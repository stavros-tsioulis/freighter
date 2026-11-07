import { rm } from "node:fs/promises";
import { AgentError } from "@freighter/protocol";
import type { ApiContext } from "./context.ts";
import { syncApp } from "./sync.ts";

export interface GitJob {
  id: string;
  app: string;
  server: string;
  repository: string;
  branch: string;
  subpath: string;
  skipIfUnchanged: boolean;
  trigger: "manual" | "webhook";
  /** An imported SSH key, decrypted when the job starts and sent to the agent for this one clone. */
  sshKeyId?: string | null;
  /** app.yaml text rendered from the app's stored settings; the agent uses it only if the repository has none. */
  fallbackManifest?: string;
}

export interface Jobs {
  enqueueDeploy(job: { id: string; app: string; server: string; artifactPath: string; manifestText: string }): void;
  enqueueRollback(job: { id: string; app: string; server: string; release?: string }): void;
  enqueueGit(job: GitJob): void;
  /** Replace an app's domains; a deployed app is redeployed with the new routing (health-gated, rolled back on failure). */
  enqueueDomains(job: { id: string; app: string; server: string; domains: { hostname: string; service: string; tls: "auto" | "off" }[]; /** Called with the failure message, or null on success. */ done?: (error: string | null) => void }): void;
  /** A git deployment for this app that is queued but has not started yet (further triggers fold into it). */
  queuedGit(app: string): string | undefined;
  /** Resolves when everything queued so far has finished (used by tests and shutdown). */
  idle(): Promise<void>;
  busy(): boolean;
}

/**
 * Runs deployments and records their outcome. Each server has its own queue, so a long build on one server never
 * delays work on another; within a server jobs run one at a time.
 */
export function createJobs(ctx: ApiContext): Jobs {
  const now = () => (ctx.now ?? (() => new Date()))().toISOString();
  const chains = new Map<string, Promise<void>>();
  const queuedGitByApp = new Map<string, string>();
  let pending = 0;

  const enqueue = (server: string, app: string, run: () => Promise<void>, cleanup?: () => Promise<void>) => {
    pending++;
    const next = (chains.get(server) ?? Promise.resolve()).then(async () => {
      try {
        await run();
      } finally {
        await cleanup?.().catch(() => {});
        await syncApp(ctx, server, app).catch(() => {}); // refresh observed state; failures are non-fatal
        pending--;
      }
    });
    chains.set(server, next);
  };

  const failure = (e: unknown) => {
    if (e instanceof AgentError) {
      return {
        status: "failed" as const,
        error: e.message,
        releaseId: e.extra.releaseId,
        previousRelease: e.extra.rolledBackTo ?? undefined,
        historyAt: e.extra.historyAt,
        finishedAt: now(),
      };
    }
    return { status: "failed" as const, error: e instanceof Error ? e.message : String(e), finishedAt: now() };
  };

  return {
    enqueueDeploy({ id, app, server, artifactPath, manifestText }) {
      enqueue(
        server,
        app,
        async () => {
          ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
          const agent = ctx.agents.forServer(server);
          const remote = ctx.registry.servers.get(server)?.kind === "remote";
          let artifact = artifactPath;
          try {
            // A remote host cannot read our spool: send the file over the connection first.
            if (remote) artifact = (await agent.putArtifact(id, artifactPath)).path;
            const r = await agent.call("app.deploy", { artifact, manifestText });
            ctx.registry.deployments.update(id, {
              status: "success",
              releaseId: r.releaseId,
              previousRelease: r.previous,
              warnings: r.warnings,
              historyAt: r.historyAt,
              finishedAt: now(),
            });
          } catch (e) {
            ctx.registry.deployments.update(id, failure(e));
          } finally {
            if (remote) await agent.call("artifact.delete", { id }).catch(() => {});
          }
        },
        () => rm(artifactPath, { force: true }),
      );
    },

    enqueueRollback({ id, app, server, release }) {
      enqueue(server, app, async () => {
        ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
        try {
          const r = await ctx.agents.forServer(server).call("app.rollback", { app, release });
          ctx.registry.deployments.update(id, {
            status: "success",
            releaseId: r.to,
            previousRelease: r.from,
            historyAt: r.historyAt,
            finishedAt: now(),
          });
        } catch (e) {
          ctx.registry.deployments.update(id, failure(e));
        }
      });
    },

    enqueueDomains({ id, app, server, domains, done }) {
      enqueue(server, app, async () => {
        ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
        try {
          const r = await ctx.agents.forServer(server).call("domains.set", { app, domains }, { timeoutMs: 5 * 60_000 });
          const note = r.deploy ? [] : ["domains saved; they take effect with the app's first deploy (or nothing changed)"];
          ctx.registry.deployments.update(id, {
            status: "success",
            releaseId: r.deploy?.releaseId,
            previousRelease: r.deploy?.previous,
            warnings: [...(r.deploy?.warnings ?? []), ...note],
            historyAt: r.deploy?.historyAt,
            finishedAt: now(),
          });
          done?.(null);
        } catch (e) {
          ctx.registry.deployments.update(id, failure(e));
          done?.(e instanceof Error ? e.message.split("\n")[0]! : String(e));
        }
      });
    },

    enqueueGit(job) {
      queuedGitByApp.set(job.app, job.id);
      enqueue(job.server, job.app, async () => {
        if (queuedGitByApp.get(job.app) === job.id) queuedGitByApp.delete(job.app);
        ctx.registry.deployments.update(job.id, { status: "running", startedAt: now() });
        const agent = ctx.agents.forServer(job.server);
        let outcome = "";
        try {
          const sshKey = job.sshKeyId ? ctx.registry.sshKeys.privateKey(job.sshKeyId) : null;
          if (job.sshKeyId) {
            if (!sshKey) throw new Error("the SSH key for this repository no longer exists");
            ctx.registry.sshKeys.touch(job.sshKeyId);
          }
          const r = await agent.call(
            "git.deploy",
            { app: job.app, buildId: job.id, repository: job.repository, branch: job.branch, subpath: job.subpath || undefined, skipIfUnchanged: job.skipIfUnchanged, fallbackManifest: job.fallbackManifest, auth: sshKey ? { sshKey } : undefined },
            { timeoutMs: 60 * 60_000 },
          );
          const commit = { commitSha: r.commit.sha, commitSubject: r.commit.subject, commitAuthor: r.commit.author };
          if (r.skipped || !r.deploy) {
            ctx.registry.deployments.update(job.id, { ...commit, status: "success", warnings: ["already deployed: the branch has no new commits"], finishedAt: now() });
            outcome = `up to date at ${r.commit.sha.slice(0, 7)}`;
          } else {
            ctx.registry.deployments.update(job.id, {
              ...commit,
              status: "success",
              releaseId: r.deploy.releaseId,
              previousRelease: r.deploy.previous,
              warnings: r.deploy.warnings,
              historyAt: r.deploy.historyAt,
              finishedAt: now(),
            });
            outcome = `deployed ${r.commit.sha.slice(0, 7)}`;
          }
        } catch (e) {
          ctx.registry.deployments.update(job.id, failure(e));
          outcome = `failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
        }
        // Keep the build log with the deployment so it can be read after the agent's copy is pruned.
        await agent
          .call("build.log", { id: job.id, from: 0 })
          .then((l) => ctx.registry.deployments.setLog(job.id, l.text))
          .catch(() => {});
        if (job.trigger === "webhook") ctx.registry.gitLinks.markDelivery(job.app, outcome);
      });
    },

    queuedGit: (app) => queuedGitByApp.get(app),

    async idle() {
      while (pending > 0) await Promise.all([...chains.values()]);
    },
    busy: () => pending > 0,
  };
}
