<script setup lang="ts">
import { validateRepoUrl } from "~/utils/validation";

const props = defineProps<{ repository: string; sshKeyId: string | null; server?: string }>();
const model = defineModel<string | null>({ required: true });

// Wait for typing to settle, and for something that looks like a repository URL, before touching the network.
const settled = ref(props.repository);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.repository, (v) => {
  clearTimeout(timer);
  timer = setTimeout(() => (settled.value = v), 500);
});
onBeforeUnmount(() => clearTimeout(timer));
const ready = computed(() => settled.value.trim() !== "" && validateRepoUrl(settled.value) === "" && settled.value === props.repository);

const { data, isFetching, error } = useBranches(settled, () => props.sshKeyId, ready, () => props.server);
const options = computed(() => (ready.value ? data.value?.branches ?? [] : []).map((b) => ({ ...b, label: b.default ? `${b.name} (default)` : b.name })));

// A new repository starts on its default branch; a branch that no longer exists is dropped.
watch([data, ready], () => {
  if (!ready.value) model.value = null;
  else if (data.value && !data.value.branches.some((b) => b.name === model.value)) model.value = data.value.defaultBranch ?? data.value.branches[0]?.name ?? null;
}, { immediate: true });
</script>

<template>
  <div class="flex flex-col gap-1">
    <label for="branch-select" class="text-sm font-medium">Branch</label>
    <Select
      v-model="model"
      input-id="branch-select"
      :options="options"
      option-label="label"
      option-value="name"
      :disabled="!ready || isFetching"
      :loading="isFetching"
      filter
      :placeholder="ready ? 'Choose a branch' : 'Enter the repository first'"
      fluid
    />
    <small v-if="ready && error" class="text-red-500">{{ error.message }}</small>
  </div>
</template>
