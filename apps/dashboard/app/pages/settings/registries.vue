<script setup lang="ts">
import type { RegistryLogin } from "~/types";
import { timeAgo } from "~/utils/format";

definePageMeta({ role: "admin" });
useHead({ title: "Registry logins - Freighter" });
const { data: logins, isLoading } = useRegistries();
const remove = useRemoveRegistry();
const confirm = useConfirm();

const show = ref(false);
const editing = ref<RegistryLogin | null>(null);
function open(existing?: RegistryLogin) {
  editing.value = existing ?? null;
  show.value = true;
}
function askRemove(l: RegistryLogin) {
  confirm.require({
    header: `Delete the login ${l.username} for ${l.host}?`,
    message: "Apps set to pull with this login fall back to the registry's other login, if there is exactly one; otherwise they need one chosen again. Apps already running are not affected.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Delete",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => remove.mutate({ host: l.host, username: l.username }),
  });
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Registry logins">
      Logins Freighter uses to pull private container images. A registry can have several (say, two accounts); each app pulls with the one chosen for it. The password or token is stored encrypted, sent to a server only for the pull, and never shown again. Public images need none.
      <template #actions>
        <Button label="Add login" icon="pi pi-plus" size="small" @click="open()" />
      </template>
    </PageHeader>

    <DataTable scrollable :value="logins ?? []" :loading="isLoading" :data-key="(r: RegistryLogin) => `${r.host}/${r.username}`">
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

    <RegistryLoginDialog v-model:visible="show" :host="editing?.host" :username="editing?.username" />
  </div>
</template>
