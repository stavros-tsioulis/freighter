<script setup lang="ts">
import { newService, toSettings, type SettingsForm } from "~/utils/settings";
import type { AppSettings } from "~/types";

/**
 * The options of app.yaml as a form. Used when a repository has no app.yaml (an app.yaml in the repository always
 * wins). The API renders and validates the result, so the preview below is exactly what would be deployed.
 */
const props = defineProps<{ appName: string; disabled?: boolean }>();
const form = defineModel<SettingsForm>({ required: true });
const emit = defineEmits<{ settings: [AppSettings] }>();

// Settle for a moment after typing before asking the API to render.
const settled = ref<AppSettings>(toSettings(form.value));
let timer: ReturnType<typeof setTimeout> | undefined;
watch(form, (f) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    settled.value = toSettings(f);
    emit("settings", settled.value);
  }, 400);
}, { deep: true, immediate: true });
onBeforeUnmount(() => clearTimeout(timer));

const preview = useManifestPreview(() => props.appName, settled, () => !!props.appName && Object.keys(settled.value.services).length > 0);
const restarts = ["on-failure", "always", "no"];

function removeService(i: number) {
  form.value.services.splice(i, 1);
}
const addService = () => form.value.services.push(newService(form.value.services.length ? "" : "web"));
</script>

<template>
  <div class="flex flex-col gap-5" :class="{ 'pointer-events-none opacity-60': disabled }">
    <!-- services -->
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h3 class="font-medium">Services</h3>
        <Button label="Add service" icon="pi pi-plus" size="small" severity="secondary" text @click="addService" />
      </div>
      <Panel v-for="(s, i) in form.services" :key="i" :header="s.name || 'New service'" toggleable>
        <template #icons>
          <Button v-if="form.services.length > 1" icon="pi pi-trash" size="small" severity="danger" text rounded aria-label="Remove service" @click="removeService(i)" />
        </template>
        <div class="grid sm:grid-cols-[10rem_1fr] gap-3">
          <div class="flex flex-col gap-1"><label :for="`svc-name-${i}`" class="text-sm font-medium">Name</label><InputText :id="`svc-name-${i}`" v-model="s.name" placeholder="web" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`svc-cmd-${i}`" class="text-sm font-medium">Start command</label><InputText :id="`svc-cmd-${i}`" v-model="s.command" placeholder="node server.js" autocomplete="off" class="font-mono" /></div>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
          <div class="flex flex-col gap-1"><label :for="`svc-port-${i}`" class="text-sm font-medium">Port</label><InputNumber :input-id="`svc-port-${i}`" v-model="s.port" :min="1" :max="65535" :use-grouping="false" placeholder="none" fluid /></div>
          <div class="flex flex-col gap-1"><label :for="`svc-rep-${i}`" class="text-sm font-medium">Replicas</label><InputNumber :input-id="`svc-rep-${i}`" v-model="s.replicas" :min="1" :max="64" fluid /></div>
          <div class="flex flex-col gap-1"><label :for="`svc-mem-${i}`" class="text-sm font-medium">Memory limit</label><InputText :id="`svc-mem-${i}`" v-model="s.memory" placeholder="512M" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`svc-cpu-${i}`" class="text-sm font-medium">CPU limit</label><InputNumber :input-id="`svc-cpu-${i}`" v-model="s.cpu" :min="0.1" :max="64" :min-fraction-digits="0" :max-fraction-digits="2" placeholder="none" fluid /></div>
        </div>
        <div class="grid sm:grid-cols-3 gap-3 mt-3">
          <div class="flex flex-col gap-1"><label :for="`svc-hc-${i}`" class="text-sm font-medium">Health check path</label><InputText :id="`svc-hc-${i}`" v-model="s.healthPath" placeholder="/up" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`svc-hct-${i}`" class="text-sm font-medium">Healthy within</label><InputText :id="`svc-hct-${i}`" v-model="s.healthTimeout" placeholder="30s" autocomplete="off" :disabled="!s.healthPath" /></div>
          <div class="flex flex-col gap-1"><label :for="`svc-rs-${i}`" class="text-sm font-medium">Restart</label><Select :input-id="`svc-rs-${i}`" v-model="s.restart" :options="restarts" fluid /></div>
        </div>
      </Panel>
    </section>

    <!-- environment + secrets -->
    <section class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <h3 class="font-medium">Environment</h3>
        <Button label="Add variable" icon="pi pi-plus" size="small" severity="secondary" text @click="form.env.push({ key: '', value: '' })" />
      </div>
      <div v-for="(e, i) in form.env" :key="i" class="grid grid-cols-[14rem_1fr_auto] gap-2 items-center">
        <InputText v-model="e.key" placeholder="NODE_ENV" autocomplete="off" class="font-mono" :aria-label="`Variable ${i + 1} name`" />
        <InputText v-model="e.value" placeholder="production" autocomplete="off" class="font-mono" :aria-label="`Variable ${i + 1} value`" />
        <Button icon="pi pi-trash" severity="danger" text rounded aria-label="Remove variable" @click="form.env.splice(i, 1)" />
      </div>
      <div class="flex flex-col gap-1 mt-1">
        <label for="mf-secrets" class="text-sm font-medium">Secret names <span class="text-muted-color font-normal">(set their values on the Secrets tab)</span></label>
        <Textarea id="mf-secrets" v-model="form.secrets" rows="2" auto-resize placeholder="DATABASE_URL" class="font-mono" />
      </div>
    </section>

    <!-- build -->
    <section class="flex flex-col gap-2">
      <h3 class="font-medium">Build <span class="text-muted-color font-normal text-sm">(optional)</span></h3>
      <div class="flex flex-col gap-1">
        <label for="mf-build" class="text-sm font-medium">Commands, one per line</label>
        <Textarea id="mf-build" v-model="form.buildCommands" rows="3" auto-resize placeholder="npm ci&#10;npm run build" class="font-mono" />
      </div>
      <div v-if="form.buildCommands.trim()" class="grid grid-cols-3 gap-3">
        <div class="flex flex-col gap-1"><label for="mf-bt" class="text-sm font-medium">Time limit</label><InputText id="mf-bt" v-model="form.buildTimeout" placeholder="15m" autocomplete="off" /></div>
        <div class="flex flex-col gap-1"><label for="mf-bm" class="text-sm font-medium">Memory limit</label><InputText id="mf-bm" v-model="form.buildMemory" placeholder="2G" autocomplete="off" /></div>
        <div class="flex flex-col gap-1"><label for="mf-bc" class="text-sm font-medium">CPUs</label><InputNumber input-id="mf-bc" v-model="form.buildCpu" :min="0.1" :max="64" :max-fraction-digits="2" placeholder="2" fluid /></div>
      </div>
    </section>

    <section class="flex items-center gap-3">
      <label for="mf-keep" class="text-sm font-medium">Releases to keep</label>
      <InputNumber input-id="mf-keep" v-model="form.keep" :min="2" :max="50" show-buttons class="w-32" />
    </section>

    <!-- what this adds up to -->
    <section class="flex flex-col gap-2" aria-live="polite">
      <h3 class="font-medium">Equivalent <code>app.yaml</code></h3>
      <Message v-if="preview.error.value" severity="warn" size="small">{{ preview.error.value.message }}</Message>
      <pre v-if="preview.data.value && !preview.error.value" class="well !break-normal overflow-auto max-h-72">{{ preview.data.value.text }}</pre>
      <p v-else-if="!preview.error.value" class="text-sm text-muted-color">Add a service with a start command.</p>
    </section>
  </div>
</template>
