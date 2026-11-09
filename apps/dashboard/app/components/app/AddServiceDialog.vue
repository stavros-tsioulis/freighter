<script setup lang="ts">
import type { AppRow } from "~/types";
import { fromSettings, newService, toSettings } from "~/utils/settings";
import { IDENT_RE } from "~/utils/validation";
import { IMAGE_RE } from "~/utils/settings";

const props = defineProps<{ app: AppRow }>();
const visible = defineModel<boolean>("visible", { required: true });
const appName = computed(() => props.app.name);
const { data: config } = useAppSettings(appName);
const save = useSaveConfig(appName);

const name = ref("");
const kind = ref<"command" | "image">("command");
const command = ref("");
const image = ref("");
const containerPort = ref<number | null>(null);
const port = ref<number | null>(null);
const kinds = [{ label: "Command", value: "command" }, { label: "Container image", value: "image" }];

watch(visible, (v) => {
  if (!v) return;
  name.value = "";
  kind.value = props.app.images && Object.keys(props.app.images).length === props.app.services.length && props.app.services.length > 0 ? "image" : "command";
  command.value = image.value = "";
  containerPort.value = port.value = null;
});

const taken = computed(() => props.app.services.some((s) => s.name === name.value) || name.value in (config.value?.settings?.services ?? {}));
const nameError = computed(() => (name.value && !IDENT_RE.test(name.value) ? "Lowercase letters, digits and single hyphens, starting with a letter." : taken.value ? "This app already has a service with that name." : ""));
const imageError = computed(() => (image.value.trim() && !IMAGE_RE.test(image.value.trim()) ? "Not a valid image reference, e.g. ghcr.io/acme/shop:1.4" : ""));
const valid = computed(() => !!config.value?.settings && IDENT_RE.test(name.value) && !taken.value && (kind.value === "command" ? command.value.trim() !== "" : image.value.trim() !== "" && !imageError.value));

async function submit() {
  const form = fromSettings(config.value!.settings);
  form.services.push({ ...newService(name.value, kind.value), command: command.value, image: image.value, containerPort: containerPort.value, port: port.value });
  await save.mutateAsync(toSettings(form)).then(() => (visible.value = false)).catch(() => {});
}
</script>

<template>
  <Dialog v-model:visible="visible" modal header="Add service" :style="{ width: '32rem' }" :closable="!save.isPending.value">
    <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="valid && submit()">
      <div class="flex flex-col gap-1">
        <label for="as-name" class="text-sm font-medium">Name</label>
        <InputText id="as-name" v-model="name" placeholder="worker" :invalid="!!nameError" autocomplete="off" />
        <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
      </div>
      <div class="flex flex-col gap-1">
        <span id="as-kind" class="text-sm font-medium">Runs</span>
        <SelectButton v-model="kind" :options="kinds" option-label="label" option-value="value" :allow-empty="false" size="small" aria-labelledby="as-kind" />
      </div>
      <div v-if="kind === 'command'" class="flex flex-col gap-1">
        <label for="as-cmd" class="text-sm font-medium">Start command</label>
        <InputText id="as-cmd" v-model="command" placeholder="node worker.js" class="font-mono" autocomplete="off" />
      </div>
      <template v-else>
        <div class="flex flex-col gap-1">
          <label for="as-img" class="text-sm font-medium">Image</label>
          <InputText id="as-img" v-model="image" placeholder="ghcr.io/acme/shop:1.4" class="font-mono" spellcheck="false" :invalid="!!imageError" autocomplete="off" />
          <small v-if="imageError" class="text-red-500">{{ imageError }}</small>
        </div>
        <div class="flex flex-col gap-1">
          <label for="as-cport" class="text-sm font-medium">Container port</label>
          <InputNumber input-id="as-cport" v-model="containerPort" :min="1" :max="65535" :use-grouping="false" placeholder="from the image" fluid />
        </div>
      </template>
      <div class="flex flex-col gap-1">
        <label for="as-port" class="text-sm font-medium">Port</label>
        <InputNumber input-id="as-port" v-model="port" :min="1" :max="65535" :use-grouping="false" placeholder="none" fluid />
      </div>
      <button type="submit" class="hidden" />
    </form>
    <template #footer>
      <Button label="Cancel" severity="secondary" text :disabled="save.isPending.value" @click="visible = false" />
      <Button label="Add and redeploy" icon="pi pi-plus" :disabled="!valid" :loading="save.isPending.value" @click="submit" />
    </template>
  </Dialog>
</template>
