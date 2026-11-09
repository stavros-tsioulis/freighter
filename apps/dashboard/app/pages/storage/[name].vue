<script setup lang="ts">
import type { StorageBackend, StorageSecrets } from "~/types";
import { backendProblem, describeBackend, endpointOf, usageSnippet } from "~/utils/storage";
import { timeAgo } from "~/utils/format";

const route = useRoute();
const router = useRouter();
const { can } = useSession();
const notify = useNotify();
const confirm = useConfirm();
const name = computed(() => String(route.params.name));
const { data: storage, isLoading, error } = useStorage(name);
useHead({ title: computed(() => `${name.value} - Storage - Freighter`) });

// The app that serves the storage carries its domains, logs and deployments.
const appName = computed(() => storage.value?.app ?? "");
const { data: app } = useApp(appName);

const TABS = ["overview", "domains", "logs", "deployments", "settings"] as const;
const tab = computed({
  get: () => (TABS.includes(route.query.tab as never) ? String(route.query.tab) : "overview"),
  set: (t: string) => void router.replace({ query: { ...route.query, tab: t === "overview" ? undefined : t } }),
});

const apply = useApplyStorage(name);
const rotate = useRotateStorageKeys(name);
const patch = usePatchStorage(name);
const del = useDeleteStorage();

const last = computed(() => storage.value?.deployments[0]);
const failed = computed(() => last.value?.status === "failed");
const endpoint = computed(() => (storage.value ? endpointOf(storage.value) : null));

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok(`${what} copied`);
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}

// ---- keys ----
const keys = ref<{ accessKey: string; secretKey: string } | null>(null);
const showKeys = ref(false);
function askRotate() {
  confirm.require({
    header: "Rotate the secret key?",
    message: "Anything using the current secret stops working until it gets the new one. Apps that connect to this storage are restarted.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Rotate",
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: async () => {
      const r = await rotate.mutateAsync().catch(() => null);
      if (r) {
        keys.value = r;
        showKeys.value = true;
      }
    },
  });
}

// ---- settings ----
const draft = ref<StorageBackend>({ kind: "local" });
const secrets = ref<StorageSecrets>({});
watch(storage, (s) => {
  if (s && JSON.stringify(draft.value) === JSON.stringify({ kind: "local" }) && s.backend.kind !== "local") draft.value = structuredClone(s.backend);
}, { immediate: true });
const dirty = computed(() => !!storage.value && (JSON.stringify(draft.value) !== JSON.stringify(storage.value.backend) || !!secrets.value.password || !!secrets.value.privateKey));
const problem = computed(() => backendProblem(draft.value, secrets.value, true));
function resetDraft() {
  if (storage.value) draft.value = structuredClone(storage.value.backend);
  secrets.value = {};
}
async function save() {
  const ok = await patch.mutateAsync({ backend: draft.value, secrets: secrets.value }).then(() => true, () => false);
  if (ok) {
    secrets.value = {};
    notify.ok("Saved", "The endpoint is being redeployed");
  }
}

// ---- delete ----
const showDelete = ref(false);
const typed = ref("");
watch(showDelete, (v) => {
  if (v) {
    typed.value = "";
    del.reset();
  }
});
async function remove() {
  const ok = await del.mutateAsync({ name: name.value }).then(() => true, () => false);
  if (ok) {
    showDelete.value = false;
    await router.push("/storage");
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader :title="name">
      <template #before>
        <NuxtLink to="/storage" class="inline-flex items-center gap-1.5 text-sm text-muted-color hover:text-color mb-1.5">
          <i class="pi pi-arrow-left text-[0.7rem]" aria-hidden="true" />Storage
        </NuxtLink>
      </template>
      <template v-if="storage" #beside><StatusTag :state="storage.activeState === 'failed' ? 'failed' : storage.activeState" /></template>
    </PageHeader>

    <Skeleton v-if="isLoading" height="12rem" />
    <Message v-else-if="error" severity="error">{{ error.message }}</Message>
    <template v-else-if="storage">
      <Message v-if="failed" severity="error" :closable="false">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="whitespace-pre-line">{{ last?.error?.split("\n")[0] ?? "The last deployment failed." }}</span>
          <Button v-if="can('admin')" label="Try again" size="small" severity="secondary" :loading="apply.isPending.value" @click="apply.mutate()" />
        </div>
      </Message>

      <Tabs v-model:value="tab" lazy>
        <TabList>
          <Tab value="overview">Overview</Tab>
          <Tab value="domains">Domains</Tab>
          <Tab value="logs">Logs</Tab>
          <Tab value="deployments">Deployments</Tab>
          <Tab v-if="can('admin')" value="settings">Settings</Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="overview">
            <div class="flex flex-col gap-8 max-w-3xl">
              <Facts>
                <Fact label="Backend" :title="describeBackend(storage.backend)">{{ describeBackend(storage.backend) }}</Fact>
                <Fact label="Server">{{ storage.server }}</Fact>
                <Fact label="Endpoint" mono :title="endpoint ?? ''">{{ endpoint ?? "–" }}</Fact>
                <Fact label="Region" mono>us-east-1</Fact>
                <Fact label="Updated" :title="storage.updatedAt">{{ timeAgo(storage.updatedAt) }}</Fact>
              </Facts>

              <section class="flex flex-col gap-3" aria-labelledby="keys-h">
                <h3 id="keys-h" class="font-display font-semibold text-[1.35rem] leading-tight">Keys</h3>
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                  <span class="text-muted-color">Access key</span>
                  <code>{{ storage.accessKey }}</code>
                  <Button icon="pi pi-copy" text rounded size="small" severity="secondary" aria-label="Copy access key" @click="copy(storage.accessKey, 'Access key')" />
                  <span class="text-muted-color ml-2">Secret key</span>
                  <code>••••••••</code>
                  <Button v-if="can('admin')" label="Rotate" icon="pi pi-refresh" size="small" severity="secondary" text :loading="rotate.isPending.value" @click="askRotate" />
                </div>
              </section>

              <section class="flex flex-col gap-3" aria-labelledby="use-h">
                <div class="flex items-center justify-between gap-2">
                  <h3 id="use-h" class="font-display font-semibold text-[1.35rem] leading-tight">Use it from an app</h3>
                  <Button icon="pi pi-copy" text rounded size="small" severity="secondary" aria-label="Copy" @click="copy(usageSnippet(storage.name), 'Snippet')" />
                </div>
                <pre class="terminal" tabindex="0">{{ usageSnippet(storage.name) }}</pre>
              </section>
            </div>
          </TabPanel>
          <TabPanel value="domains"><AppDomainsTab v-if="app" :app="app" /><Skeleton v-else height="6rem" /></TabPanel>
          <TabPanel value="logs"><AppLogsTab v-if="app" :app="app" /><Skeleton v-else height="6rem" /></TabPanel>
          <TabPanel value="deployments"><AppDeploymentsTab v-if="app" :app="app" /><Skeleton v-else height="6rem" /></TabPanel>
          <TabPanel value="settings">
            <div class="flex flex-col gap-10 max-w-2xl">
              <section v-if="storage.backend.kind !== 'local'" class="flex flex-col gap-3" aria-labelledby="conn-h">
                <h3 id="conn-h" class="font-display font-semibold text-[1.35rem] leading-tight">Connection</h3>
                <StorageBackendForm v-model:backend="draft" v-model:secrets="secrets" :server="storage.server" editing />
                <div class="flex gap-2">
                  <Button label="Save" size="small" :disabled="!dirty || !!problem" :loading="patch.isPending.value" @click="save" />
                  <Button label="Reset" size="small" severity="secondary" text :disabled="!dirty" @click="resetDraft" />
                </div>
              </section>
              <section class="flex flex-col gap-3" aria-labelledby="danger-h">
                <h3 id="danger-h" class="font-display font-semibold text-[1.35rem] leading-tight">Delete</h3>
                <Button label="Delete storage" icon="pi pi-trash" severity="danger" outlined size="small" class="self-start" @click="showDelete = true" />
              </section>
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>

      <StorageKeysDialog v-if="keys" v-model="showKeys" :name="storage.name" :access-key="keys.accessKey" :secret-key="keys.secretKey" rotated />
      <Dialog v-model:visible="showDelete" modal :header="`Delete ${storage.name}?`" :style="{ width: '30rem' }" :closable="!del.isPending.value">
        <div class="flex flex-col gap-3 text-sm">
          <p>Type <b>{{ storage.name }}</b> to confirm.</p>
          <InputText v-model="typed" autocomplete="off" :aria-label="`Type ${storage.name}`" />
          <Message v-if="del.isError.value" severity="error" :closable="false" size="small">{{ errorMessage(del.error.value) }}</Message>
        </div>
        <template #footer>
          <Button label="Cancel" severity="secondary" text :disabled="del.isPending.value" @click="showDelete = false" />
          <Button label="Delete storage" severity="danger" :disabled="typed !== storage.name" :loading="del.isPending.value" @click="remove" />
        </template>
      </Dialog>
    </template>
  </div>
</template>
