/** Same rule as the API and manifest: lowercase letters/digits joined by single hyphens, starting with a letter. */
export const IDENT_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Returns an explanation when `url` would not be accepted by the server, or "" when it looks fine. */
export function validateRepoUrl(url: string): string {
  const u = url.trim();
  if (u.startsWith("-") || /[\s\x00-\x1f]/.test(u)) return "Not a valid repository URL";
  const ok =
    /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~/-]+$/.test(u) ||
    /^ssh:\/\/([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/.test(u) ||
    /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?\/[A-Za-z0-9._~/-]+$/.test(u);
  return ok && !u.includes("..") ? "" : "Use git@host:org/repo.git, ssh://… or https://…";
}
