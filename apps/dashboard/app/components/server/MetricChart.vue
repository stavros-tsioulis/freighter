<script setup lang="ts">
import { chartGeometry, nearest, type ChartPoint } from "~/utils/chart";

/** One reading over time: filled line, a scale, and the value under the pointer. */
const props = defineProps<{
  title: string;
  /** The latest value, as text. */
  value: string;
  detail?: string;
  points: ChartPoint[];
  from: number;
  to: number;
  yMax: number;
  format: (v: number) => string;
  /** A line to mark on the scale (e.g. all the CPUs busy). */
  mark?: { value: number; label: string };
  gapMs?: number;
}>();

const W = 600;
const H = 120;
const geo = computed(() => chartGeometry(props.points, props.from, props.to, props.yMax, W, H, props.gapMs ?? 90_000));
const hover = ref<{ x: number; y: number; t: number; v: number } | null>(null);
function move(e: PointerEvent) {
  const r = (e.currentTarget as SVGElement).getBoundingClientRect();
  hover.value = nearest(geo.value.dots, ((e.clientX - r.left) / r.width) * W) ?? null;
}
const markY = computed(() => (props.mark && props.mark.value <= props.yMax ? H - 2 - (props.mark.value / props.yMax) * (H - 4) : null));
const when = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const gradient = `mc-${useId()}`;
</script>

<template>
  <figure class="chart">
    <figcaption class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 mb-2">
      <span class="font-medium">{{ title }}</span>
      <span class="num text-lg font-semibold">{{ value }}</span>
      <span v-if="detail" class="text-sm text-muted-color">{{ detail }}</span>
    </figcaption>
    <div class="relative">
      <span class="axis top-0">{{ format(yMax) }}</span>
      <span class="axis bottom-0">{{ format(0) }}</span>
      <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="w-full h-[120px] text-primary" role="img" :aria-label="`${title} over time`" @pointermove="move" @pointerleave="hover = null">
        <defs><linearGradient :id="gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity="0.28" /><stop offset="1" stop-color="currentColor" stop-opacity="0.02" /></linearGradient></defs>
        <line x1="0" :x2="W" :y1="H / 2" :y2="H / 2" stroke="currentColor" opacity="0.08" />
        <line x1="0" :x2="W" y1="1" y2="1" stroke="currentColor" opacity="0.08" />
        <line x1="0" :x2="W" :y1="H - 1" :y2="H - 1" stroke="currentColor" opacity="0.2" />
        <template v-if="markY !== null"><line x1="0" :x2="W" :y1="markY" :y2="markY" stroke="currentColor" opacity="0.5" stroke-dasharray="4 4" vector-effect="non-scaling-stroke" /></template>
        <path v-if="geo.area" :d="geo.area" :fill="`url(#${gradient})`" />
        <path v-if="geo.line" :d="geo.line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        <line v-if="hover" :x1="hover.x" :x2="hover.x" y1="0" :y2="H" stroke="currentColor" opacity="0.4" vector-effect="non-scaling-stroke" />
      </svg>
      <span v-if="mark && markY !== null" class="mark" :style="{ top: `${(markY / H) * 100}%` }">{{ mark.label }}</span>
      <div v-if="hover" class="tip" :style="{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }" :class="{ flip: hover.x > W * 0.7 }"><b class="num">{{ format(hover.v) }}</b> <span class="text-muted-color">{{ when(hover.t) }}</span></div>
      <p v-if="!geo.dots.length" class="absolute inset-0 flex items-center justify-center text-sm text-muted-color">No readings yet</p>
    </div>
  </figure>
</template>

<style scoped>
.chart { margin: 0; padding: 0.9rem 1.1rem 0.8rem; background: var(--fr-panel); border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-lg); }
.axis { position: absolute; left: 0.25rem; font-size: 0.7rem; color: var(--p-text-muted-color); background: var(--fr-panel); padding: 0 0.2rem; border-radius: 0.2rem; z-index: 1; }
.mark { position: absolute; right: 0.25rem; transform: translateY(-110%); font-size: 0.7rem; color: var(--p-text-muted-color); }
.tip { position: absolute; transform: translate(0.6rem, -120%); white-space: nowrap; font-size: 0.8rem; background: var(--p-content-background, var(--fr-panel)); border: 1px solid var(--fr-line); border-radius: 0.4rem; padding: 0.15rem 0.5rem; pointer-events: none; box-shadow: 0 4px 12px rgb(0 0 0 / 0.12); z-index: 2; }
.tip.flip { transform: translate(calc(-100% - 0.6rem), -120%); }
</style>
