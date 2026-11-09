<script setup lang="ts">
import type { AppRow } from "~/types";
import { emptyForm, fromSettings, hasService, toSettings } from "~/utils/settings";

/** The app's configuration. It started from app.yaml; from the first deploy on, this is where it changes. */
const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const { data: config, isLoading, error } = useAppSettings(appName);
const save = useSaveConfig(appName);

const form = ref(emptyForm());
const dirty = ref(false);
watch(() => config.value?.text, () => { form.value = fromSettings(config.value?.settings); dirty.value = false; }, { immediate: true });
watch(form, () => { dirty.value = true; }, { deep: true });
const reset = () => { form.value = fromSettings(config.value?.settings); dirty.value = false; };
async function submit() {
  await save.mutateAsync(toSettings(form.value)).then(() => { dirty.value = false; }).catch(() => {});
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-3xl">
    <Skeleton v-if="isLoading" height="12rem" />
    <Message v-else-if="error" severity="error">{{ error.message }}</Message>
    <template v-else>
      <ManifestForm v-model="form" :app-name="app.name" :disabled="!can('admin')" />
      <div v-if="can('admin')" class="flex gap-2">
        <Button label="Save and redeploy" icon="pi pi-save" :disabled="!dirty || !hasService(form)" :loading="save.isPending.value" @click="submit" />
        <Button label="Discard" severity="secondary" text :disabled="!dirty || save.isPending.value" @click="reset" />
      </div>
    </template>
  </div>
</template>
