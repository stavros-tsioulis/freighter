<script setup lang="ts">
import type { AppRow } from "~/types";
import { emptyForm, fromSettings, hasService, toSettings } from "~/utils/settings";

/** The app's configuration. It started from app.yaml; from the first deploy on, this is where it changes. */
const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const { data: config, isLoading, error } = useAppSettings(appName);
const save = useSaveConfig(appName);
const { data: link } = useGitLink(appName);
const gitDeploy = useGitAction(appName).deploy;
const notify = useNotify();

const form = ref(emptyForm());
const dirty = ref(false);
watch(() => config.value?.text, () => { form.value = fromSettings(config.value?.settings); dirty.value = false; }, { immediate: true });
watch(form, () => { dirty.value = true; }, { deep: true });
const reset = () => { form.value = fromSettings(config.value?.settings); dirty.value = false; };
// Build commands run when the code is fetched from Git, not when the configuration is saved: saving redeploys the
// release that is running, as it was built. So a change to them takes effect with the next Git deploy.
const buildChanged = computed(() => JSON.stringify(toSettings(form.value).build ?? null) !== JSON.stringify(toSettings(fromSettings(config.value?.settings)).build ?? null));
const rebuild = ref(true);
async function submit() {
  const rebuilding = buildChanged.value && !!link.value && rebuild.value;
  const saved = await save.mutateAsync(toSettings(form.value)).then(() => true, () => false);
  if (!saved) return;
  dirty.value = false;
  // Queued behind the save on the same server, so it builds with the new commands.
  if (rebuilding) await gitDeploy.mutateAsync().then(() => notify.started(props.app.name)).catch(() => {});
}
</script>

<template>
  <div class="flex flex-col gap-4 max-w-3xl">
    <Skeleton v-if="isLoading" height="12rem" />
    <Message v-else-if="error" severity="error">{{ error.message }}</Message>
    <template v-else>
      <AppVolumesPanel :app="app" />
      <ManifestForm v-model="form" :app-name="app.name" :disabled="!can('admin')" hide-services />
      <Message v-if="buildChanged && !link" severity="info" size="small" :closable="false">Build commands only run for Git deployments. Saving redeploys the release that is running, as it was built.</Message>
      <label v-else-if="buildChanged && link && can('admin')" class="flex items-center gap-2 text-sm">
        <Checkbox v-model="rebuild" binary input-id="st-rebuild" />
        <span>Build again from Git after saving. Saving alone redeploys the release that is running, as it was built.</span>
      </label>
      <div v-if="can('admin')" class="flex gap-2">
        <Button :label="buildChanged && link && rebuild ? 'Save and rebuild' : 'Save and redeploy'" icon="pi pi-save" :disabled="!dirty || !hasService(form)" :loading="save.isPending.value || gitDeploy.isPending.value" @click="submit" />
        <Button label="Discard" severity="secondary" text :disabled="!dirty || save.isPending.value" @click="reset" />
      </div>
    </template>
  </div>
</template>
