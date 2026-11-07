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
