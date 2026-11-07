<script setup lang="ts">
import type { AppRow } from "~/types";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const notify = useNotify();
const appName = computed(() => props.app.name);
const service = ref<string | null>(props.app.services[0]?.name ?? null);
const lines = ref(200);
const live = ref(false);
const options = computed(() => props.app.services.map((s) => ({ label: s.name, value: s.name })));
const { data: text, error, isFetching, refetch } = useLogs(appName, service, lines, live);
const box = ref<HTMLElement | null>(null);

// Keep the view pinned to the newest line unless the user scrolled up.
watch(text, async () => {
  const el = box.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  await nextTick();
  if (nearBottom || live.value) el.scrollTop = el.scrollHeight;
});

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value ?? "");
    notify.ok("Copied");
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}
function download() {
  const url = URL.createObjectURL(new Blob([text.value ?? ""], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${props.app.name}-${service.value}.log` });
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <Message v-if="!can('deployer')" severity="info">Reading logs requires the deployer role.</Message>
  <div v-else class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-3">
      <Select v-model="service" :options="options" option-label="label" option-value="value" placeholder="Service" class="w-48" aria-label="Service" />
      <InputNumber v-model="lines" :min="10" :max="1000" :step="50" show-buttons button-layout="horizontal" input-class="w-20 text-center" suffix=" lines" aria-label="Number of lines" />
      <div class="flex items-center gap-2">
        <ToggleSwitch v-model="live" input-id="logs-live" />
        <label for="logs-live" class="text-sm">Live</label>
      </div>
      <div class="ml-auto flex gap-1">
        <Button icon="pi pi-refresh" text rounded severity="secondary" aria-label="Refresh" :loading="isFetching" @click="refetch()" />
        <Button icon="pi pi-copy" text rounded severity="secondary" aria-label="Copy" :disabled="!text" @click="copy" />
        <Button icon="pi pi-download" text rounded severity="secondary" aria-label="Download" :disabled="!text" @click="download" />
      </div>
    </div>
    <Message v-if="error" severity="error" size="small">{{ error.message }}</Message>
    <pre ref="box" class="font-mono text-xs leading-5 p-3 rounded-md bg-surface-950 text-surface-100 overflow-auto h-[28rem] whitespace-pre-wrap break-words" tabindex="0">{{ text || (isFetching ? "Loading…" : "No log lines.") }}</pre>
  </div>
</template>
