import type { StorageBackend } from "@freighter/manifest";
export type Role = "viewer" | "deployer" | "admin";
const ORDER: Role[] = ["viewer", "deployer", "admin"];
export const roleAtLeast = (have: Role, need: Role) => ORDER.indexOf(have) >= ORDER.indexOf(need);
export const isRole = (x: unknown): x is Role => typeof x === "string" && (ORDER as string[]).includes(x);

export interface AppRow {
  name: string;
  /** The server this app is pinned to. */
  server: string;
  manifestText: string | null;
  currentRelease: string | null;
  previousRelease: string | null;
  status: "deployed" | "undeployed" | "missing" | "unknown";
  syncedAt: string | null;
  updatedAt: string;
  /** The project this app is organized under, if any. */
  projectId: string | null;
  /** `storage`: the app that serves an S3 storage (hidden from app lists). */
  kind: "app" | "storage";
}
export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  appCount: number;
}
export interface ServiceRow {
  app: string;
  name: string;
  unit: string;
  port: number | null;
  hostnames: string[];
  activeState: string;
  subState: string;
  restarts: number;
  memoryBytes: number | null;
  observedAt: string;
}
export type DeploymentStatus = "queued" | "running" | "success" | "failed";
export interface DeploymentRow {
  id: string;
  app: string;
  server: string;
  action: "deploy" | "rollback";
  status: DeploymentStatus;
  releaseId: string | null;
  previousRelease: string | null;
  source: "api" | "host";
  /** What started it: an uploaded artifact, a manual "deploy latest", a push webhook, or the host CLI. */
  trigger: "upload" | "manual" | "webhook" | "host";
  commitSha: string | null;
  commitSubject: string | null;
  commitAuthor: string | null;
  requestedBy: string | null;
  artifactSha256: string | null;
  error: string | null;
  warnings: string[];
  historyAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface TokenRow {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface AuditRow {
  id: number;
  at: string;
  tokenId: string | null;
  action: string;
  app: string | null;
  detail: Record<string, unknown>;
}
export interface HistoryEntryLike {
  at: string;
  action: "deploy" | "rollback";
  release: string;
  previous: string | null;
  result: "success" | "failed";
  reason?: string;
  source?: { type: "git"; sha: string; ref: string; subject?: string; author?: string };
}
export interface MetricSampleRow {
  app: string;
  service: string;
  unit: string;
  at: string;
  active: string;
  memoryBytes: number | null;
  cpuNanos: number | null;
  restarts: number;
}
export interface HostStatus {
  hostname: string;
  uptimeSeconds: number;
  load1: number;
  memTotal: number;
  memFree: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
}
export interface ServerRow {
  name: string;
  kind: "local" | "remote";
  address: string | null;
  status: "online" | "offline" | "pending" | "error";
  agentVersion: string | null;
  hostname: string | null;
  host: HostStatus | null;
  lastSeenAt: string | null;
  lastError: string | null;
  certFingerprint: string | null;
  certExpiresAt: string | null;
  /** True while a one-time enrollment token is outstanding. */
  enrollmentPending: boolean;
  enrollExpiresAt: string | null;
  createdAt: string;
  appCount: number;
}
export interface GitLinkRow {
  app: string;
  provider: "github" | "gitlab" | "other";
  repository: string;
  branch: string;
  subpath: string;
  autoDeploy: boolean;
  /** Verifies incoming webhooks. Only ever returned when it has just been created or rotated. */
  webhookSecret: string;
  publicKey: string;
  keyFingerprint: string;
  lastDeliveryAt: string | null;
  lastDeliveryResult: string | null;
  createdAt: string;
  /** The imported SSH key used to clone, or null for the per-app deploy key. */
  sshKeyId: string | null;
  /** What to deploy when the repository has no app.yaml (the manifest options, minus the name). Null: none set. */
  settings: Record<string, unknown> | null;
}


/** A domain that was added but not routed yet: it waits for its DNS records to be verified. */
export interface PendingDomainRow {
  hostname: string;
  app: string;
  service: string;
  tls: "auto" | "off";
  createdAt: string;
  checkedAt: string | null;
  lastError: string | null;
}

export interface RegistryCredentialRow {
  host: string;
  username: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SshKeyRow {
  id: string;
  name: string;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  comment: string | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** Number of linked apps that clone with this key. */
  appCount: number;
}

/** An S3 storage. The key pair and any remote credentials are sealed; `registry.storages.secrets` opens them. */
export interface StorageRow {
  name: string;
  server: string;
  backend: StorageBackend;
  /** The port its endpoint listens on while it has no domain. */
  port: number;
  accessKey: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
