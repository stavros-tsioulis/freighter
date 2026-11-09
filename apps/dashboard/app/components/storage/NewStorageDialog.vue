<script setup lang="ts">
import type { StorageBackend, StorageCreated, StorageSecrets } from "~/types";
import { KINDS, STORAGE_NAME_RE, backendProblem, emptyBackend, type StorageKind } from "~/utils/storage";

const visible = defineModel<boolean>("visible", { required: true });
const emit = defineEmits<{ created: [StorageCreated] }>();
const { data: servers } = useServers();
const create = useCreateStorage();

const kind = ref<StorageKind>("local");
const name = ref("");
const server = ref<string | undefined>();
const backend = ref<StorageBackend>(emptyBackend("local"));
const secrets = ref<StorageSecrets>({});

const usable = computed(() => (servers.value ?? []).filter((s) => s.status === "online"));
watch(visible, (v) => {
  if (!v) return;
  kind.value = "local";
  name.value = "";
  backend.value = emptyBackend("local");
  secrets.value = {};
  server.value = usable.value.length === 1 ? usable.value[0]!.name : undefined;
  create.reset();
});
watch(kind, (k) => {
  backend.value = emptyBackend(k);
  secrets.value = {};
});

const nameError = computed(() => (name.value && !STORAGE_NAME_RE.test(name.value) ? "Lowercase letters, digits and single hyphens" : ""));
const problem = computed(() => (!STORAGE_NAME_RE.test(name.value) ? "name" : backendProblem(backend.value, secrets.value)));
const needsServer = computed(() => usable.value.length > 1 && !server.value);

async function submit() {
  const r = await create.mutateAsync({ name: name.value, server: server.value, backend: backend.value, secrets: kind.value === "local" ? undefined : secrets.value }).catch(() => null);
  if (r) {
    visible.value = false;
    emit("created", r);
  }
}
</script>

<template>
  <Dialog v-model:visible="visible" modal header="New storage" :style="{ width: '36rem' }" :closable="!create.isPending.value">
    <form class="flex flex-col gap-4" autocomplete="off" @submit.prevent="!problem && !needsServer && submit()">
      <div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Where the files live">
        <button
          v-for="k in KINDS"
          :key="k.kind"
          type="button"
          role="radio"
          :aria-checked="kind === k.kind"
          class="kind"
          :data-on="kind === k.kind || undefined"
          @click="kind = k.kind"
        >
          <i :class="k.icon" aria-hidden="true" />
          <span class="font-medium">{{ k.label }}</span>
          <span class="text-xs text-muted-color">{{ k.text }}</span>
        </button>
      </div>

      <div class="grid grid-cols-6 gap-3">
        <div class="col-span-6 flex flex-col gap-1" :class="{ 'sm:col-span-3': usable.length > 1 }">
          <label for="st-name" class="text-sm font-medium">Name</label>
          <InputText id="st-name" v-model="name" placeholder="uploads" :invalid="!!nameError" autocomplete="off" />
          <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
        </div>
        <div v-if="usable.length > 1" class="col-span-6 sm:col-span-3 flex flex-col gap-1">
          <label for="st-server" class="text-sm font-medium">Server</label>
          <Select v-model="server" input-id="st-server" :options="usable" option-label="name" option-value="name" placeholder="Choose" />
        </div>
      </div>

      <StorageBackendForm v-if="kind !== 'local'" v-model:backend="backend" v-model:secrets="secrets" :server="server" />

      <Message v-if="create.isError.value" severity="error" :closable="false" size="small">{{ errorMessage(create.error.value) }}</Message>
      <button type="submit" class="hidden" />
    </form>
    <template #footer>
      <Button label="Cancel" severity="secondary" text :disabled="create.isPending.value" @click="visible = false" />
      <Button label="Create storage" :disabled="!!problem || needsServer" :loading="create.isPending.value" @click="submit" />
    </template>
  </Dialog>
</template>

<style scoped>
.kind {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.2rem;
  padding: 0.7rem 0.8rem;
  text-align: left;
  background: var(--fr-panel);
  border: 1px solid var(--fr-line);
  border-radius: var(--p-border-radius-md);
  cursor: pointer;
  color: inherit;
}
.kind i { font-size: 1.1rem; color: var(--p-text-muted-color); }
.kind:hover { border-color: var(--p-surface-400); }
.kind[data-on] { border-color: var(--p-primary-color); box-shadow: 0 0 0 1px var(--p-primary-color); }
.kind[data-on] i { color: var(--p-primary-color); }
</style>
