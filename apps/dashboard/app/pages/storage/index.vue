<script setup lang="ts">
import type { StorageCreated } from "~/types";
import { KINDS, describeBackend, endpointOf } from "~/utils/storage";

useHead({ title: "Storage - Freighter" });
const { can } = useSession();
const { data: storages, isLoading } = useStorages();
const router = useRouter();

const showNew = ref(false);
const created = ref<StorageCreated | null>(null);
const showKeys = ref(false);
function onCreated(c: StorageCreated) {
  created.value = c;
  showKeys.value = true;
  void router.push(`/storage/${c.storage.name}`);
}
const icon = (kind: string) => KINDS.find((k) => k.kind === kind)?.icon ?? "pi pi-database";
const tone = (s: { activeState: string }) => (s.activeState === "failed" ? "failed" : s.activeState);
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Storage">
      <template #actions>
        <Button v-if="can('admin')" label="New storage" icon="pi pi-plus" size="small" @click="showNew = true" />
      </template>
    </PageHeader>

    <Skeleton v-if="isLoading" height="9rem" />
    <div v-else-if="!(storages ?? []).length" class="rounded-[var(--p-border-radius-lg)] border border-dashed border-[var(--p-surface-300)] dark:border-[var(--p-surface-700)] px-6 py-10 sm:px-10 max-w-3xl">
      <h2 class="font-display font-semibold text-2xl">No storage yet</h2>
      <div class="mt-4"><Button v-if="can('admin')" label="New storage" icon="pi pi-plus" @click="showNew = true" /></div>
    </div>
    <ul v-else class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(20rem,1fr))]">
      <li v-for="s in storages" :key="s.name" class="card" :data-bad="s.activeState === 'failed' || undefined">
        <h2 class="font-display font-semibold text-[1.5rem] leading-tight flex items-center gap-2.5 min-w-0">
          <NuxtLink :to="`/storage/${s.name}`" class="stretch flex items-center gap-2.5 min-w-0">
            <i :class="icon(s.backend.kind)" class="text-[1.05rem] text-muted-color" aria-hidden="true" />
            <span class="truncate">{{ s.name }}</span>
          </NuxtLink>
        </h2>
        <p class="text-sm text-muted-color truncate" :title="describeBackend(s.backend)">{{ describeBackend(s.backend) }}</p>
        <div class="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
          <span class="truncate min-w-0" :title="endpointOf(s) ?? ''">{{ s.hostnames[0] ?? "No domain" }}</span>
          <StatusTag :state="tone(s)" class="!text-[0.85rem]" />
        </div>
      </li>
    </ul>

    <StorageNewStorageDialog v-model:visible="showNew" @created="onCreated" />
    <StorageKeysDialog v-if="created" v-model="showKeys" :name="created.storage.name" :access-key="created.accessKey" :secret-key="created.secretKey" />
  </div>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 8.5rem;
  padding: 1rem 1.15rem 1.05rem;
  background: var(--fr-panel);
  border: 1px solid var(--fr-line);
  border-radius: var(--p-border-radius-lg);
  transition: border-color 0.12s, background 0.12s;
}
.card:hover { border-color: var(--p-surface-400); background: color-mix(in srgb, var(--p-primary-color) 3%, var(--fr-panel)); }
.card[data-bad] { border-color: color-mix(in srgb, var(--p-red-500) 45%, var(--fr-line)); }
.stretch::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
</style>
