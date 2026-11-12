<script setup lang="ts">
import type { AppRow } from "~/types";
import { emptyForm, fromSettings, newService, toSettings, type ServiceForm } from "~/utils/settings";
import { IDENT_RE } from "~/utils/validation";
import { IMAGE_RE } from "~/utils/settings";

/** Adds a service to the app, or (with `service`) edits one. Either way the app's configuration is saved and the app redeployed. */
const props = defineProps<{ app: AppRow; service?: string }>();
const visible = defineModel<boolean>("visible", { required: true });
const appName = computed(() => props.app.name);
const { data: config, error: configError, isPending: configPending } = useAppSettings(appName);
const save = useSaveConfig(appName);

const allImages = () => !!props.app.images && Object.keys(props.app.images).length === props.app.services.length && props.app.services.length > 0;
const blank = (): ServiceForm => newService("", allImages() ? "image" : "command");
const service = ref<ServiceForm>(blank());
const editing = computed(() => props.service !== undefined);
const confirm = useConfirm();
const pristine = ref(JSON.stringify(service.value));

watch(visible, (v) => {
  if (!v) return;
  load();
});
watch(() => config.value?.text, () => visible.value && load());
function load() {
  const found = props.service === undefined ? undefined : current.value?.services.find((x) => x.name === props.service);
  service.value = found ? structuredClone(toRaw(found)) : blank();
  pristine.value = JSON.stringify(service.value);
}

/** The app as the form sees it now, to complete references against and to add the new service to. */
const current = computed(() => (config.value ? (config.value.settings ? fromSettings(config.value.settings) : { ...emptyForm(), services: [] }) : null));
/** Whether the app is running, so adding a service releases it. */
function remove() {
  confirm.require({
    header: `Remove ${props.service}?`,
    message: "The service stops and its configuration is deleted. Its volumes are kept.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Remove",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: async () => {
      const form = structuredClone(toRaw(current.value!));
      form.services = form.services.filter((x) => x.name !== props.service);
      await save.mutateAsync(toSettings(form)).then(() => (visible.value = false)).catch(() => {});
    },
  });
}
const deployed = computed(() => !!props.app.currentRelease);
const names = computed(() => [...(current.value?.services.map((s) => s.name.trim()) ?? []), service.value.name.trim()].filter(Boolean));
const volumes = computed(() => [...new Set([...(current.value?.remoteVolumes ?? []), ...(current.value?.services.flatMap((s) => s.volumes) ?? []), ...service.value.volumes].map((v) => v.name.trim()).filter(Boolean))]);

const s = computed(() => service.value);
const taken = computed(() => !editing.value && (props.app.services.some((x) => x.name === s.value.name) || (current.value?.services.some((x) => x.name === s.value.name) ?? false)));
const nameError = computed(() => (s.value.name && !IDENT_RE.test(s.value.name) ? "Lowercase letters, digits and single hyphens, starting with a letter." : taken.value ? "This app already has a service with that name." : ""));
const imageBad = computed(() => s.value.kind === "image" && s.value.image.trim() !== "" && !IMAGE_RE.test(s.value.image.trim()));
const valid = computed(() => !!current.value && IDENT_RE.test(s.value.name) && !taken.value && !imageBad.value && (s.value.kind === "command" ? s.value.command.trim() !== "" : s.value.image.trim() !== ""));

const disabledReason = computed(() => {
  if (valid.value) return undefined;
  if (configPending.value) return "Loading the app's configuration";
  if (!current.value) return "The app's configuration could not be loaded";
  if (!s.value.name) return "Name the service";
  if (nameError.value) return nameError.value;
  if (imageBad.value) return "Not a valid image reference";
  return s.value.kind === "command" ? "Enter a start command" : "Enter an image";
});

const { request } = useDiscardGuard(visible, () => JSON.stringify(service.value) !== pristine.value);

async function submit() {
  const form = structuredClone(toRaw(current.value!));
  if (editing.value) form.services = form.services.map((x) => (x.name === props.service ? service.value : x));
  else form.services.push(service.value);
  await save.mutateAsync(toSettings(form)).then(() => (visible.value = false)).catch(() => {});
}
</script>

<template>
  <Dialog :visible="visible" modal :header="editing ? `Edit ${props.service}` : 'Add service'" :style="{ width: '44rem' }" :closable="!save.isPending.value" @update:visible="request">
    <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="valid && submit()">
      <Message v-if="configError" severity="error" size="small" :closable="false">Could not load the app's configuration: {{ configError.message }}</Message>
      <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
      <ServiceFields v-model="service" id="svc" :lock-name="editing" :app-name="app.name" :own-services="names" :own-volumes="volumes" />
      <button type="submit" class="hidden" />
    </form>
    <template #footer>
      <Button v-if="editing && (current?.services.length ?? 0) > 1" label="Remove" icon="pi pi-trash" severity="danger" text :disabled="save.isPending.value" @click="remove" />
      <small v-if="disabledReason" class="ml-auto text-muted-color">{{ disabledReason }}</small>
      <Button label="Cancel" severity="secondary" text :disabled="save.isPending.value" @click="request()" />
      <Button :label="(editing ? 'Save' : 'Add') + (deployed ? ' and deploy' : editing ? '' : ' service')" :icon="editing ? 'pi pi-save' : 'pi pi-plus'" :disabled="!valid" :loading="save.isPending.value" @click="submit" />
    </template>
  </Dialog>
</template>
