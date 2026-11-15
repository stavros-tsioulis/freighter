import type { GitLink } from "~/types";

/** The repository's web address, from the git@, ssh:// or https:// URL it was linked with. */
export function repoWebUrl(repository: string | null | undefined): string | null {
  if (!repository) return null;
  const raw = repository.trim().replace(/\.git$/, "");
  const scp = raw.match(/^[^@\s]+@([^:/\s]+):(.+)$/);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^ssh:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return `https://${u.hostname}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return null;
    }
  }
  return null;
}

/** A link to the commit on the host's web UI; for an unknown host, the repository itself. */
export function commitUrl(link: GitLink | null | undefined, sha: string | null | undefined): string | null {
  if (!link || !sha) return null;
  const base = repoWebUrl(link.repository);
  if (!base) return null;
  if (link.provider === "gitlab") return `${base}/-/commit/${sha}`;
  if (link.provider === "github") return `${base}/commit/${sha}`;
  return base;
}
