import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { ConfigField, ConfigSaved, AppRow, AppSettings, AuditRow, BranchList, CertRow, DeployFromGit, DeploymentRow, Enrollment, GitLink, GitSetup, Inspect, MetricPoint, Principal, Project, ProjectGraph, RegistryLogin, StorageBackend, StorageCreated, StorageRow, StorageSecrets, StorageTest, ReleaseInfo, Role, ServerRow, SshKey, TokenRow } from "~/types";
import { ApiRequestError, api, errorMessage } from "./api";

const ROLE_RANK: Record<Role, number> = { viewer: 0, deployer: 1, admin: 2 };
export const roleAtLeast = (have: Role | undefined, need: Role) => have !== undefined && ROLE_RANK[have] >= ROLE_RANK[need];

export const sessionQuery = () => ({
  queryKey: ["session"] as const,
  queryFn: () => api<Principal>("/session"),
  retry: false,
  staleTime: 60_000,
});

export function useSession() {
  const q = useQuery(sessionQuery());
  const me = computed(() => q.data.value ?? null);
  const can = (role: Role) => roleAtLeast(me.value?.role, role);
  return { me, can, isLoading: q.isLoading };
}

export function useNotify() {
  const toast = useToast();
  return {
    ok: (summary: string, detail?: string) => toast.add({ severity: "success", summary, detail, life: 3500 }),
    fail: (summary: string, e: unknown) => toast.add({ severity: "error", summary, detail: errorMessage(e), life: 7000 }),
  };
}

// ---- reads ----
export const useApps = () =>
  useQuery({ queryKey: ["apps"], queryFn: () => api<{ apps: AppRow[] }>("/apps").then((r) => r.apps), refetchInterval: 10_000 });

export const useProjects = () => useQuery({ queryKey: ["projects"], queryFn: () => api<{ projects: Project[] }>("/projects").then((r) => r.projects) });

export function useSaveProject() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { id?: string; name: string; description: string }) =>
      v.id ? api<Project>(`/projects/${v.id}`, { method: "PATCH", body: { name: v.name, description: v.description } }) : api<Project>("/projects", { method: "POST", body: { name: v.name, description: v.description } }),
    onSuccess: (p, v) => {
      notify.ok(v.id ? "Project saved" : "Project created", p.name);
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (id: string) => api(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      notify.ok("Project deleted", "Its apps were kept.");
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["apps"] });
      void qc.invalidateQueries({ queryKey: ["app"] });
    },
    onError: (e) => notify.fail("Could not delete the project", e),
  });
}

/** Move an app into a project, or (null) out of any project. */
export function useMoveApp() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { app: string; projectId: string | null }) => api(`/apps/${v.app}/project`, { method: "PUT", body: { projectId: v.projectId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["apps"] });
      void qc.invalidateQueries({ queryKey: ["app"] });
    },
    onError: (e) => notify.fail("Could not move the app", e),
  });
}

/** A project's canvas ("none": the apps without a project). */
export const useProjectGraph = (id: MaybeRef<string>) =>
  useQuery({ queryKey: ["graph", id], queryFn: () => api<ProjectGraph>(`/projects/${toValue(id)}/graph`), refetchInterval: 10_000, retry: false });

/** Save where the apps sit on a project's canvas. The cached graph is updated in place so the canvas doesn't jump. */
export function useSaveLayout(id: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (positions: ProjectGraph["layout"]) => api(`/projects/${toValue(id)}/layout`, { method: "PUT", body: { positions } }),
    onMutate: (positions) => {
      qc.setQueryData<ProjectGraph>(["graph", toValue(id)], (g) => (g ? { ...g, layout: positions } : g));
    },
    onError: (e) => notify.fail("Could not save the layout", e),
  });
}

export const useApp = (name: MaybeRef<string>) =>
  useQuery({ queryKey: ["app", name], queryFn: () => api<AppRow>(`/apps/${toValue(name)}`), refetchInterval: 10_000, retry: false });

export const useRecentDeployments = () =>
  useQuery({ queryKey: ["deployments"], queryFn: () => api<{ deployments: DeploymentRow[] }>("/deployments", { query: { limit: 15 } }).then((r) => r.deployments), refetchInterval: 10_000 });

export const useAppDeployments = (name: MaybeRef<string>) =>
  useQuery({
    queryKey: ["app-deployments", name],
    queryFn: () => api<{ deployments: DeploymentRow[] }>(`/apps/${toValue(name)}/deployments`, { query: { limit: 50 } }).then((r) => r.deployments),
    refetchInterval: 10_000,
  });

export const useDeployment = (id: Ref<string | null>) =>
  useQuery({
    queryKey: ["deployment", id],
    enabled: computed(() => id.value !== null),
    queryFn: () => api<DeploymentRow>(`/deployments/${id.value}`),
    // poll quickly while the job is still running
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.status) ? 1000 : false),
  });

export const useReleases = (name: MaybeRef<string>) =>
  useQuery({ queryKey: ["releases", name], queryFn: () => api<{ releases: ReleaseInfo[] }>(`/apps/${toValue(name)}/releases`).then((r) => r.releases) });

export const useMetrics = (name: MaybeRef<string>, minutes: MaybeRef<number>) =>
  useQuery({
    queryKey: ["metrics", name, minutes],
    queryFn: () => api<{ series: Record<string, MetricPoint[]> }>(`/apps/${toValue(name)}/metrics`, { query: { minutes: toValue(minutes) } }).then((r) => r.series),
    refetchInterval: 15_000,
  });

export const useLogs = (app: MaybeRef<string>, service: MaybeRef<string | null>, lines: MaybeRef<number>, live: MaybeRef<boolean>) =>
  useQuery({
    queryKey: ["logs", app, service, lines],
    enabled: computed(() => !!toValue(service)),
    queryFn: () => api<{ text: string }>(`/apps/${toValue(app)}/logs`, { query: { service: toValue(service), lines: toValue(lines) } }).then((r) => r.text),
    refetchInterval: () => (toValue(live) ? 3000 : false),
    staleTime: 0,
    retry: false,
  });

export interface VariableRow {
  key: string;
  /** As written in app.yaml. */
  value: string;
  /** With connections filled in; null when one can't be resolved (see `error`). */
  resolved: string | null;
  error: string | null;
  /** The value contains a connection such as `@api.url`. */
  reference: boolean;
  /** It resolves to a credential (a storage's key pair), which is never shown. */
  secret?: boolean;
  /** `app.yaml`: the initial value; `added`: set in the dashboard; `override`: set in the dashboard over app.yaml's. */
  source: "app.yaml" | "added" | "override";
}
export const useVariables = (app: MaybeRef<string>) =>
  useQuery({ queryKey: ["variables", app], queryFn: () => api<{ variables: VariableRow[] }>(`/apps/${toValue(app)}/variables`).then((r) => r.variables), refetchInterval: 15_000 });

/** Add or change a variable, or remove one added in the dashboard (an override goes back to app.yaml's value). The app is redeployed to apply it. */
export function useVariableChange(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { key: string; value?: string }) =>
      v.value === undefined
        ? api(`/apps/${toValue(app)}/variables/${v.key}`, { method: "DELETE" })
        : api(`/apps/${toValue(app)}/variables/${v.key}`, { method: "PUT", body: { value: v.value } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["variables"] });
      void qc.invalidateQueries({ queryKey: ["app"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (e) => notify.fail("Could not change the variable", e),
  });
}

export const useEnvNames = (app: MaybeRef<string>) =>
  useQuery({ queryKey: ["env", app], queryFn: () => api<{ names: string[] }>(`/apps/${toValue(app)}/env`).then((r) => r.names), retry: false });

export const useCerts = () => useQuery({ queryKey: ["certs"], queryFn: () => api<{ certs: CertRow[] }>("/certs").then((r) => r.certs), retry: false });
export const useTokens = () => useQuery({ queryKey: ["tokens"], queryFn: () => api<{ tokens: TokenRow[] }>("/tokens").then((r) => r.tokens) });
export const useAudit = () => useQuery({ queryKey: ["audit"], queryFn: () => api<{ entries: AuditRow[] }>("/audit", { query: { limit: 200 } }).then((r) => r.entries) });

export const useServers = () =>
  useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: ServerRow[] }>("/servers").then((r) => r.servers), refetchInterval: 10_000 });

/** The app's repository link, or `null` when it is not linked (a 404 is an answer here, not an error). */
export const useGitLink = (app: MaybeRef<string>) =>
  useQuery({
    queryKey: ["git", app],
    queryFn: () =>
      api<GitLink>(`/apps/${toValue(app)}/git`).catch((e) => {
        if (e instanceof ApiRequestError && e.status === 404) return null;
        throw e;
      }),
    retry: false,
  });

/**
 * A deployment's build log, appended to as it grows. Polls while `running`, then once more to pick up the tail.
 * Needs the deployer role; viewers get `forbidden` instead of text.
 */
export function useDeploymentLog(id: MaybeRefOrGetter<string | null>, running: MaybeRefOrGetter<boolean>) {
  const text = ref("");
  const forbidden = ref(false);
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;

  async function pull() {
    const current = toValue(id);
    if (!current || busy) return;
    busy = true;
    try {
      const r = await api<{ text: string; next: number; done: boolean }>(`/deployments/${current}/log`, { query: { from: offset } });
      text.value += r.text;
      offset = r.next;
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 403) forbidden.value = true;
    } finally {
      busy = false;
    }
  }
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  watch(
    [() => toValue(id), () => toValue(running)],
    async ([, isRunning], [prevId, wasRunning] = [null, false]) => {
      if (toValue(id) !== prevId) {
        text.value = "";
        offset = 0;
      }
      stop();
      await pull();
      if (isRunning) timer = setInterval(pull, 1500);
      else if (wasRunning) setTimeout(pull, 400); // the build just finished: fetch the last lines
    },
    { immediate: true },
  );
  onScopeDispose(stop);
  return { text, forbidden };
}

// ---- writes ----
export function useAddServer() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { name: string; address: string }) => api<Enrollment>("/servers", { method: "POST", body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["servers"] }),
    onError: (e) => notify.fail("Could not add server", e),
  });
}

export function useServerEnrollment() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (name: string) => api<Enrollment>(`/servers/${name}/enrollment`, { method: "POST", body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["servers"] }),
    onError: (e) => notify.fail("Could not create enrollment token", e),
  });
}

export function useCheckServer() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (name: string) => api<ServerRow>(`/servers/${name}/check`, { method: "POST", body: {} }),
    onSuccess: (s) => {
      if (s.status === "online") notify.ok(`${s.name} is online`);
      else notify.fail(`${s.name} is ${s.status}`, new Error(s.lastError ?? "no response"));
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (e) => notify.fail("Check failed", e),
  });
}

/** The version (git commit) the control plane runs: where "Upgrade" takes a server. */
export const useControlVersion = () =>
  useQuery({ queryKey: ["control-version"], queryFn: () => api<{ commit: string | null }>("/version").then((r) => r.commit), staleTime: 5 * 60_000 });

export interface UpgradeInfo {
  state: "running" | "verifying" | "rolling-back" | "done" | "rolled-back" | "failed";
  from: string | null;
  to: string | null;
  ref: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  message: string | null;
}
export interface UpgradeView {
  supported: boolean;
  reason: string | null;
  commit: string | null;
  upgrade: UpgradeInfo | null;
  log: string;
  /** Whose HAProxy the server uses. Absent on old agents. */
  haproxy?: { mode: "dedicated" | "existing" };
  target: string | null;
  outdated: boolean;
}
export const upgradeActive = (u: UpgradeInfo | null | undefined) => !!u && ["running", "verifying", "rolling-back"].includes(u.state);

/** A server's upgrade state and log. Polls while `open`, quickly while an upgrade runs (the agent restarts partway, so errors are expected). */
export function useServerUpgrade(name: MaybeRef<string>, open: MaybeRef<boolean>) {
  return useQuery({
    queryKey: ["server-upgrade", name],
    queryFn: () => api<UpgradeView>(`/servers/${toValue(name)}/upgrade`),
    enabled: () => toValue(open),
    refetchInterval: 3_000,
    retry: false,
  });
}

export interface RepoCommit {
  commit: string;
  subject: string;
  committedAt: string;
}
export interface UpdateCheck {
  ref: string;
  installed: RepoCommit | null;
  latest: RepoCommit;
  state: "up-to-date" | "behind" | "ahead" | "different";
  behind: number | null;
  commits: { sha: string; subject: string }[];
  checkedAt: string;
  /** The commit the control plane runs. */
  target: string | null;
}

/** Ask the server's own git what's new in the repository it was installed from. */
export function useCheckUpdates() {
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { server: string; ref?: string }) => api<UpdateCheck>(`/servers/${v.server}/updates/check`, { method: "POST", body: v.ref ? { ref: v.ref } : {} }),
    onError: (e) => notify.fail("Could not check for updates", e),
  });
}

export function useStartUpgrade() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { server: string; ref?: string; /** Add Podman at the installed version instead of upgrading. */ containers?: boolean; /** Add rclone (for S3 storages) at the installed version instead of upgrading. */ storage?: boolean }) =>
      api<UpgradeView>(`/servers/${v.server}/upgrade`, { method: "POST", body: v.containers ? { containers: true } : v.storage ? { storage: true } : v.ref ? { ref: v.ref } : {} }),
    onSuccess: (r, v) => {
      // The response already describes the new run: show it at once instead of the previous run until the next poll.
      qc.setQueryData(["server-upgrade", v.server], r);
      void qc.invalidateQueries({ queryKey: ["server-upgrade", v.server] });
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (e) => notify.fail("Could not start", e),
  });
}

export function useRemoveServer() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (name: string) => api(`/servers/${name}`, { method: "DELETE" }),
    onSuccess: () => {
      notify.ok("Server removed");
      void qc.invalidateQueries({ queryKey: ["servers"] });
    },
    onError: (e) => notify.fail("Could not remove server", e),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api<Principal>("/session", { method: "POST", body: { token } }),
    onSuccess: (me) => qc.setQueryData(["session"], me),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/session", { method: "DELETE" }),
    onSettled: () => {
      qc.clear();
      return navigateTo("/login");
    },
  });
}

export function useControl(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { verb: "start" | "stop" | "restart"; service?: string }) => api(`/apps/${toValue(app)}/${v.verb}`, { method: "POST", body: { service: v.service } }),
    onSuccess: (_r, v) => {
      notify.ok(`${v.verb} requested`, v.service ?? "all services");
      void qc.invalidateQueries({ queryKey: ["app"] });
    },
    onError: (e) => notify.fail("Action failed", e),
  });
}

export function useRollback(app: MaybeRef<string>) {
  const notify = useNotify();
  return useMutation({
    mutationFn: (release?: string) => api<{ id: string }>(`/apps/${toValue(app)}/rollback`, { method: "POST", body: { release } }),
    onError: (e) => notify.fail("Rollback failed to start", e),
  });
}

export function useSetEnv(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { key: string; value: string }) => api(`/apps/${toValue(app)}/env/${v.key}`, { method: "PUT", body: { value: v.value } }),
    onSuccess: (_r, v) => {
      notify.ok("Secret saved", v.key);
      void qc.invalidateQueries({ queryKey: ["env"] });
    },
    onError: (e) => notify.fail("Could not save secret", e),
  });
}

export function useCreateToken() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { name: string; role: Role }) => api<TokenRow & { token: string }>("/tokens", { method: "POST", body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }),
    onError: (e) => notify.fail("Could not create token", e),
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (id: string) => api(`/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      notify.ok("Token revoked");
      void qc.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e) => notify.fail("Could not revoke token", e),
  });
}

export function useRenewCerts() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (force: boolean) => api("/certs/renew", { method: "POST", body: { force } }),
    onSuccess: () => {
      notify.ok("Certificates checked");
      void qc.invalidateQueries({ queryKey: ["certs"] });
    },
    onError: (e) => notify.fail("Renewal failed", e),
  });
}

export function useSync() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: () => api("/sync", { method: "POST", body: {} }),
    onSuccess: () => {
      notify.ok("Synced with host");
      void qc.invalidateQueries();
    },
    onError: (e) => notify.fail("Sync failed", e),
  });
}

const gitInvalidate = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ["git"] });
  void qc.invalidateQueries({ queryKey: ["apps"] });
};

export function useSaveGitLink(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { repository: string; branch: string; provider: string; subpath: string; autoDeploy: boolean; server?: string; sshKeyId?: string | null; settings?: AppSettings | null }) =>
      api<GitSetup>(`/apps/${toValue(app)}/git`, { method: "PUT", body: v }),
    onSuccess: () => gitInvalidate(qc),
    onError: (e) => notify.fail("Could not link the repository", e),
  });
}

export function usePatchGitLink(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: Partial<{ branch: string; subpath: string; autoDeploy: boolean; provider: string; sshKeyId: string | null; settings: AppSettings | null }>) =>
      api<GitLink>(`/apps/${toValue(app)}/git`, { method: "PATCH", body: v }),
    onSuccess: () => gitInvalidate(qc),
    onError: (e) => notify.fail("Could not update the repository settings", e),
  });
}

export function useGitAction(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  const call = <T>(path: string, method = "POST") => api<T>(`/apps/${toValue(app)}/git${path}`, { method, body: method === "DELETE" ? undefined : {} });
  return {
    check: useMutation({
      mutationFn: () => call<{ sha: string }>("/check"),
      onSuccess: (r) => notify.ok("Repository reachable", `branch head ${r.sha.slice(0, 7)}`),
      onError: (e) => notify.fail("Cannot reach the repository", e),
    }),
    deploy: useMutation({
      mutationFn: () => call<{ id: string; coalesced: boolean }>("/deploy"),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ["app-deployments"] });
        void qc.invalidateQueries({ queryKey: ["deployments"] });
      },
      onError: (e) => notify.fail("Could not start the deployment", e),
    }),
    rotateSecret: useMutation({
      mutationFn: () => call<{ webhookSecret: string }>("/rotate-secret"),
      onError: (e) => notify.fail("Could not rotate the secret", e),
    }),
    rotateKey: useMutation({
      mutationFn: () => call<GitLink>("/rotate-key"),
      onSuccess: () => gitInvalidate(qc),
      onError: (e) => notify.fail("Could not rotate the key", e),
    }),
    unlink: useMutation({
      mutationFn: () => call("", "DELETE"),
      onSuccess: () => {
        notify.ok("Repository unlinked");
        gitInvalidate(qc);
      },
      onError: (e) => notify.fail("Could not unlink", e),
    }),
  };
}

// ---- SSH keys, branches, inspection ----
export const useSshKeys = (enabled: MaybeRefOrGetter<boolean> = true) =>
  useQuery({ queryKey: ["ssh-keys"], enabled: computed(() => toValue(enabled)), queryFn: () => api<{ keys: SshKey[] }>("/ssh-keys").then((r) => r.keys) });

export function useImportSshKey() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { name: string; privateKey: string; passphrase?: string }) => api<SshKey>("/ssh-keys", { method: "POST", body: v }),
    onSuccess: (k) => {
      notify.ok("SSH key imported", k.name);
      void qc.invalidateQueries({ queryKey: ["ssh-keys"] });
    },
    onError: (e) => notify.fail("Could not import the key", e),
  });
}

export function useGenerateSshKey() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { name: string }) => api<SshKey>("/ssh-keys/generate", { method: "POST", body: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["ssh-keys"] }),
    onError: (e) => notify.fail("Could not generate the key", e),
  });
}

export function useRemoveSshKey() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (id: string) => api(`/ssh-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      notify.ok("SSH key deleted");
      void qc.invalidateQueries({ queryKey: ["ssh-keys"] });
    },
    onError: (e) => notify.fail("Could not delete the key", e),
  });
}

/** Branches of a repository, read over SSH with the chosen key (only while `enabled`; the caller debounces typing). */
export const useBranches = (repository: MaybeRefOrGetter<string>, sshKeyId: MaybeRefOrGetter<string | null>, enabled: MaybeRefOrGetter<boolean>, server?: MaybeRefOrGetter<string | undefined>) =>
  useQuery({
    queryKey: ["branches", repository, sshKeyId, server],
    enabled: computed(() => toValue(enabled)),
    queryFn: () => api<BranchList>("/git/branches", { method: "POST", body: { repository: toValue(repository).trim(), sshKeyId: toValue(sshKeyId), server: toValue(server) } }),
    staleTime: 15_000,
    retry: false,
  });

/** What app.yaml on the chosen branch says: the app's name, or what is wrong. */
export const useInspect = (repository: MaybeRefOrGetter<string>, branch: MaybeRefOrGetter<string | null>, sshKeyId: MaybeRefOrGetter<string | null>, enabled: MaybeRefOrGetter<boolean>, server?: MaybeRefOrGetter<string | undefined>, subpath?: MaybeRefOrGetter<string>) =>
  useQuery({
    queryKey: ["inspect", repository, branch, sshKeyId, server, subpath],
    enabled: computed(() => toValue(enabled) && !!toValue(branch)),
    queryFn: () => api<Inspect>("/git/inspect", { method: "POST", body: { repository: toValue(repository).trim(), branch: toValue(branch), sshKeyId: toValue(sshKeyId), server: toValue(server), subpath: toValue(subpath)?.trim() || undefined } }),
    staleTime: 5_000,
    retry: false,
  });

export function useDeployFromGit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { repository: string; branch: string; sshKeyId: string | null; server?: string; autoDeploy?: boolean; appName?: string; settings?: AppSettings }) =>
      api<DeployFromGit>("/git/deployments", { method: "POST", body: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["apps"] });
      void qc.invalidateQueries({ queryKey: ["ssh-keys"] });
      void qc.invalidateQueries({ queryKey: ["git"] });
    },
  });
}

/** The app.yaml that some settings stand for, rendered (and validated) by the API; errors come back as `error`. */
export const useManifestPreview = (name: MaybeRefOrGetter<string>, settings: MaybeRefOrGetter<AppSettings>, enabled: MaybeRefOrGetter<boolean> = true) =>
  useQuery({
    queryKey: ["manifest-preview", name, settings],
    enabled: computed(() => toValue(enabled) && !!toValue(name)),
    queryFn: () => api<{ text: string }>("/manifest/render", { method: "POST", body: { name: toValue(name), settings: toValue(settings) } }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    placeholderData: (prev) => prev,
  });

export interface DomainRow {
  hostname: string;
  service: string;
  tls: "auto" | "off";
  /** `pending`: added, waiting for its DNS records to be verified. Nothing is routed until it is `active`. */
  status: "active" | "pending";
  checkedAt: string | null;
  lastError: string | null;
}
export interface DomainsResponse {
  domains: DomainRow[];
  /** The DNS records a domain needs to point at this app's server (empty when the server's public IP is unknown). */
  dns: { addresses: string[]; records: { type: "A" | "AAAA"; value: string }[] };
}

export const useDomains = (app: MaybeRef<string>) =>
  useQuery({ queryKey: ["domains", app], queryFn: () => api<DomainsResponse>(`/apps/${toValue(app)}/domains`), retry: false });

export function useAddDomain(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { hostname: string; service: string; tls: "auto" | "off" }) => api(`/apps/${toValue(app)}/domains`, { method: "POST", body: v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["domains"] }),
    onError: (e) => notify.fail("Could not add the domain", e),
  });
}

/** Checks DNS; when it is right the domain goes live and `id` names the deployment to follow. */
export function useVerifyDomain(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (hostname: string) => api<{ verified: boolean; id?: string; reason?: string | null; found: string[]; expected: string[]; method: "local" | "dns" | "http" | null; cloudflare: boolean }>(`/apps/${toValue(app)}/domains/${hostname}/verify`, { method: "POST", body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["domains"] });
      void qc.invalidateQueries({ queryKey: ["app"] });
    },
    onError: (e) => notify.fail("Could not verify the domain", e),
  });
}

export function useRemoveDomain(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (hostname: string) => api<{ ok?: boolean; id?: string }>(`/apps/${toValue(app)}/domains/${hostname}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["domains"] });
      void qc.invalidateQueries({ queryKey: ["app"] });
    },
    onError: (e) => notify.fail("Could not remove the domain", e),
  });
}

export interface DeletedApp {
  ok: boolean;
  app: string;
  server: string;
  units: string[];
  hostnames: string[];
  /** Only the dashboard's records were removed; the server wasn't asked. */
  forgotten: boolean;
}

/** Delete an app for good (units, routing, certificates, releases, shared data, secrets). The name is the confirmation. */
export function useDeleteApp() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { app: string; forget?: boolean }) => api<DeletedApp>(`/apps/${v.app}`, { method: "DELETE", body: { confirm: v.app, ...(v.forget ? { forget: true } : {}) } }),
    onSuccess: (r, v) => {
      qc.removeQueries({ queryKey: ["app", v.app] });
      for (const key of ["apps", "deployments", "servers", "domains", "certs"]) void qc.invalidateQueries({ queryKey: [key] });
      notify.ok(`Deleted ${r.app}`, r.forgotten ? `Only the dashboard's records were removed; nothing was removed from ${r.server}.` : undefined);
    },
    onError: (e) => notify.fail("Could not delete the app", e),
  });
}

// ---- server settings (config.yaml) ----
/** The pseudo-server that stands for the control plane's own settings (saved in the registry, no agent involved). */
export const CONTROL = "@control";
const configUrl = (server: string) => (server === CONTROL ? "/settings" : `/servers/${server}/config`);

export const useServerConfig = (server: MaybeRef<string>) =>
  useQuery({
    queryKey: ["server-config", server],
    queryFn: () => api<{ fields: ConfigField[] }>(configUrl(toValue(server))).then((r) => r.fields),
    enabled: computed(() => toValue(server) !== ""),
    retry: false,
    refetchOnWindowFocus: false, // never replace what someone is in the middle of editing
  });

export function useSaveServerConfig() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { server: string; changes: Record<string, unknown> }) => api<ConfigSaved>(configUrl(v.server), { method: "PUT", body: { changes: v.changes } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["server-config"] }),
    onError: (e) => notify.fail("Could not save", e),
  });
}

export function useRestartService() {
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { server: string; service: "agent" | "api" }) => api(`/servers/${v.server}/restart`, { method: "POST", body: { service: v.service } }),
    onError: (e) => notify.fail("Could not restart", e),
  });
}

// ---- container images ----

const refreshApps = (qc: ReturnType<typeof useQueryClient>) => {
  for (const key of ["apps", "app", "deployments"]) void qc.invalidateQueries({ queryKey: [key] });
};

/** Create (or update) an app made of image services: the API renders app.yaml from the form, then the server pulls the images. */
export function useDeployImages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { name: string; settings: AppSettings; server?: string; /** host -> user name, where a registry has several logins */ logins?: Record<string, string> }) => {
      const { text } = await api<{ text: string }>("/manifest/render", { method: "POST", body: { name: v.name, settings: v.settings } });
      return api<{ id: string }>(`/apps/${v.name}/image-deployments`, { method: "POST", body: { manifest: text, ...(v.logins && Object.keys(v.logins).length ? { logins: v.logins } : {}) }, query: v.server ? { server: v.server } : undefined });
    },
    onSuccess: () => refreshApps(qc),
  });
}

/** Pull an image app's images again and release the result. */
export function useRedeployImages(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: () => api<{ id: string }>(`/apps/${toValue(app)}/redeploy`, { method: "POST" }),
    onSuccess: () => refreshApps(qc),
    onError: (e) => notify.fail("Could not start the redeploy", e),
  });
}

/** Run different images (usually a new tag) for some services of an app, keeping the rest of its app.yaml. */
export function useSetImages(app: MaybeRef<string>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (images: Record<string, string>) => api<{ id: string }>(`/apps/${toValue(app)}/images`, { method: "POST", body: { images } }),
    onSuccess: () => refreshApps(qc),
  });
}

export const useRegistries = (enabled: MaybeRefOrGetter<boolean> = true) => useQuery({ queryKey: ["registries"], enabled: computed(() => toValue(enabled)), queryFn: () => api<{ registries: RegistryLogin[] }>("/registries").then((r) => r.registries) });

export function useSaveRegistry() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { host: string; username: string; password: string }) =>
      api<RegistryLogin>(`/registries/${encodeURIComponent(v.host)}`, { method: "PUT", body: { username: v.username, password: v.password } }),
    onSuccess: (r) => {
      notify.ok("Registry login saved", r.host);
      void qc.invalidateQueries({ queryKey: ["registries"] });
    },
    onError: (e) => notify.fail("Could not save the login", e),
  });
}

export function useRemoveRegistry() {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { host: string; username: string }) => api(`/registries/${encodeURIComponent(v.host)}`, { method: "DELETE", query: { username: v.username } }),
    onSuccess: () => {
      notify.ok("Registry login deleted");
      void qc.invalidateQueries({ queryKey: ["registries"] });
    },
    onError: (e) => notify.fail("Could not delete the login", e),
  });
}

/** Pull an app's images from `host` with this login (null: the registry's default). Remembered for the app, including for redeploys. */
export function useChooseLogin(app: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { host: string; username: string | null }) => api(`/apps/${toValue(app)}/registry-logins/${encodeURIComponent(v.host)}`, { method: "PUT", body: { username: v.username } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["app"] }),
    onError: (e) => notify.fail("Could not choose the login", e),
  });
}

// ---- S3 storage ----
export const useStorages = () => useQuery({ queryKey: ["storages"], queryFn: () => api<{ storages: StorageRow[] }>("/storages").then((r) => r.storages), refetchInterval: 10_000 });
export const useStorage = (name: MaybeRef<string>) => useQuery({ queryKey: ["storage", name], queryFn: () => api<StorageRow>(`/storages/${toValue(name)}`), refetchInterval: 10_000, retry: false });

function useStorageMutation<V, R>(fn: (v: V) => Promise<R>, failure: string, after?: (r: R) => void) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      for (const key of ["storages", "storage", "apps", "app", "graph", "variables"]) void qc.invalidateQueries({ queryKey: [key] });
      after?.(r);
    },
    onError: (e) => notify.fail(failure, e),
  });
}
export const useCreateStorage = () =>
  useStorageMutation((v: { name: string; server?: string; backend: StorageBackend; secrets?: StorageSecrets }) => api<StorageCreated>("/storages", { method: "POST", body: v }), "Could not create the storage");
export const usePatchStorage = (name: MaybeRef<string>) =>
  useStorageMutation((v: { backend?: StorageBackend; secrets?: StorageSecrets }) => api(`/storages/${toValue(name)}`, { method: "PATCH", body: v }), "Could not change the storage");
export const useApplyStorage = (name: MaybeRef<string>) => useStorageMutation(() => api(`/storages/${toValue(name)}/apply`, { method: "POST" }), "Could not deploy the storage");
export const useRotateStorageKeys = (name: MaybeRef<string>) =>
  useStorageMutation(() => api<{ id: string; accessKey: string; secretKey: string }>(`/storages/${toValue(name)}/rotate-keys`, { method: "POST" }), "Could not rotate the keys");
export const useDeleteStorage = () => useStorageMutation((v: { name: string; forget?: boolean }) => api(`/storages/${v.name}`, { method: "DELETE", body: { confirm: v.name, forget: v.forget } }), "Could not delete the storage");
export function useTestStorage() {
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { server?: string; backend: StorageBackend; secrets?: StorageSecrets }) => api<StorageTest>("/storages/test", { method: "POST", body: v }),
    onError: (e) => notify.fail("Could not test the connection", e),
  });
}
