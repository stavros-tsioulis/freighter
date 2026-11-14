import { defineCommand, type CommandDef } from "citty";
import { usage } from "../lib/errors.ts";

type Tree = { [name: string]: Tree };

/** The command names of a citty command, as a tree (a lazy `host` is named but not opened). */
export async function commandTree(cmd: CommandDef): Promise<Tree> {
  const subs = typeof cmd.subCommands === "function" ? await cmd.subCommands() : await cmd.subCommands;
  const out: Tree = {};
  for (const [name, sub] of Object.entries(subs ?? {})) {
    if (name.startsWith("__")) continue; // internal
    const resolved = await (typeof sub === "function" ? (sub as () => Promise<CommandDef>)() : sub);
    out[name] = await commandTree(resolved as CommandDef);
  }
  return out;
}

const words = (t: Tree) => Object.keys(t).join(" ");

export function script(shell: string, tree: Tree): string {
  const top = words(tree);
  const nested = Object.entries(tree).filter(([, t]) => Object.keys(t).length > 0);
  if (shell === "bash") {
    const cases = nested.map(([n, t]) => `    ${n}) COMPREPLY=($(compgen -W "${words(t)}" -- "$cur")) ;;`).join("\n");
    return `_freighter() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W "${top}" -- "$cur")); return; fi\n  case "\${COMP_WORDS[1]}" in\n${cases}\n  esac\n}\ncomplete -F _freighter freighter\n`;
  }
  if (shell === "zsh") {
    const cases = nested.map(([n, t]) => `    ${n}) compadd ${words(t)} ;;`).join("\n");
    return `#compdef freighter\n_freighter() {\n  if (( CURRENT == 2 )); then compadd ${top}; return; fi\n  case "$words[2]" in\n${cases}\n  esac\n}\ncompdef _freighter freighter\n`;
  }
  if (shell === "fish") {
    const lines = [`complete -c freighter -f -n "__fish_use_subcommand" -a "${top}"`, ...nested.map(([n, t]) => `complete -c freighter -f -n "__fish_seen_subcommand_from ${n}" -a "${words(t)}"`)];
    return lines.join("\n") + "\n";
  }
  throw usage(`unknown shell "${shell}"`, "bash, zsh or fish");
}

export const completion = (root: () => CommandDef) =>
  defineCommand({
    meta: { name: "completion", description: "Print a shell completion script: bash, zsh or fish" },
    args: { shell: { type: "positional", required: true, description: "bash, zsh or fish" } },
    run: async ({ args }) => {
      process.stdout.write(script(args.shell, await commandTree(root())));
    },
  });
