<script setup lang="ts">
import type { AppRow } from "~/types";
import { formatBytes } from "~/utils/format";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const minutes = ref(60);
const appName = computed(() => props.app.name);
const { data: series } = useMetrics(appName, minutes);
const control = useControl(appName);
const confirm = useConfirm();
const adding = ref(false);

const ranges = [
  { label: "15 min", value: 15 },
  { label: "hour", value: 60 },
  { label: "6 hours", value: 360 },
];

function last<T>(xs: T[] | undefined): T | undefined {
  return xs?.[xs.length - 1];
}
const rows = computed(() =>
  props.app.services.map((s) => {
    const pts = series.value?.[s.name] ?? [];
    const lastCpu = [...pts].reverse().find((p) => p.cpuPercent !== null)?.cpuPercent ?? null;
    return {
      ...s,
      memory: last(pts)?.memoryBytes ?? s.memoryBytes,
      memSeries: pts.map((p) => p.memoryBytes),
      cpuSeries: pts.map((p) => p.cpuPercent),
      cpu: lastCpu,
    };
  }),
);

function act(verb: "start" | "stop" | "restart", service: string) {
  if (verb === "start") return control.mutate({ verb, service });
  confirm.require({
    header: `${verb[0]!.toUpperCase()}${verb.slice(1)} ${service}?`,
    message: verb === "stop" ? "The service will stop serving until it is started again." : "The service restarts in place; routed services briefly drop requests.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: verb === "stop" ? "Stop" : "Restart",
    acceptProps: { severity: verb === "stop" ? "danger" : "primary" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => control.mutate({ verb, service }),
  });
}
const url = (host: string) => `https://${host}`;
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <Button v-if="can('admin')" label="Add service" icon="pi pi-plus" size="small" severity="secondary" @click="adding = true" />
      <span class="text-sm text-muted-color ml-auto">Memory and CPU over the last</span>
      <SelectButton v-model="minutes" :options="ranges" option-label="label" option-value="value" :allow-empty="false" size="small" aria-label="Metrics range" />
    </div>
    <DataTable scrollable :value="rows" data-key="name">
      <template #empty><span class="text-muted-color">No services yet. They appear after the first deploy.</span></template>
      <Column header="Service" field="name">
        <template #body="{ data }">
          <div class="font-medium">{{ data.name }}</div>
          <div v-if="app.images?.[data.name]" class="text-xs text-muted-color font-mono truncate max-w-[14rem]" :title="app.images[data.name]"><i class="pi pi-box text-[0.65rem] mr-1" aria-hidden="true" />{{ app.images[data.name] }}</div>
          <div v-else class="text-xs text-muted-color font-mono">{{ data.unit.replace(/^freighter-/, "").replace(".service", "") }}</div>
        </template>
      </Column>
      <Column header="State">
        <template #body="{ data }">
          <StatusTag :state="data.activeState" />
          <span class="text-xs text-muted-color ml-2">{{ data.subState }}</span>
        </template>
      </Column>
      <Column header="Address">
        <template #body="{ data }">
          <div v-for="h in data.hostnames" :key="h"><a :href="url(h)" target="_blank" rel="noopener" class="text-primary hover:underline">{{ h }}</a></div>
          <span v-if="data.port" class="text-xs text-muted-color font-mono">:{{ data.port }}</span>
          <span v-if="!data.hostnames.length && !data.port" class="text-muted-color">–</span>
        </template>
      </Column>
      <Column header="Restarts" field="restarts" />
      <Column header="Memory">
        <template #body="{ data }">
          <div class="flex items-center gap-3">
            <span class="w-16 tabular-nums">{{ formatBytes(data.memory) }}</span>
            <Sparkline :values="data.memSeries" label="memory trend" />
          </div>
        </template>
      </Column>
      <Column header="CPU">
        <template #body="{ data }">
          <div class="flex items-center gap-3">
            <span class="w-12 tabular-nums">{{ data.cpu === null ? "–" : `${data.cpu}%` }}</span>
            <Sparkline :values="data.cpuSeries" label="cpu trend" />
          </div>
        </template>
      </Column>
      <Column v-if="can('deployer')" header="" class="text-right">
        <template #body="{ data }">
          <div class="flex gap-1 justify-end">
            <Button icon="pi pi-refresh" text rounded size="small" severity="secondary" aria-label="Restart" title="Restart" :loading="control.isPending.value" @click="act('restart', data.name)" />
            <Button v-if="data.activeState === 'active'" icon="pi pi-stop-circle" text rounded size="small" severity="danger" aria-label="Stop" title="Stop" @click="act('stop', data.name)" />
            <Button v-else icon="pi pi-play" text rounded size="small" severity="success" aria-label="Start" title="Start" @click="act('start', data.name)" />
          </div>
        </template>
      </Column>
    </DataTable>
  <AppAddServiceDialog v-model:visible="adding" :app="app" />
  </div>
</template>
