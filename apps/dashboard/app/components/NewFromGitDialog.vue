<script setup lang="ts">
import { IDENT_RE, validateRepoUrl } from "~/utils/validation";
import { emptyForm, hasService, toSettings } from "~/utils/settings";

const visible = defineModel<boolean>("visible", { required: true });
const { data: servers } = useServers();
const notify = useNotify();
const deploy = useDeployFromGit();

const sshKeyId = ref<string | null>(null);
const repository = ref("");
const branch = ref<string | null>(null);
const server = ref("");
const result = ref<{ app: string; deploymentId: string; webhookSecret: string; webhookUrl: string } | null>(null);
const showSetup = ref(false);
// Only used when the repository has no app.yaml.
const appName = ref("");
const form = ref(emptyForm());

const repoError = computed(() => (repository.value ? validateRepoUrl(repository.value) : ""));
const urlOk = computed(() => repository.value.trim() !== "" && !repoError.value);
const choices = computed(() => (servers.value ?? []).filter((s) => s.kind === "local" || s.status !== "pending").map((s) => ({ label: s.name, value: s.name })));
const first = computed(() => choices.value[0]?.value ?? "");
watch(first, () => { if (!choices.value.some((c) => c.value === server.value)) server.value = first.value; }, { immediate: true });
const inspect = useInspect(repository, branch, sshKeyId, () => urlOk.value, server);
const info = computed(() => (urlOk.value && branch.value ? inspect.data.value : undefined));
const manual = computed(() => info.value?.hasManifest === false);
const nameError = computed(() => (appName.value && !IDENT_RE.test(appName.value) ? "Lowercase letters, digits and single hyphens, starting with a letter." : ""));
const ready = computed(
  () =>
    urlOk.value && !!branch.value && !deploy.isPending.value && choices.value.length > 0 &&
    (info.value?.valid === true || (manual.value && IDENT_RE.test(appName.value) && hasService(form.value))),
);

watch(visible, (v) => {
  if (!v) return;
  sshKeyId.value = null;
  repository.value = "";
  branch.value = null;
  server.value = first.value;
  result.value = null;
  showSetup.value = false;
  appName.value = "";
  form.value = emptyForm();
  deploy.reset();
});

async function start() {
  try {
    const r = await deploy.mutateAsync({ repository: repository.value.trim(), branch: branch.value!, sshKeyId: sshKeyId.value, server: server.value, ...(manual.value ? { appName: appName.value, settings: toSettings(form.value) } : {}) });
    result.value = { app: r.app, deploymentId: r.deployment.id, webhookSecret: r.webhookSecret, webhookUrl: r.link.webhookUrl };
  } catch (e) {
    notify.fail("Could not start the deployment", e);
  }
}
async function openApp() {
  visible.value = false;
  await navigateTo(`/apps/${result.value!.app}`);
}
</script>

<template>
  <Dialog v-model:visible="visible" modal header="Deploy from Git" :style="{ width: manual ? '48rem' : '40rem' }" :closable="!deploy.isPending.value">
    <div v-if="!result" class="flex flex-col gap-4">
      <Message v-if="!choices.length" severity="warn" :closable="false">
        This control server runs no apps of its own, and no server is enrolled yet. <NuxtLink to="/servers" class="underline" @click="visible = false">Add a server</NuxtLink> first.
      </Message>
      <SshKeySelect v-model="sshKeyId" />
      <div class="flex flex-col gap-1">
        <label for="ng-repo" class="text-sm font-medium">Repository</label>
        <InputText id="ng-repo" v-model="repository" placeholder="git@github.com:acme/shop.git" :invalid="!!repoError" autocomplete="off" fluid />
        <small v-if="repoError" class="text-red-500">{{ repoError }}</small>
      </div>
      <BranchSelect v-model="branch" :repository="repository" :ssh-key-id="sshKeyId" :server="server" />

      <div v-if="choices.length > 1" class="flex flex-col gap-1">
        <label for="ng-server" class="text-sm font-medium">Server</label>
        <Select id="ng-server" v-model="server" :options="choices" option-label="label" option-value="value" fluid />
      </div>

      <div v-if="urlOk && branch" aria-live="polite">
        <Skeleton v-if="inspect.isFetching.value && !info" height="1.5rem" />
        <Message v-else-if="info?.valid" severity="success" size="small">
          Will deploy as <b>{{ info.appName }}</b> from <code>{{ info.sha.slice(0, 7) }}</code> “{{ info.commit.subject }}”{{ info.buildCommands.length ? `, building with ${info.buildCommands.length} command${info.buildCommands.length === 1 ? "" : "s"}` : "" }}.
        </Message>
        <Message v-else-if="manual" severity="info" size="small">
          No <code>app.yaml</code> at <code>{{ info?.sha.slice(0, 7) }}</code>. Describe the app below instead; if you add an <code>app.yaml</code> later, the file takes over.
        </Message>
        <Message v-else-if="info" severity="warn" size="small">{{ info.error }}</Message>
        <Message v-else-if="inspect.error.value" severity="error" size="small">{{ inspect.error.value.message }}</Message>
      </div>

      <template v-if="manual">
        <div class="flex flex-col gap-1">
          <label for="ng-name" class="text-sm font-medium">App name</label>
          <InputText id="ng-name" v-model="appName" placeholder="shop" :invalid="!!nameError" autocomplete="off" />
          <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
        </div>
        <ManifestForm v-model="form" :app-name="IDENT_RE.test(appName) ? appName : ''" />
      </template>
    </div>

    <div v-else class="flex flex-col gap-3">
      <DeploymentStatus :id="result.deploymentId" />
      <div class="border-t border-[var(--fr-line)] pt-3 flex flex-col gap-2">
        <p class="text-sm font-medium">Webhook (deploy on push)</p>
        <div class="grid grid-cols-[5rem_1fr] gap-2 text-sm">
          <span class="text-muted-color">URL</span><code class="break-all">{{ result.webhookUrl }}</code>
          <span class="text-muted-color">Secret</span><code class="break-all">{{ result.webhookSecret }}</code>
        </div>
        <small class="text-muted-color">The secret is shown once. Content type application/json, push events.</small>
      </div>
    </div>

    <template #footer>
      <template v-if="!result">
        <Button label="Cancel" severity="secondary" text @click="visible = false" />
        <Button label="Deploy" icon="pi pi-cloud-upload" :disabled="!ready" :loading="deploy.isPending.value" @click="start" />
      </template>
      <Button v-else label="Open app" icon="pi pi-arrow-right" @click="openApp" />
    </template>
  </Dialog>
</template>
