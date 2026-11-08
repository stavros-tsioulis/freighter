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
export const releasePath = (l: Layout, app: string, release: string) => `${l.appsRoot}/${app}/releases/${release}`;
/** Home of the app's rootless Podman (image store, runtime state); owned by the app user. */
export const containerHome = (l: Layout, app: string) => `${l.appsRoot}/${app}/container`;
/** Host directory behind one of a service's named volumes. */
export const volumeDir = (l: Layout, app: string, name: string) => `${sharedDir(l, app)}/volumes/${name}`;
/** Name of the container a unit runs (also what `podman stop` addresses). */
export const containerName = (app: string, service: string, instance?: string) =>
  `freighter-${app}--${service}${instance !== undefined ? `--${instance}` : ""}`;
