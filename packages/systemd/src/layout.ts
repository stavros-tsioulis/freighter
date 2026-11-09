export interface Layout {
  appsRoot: string;
  envDir: string;
  unitDir: string;
}

export const defaultLayout: Layout = {
  appsRoot: "/srv/apps",
  envDir: "/etc/freighter/apps",
  unitDir: "/etc/systemd/system",
};

export const workingDir = (l: Layout, app: string) => `${l.appsRoot}/${app}/current`;
export const sharedDir = (l: Layout, app: string) => `${l.appsRoot}/${app}/shared`;
export const envFile = (l: Layout, app: string) => `${l.envDir}/${app}.env`;
/** Credentials that connections resolve to (a storage's key pair): root-only like the secrets file, never in a unit. */
export const refsEnvFile = (l: Layout, app: string) => `${l.envDir}/${app}.refs.env`;
export const releasePath = (l: Layout, app: string, release: string) => `${l.appsRoot}/${app}/releases/${release}`;
/** Home of the app's rootless Podman (image store, runtime state); owned by the app user. */
export const containerHome = (l: Layout, app: string) => `${l.appsRoot}/${app}/container`;
/** Host directory behind one of a service's named volumes. */
export const volumeDir = (l: Layout, app: string, name: string) => `${sharedDir(l, app)}/volumes/${name}`;
/**
 * Runtime directory of an app's rootless Podman (what XDG_RUNTIME_DIR points at): a private directory under /run that
 * the unit itself creates (RuntimeDirectory=), so it does not depend on a login session or systemd-logind.
 */
export const containerRuntimeName = (app: string) => `freighter-${app}`;
export const containerRuntimeDir = (app: string) => `/run/${containerRuntimeName(app)}`;
/** Name of the container a unit runs (also what `podman stop` addresses). */
export const containerName = (app: string, service: string, instance?: string) =>
  `freighter-${app}--${service}${instance !== undefined ? `--${instance}` : ""}`;
