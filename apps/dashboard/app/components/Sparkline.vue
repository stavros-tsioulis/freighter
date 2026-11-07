<script setup lang="ts">
import { sparkline } from "~/utils/sparkline";

const props = withDefaults(defineProps<{ values: (number | null)[]; width?: number; height?: number; label?: string }>(), { width: 120, height: 28, label: "trend" });
const geo = computed(() => sparkline(props.values, props.width, props.height));
</script>

<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="label" class="text-primary overflow-visible">
    <path v-if="geo.area" :d="geo.area" fill="currentColor" opacity="0.12" />
    <path v-if="geo.line" :d="geo.line" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    <line v-else :x1="2" :x2="width - 2" :y1="height / 2" :y2="height / 2" stroke="currentColor" opacity="0.25" stroke-dasharray="3 3" />
  </svg>
</template>
