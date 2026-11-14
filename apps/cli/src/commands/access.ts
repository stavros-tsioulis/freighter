import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { ago, readStdin } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";

const ROLES = ["viewer", "deployer", "admin"];

// ---- token ----

interface Token {
  id: string;
  name: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const tokenList = defineCommand({
  meta: { name: "list", description: "The API tokens (never their secrets)" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { tokens } = await api().get<{ tokens: Token[] }>("/tokens");
      out.ids(tokens.map((t) => t.id), tokens, () => out.table(["ID", "NAME", "ROLE", "LAST USED"], tokens.map((t) => [t.id, t.name, t.role, t.revokedAt ? out.paint("red", "revoked") : t.lastUsedAt ? ago(t.lastUsedAt) : "never"])));
    }),
});

const tokenCreate = defineCommand({
  meta: { name: "create", description: "Make an API token (shown once)" },
  args: { name: { type: "positional", required: true, description: "A label, like ci-github" }, role: { type: "string", default: "viewer", description: "viewer, deployer or admin" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      if (!ROLES.includes(args.role)) throw usage(`"${args.role}" is not a role`, "viewer, deployer or admin");
      const t = await api().post<Token & { token: string }>("/tokens", { name: args.name, role: args.role });
      out.ids([t.token], t, () => {
        out.line(`${t.id}  ${t.role}  ${t.name}\n`);
        out.line(t.token);
        out.note("\nKeep it now: it can't be shown again.");
      });
    }),
});

const tokenRevoke = defineCommand({
  meta: { name: "revoke", description: "Stop a token from working" },
  args: { id: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      await out.confirm(`Revoke ${args.id}? Anything using it stops working.`);
      await api().delete(`/tokens/${args.id}`);
      out.data({ revoked: args.id }, () => out.line(`Revoked ${args.id}.`));
    }),
});

export const token = defineCommand({ meta: { name: "token", description: "API tokens" }, subCommands: { list: tokenList, create: tokenCreate, revoke: tokenRevoke } });

// ---- ssh-key ----

interface SshKey {
  id: string;
  name: string;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  appCount: number;
}

const keyList = defineCommand({
  meta: { name: "list", description: "The SSH keys" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { keys } = await api().get<{ keys: SshKey[] }>("/ssh-keys");
      out.ids(keys.map((k) => k.name), keys, () => out.table(["NAME", "TYPE", "FINGERPRINT", "APPS"], keys.map((k) => [k.name, k.keyType, k.fingerprint, String(k.appCount)])));
    }),
});

const keyGenerate = defineCommand({
  meta: { name: "generate", description: "Make a key; its public half is shown" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const k = await api().post<SshKey>("/ssh-keys/generate", { name: args.name });
      out.ids([k.publicKey], k, () => out.line(k.publicKey));
    }),
});

const keyImport = defineCommand({
  meta: { name: "import", description: "Import a private key" },
  args: { name: { type: "positional", required: true }, file: { type: "string", required: true, description: "The key file, or - for standard input" }, "passphrase-stdin": { type: "boolean", description: "The key has a passphrase, which is the first line of standard input" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      let passphrase: string | undefined;
      let privateKey: string;
      if (args["passphrase-stdin"]) {
        if (args.file === "-") throw usage("the key and its passphrase can't both come from standard input");
        passphrase = (await readStdin()).replace(/\r?\n$/, "");
      }
      privateKey = args.file === "-" ? await readStdin() : (() => {
        try {
          return readFileSync(args.file, "utf8");
        } catch {
          throw new CliError(`cannot read ${args.file}`, EXIT.notFound);
        }
      })();
      const k = await api().post<SshKey>("/ssh-keys", { name: args.name, privateKey, ...(passphrase ? { passphrase } : {}) });
      out.ids([k.name], k, () => out.line(`Imported ${k.name} (${k.fingerprint}).`));
    }),
});

const keyRemove = defineCommand({
  meta: { name: "remove", description: "Remove a key that no app uses" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { keys } = await api().get<{ keys: SshKey[] }>("/ssh-keys");
      const k = keys.find((x) => x.name === args.name || x.id === args.name);
      if (!k) throw new CliError(`no SSH key named "${args.name}"`, EXIT.notFound);
      await out.confirm(`Remove the key ${k.name}?`);
      await api().delete(`/ssh-keys/${k.id}`);
      out.data({ removed: k.name }, () => out.line(`Removed ${k.name}.`));
    }),
});

export const sshKey = defineCommand({ meta: { name: "ssh-key", description: "SSH keys for cloning repositories and for SFTP storages" }, subCommands: { list: keyList, generate: keyGenerate, import: keyImport, remove: keyRemove } });

// ---- registry ----

interface Login {
  host: string;
  username: string;
  createdAt: string;
}

const regList = defineCommand({
  meta: { name: "list", description: "Registry logins" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { registries } = await api().get<{ registries: Login[] }>("/registries");
      out.ids(registries.map((r) => r.host), registries, () => out.table(["HOST", "USERNAME", "ADDED"], registries.map((r) => [r.host, r.username, ago(r.createdAt)])));
    }),
});

const regAdd = defineCommand({
  meta: { name: "add", description: "Save a login for a registry (the password is read from standard input)" },
  args: { host: { type: "positional", required: true }, username: { type: "string", required: true }, "password-stdin": { type: "boolean", description: "Read the password or token from standard input" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      if (!args["password-stdin"]) throw usage("the password is never an argument", "pipe it in with --password-stdin");
      const password = (await readStdin()).trim();
      if (!password) throw usage("the password is empty");
      await api().put(`/registries/${args.host}`, { username: args.username, password });
      out.data({ host: args.host, username: args.username }, () => out.line(`Saved the login for ${args.host} (${args.username}).`));
    }),
});

const regRemove = defineCommand({
  meta: { name: "remove", description: "Remove a login" },
  args: { host: { type: "positional", required: true }, username: { type: "string", description: "Which login, when the registry has several" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      await out.confirm(`Remove the login for ${args.host}${args.username ? ` (${args.username})` : ""}?`);
      await api().request("DELETE", `/registries/${args.host}`, { query: args.username ? { username: args.username } : undefined });
      out.data({ host: args.host }, () => out.line(`Removed the login for ${args.host}${args.username ? ` (${args.username})` : ""}.`));
    }),
});

export const registry = defineCommand({ meta: { name: "registry", description: "Logins for private container registries" }, subCommands: { list: regList, add: regAdd, remove: regRemove } });

// ---- cert ----

const certList = defineCommand({
  meta: { name: "list", description: "Every automatic certificate, soonest to expire first" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { certs } = await api().get<{ certs: { server: string; hostname: string; expires: string | null }[] }>("/certs");
      const sorted = [...certs].sort((a, b) => (a.expires ?? "9999") < (b.expires ?? "9999") ? -1 : 1);
      out.ids(sorted.map((c) => c.hostname), sorted, () =>
        out.table(["HOSTNAME", "SERVER", "EXPIRES", "DAYS LEFT"], sorted.map((c) => {
          const days = c.expires ? Math.floor((Date.parse(c.expires) - Date.now()) / 86_400_000) : null;
          const left = days === null ? "" : days < 7 ? out.paint("red", String(days)) : days < 14 ? out.paint("yellow", String(days)) : String(days);
          return [c.hostname, c.server, c.expires?.slice(0, 10) ?? "", left];
        })),
      );
    }),
});

const certRenew = defineCommand({
  meta: { name: "renew", description: "Renew what is due (or everything with --force)" },
  args: { force: { type: "boolean", description: "Renew everything, due or not" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { certs } = await api().post<{ certs: { server: string; hostname: string; issued: boolean }[] }>("/certs/renew", { ...(args.force ? { force: true } : {}) });
      const issued = certs.filter((c) => c.issued);
      out.data({ certs }, () => out.line(issued.length ? `Renewed ${issued.map((c) => c.hostname).join(", ")}.` : "Nothing was due."));
    }),
});

export const cert = defineCommand({ meta: { name: "cert", description: "Automatic HTTPS certificates" }, subCommands: { list: certList, renew: certRenew } });

// ---- audit, sync ----

interface Audit {
  id: number;
  at: string;
  tokenId: string | null;
  action: string;
  app: string | null;
  detail: Record<string, unknown>;
}

export const audit = defineCommand({
  meta: { name: "audit", description: "Who did what" },
  args: {
    app: { type: "string", description: "Only this app" },
    who: { type: "string", description: "Only this token (name or id)" },
    action: { type: "string", description: "Only actions starting with this, like deploy or console" },
    n: { type: "string", alias: "n", description: "How many entries", default: "50" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const n = Number(args.n);
      if (!Number.isInteger(n) || n < 1) throw usage("-n is a number");
      const filtered = !!(args.app || args.who || args.action);
      const [{ entries }, { tokens }] = await Promise.all([api().get<{ entries: Audit[] }>("/audit", { limit: filtered ? Math.min(n * 20, 1000) : n }), api().get<{ tokens: Token[] }>("/tokens")]);
      const nameOf = (id: string | null) => (id ? (tokens.find((t) => t.id === id)?.name ?? id) : "");
      const shown = entries
        .filter((e) => (!args.app || e.app === args.app) && (!args.action || e.action.startsWith(args.action)) && (!args.who || e.tokenId === args.who || nameOf(e.tokenId) === args.who))
        .slice(0, n);
      out.data(shown, () =>
        out.table(["WHEN", "WHO", "ACTION", "APP", "DETAIL"], shown.map((e) => [ago(e.at), nameOf(e.tokenId), e.action, e.app ?? "", Object.entries(e.detail ?? {}).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")])),
      );
    }),
});

export const sync = defineCommand({
  meta: { name: "sync", description: "Re-read every server now" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const r = await api().post<Record<string, unknown>>("/sync");
      out.data(r, () => out.line("Synced."));
    }),
});
