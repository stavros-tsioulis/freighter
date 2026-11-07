/**
 * Validation for the strings that end up on a `git` command line. Everything here is allow-list based:
 * anything unusual (option-like values, `ext::`/`file:` transports, whitespace, control characters) is refused.
 */

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~/-]+$/; // git@github.com:org/repo.git
const SSH_URL = /^ssh:\/\/([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/;
const LOCAL_PATH = /^(file:\/\/)?\/[A-Za-z0-9._~/-]+$/;

/** Returns the trimmed URL, or throws. `allowLocal` additionally accepts absolute paths, file:// (tests/lab only). */
export function validateRepoUrl(url: string, opts: { allowLocal?: boolean } = {}): string {
  const u = url.trim();
  if (u === "" || u.length > 300) throw new Error("repository URL is empty or too long");
  if (u.startsWith("-")) throw new Error("repository URL must not start with '-'");
  if (/[\s\x00-\x1f\x7f]/.test(u)) throw new Error("repository URL must not contain whitespace or control characters");
  if (u.includes("..")) throw new Error("repository URL must not contain '..'");
  if (SCP_LIKE.test(u) || SSH_URL.test(u) || HTTPS_URL.test(u)) return u;
  if (opts.allowLocal && (LOCAL_PATH.test(u))) return u;
  throw new Error("unsupported repository URL (use git@host:org/repo.git, ssh://… or https://…)");
}

/** A plain branch name: no leading '-', no '..', no refspec or revision syntax. */
export function validateBranch(branch: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes("..") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new Error(`invalid branch name "${branch}"`);
  }
  return branch;
}

/** A relative directory inside the repository ("" means the root). */
export function validateSubpath(subpath: string): string {
  const p = subpath.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (p === "") return "";
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) || p.split("/").some((s) => s === "." || s === "..")) {
    throw new Error(`invalid subpath "${subpath}"`);
  }
  return p;
}
