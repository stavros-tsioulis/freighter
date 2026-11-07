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
  { label: "Viewer", hint: "Sees everything, changes nothing", value: "viewer" },
  { label: "Deployer", hint: "Deploys, rolls back, restarts and reads logs", value: "deployer" },
  { label: "Admin", hint: "Everything, including servers, domains, secrets and tokens", value: "admin" },
];
const roleName = (r: Role) => roles.find((x) => x.value === r)?.label ?? r;
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
  <div class="flex flex-col gap-8">
    <PageHeader title="API tokens">
      Tokens sign in to this dashboard and let the CLI and CI jobs call the API. Give each one the smallest role it needs.
      <template #actions>
        <Button label="New token" icon="pi pi-plus" size="small" @click="open" />
      </template>
    </PageHeader>
    <DataTable scrollable :value="tokens ?? []" :loading="isLoading" data-key="id">
      <template #empty><span class="text-muted-color">No tokens yet.</span></template>
      <Column header="Name" field="name"><template #body="{ data }"><span class="font-medium" :class="{ 'line-through text-muted-color': data.revokedAt }">{{ data.name }}</span></template></Column>
      <Column header="Role"><template #body="{ data }">{{ roleName(data.role) }}</template></Column>
      <Column header="Created"><template #body="{ data }">{{ timeAgo(data.createdAt) }}</template></Column>
      <Column header="Last used"><template #body="{ data }">{{ data.lastUsedAt ? timeAgo(data.lastUsedAt) : "never" }}</template></Column>
      <Column header="" class="text-right" style="width: 7rem">
        <template #body="{ data }">
          <span v-if="data.revokedAt" class="text-sm text-muted-color">Revoked</span>
          <Button v-else label="Revoke" text severity="danger" size="small" @click="askRevoke(data)" />
        </template>
      </Column>
    </DataTable>

    <Dialog v-model:visible="showCreate" modal :header="created ? 'Token created' : 'New API token'" :style="{ width: '32rem' }" :closable="!create.isPending.value">
      <div v-if="!created" class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label for="tok-name" class="text-sm font-medium">Name</label>
          <InputText id="tok-name" v-model="name" placeholder="github-actions" maxlength="64" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="tok-role" class="text-sm font-medium">Role</label>
          <Select id="tok-role" v-model="role" :options="roles" option-label="label" option-value="value">
            <template #option="{ option }"><div><div>{{ option.label }}</div><div class="text-sm text-muted-color">{{ option.hint }}</div></div></template>
          </Select>
          <small class="text-muted-color">{{ roles.find((r) => r.value === role)?.hint }}</small>
        </div>
      </div>
      <div v-else class="flex flex-col gap-3">
        <Message severity="warn" size="small">Copy this token now. It is not stored and cannot be shown again.</Message>
        <div class="flex gap-2">
          <InputText :model-value="created" readonly class="font-mono flex-1" aria-label="New token" @focus="($event.target as HTMLInputElement).select()" />
          <Button icon="pi pi-copy" label="Copy" severity="secondary" outlined @click="copy" />
        </div>
      </div>
      <template #footer>
        <Button :label="created ? 'Done' : 'Cancel'" severity="secondary" text @click="showCreate = false" />
        <Button v-if="!created" label="Create token" :disabled="!name.trim()" :loading="create.isPending.value" @click="submit" />
      </template>
    </Dialog>
  </div>
</template>
