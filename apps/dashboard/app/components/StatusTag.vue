<script setup lang="ts">
const props = defineProps<{ state: string | null | undefined }>();
const severity = computed(() => {
  const map: Record<string, string> = {
    active: "success", deployed: "success", success: "success",
    failed: "danger", missing: "danger",
    activating: "warn", reloading: "warn", deactivating: "warn",
    running: "info",
  };
  return map[props.state ?? ""] ?? "secondary";
});
</script>

<template>
  <Tag :value="state ?? 'unknown'" :severity="severity as never" />
</template>
