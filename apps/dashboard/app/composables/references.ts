import type { ReferenceSources } from "~/utils/references";

/**
 * What an environment value of `app` can connect to: its own services (and their variables), the services of the other
 * apps in its project, and the S3 storages. `ownServices` stands in for an app that doesn't exist yet.
 */
export function useReferenceSources(app: MaybeRef<string>, ownServices?: MaybeRef<string[] | undefined>, ownVolumes?: MaybeRef<string[] | undefined>) {
  const { data: apps } = useApps();
  const row = computed(() => (apps.value ?? []).find((a) => a.name === toValue(app)));
  const projectId = computed(() => row.value?.projectId ?? null);
  const { data: graph } = useProjectGraph(computed(() => projectId.value ?? "none"));
  const { data: variables } = useVariables(app, computed(() => !!row.value));
  const { data: storages } = useStorages();
  const { data: config } = useAppSettings(app, computed(() => !!row.value));

  return computed<ReferenceSources>(() => {
    const own = graph.value?.apps.find((a) => a.name === toValue(app));
    const env: Record<string, string[]> = {};
    for (const v of variables.value ?? []) (env[v.service] ??= []).push(v.key);
    return {
      services: toValue(ownServices)?.filter(Boolean) ?? own?.services.map((s) => s.name) ?? [],
      env,
      // other apps only connect within a project
      peers: projectId.value ? (graph.value?.apps ?? []).filter((a) => a.name !== toValue(app)).map((a) => ({ app: a.name, services: a.services.map((s) => s.name) })) : [],
      storages: (storages.value ?? []).map((s) => s.name),
      volumes: toValue(ownVolumes) ?? [...new Set([...Object.keys(config.value?.settings?.volumes ?? {}), ...Object.values(config.value?.settings?.services ?? {}).flatMap((s) => Object.keys(s.volumes ?? {}))])].sort(),
    };
  });
}
