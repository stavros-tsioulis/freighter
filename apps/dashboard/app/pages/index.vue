<script setup lang="ts">
import { shortRelease, timeAgo } from "~/utils/format";

const { can } = useSession();
const { data: allApps, isLoading } = useApps();
const { data: servers } = useServers();
const serverFilter = ref<string | null>(null);
const multi = computed(() => (servers.value?.length ?? 0) > 1);
const apps = computed(() => (allApps.value ?? []).filter((a) => !serverFilter.value || a.server === serverFilter.value));
const { data: recent } = useRecentDeployments();
const sync = useSync();
const showDeploy = ref(false);
const showGit = ref(false);
const edge = (a: { status: string; services: { activeState: string }[] }) =>
  a.status === "missing" || a.services.some((s) => s.activeState === "failed")
    ? "bg-red-500"
    : a.status === "deployed"
      ? "bg-green-500"
      : "bg-surface-400";
const hosts = (a: { services: { hostnames: string[] }[] }) => [...new Set(a.services.flatMap((s) => s.hostnames))];
</script>

<template>
  <div class="flex flex-col gap-6">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-semibold">Overview</h1>
      <div class="flex gap-2">
        <Select v-if="multi" v-model="serverFilter" :options="servers" option-label="name" option-value="name" placeholder="All servers" show-clear size="small" class="w-44" aria-label="Filter by server" />
        <Button v-if="can('admin')" label="Sync" icon="pi pi-sync" severity="secondary" outlined size="small" :loading="sync.isPending.value" @click="sync.mutate()" />
        <Button v-if="can('admin')" label="New app from Git" icon="pi pi-github" severity="secondary" outlined size="small" @click="showGit = true" />
        <Button v-if="can('deployer')" label="Deploy app" icon="pi pi-upload" size="small" @click="showDeploy = true" />
      </div>
    </div>

    <section aria-label="Apps">
      <Skeleton v-if="isLoading" height="8rem" />
      <div v-else-if="!apps.length" class="rounded-lg border border-dashed border-surface p-8 flex flex-col items-start gap-3">
        <p>No apps yet. Deploy an archive or point Freighter at a Git repository.</p>
        <div class="flex flex-wrap gap-2">
          <Button v-if="can('deployer')" label="Deploy app" icon="pi pi-upload" size="small" @click="showDeploy = true" />
          <Button v-if="can('admin')" label="New app from Git" icon="pi pi-github" severity="secondary" outlined size="small" @click="showGit = true" />
        </div>
      </div>
      <ul v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <li v-for="a in apps" :key="a.name">
          <NuxtLink
            :to="`/apps/${a.name}`"
            class="relative block h-full rounded-lg border border-surface bg-surface-0 dark:bg-surface-900 p-5 transition-colors hover:bg-surface-50 dark:hover:bg-surface-800"
          >
            <span class="absolute -top-1.5 -left-1.5 size-3.5 rounded-full ring-4 ring-surface-0 dark:ring-surface-950" :class="edge(a)" aria-hidden="true" />
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="font-semibold text-lg truncate">{{ a.name }}</h2>
                <p v-if="multi" class="text-sm text-muted-color flex items-center gap-1"><i class="pi pi-server text-xs" />{{ a.server }}</p>
              </div>
              <StatusTag :state="a.status" />
            </div>
            <div v-if="a.services.length" class="flex flex-wrap gap-1.5 mt-4">
              <Tag v-for="s in a.services" :key="s.name" :value="s.name" :severity="s.activeState === 'active' ? 'success' : s.activeState === 'failed' ? 'danger' : 'secondary'" />
            </div>
            <p v-if="hosts(a).length" class="mt-3 text-sm text-muted-color truncate" :title="hosts(a).join(', ')">{{ hosts(a).join(", ") }}</p>
            <div class="mt-4 pt-3 border-t border-surface flex justify-between text-xs text-muted-color">
              <span class="font-mono">{{ shortRelease(a.currentRelease) }}</span>
              <span :title="a.updatedAt">{{ timeAgo(a.updatedAt) }}</span>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </section>

    <section>
      <h2 class="font-medium mb-3">Recent deployments</h2>
      <p v-if="!(recent ?? []).length" class="text-muted-color">Nothing deployed yet.</p>
      <ul v-else class="rounded-lg border border-surface bg-surface-0 dark:bg-surface-900 divide-y divide-[var(--p-content-border-color)]">
        <li v-for="d in recent" :key="d.id" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4">
          <NuxtLink :to="`/apps/${d.app}`" class="font-medium text-primary hover:underline min-w-32">{{ d.app }}</NuxtLink>
          <span class="text-sm text-muted-color">{{ d.action }}</span>
          <span class="font-mono text-xs text-muted-color">{{ shortRelease(d.releaseId) }}</span>
          <span class="ml-auto flex items-center gap-3">
            <StatusTag :state="d.status" />
            <span class="text-sm text-muted-color w-20 text-right" :title="d.createdAt">{{ timeAgo(d.createdAt) }}</span>
          </span>
        </li>
      </ul>
    </section>

    <DeployDialog v-model:visible="showDeploy" />
    <NewFromGitDialog v-model:visible="showGit" />
  </div>
</template>
