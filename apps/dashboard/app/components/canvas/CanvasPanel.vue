<script setup lang="ts">
import type { ProjectGraph } from "~/types";
import { connectionsOf, selectionId } from "~/utils/graph";
import { formatBytes, shortRelease } from "~/utils/format";

type Selection = { app: string; service?: string };
const props = defineProps<{ graph: ProjectGraph; selection: Selection }>();
const emit = defineEmits<{ close: []; select: [Selection] }>();

const { can } = useSession();
const confirm = useConfirm();
const appName = computed(() => props.selection.app);
const { data: app } = useApp(appName);
const control = useControl(appName);

const graphApp = computed(() => props.graph.apps.find((a) => a.name === props.selection.app));
const svc = computed(() => graphApp.value?.services.find((s) => s.name === props.selection.service));
const conns = computed(() => connectionsOf(props.graph, props.selection));
const title = computed(() => props.selection.service ?? props.selection.app);

const tab = ref("overview");
watch(() => selectionId(props.selection.app, props.selection.service), () => (tab.value = "overview"));

function act(verb: "start" | "stop" | "restart") {
  const service = props.selection.service;
  if (verb === "start") return control.mutate({ verb, service });
  confirm.require({
    header: `${verb === "stop" ? "Stop" : "Restart"} ${service ?? props.selection.app}?`,
    message: verb === "stop" ? "It will stop serving until it is started again." : "It restarts in place; routed services briefly drop requests.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: verb === "stop" ? "Stop" : "Restart",
    acceptProps: { severity: verb === "stop" ? "danger" : "primary" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => control.mutate({ verb, service }),
  });
}
const peer = (e: { app: string; service: string }) => (e.app === props.selection.app ? e.service : `${e.app}/${e.service}`);
const selectEnd = (e: { app: string; service: string }) => emit("select", { app: e.app, service: e.service });
</script>

<template>
  <aside class="panel" aria-label="Details">
    <header class="px-5 pt-4 pb-3 border-b border-[var(--fr-line)] flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p v-if="selection.service" class="text-sm text-muted-color truncate"><i class="pi pi-box text-[0.7rem] mr-1" aria-hidden="true" />{{ selection.app }}</p>
        <h2 class="font-display font-semibold text-[1.7rem] leading-tight truncate">{{ title }}</h2>
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusTag :state="svc ? svc.activeState : graphApp?.status" :sub="svc?.subState" />
          <span v-if="svc" class="text-sm text-muted-color">{{ svc.subState }}</span>
        </div>
      </div>
      <div class="flex shrink-0 gap-0.5">
        <NuxtLink :to="`/apps/${selection.app}`" class="inline-flex"><Button icon="pi pi-external-link" text rounded size="small" severity="secondary" aria-label="Open the full app page" title="Open the full app page" tabindex="-1" /></NuxtLink>
        <Button icon="pi pi-times" text rounded size="small" severity="secondary" aria-label="Close" title="Close (Esc)" @click="emit('close')" />
      </div>
    </header>

    <Tabs v-model:value="tab" lazy class="flex-1 min-h-0 flex flex-col">
      <TabList>
        <Tab value="overview">Overview</Tab>
        <Tab value="logs">Logs</Tab>
        <Tab value="domains">Domains</Tab>
        <Tab value="env">Variables</Tab>
        <Tab value="deployments">Deployments</Tab>
      </TabList>
      <TabPanels class="flex-1 min-h-0 overflow-y-auto !px-5 !py-4">
        <TabPanel value="overview">
          <div class="flex flex-col gap-6">
            <div v-if="can('deployer')" class="flex flex-wrap gap-2">
              <Button label="Restart" icon="pi pi-refresh" size="small" severity="secondary" :loading="control.isPending.value" @click="act('restart')" />
              <Button v-if="svc?.activeState !== 'active'" label="Start" icon="pi pi-play" size="small" severity="secondary" @click="act('start')" />
              <Button v-else label="Stop" icon="pi pi-stop" size="small" severity="secondary" @click="act('stop')" />
            </div>

            <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt class="text-muted-color">Server</dt><dd class="font-medium">{{ graphApp?.server }}</dd></div>
              <div><dt class="text-muted-color">Release</dt><dd class="font-mono text-[0.85rem]">{{ shortRelease(graphApp?.currentRelease ?? null) }}</dd></div>
              <template v-if="svc">
                <div><dt class="text-muted-color">Port</dt><dd class="font-mono text-[0.85rem]">{{ svc.port ?? "–" }}</dd></div>
                <div><dt class="text-muted-color">Memory</dt><dd class="num">{{ formatBytes(svc.memoryBytes) }}</dd></div>
                <div><dt class="text-muted-color">Restarts</dt><dd class="num">{{ svc.restarts }}</dd></div>
                <div class="col-span-2">
                  <dt class="text-muted-color">{{ svc.image ? "Image" : "Command" }}</dt>
                  <dd class="font-mono text-[0.85rem] break-all">{{ svc.image ?? svc.command ?? "–" }}</dd>
                </div>
                <div v-if="svc.hostnames.length" class="col-span-2">
                  <dt class="text-muted-color">Domains</dt>
                  <dd v-for="h in svc.hostnames" :key="h"><a :href="`https://${h}`" target="_blank" rel="noopener" class="text-primary hover:underline">{{ h }}</a></dd>
                </div>
              </template>
              <div v-else class="col-span-2">
                <dt class="text-muted-color">Services</dt>
                <dd class="flex flex-wrap gap-x-3 gap-y-1">
                  <button v-for="s in graphApp?.services" :key="s.name" type="button" class="link-btn" @click="emit('select', { app: selection.app, service: s.name })">
                    <StatusTag :state="s.activeState" :sub="s.subState" :label="s.name" class="!font-normal" />
                  </button>
                  <span v-if="!graphApp?.services.length" class="text-muted-color">None yet</span>
                </dd>
              </div>
            </dl>

            <section aria-label="Connections">
              <h3 class="font-display font-semibold text-lg mb-2">Connections</h3>
              <p v-if="!conns.uses.length && !conns.usedBy.length" class="text-sm text-muted-color">
                Nothing connects to or from this yet. Point an environment value at a service, such as <code>API_URL: "@api.url"</code>.
              </p>
              <template v-for="[label, list, end] in ([['Uses', conns.uses, 'to'], ['Used by', conns.usedBy, 'from']] as const)" :key="label">
                <div v-if="list.length" class="mb-3">
                  <p class="text-sm text-muted-color mb-1">{{ label }}</p>
                  <ul class="flex flex-col gap-1">
                    <li v-for="(e, i) in list" :key="i" class="conn-row" :data-broken="e.broken ? '' : undefined">
                      <button type="button" class="link-btn font-medium" @click="selectEnd(e[end])">{{ peer(e[end]) }}</button>
                      <code class="text-xs">{{ e.attr }}</code>
                      <span class="text-xs text-muted-color truncate">{{ e.key }}</span>
                      <span v-if="e.broken" class="w-full text-xs text-red-600 dark:text-red-400"><i class="pi pi-exclamation-triangle mr-1" aria-hidden="true" />{{ e.broken }}</span>
                    </li>
                  </ul>
                </div>
              </template>
            </section>
          </div>
        </TabPanel>
        <TabPanel value="logs"><AppLogsTab v-if="app" :app="app" /></TabPanel>
        <TabPanel value="domains"><AppDomainsTab v-if="app" :app="app" /></TabPanel>
        <TabPanel value="env"><AppEnvTab v-if="app" :app="app" :service="selection.service" /></TabPanel>
        <TabPanel value="deployments"><AppDeploymentsTab v-if="app" :app="app" /></TabPanel>
      </TabPanels>
    </Tabs>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--fr-panel);
  border-left: 1px solid var(--fr-line);
  box-shadow: -8px 0 24px rgb(0 0 0 / 0.06);
}
dd { margin: 0; }
.link-btn { background: none; border: 0; padding: 0; color: inherit; cursor: pointer; text-align: left; }
.link-btn:hover { color: var(--p-primary-color); text-decoration: underline; }
.conn-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.15rem 0.6rem; padding: 0.35rem 0.6rem; border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-md); background: var(--fr-sunken); }
.conn-row[data-broken] { border-color: color-mix(in srgb, var(--p-red-500) 45%, var(--fr-line)); }
:deep(.p-tabpanels) { padding: 0; }
:deep(.p-tablist) { --tab-fade: var(--fr-panel); }
</style>
