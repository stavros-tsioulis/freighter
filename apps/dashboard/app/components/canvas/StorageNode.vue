<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import type { FlowNode } from "~/utils/graph";
import { KINDS } from "~/utils/storage";

// Vue Flow passes every node prop (id, type, selected, ...); only `data` is used.
defineOptions({ inheritAttrs: false });
const props = defineProps<{ data: FlowNode["data"] }>();
const s = computed(() => props.data.storage!);
const tone = computed(() => (s.value.activeState === "failed" ? "bad" : s.value.activeState === "active" ? "ok" : "idle"));
const label = computed(() => KINDS.find((k) => k.kind === s.value.kind)?.label ?? s.value.kind);
</script>

<template>
  <div class="st" :data-tone="tone" :aria-label="`Storage ${s.name}, ${s.activeState}`" :title="`Open ${s.name}`">
    <Handle type="target" :position="Position.Left" :connectable="false" />
    <span class="st-name"><i class="pi pi-database" aria-hidden="true" />{{ s.name }}</span>
    <span class="st-line"><span>{{ label }}</span><span v-if="s.hostnames[0]" class="truncate">· {{ s.hostnames[0] }}</span></span>
  </div>
</template>

<style scoped>
.st {
  position: relative;
  height: 100%;
  box-sizing: border-box;
  padding: 0.55rem 0.8rem 0.5rem 1rem;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.15rem;
  background: color-mix(in srgb, var(--p-primary-color) 6%, var(--fr-panel));
  border: 1px dashed color-mix(in srgb, var(--p-primary-color) 55%, var(--fr-line));
  border-radius: var(--p-border-radius-lg);
  cursor: pointer;
  overflow: hidden;
}
.st::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--band); }
.st[data-tone="ok"] { --band: var(--p-green-500); }
.st[data-tone="bad"] { --band: var(--p-red-500); }
.st[data-tone="idle"] { --band: var(--p-surface-300); }
.st:hover { border-style: solid; }
.st-name { display: flex; align-items: center; gap: 0.45rem; font-family: var(--font-display); font-weight: 600; font-size: 1.2rem; line-height: 1.15; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-name i { font-size: 0.8rem; color: var(--p-text-muted-color); }
.st-line { display: flex; gap: 0.35rem; font-size: 0.85rem; color: var(--p-text-muted-color); min-width: 0; }
:deep(.vue-flow__handle) { width: 8px; height: 8px; background: var(--fr-panel); border: 2px solid var(--p-surface-400); }
</style>
