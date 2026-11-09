<script setup lang="ts">
import { IDENT_RE } from "~/utils/validation";
import { emptyForm, hasService, imageHost, IMAGE_RE, newService, toSettings, type SettingsForm } from "~/utils/settings";

const visible = defineModel<boolean>("visible", { required: true });
const emit = defineEmits<{ back: [] }>();
const { data: servers } = useServers();
const { data: apps } = useApps();
const { can } = useSession();
const { data: registries } = useRegistries(() => can('deployer'));
const notify = useNotify();
const deploy = useDeployImages();

const blank = (): SettingsForm => ({ ...emptyForm(), services: [newService("web", "image")] });
const name = ref("");
const server = ref("");
const form = ref<SettingsForm>(blank());
const loginFor = ref<string | null>(null);
const loginOpen = computed({ get: () => loginFor.value !== null, set: (v: boolean) => { if (!v) loginFor.value = null; } });
const deploymentId = ref<string | null>(null);
const finished = ref<"success" | "failed" | null>(null);

/** An app that already exists is pinned to its server. */
const pinned = computed(() => apps.value?.find((a) => a.name === name.value)?.server ?? null);
const choices = computed(() => (servers.value ?? []).filter((s) => s.kind === "local" || s.status !== "pending").map((s) => ({ label: `${s.name}${s.status === "offline" ? " (offline)" : ""}`, value: s.name })));
const first = computed(() => choices.value[0]?.value ?? "");
watch(first, () => { if (!choices.value.some((c) => c.value === server.value)) server.value = first.value; }, { immediate: true });
const target = computed(() => servers.value?.find((s) => s.name === (pinned.value ?? server.value)));

const nameError = computed(() => (name.value && !IDENT_RE.test(name.value) ? "Lowercase letters, digits and single hyphens, starting with a letter." : ""));
const images = computed(() => form.value.services.filter((s) => s.kind === "image" && s.image.trim()).map((s) => s.image.trim()));
const imagesValid = computed(() => form.value.services.every((s) => !s.image.trim() || IMAGE_RE.test(s.image.trim())));
const hosts = computed(() => [...new Set(images.value.map(imageHost))]);
/** Per registry the images come from: the logins saved for it, and (when there are several) the one picked for this app. */
const loginsOf = (host: string) => (registries.value ?? []).filter((r) => r.host === host).map((r) => r.username);
const chosen = ref<Record<string, string>>({});
const needsChoice = computed(() => hosts.value.filter((h) => loginsOf(h).length > 1 && !chosen.value[h]));
const chosenLogins = computed(() => Object.fromEntries(hosts.value.flatMap((h) => (chosen.value[h] && loginsOf(h).includes(chosen.value[h]!) ? [[h, chosen.value[h]!]] : []))));
const podmanProblem = computed(() => {
  const h = target.value?.host;
  if (!h || target.value?.status === "offline") return "";
  if (!h.containers) return `${target.value!.name}'s agent predates images. Upgrade it from the Servers page first.`;
  return h.containers.available ? "" : `Podman is not installed on ${target.value!.name}. Re-run its installer with --with-containers.`;
});

const ready = computed(
  () => IDENT_RE.test(name.value) && hasService(form.value) && imagesValid.value && !needsChoice.value.length && choices.value.length > 0 && !podmanProblem.value && !deploy.isPending.value && !deploymentId.value,
);

watch(visible, (v) => {
  if (!v) return;
  name.value = "";
  server.value = first.value;
  form.value = blank();
  chosen.value = {};
  deploymentId.value = null;
  finished.value = null;
  deploy.reset();
});

async function start() {
  try {
    const r = await deploy.mutateAsync({ name: name.value, settings: toSettings(form.value), server: pinned.value ? undefined : server.value || undefined, logins: chosenLogins.value });
    deploymentId.value = r.id;
  } catch (e) {
    notify.fail("Could not start the deployment", e);
  }
}
/** Back to the form with everything still filled in, e.g. after adding a registry login for a failed pull. */
function tryAgain() {
  deploymentId.value = null;
  finished.value = null;
  deploy.reset();
}
async function openApp() {
  visible.value = false;
  await navigateTo(`/apps/${name.value}`);
}
</script>

<template>
  <Dialog v-model:visible="visible" modal header="Deploy an image" :style="{ width: '44rem' }" :closable="!deploy.isPending.value">
    <div v-if="!deploymentId" class="flex flex-col gap-4">
      <Message v-if="!choices.length" severity="warn" :closable="false">
        This control server runs no apps of its own, and no server is enrolled yet. <NuxtLink to="/servers" class="underline" @click="visible = false">Add a server</NuxtLink> first.
      </Message>
      <div class="grid sm:grid-cols-2 gap-3">
        <div class="flex flex-col gap-1">
          <label for="img-name" class="text-sm font-medium">App name</label>
          <InputText id="img-name" v-model="name" placeholder="shop" :invalid="!!nameError" autocomplete="off" />
          <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
          <small v-else-if="pinned" class="text-muted-color">This app exists; deploying replaces its services.</small>
        </div>
        <div v-if="choices.length > 1" class="flex flex-col gap-1">
          <label for="img-server" class="text-sm font-medium">Server</label>
          <Select v-if="!pinned" id="img-server" v-model="server" :options="choices" option-label="label" option-value="value" />
          <div v-else class="text-sm pt-2"><Tag :value="pinned" severity="secondary" icon="pi pi-server" /> <span class="text-muted-color">The app already runs here.</span></div>
        </div>
      </div>
      <Message v-if="podmanProblem" severity="warn" size="small" :closable="false">{{ podmanProblem }}</Message>

      <ManifestForm v-model="form" :app-name="IDENT_RE.test(name) ? name : ''" hide-build images-only />

      <div v-if="hosts.length" class="flex flex-col gap-2 rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] px-4 py-3" aria-label="Registry logins">
        <div v-for="h in hosts" :key="h" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <code>{{ h }}</code>
          <template v-if="loginsOf(h).length > 1">
            <label :for="`login-${h}`" class="text-muted-color">Pull with</label>
            <Select :input-id="`login-${h}`" v-model="chosen[h]" :options="loginsOf(h)" placeholder="Choose a login" size="small" class="w-48" :invalid="!chosen[h]" />
          </template>
          <template v-else-if="loginsOf(h).length === 1"><Tag :value="`login saved: ${loginsOf(h)[0]}`" severity="success" /><span class="text-muted-color">Used for the pull.</span></template>
          <span v-else class="text-muted-color">{{ can('admin') ? "No login: fine for public images." : "No login: public images only. Private ones need an admin to add a login." }}</span>
          <Button v-if="can('admin')" :label="loginsOf(h).length ? 'Add another login' : 'Add login for a private image'" icon="pi pi-key" size="small" text class="ml-auto" @click="loginFor = h" />
        </div>
      </div>
    </div>
    <DeploymentStatus v-else :id="deploymentId" @finished="finished = $event" />

    <RegistryLoginDialog v-model:visible="loginOpen" :host="loginFor ?? undefined" />

    <template #footer>
      <template v-if="!deploymentId">
        <Button label="Back" icon="pi pi-arrow-left" severity="secondary" text class="mr-auto" :disabled="deploy.isPending.value" @click="emit('back')" />
        <Button label="Cancel" severity="secondary" text @click="visible = false" />
        <Button label="Pull and deploy" icon="pi pi-cloud-download" :disabled="!ready" :loading="deploy.isPending.value" @click="start" />
      </template>
      <template v-else>
        <Button label="Close" severity="secondary" text @click="visible = false" />
        <Button v-if="finished === 'failed'" label="Back to the form" icon="pi pi-arrow-left" severity="secondary" @click="tryAgain" />
        <Button label="Open app" icon="pi pi-arrow-right" :disabled="finished === 'failed'" @click="openApp" />
      </template>
    </template>
  </Dialog>
</template>
