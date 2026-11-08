<script setup lang="ts">
import type { RegistryLogin } from "~/types";
import { timeAgo } from "~/utils/format";

definePageMeta({ role: "admin" });
useHead({ title: "Registry logins - Freighter" });
const { data: logins, isLoading } = useRegistries();
const save = useSaveRegistry();
const remove = useRemoveRegistry();
const confirm = useConfirm();

const show = ref(false);
const host = ref("");
const username = ref("");
const password = ref("");
const replacing = ref(false);
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const valid = computed(() => HOST_RE.test(host.value.trim().toLowerCase()) && username.value.trim() !== "" && password.value !== "");

function open(existing?: RegistryLogin) {
  host.value = existing?.host ?? "";
  username.value = existing?.username ?? "";
  password.value = "";
  replacing.value = !!existing;
  save.reset();
  show.value = true;
}
async function submit() {
  const r = await save.mutateAsync({ host: host.value.trim().toLowerCase(), username: username.value.trim(), password: password.value }).catch(() => null);
  password.value = ""; // do not keep the secret in the page longer than needed
  if (r) show.value = false;
}
function askRemove(l: RegistryLogin) {
  confirm.require({
    header: `Delete the login for ${l.host}?`,
    message: "Images from this registry can then only be pulled if they are public. Apps already running are not affected.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Delete",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => remove.mutate(l.host),
  });
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Registry logins">
      Logins Freighter uses to pull private container images. The password or token is stored encrypted, sent to a server only for the pull, and never shown again. Public images need none.
      <template #actions>
        <Button label="Add login" icon="pi pi-plus" size="small" @click="open()" />
      </template>
    </PageHeader>

    <DataTable scrollable :value="logins ?? []" :loading="isLoading" data-key="host">
      <template #empty><span class="text-muted-color">No logins yet. Public images from Docker Hub, GHCR and others work without one.</span></template>
      <Column header="Registry" field="host"><template #body="{ data }"><span class="font-medium">{{ data.host }}</span></template></Column>
      <Column header="User" field="username" />
      <Column header="Saved"><template #body="{ data }">{{ timeAgo(data.updatedAt) }}</template></Column>
      <Column header="" class="text-right whitespace-nowrap">
        <template #body="{ data }">
          <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" aria-label="Replace the login" title="Replace the login" @click="open(data)" />
          <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Delete the login" @click="askRemove(data)" />
        </template>
      </Column>
    </DataTable>

    <Dialog v-model:visible="show" modal :header="replacing ? `Replace the login for ${host}` : 'Add a registry login'" :style="{ width: '32rem' }" :closable="!save.isPending.value">
      <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="valid && submit()">
        <div class="flex flex-col gap-1">
          <label for="reg-host" class="text-sm font-medium">Registry</label>
          <InputText id="reg-host" v-model="host" placeholder="ghcr.io" autocomplete="off" spellcheck="false" :disabled="replacing" />
          <small class="text-muted-color">The host in the image name. Docker Hub is <code>docker.io</code>.</small>
        </div>
        <div class="flex flex-col gap-1">
          <label for="reg-user" class="text-sm font-medium">User name</label>
          <InputText id="reg-user" v-model="username" autocomplete="off" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="reg-pass" class="text-sm font-medium">Password or access token</label>
          <Password id="reg-pass" v-model="password" :feedback="false" toggle-mask fluid input-class="w-full" autocomplete="new-password" />
          <small class="text-muted-color">Prefer a token that can only read packages.</small>
        </div>
        <Message v-if="save.error.value" severity="error" size="small">{{ save.error.value.message }}</Message>
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="show = false" />
        <Button :label="replacing ? 'Replace login' : 'Save login'" :disabled="!valid" :loading="save.isPending.value" @click="submit" />
      </template>
    </Dialog>
  </div>
</template>
