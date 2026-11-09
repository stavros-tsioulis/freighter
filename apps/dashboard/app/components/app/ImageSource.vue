<script setup lang="ts">
import type { AppRow } from "~/types";
import { IMAGE_RE, imageHost } from "~/utils/settings";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const notify = useNotify();
const name = computed(() => props.app.name);
const redeploy = useRedeployImages(name);
const setImages = useSetImages(name);
const { data: registries } = useRegistries(() => can("deployer"));
const choose = useChooseLogin(name);

const loginsOf = (host: string) => (registries.value ?? []).filter((r) => r.host === host).map((r) => r.username);
const rows = computed(() =>
  Object.entries(props.app.images ?? {}).map(([service, image]) => {
    const host = imageHost(image);
    const d = props.app.imageDetails?.[service];
    const svc = props.app.services.find((x) => x.name === service);
    return {
      service,
      image,
      host,
      logins: loginsOf(host),
      chosen: props.app.registryLogins?.[host] ?? null,
      containerPort: d?.containerPort ?? null,
      volumes: Object.entries(d?.volumes ?? {}),
      hostnames: svc?.hostnames ?? [],
      port: svc?.port ?? null,
    };
  }),
);

const loginFor = ref<string | null>(null);
const loginOpen = computed({ get: () => loginFor.value !== null, set: (v: boolean) => { if (!v) loginFor.value = null; } });

// One dialog follows whichever deployment was just started (a redeploy or a change of image).
const progress = ref(false);
const deploymentId = ref<string | null>(null);
const finished = ref<"success" | "failed" | null>(null);
function follow(id: string) {
  deploymentId.value = id;
  finished.value = null;
  progress.value = true;
}

async function pullAgain() {
  const r = await redeploy.mutateAsync().catch(() => null);
  if (r) follow(r.id);
}

const edit = ref<{ service: string; image: string } | null>(null);
const editVisible = computed({ get: () => edit.value !== null, set: (v) => { if (!v) edit.value = null; } });
const editError = computed(() => (edit.value && edit.value.image.trim() && !IMAGE_RE.test(edit.value.image.trim()) ? "Not a valid image reference, e.g. ghcr.io/acme/shop:1.4" : ""));
const editReady = computed(() => !!edit.value && edit.value.image.trim() !== "" && !editError.value && edit.value.image.trim() !== props.app.images?.[edit.value.service]);
async function saveEdit() {
  if (!edit.value) return;
  try {
    const r = await setImages.mutateAsync({ [edit.value.service]: edit.value.image.trim() });
    edit.value = null;
    follow(r.id);
  } catch (e) {
    notify.fail("Could not start the deployment", e);
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <p class="text-sm text-muted-color max-w-[60ch]">
        This app runs container images, pulled by the server from a registry and run with Podman. Each release is pinned to the exact image content it pulled, so a rollback returns to that content even if the tag has moved on.
      </p>
      <Button v-if="can('deployer')" label="Pull again and redeploy" icon="pi pi-cloud-download" size="small" :loading="redeploy.isPending.value" title="Pull every image again and release the result" @click="pullAgain" />
    </div>

    <DataTable scrollable :value="rows" data-key="service">
      <Column header="Service" field="service"><template #body="{ data }"><span class="font-medium">{{ data.service }}</span></template></Column>
      <Column header="Image">
        <template #body="{ data }">
          <code class="break-all">{{ data.image }}</code>
          <div class="flex flex-wrap items-center gap-2 mt-1 text-xs text-muted-color">
            <span>from {{ data.host }}</span>
            <template v-if="data.logins.length > 1 && can('deployer')">
              <Select :model-value="data.chosen" :options="data.logins" placeholder="Choose a login" size="small" class="w-44" :aria-label="`Login for ${data.host}`" :invalid="!data.chosen" :loading="choose.isPending.value" @update:model-value="choose.mutate({ host: data.host, username: $event })" />
            </template>
            <Tag v-else-if="data.logins.length === 1" :value="`login: ${data.logins[0]}`" severity="success" />
            <Button v-else-if="can('admin')" label="Add login" icon="pi pi-key" size="small" text title="For a private image" @click="loginFor = data.host" />
          </div>
        </template>
      </Column>
      <Column header="Reachable at">
        <template #body="{ data }">
          <div v-for="h in data.hostnames" :key="h"><a :href="`https://${h}`" target="_blank" rel="noopener" class="text-primary hover:underline">{{ h }}</a></div>
          <span v-if="data.port" class="text-xs text-muted-color font-mono block">127.0.0.1:{{ data.port }} → container {{ data.containerPort ?? "port from the image" }}</span>
          <span v-else-if="!data.hostnames.length" class="text-muted-color">–</span>
        </template>
      </Column>
      <Column header="Volumes">
        <template #body="{ data }">
          <div v-for="[n, path] in data.volumes" :key="n" class="text-xs font-mono"><span class="text-muted-color">{{ n }}</span> → {{ path }}</div>
          <span v-if="!data.volumes.length" class="text-muted-color">–</span>
        </template>
      </Column>
      <Column v-if="can('deployer')" header="" class="text-right whitespace-nowrap">
        <template #body="{ data }">
          <Button label="Change image" icon="pi pi-pencil" text size="small" severity="secondary" @click="edit = { service: data.service, image: data.image }" />
        </template>
      </Column>
    </DataTable>

    <Dialog v-model:visible="editVisible" modal :header="`Change the image of ${edit?.service ?? ''}`" :style="{ width: '34rem' }" :closable="!setImages.isPending.value">
      <form v-if="edit" class="flex flex-col gap-2" @submit.prevent="editReady && saveEdit()">
        <label for="img-edit" class="text-sm font-medium">Image</label>
        <InputText id="img-edit" v-model="edit.image" class="font-mono" autocomplete="off" spellcheck="false" :invalid="!!editError" autofocus />
        <small v-if="editError" class="text-red-500">{{ editError }}</small>
        <small v-else class="text-muted-color">Pulled, health-checked and switched over like any release. If it doesn't come up, the current one keeps serving.</small>
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="edit = null" />
        <Button label="Pull and deploy" icon="pi pi-cloud-download" :disabled="!editReady" :loading="setImages.isPending.value" @click="saveEdit" />
      </template>
    </Dialog>

    <RegistryLoginDialog v-model:visible="loginOpen" :host="loginFor ?? undefined" />

    <Dialog v-model:visible="progress" modal header="Deploying" :style="{ width: '40rem' }">
      <DeploymentStatus :id="deploymentId" @finished="finished = $event" />
      <template #footer><Button label="Close" severity="secondary" text @click="progress = false" /></template>
    </Dialog>
  </div>
</template>
