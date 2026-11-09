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
  /** service -> image reference, for services that run an image. */
  images?: Record<string, string>;
  /** service -> what app.yaml says about its container. */
  imageDetails?: Record<string, { image: string; containerPort?: number; volumes?: Record<string, string> }>;
  /** host -> user name of the registry login chosen for this app, where it has chosen one. */
  registryLogins?: Record<string, string>;
  /** The project this app is organized under, if any. */
  projectId: string | null;
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
  /** Whether the server can run image services (Podman installed). Absent on agents that predate images. */
  containers?: { available: boolean; version?: string };
  /** Whether the server can serve S3 storages (rclone installed). Absent on agents that predate storage. */
  storage?: { available: boolean; version?: string };
  /** Whether the server can mount SMB and NFS volumes. Absent on agents that predate volumes. */
  mounts?: { smb: boolean; nfs: boolean };
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
export type RemoteVolume =
  | { type: "smb"; host: string; share: string; path?: string; user: string; domain?: string; port?: number }
  | { type: "nfs"; host: string; export: string; version?: string };
/** The options of app.yaml except the name; used when a repository has no app.yaml. */
export interface AppSettings {
  build?: { commands: string[]; timeout?: string; memory?: string; cpu?: number };
  services: Record<
    string,
    {
      command?: string;
      image?: string;
      containerPort?: number;
      volumes?: Record<string, string>;
      port?: number;
      replicas?: number;
      resources?: { memory?: string; cpu?: number };
      healthcheck?: { path: string; interval?: string; timeout?: string };
      restart?: "always" | "on-failure" | "no";
      environment?: Record<string, string>;
      secrets?: string[];
    }
  >;
  /** Remote folders (SMB, NFS) the app can mount; the password is set separately and never read back. */
  volumes?: Record<string, RemoteVolume>;
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
  /** What app.yaml says, to fill the settings form in. */
  settings: AppSettings | null;
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
  /** Control-server settings: where the value in effect comes from. */
  source?: "env" | "dashboard" | "file" | "default";
  /** The environment variable that fixes the value: it can't be changed here. */
  envVar?: string;
}
export interface ConfigSaved {
  changed: string[];
  restart: ("agent" | "api")[];
  haproxy: "applied" | "manual" | "none";
}

export interface RegistryLogin {
  host: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  appCount: number;
}

/** One project's canvas: its apps with their services, the connections between services, and saved node positions. */
export interface GraphService {
  name: string;
  activeState: string;
  subState: string;
  port: number | null;
  hostnames: string[];
  restarts: number;
  memoryBytes: number | null;
  image: string | null;
  command: string | null;
}
export interface GraphApp {
  name: string;
  server: string;
  status: AppRow["status"];
  currentRelease: string | null;
  services: GraphService[];
}
export interface GraphEdge {
  from: { app: string; service: string };
  to: { app: string; service: string };
  attr: string;
  key: string;
  /** Why this reference can't be resolved right now. */
  broken: string | null;
}
export interface GraphStorage {
  name: string;
  kind: StorageBackend["kind"];
  server: string;
  hostnames: string[];
  activeState: string;
}
export interface GraphStorageEdge {
  from: { app: string; service: string };
  storage: string;
  attr: string;
  key: string;
  broken: string | null;
}
export interface ProjectGraph {
  project: string | null;
  apps: GraphApp[];
  edges: GraphEdge[];
  /** The S3 storages this project's apps use, with an arrow from each service that does. */
  storages: GraphStorage[];
  storageEdges: GraphStorageEdge[];
  layout: Record<string, { x: number; y: number }>;
}

/** An S3 storage. The key pair is shown once, when it is created or rotated; apps get it through connections. */
export type StorageBackend =
  | { kind: "local" }
  | { kind: "sftp"; host: string; port?: number; user: string; path: string; auth: "password" | "key"; hostKey?: string }
  | { kind: "smb"; host: string; port?: number; share: string; user: string; domain?: string; path: string };
export interface StorageSecrets {
  password?: string;
  privateKey?: string;
}
export interface StorageRow {
  name: string;
  server: string;
  backend: StorageBackend;
  port: number;
  accessKey: string;
  createdAt: string;
  updatedAt: string;
  /** The app that serves it (domains, logs and deployments are those of this app). */
  app: string;
  status: AppRow["status"];
  activeState: string;
  hostnames: string[];
  deployments: DeploymentRow[];
}
export interface StorageCreated {
  id: string;
  status: string;
  storage: StorageRow;
  accessKey: string;
  secretKey: string;
}
export interface StorageTest {
  ok: boolean;
  error?: string;
  hostKey?: { line: string; fingerprint: string; type: string };
}
