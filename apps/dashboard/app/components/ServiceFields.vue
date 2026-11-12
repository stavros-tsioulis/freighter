<script setup lang="ts">
import { isImage, type ServiceForm } from "~/utils/settings";

/** The fields of one service: what it runs, port, limits, health check, volumes, environment and secrets. */
defineProps<{
  /** Keeps element ids unique when several services are on screen. */
  id: string;
  appName: string;
  /** Every service of the app (for `@service` completion) and every volume it can see. */
  ownServices: string[];
  ownVolumes: string[];
  /** Volumes this service could pick by name (see `volumeChoices`). */
  volumeChoices?: { name: string; detail: string }[];
  /** Every service runs an image: no choice of kind. */
  imagesOnly?: boolean;
  /** An existing service keeps its name. */
  lockName?: boolean;
}>();
const s = defineModel<ServiceForm>({ required: true });
const restarts = ["on-failure", "always", "no"];
const kinds = [{ label: "Command", value: "command" }, { label: "Container image", value: "image" }];
const imageError = (ref: string) => (ref.trim() && !isImage(ref) ? "Not a valid image reference, e.g. ghcr.io/acme/shop:1.4" : "");
</script>

<template>
  <div>
  <div class="grid gap-3" :class="imagesOnly ? 'sm:grid-cols-[10rem]' : 'sm:grid-cols-[10rem_1fr]'">
    <div class="flex flex-col gap-1"><label :for="`svc-name-${id}`" class="text-sm font-medium">Name</label><InputText :id="`svc-name-${id}`" v-model="s.name" placeholder="web" autocomplete="off" :disabled="lockName" /></div>
    <div v-if="!imagesOnly" class="flex flex-col gap-1">
      <span :id="`svc-kind-l-${id}`" class="text-sm font-medium">Runs</span>
      <SelectButton v-model="s.kind" :options="kinds" option-label="label" option-value="value" :allow-empty="false" size="small" :aria-labelledby="`svc-kind-l-${id}`" />
    </div>
  </div>
  <div v-if="s.kind === 'command'" class="flex flex-col gap-1 mt-3"><label :for="`svc-cmd-${id}`" class="text-sm font-medium">Start command</label><InputText :id="`svc-cmd-${id}`" v-model="s.command" placeholder="node server.js" autocomplete="off" class="font-mono" /></div>
  <template v-else>
    <div class="grid sm:grid-cols-[1fr_10rem] gap-3 mt-3">
      <div class="flex flex-col gap-1">
        <label :for="`svc-img-${id}`" class="text-sm font-medium">Image</label>
        <InputText :id="`svc-img-${id}`" v-model="s.image" placeholder="ghcr.io/acme/shop:1.4" autocomplete="off" spellcheck="false" class="font-mono" :invalid="!!imageError(s.image)" />
        <small v-if="imageError(s.image)" class="text-red-500">{{ imageError(s.image) }}</small>
      </div>
      <div class="flex flex-col gap-1"><label :for="`svc-cport-${id}`" class="text-sm font-medium">Container port</label><InputNumber :input-id="`svc-cport-${id}`" v-model="s.containerPort" :min="1" :max="65535" :use-grouping="false" placeholder="from the image" fluid /></div>
    </div>
  </template>
  <div class="flex flex-col gap-2 mt-3">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium">Volumes <span class="text-muted-color font-normal">(kept across releases)</span></span>
      <Button label="Add volume" icon="pi pi-plus" size="small" severity="secondary" text @click="s.volumes.push({ name: '', path: '' })" />
    </div>
    <div v-for="(v, j) in s.volumes" :key="j" class="grid grid-cols-[10rem_1fr_auto] gap-2 items-center">
      <SuggestInput v-model="v.name" :choices="(volumeChoices ?? []).map((c) => ({ value: c.name, detail: c.detail }))" placeholder="uploads" :aria-label="`Volume ${j + 1} name`" />
      <InputText v-model="v.path" :placeholder="s.kind === 'image' ? '/var/uploads' : '/data/uploads'" autocomplete="off" class="font-mono" :aria-label="`Volume ${j + 1} path ${s.kind === 'image' ? 'in the container' : 'the service sees'}`" />
      <Button icon="pi pi-trash" severity="danger" text rounded aria-label="Remove volume" @click="s.volumes.splice(j, 1)" />
    </div>
  </div>
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
    <div class="flex flex-col gap-1"><label :for="`svc-port-${id}`" class="text-sm font-medium">Port</label><InputNumber :input-id="`svc-port-${id}`" v-model="s.port" :min="1" :max="65535" :use-grouping="false" placeholder="none" fluid /></div>
    <div class="flex flex-col gap-1"><label :for="`svc-rep-${id}`" class="text-sm font-medium">Replicas</label><InputNumber :input-id="`svc-rep-${id}`" v-model="s.replicas" :min="1" :max="64" fluid /></div>
    <div class="flex flex-col gap-1"><label :for="`svc-mem-${id}`" class="text-sm font-medium">Memory limit</label><InputText :id="`svc-mem-${id}`" v-model="s.memory" placeholder="512M" autocomplete="off" /></div>
    <div class="flex flex-col gap-1"><label :for="`svc-cpu-${id}`" class="text-sm font-medium">CPU limit</label><InputNumber :input-id="`svc-cpu-${id}`" v-model="s.cpu" :min="0.1" :max="64" :min-fraction-digits="0" :max-fraction-digits="2" placeholder="none" fluid /></div>
  </div>
  <div class="grid sm:grid-cols-3 gap-3 mt-3">
    <div class="flex flex-col gap-1"><label :for="`svc-hc-${id}`" class="text-sm font-medium">Health check path</label><InputText :id="`svc-hc-${id}`" v-model="s.healthPath" placeholder="/up" autocomplete="off" /></div>
    <div class="flex flex-col gap-1"><label :for="`svc-hct-${id}`" class="text-sm font-medium">Healthy within</label><InputText :id="`svc-hct-${id}`" v-model="s.healthTimeout" placeholder="30s" autocomplete="off" :disabled="!s.healthPath" /></div>
    <div class="flex flex-col gap-1"><label :for="`svc-rs-${id}`" class="text-sm font-medium">Restart</label><Select :input-id="`svc-rs-${id}`" v-model="s.restart" :options="restarts" fluid /></div>
  </div>
  <div class="flex flex-col gap-2 mt-3">
    <div class="flex items-center justify-between">
      <span class="text-sm font-medium">Environment</span>
      <Button label="Add variable" icon="pi pi-plus" size="small" severity="secondary" text @click="s.env.push({ key: '', value: '' })" />
    </div>
    <div v-for="(e, j) in s.env" :key="j" class="grid grid-cols-[14rem_1fr_auto] gap-2 items-center">
      <InputText v-model="e.key" placeholder="NODE_ENV" autocomplete="off" class="font-mono" :aria-label="`Variable ${j + 1} name`" />
      <ReferenceInput v-model="e.value" :app="appName" :own-services="ownServices" :own-volumes="ownVolumes" placeholder="production" :aria-label="`Variable ${j + 1} value`" />
      <Button icon="pi pi-trash" severity="danger" text rounded aria-label="Remove variable" @click="s.env.splice(j, 1)" />
    </div>
    <div class="flex flex-col gap-1">
      <label :for="`svc-secrets-${id}`" class="text-sm font-medium">Secret names</label>
      <Textarea :id="`svc-secrets-${id}`" v-model="s.secrets" rows="1" auto-resize placeholder="DATABASE_URL" class="font-mono" />
    </div>
  </div>
  </div>
</template>
