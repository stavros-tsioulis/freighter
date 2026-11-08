import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { migrations } from "./migrations.ts";
import { createSecretBox, memorySecretBox, type SecretBox } from "./secrets.ts";
import {
  isRole,
  type AppRow,
  type AuditRow,
  type DeploymentRow,
  type HistoryEntryLike,
  type GitLinkRow,
  type HostStatus,
  type ServerRow,
  type PendingDomainRow,
  type SshKeyRow,
  type MetricSampleRow,
  type Role,
  type ServiceRow,
  type TokenRow,
} from "./types.ts";

type Row = Record<string, SQLInputValue>;
const plain = (r: unknown): Row => ({ ...(r as Row) });

const appFrom = (r: Row): AppRow => ({
  name: r.name as string,
  server: r.server as string,
  manifestText: r.manifest_text as string | null,
  currentRelease: r.current_release as string | null,
  previousRelease: r.previous_release as string | null,
  status: r.status as AppRow["status"],
  syncedAt: r.synced_at as string | null,
  updatedAt: r.updated_at as string,
});
const serviceFrom = (r: Row): ServiceRow => ({
  app: r.app as string,
  name: r.name as string,
  unit: r.unit as string,
  port: r.port as number | null,
  hostnames: JSON.parse(r.hostnames as string),
  activeState: r.active_state as string,
  subState: r.sub_state as string,
  restarts: r.restarts as number,
  memoryBytes: r.memory_bytes as number | null,
  observedAt: r.observed_at as string,
});
const deploymentFrom = (r: Row): DeploymentRow => ({
  id: r.id as string,
  app: r.app as string,
  server: r.server as string,
  action: r.action as DeploymentRow["action"],
  status: r.status as DeploymentRow["status"],
  releaseId: r.release_id as string | null,
  previousRelease: r.previous_release as string | null,
  source: r.source as DeploymentRow["source"],
  trigger: r.trigger as DeploymentRow["trigger"],
  commitSha: r.commit_sha as string | null,
  commitSubject: r.commit_subject as string | null,
  commitAuthor: r.commit_author as string | null,
  requestedBy: r.requested_by as string | null,
  artifactSha256: r.artifact_sha256 as string | null,
  error: r.error as string | null,
  warnings: JSON.parse(r.warnings as string),
  historyAt: r.history_at as string | null,
  createdAt: r.created_at as string,
  startedAt: r.started_at as string | null,
  finishedAt: r.finished_at as string | null,
});
const gitLinkFrom = (r: Row): GitLinkRow => ({
  app: r.app as string,
  provider: r.provider as GitLinkRow["provider"],
  repository: r.repository as string,
  branch: r.branch as string,
  subpath: r.subpath as string,
  autoDeploy: Number(r.auto_deploy) === 1,
  webhookSecret: r.webhook_secret as string,
  publicKey: r.public_key as string,
  keyFingerprint: r.key_fingerprint as string,
  lastDeliveryAt: r.last_delivery_at as string | null,
  lastDeliveryResult: r.last_delivery_result as string | null,
  createdAt: r.created_at as string,
  sshKeyId: r.ssh_key_id as string | null,
  settings: r.settings_json ? (JSON.parse(r.settings_json as string) as Record<string, unknown>) : null,
});
const pendingFrom = (r: Row): PendingDomainRow => ({
  hostname: r.hostname as string,
  app: r.app as string,
  service: r.service as string,
  tls: r.tls as "auto" | "off",
  createdAt: r.created_at as string,
  checkedAt: r.checked_at as string | null,
  lastError: r.last_error as string | null,
});
const sshKeyFrom = (r: Row): SshKeyRow => ({
  id: r.id as string,
  name: r.name as string,
  keyType: r.key_type as string,
  publicKey: r.public_key as string,
  fingerprint: r.fingerprint as string,
  comment: r.comment as string | null,
  createdBy: r.created_by as string | null,
  createdAt: r.created_at as string,
  lastUsedAt: r.last_used_at as string | null,
  appCount: Number(r.app_count ?? 0),
});
const tokenFrom = (r: Row): TokenRow => ({
  id: r.id as string,
  name: r.name as string,
  role: r.role as Role,
  createdAt: r.created_at as string,
  lastUsedAt: r.last_used_at as string | null,
  revokedAt: r.revoked_at as string | null,
});

const serverFrom = (r: Row): ServerRow => ({
  name: r.name as string,
  kind: r.kind as ServerRow["kind"],
  address: r.address as string | null,
  status: r.status as ServerRow["status"],
  agentVersion: r.agent_version as string | null,
  hostname: r.hostname as string | null,
  host: r.host_json ? (JSON.parse(r.host_json as string) as HostStatus) : null,
  lastSeenAt: r.last_seen_at as string | null,
  lastError: r.last_error as string | null,
  certFingerprint: r.cert_fingerprint as string | null,
  certExpiresAt: r.cert_expires_at as string | null,
  enrollmentPending: r.enroll_token_hash !== null,
  enrollExpiresAt: r.enroll_expires_at as string | null,
  createdAt: r.created_at as string,
  appCount: Number(r.app_count ?? 0),
});
// Everything but the (potentially large) build log, which is fetched on demand.
const DEP_COLS =
  "id, app, server, action, status, release_id, previous_release, source, trigger, commit_sha, commit_subject, commit_author, requested_by, artifact_sha256, error, warnings, history_at, created_at, started_at, finished_at";
const SSH_KEY_SELECT =
  "SELECT k.*, (SELECT COUNT(*) FROM git_links l WHERE l.ssh_key_id = k.id) AS app_count FROM ssh_keys k";
const SERVER_SELECT = "SELECT s.*, (SELECT COUNT(*) FROM apps a WHERE a.server = s.name) AS app_count FROM servers s";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type DeploymentPatch = Partial<
  Pick<
    DeploymentRow,
    "status" | "releaseId" | "previousRelease" | "error" | "warnings" | "historyAt" | "startedAt" | "finishedAt" | "commitSha" | "commitSubject" | "commitAuthor"
  >
>;

export type GitLinkInput = Omit<GitLinkRow, "createdAt" | "lastDeliveryAt" | "lastDeliveryResult" | "sshKeyId" | "settings"> & Partial<Pick<GitLinkRow, "sshKeyId" | "settings">>;

export interface NewSshKey {
  name: string;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  comment?: string | null;
  privateKey: string;
  createdBy?: string | null;
}

export interface Registry {
  close(): void;
  schemaVersion(): number;
  sshKeys: {
    create(k: NewSshKey): SshKeyRow;
    get(id: string): SshKeyRow | undefined;
    list(): SshKeyRow[];
    /** The decrypted private key. Only ever handed to the agent that is about to clone with it. */
    privateKey(id: string): string | null;
    touch(id: string): void;
    remove(id: string): boolean;
  };
  /** Control-plane settings saved from the dashboard: key -> JSON value. */
  settings: {
    all(): Record<string, unknown>;
    set(key: string, value: unknown): void;
    remove(key: string): boolean;
  };
  pendingDomains: {
    list(app?: string): PendingDomainRow[];
    get(hostname: string): PendingDomainRow | undefined;
    create(d: { hostname: string; app: string; service: string; tls: "auto" | "off" }): PendingDomainRow;
    markChecked(hostname: string, error: string | null): void;
    remove(hostname: string): boolean;
  };
  gitLinks: {
    get(app: string): GitLinkRow | undefined;
    upsert(link: GitLinkInput): GitLinkRow;
    remove(app: string): boolean;
    markDelivery(app: string, result: string): void;
  };
  servers: {
    /** Register a remote server (status `pending` until it enrolls). */
    create(o: { name: string; address: string }): ServerRow;
    get(name: string): ServerRow | undefined;
    list(): ServerRow[];
    remove(name: string): boolean;
    /** Start (or restart) enrollment: returns the plaintext one-time token; only its hash is stored. */
    /**
     * Whether this control server also runs apps through its own agent (the server "local"). Turning it off removes
     * the row unless apps or deployments still point at it; returns whether the row is now as asked.
     */
    setLocal(enabled: boolean): boolean;
    newEnrollment(name: string, ttlMs?: number): string;
    /** Redeem a token exactly once; returns the server it was issued for, or null if unknown/expired/used. */
    consumeEnrollment(token: string): ServerRow | null;
    setCert(name: string, fingerprint: string, expiresIso: string): void;
    markSeen(name: string, info: { agentVersion?: string | null; hostname?: string | null; host?: HostStatus | null }): void;
    markError(name: string, message: string): void;
  };
  apps: {
    /** Pin an app to a server if it has no row yet (never moves an existing app). */
    ensure(name: string, server: string): void;
    upsert(a: { name: string; server?: string; manifestText: string | null; currentRelease: string | null; previousRelease: string | null; status: AppRow["status"] }): void;
    get(name: string): AppRow | undefined;
    list(): AppRow[];
    /** Mark apps pinned to `server` that are no longer reported by it. */
    markMissing(present: string[], server?: string): void;
  };
  services: {
    replace(app: string, rows: Omit<ServiceRow, "app" | "observedAt">[]): void;
    list(app: string): ServiceRow[];
  };
  deployments: {
    create(d: { id?: string; app: string; server?: string; action: "deploy" | "rollback"; trigger?: DeploymentRow["trigger"]; requestedBy?: string | null; artifactSha256?: string | null }): DeploymentRow;
    /** The (possibly large) build log is kept apart from the row so listings stay light. */
    setLog(id: string, text: string): void;
    getLog(id: string): string | null;
    update(id: string, patch: DeploymentPatch): void;
    get(id: string): DeploymentRow | undefined;
    list(o?: { app?: string; limit?: number }): DeploymentRow[];
    importHistory(app: string, entries: HistoryEntryLike[]): number;
    markInterrupted(): number;
  };
  tokens: {
    create(o: { name: string; role: Role }): { token: string; row: TokenRow };
    /**
     * First-run sign-in for hosts without a shell: when no token has ever been created, store `token` (supplied by the
     * operator, e.g. through an environment variable) as an admin token named "bootstrap". Returns whether it did.
     */
    bootstrap(token: string): boolean;
    verify(token: string): TokenRow | null;
    list(): TokenRow[];
    revoke(id: string): boolean;
  };
  metrics: {
    add(rows: Omit<MetricSampleRow, "at">[], at?: string): void;
    /** Samples for an app at or after `sinceIso`, ordered by service then time. */
    series(app: string, sinceIso: string): MetricSampleRow[];
    /** Delete samples older than `beforeIso`; returns how many. */
    prune(beforeIso: string): number;
  };
  audit: {
    add(e: { tokenId?: string | null; action: string; app?: string | null; detail?: Record<string, unknown> }): void;
    list(limit?: number): AuditRow[];
  };
}

export function openRegistry(path: string, opts: { now?: () => Date; secrets?: SecretBox } = {}): Registry {
  const now = () => (opts.now ?? (() => new Date()))().toISOString();
  const box = opts.secrets ?? (path === ":memory:" ? memorySecretBox() : createSecretBox(join(dirname(path), "secret.key")));
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  let version = Number(versionRow?.value ?? 0);
  for (; version < migrations.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[version]!);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version + 1));
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  const all = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p).map(plain);
  const one = (sql: string, ...p: SQLInputValue[]) => {
    const r = db.prepare(sql).get(...p);
    return r === undefined ? undefined : plain(r);
  };
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  return {
    close: () => db.close(),
    schemaVersion: () => Number((one("SELECT value FROM meta WHERE key = 'schema_version'")?.value as string) ?? 0),

    sshKeys: {
      create(k) {
        const id = `key_${randomBytes(6).toString("hex")}`;
        run(
          "INSERT INTO ssh_keys (id, name, key_type, public_key, fingerprint, comment, private_enc, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id, k.name, k.keyType, k.publicKey, k.fingerprint, k.comment ?? null, box.seal(k.privateKey), k.createdBy ?? null, now(),
        );
        return sshKeyFrom(one(`${SSH_KEY_SELECT} WHERE k.id = ?`, id)!);
      },
      get: (id) => {
        const r = one(`${SSH_KEY_SELECT} WHERE k.id = ?`, id);
        return r && sshKeyFrom(r);
      },
      list: () => all(`${SSH_KEY_SELECT} ORDER BY k.name`).map(sshKeyFrom),
      privateKey(id) {
        const r = one("SELECT private_enc FROM ssh_keys WHERE id = ?", id);
        return r ? box.open(r.private_enc as string) : null;
      },
      touch(id) {
        run("UPDATE ssh_keys SET last_used_at = ? WHERE id = ?", now(), id);
      },
      remove: (id) => Number(run("DELETE FROM ssh_keys WHERE id = ?", id).changes) > 0,
    },

    settings: {
      all: () => Object.fromEntries(all("SELECT key, value_json FROM settings").map((r) => [r.key as string, JSON.parse(r.value_json as string)])),
      set(key, value) {
        run("INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at", key, JSON.stringify(value), now());
      },
      remove: (key) => Number(run("DELETE FROM settings WHERE key = ?", key).changes) > 0,
    },

    pendingDomains: {
      list: (app) => all(app ? "SELECT * FROM pending_domains WHERE app = ? ORDER BY created_at" : "SELECT * FROM pending_domains ORDER BY created_at", ...(app ? [app] : [])).map(pendingFrom),
      get: (hostname) => {
        const r = one("SELECT * FROM pending_domains WHERE hostname = ?", hostname);
        return r && pendingFrom(r);
      },
      create(d) {
        run("INSERT INTO pending_domains (hostname, app, service, tls, created_at) VALUES (?, ?, ?, ?, ?)", d.hostname, d.app, d.service, d.tls, now());
        return pendingFrom(one("SELECT * FROM pending_domains WHERE hostname = ?", d.hostname)!);
      },
      markChecked(hostname, error) {
        run("UPDATE pending_domains SET checked_at = ?, last_error = ? WHERE hostname = ?", now(), error, hostname);
      },
      remove: (hostname) => Number(run("DELETE FROM pending_domains WHERE hostname = ?", hostname).changes) > 0,
    },

    gitLinks: {
      get: (app) => {
        const r = one("SELECT * FROM git_links WHERE app = ?", app);
        return r && gitLinkFrom(r);
      },
      upsert(l) {
        run(
          `INSERT INTO git_links (app, provider, repository, branch, subpath, auto_deploy, webhook_secret, public_key, key_fingerprint, created_at, ssh_key_id, settings_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(app) DO UPDATE SET provider = excluded.provider, repository = excluded.repository, branch = excluded.branch,
             subpath = excluded.subpath, auto_deploy = excluded.auto_deploy, webhook_secret = excluded.webhook_secret,
             public_key = excluded.public_key, key_fingerprint = excluded.key_fingerprint, ssh_key_id = excluded.ssh_key_id,
             settings_json = excluded.settings_json`,
          l.app, l.provider, l.repository, l.branch, l.subpath, l.autoDeploy ? 1 : 0, l.webhookSecret, l.publicKey, l.keyFingerprint, now(), l.sshKeyId ?? null, l.settings ? JSON.stringify(l.settings) : null,
        );
        return gitLinkFrom(one("SELECT * FROM git_links WHERE app = ?", l.app)!);
      },
      remove: (app) => Number(run("DELETE FROM git_links WHERE app = ?", app).changes) > 0,
      markDelivery(app, result) {
        run("UPDATE git_links SET last_delivery_at = ?, last_delivery_result = ? WHERE app = ?", now(), result.slice(0, 200), app);
      },
    },

    servers: {
      create({ name, address }) {
        run("INSERT INTO servers (name, kind, address, status, created_at) VALUES (?, 'remote', ?, 'pending', ?)", name, address, now());
        return serverFrom(one(`${SERVER_SELECT} WHERE s.name = ?`, name)!);
      },
      get: (name) => {
        const r = one(`${SERVER_SELECT} WHERE s.name = ?`, name);
        return r && serverFrom(r);
      },
      list: () => all(`${SERVER_SELECT} ORDER BY (s.kind = 'local') DESC, s.name`).map(serverFrom),
      remove: (name) => Number(run("DELETE FROM servers WHERE name = ? AND kind = 'remote'", name).changes) > 0,
      setLocal(enabled) {
        if (enabled) {
          run("INSERT OR IGNORE INTO servers (name, kind, status, created_at) VALUES ('local', 'local', 'online', ?)", now());
          return true;
        }
        const pinned = one("SELECT (SELECT COUNT(*) FROM apps WHERE server = 'local') + (SELECT COUNT(*) FROM deployments WHERE server = 'local') AS n")!.n as number;
        if (pinned > 0) return false; // history that still points at it: keep the row rather than orphan it
        run("DELETE FROM servers WHERE name = 'local' AND kind = 'local'");
        return true;
      },
      newEnrollment(name, ttlMs = 3_600_000) {
        const token = `fre_${randomBytes(24).toString("base64url")}`;
        const r = run(
          "UPDATE servers SET enroll_token_hash = ?, enroll_expires_at = ? WHERE name = ? AND kind = 'remote'",
          hashToken(token), new Date(Date.parse(now()) + ttlMs).toISOString(), name,
        );
        if (Number(r.changes) === 0) throw new Error(`unknown remote server "${name}"`);
        return token;
      },
      consumeEnrollment(token) {
        const r = one(`${SERVER_SELECT} WHERE s.enroll_token_hash = ?`, hashToken(token));
        if (!r || (r.enroll_expires_at as string) < now()) return null;
        // single use: the UPDATE only succeeds for whoever clears the hash first
        const cleared = run("UPDATE servers SET enroll_token_hash = NULL, enroll_expires_at = NULL WHERE name = ? AND enroll_token_hash = ?", r.name as string, hashToken(token));
        return Number(cleared.changes) === 1 ? serverFrom({ ...r, enroll_token_hash: null }) : null;
      },
      setCert(name, fingerprint, expiresIso) {
        run("UPDATE servers SET cert_fingerprint = ?, cert_expires_at = ?, status = CASE WHEN status = 'pending' THEN 'offline' ELSE status END WHERE name = ?", fingerprint, expiresIso, name);
      },
      markSeen(name, info) {
        run(
          `UPDATE servers SET status = 'online', last_seen_at = ?, last_error = NULL,
             agent_version = COALESCE(?, agent_version), hostname = COALESCE(?, hostname), host_json = COALESCE(?, host_json) WHERE name = ?`,
          now(), info.agentVersion ?? null, info.hostname ?? null, info.host ? JSON.stringify(info.host) : null, name,
        );
      },
      markError(name, message) {
        run("UPDATE servers SET status = CASE WHEN status = 'pending' THEN 'pending' ELSE 'offline' END, last_error = ? WHERE name = ?", message.slice(0, 500), name);
      },
    },

    apps: {
      ensure(name, server) {
        run("INSERT OR IGNORE INTO apps (name, server, status, updated_at) VALUES (?, ?, 'unknown', ?)", name, server, now());
      },
      upsert(a) {
        const t = now();
        run(
          `INSERT INTO apps (name, server, manifest_text, current_release, previous_release, status, synced_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET manifest_text = excluded.manifest_text, current_release = excluded.current_release,
             previous_release = excluded.previous_release, status = excluded.status, synced_at = excluded.synced_at, updated_at = excluded.updated_at`,
          a.name, a.server ?? "local", a.manifestText, a.currentRelease, a.previousRelease, a.status, t, t,
        );
      },
      get: (name) => {
        const r = one("SELECT * FROM apps WHERE name = ?", name);
        return r && appFrom(r);
      },
      list: () => all("SELECT * FROM apps ORDER BY name").map(appFrom),
      markMissing(present, server = "local") {
        const keep = new Set(present);
        for (const a of all("SELECT name FROM apps WHERE status <> 'missing' AND server = ?", server)) {
          if (!keep.has(a.name as string)) run("UPDATE apps SET status = 'missing', updated_at = ? WHERE name = ?", now(), a.name as string);
        }
      },
    },

    services: {
      replace(app, rows) {
        tx(() => {
          run("DELETE FROM services WHERE app = ?", app);
          for (const s of rows) {
            run(
              `INSERT INTO services (app, name, unit, port, hostnames, active_state, sub_state, restarts, memory_bytes, observed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              app, s.name, s.unit, s.port, JSON.stringify(s.hostnames), s.activeState, s.subState, s.restarts, s.memoryBytes, now(),
            );
          }
        });
      },
      list: (app) => all("SELECT * FROM services WHERE app = ? ORDER BY name", app).map(serviceFrom),
    },

    deployments: {
      create(d) {
        const id = d.id ?? randomUUID();
        run(
          `INSERT INTO deployments (id, app, server, action, status, source, trigger, requested_by, artifact_sha256, created_at)
           VALUES (?, ?, ?, ?, 'queued', 'api', ?, ?, ?, ?)`,
          id, d.app, d.server ?? "local", d.action, d.trigger ?? "upload", d.requestedBy ?? null, d.artifactSha256 ?? null, now(),
        );
        return deploymentFrom(one(`SELECT ${DEP_COLS} FROM deployments WHERE id = ?`, id)!);
      },
      update(id, patch) {
        const cols: Record<string, SQLInputValue> = {};
        if (patch.status !== undefined) cols.status = patch.status;
        if (patch.releaseId !== undefined) cols.release_id = patch.releaseId;
        if (patch.previousRelease !== undefined) cols.previous_release = patch.previousRelease;
        if (patch.error !== undefined) cols.error = patch.error;
        if (patch.warnings !== undefined) cols.warnings = JSON.stringify(patch.warnings);
        if (patch.historyAt !== undefined) cols.history_at = patch.historyAt;
        if (patch.startedAt !== undefined) cols.started_at = patch.startedAt;
        if (patch.finishedAt !== undefined) cols.finished_at = patch.finishedAt;
        if (patch.commitSha !== undefined) cols.commit_sha = patch.commitSha;
        if (patch.commitSubject !== undefined) cols.commit_subject = patch.commitSubject;
        if (patch.commitAuthor !== undefined) cols.commit_author = patch.commitAuthor;
        const keys = Object.keys(cols);
        if (keys.length === 0) return;
        tx(() => {
          const app = one("SELECT app FROM deployments WHERE id = ?", id)?.app as string | undefined;
          // A periodic sync may already have imported this host-history entry; the API row wins.
          if (app && patch.historyAt) run("DELETE FROM deployments WHERE app = ? AND history_at = ? AND id <> ? AND source = 'host'", app, patch.historyAt, id);
          run(`UPDATE deployments SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => cols[k]!), id);
        });
      },
      setLog(id, text) {
        run("UPDATE deployments SET log = ? WHERE id = ?", text, id);
      },
      getLog: (id) => (one("SELECT log FROM deployments WHERE id = ?", id)?.log as string | null | undefined) ?? null,
      get: (id) => {
        const r = one(`SELECT ${DEP_COLS} FROM deployments WHERE id = ?`, id);
        return r && deploymentFrom(r);
      },
      list(o = {}) {
        const limit = Math.min(Math.max(o.limit ?? 50, 1), 500);
        const rows = o.app
          ? all(`SELECT ${DEP_COLS} FROM deployments WHERE app = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, o.app, limit)
          : all(`SELECT ${DEP_COLS} FROM deployments ORDER BY created_at DESC, rowid DESC LIMIT ?`, limit);
        return rows.map(deploymentFrom);
      },
      importHistory(app, entries) {
        let added = 0;
        for (const e of entries) {
          const r = run(
            `INSERT OR IGNORE INTO deployments (id, app, server, action, status, release_id, previous_release, source, trigger, error, history_at, created_at, started_at, finished_at, commit_sha, commit_subject, commit_author)
             VALUES (?, ?, COALESCE((SELECT server FROM apps WHERE name = ?), 'local'), ?, ?, ?, ?, 'host', 'host', ?, ?, ?, ?, ?, ?, ?, ?)`,
            randomUUID(), app, app, e.action, e.result, e.release, e.previous, e.reason ?? null, e.at, e.at, e.at, e.at,
            e.source?.sha ?? null, e.source?.subject ?? null, e.source?.author ?? null,
          );
          added += Number(r.changes);
        }
        return added;
      },
      markInterrupted() {
        const r = run(
          "UPDATE deployments SET status = 'failed', error = 'interrupted by API restart', finished_at = ? WHERE status IN ('queued','running')",
          now(),
        );
        return Number(r.changes);
      },
    },

    tokens: {
      create({ name, role }) {
        if (!isRole(role)) throw new Error(`invalid role "${role}"`);
        const token = `fr_${randomBytes(32).toString("base64url")}`;
        const id = `tok_${randomBytes(6).toString("hex")}`;
        run("INSERT INTO api_tokens (id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, name, role, hashToken(token), now());
        return { token, row: tokenFrom(one("SELECT * FROM api_tokens WHERE id = ?", id)!) };
      },
      bootstrap(token) {
        if (!/^fr_[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("the bootstrap token must look like fr_ followed by at least 32 letters, digits, - or _");
        if (Number(one("SELECT COUNT(*) AS n FROM api_tokens")!.n) > 0) return false; // revoked tokens count: it is a first-run helper only
        run("INSERT INTO api_tokens (id, name, role, token_hash, created_at) VALUES (?, 'bootstrap', 'admin', ?, ?)", `tok_${randomBytes(6).toString("hex")}`, hashToken(token), now());
        return true;
      },
      verify(token) {
        const r = one("SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL", hashToken(token));
        if (!r) return null;
        const row = tokenFrom(r);
        const t = now();
        if (!row.lastUsedAt || Date.parse(t) - Date.parse(row.lastUsedAt) > 60_000) run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", t, row.id);
        return row;
      },
      list: () => all("SELECT * FROM api_tokens ORDER BY created_at, rowid").map(tokenFrom),
      revoke(id) {
        return Number(run("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now(), id).changes) > 0;
      },
    },

    metrics: {
      add(rows, at) {
        const t = at ?? now();
        tx(() => {
          for (const r of rows) {
            run(
              "INSERT INTO metrics_samples (app, service, unit, at, active, memory_bytes, cpu_nanos, restarts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              r.app, r.service, r.unit, t, r.active, r.memoryBytes, r.cpuNanos, r.restarts,
            );
          }
        });
      },
      series: (app, sinceIso) =>
        all("SELECT * FROM metrics_samples WHERE app = ? AND at >= ? ORDER BY service, at", app, sinceIso).map(
          (r): MetricSampleRow => ({
            app: r.app as string,
            service: r.service as string,
            unit: r.unit as string,
            at: r.at as string,
            active: r.active as string,
            memoryBytes: r.memory_bytes as number | null,
            cpuNanos: r.cpu_nanos as number | null,
            restarts: r.restarts as number,
          }),
        ),
      prune: (beforeIso) => Number(run("DELETE FROM metrics_samples WHERE at < ?", beforeIso).changes),
    },

    audit: {
      add(e) {
        run("INSERT INTO audit_log (at, token_id, action, app, detail) VALUES (?, ?, ?, ?, ?)", now(), e.tokenId ?? null, e.action, e.app ?? null, JSON.stringify(e.detail ?? {}));
      },
      list(limit = 100) {
        return all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", Math.min(Math.max(limit, 1), 1000)).map(
          (r): AuditRow => ({
            id: r.id as number,
            at: r.at as string,
            tokenId: r.token_id as string | null,
            action: r.action as string,
            app: r.app as string | null,
            detail: JSON.parse(r.detail as string),
          }),
        );
      },
    },
  };
}
