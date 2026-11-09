<script setup lang="ts">
import type { AppRow } from "~/types";
import { timeAgo } from "~/utils/format";
import { validateRepoUrl } from "~/utils/validation";
import { emptyForm, fromSettings, hasService, toSettings } from "~/utils/settings";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const hasImages = computed(() => Object.keys(props.app.images ?? {}).length > 0);
const { data: link, isLoading } = useGitLink(appName);
const save = useSaveGitLink(appName);
const patch = usePatchGitLink(appName);
const actions = useGitAction(appName);
const confirm = useConfirm();

// ---- linked: change branch / key in place ----
const branch = computed({
  get: () => link.value?.branch ?? null,
  set: (b) => {
    if (b && b !== link.value?.branch) patch.mutate({ branch: b });
  },
});
const linkedKey = computed({
  get: () => link.value?.sshKeyId ?? null,
  set: (k) => {
    if (k !== (link.value?.sshKeyId ?? null)) patch.mutate({ sshKeyId: k });
  },
});

// ---- not linked: link the app to a repository ----
const sshKeyId = ref<string | null>(null);
const repository = ref("");
const newBranch = ref<string | null>(null);
const provider = ref<"github" | "gitlab" | "other">("github");
const subpath = ref("");
const autoDeploy = ref(true);
const providers = [{ label: "GitHub", value: "github" }, { label: "GitLab", value: "gitlab" }, { label: "Other", value: "other" }];
const repoError = computed(() => (repository.value ? validateRepoUrl(repository.value) : ""));
const urlOk = computed(() => repository.value.trim() !== "" && !repoError.value);
const newInspect = useInspect(repository, newBranch, sshKeyId, () => urlOk.value, () => props.app.server, subpath);
const newInfo = computed(() => (urlOk.value && newBranch.value ? newInspect.data.value : undefined));
const newForm = ref(emptyForm());
const manualNew = computed(() => newInfo.value?.hasManifest === false);
const valid = computed(() => urlOk.value && !!newBranch.value && (!manualNew.value || hasService(newForm.value)));

// ---- linked: settings used while the repository has no app.yaml ----
const linkInspect = useInspect(() => link.value?.repository ?? "", () => link.value?.branch ?? null, () => link.value?.sshKeyId ?? null, () => !!link.value, () => props.app.server, () => link.value?.subpath ?? "");
const hasFile = computed(() => linkInspect.data.value?.hasManifest === true);
const settingsForm = ref(emptyForm());
const dirty = ref(false);
watch(() => link.value?.settings, (s) => { settingsForm.value = fromSettings(s); dirty.value = false; }, { immediate: true });
watch(settingsForm, () => { dirty.value = true; }, { deep: true });
async function saveSettings() {
  await patch.mutateAsync({ settings: toSettings(settingsForm.value) }).then(() => { dirty.value = false; }).catch(() => {});
}
async function clearSettings() {
  await patch.mutateAsync({ settings: null }).catch(() => {});
}

const secret = ref<string | undefined>();
const showSetup = ref(false);
const deployedId = ref<string | null>(null);
const showDeployment = ref(false);

async function linkRepo() {
  const r = await save.mutateAsync({ repository: repository.value.trim(), branch: newBranch.value!, provider: provider.value, subpath: subpath.value.trim(), autoDeploy: autoDeploy.value, sshKeyId: sshKeyId.value, server: props.app.server, ...(manualNew.value ? { settings: toSettings(newForm.value) } : {}) }).catch(() => null);
  if (r) {
    secret.value = r.webhookSecret;
    showSetup.value = true;
  }
}
async function rotateSecret() {
  const r = await actions.rotateSecret.mutateAsync().catch(() => null);
  if (r) {
    secret.value = r.webhookSecret;
    showSetup.value = true;
  }
}
async function deployLatest() {
  const r = await actions.deploy.mutateAsync().catch(() => null);
  if (r) {
    deployedId.value = r.id;
    showDeployment.value = true;
  }
}
function ask(header: string, message: string, label: string, run: () => void) {
  confirm.require({
    header, message, icon: "pi pi-exclamation-triangle", acceptLabel: label,
    acceptProps: { severity: "danger" }, rejectProps: { severity: "secondary", text: true, label: "Cancel" }, accept: run,
  });
}
</script>

<template>
  <!-- an app that runs container images: its source is the image, not an archive or a repository -->
  <AppImageSource v-if="hasImages" :app="app" />

  <Skeleton v-if="isLoading && !hasImages" height="10rem" />

  <!-- not linked (and not an image app, which has nothing to link) -->
  <div v-else-if="!link && !hasImages" class="flex flex-col gap-4 max-w-2xl">
    <Message v-if="!can('admin')" severity="info">Deployed from uploaded artifacts. An admin can link a Git repository.</Message>
    <p v-if="can('admin')" class="text-sm text-muted-color">This app is deployed from uploaded archives. Link a repository to build and deploy it from Git instead.</p>
    <form v-if="can('admin')" class="grid gap-3" @submit.prevent="valid && linkRepo()">
      <SshKeySelect v-model="sshKeyId" allow-generated />
      <div class="flex flex-col gap-1">
        <label for="git-repo" class="text-sm font-medium">Repository (SSH or HTTPS)</label>
        <InputText id="git-repo" v-model="repository" placeholder="git@github.com:acme/shop.git" :invalid="!!repoError" autocomplete="off" />
        <small v-if="repoError" class="text-red-500">{{ repoError }}</small>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <BranchSelect v-model="newBranch" :repository="repository" :ssh-key-id="sshKeyId" :server="app.server" />
        <div class="flex flex-col gap-1"><label for="git-sub" class="text-sm font-medium">Subdirectory <span class="text-muted-color font-normal">(monorepos)</span></label><InputText id="git-sub" v-model="subpath" placeholder="apps/web" autocomplete="off" /></div>
      </div>
      <div class="flex flex-wrap items-center gap-6">
        <SelectButton v-model="provider" :options="providers" option-label="label" option-value="value" :allow-empty="false" aria-label="Webhook format" />
        <span class="flex items-center gap-2"><ToggleSwitch v-model="autoDeploy" input-id="git-auto" /><label for="git-auto" class="text-sm">Deploy on push</label></span>
      </div>
      <template v-if="newBranch && urlOk">
        <Message v-if="manualNew" severity="info" size="small">No <code>app.yaml</code> in this repository. Describe the app below.</Message>
        <Message v-else-if="newInfo?.valid && newInfo.appName !== app.name" severity="warn" size="small">The repository’s <code>app.yaml</code> is for “{{ newInfo.appName }}”, not “{{ app.name }}”.</Message>
        <Message v-else-if="newInfo?.valid" severity="success" size="small">Using <code>app.yaml</code> from the repository.</Message>
        <Message v-else-if="newInfo" severity="warn" size="small">{{ newInfo.error }}</Message>
        <ManifestForm v-if="manualNew" v-model="newForm" :app-name="app.name" />
      </template>
      <div><Button type="submit" label="Link repository" icon="pi pi-link" :disabled="!valid" :loading="save.isPending.value" /></div>
    </form>
  </div>

  <!-- linked -->
  <div v-else-if="link" class="flex flex-col gap-4" :class="{ 'mt-8 border-t border-[var(--fr-line)] pt-6': hasImages }">
    <div class="grid grid-cols-[9rem_1fr] gap-y-3 text-sm items-center max-w-3xl">
      <span class="text-muted-color">Repository</span><code class="break-all">{{ link.repository }}</code>
      <span class="text-muted-color">Branch</span>
      <div v-if="can('admin')" class="max-w-xs"><BranchSelect v-model="branch" :repository="link.repository" :ssh-key-id="link.sshKeyId" :server="app.server" /></div>
      <span v-else><code>{{ link.branch }}</code></span>
      <template v-if="link.subpath"><span class="text-muted-color">Subdirectory</span><code>{{ link.subpath }}</code></template>
      <span class="text-muted-color">SSH key</span>
      <div v-if="can('admin')" class="max-w-md"><SshKeySelect v-model="linkedKey" allow-generated label="" /></div>
      <span v-else>{{ link.sshKey?.name ?? "generated deploy key" }}</span>
      <span class="text-muted-color">Webhook format</span><span><Tag :value="link.provider" severity="secondary" /></span>
      <span class="text-muted-color">Auto-deploy</span>
      <span class="flex items-center gap-2">
        <ToggleSwitch :model-value="link.autoDeploy" :disabled="!can('admin') || patch.isPending.value" input-id="auto-toggle" @update:model-value="patch.mutate({ autoDeploy: $event })" />
        <label for="auto-toggle">{{ link.autoDeploy ? "deploys on every push to the branch" : "off — use “Deploy latest”" }}</label>
      </span>
      <span class="text-muted-color">Last webhook</span>
      <span><template v-if="link.lastDeliveryAt">{{ link.lastDeliveryResult }}, {{ timeAgo(link.lastDeliveryAt) }}</template><span v-else class="text-muted-color">none received yet</span></span>
    </div>
    <div class="flex flex-wrap gap-2">
      <Button v-if="can('deployer')" label="Deploy latest" icon="pi pi-cloud-upload" :loading="actions.deploy.isPending.value" @click="deployLatest" />
      <Button v-if="can('deployer')" label="Test connection" icon="pi pi-bolt" severity="secondary" outlined :loading="actions.check.isPending.value" @click="actions.check.mutate()" />
      <Button label="Setup instructions" icon="pi pi-book" severity="secondary" text @click="secret = undefined; showSetup = true" />
      <template v-if="can('admin')">
        <Button label="Rotate secret" icon="pi pi-refresh" severity="secondary" text :loading="actions.rotateSecret.isPending.value" @click="rotateSecret" />
        <Button v-if="!link.sshKeyId" label="Rotate key" icon="pi pi-key" severity="secondary" text @click="ask('Rotate the deploy key?', 'A new key is created. Replace the old one under Deploy keys in your git host, or builds will fail to fetch.', 'Rotate', () => actions.rotateKey.mutate())" />
        <Button label="Unlink" icon="pi pi-trash" severity="danger" text @click="ask('Unlink the repository?', 'Pushes stop deploying this app. Existing releases keep running.', 'Unlink', () => actions.unlink.mutate())" />
      </template>
    </div>

    <section class="flex flex-col gap-3 max-w-3xl border-t border-[var(--fr-line)] pt-4">
      <div>
        <h3 class="font-medium">Settings without an app.yaml</h3>
        <p class="text-sm text-muted-color">
          <template v-if="hasFile">The repository’s <code>app.yaml</code> is in use; these settings are ignored.</template>
          <template v-else>Used because the repository has no <code>app.yaml</code>.</template>
        </p>
      </div>
      <ManifestForm v-model="settingsForm" :app-name="app.name" :disabled="!can('admin')" />
      <div v-if="can('admin')" class="flex gap-2">
        <Button label="Save settings" icon="pi pi-save" :disabled="!dirty || !hasService(settingsForm)" :loading="patch.isPending.value" @click="saveSettings" />
        <Button v-if="link.settings" label="Clear" severity="secondary" text :disabled="patch.isPending.value" @click="clearSettings" />
      </div>
    </section>
  </div>

  <Dialog v-model:visible="showSetup" modal header="Connect the repository" :style="{ width: '44rem' }">
    <GitSetupPanel v-if="link" :link="link" :webhook-secret="secret" />
    <template #footer><Button label="Done" @click="showSetup = false" /></template>
  </Dialog>

  <Dialog v-model:visible="showDeployment" modal header="Deploying from Git" :style="{ width: '44rem' }">
    <DeploymentStatus :id="deployedId" />
    <template #footer><Button label="Close" severity="secondary" text @click="showDeployment = false" /></template>
  </Dialog>
</template>
