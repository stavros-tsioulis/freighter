<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 22 });
</script>

<!-- Two stacked containers, the top one offset: Freighter's mark. -->
<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" aria-hidden="true" class="text-primary shrink-0">
    <rect x="2" y="12.5" width="20" height="8.5" rx="1.2" fill="currentColor" />
    <rect x="6" y="3" width="14" height="8" rx="1.2" fill="currentColor" opacity="0.55" />
    <path d="M7 15v3.5M10.5 15v3.5M14 15v3.5M17.5 15v3.5" stroke="var(--fr-rail, #fff)" stroke-width="1.3" stroke-linecap="round" />
  </svg>
</template>
