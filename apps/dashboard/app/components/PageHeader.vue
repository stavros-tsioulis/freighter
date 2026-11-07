<script setup lang="ts">
/** The title row every page opens with: what this is, one sentence on its state, and the page's actions. */
defineProps<{ title: string }>();
</script>

<template>
  <header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-5 border-b border-[var(--fr-line)]">
    <div class="min-w-0">
      <slot name="before" />
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 class="font-display text-[2.15rem] leading-[1.05] font-semibold break-words min-w-0">{{ title }}</h1>
        <slot name="beside" />
      </div>
      <p v-if="$slots.default" class="mt-1.5 text-muted-color max-w-[68ch]"><slot /></p>
    </div>
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2"><slot name="actions" /></div>
  </header>
</template>
