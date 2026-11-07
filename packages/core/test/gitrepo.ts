import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada Dev",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada Dev",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** A throw-away "remote": a bare repository plus a work tree to commit from. */
export async function makeRepo(files: Record<string, string>, branch = "main") {
  const root = await mkdtemp(join(tmpdir(), "freighter-repo-"));
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "--quiet", "-b", branch, bare);
  git(root, "init", "--quiet", "-b", branch, work);
  git(work, "remote", "add", "origin", bare);

  async function commit(change: Record<string, string | null>, message: string, onBranch = branch): Promise<string> {
    if (onBranch !== branch) {
      try {
        git(work, "checkout", "--quiet", onBranch);
      } catch {
        git(work, "checkout", "--quiet", "-b", onBranch);
      }
    }
    for (const [path, content] of Object.entries(change)) {
      const full = join(work, path);
      if (content === null) execFileSync("rm", ["-f", full]);
      else {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
      }
    }
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", message);
    git(work, "push", "--quiet", "origin", `${onBranch}:${onBranch}`);
    return git(work, "rev-parse", "HEAD");
  }
  const first = await commit(files, "initial commit");
  return { url: bare, work, commit, first };
}

export const APP_YAML = (name = "shop", extra = "") => `name: ${name}
services:
  web:
    command: node server.mjs
${extra}`;
