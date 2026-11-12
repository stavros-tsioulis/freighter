<script setup lang="ts">
import { newRemoteVolume, newService, toSettings, volumeChoices, type SettingsForm } from "~/utils/settings";
import type { AppSettings } from "~/types";

/**
 * The options of app.yaml as a form. Used when a repository has no app.yaml (an app.yaml in the repository always
 * wins). The API renders and validates the result, so the preview below is exactly what would be deployed.
 */
const props = defineProps<{ appName: string; disabled?: boolean; /** Leave out the build section (images are built elsewhere). */ hideBuild?: boolean; /** Leave out the services (they are edited on the app's Services tab). */ hideServices?: boolean; /** Every service runs an image (the image deploy form): no choice of kind, and new services are images. */ imagesOnly?: boolean }>();
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

const previewQuery = useManifestPreview(() => props.appName, settled, () => !!props.appName && Object.keys(settled.value.services).length > 0);
const previewText = computed(() => previewQuery.data.value?.text ?? "");
const previewError = computed(() => previewQuery.error.value?.message ?? "");

function removeService(i: number) {
  form.value.services.splice(i, 1);
}
const addService = () => form.value.services.push(newService(form.value.services.length ? "" : "web", props.imagesOnly ? "image" : "command"));
</script>

<template>
  <div class="flex flex-col gap-5" :class="{ 'pointer-events-none opacity-60': disabled }">
    <!-- services -->
    <section v-if="!hideServices" class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h3 class="font-medium">Services</h3>
        <Button label="Add service" icon="pi pi-plus" size="small" severity="secondary" text @click="addService" />
      </div>
      <Panel v-for="(s, i) in form.services" :key="i" :header="s.name || 'New service'" toggleable>
        <template #icons>
          <Button v-if="form.services.length > 1" icon="pi pi-trash" size="small" severity="danger" text rounded aria-label="Remove service" @click="removeService(i)" />
        </template>
        <ServiceFields
          :model-value="s"
          :id="String(i)"
          :app-name="appName"
          :own-services="form.services.map((x) => x.name.trim())"
          :own-volumes="[...new Set([...form.remoteVolumes, ...form.services.flatMap((x) => x.volumes)].map((x) => x.name.trim()).filter(Boolean))]"
          :volume-choices="volumeChoices(form, i)"
          :images-only="imagesOnly"
        />
      </Panel>
    </section>

    <!-- the app's environment -->
    <section class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <h3 class="font-medium">Environment <span class="text-muted-color font-normal text-sm">(every service, at run time)</span></h3>
        <Button label="Add variable" icon="pi pi-plus" size="small" severity="secondary" text @click="form.env.push({ key: '', value: '' })" />
      </div>
      <p v-if="!form.env.length" class="text-sm text-muted-color">Values every service gets. A value set on the service itself wins. Build-time values are in the Build section.</p>
      <div v-for="(e, j) in form.env" :key="j" class="grid grid-cols-[14rem_1fr_auto] gap-2 items-center">
        <InputText v-model="e.key" placeholder="TZ" autocomplete="off" class="font-mono" :aria-label="`App variable ${j + 1} name`" />
        <ReferenceInput v-model="e.value" :app="appName" :own-services="form.services.map((x) => x.name.trim())" :own-volumes="[...new Set([...form.remoteVolumes, ...form.services.flatMap((x) => x.volumes)].map((x) => x.name.trim()).filter(Boolean))]" placeholder="UTC" :aria-label="`App variable ${j + 1} value`" />
        <Button icon="pi pi-trash" severity="danger" text rounded aria-label="Remove variable" @click="form.env.splice(j, 1)" />
      </div>
    </section>

    <!-- remote volumes -->
    <section class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <h3 class="font-medium">Remote volumes <span class="text-muted-color font-normal text-sm">(SMB, NFS)</span></h3>
        <Button label="Add remote volume" icon="pi pi-plus" size="small" severity="secondary" text @click="form.remoteVolumes.push(newRemoteVolume())" />
      </div>
      <div v-for="(v, i) in form.remoteVolumes" :key="i" class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] p-3 flex flex-col gap-3">
        <div class="grid sm:grid-cols-[10rem_8rem_1fr_auto] gap-2 items-end">
          <div class="flex flex-col gap-1"><label :for="`rv-name-${i}`" class="text-sm font-medium">Name</label><InputText :id="`rv-name-${i}`" v-model="v.name" placeholder="media" class="font-mono" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`rv-type-${i}`" class="text-sm font-medium">Type</label><Select :input-id="`rv-type-${i}`" v-model="v.type" :options="['smb', 'nfs']" fluid /></div>
          <div class="flex flex-col gap-1"><label :for="`rv-host-${i}`" class="text-sm font-medium">Host</label><InputText :id="`rv-host-${i}`" v-model="v.host" placeholder="nas.local" autocomplete="off" /></div>
          <Button icon="pi pi-trash" severity="danger" text rounded aria-label="Remove remote volume" @click="form.remoteVolumes.splice(i, 1)" />
        </div>
        <div v-if="v.type === 'smb'" class="grid sm:grid-cols-4 gap-2">
          <div class="flex flex-col gap-1"><label :for="`rv-share-${i}`" class="text-sm font-medium">Share</label><InputText :id="`rv-share-${i}`" v-model="v.share" placeholder="media" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`rv-path-${i}`" class="text-sm font-medium">Folder in the share</label><InputText :id="`rv-path-${i}`" v-model="v.path" placeholder="optional" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`rv-user-${i}`" class="text-sm font-medium">User</label><InputText :id="`rv-user-${i}`" v-model="v.user" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`rv-domain-${i}`" class="text-sm font-medium">Domain</label><InputText :id="`rv-domain-${i}`" v-model="v.domain" placeholder="optional" autocomplete="off" /></div>
        </div>
        <div v-else class="grid sm:grid-cols-[1fr_8rem] gap-2">
          <div class="flex flex-col gap-1"><label :for="`rv-export-${i}`" class="text-sm font-medium">Export</label><InputText :id="`rv-export-${i}`" v-model="v.export" placeholder="/exports/media" class="font-mono" autocomplete="off" /></div>
          <div class="flex flex-col gap-1"><label :for="`rv-ver-${i}`" class="text-sm font-medium">Version</label><Select :input-id="`rv-ver-${i}`" v-model="v.version" :options="['3', '4', '4.1', '4.2']" fluid /></div>
        </div>
      </div>
    </section>

    <!-- build -->
    <section v-if="!hideBuild" class="flex flex-col gap-2">
      <h3 class="font-medium">Build <span class="text-muted-color font-normal text-sm">(optional)</span></h3>
      <div class="flex flex-col gap-1">
        <label for="mf-build" class="text-sm font-medium">Commands, one per line</label>
        <Textarea id="mf-build" v-model="form.buildCommands" rows="3" auto-resize placeholder="npm ci&#10;npm run build" class="font-mono" />
      </div>
      <div v-if="form.buildCommands.trim()" class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">Build environment <span class="text-muted-color font-normal">(only the build sees these; no secrets. <code>@service.url</code> works)</span></span>
          <Button label="Add variable" icon="pi pi-plus" size="small" severity="secondary" text @click="form.buildEnv.push({ key: '', value: '' })" />
        </div>
        <div v-for="(row, k) in form.buildEnv" :key="k" class="grid grid-cols-[14rem_1fr_auto] gap-2 items-center">
          <InputText v-model="row.key" placeholder="PUBLIC_API_URL" autocomplete="off" class="font-mono" :aria-label="`Build variable ${k + 1} name`" />
          <ReferenceInput v-model="row.value" :app="appName" :own-services="form.services.map((x) => x.name.trim())" public-only placeholder="@api.url" :aria-label="`Build variable ${k + 1} value`" />
          <Button icon="pi pi-trash" severity="danger" text rounded aria-label="Remove build variable" @click="form.buildEnv.splice(k, 1)" />
        </div>
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
      <Message v-if="previewError" severity="warn" size="small">{{ previewError }}</Message>
      <pre v-if="previewText && !previewError" class="well !break-normal overflow-auto max-h-72">{{ previewText }}</pre>
      <p v-else-if="!previewError" class="text-sm text-muted-color">Add a service with a start command or an image.</p>
    </section>
  </div>
</template>
