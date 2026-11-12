<script setup lang="ts">
import { shownStatus } from "~/utils/deployments";
import type { AppRow } from "~/types";
import { troubled } from "~/utils/apps";
import { shortRelease, timeAgo } from "~/utils/format";

useHead({ title: "Overview - Freighter" });
const { can } = useSession();
const { data: allApps, isLoading } = useApps();
const { data: servers } = useServers();
const serverFilter = ref<string | null>(null);
const multi = computed(() => (servers.value?.length ?? 0) > 1);
const { data: recent } = useRecentDeployments();
const sync = useSync();

// Apps that need attention float to the top; the rest keep the API's order.
const apps = computed(() =>
  (allApps.value ?? [])
    .filter((a) => !serverFilter.value || a.server === serverFilter.value)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => Number(troubled(y.a)) - Number(troubled(x.a)) || x.i - y.i)
    .map((x) => x.a),
);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const summary = computed(() => {
  const list = allApps.value ?? [];
  if (!list.length) return "";
  const where = multi.value ? ` on ${plural(servers.value!.length, "server")}` : "";
  const bad = list.filter(troubled).map((a) => a.name);
  const state =
    bad.length === 0 ? "Everything is running." : bad.length === 1 ? `${bad[0]} needs attention.` : `${bad.length} need attention: ${bad.join(", ")}.`;
  return `${plural(list.length, "app")}${where}. ${state}`;
});
</script>

<template>
  <div class="flex flex-col gap-10">
    <PageHeader title="Overview">
      {{ summary || "Apps you deploy show up here." }}
      <template #actions>
        <Select v-if="multi" v-model="serverFilter" :options="servers" option-label="name" option-value="name" placeholder="All servers" show-clear size="small" class="w-44" aria-label="Filter by server" />
        <Button v-if="can('admin')" label="Sync" icon="pi pi-sync" severity="secondary" text size="small" title="Re-read app state from every server" :loading="sync.isPending.value" @click="sync.mutate()" />
        <DeployMenu size="small" />
      </template>
    </PageHeader>

    <section aria-label="Apps">
      <Skeleton v-if="isLoading" height="9rem" />
      <div v-else-if="!apps.length && serverFilter" class="text-muted-color">No apps on {{ serverFilter }}.</div>
      <div v-else-if="!apps.length" class="rounded-[var(--p-border-radius-lg)] border border-dashed border-[var(--p-surface-300)] dark:border-[var(--p-surface-700)] px-6 py-10 sm:px-10 max-w-3xl">
        <h2 class="font-display font-semibold text-2xl">Ship your first app</h2>
        <Message v-if="servers && !servers.length" severity="warn" :closable="false" class="mt-3">
          This control server runs no apps of its own. <NuxtLink to="/servers" class="underline">Add a server</NuxtLink> to run them on.
        </Message>
        <p class="mt-1.5 text-muted-color max-w-[56ch]">
          Point Freighter at a Git repository and it builds and deploys on every push, upload a <code>.tar.gz</code> that contains an <code>app.yaml</code>, or run a container image from a registry.
        </p>
        <div class="mt-5"><DeployMenu /></div>
      </div>

      <AppBoard v-else :apps="apps" />
    </section>

    <section v-if="(recent ?? []).length" aria-labelledby="recent-h">
      <h2 id="recent-h" class="font-display font-semibold text-[1.5rem] mb-3">Recent deployments</h2>
      <ul class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] divide-y divide-[var(--fr-line)]">
        <li v-for="d in recent" :key="d.id" class="recent-row">
          <span class="r-time text-sm text-muted-color whitespace-nowrap" :title="d.createdAt">{{ timeAgo(d.createdAt) }}</span>
          <NuxtLink :to="`/apps/${d.app}`" class="r-app font-medium text-primary hover:underline truncate">{{ d.app }}</NuxtLink>
          <span class="r-action text-sm">{{ d.action === "rollback" ? "Rollback" : "Deploy" }}</span>
          <span class="r-rel font-mono text-[0.8rem] text-muted-color truncate">{{ shortRelease(d.releaseId) }}</span>
          <StatusTag :state="shownStatus(d)" class="r-status" />
        </li>
      </ul>
    </section>

  </div>
</template>

<style scoped>
.recent-row {
  display: grid;
  grid-template-columns: 9rem minmax(8rem, 1fr) 6rem minmax(0, 1fr) 8rem;
  align-items: center;
  gap: 0.25rem 1.25rem;
  padding: 0.75rem 1.25rem;
}
.r-status { justify-self: end; }
@media (max-width: 639px) {
  .recent-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "app time" "status action";
  }
  .r-app { grid-area: app; }
  .r-time { grid-area: time; justify-self: end; }
  .r-status { grid-area: status; justify-self: start; }
  .r-action { grid-area: action; justify-self: end; color: var(--p-text-muted-color); }
  .r-rel { display: none; }
}
</style>
