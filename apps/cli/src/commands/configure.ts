import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest, renderManifest } from "@freighter/manifest";
import { defineCommand } from "citty";
import type { Api } from "../lib/api.ts";
import { lineDiff } from "../lib/diff.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { promptSecret, readStdin } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";
import { serviceTarget, target } from "../lib/target.ts";
import { finish, follow, parseSpan, conclude } from "../lib/wait.ts";

const waitArgs = {
  wait: { type: "boolean", default: true, description: "Wait for the change to be applied (--no-wait returns its id)" },
  verbose: { type: "boolean", alias: "v", description: "Show the whole deployment log" },
  timeout: { type: "string", description: "Stop waiting after this long (the change carries on)" },
} as const;
const waiting = (args: { wait?: boolean; verbose?: boolean; timeout?: string }) => ({ wait: args.wait !== false, verbose: args.verbose, timeoutMs: args.timeout ? parseSpan(args.timeout) : undefined });

interface ConfigView {
  text: string | null;
  settings: Record<string, any> | null;
  pending: Record<string, any> | null;
}

/** The text of an app.yaml as the settings the API takes, and the app it names. */
function settingsOf(text: string): { name: string; settings: Record<string, unknown> } {
  const { name, source: _source, ...settings } = parseManifest(text, { legacy: true, raw: true });
  return { name, settings };
}

async function putConfig(api: Api, app: string, settings: Record<string, unknown>): Promise<{ id: string }> {
  return api.put<{ id: string }>(`/apps/${app}/config`, { settings });
}

// ---- config ----

const configShow = defineCommand({
  meta: { name: "show", description: "An app's configuration, as app.yaml" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const c = await api().get<ConfigView>(`/apps/${app}/config`);
      if (!c.text) throw new CliError(`${app} has no configuration yet`, EXIT.notFound, "it gets one with its first deployment");
      out.data({ app, text: c.text, settings: c.settings }, () => process.stdout.write(c.text!.endsWith("\n") ? c.text! : `${c.text}\n`));
    }),
});

const configApply = defineCommand({
  meta: { name: "apply", description: "Replace an app's configuration with an app.yaml" },
  args: { app: { type: "positional", required: false }, file: { type: "string", alias: "f", description: "The app.yaml", default: "app.yaml" }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const text = await readFile(args.file, "utf8").catch(() => {
        throw new CliError(`cannot read ${args.file}`, EXIT.notFound);
      });
      const { name, settings } = settingsOf(text);
      if (args.app && args.app !== name) throw usage(`${args.file} is for "${name}", not "${args.app}"`);
      const q = await putConfig(api(), name, settings);
      out.step(`Applying ${args.file} to ${name}`);
      await finish(api(), out, q, { ...waiting(args), verb: "configuration change" });
    }),
});

const configDiff = defineCommand({
  meta: { name: "diff", description: "What applying an app.yaml would change" },
  args: { app: { type: "positional", required: false }, file: { type: "string", alias: "f", description: "The app.yaml", default: "app.yaml" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const text = await readFile(args.file, "utf8").catch(() => {
        throw new CliError(`cannot read ${args.file}`, EXIT.notFound);
      });
      const { name, settings } = settingsOf(text);
      if (args.app && args.app !== name) throw usage(`${args.file} is for "${name}", not "${args.app}"`);
      const current = await api().get<ConfigView>(`/apps/${name}/config`);
      if (!current.text) throw new CliError(`${name} has no configuration yet`, EXIT.notFound);
      // both written the same way, so only real changes show
      const before = (() => {
        try {
          return renderManifest(name, settingsOf(current.text!).settings as never);
        } catch {
          return current.text!;
        }
      })();
      const lines = lineDiff(before, renderManifest(name, settings as never));
      out.data({ app: name, changed: lines.length > 0, diff: lines }, () => {
        if (lines.length === 0) return out.line("No changes.");
        for (const l of lines) out.line(l.startsWith("+") ? out.paint("green", l) : l.startsWith("-") ? out.paint("red", l) : l);
      });
    }),
});

const configEdit = defineCommand({
  meta: { name: "edit", description: "Edit an app's configuration in $EDITOR, and apply it when you save" },
  args: { app: { type: "positional", required: false }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      if (!out.interactive) throw usage("`config edit` needs a terminal", "use `freighter config show` and `freighter config apply -f` in a script");
      const { app } = target(args.app);
      const c = await api().get<ConfigView>(`/apps/${app}/config`);
      if (!c.text) throw new CliError(`${app} has no configuration yet`, EXIT.notFound);
      const dir = mkdtempSync(join(tmpdir(), "freighter-edit-"));
      const file = join(dir, "app.yaml");
      try {
        writeFileSync(file, c.text, { mode: 0o600 });
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        const r = spawnSync(editor, [file], { stdio: "inherit", shell: true });
        if (r.status !== 0) throw new CliError(`${editor} exited with ${r.status}; nothing was changed`);
        const edited = readFileSync(file, "utf8");
        if (edited === c.text) return out.data({ app, changed: false }, () => out.line("No changes."));
        const { name, settings } = settingsOf(edited);
        if (name !== app) throw usage(`the name is ${app}; it can't be changed to ${name}`);
        const q = await putConfig(api(), app, settings);
        out.step(`Applying the new configuration to ${app}`);
        await finish(api(), out, q, { ...waiting(args), verb: "configuration change" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
});

export const config = defineCommand({
  meta: { name: "config", description: "An app's configuration" },
  subCommands: { show: configShow, edit: configEdit, apply: configApply, diff: configDiff },
});

// ---- var ----

interface Variable {
  service: string;
  key: string;
  value: string;
  resolved: string | null;
  error: string | null;
  source: "service" | "app";
  secret: boolean;
  reference: boolean;
}

/** The `KEY=VALUE` words after the target: the positionals citty keeps in `_`. */
function pairs(rest: string[]): [string, string][] {
  if (rest.length === 0) throw usage("give at least one KEY=VALUE");
  return rest.map((w) => {
    const i = w.indexOf("=");
    if (i < 1) throw usage(`"${w}" is not KEY=VALUE`);
    const key = w.slice(0, i);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw usage(`"${key}" is not a valid name`, "names are UPPER_SNAKE_CASE");
    return [key, w.slice(i + 1)];
  });
}

const varList = defineCommand({
  meta: { name: "list", description: "An app's variables" },
  args: { target: { type: "positional", required: false, description: "app or app/service" }, resolved: { type: "boolean", description: "Show what each connection resolves to" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const t = target(args.target);
      const { variables } = await api().get<{ variables: Variable[] }>(`/apps/${t.app}/variables`);
      const shown = variables.filter((v) => !t.service || v.service === t.service);
      out.ids(shown.map((v) => v.key), shown, () => {
        if (shown.length === 0) return out.note("no variables");
        const withService = !t.service;
        out.table(
          [...(withService ? ["SERVICE"] : []), "KEY", "VALUE", "FROM", ...(args.resolved ? ["RESOLVED"] : [])],
          shown.map((v) => [...(withService ? [v.service] : []), v.key, v.value, v.source, ...(args.resolved ? [v.error ? out.paint("red", v.error) : v.reference ? (v.secret ? "(a credential)" : (v.resolved ?? "")) : ""] : [])]),
        );
      });
    }),
});

const varSet = defineCommand({
  meta: { name: "set", description: "Set variables: KEY=VALUE ..." },
  args: { target: { type: "positional", required: true, description: "app or app/service" }, build: { type: "boolean", description: "The build's environment" }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const t = target(args.target);
      const kv = pairs(((args as { _?: string[] })._ ?? []).slice(1));
      let last: { id: string } | undefined;
      if (t.service && !args.build) {
        for (const [key, value] of kv) last = await api().put<{ id: string }>(`/apps/${t.app}/services/${t.service}/variables/${key}`, { value });
      } else {
        last = await changeSettings(api(), t.app, args.build ? "build" : "app", (env) => Object.assign(env, Object.fromEntries(kv)));
      }
      out.step(`Setting ${kv.map(([k]) => k).join(", ")} on ${t.service ? `${t.app}/${t.service}` : t.app}${args.build ? " (build)" : ""}`);
      await finish(api(), out, last!, { ...waiting(args), verb: "variable change" });
    }),
});

const varUnset = defineCommand({
  meta: { name: "unset", description: "Remove variables: KEY ..." },
  args: { target: { type: "positional", required: true, description: "app or app/service" }, build: { type: "boolean", description: "The build's environment" }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const t = target(args.target);
      const keys = ((args as { _?: string[] })._ ?? []).slice(1);
      if (keys.length === 0) throw usage("give at least one KEY");
      let last: { id: string } | undefined;
      if (t.service && !args.build) {
        for (const key of keys) last = await api().delete<{ id: string }>(`/apps/${t.app}/services/${t.service}/variables/${key}`);
      } else {
        last = await changeSettings(api(), t.app, args.build ? "build" : "app", (env) => keys.forEach((k) => delete env[k]));
      }
      out.step(`Removing ${keys.join(", ")} from ${t.service ? `${t.app}/${t.service}` : t.app}${args.build ? " (build)" : ""}`);
      await finish(api(), out, last!, { ...waiting(args), verb: "variable change" });
    }),
});

/** Change the app-level or build environment: it lives in the app's configuration, which is replaced whole. */
async function changeSettings(api: Api, app: string, which: "app" | "build", change: (env: Record<string, string>) => void): Promise<{ id: string }> {
  const c = await api.get<ConfigView>(`/apps/${app}/config`);
  if (!c.settings) throw new CliError(`${app} has no configuration yet`, EXIT.notFound);
  const settings = structuredClone(c.settings) as Record<string, any>;
  if (which === "build") {
    if (!settings.build) throw usage(`${app} has no build section: there is no build environment to change`);
    settings.build.environment = settings.build.environment ?? {};
    change(settings.build.environment);
  } else {
    settings.environment = settings.environment ?? {};
    change(settings.environment);
  }
  const { name: _n, source: _s, ...rest } = settings;
  return putConfig(api, app, rest);
}

export const variable = defineCommand({
  meta: { name: "var", description: "An app's plain variables (the `environment:` of its services)" },
  subCommands: { list: varList, set: varSet, unset: varUnset },
});

// ---- secret ----

const secretList = defineCommand({
  meta: { name: "list", description: "The names of a service's secrets, and whether each has a value" },
  args: { target: { type: "positional", required: false, description: "app/service" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const t = serviceTarget(args.target);
      const { names, declared } = await api().get<{ names: string[]; declared: string[] }>(`/apps/${t.app}/services/${t.service}/env`);
      const all = [...new Set([...declared, ...names])].sort();
      out.ids(all, all.map((n) => ({ name: n, set: names.includes(n), declared: declared.includes(n) })), () => {
        if (all.length === 0) return out.note("no secrets");
        out.table(["NAME", "SET"], all.map((n) => [n, names.includes(n) ? "yes" : out.paint("yellow", "no")]));
      });
    }),
});

const secretSet = defineCommand({
  meta: { name: "set", description: "Set a secret's value (asked for, or read from standard input)" },
  args: { target: { type: "positional", required: true, description: "app/service" }, key: { type: "positional", required: true }, stdin: { type: "boolean", description: "Read the value from standard input" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const t = serviceTarget(args.target);
      if (args.key.includes("=")) throw usage("a secret's value is never an argument, so it stays out of your shell history", "use --stdin, or leave it out to be asked");
      if (!/^[A-Z_][A-Z0-9_]*$/.test(args.key)) throw usage(`"${args.key}" is not a valid name`, "names are UPPER_SNAKE_CASE");
      let value: string;
      if (args.stdin) value = (await readStdin()).replace(/\r?\n$/, "");
      else if (out.interactive) value = await promptSecret(`Value for ${args.key}: `);
      else throw usage("no terminal to ask for the value", "pass it on standard input with --stdin");
      if (!value) throw usage("the value is empty");
      await api().put(`/apps/${t.app}/services/${t.service}/env/${args.key}`, { value });
      out.data({ app: t.app, service: t.service, key: args.key }, () => out.line(`Set ${args.key} on ${t.app}/${t.service}. Release it again to use it: freighter redeploy ${t.app}`));
    }),
});

export const secret = defineCommand({
  meta: { name: "secret", description: "A service's secrets, which are write-only" },
  subCommands: { list: secretList, set: secretSet },
});

// ---- domain ----

interface DomainRow {
  hostname: string;
  service: string;
  tls: string;
  status: "active" | "pending";
  lastError: string | null;
}

const domainList = defineCommand({
  meta: { name: "list", description: "An app's domains" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const { domains } = await api().get<{ domains: DomainRow[] }>(`/apps/${app}/domains`);
      out.ids(domains.map((d) => d.hostname), domains, () => {
        if (domains.length === 0) return out.note(`${app} has no domains: \`freighter domain add ${app} <hostname> --service <service>\``);
        out.table(["HOSTNAME", "SERVICE", "TLS", "STATE"], domains.map((d) => [d.hostname, d.service, d.tls === "auto" ? "automatic" : "off", d.status === "active" ? "live" : d.lastError ? `waiting for DNS (${d.lastError})` : "waiting for DNS"]));
      });
    }),
});

const domainAdd = defineCommand({
  meta: { name: "add", description: "Add a domain to a service" },
  args: {
    app: { type: "positional", required: true, description: "The app, then the hostname (the app can be left out in a project directory)" },
    hostname: { type: "positional", required: false },
    service: { type: "string", description: "The service that serves it" },
    http: { type: "boolean", description: "Serve it without HTTPS" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const hostArg = args.hostname ?? (args.app.includes(".") ? args.app : undefined);
      const appArg = args.hostname ? args.app : args.app.includes(".") ? undefined : args.app;
      if (!hostArg) throw usage("which hostname?", "freighter domain add <app> <hostname> --service <service>");
      const { app } = target(appArg);
      if (!args.service) throw usage(`which service of ${app} serves ${hostArg}?`, `add --service <service>`);
      const r = await api().post<{ domain: DomainRow; dns: { records: { type: string; value: string }[] } }>(`/apps/${app}/domains`, { hostname: hostArg, service: args.service, tls: args.http ? "off" : "auto" });
      out.data(r, () => {
        out.line(`Added ${r.domain.hostname} to ${app}/${r.domain.service}. At your DNS provider, add:`);
        if (r.dns.records.length === 0) out.line("  (this server's public address isn't known: set api.publicIps in config.yaml)");
        for (const rec of r.dns.records) out.line(`  ${rec.type.padEnd(6)} ${r.domain.hostname}   ${rec.value}`);
        out.line(`Then run: freighter domain verify ${app} ${r.domain.hostname}`);
      });
    }),
});

const domainVerify = defineCommand({
  meta: { name: "verify", description: "Check the DNS records, and put the domain live" },
  args: { app: { type: "positional", required: true }, hostname: { type: "positional", required: false }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const hostArg = args.hostname ?? (args.app.includes(".") ? args.app : undefined);
      const { app } = target(args.hostname ? args.app : args.app.includes(".") ? undefined : args.app);
      if (!hostArg) throw usage("which hostname?");
      const r = await api().post<{ verified: boolean; id?: string; reason?: string | null; found?: string[]; expected?: string[]; cloudflare?: boolean }>(`/apps/${app}/domains/${hostArg}/verify`, {});
      if (!r.verified) {
        const detail = [r.found?.length ? `found ${r.found.join(", ")}` : "", r.expected?.length ? `expected ${r.expected.join(", ")}` : ""].filter(Boolean).join("; ");
        throw new CliError(`${hostArg} isn't ready: ${r.reason ?? "the records don't match"}${detail ? ` (${detail})` : ""}`, EXIT.failed, "DNS changes can take a few minutes to spread; try again shortly");
      }
      out.step(`DNS is right for ${hostArg}; putting it live`);
      if (r.id) {
        const d = await follow(api(), out, r.id, waiting(args));
        conclude(out, d, { verb: "domain change" });
        out.data(d, () => out.line(`${hostArg} is live.`));
      } else out.data(r, () => out.line(`${hostArg} is live.`));
    }),
});

const domainRemove = defineCommand({
  meta: { name: "remove", description: "Remove a domain; nothing is redeployed" },
  args: { app: { type: "positional", required: true }, hostname: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const hostArg = args.hostname ?? (args.app.includes(".") ? args.app : undefined);
      const { app } = target(args.hostname ? args.app : args.app.includes(".") ? undefined : args.app);
      if (!hostArg) throw usage("which hostname?");
      await api().delete(`/apps/${app}/domains/${hostArg}`);
      out.data({ app, hostname: hostArg }, () => out.line(`Removed ${hostArg} from ${app}.`));
    }),
});

export const domain = defineCommand({
  meta: { name: "domain", description: "An app's hostnames" },
  subCommands: { list: domainList, add: domainAdd, verify: domainVerify, remove: domainRemove },
});

// ---- volume ----

const volumeList = defineCommand({
  meta: { name: "list", description: "An app's remote volumes, and whether they are mounted" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const { volumes } = await api().get<{ volumes: Record<string, { type: string; state: string; password: boolean | null }> }>(`/apps/${app}/volumes`);
      const rows = Object.entries(volumes);
      out.ids(rows.map(([n]) => n), volumes, () => {
        if (rows.length === 0) return out.note(`${app} has no remote volumes`);
        out.table(["VOLUME", "TYPE", "STATE", "PASSWORD"], rows.map(([n, v]) => [n, v.type, v.state, v.password === null ? "" : v.password ? "set" : out.paint("yellow", "not set")]));
      });
    }),
});

const volumePassword = defineCommand({
  meta: { name: "password", description: "Set the password of an SMB volume (asked for, or from standard input)" },
  args: { app: { type: "positional", required: true }, name: { type: "positional", required: false }, stdin: { type: "boolean", description: "Read it from standard input" }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const nameArg = args.name ?? args.app;
      const { app } = target(args.name ? args.app : undefined);
      let password: string;
      if (args.stdin) password = (await readStdin()).replace(/\r?\n$/, "");
      else if (out.interactive) password = await promptSecret(`Password for ${nameArg}: `);
      else throw usage("no terminal to ask for the password", "pass it on standard input with --stdin");
      await api().put(`/apps/${app}/volumes/${nameArg}/password`, { password });
      out.data({ app, volume: nameArg }, () => out.line(`Set the password of ${nameArg}.`));
    }),
});

export const volume = defineCommand({
  meta: { name: "volume", description: "An app's volumes" },
  subCommands: { list: volumeList, password: volumePassword },
});

// ---- git ----

interface Link {
  repository: string;
  branch: string;
  subpath: string;
  provider: string;
  autoDeploy: boolean;
  publicKey: string;
  sshKey?: { name: string; fingerprint: string } | null;
  webhookUrl: string;
  lastDeliveryAt: string | null;
  lastDeliveryResult: string | null;
}

const gitShow = defineCommand({
  meta: { name: "show", description: "An app's repository link" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const l = await api().get<Link>(`/apps/${app}/git`);
      out.data(l, () =>
        out.facts([
          ["repository", l.repository],
          ["branch", `${l.branch}${l.subpath ? `  (subdirectory ${l.subpath})` : ""}`],
          ["ssh key", l.sshKey ? `${l.sshKey.name} (${l.sshKey.fingerprint})` : "a deploy key made for this app"],
          ["on push", l.autoDeploy ? "deploys" : "does nothing"],
          ["webhook", l.webhookUrl],
          ["last push", l.lastDeliveryAt ? `${l.lastDeliveryAt}  ${l.lastDeliveryResult}` : "none yet"],
        ]),
      );
    }),
});

const gitLink = defineCommand({
  meta: { name: "link", description: "Link an app to a Git repository" },
  args: {
    app: { type: "positional", required: true },
    repo: { type: "positional", required: true, description: "git@host:org/repo.git or https://…" },
    branch: { type: "string", default: "main" },
    provider: { type: "string", default: "github", description: "github, gitlab or other" },
    key: { type: "string", description: "An imported SSH key (default: a deploy key is made)" },
    subpath: { type: "string", default: "" },
    auto: { type: "boolean", default: true, description: "Deploy on push (--no-auto to turn it off)" },
    server: { type: "string", description: "Server for a new app" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      let sshKeyId: string | null = null;
      if (args.key) {
        const { keys } = await api().get<{ keys: { id: string; name: string }[] }>("/ssh-keys");
        sshKeyId = keys.find((k) => k.name === args.key || k.id === args.key)?.id ?? null;
        if (!sshKeyId) throw new CliError(`no imported SSH key named "${args.key}"`, EXIT.notFound, "see `freighter ssh-key list`");
      }
      const r = await api().put<{ link: Link; webhookSecret?: string }>(`/apps/${app}/git`, { repository: args.repo, branch: args.branch, provider: args.provider, subpath: args.subpath, autoDeploy: args.auto, sshKeyId, ...(args.server ? { server: args.server } : {}) });
      out.data(r, () => {
        out.line(`Linked ${app} to ${r.link.repository} (${r.link.branch}).`);
        if (!sshKeyId) out.line(`\nAdd this deploy key (read-only) to the repository:\n  ${r.link.publicKey}`);
        out.line(`\nFor deploys on push, add a webhook:\n  URL     ${r.link.webhookUrl}\n  Secret  ${r.webhookSecret ?? "(unchanged: `freighter git rotate-secret` makes a new one)"}`);
        if (r.webhookSecret) out.line("The secret is shown once.");
      });
    }),
});

const gitCheck = defineCommand({
  meta: { name: "check", description: "Test that the server can reach the repository" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const r = await api().post<{ sha: string }>(`/apps/${app}/git/check`);
      out.data(r, () => out.line(`Reached it: the branch is at ${r.sha.slice(0, 12)}.`));
    }),
});

const gitDeploy = defineCommand({
  meta: { name: "deploy", description: "Build the branch head and deploy it now" },
  args: { app: { type: "positional", required: false }, ...waitArgs, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const q = await api().post<{ id: string; coalesced?: boolean }>(`/apps/${app}/git/deploy`);
      out.step(q.coalesced ? `Joining the deployment already waiting for ${app}` : `Deploying ${app} from Git`);
      await finish(api(), out, q, waiting(args));
    }),
});

const gitRotateSecret = defineCommand({
  meta: { name: "rotate-secret", description: "Make a new webhook secret (shown once)" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const r = await api().post<{ webhookSecret: string }>(`/apps/${app}/git/rotate-secret`);
      out.ids([r.webhookSecret], r, () => out.line(r.webhookSecret));
    }),
});

const gitRotateKey = defineCommand({
  meta: { name: "rotate-key", description: "Make a new deploy key (its public half is shown)" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      const r = await api().post<{ publicKey: string }>(`/apps/${app}/git/rotate-key`);
      out.ids([r.publicKey], r, () => out.line(r.publicKey));
    }),
});

const gitUnlink = defineCommand({
  meta: { name: "unlink", description: "Stop deploying an app from Git" },
  args: { app: { type: "positional", required: false }, ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api }) => {
      const { app } = target(args.app);
      await out.confirm(`Unlink ${app} from Git? It keeps running; pushes stop deploying it.`);
      await api().delete(`/apps/${app}/git`);
      out.data({ app }, () => out.line(`Unlinked ${app}.`));
    }),
});

export const git = defineCommand({
  meta: { name: "git", description: "An app that builds from a Git repository" },
  subCommands: { show: gitShow, link: gitLink, check: gitCheck, deploy: gitDeploy, "rotate-secret": gitRotateSecret, "rotate-key": gitRotateKey, unlink: gitUnlink },
});
