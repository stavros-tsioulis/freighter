<script setup lang="ts">
import { IDENT_RE } from "~/utils/validation";

const props = defineProps<{ app?: string }>();
const visible = defineModel<boolean>("visible", { required: true });
const emit = defineEmits<{ back: [] }>();
const notify = useNotify();
const { data: servers } = useServers();
const { data: apps } = useApps();
const server = ref("");
/** An app that already exists is pinned to its server. */
const pinned = computed(() => (props.app ? apps.value?.find((a) => a.name === props.app) : apps.value?.find((a) => a.name === name.value))?.server ?? null);
const choices = computed(() => (servers.value ?? []).filter((s) => s.kind === "local" || s.status !== "pending").map((s) => ({ label: `${s.name}${s.status === "offline" ? " (offline)" : ""}`, value: s.name })));
const showServer = computed(() => choices.value.length > 1);
/** Preselect the first server (this machine's, when it runs apps), and move off one that is no longer offered. */
const first = computed(() => choices.value[0]?.value ?? "");
watch(first, () => { if (!choices.value.some((c) => c.value === server.value)) server.value = first.value; }, { immediate: true });


const name = ref(props.app ?? "");
const file = ref<File | null>(null);
const progress = ref(0);
const uploading = ref(false);
const deploymentId = ref<string | null>(null);
const finished = ref<"success" | "failed" | null>(null);

const nameError = computed(() => (name.value && !IDENT_RE.test(name.value) ? "Lowercase letters, digits and single hyphens" : ""));
const canSubmit = computed(() => !!file.value && (!!pinned.value || choices.value.length > 0) && IDENT_RE.test(name.value) && !uploading.value && !deploymentId.value);

function reset() {
  file.value = null;
  progress.value = 0;
  uploading.value = false;
  deploymentId.value = null;
  finished.value = null;
  name.value = props.app ?? "";
  server.value = first.value;
}
watch(visible, (v) => v && reset());

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}

async function submit() {
  if (!file.value) return;
  uploading.value = true;
  try {
    const { id } = await uploadArtifact(name.value, file.value, (f) => (progress.value = f), pinned.value ? undefined : server.value || undefined);
    deploymentId.value = id;
  } catch (e) {
    notify.fail("Upload failed", e);
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="app ? `Deploy ${app} from an archive` : 'Deploy an archive'" :style="{ width: '32rem' }" :closable="!uploading">
    <div class="flex flex-col gap-4">
      <Message v-if="!pinned && !choices.length" severity="warn" :closable="false">
        This control server runs no apps of its own, and no server is enrolled yet. <NuxtLink to="/servers" class="underline" @click="visible = false">Add a server</NuxtLink> first.
      </Message>
      <div v-if="!app" class="flex flex-col gap-1">
        <label for="deploy-name" class="text-sm font-medium">App name</label>
        <InputText id="deploy-name" v-model="name" placeholder="shop" :invalid="!!nameError" />
        <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
        <small v-else class="text-muted-color">Must match <code>name:</code> in the archive's <code>app.yaml</code>.</small>
      </div>
      <div v-if="showServer" class="flex flex-col gap-1">
        <label for="deploy-server" class="text-sm font-medium">Server</label>
        <Select v-if="!pinned" id="deploy-server" v-model="server" :options="choices" option-label="label" option-value="value" />
        <div v-else class="text-sm"><Tag :value="pinned" severity="secondary" icon="pi pi-server" /> <span class="text-muted-color">The app already runs here.</span></div>
      </div>
      <div class="flex flex-col gap-1">
        <label for="deploy-file" class="text-sm font-medium">Archive</label>
        <input id="deploy-file" type="file" accept=".gz,.tgz,application/gzip" class="text-sm" :disabled="uploading || !!deploymentId" @change="onFile" />
        <small class="text-muted-color">A <code>.tar.gz</code> with <code>app.yaml</code> at its root.</small>
      </div>
      <ProgressBar v-if="uploading" :value="Math.round(progress * 100)" />
      <DeploymentStatus v-if="deploymentId" :id="deploymentId" @finished="finished = $event" />
    </div>
    <template #footer>
      <Button v-if="!app && !deploymentId" label="Back" icon="pi pi-arrow-left" severity="secondary" text class="mr-auto" :disabled="uploading" @click="emit('back')" />
      <Button :label="deploymentId ? 'Close' : 'Cancel'" severity="secondary" text :disabled="uploading" @click="visible = false" />
      <Button v-if="!deploymentId" label="Upload and deploy" :disabled="!canSubmit" :loading="uploading" @click="submit" />
    </template>
  </Dialog>
</template>
