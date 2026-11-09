<script setup lang="ts">
import type { Project } from "~/types";

/** Create a project, or (with `project`) rename and re-describe one. */
const props = defineProps<{ project?: Project }>();
const visible = defineModel<boolean>("visible", { required: true });
const save = useSaveProject();

const name = ref("");
const description = ref("");
const valid = computed(() => name.value.trim() !== "");

watch(visible, (v) => {
  if (!v) return;
  name.value = props.project?.name ?? "";
  description.value = props.project?.description ?? "";
  save.reset();
});

async function submit() {
  const ok = await save.mutateAsync({ id: props.project?.id, name: name.value.trim(), description: description.value.trim() }).then(() => true, () => false);
  if (ok) visible.value = false;
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="project ? `Edit ${project.name}` : 'New project'" :style="{ width: '30rem' }" :closable="!save.isPending.value">
    <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="valid && submit()">
      <div class="flex flex-col gap-1">
        <label for="project-name" class="text-sm font-medium">Name</label>
        <InputText id="project-name" v-model="name" maxlength="60" placeholder="Storefront" autofocus />
      </div>
      <div class="flex flex-col gap-1">
        <label for="project-desc" class="text-sm font-medium">Description <span class="text-muted-color font-normal">(optional)</span></label>
        <InputText id="project-desc" v-model="description" maxlength="300" placeholder="Web, API and workers for the shop" />
      </div>
      <p class="text-sm text-muted-color">A project only groups apps. It changes nothing about how they run, so apps can be moved in and out at any time.</p>
      <Message v-if="save.error.value" severity="error" size="small">{{ save.error.value.message }}</Message>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <Button label="Cancel" severity="secondary" text @click="visible = false" />
      <Button :label="project ? 'Save' : 'Create project'" :disabled="!valid" :loading="save.isPending.value" @click="submit" />
    </template>
  </Dialog>
</template>
