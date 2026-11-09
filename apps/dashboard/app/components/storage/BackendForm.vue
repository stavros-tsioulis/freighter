<script setup lang="ts">
import type { StorageBackend, StorageSecrets } from "~/types";
import { backendProblem } from "~/utils/storage";

/**
 * The fields of a remote backend (SFTP or SMB), with a "Test connection" button. For SFTP the first test reads the
 * server's host key, which has to be trusted before the connection is tried (and is then pinned).
 */
const props = defineProps<{ server?: string; editing?: boolean }>();
const backend = defineModel<StorageBackend>("backend", { required: true });
const secrets = defineModel<StorageSecrets>("secrets", { required: true });

const test = useTestStorage();
const tested = ref<{ ok: boolean; error?: string } | null>(null);
const pending = ref<{ line: string; fingerprint: string; type: string } | null>(null);

// The fields every remote backend has; the template only shows them for SFTP and SMB.
const remote = computed(() => backend.value as Exclude<StorageBackend, { kind: "local" }>);
const sftp = computed(() => (backend.value.kind === "sftp" ? backend.value : null));
const smb = computed(() => (backend.value.kind === "smb" ? backend.value : null));
const problem = computed(() => backendProblem(backend.value, secrets.value, props.editing));
// Anything that changes what is being connected to invalidates an earlier test and an unconfirmed host key.
watch(() => JSON.stringify([backend.value, secrets.value]), () => (tested.value = null));
watch(() => (backend.value.kind === "sftp" ? [backend.value.host, backend.value.port] : null), () => {
  pending.value = null;
  if (backend.value.kind === "sftp") backend.value = { ...backend.value, hostKey: undefined };
});

async function run() {
  tested.value = null;
  const r = await test.mutateAsync({ server: props.server, backend: backend.value, secrets: secrets.value }).catch(() => null);
  if (!r) return;
  if (r.hostKey) pending.value = r.hostKey;
  else tested.value = r;
}
function trust() {
  if (!pending.value || backend.value.kind !== "sftp") return;
  backend.value = { ...backend.value, hostKey: pending.value.line };
  pending.value = null;
  void run();
}
// Reading an SFTP host key needs only the address; a real test needs every field, secrets included (even when editing,
// because the stored ones are not available here).
const canTest = computed(() => {
  const b = backend.value;
  if (b.kind === "local") return false;
  if (b.kind === "sftp" && !b.hostKey) return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(b.host);
  return backendProblem(b, secrets.value, false) === null;
});
</script>

<template>
  <div v-if="sftp || smb" class="grid grid-cols-6 gap-x-3 gap-y-3">
    <div class="col-span-6 sm:col-span-4 flex flex-col gap-1">
      <label for="sb-host" class="text-sm font-medium">Host</label>
      <InputText id="sb-host" v-model="remote.host" placeholder="files.example.com" autocomplete="off" />
    </div>
    <div class="col-span-6 sm:col-span-2 flex flex-col gap-1">
      <label for="sb-port" class="text-sm font-medium">Port</label>
      <InputNumber id="sb-port" v-model="remote.port" :use-grouping="false" :min="1" :max="65535" :placeholder="sftp ? '22' : '445'" fluid />
    </div>
    <div class="col-span-6 sm:col-span-3 flex flex-col gap-1">
      <label for="sb-user" class="text-sm font-medium">User</label>
      <InputText id="sb-user" v-model="remote.user" autocomplete="off" />
    </div>
    <div v-if="smb" class="col-span-6 sm:col-span-3 flex flex-col gap-1">
      <label for="sb-domain" class="text-sm font-medium">Domain <span class="text-muted-color font-normal">optional</span></label>
      <InputText id="sb-domain" v-model="smb.domain" autocomplete="off" />
    </div>
    <div v-if="smb" class="col-span-6 sm:col-span-3 flex flex-col gap-1">
      <label for="sb-share" class="text-sm font-medium">Share</label>
      <InputText id="sb-share" v-model="smb.share" autocomplete="off" />
    </div>
    <div class="col-span-6 sm:col-span-3 flex flex-col gap-1">
      <label for="sb-path" class="text-sm font-medium">Folder <span class="text-muted-color font-normal">optional</span></label>
      <InputText id="sb-path" v-model="remote.path" placeholder="buckets" autocomplete="off" />
    </div>

    <div v-if="sftp" class="col-span-6 flex flex-col gap-1">
      <span class="text-sm font-medium">Sign in with</span>
      <SelectButton v-model="sftp.auth" :options="[{ l: 'Password', v: 'password' }, { l: 'Private key', v: 'key' }]" option-label="l" option-value="v" :allow-empty="false" size="small" aria-label="Sign in with" />
    </div>
    <div v-if="!sftp || sftp.auth === 'password'" class="col-span-6 flex flex-col gap-1">
      <label for="sb-pass" class="text-sm font-medium">Password</label>
      <Password v-model="secrets.password" input-id="sb-pass" :feedback="false" toggle-mask fluid autocomplete="off" :placeholder="editing ? 'Unchanged' : ''" />
    </div>
    <div v-else class="col-span-6 flex flex-col gap-1">
      <label for="sb-key" class="text-sm font-medium">Private key</label>
      <Textarea id="sb-key" v-model="secrets.privateKey" rows="4" class="font-mono !text-xs" spellcheck="false" autocomplete="off" :placeholder="editing ? 'Unchanged' : '-----BEGIN OPENSSH PRIVATE KEY-----'" />
    </div>

    <Message v-if="pending" severity="warn" :closable="false" class="col-span-6">
      <div class="flex flex-col gap-2">
        <span>{{ remote.host }} presents this {{ pending.type }} key. Trust it only if it matches the server's.</span>
        <code class="break-all">{{ pending.fingerprint }}</code>
        <Button label="Trust this key and test" size="small" class="self-start" @click="trust" />
      </div>
    </Message>
    <div v-else class="col-span-6 flex flex-wrap items-center gap-3">
      <Button :label="sftp && !sftp.hostKey ? 'Read host key' : 'Test connection'" icon="pi pi-bolt" size="small" severity="secondary" :loading="test.isPending.value" :disabled="!canTest" @click="run" />
      <span v-if="sftp?.hostKey" class="text-sm text-muted-color"><i class="pi pi-lock text-[0.7rem] mr-1" aria-hidden="true" />host key pinned</span>
      <span v-if="tested?.ok" class="text-sm text-green-600 dark:text-green-400"><i class="pi pi-check mr-1" aria-hidden="true" />Connected</span>
      <span v-else-if="tested" class="text-sm text-red-600 dark:text-red-400">{{ tested.error }}</span>
    </div>
  </div>
</template>
