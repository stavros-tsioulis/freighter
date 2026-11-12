import { rm } from "node:fs/promises";
import { imageHost, imageServices, parseManifest, storageApp, storageOfApp } from "@freighter/manifest";
import { randomUUID } from "node:crypto";
import { AgentError } from "@freighter/protocol";
import { pushConnections } from "./connections.ts";
import { dependantsOf } from "./dependants.ts";
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
  /** A new configuration for the app, saved on the server before this builds and deploys with it. */
  configText?: string;
}

/** What the error of a canceled deployment starts with (they are recorded as failed, so older dashboards still understand them). */
export const CANCELED = "Canceled by ";

export interface Jobs {
  enqueueDeploy(job: { id: string; app: string; server: string; artifactPath: string; manifestText: string }): void;
  /** Deploy an app made only of image services: the agent pulls the images, so there is no artifact. */
  enqueueImageDeploy(job: { id: string; app: string; server: string; manifestText: string; replaceConfig?: boolean }): void;
  /** Replace an app's configuration; a deployed app is redeployed with it (health-gated, rolled back on failure). */
  enqueueConfig(job: { id: string; app: string; server: string; manifestText: string }): void;
  /** The configuration a queued or running deployment is about to apply, if any (it is only saved once the deploy works). */
  pendingConfig(app: string): string | null;
  enqueueRollback(job: { id: string; app: string; server: string; release?: string }): void;
  enqueueGit(job: GitJob): void;
  /** Create or update the endpoint that serves a storage, from what the registry holds for it. */
  enqueueStorage(job: { id: string; name: string; server: string }): void;
  /**
   * Something an app or storage offers has changed (a domain, a port, a key): redeploy the apps that connect to it,
   * those whose resolved values actually differ. Call after a change that did not go through a job.
   */
  cascade(target: { app: string }, depth?: number): Promise<void>;
  /** Replace an app's domains; a deployed app is redeployed with the new routing (health-gated, rolled back on failure). */
  enqueueDomains(job: { id: string; app: string; server: string; domains: { hostname: string; service: string; tls: "auto" | "off" }[]; /** Called with the failure message, or null on success. */ done?: (error: string | null) => void }): void;
  /** A git deployment for this app that is queued but has not started yet (further triggers fold into it). */
  queuedGit(app: string): string | undefined;
  /**
   * Stop a deployment. One still waiting never starts (`canceled`); one running is asked to stop on its server
   * (`stopping`) and ends as canceled, rolled back if it had begun to switch. `finished` if it is already over.
   */
  cancel(id: string, by: string): Promise<"canceled" | "stopping" | "finished">;
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

  /**
   * `shows` is the configuration the job is about to give the app, if it will be the app's configuration (a new app,
   * or a change that replaces it): the dashboard lists its services while the job waits and runs.
   */
  const enqueue = (server: string, app: string, run: () => Promise<void>, cleanup?: () => Promise<void>, depth = 0, jobId?: string, shows?: string) => {
    pending++;
    if (shows) pendingConfigs.set(app, shows);
    const next = (chains.get(server) ?? Promise.resolve()).then(async () => {
      try {
        if (jobId && skipped.has(jobId)) skipped.delete(jobId); // canceled while it waited
        else await run();
      } finally {
        // Canceled while running: whatever the agent reported, the outcome is the cancelation.
        const by = jobId ? stopping.get(jobId) : undefined;
        if (jobId && by !== undefined) {
          stopping.delete(jobId);
          if (ctx.registry.deployments.get(jobId)?.status === "failed") ctx.registry.deployments.update(jobId, { error: CANCELED + by });
        }
        await cleanup?.().catch(() => {});
        if (shows && pendingConfigs.get(app) === shows) pendingConfigs.delete(app);
        await syncApp(ctx, server, app).catch(() => {}); // refresh observed state; failures are non-fatal
        // What this app offers (domains, ports, keys) may have moved: the apps that connect to it follow.
        // A job that turned out to have nothing to do (its deployment was removed) changed nothing for anyone.
        const done = jobId ? ctx.registry.deployments.get(jobId) : ctx.registry.deployments.list({ app, limit: 1 })[0];
        if (done?.status === "success") await cascade({ app }, depth).catch(() => {});
        pending--;
      }
    });
    chains.set(server, next);
  };

  /**
   * Logins for the registries the images of an app come from, to pass to whatever may pull them: any deploy of an app
   * with image services pulls again, so this goes with Git deploys, configuration changes and the rest as well as with
   * image deploys. Given the manifest, only the registries it names; without one (a Git deploy reads its own, later),
   * every registry that has a login. A registry with several logins and none chosen for the app is an error when the
   * images need it (`strict`), and is left out otherwise.
   */
  const registryAuthFor = (app: string, manifestText: string | null | undefined, strict: boolean) => {
    const every = () => [...new Set(ctx.registry.registryCredentials.list().map((r) => r.host))];
    let hosts: string[];
    try {
      hosts = manifestText ? [...new Set(Object.values(imageServices(parseManifest(manifestText, { legacy: true }))).map(imageHost))] : every();
    } catch {
      hosts = every(); // unreadable here: let the server decide what it needs
    }
    const auth = hosts.flatMap((host) => {
      const c = ctx.registry.registryCredentials.resolve(app, host);
      if (c && "ambiguous" in c) {
        if (strict) throw new Error(`${app} has no login chosen for ${host}, which has several (${c.ambiguous.join(", ")}). Choose one and deploy again.`);
        return [];
      }
      return c ? [{ host, ...c }] : [];
    });
    return auth.length ? auth : undefined;
  };

  /** app -> the configuration a queued or running configuration change is applying. */
  const pendingConfigs = new Map<string, string>();

  /** An app with no configuration yet takes it from its first deploy; for one that has it, the deploy's file is ignored. */
  const configOfNewApp = (app: string, text: string) => (ctx.registry.apps.get(app)?.manifestText ? undefined : text);

  /** Deployments canceled before they started, and ones asked to stop while running (id -> who). */
  const skipped = new Set<string>();
  const stopping = new Map<string, string>();

  const MAX_DEPTH = 3; // A reaching B reaching C is fine; a loop of apps that read each other must end.
  /** Queue a re-resolve for every app that connects to `target`. They only redeploy when a value they read changed. */
  async function cascade(target: { app: string }, depth = 0): Promise<void> {
    if (depth >= MAX_DEPTH) return;
    const storage = ctx.registry.apps.get(target.app)?.kind === "storage" ? storageOfApp(target.app) : null;
    for (const row of await dependantsOf(ctx, storage ? { storage } : { app: target.app })) {
      const id = randomUUID();
      ctx.registry.deployments.create({ id, app: row.name, server: row.server, action: "deploy", trigger: "manual", requestedBy: null });
      enqueueReapply({ id, app: row.name, server: row.server, because: storage ? `storage ${storage}` : target.app, depth: depth + 1 });
    }
  }

  function enqueueReapply({ id, app, server, because, depth }: { id: string; app: string; server: string; because: string; depth: number }) {
    enqueue(
      server,
      app,
      async () => {
        const agent = ctx.agents.forServer(server);
        ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
        try {
          await pushConnections(ctx, server, app);
          const r = await agent.call("app.reapply", { app, registryAuth: registryAuthFor(app, ctx.registry.apps.get(app)?.manifestText, false), logId: id }, { timeoutMs: 15 * 60_000 });
          if (!r.changed || !r.deploy) return void ctx.registry.deployments.remove(id); // nothing it reads has changed: no deployment to show
          ctx.registry.deployments.update(id, {
            status: "success",
            releaseId: r.deploy.releaseId,
            previousRelease: r.deploy.previous,
            warnings: [`restarted because ${because} changed`, ...r.deploy.warnings],
            historyAt: r.deploy.historyAt,
            finishedAt: now(),
          });
          await agent.call("build.log", { id, from: 0 }).then((l) => ctx.registry.deployments.setLog(id, l.text)).catch(() => {});
        } catch (e) {
          // An agent that predates this has nothing to re-resolve; it is not a failure worth a deployment.
          if (e instanceof AgentError && /unknown op|not supported/i.test(e.message)) return void ctx.registry.deployments.remove(id);
          ctx.registry.deployments.update(id, failure(e));
        }
      },
      undefined,
      depth,
      id,
    );
  }

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
            await pushConnections(ctx, server, app);
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
        0,
        id,
        configOfNewApp(app, manifestText),
      );
    },

    enqueueImageDeploy({ id, app, server, manifestText, replaceConfig }) {
      enqueue(server, app, async () => {
        ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
        const agent = ctx.agents.forServer(server);
        try {
          await pushConnections(ctx, server, app);
          const caps = (await agent.call("ping", {})).capabilities ?? [];
          if (!caps.includes("images")) throw new Error("this server's agent is too old to run images; upgrade it from the Servers page");
          // Send only the logins for the registries these images live on.
          const r = await agent.call("app.deploy", { manifestText, registryAuth: registryAuthFor(app, manifestText, true), logId: id, replaceConfig }, { timeoutMs: 30 * 60_000 });
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
        }
        // Keep the log (pull progress included) with the deployment, as Git deployments do.
        await agent
          .call("build.log", { id, from: 0 })
          .then((l) => ctx.registry.deployments.setLog(id, l.text))
          .catch(() => {});
      }, undefined, 0, id, replaceConfig ? manifestText : configOfNewApp(app, manifestText));
    },

    pendingConfig: (app) => pendingConfigs.get(app) ?? null,

    async cancel(id, by) {
      const row = ctx.registry.deployments.get(id);
      if (!row || (row.status !== "queued" && row.status !== "running")) return "finished";
      if (row.status === "queued") {
        skipped.add(id);
        if (queuedGitByApp.get(row.app) === id) queuedGitByApp.delete(row.app);
        ctx.registry.deployments.update(id, { status: "failed", error: CANCELED + by, finishedAt: now() });
        return "canceled";
      }
      stopping.set(id, by);
      try {
        const r = await ctx.agents.forServer(row.server).call("deploy.cancel", { id }, { timeoutMs: 15_000 });
        if (!r.canceled) stopping.delete(id); // nothing of it is running on the server: it was between steps or already over
        return r.canceled ? "stopping" : "finished";
      } catch (e) {
        stopping.delete(id);
        throw e;
      }
    },

    enqueueConfig({ id, app, server, manifestText }) {
      enqueue(server, app, async () => {
        ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
        const agent = ctx.agents.forServer(server);
        try {
          await pushConnections(ctx, server, app);
          const r = await agent.call("app.config.set", { app, manifestText, registryAuth: registryAuthFor(app, manifestText, true), logId: id }, { timeoutMs: 30 * 60_000 });
          ctx.registry.deployments.update(id, {
            status: "success",
            ...(r.deploy ? { releaseId: r.deploy.releaseId, previousRelease: r.deploy.previous, warnings: r.deploy.warnings, historyAt: r.deploy.historyAt } : {}),
            finishedAt: now(),
          });
        } catch (e) {
          ctx.registry.deployments.update(id, failure(e));
        }
        await agent
          .call("build.log", { id, from: 0 })
          .then((l) => ctx.registry.deployments.setLog(id, l.text))
          .catch(() => {});
      }, undefined, 0, id, manifestText);
    },

    enqueueRollback({ id, app, server, release }) {
      enqueue(server, app, async () => {
        ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
        try {
          await pushConnections(ctx, server, app);
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
          await pushConnections(ctx, server, app);
          const r = await ctx.agents.forServer(server).call("domains.set", { app, domains, registryAuth: registryAuthFor(app, ctx.registry.apps.get(app)?.manifestText, false), logId: id }, { timeoutMs: 5 * 60_000 });
          const note = r.deploy
            ? []
            : r.mode === "routing"
              ? ["routing updated; the app was not redeployed. A service that lost its last domain keeps running until the next deploy"]
              : ["domains saved; they take effect with the app's first deploy (or nothing changed)"];
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
        // Keep the log with the deployment, as Git deployments do, so it can be read after the agent's copy is pruned.
        await ctx.agents
          .forServer(server)
          .call("build.log", { id, from: 0 })
          .then((l) => ctx.registry.deployments.setLog(id, l.text))
          .catch(() => {});
      });
    },

    enqueueStorage({ id, name, server }) {
      const app = storageApp(name);
      enqueue(server, app, async () => {
        ctx.registry.deployments.update(id, { status: "running", startedAt: now() });
        const agent = ctx.agents.forServer(server);
        try {
          const row = ctx.registry.storages.get(name);
          const secrets = ctx.registry.storages.secrets(name);
          if (!row || !secrets) throw new Error("the storage was deleted");
          const hasRemote = Object.keys(secrets.remote).length > 0;
          const r = await agent.call(
            "storage.apply",
            { name, backend: row.backend, accessKey: row.accessKey, secretKey: secrets.secretKey, secrets: hasRemote ? secrets.remote : undefined, public: row.public || undefined, logId: id },
            { timeoutMs: 10 * 60_000 },
          );
          ctx.registry.storages.update(name, { port: r.port });
          ctx.registry.deployments.update(id, { status: "success", releaseId: r.deploy.releaseId, previousRelease: r.deploy.previous, warnings: r.deploy.warnings, historyAt: r.deploy.historyAt, finishedAt: now() });
        } catch (e) {
          ctx.registry.deployments.update(id, failure(e));
        }
        await agent
          .call("build.log", { id, from: 0 })
          .then((l) => ctx.registry.deployments.setLog(id, l.text))
          .catch(() => {});
      });
    },

    enqueueGit(job) {
      queuedGitByApp.set(job.app, job.id);
      // A repository's own app.yaml wins over the settings of the form, and is not known until it is cloned.
      const shows = job.configText ?? (job.fallbackManifest ? configOfNewApp(job.app, job.fallbackManifest) : undefined);
      enqueue(job.server, job.app, async () => {
        if (queuedGitByApp.get(job.app) === job.id) queuedGitByApp.delete(job.app);
        ctx.registry.deployments.update(job.id, { status: "running", startedAt: now() });
        const agent = ctx.agents.forServer(job.server);
        let outcome = "";
        try {
          await pushConnections(ctx, job.server, job.app);
          const sshKey = job.sshKeyId ? ctx.registry.sshKeys.privateKey(job.sshKeyId) : null;
          if (job.sshKeyId) {
            if (!sshKey) throw new Error("the SSH key for this repository no longer exists");
            ctx.registry.sshKeys.touch(job.sshKeyId);
          }
          const r = await agent.call(
            "git.deploy",
            { app: job.app, buildId: job.id, repository: job.repository, branch: job.branch, subpath: job.subpath || undefined, skipIfUnchanged: job.skipIfUnchanged, fallbackManifest: job.fallbackManifest, configText: job.configText, registryAuth: registryAuthFor(job.app, null, false), auth: sshKey ? { sshKey } : undefined },
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
      }, undefined, 0, job.id, shows);
    },

    queuedGit: (app) => queuedGitByApp.get(app),
    cascade: (target, depth) => cascade(target, depth),

    async idle() {
      while (pending > 0) await Promise.all([...chains.values()]);
    },
    busy: () => pending > 0,
  };
}
