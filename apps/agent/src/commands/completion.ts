import { defineCommand } from "citty";
import { usage } from "../lib/cli.ts";

export type Tree = { [name: string]: Tree };

const words = (tree: Tree) => Object.keys(tree).join(" ");

function functionName(program: string): string {
  return `_${program.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

export function script(shell: string, tree: Tree, program: string): string {
  const top = words(tree);
  const nested = Object.entries(tree).filter(([, sub]) => Object.keys(sub).length > 0);
  const complete = functionName(program);

  if (shell === "bash") {
    const cases = nested.map(([name, sub]) => `    ${name}) COMPREPLY=($(compgen -W "${words(sub)}" -- "$cur")) ;;`).join("\n");
    return `${complete}() {\n  local cur="\${COMP_WORDS[COMP_CWORD]}"\n  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W "${top}" -- "$cur")); return; fi\n  case "\${COMP_WORDS[1]}" in\n${cases}\n  esac\n}\ncomplete -F ${complete} ${program}\n`;
  }
  if (shell === "zsh") {
    const cases = nested.map(([name, sub]) => `    ${name}) compadd ${words(sub)} ;;`).join("\n");
    return `#compdef ${program}\n${complete}() {\n  if (( CURRENT == 2 )); then compadd ${top}; return; fi\n  case "$words[2]" in\n${cases}\n  esac\n}\ncompdef ${complete} ${program}\n`;
  }
  if (shell === "fish") {
    const lines = [`complete -c ${program} -f -n "__fish_use_subcommand" -a "${top}"`, ...nested.map(([name, sub]) => `complete -c ${program} -f -n "__fish_seen_subcommand_from ${name}" -a "${words(sub)}"`)];
    return `${lines.join("\n")}\n`;
  }
  throw usage(`unknown shell "${shell}"`, "bash, zsh or fish");
}

export const completion = (tree: Tree) =>
  defineCommand({
    meta: { name: "completion", description: "Print a shell completion script: bash, zsh or fish" },
    args: { shell: { type: "positional", required: true, description: "bash, zsh or fish" } },
    run: ({ args }) => {
      process.stdout.write(script(args.shell, tree, "freighter-agent"));
    },
  });
