<script setup lang="ts">
const props = defineProps<{ id: string; running: boolean }>();
const { text, forbidden } = useDeploymentLog(() => props.id, () => props.running);
const box = ref<HTMLElement | null>(null);

// Follow the tail while the build is running, unless the user scrolled up to read.
watch(text, async () => {
  const el = box.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  await nextTick();
  if (nearBottom) el.scrollTop = el.scrollHeight;
});
</script>

<template>
  <Message v-if="forbidden" severity="secondary" size="small">Build logs require the deployer role.</Message>
  <pre
    v-else
    ref="box"
    class="font-mono text-xs leading-5 p-3 rounded-md bg-surface-950 text-surface-100 overflow-auto max-h-80 whitespace-pre-wrap break-words"
    tabindex="0"
    aria-label="Build log"
  >{{ text || (running ? "Waiting for output…" : "No log was recorded.") }}</pre>
</template>
