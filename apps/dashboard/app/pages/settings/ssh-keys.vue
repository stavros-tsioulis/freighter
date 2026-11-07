<script setup lang="ts">
import type { SshKey } from "~/types";
import { timeAgo } from "~/utils/format";

definePageMeta({ role: "admin" });
const { data: keys, isLoading } = useSshKeys();
const importKey = useImportSshKey();
const remove = useRemoveSshKey();
const generate = useGenerateSshKey();
const confirm = useConfirm();
const notify = useNotify();

const show = ref(false);
const name = ref("");
const privateKey = ref("");
const passphrase = ref("");
const needsPassphrase = computed(() => /ENCRYPTED/.test(privateKey.value) || importKey.error.value?.message.includes("passphrase") === true);
const valid = computed(() => /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/.test(name.value.trim()) && privateKey.value.includes("PRIVATE KEY"));

function open() {
  name.value = "";
  privateKey.value = "";
  passphrase.value = "";
  importKey.reset();
  show.value = true;
}
async function pickFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  privateKey.value = await f.text();
  if (!name.value) name.value = f.name.replace(/^id_/, "").replace(/\.(pem|key)$/, "");
}
async function submit() {
  const r = await importKey.mutateAsync({ name: name.value.trim(), privateKey: privateKey.value, ...(passphrase.value ? { passphrase: passphrase.value } : {}) }).catch(() => null);
  if (r) {
    privateKey.value = ""; // do not keep key material in the page longer than needed
    passphrase.value = "";
    show.value = false;
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok("Public key copied");
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}
const showGen = ref(false);
const genName = ref("");
const generated = ref<SshKey | null>(null);
const genValid = computed(() => /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/.test(genName.value.trim()));
function openGen() {
  genName.value = "";
  generated.value = null;
  generate.reset();
  showGen.value = true;
}
async function submitGen() {
  generated.value = (await generate.mutateAsync({ name: genName.value.trim() }).catch(() => null)) ?? null;
}
function askRemove(k: SshKey) {
  confirm.require({
    header: `Delete “${k.name}”?`,
    message: k.appCount ? `${k.appCount} app${k.appCount === 1 ? "" : "s"} still use this key. Switch them to another key first.` : "Freighter forgets this key. Repositories it could reach can no longer be fetched with it.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Delete",
    acceptProps: { severity: "danger", disabled: k.appCount > 0 },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => remove.mutate(k.id),
  });
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-2xl font-semibold">SSH keys</h1>
      </div>
      <div class="flex gap-2">
        <Button label="Generate key" icon="pi pi-plus" size="small" severity="secondary" outlined @click="openGen" />
        <Button label="Import key" icon="pi pi-upload" size="small" @click="open" />
      </div>
    </div>

    <DataTable scrollable :value="keys ?? []" :loading="isLoading" size="small" striped-rows data-key="id">
      <template #empty><span class="text-muted-color">No keys yet.</span></template>
      <Column header="Name" field="name" />
      <Column header="Type"><template #body="{ data }"><Tag :value="data.keyType" severity="secondary" /></template></Column>
      <Column header="Fingerprint"><template #body="{ data }"><code class="text-xs break-all">{{ data.fingerprint }}</code></template></Column>
      <Column header="Apps" field="appCount" />
      <Column header="Imported"><template #body="{ data }">{{ timeAgo(data.createdAt) }}</template></Column>
      <Column header="Last used"><template #body="{ data }">{{ data.lastUsedAt ? timeAgo(data.lastUsedAt) : "never" }}</template></Column>
      <Column header="">
        <template #body="{ data }">
          <Button icon="pi pi-copy" text rounded size="small" severity="secondary" aria-label="Copy public key" @click="copy(data.publicKey)" />
          <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Delete key" @click="askRemove(data)" />
        </template>
      </Column>
    </DataTable>

    <Dialog v-model:visible="showGen" modal :header="generated ? 'Key created' : 'Generate an SSH key'" :style="{ width: '36rem' }" :closable="!generate.isPending.value">
      <form v-if="!generated" class="flex flex-col gap-3" @submit.prevent="genValid && submitGen()">
        <div class="flex flex-col gap-1">
          <label for="gen-name" class="text-sm font-medium">Name</label>
          <InputText id="gen-name" v-model="genName" placeholder="e.g. deploy-acme" maxlength="64" autocomplete="off" />
        </div>
        <Message v-if="generate.error.value" severity="error" size="small">{{ generate.error.value.message }}</Message>
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>
      <div v-else class="flex flex-col gap-2">
        <p class="text-sm">Add this public key to your git host. Read access is enough.</p>
        <div class="flex gap-2 items-start">
          <pre class="flex-1 font-mono text-xs p-3 rounded-md bg-surface-100 dark:bg-surface-800 whitespace-pre-wrap break-all" tabindex="0">{{ generated.publicKey }}</pre>
          <Button icon="pi pi-copy" aria-label="Copy public key" @click="copy(generated.publicKey)" />
        </div>
        <small class="text-muted-color break-all">Fingerprint {{ generated.fingerprint }}</small>
      </div>
      <template #footer>
        <Button :label="generated ? 'Done' : 'Cancel'" severity="secondary" text @click="showGen = false" />
        <Button v-if="!generated" label="Generate" icon="pi pi-check" :disabled="!genValid" :loading="generate.isPending.value" @click="submitGen" />
      </template>
    </Dialog>

    <Dialog v-model:visible="show" modal header="Import an SSH key" :style="{ width: '36rem' }" :closable="!importKey.isPending.value">
      <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="valid && submit()">
        <div class="flex flex-col gap-1">
          <label for="key-name" class="text-sm font-medium">Name</label>
          <InputText id="key-name" v-model="name" placeholder="e.g. work-github" maxlength="64" autocomplete="off" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="key-pem" class="text-sm font-medium">Private key</label>
          <Textarea id="key-pem" v-model="privateKey" rows="7" class="font-mono text-xs" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false" autocomplete="off" />
          <input type="file" class="text-sm" aria-label="Or choose a key file" @change="pickFile" />
        </div>
        <div v-if="needsPassphrase" class="flex flex-col gap-1">
          <label for="key-pass" class="text-sm font-medium">Passphrase</label>
          <Password id="key-pass" v-model="passphrase" :feedback="false" toggle-mask fluid input-class="w-full" />
        </div>
        <Message v-if="importKey.error.value" severity="error" size="small">{{ importKey.error.value.message }}</Message>
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="show = false" />
        <Button label="Import" icon="pi pi-check" :disabled="!valid" :loading="importKey.isPending.value" @click="submit" />
      </template>
    </Dialog>
  </div>
</template>
