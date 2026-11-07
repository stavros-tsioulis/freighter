<script setup lang="ts">
import type { Role, TokenRow } from "~/types";
import { timeAgo } from "~/utils/format";

definePageMeta({ role: "admin" });
const notify = useNotify();
const { data: tokens, isLoading } = useTokens();
const create = useCreateToken();
const revoke = useRevokeToken();
const confirm = useConfirm();

const showCreate = ref(false);
const name = ref("");
const role = ref<Role>("deployer");
const roles = [
  { label: "Viewer — read-only", value: "viewer" },
  { label: "Deployer — deploy and operate", value: "deployer" },
  { label: "Admin — everything", value: "admin" },
];
const created = ref<string | null>(null);

function open() {
  name.value = "";
  role.value = "deployer";
  created.value = null;
  showCreate.value = true;
}
async function submit() {
  const r = await create.mutateAsync({ name: name.value.trim(), role: role.value }).catch(() => null);
  if (r) created.value = r.token;
}
async function copy() {
  try {
    await navigator.clipboard.writeText(created.value ?? "");
    notify.ok("Token copied");
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}
function askRevoke(t: TokenRow) {
  confirm.require({
    header: `Revoke “${t.name}”?`,
    message: "Anything using this token (CI jobs, browser sessions) stops working immediately.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Revoke",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => revoke.mutate(t.id),
  });
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-semibold">API tokens</h1>
      <Button label="New token" icon="pi pi-plus" size="small" @click="open" />
    </div>
    <DataTable scrollable :value="tokens ?? []" :loading="isLoading" size="small" striped-rows data-key="id">
      <Column header="Name" field="name" />
      <Column header="Role"><template #body="{ data }"><Tag :value="data.role" severity="secondary" /></template></Column>
      <Column header="Created"><template #body="{ data }">{{ timeAgo(data.createdAt) }}</template></Column>
      <Column header="Last used"><template #body="{ data }">{{ data.lastUsedAt ? timeAgo(data.lastUsedAt) : "never" }}</template></Column>
      <Column header="">
        <template #body="{ data }">
          <Tag v-if="data.revokedAt" value="revoked" severity="danger" />
          <Button v-else icon="pi pi-trash" text rounded severity="danger" size="small" aria-label="Revoke token" @click="askRevoke(data)" />
        </template>
      </Column>
    </DataTable>

    <Dialog v-model:visible="showCreate" modal :header="created ? 'Token created' : 'New API token'" :style="{ width: '32rem' }" :closable="!create.isPending.value">
      <div v-if="!created" class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label for="tok-name" class="text-sm font-medium">Name</label>
          <InputText id="tok-name" v-model="name" placeholder="e.g. github-actions" maxlength="64" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="tok-role" class="text-sm font-medium">Role</label>
          <Select id="tok-role" v-model="role" :options="roles" option-label="label" option-value="value" />
        </div>
      </div>
      <div v-else class="flex flex-col gap-3">
        <Message severity="warn" size="small">Copy this token now. It is not stored and cannot be shown again.</Message>
        <div class="flex gap-2">
          <InputText :model-value="created" readonly class="font-mono flex-1" aria-label="New token" @focus="($event.target as HTMLInputElement).select()" />
          <Button icon="pi pi-copy" aria-label="Copy token" @click="copy" />
        </div>
      </div>
      <template #footer>
        <Button :label="created ? 'Done' : 'Cancel'" severity="secondary" text @click="showCreate = false" />
        <Button v-if="!created" label="Create" icon="pi pi-check" :disabled="!name.trim()" :loading="create.isPending.value" @click="submit" />
      </template>
    </Dialog>
  </div>
</template>
