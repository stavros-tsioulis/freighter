<script setup lang="ts">
import { MarkerType, VueFlow, useVueFlow, type NodeMouseEvent } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import type { ProjectGraph } from "~/types";
import { buildFlow, type FlowEdge, type FlowNode } from "~/utils/graph";

type Selection = { app: string; service?: string } | null;
const props = defineProps<{ graph: ProjectGraph; selected: Selection; editable: boolean }>();
const emit = defineEmits<{ select: [Selection]; layout: [ProjectGraph["layout"]] }>();

const flow = computed(() => buildFlow(props.graph, props.selected));
const COLOR = { rest: "#6b7783", hot: "#7183ea", bad: "#ef4444" };
const withMarker = (e: FlowEdge) => {
  const color = e.data.broken ? COLOR.bad : e.data.highlight ? COLOR.hot : COLOR.rest;
  return { ...e, markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 } };
};

// The graph is refetched every few seconds. Hand Vue Flow new nodes only when something visible changed, and never in
// the middle of a drag, so a refresh can't snap a card back under the pointer.
const nodes = ref<FlowNode[]>([]);
const edges = ref<ReturnType<typeof withMarker>[]>([]);
const dragging = ref(false);
let lastNodes = "";
let lastEdges = "";
function sync() {
  if (dragging.value) return;
  const n = JSON.stringify(flow.value.nodes);
  const e = JSON.stringify(flow.value.edges);
  if (n !== lastNodes) {
    nodes.value = flow.value.nodes;
    lastNodes = n;
  }
  if (e !== lastEdges) {
    edges.value = flow.value.edges.map(withMarker);
    lastEdges = e;
  }
}
watch(flow, sync, { immediate: true });

const { getNodes, fitView, onNodeDragStart, onNodeDragStop, onNodeClick, onPaneClick } = useVueFlow();
onNodeDragStart(() => (dragging.value = true));
onNodeDragStop(() => {
  dragging.value = false;
  const positions: ProjectGraph["layout"] = { ...props.graph.layout };
  for (const n of getNodes.value) if (n.type === "app") positions[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
  emit("layout", positions);
});
onNodeClick(({ node }: NodeMouseEvent) => {
  const d = node.data as FlowNode["data"];
  emit("select", { app: d.app.name, service: node.type === "service" ? d.service?.name : undefined });
});
onPaneClick(() => emit("select", null));

const fit = () => void fitView({ padding: 0.2, duration: 250, maxZoom: 1 });
defineExpose({ fit });
const minimapColor = (n: { data?: FlowNode["data"]; type?: string }) =>
  n.type === "app" ? "transparent" : n.data?.service?.activeState === "failed" ? "#ef4444" : n.data?.service?.activeState === "active" ? "#22c55e" : "#96a1ab";
</script>

<template>
  <VueFlow
    :nodes="nodes"
    :edges="edges"
    :nodes-draggable="editable"
    :nodes-connectable="false"
    :elements-selectable="true"
    :min-zoom="0.2"
    :max-zoom="1.6"
    :default-viewport="{ x: 0, y: 0, zoom: 1 }"
    :fit-view-on-init="true"
    :fit-view-params="{ padding: 0.2, maxZoom: 1 }"
    :delete-key-code="null"
    :zoom-on-double-click="false"
    class="canvas"
    aria-label="Project canvas"
  >
    <template #node-app="p"><CanvasAppGroupNode v-bind="p" /></template>
    <template #node-service="p"><CanvasServiceNode v-bind="p" /></template>
    <template #edge-connection="p"><CanvasConnectionEdge v-bind="p" /></template>
    <Background :gap="22" :size="1.6" pattern-color="var(--canvas-dot)" />
    <Controls position="bottom-left" :show-interactive="false" />
    <MiniMap pannable zoomable :node-color="minimapColor" :node-stroke-width="0" mask-color="rgb(0 0 0 / 0.08)" class="hidden md:block" />
  </VueFlow>
</template>

<style>
.canvas.vue-flow {
  --canvas-dot: var(--p-surface-300);
  background: var(--fr-page);
}
.app-dark .canvas.vue-flow { --canvas-dot: var(--p-surface-700); }
.canvas .vue-flow__node { cursor: pointer; }
.canvas .vue-flow__node-app { cursor: grab; }
.canvas .vue-flow__node:focus-visible { outline: 2px solid var(--p-primary-color); outline-offset: 2px; border-radius: 10px; }
.canvas .vue-flow__node.selected, .canvas .vue-flow__node:focus { box-shadow: none; }
.canvas .vue-flow__controls { box-shadow: none; border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-md); overflow: hidden; margin: 1rem; }
.canvas .vue-flow__controls-button { background: var(--fr-panel); border-bottom: 1px solid var(--fr-line); color: var(--p-text-color); fill: currentColor; width: 30px; height: 30px; }
.canvas .vue-flow__controls-button:hover { background: var(--fr-sunken); }
.canvas .vue-flow__minimap { background: var(--fr-panel); border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-md); margin: 1rem; overflow: hidden; }
.app-dark .canvas .vue-flow__minimap-mask { fill: rgb(255 255 255 / 0.06); }
.canvas .vue-flow__edge-path { stroke-linecap: round; }
</style>
