<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import type { FlowNode } from "~/utils/graph";

// Vue Flow passes every node prop (id, type, selected, ...); only `data` is used.
defineOptions({ inheritAttrs: false });
const props = defineProps<{ data: FlowNode["data"] }>();
const s = computed(() => props.data.service!);
const tone = computed(() => (s.value.activeState === "failed" ? "bad" : s.value.activeState === "active" ? "ok" : "idle"));
const address = computed(() => s.value.hostnames[0] ?? (s.value.port ? `:${s.value.port}` : null));
// The left band carries the state; the words are for screen readers and the tooltip.
const state = computed(() => ({ active: "Running", failed: "Failed", inactive: "Stopped", activating: "Starting", deactivating: "Stopping" })[s.value.activeState] ?? s.value.activeState);
</script>

<template>
  <div class="svc" :data-tone="tone" :data-selected="data.selected || undefined" :aria-label="`${s.name}, ${state}`" :title="state">
    <Handle type="target" :position="Position.Left" :connectable="false" />
    <span class="svc-name">{{ s.name }}</span>
    <div class="svc-line" :title="s.hostnames.join(', ')">
      <i :class="s.hostnames.length ? 'pi pi-globe' : 'pi pi-link'" aria-hidden="true" />
      <span v-if="address" class="truncate">{{ address }}<template v-if="s.hostnames.length > 1"> +{{ s.hostnames.length - 1 }}</template></span>
      <span v-else>No address</span>
    </div>
    <Handle type="source" :position="Position.Right" :connectable="false" />
  </div>
</template>

<style scoped>
.svc {
  position: relative;
  height: 100%;
  box-sizing: border-box;
  padding: 0.6rem 0.8rem 0.55rem 1rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.2rem;
  background: var(--fr-panel);
  border: 1px solid var(--fr-line);
  border-radius: var(--p-border-radius-lg);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
  overflow: hidden;
}
.svc::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--band);
}
.svc[data-tone="ok"] { --band: var(--p-green-500); }
.svc[data-tone="bad"] { --band: var(--p-red-500); }
.svc[data-tone="idle"] { --band: var(--p-surface-300); }
.svc:hover { border-color: var(--p-surface-400); }
.svc[data-selected] { border-color: var(--p-primary-color); box-shadow: 0 0 0 2px color-mix(in srgb, var(--p-primary-color) 35%, transparent); }
.svc-name { font-family: var(--font-display); font-weight: 600; font-size: 1.25rem; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.svc-line { display: flex; align-items: center; gap: 0.45rem; font-size: 0.85rem; color: var(--p-text-muted-color); min-width: 0; }
.svc-line i { font-size: 0.7rem; flex: none; }
:deep(.vue-flow__handle) { width: 8px; height: 8px; background: var(--fr-panel); border: 2px solid var(--p-surface-400); }
</style>
