import type { StorageBackend, StorageRow, StorageSecrets } from "~/types";

export type StorageKind = StorageBackend["kind"];
export const KINDS: { kind: StorageKind; label: string; icon: string; text: string }[] = [
  { kind: "local", label: "Local disk", icon: "pi pi-hdd", text: "Kept on the server, persisted by Freighter" },
  { kind: "sftp", label: "SFTP", icon: "pi pi-lock", text: "Any SSH server" },
  { kind: "smb", label: "SMB", icon: "pi pi-share-alt", text: "A Windows or NAS share" },
];

export function emptyBackend(kind: StorageKind): StorageBackend {
  if (kind === "sftp") return { kind, host: "", user: "", path: "", auth: "password" };
  if (kind === "smb") return { kind, host: "", user: "", share: "", path: "" };
  return { kind: "local" };
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const PATH_RE = /^[A-Za-z0-9._/ @+-]*$/;
const portOk = (p: number | undefined) => p === undefined || (Number.isInteger(p) && p >= 1 && p <= 65535);
export const STORAGE_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Whether a backend can be saved. `keepSecrets`: editing an existing storage, where an empty secret means "unchanged". */
export function backendProblem(b: StorageBackend, secrets: StorageSecrets, keepSecrets = false): string | null {
  if (b.kind === "local") return null;
  if (!HOST_RE.test(b.host)) return "Enter the host name or IPv4 address";
  if (!portOk(b.port)) return "The port must be 1 to 65535";
  if (!USER_RE.test(b.user)) return "Enter the user name";
  if (!PATH_RE.test(b.path) || b.path.split("/").includes("..")) return "The path has characters that are not allowed";
  if (b.kind === "smb") {
    if (!/^[A-Za-z0-9._ $-]{1,80}$/.test(b.share)) return "Enter the share name";
    if (!keepSecrets && !secrets.password) return "Enter the password";
    return null;
  }
  if (!b.hostKey) return "Test the connection and trust the server's host key";
  if (!keepSecrets && b.auth === "password" && !secrets.password) return "Enter the password";
  if (!keepSecrets && b.auth === "key" && !secrets.privateKey) return "Paste the private key";
  return null;
}

/** What the backend is, in one line. */
export function describeBackend(b: StorageBackend): string {
  if (b.kind === "local") return "Local disk";
  const path = b.path ? `/${b.path.replace(/^\/+/, "")}` : "";
  if (b.kind === "sftp") return `sftp://${b.user}@${b.host}${b.port ? `:${b.port}` : ""}${path}`;
  return `smb://${b.host}${b.port ? `:${b.port}` : ""}/${b.share}${path}`;
}

/** The address clients use: the first domain, else the internal one (only reachable from the same server). */
export function endpointOf(s: Pick<StorageRow, "hostnames" | "port">): string | null {
  if (s.hostnames[0]) return `https://${s.hostnames[0]}`;
  return s.port ? `http://127.0.0.1:${s.port}` : null;
}

/** The `environment:` lines an app adds to use a storage. */
export function usageSnippet(name: string): string {
  return [
    "environment:",
    `  S3_ENDPOINT: "@storage:${name}.url"`,
    `  S3_REGION: "@storage:${name}.region"`,
    `  S3_ACCESS_KEY_ID: "@storage:${name}.accessKey"`,
    `  S3_SECRET_ACCESS_KEY: "@storage:${name}.secretKey"`,
  ].join("\n");
}
