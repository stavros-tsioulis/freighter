<script setup lang="ts">
import type { ServerRow } from "~/types";
import { niceMax } from "~/utils/chart";
import { formatBytes, formatDuration } from "~/utils/format";

/** How the machine has been doing: load, memory and disk, sampled by the control plane along with the apps' metrics. */
const props = defineProps<{ server: ServerRow }>();
const minutes = ref(60);
const ranges = [{ label: "15 min", value: 15 }, { label: "Hour", value: 60 }, { label: "6 hours", value: 360 }, { label: "Day", value: 1440 }];
const { data: points, isLoading } = useHostMetrics(computed(() => props.server.name), minutes, computed(() => props.server.status !== "pending"));
const to = ref(Date.now());
const from = computed(() => to.value - minutes.value * 60_000);
watch([points, minutes], () => (to.value = Date.now()), { immediate: true });

const last = computed(() => points.value?.at(-1));
const cpus = computed(() => last.value?.cpus ?? props.server.host?.cpus ?? null);
const t = (p: { at: string }) => Date.parse(p.at);
const load = computed(() => (points.value ?? []).map((p) => ({ t: t(p), v: p.load1 })));
const mem = computed(() => (points.value ?? []).map((p) => ({ t: t(p), v: p.memUsed })));
const disk = computed(() => (points.value ?? []).map((p) => ({ t: t(p), v: p.diskUsed })));
const loadMax = computed(() => niceMax(Math.max(cpus.value ?? 1, ...load.value.map((p) => p.v)), 1));
const pct = (used: number | null | undefined, total: number | null | undefined) => (used != null && total ? `${Math.round((used / total) * 100)}%` : "–");
const h = computed(() => props.server.host);
</script>

<template>
  <div class="flex flex-col gap-5">
    <Facts v-if="h">
      <Fact label="Up for">{{ formatDuration(h.uptimeSeconds * 1000) }}</Fact>
      <Fact v-if="cpus" label="CPUs">{{ cpus }}</Fact>
      <Fact v-if="h.os" label="System" :title="h.os">{{ h.os }}</Fact>
      <Fact label="Load (1 min)">{{ h.load1.toFixed(2) }}<span v-if="cpus" class="text-muted-color font-normal"> on {{ cpus }}</span></Fact>
    </Facts>

    <div class="flex items-center justify-between gap-2">
      <span class="text-sm text-muted-color">Readings every 15 seconds, kept for six hours.</span>
      <SelectButton v-model="minutes" :options="ranges" option-label="label" option-value="value" :allow-empty="false" size="small" aria-label="Time range" />
    </div>
    <Skeleton v-if="isLoading" height="12rem" />
    <div v-else class="grid gap-4 lg:grid-cols-2">
      <ServerMetricChart
        class="lg:col-span-2"
        title="Load"
        :value="last ? last.load1.toFixed(2) : '–'"
        :detail="cpus ? `${cpus} CPUs` : undefined"
        :points="load"
        :from="from"
        :to="to"
        :y-max="loadMax"
        :format="(v: number) => v.toFixed(v < 10 ? 2 : 0)"
        :mark="cpus ? { value: cpus, label: 'all CPUs busy' } : undefined"
      />
      <ServerMetricChart title="Memory" :value="pct(last?.memUsed, last?.memTotal)" :detail="last ? `${formatBytes(last.memUsed)} of ${formatBytes(last.memTotal)}` : undefined" :points="mem" :from="from" :to="to" :y-max="last?.memTotal ?? 1" :format="formatBytes" />
      <ServerMetricChart title="Disk" :value="pct(last?.diskUsed, last?.diskTotal)" :detail="last?.diskUsed != null && last.diskTotal ? `${formatBytes(last.diskUsed)} of ${formatBytes(last.diskTotal)}` : undefined" :points="disk" :from="from" :to="to" :y-max="last?.diskTotal ?? 1" :format="formatBytes" />
    </div>
  </div>
</template>
