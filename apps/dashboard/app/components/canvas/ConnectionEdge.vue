<script setup lang="ts">
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type Position } from "@vue-flow/core";
import { edgeLabel, type FlowEdge } from "~/utils/graph";

// Declared by hand: Vue can't expand Vue Flow's generic EdgeProps at compile time.
const props = defineProps<{
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  markerEnd?: string;
  data: FlowEdge["data"];
}>();
const path = computed(() => getBezierPath(props));
const text = computed(() => edgeLabel(props.data!.labels));
const title = computed(() =>
  props.data!.labels.map((l) => `${l.key} ← ${l.attr}${l.broken ? ` (${l.broken})` : ""}`).join("\n"),
);
</script>

<template>
  <BaseEdge
    :id="id"
    :path="path[0]"
    :marker-end="markerEnd"
    class="conn"
    :class="{ 'is-broken': data!.broken, 'is-hot': data!.highlight, 'is-dim': data!.dim }"
  />
  <EdgeLabelRenderer>
    <div
      class="pill nodrag nopan"
      :class="{ 'is-broken': data!.broken, 'is-hot': data!.highlight, 'is-dim': data!.dim }"
      :style="{ transform: `translate(-50%, -50%) translate(${path[1]}px, ${path[2]}px)` }"
      :title="title"
    >
      <i v-if="data!.broken" class="pi pi-exclamation-triangle" aria-hidden="true" />{{ text }}
    </div>
  </EdgeLabelRenderer>
</template>

<style scoped>
:deep(.conn) { stroke: var(--p-surface-400); stroke-width: 1.75; fill: none; transition: opacity 0.15s, stroke 0.15s; }
:deep(.conn.is-hot) { stroke: var(--p-primary-color); stroke-width: 2.25; stroke-dasharray: 7 5; animation: flow 0.9s linear infinite; }
:deep(.conn.is-broken) { stroke: var(--p-red-500); stroke-dasharray: 4 4; }
:deep(.conn.is-dim) { opacity: 0.3; }
.pill {
  position: absolute;
  pointer-events: all;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.05rem 0.5rem;
  font-size: 0.75rem;
  line-height: 1.4;
  font-family: var(--font-mono);
  color: var(--p-text-muted-color);
  background: var(--fr-panel);
  border: 1px solid var(--fr-line);
  border-radius: 999px;
  transition: opacity 0.15s;
}
.pill.is-hot { color: var(--p-primary-color); border-color: var(--p-primary-color); }
.pill.is-broken { color: var(--p-red-600); border-color: var(--p-red-400); }
.pill.is-dim { opacity: 0.4; }
.pill i { font-size: 0.65rem; }
@keyframes flow { to { stroke-dashoffset: -12; } }
@media (prefers-reduced-motion: reduce) { :deep(.conn.is-hot) { animation: none; } }
</style>
