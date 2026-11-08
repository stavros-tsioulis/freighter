import type { AgentClient } from "@freighter/protocol";
import type { DnsResolver } from "./dns.ts";
import type { KeyPair } from "@freighter/pki";
import type { Registry, Role } from "@freighter/registry";
import type { ControlSettings } from "./control-settings.ts";

/** Resolves the agent for a registered server ("local" is the unix socket; others use mutual TLS). */
export interface AgentDirectory {
  forServer(name: string): AgentClient;
}

export interface ApiContext {
  registry: Registry;
  agents: AgentDirectory;
  /** The control plane's CA, used to sign agent certificates at enrollment. */
  pki: { ensureCa(): Promise<KeyPair> };
  /** Spool directory shared with the *local* agent (the agent only accepts artifacts from here). */
  artifactsDir: string;
  maxUploadBytes: number;
  /** Accept local-path repositories (lab/tests only; mirrors the agents' `git.allowLocal`). */
  gitAllowLocal?: boolean;
  /** Public base URL of this control plane; webhook URLs are built from it. */
  publicUrl?: string;
  /** This control plane's own public IP address(es): where a domain's DNS record should point for apps on the local server. */
  publicIps?: string[];
  /** DNS used to verify domains (default: the system's). */
  dns?: DnsResolver;
  /** Trust X-Forwarded-For/-Proto/-Host (API sits behind HAProxy). */
  trustProxy: boolean;
  /** How long metric samples are kept (default 6). */
  metricsRetentionHours?: number;
  /** The control plane's own settings (saved in the registry, overridden by environment variables). */
  controlSettings?: ControlSettings;
  now?: () => Date;
}

export interface Principal {
  id: string;
  name: string;
  role: Role;
}
