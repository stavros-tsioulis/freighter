<script setup lang="ts">
import type { FlowNode } from "~/utils/graph";

// Vue Flow passes every node prop (id, type, selected, ...); only `data` is used.
defineOptions({ inheritAttrs: false });
const props = defineProps<{ data: FlowNode["data"] }>();
const a = computed(() => props.data.app!);
const bad = computed(() => a.value.status === "missing" || a.value.services.some((s) => s.activeState === "failed"));
</script>

<template>
  <div class="grp" :data-selected="data.selected || undefined" :data-bad="bad || undefined">
    <div class="grp-head">
      <span class="grp-name">{{ a.name }}</span>
      <StatusTag :state="bad && a.status !== 'missing' ? 'failed' : a.status" :label="bad && a.status !== 'missing' ? 'Service failed' : undefined" class="!text-[0.8rem]" />
    </div>
    <p v-if="!a.services.length" class="px-3.5 text-sm text-muted-color">No services yet</p>
  </div>
</template>

<style scoped>
.grp {
  height: 100%;
  box-sizing: border-box;
  border: 1px solid var(--fr-line);
  border-radius: calc(var(--p-border-radius-lg) + 4px);
  background: color-mix(in srgb, var(--fr-sunken) 70%, transparent);
  cursor: grab;
}
.grp[data-bad] { border-color: color-mix(in srgb, var(--p-red-500) 55%, var(--fr-line)); }
.grp[data-selected] { border-color: var(--p-primary-color); box-shadow: 0 0 0 2px color-mix(in srgb, var(--p-primary-color) 30%, transparent); }
.grp-head { height: 48px; padding: 0 0.9rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.grp-name { font-family: var(--font-display); font-weight: 600; font-size: 1.1rem; letter-spacing: 0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
