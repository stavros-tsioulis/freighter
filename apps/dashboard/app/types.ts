export type Role = "viewer" | "deployer" | "admin";

export interface Principal {
  id: string;
  name: string;
  role: Role;
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
export interface AppRow {
  name: string;
  server: string;
  manifestText?: string | null;
  currentRelease: string | null;
  previousRelease: string | null;
  status: "deployed" | "undeployed" | "missing" | "unknown";
  syncedAt: string | null;
  updatedAt: string;
  services: ServiceRow[];
  deployments?: DeploymentRow[];
}
export interface DeploymentRow {
  id: string;
  app: string;
  server: string;
  action: "deploy" | "rollback";
  status: "queued" | "running" | "success" | "failed";
  releaseId: string | null;
  previousRelease: string | null;
  source: "api" | "host";
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
export interface ReleaseInfo {
  id: string;
  current: boolean;
  result?: "success" | "failed";
  at?: string;
}
export interface MetricPoint {
  at: string;
  memoryBytes: number | null;
  cpuPercent: number | null;
  restarts: number;
  active: string;
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
export interface CertRow {
  server?: string;
  hostname: string;
  expires: string | null;
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
  enrollmentPending: boolean;
  enrollExpiresAt: string | null;
  createdAt: string;
  appCount: number;
}
export interface Enrollment {
  server: ServerRow;
  enrollment: { token: string; expiresAt: string | null; caFingerprint: string; command: string };
}
/** The options of app.yaml except the name; used when a repository has no app.yaml. */
export interface AppSettings {
  build?: { commands: string[]; timeout?: string; memory?: string; cpu?: number };
  services: Record<
    string,
    {
      command: string;
      port?: number;
      replicas?: number;
      resources?: { memory?: string; cpu?: number };
      healthcheck?: { path: string; interval?: string; timeout?: string };
      restart?: "always" | "on-failure" | "no";
    }
  >;
  environment?: Record<string, string>;
  secrets?: string[];
  releases?: { keep: number };
}
export interface GitLink {
  app: string;
  provider: "github" | "gitlab" | "other";
  repository: string;
  branch: string;
  subpath: string;
  autoDeploy: boolean;
  publicKey: string;
  keyFingerprint: string;
  webhookUrl: string;
  sshKeyId: string | null;
  /** The imported key used to clone, or null when the app uses its own generated deploy key. */
  sshKey: { id: string; name: string; fingerprint: string } | null;
  /** What gets deployed when the repository has no app.yaml. */
  settings: AppSettings | null;
  lastDeliveryAt: string | null;
  lastDeliveryResult: string | null;
  createdAt: string;
}
export interface GitSetup {
  link: GitLink;
  /** Present only when the link was just created or the secret rotated. */
  webhookSecret?: string;
}

export interface SshKey {
  id: string;
  name: string;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  comment: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  appCount: number;
}
export interface BranchList {
  branches: { name: string; default: boolean }[];
  defaultBranch: string | null;
}
export interface Inspect {
  sha: string;
  commit: { sha: string; subject: string; author: string };
  hasManifest: boolean;
  valid: boolean;
  appName: string | null;
  error: string | null;
  buildCommands: string[];
}
export interface DeployFromGit {
  app: string;
  deployment: { id: string; status: string; coalesced: boolean };
  link: GitLink;
  /** Shown once. */
  webhookSecret: string;
}

/** One setting of a server's config.yaml, as the settings page renders it. */
export interface ConfigField {
  key: string;
  section: string;
  label: string;
  help: string;
  type: "string" | "number" | "boolean" | "list" | "enum";
  scope: "agent" | "control";
  restart: "none" | "agent" | "api";
  options?: string[];
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
  haproxy?: boolean;
  /** In effect now (the file's value, or the default). */
  value: unknown;
  default: unknown;
  /** The file sets it. */
  explicit: boolean;
}
export interface ConfigSaved {
  changed: string[];
  restart: ("agent" | "api")[];
  haproxy: "applied" | "manual" | "none";
}
