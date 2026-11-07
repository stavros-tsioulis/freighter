<script setup lang="ts">
const props = withDefaults(defineProps<{ allowGenerated?: boolean; label?: string }>(), { allowGenerated: false, label: "SSH key" });
const model = defineModel<string | null>({ required: true });
const { can } = useSession();
const { data: keys, isLoading } = useSshKeys(() => can("admin"));

const NONE = "__none__";
const options = computed(() => [
  { value: NONE, label: props.allowGenerated ? "Generated deploy key for this app" : "None — public repository over HTTPS" },
  ...(keys.value ?? []).map((k) => ({ value: k.id, label: `${k.name} (${k.keyType}, ${k.fingerprint.slice(0, 18)}…)` })),
]);
const value = computed({ get: () => model.value ?? NONE, set: (v: string) => (model.value = v === NONE ? null : v) });
</script>

<template>
  <div class="flex flex-col gap-1">
    <label for="ssh-key-select" class="text-sm font-medium">{{ label }}</label>
    <Select v-model="value" input-id="ssh-key-select" :options="options" option-label="label" option-value="value" :loading="isLoading" fluid />
    <small v-if="!isLoading && !(keys?.length)" class="text-muted-color">
      No keys yet. <NuxtLink to="/settings/ssh-keys" class="underline">Add one</NuxtLink> for private repositories.
    </small>
  </div>
</template>
