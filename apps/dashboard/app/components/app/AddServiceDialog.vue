<script setup lang="ts">
import type { AppRow } from "~/types";
import { fromSettings, newService, toSettings, type ServiceForm } from "~/utils/settings";
import { IDENT_RE } from "~/utils/validation";
import { IMAGE_RE } from "~/utils/settings";

const props = defineProps<{ app: AppRow }>();
const visible = defineModel<boolean>("visible", { required: true });
const appName = computed(() => props.app.name);
const { data: config } = useAppSettings(appName);
const save = useSaveConfig(appName);

const allImages = () => !!props.app.images && Object.keys(props.app.images).length === props.app.services.length && props.app.services.length > 0;
const blank = (): ServiceForm => newService("", allImages() ? "image" : "command");
const service = ref<ServiceForm>(blank());
const pristine = ref(JSON.stringify(service.value));

watch(visible, (v) => {
  if (!v) return;
  service.value = blank();
  pristine.value = JSON.stringify(service.value);
});

/** The app as the form sees it now, to complete references against and to add the new service to. */
const current = computed(() => (config.value?.settings ? fromSettings(config.value.settings) : null));
const names = computed(() => [...(current.value?.services.map((s) => s.name.trim()) ?? []), service.value.name.trim()].filter(Boolean));
const volumes = computed(() => [...new Set([...(current.value?.remoteVolumes ?? []), ...(current.value?.services.flatMap((s) => s.volumes) ?? []), ...service.value.volumes].map((v) => v.name.trim()).filter(Boolean))]);

const s = computed(() => service.value);
const taken = computed(() => props.app.services.some((x) => x.name === s.value.name) || (current.value?.services.some((x) => x.name === s.value.name) ?? false));
const nameError = computed(() => (s.value.name && !IDENT_RE.test(s.value.name) ? "Lowercase letters, digits and single hyphens, starting with a letter." : taken.value ? "This app already has a service with that name." : ""));
const imageBad = computed(() => s.value.kind === "image" && s.value.image.trim() !== "" && !IMAGE_RE.test(s.value.image.trim()));
const valid = computed(() => !!current.value && IDENT_RE.test(s.value.name) && !taken.value && !imageBad.value && (s.value.kind === "command" ? s.value.command.trim() !== "" : s.value.image.trim() !== ""));

const { request } = useDiscardGuard(visible, () => JSON.stringify(service.value) !== pristine.value);

async function submit() {
  const form = fromSettings(config.value!.settings);
  form.services.push(service.value);
  await save.mutateAsync(toSettings(form)).then(() => (visible.value = false)).catch(() => {});
}
</script>

<template>
  <Dialog :visible="visible" modal header="Add service" :style="{ width: '44rem' }" :closable="!save.isPending.value" @update:visible="request">
    <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="valid && submit()">
      <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
      <ServiceFields v-model="service" id="add" :app-name="app.name" :own-services="names" :own-volumes="volumes" />
      <button type="submit" class="hidden" />
    </form>
    <template #footer>
      <Button label="Cancel" severity="secondary" text :disabled="save.isPending.value" @click="request()" />
      <Button label="Add and redeploy" icon="pi pi-plus" :disabled="!valid" :loading="save.isPending.value" @click="submit" />
    </template>
  </Dialog>
</template>
