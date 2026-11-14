import { defineCommand } from "citty";
import { Api } from "../lib/api.ts";
import { readConfig, resolveConnection, writeConfig } from "../lib/config.ts";
import { CliError, EXIT, usage } from "../lib/errors.ts";
import { promptSecret } from "../lib/out.ts";
import { globalArgs, run } from "../lib/run.ts";

interface Who {
  id: string;
  name: string;
  role: string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** `freighter.example.com`, `https://freighter.example.com/` and `http://localhost:3000` all name a Freighter. */
function normalize(address: string): string {
  const withScheme = /^https?:\/\//.test(address) ? address : `${/^(localhost|127\.|\[::1\])/.test(address) ? "http" : "https"}://${address}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw usage(`"${address}" is not a URL`);
  }
}

export const login = defineCommand({
  meta: { name: "login", description: "Sign in to a Freighter and save it as a context" },
  args: {
    address: { type: "positional", required: false, description: "The Freighter's address (https://freighter.example.com)" },
    name: { type: "string", description: "Name for this context (default: the host)" },
    ...globalArgs,
  },
  run: ({ args }) =>
    run(args, async ({ out }) => {
      const config = readConfig();
      const existing = config.current ? config.contexts[config.current] : undefined;
      const address = args.address ?? args.url ?? process.env.FREIGHTER_URL ?? existing?.url;
      if (!address) throw usage("which Freighter?", "freighter login https://freighter.example.com");
      const url = normalize(address);
      const token = args.token ?? process.env.FREIGHTER_TOKEN ?? (await promptSecret(`Token (from API tokens in the dashboard): `));
      if (!token.trim()) throw usage("no token given");
      const who = await new Api(url, token.trim()).get<Who>("/session");
      const name = args.name ?? hostOf(url);
      config.contexts[name] = { url, token: token.trim(), user: who.name, role: who.role };
      config.current = name;
      writeConfig(config);
      out.data({ context: name, url, user: who.name, role: who.role }, () => out.line(`Signed in to ${hostOf(url)} as ${who.name} (${who.role}).`));
    }),
});

export const logout = defineCommand({
  meta: { name: "logout", description: "Forget a context" },
  args: { name: { type: "positional", required: false, description: "The context (default: the current one)" }, ...globalArgs },
  run: ({ args }) =>
    run(args, ({ out }) => {
      const config = readConfig();
      const name = args.name ?? args.context ?? config.current;
      if (!name || !config.contexts[name]) throw new CliError(name ? `no context named "${name}"` : "not signed in", name ? EXIT.notFound : EXIT.auth);
      delete config.contexts[name];
      if (config.current === name) config.current = Object.keys(config.contexts)[0];
      writeConfig(config);
      out.data({ removed: name }, () => out.line(`Signed out of ${name}.`));
    }),
});

export const whoami = defineCommand({
  meta: { name: "whoami", description: "Show who you are signed in as" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, async ({ out, api, connection }) => {
      const who = await api().get<Who>("/session");
      out.data({ ...who, url: connection().url, context: connection().context }, () => out.line(`${who.name} (${who.role}) on ${hostOf(connection().url)}`));
    }),
});

const list = defineCommand({
  meta: { name: "list", description: "List the contexts" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, ({ out }) => {
      const config = readConfig();
      const names = Object.keys(config.contexts).sort();
      out.ids(names, names.map((n) => ({ name: n, current: n === config.current, ...config.contexts[n]!, token: undefined })), () => {
        if (names.length === 0) return out.note("no contexts: sign in with `freighter login <url>`");
        out.table(["", "CONTEXT", "URL", "USER", "ROLE"], names.map((n) => [n === config.current ? "*" : "", n, config.contexts[n]!.url, config.contexts[n]!.user ?? "", config.contexts[n]!.role ?? ""]));
      });
    }),
});

const use = defineCommand({
  meta: { name: "use", description: "Make a context the current one" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, ({ out }) => {
      const config = readConfig();
      if (!config.contexts[args.name]) throw new CliError(`no context named "${args.name}"`, EXIT.notFound, "see `freighter context list`");
      config.current = args.name;
      writeConfig(config);
      out.data({ current: args.name }, () => out.line(`Now using ${args.name}.`));
    }),
});

const show = defineCommand({
  meta: { name: "show", description: "Show which Freighter commands go to now" },
  args: { ...globalArgs },
  run: ({ args }) =>
    run(args, ({ out }) => {
      const c = resolveConnection(args);
      out.data({ context: c.context, url: c.url }, () => out.line(c.context ? `${c.context}  ${c.url}` : c.url));
    }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Forget a context" },
  args: { name: { type: "positional", required: true }, ...globalArgs },
  run: ({ args }) =>
    run(args, ({ out }) => {
      const config = readConfig();
      if (!config.contexts[args.name]) throw new CliError(`no context named "${args.name}"`, EXIT.notFound);
      delete config.contexts[args.name];
      if (config.current === args.name) config.current = Object.keys(config.contexts)[0];
      writeConfig(config);
      out.data({ removed: args.name }, () => out.line(`Removed ${args.name}.`));
    }),
});

export const context = defineCommand({
  meta: { name: "context", description: "Switch between Freighters you have signed in to" },
  subCommands: { list, use, show, remove },
});
