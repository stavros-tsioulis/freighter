<script setup lang="ts">
import type { ProcessRow } from "~/types";
import { useProcesses, useSignalProcess } from "~/composables/files";
import { formatBytes, timeAgo } from "~/utils/format";

/** What is running on the server, with the processes Freighter manages in their own colour. */
const props = defineProps<{ server: string; enabled: boolean; readOnly?: boolean }>();
const confirm = useConfirm();
const notify = useNotify();
const live = ref(true);
const { data, error, isFetching } = useProcesses(computed(() => props.server), live, computed(() => props.enabled));
const signal = useSignalProcess(computed(() => props.server));

const filter = ref("");
const onlyManaged = ref(false);
const showKernel = ref(false);
const rows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return (data.value?.processes ?? []).filter((p) => {
    if (!showKernel.value && p.kernel) return false;
    if (onlyManaged.value && !p.managed) return false;
    if (!q) return true;
    return [p.name, p.command, p.user, String(p.pid), p.managed?.app ?? "", p.managed?.service ?? ""].some((x) => x.toLowerCase().includes(q));
  });
});
const counts = computed(() => {
  const all = data.value?.processes ?? [];
  return { all: all.length, managed: all.filter((p) => p.managed).length };
});
const memTotal = computed(() => data.value?.memTotal ?? 0);
const cpus = computed(() => data.value?.cpus ?? 1);

const KINDS: Record<string, { label: string; tone: string }> = {
  app: { label: "App", tone: "app" },
  storage: { label: "Storage", tone: "app" },
  build: { label: "Build", tone: "build" },
  platform: { label: "Freighter", tone: "platform" },
};
const labelOf = (p: ProcessRow) => {
  const m = p.managed;
  if (!m) return "";
  if (m.kind === "build") return "build";
  if (m.kind === "platform") return "Freighter";
  const app = m.kind === "storage" ? m.app!.replace(/^storage-/, "") : m.app!;
  return m.service ? `${app}/${m.service}` : app;
};
const tone = (p: ProcessRow) => (p.managed ? KINDS[p.managed.kind]!.tone : undefined);
const STATES: Record<string, string> = { R: "running", S: "sleeping", D: "waiting on disk", Z: "zombie", T: "stopped", t: "traced", I: "idle", X: "dead" };

function ask(p: ProcessRow, sig: "TERM" | "KILL") {
  const force = sig === "KILL";
  const managed = p.managed?.kind === "app" || p.managed?.kind === "storage";
  confirm.require({
    header: `${force ? "Kill" : "Terminate"} ${p.name} (${p.pid})?`,
    message: managed
      ? `This belongs to ${labelOf(p)}. systemd starts it again right away; to stop it for good, use Stop on the app's Services tab.`
      : force
        ? "It is stopped at once and gets no chance to clean up."
        : "It is asked to exit and can clean up first.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: force ? "Kill" : "Terminate",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: async () => {
      const ok = await signal.mutateAsync({ pid: p.pid, starttime: p.starttime, signal: sig, name: p.name }).then(() => true, () => false);
      if (ok) notify.ok(force ? "Killed" : "Terminated", `${p.name} (${p.pid})`);
    },
  });
}
const canSignal = (p: ProcessRow) => !props.readOnly && !p.kernel && p.pid > 1 && p.managed?.kind !== "platform";
const menu = ref();
const target = ref<ProcessRow | null>(null);
const menuItems = computed(() => {
  const p = target.value;
  if (!p) return [];
  return [
    { label: "Terminate (SIGTERM)", icon: "pi pi-stop-circle", disabled: !canSignal(p), command: () => ask(p, "TERM") },
    { label: "Kill (SIGKILL)", icon: "pi pi-times-circle", disabled: !canSignal(p), command: () => ask(p, "KILL") },
    { separator: true },
    { label: "Copy command", icon: "pi pi-copy", command: () => void navigator.clipboard?.writeText(p.command) },
    ...(p.managed?.app && p.managed.kind === "app" ? [{ label: "Open app", icon: "pi pi-arrow-right", command: () => void navigateTo(`/apps/${p.managed!.app}`) }] : []),
    ...(p.managed?.kind === "storage" ? [{ label: "Open storage", icon: "pi pi-arrow-right", command: () => void navigateTo(`/storage/${p.managed!.app!.replace(/^storage-/, "")}`) }] : []),
  ];
});
function open(e: Event, p: ProcessRow) {
  target.value = p;
  menu.value?.show(e);
}
const cpuBar = (p: ProcessRow) => Math.min(100, p.cpu / cpus.value);
const memPct = (p: ProcessRow) => (memTotal.value ? (p.rss / memTotal.value) * 100 : 0);
const errorText = computed(() => (error.value as Error | null)?.message ?? "");
</script>

<template>
  <section class="flex flex-col gap-3" aria-labelledby="proc-h">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h3 id="proc-h" class="font-display font-semibold text-[1.35rem] leading-tight">Processes</h3>
      <span class="text-sm text-muted-color">{{ counts.all }} running<template v-if="counts.managed">, <span class="legend app" /> {{ counts.managed }} Freighter's</template></span>
      <div class="ml-auto flex flex-wrap items-center gap-3 text-sm">
        <label class="flex items-center gap-2"><ToggleSwitch v-model="onlyManaged" input-id="pr-managed" /><span>Freighter's only</span></label>
        <label class="flex items-center gap-2"><ToggleSwitch v-model="showKernel" input-id="pr-kernel" /><span>Kernel threads</span></label>
        <Button :icon="live ? 'pi pi-pause' : 'pi pi-play'" :label="live ? 'Live' : 'Paused'" size="small" severity="secondary" text :loading="isFetching && live" :aria-pressed="live" @click="live = !live" />
        <IconField>
          <InputIcon class="pi pi-search" />
          <InputText v-model="filter" size="small" placeholder="Filter" aria-label="Filter processes" autocomplete="off" class="w-44" />
        </IconField>
      </div>
    </div>

    <Message v-if="!enabled" severity="info" size="small" :closable="false">The process list is turned off on this server (<code>agent.processes.enabled</code> in its config.yaml).</Message>
    <Message v-else-if="errorText && !data" severity="error" size="small">{{ errorText }}</Message>
    <Message v-else-if="errorText" severity="warn" size="small">{{ errorText }}</Message>

    <DataTable v-if="enabled" :value="rows" data-key="pid" size="small" scrollable scroll-height="55vh" sort-field="rss" :sort-order="-1" removable-sort :row-class="(p: ProcessRow) => (p.managed ? `managed ${tone(p)}` : '')" :loading="!data && isFetching" context-menu @row-contextmenu="(e: any) => open(e.originalEvent, e.data)">
      <template #empty><span class="text-muted-color">{{ filter || onlyManaged ? "Nothing matches." : "No processes." }}</span></template>
      <Column field="name" header="Process" sortable>
        <template #body="{ data: p }">
          <div class="min-w-0 flex flex-col">
            <span class="inline-flex items-center gap-2 min-w-0">
              <span class="font-medium truncate" :title="p.name">{{ p.name }}</span>
              <NuxtLink v-if="p.managed" :to="p.managed.kind === 'app' ? `/apps/${p.managed.app}` : p.managed.kind === 'storage' ? `/storage/${p.managed.app!.replace(/^storage-/, '')}` : undefined" class="tag" :data-tone="tone(p)" :title="`${KINDS[p.managed.kind]!.label}${p.unit ? ` · ${p.unit}` : ''}`" @click.stop>{{ labelOf(p) }}</NuxtLink>
            </span>
            <span class="text-xs text-muted-color font-mono truncate max-w-[34rem]" :title="p.command">{{ p.command }}</span>
          </div>
        </template>
      </Column>
      <Column field="pid" header="PID" sortable style="width: 5.5rem" body-class="num"><template #body="{ data: p }"><span class="num text-muted-color">{{ p.pid }}</span></template></Column>
      <Column field="user" header="User" sortable class="hidden md:table-cell" header-class="hidden md:table-cell" style="width: 8rem"><template #body="{ data: p }"><span class="text-sm text-muted-color">{{ p.user }}</span></template></Column>
      <Column field="cpu" header="CPU" sortable style="width: 8rem">
        <template #body="{ data: p }">
          <div class="meter" :title="`${p.cpu}% of one core`"><span class="num w-12 text-right">{{ p.cpu.toFixed(p.cpu < 10 ? 1 : 0) }}%</span><span class="bar"><i :style="{ width: `${cpuBar(p)}%` }" /></span></div>
        </template>
      </Column>
      <Column field="rss" header="Memory" sortable style="width: 10rem">
        <template #body="{ data: p }">
          <div class="meter" :title="`${memPct(p).toFixed(1)}% of the server's memory`"><span class="num w-16 text-right">{{ formatBytes(p.rss) }}</span><span class="bar"><i :style="{ width: `${Math.min(100, memPct(p))}%` }" /></span></div>
        </template>
      </Column>
      <Column field="threads" header="Threads" sortable class="hidden lg:table-cell" header-class="hidden lg:table-cell" style="width: 6rem"><template #body="{ data: p }"><span class="num text-muted-color">{{ p.threads }}</span></template></Column>
      <Column field="state" header="State" class="hidden lg:table-cell" header-class="hidden lg:table-cell" style="width: 8rem"><template #body="{ data: p }"><span class="text-sm" :class="p.state === 'Z' ? 'text-red-600 dark:text-red-400' : 'text-muted-color'">{{ STATES[p.state] ?? p.state }}</span></template></Column>
      <Column field="startedMs" header="Started" sortable class="hidden xl:table-cell" header-class="hidden xl:table-cell" style="width: 8rem"><template #body="{ data: p }"><span class="text-sm text-muted-color" :title="new Date(p.startedMs).toLocaleString()">{{ timeAgo(new Date(p.startedMs).toISOString()) }}</span></template></Column>
      <Column header="" style="width: 3rem" body-class="text-right">
        <template #body="{ data: p }"><Button icon="pi pi-ellipsis-v" text rounded size="small" severity="secondary" :aria-label="`Actions for ${p.name} ${p.pid}`" @click.stop="open($event, p)" /></template>
      </Column>
    </DataTable>
    <ContextMenu ref="menu" :model="menuItems" />
    <p v-if="enabled && readOnly" class="text-sm text-amber-600 dark:text-amber-400">Read-only on this server: processes can be looked at, not signaled.</p>
  </section>
</template>

<style scoped>
.legend { display: inline-block; width: 0.7rem; height: 0.7rem; border-radius: 0.2rem; vertical-align: -0.05rem; }
.legend.app, .tag[data-tone="app"] { --c: var(--p-primary-color); }
.tag { display: inline-flex; align-items: center; padding: 0.05rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; line-height: 1.4; white-space: nowrap; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); border: 1px solid color-mix(in srgb, var(--c) 40%, transparent); text-decoration: none; }
.tag[data-tone="build"] { --c: var(--p-amber-500); }
.tag[data-tone="platform"] { --c: var(--p-violet-500, #8b5cf6); }
.legend.app { background: var(--c); }
.meter { display: flex; align-items: center; gap: 0.5rem; }
.bar { flex: 1; height: 4px; border-radius: 2px; background: var(--fr-line); overflow: hidden; min-width: 2rem; }
.bar i { display: block; height: 100%; background: var(--p-text-muted-color); }
:deep(tr.managed > td:first-child) { box-shadow: inset 3px 0 0 var(--c, var(--p-primary-color)); }
:deep(tr.managed.app) { --c: var(--p-primary-color); }
:deep(tr.managed.build) { --c: var(--p-amber-500); }
:deep(tr.managed.platform) { --c: var(--p-violet-500, #8b5cf6); }
:deep(tr.managed) { background: color-mix(in srgb, var(--c) 7%, transparent); }
:deep(tr.managed .bar i) { background: var(--c); }
:deep(.p-datatable-tbody > tr) { cursor: default; }
</style>
