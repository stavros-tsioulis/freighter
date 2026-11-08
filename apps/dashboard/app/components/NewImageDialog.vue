<script setup lang="ts">
import { IDENT_RE } from "~/utils/validation";
import { emptyForm, hasService, imageHost, IMAGE_RE, newService, toSettings, type SettingsForm } from "~/utils/settings";

const visible = defineModel<boolean>("visible", { required: true });
const { data: servers } = useServers();
const { data: apps } = useApps();
const { can } = useSession();
const { data: registries } = useRegistries(() => can('admin'));
const notify = useNotify();
const deploy = useDeployImages();

const blank = (): SettingsForm => ({ ...emptyForm(), services: [newService("web", "image")] });
const name = ref("");
const server = ref("");
const form = ref<SettingsForm>(blank());
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
const imagesValid = computed(() => form.value.services.every((s) => s.kind === "image" && (!s.image.trim() || IMAGE_RE.test(s.image.trim()))));
const mixed = computed(() => form.value.services.some((s) => s.kind === "command"));
const hosts = computed(() => [...new Set(images.value.map(imageHost))]);
const withLogin = computed(() => hosts.value.filter((h) => registries.value?.some((r) => r.host === h)));
/** Only admins can see which logins exist; for others the hint stays general. */
const knowsLogins = computed(() => can('admin'));
const podmanProblem = computed(() => {
  const h = target.value?.host;
  if (!h || target.value?.status === "offline") return "";
  if (!h.containers) return `${target.value!.name}'s agent predates images. Upgrade it from the Servers page first.`;
  return h.containers.available ? "" : `Podman is not installed on ${target.value!.name}. Re-run its installer with --with-containers.`;
});

const ready = computed(
  () => IDENT_RE.test(name.value) && hasService(form.value) && imagesValid.value && !mixed.value && choices.value.length > 0 && !podmanProblem.value && !deploy.isPending.value && !deploymentId.value,
);

watch(visible, (v) => {
  if (!v) return;
  name.value = "";
  server.value = first.value;
  form.value = blank();
  deploymentId.value = null;
  finished.value = null;
  deploy.reset();
});

async function start() {
  try {
    const r = await deploy.mutateAsync({ name: name.value, settings: toSettings(form.value), server: pinned.value ? undefined : server.value || undefined });
    deploymentId.value = r.id;
  } catch (e) {
    notify.fail("Could not start the deployment", e);
  }
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

      <ManifestForm v-model="form" :app-name="IDENT_RE.test(name) ? name : ''" hide-build />

      <Message v-if="mixed" severity="warn" size="small" :closable="false">Every service must run an image here. To mix in a command service, upload an archive instead.</Message>
      <Message v-if="hosts.length && !knowsLogins" severity="secondary" size="small" :closable="false">Pulling from {{ hosts.join(", ") }}. Private images need a registry login, which an admin can add.</Message>
      <Message v-else-if="hosts.length" severity="secondary" size="small" :closable="false">
        <template v-if="withLogin.length === hosts.length">Pulling with the saved login for {{ hosts.join(", ") }}.</template>
        <template v-else>
          Pulling from {{ hosts.join(", ") }} without a login{{ withLogin.length ? ` (saved for ${withLogin.join(", ")})` : "" }}. That works for public images.
          <NuxtLink to="/settings/registries" class="underline" @click="visible = false">Add a registry login</NuxtLink> for private ones.
        </template>
      </Message>
    </div>
    <DeploymentStatus v-else :id="deploymentId" @finished="finished = $event" />

    <template #footer>
      <template v-if="!deploymentId">
        <Button label="Cancel" severity="secondary" text @click="visible = false" />
        <Button label="Pull and deploy" icon="pi pi-cloud-download" :disabled="!ready" :loading="deploy.isPending.value" @click="start" />
      </template>
      <template v-else>
        <Button label="Close" severity="secondary" text @click="visible = false" />
        <Button label="Open app" icon="pi pi-arrow-right" :disabled="finished === 'failed'" @click="openApp" />
      </template>
    </template>
  </Dialog>
</template>
