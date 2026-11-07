<script setup lang="ts">
defineProps<{ label: string; mono?: boolean; title?: string }>();
</script>

<template>
  <div class="fact">
    <dt class="text-[0.8rem] text-muted-color">{{ label }}</dt>
    <dd class="mt-0.5 font-medium truncate" :class="mono ? 'font-mono text-[0.85rem] leading-6' : 'num'" :title="title"><slot /></dd>
  </div>
</template>

<style scoped>
.fact {
  background: var(--fr-panel);
  padding: 0.6rem 0.95rem 0.7rem;
  min-width: 0;
  box-shadow: 1px 0 0 0 var(--fr-line), 0 1px 0 0 var(--fr-line);
}
dd { margin: 0; }
</style>
