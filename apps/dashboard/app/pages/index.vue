<script setup lang="ts">
import type { AppRow } from "~/types";
import { shortRelease, timeAgo } from "~/utils/format";

useHead({ title: "Apps - Freighter" });
const { can } = useSession();
const { data: allApps, isLoading } = useApps();
const { data: servers } = useServers();
const serverFilter = ref<string | null>(null);
const multi = computed(() => (servers.value?.length ?? 0) > 1);
const { data: recent } = useRecentDeployments();
const sync = useSync();

const troubled = (a: AppRow) => a.status === "missing" || a.services.some((s) => s.activeState === "failed");
const tone = (a: AppRow) => (troubled(a) ? "bad" : a.status === "deployed" ? "ok" : "idle");
// Apps that need attention float to the top; the rest keep the API's order.
const apps = computed(() =>
  (allApps.value ?? [])
    .filter((a) => !serverFilter.value || a.server === serverFilter.value)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => Number(troubled(y.a)) - Number(troubled(x.a)) || x.i - y.i)
    .map((x) => x.a),
);
const hosts = (a: AppRow) => [...new Set(a.services.flatMap((s) => s.hostnames))];

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
    <PageHeader title="Apps">
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

      <div v-else class="board">
        <div class="board-head" aria-hidden="true">
          <span>App</span><span>Services</span><span>Address</span><span>Release</span><span class="text-right">Updated</span>
        </div>
        <ul>
          <li v-for="a in apps" :key="a.name">
            <NuxtLink :to="`/apps/${a.name}`" class="board-row" :data-tone="tone(a)">
              <div class="min-w-0">
                <span class="block font-display font-semibold text-[1.4rem] leading-tight truncate">{{ a.name }}</span>
                <span class="flex items-center gap-x-3 text-sm text-muted-color">
                  <StatusTag :state="troubled(a) && a.status !== 'missing' ? 'failed' : a.status" :label="troubled(a) && a.status !== 'missing' ? 'Service failed' : undefined" class="!text-[0.85rem]" />
                  <span v-if="multi" class="truncate"><i class="pi pi-server text-[0.7rem] mr-1" aria-hidden="true" />{{ a.server }}</span>
                </span>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <StatusTag v-for="s in a.services" :key="s.name" :state="s.activeState" :label="s.name" class="!font-normal !text-[0.9rem]" />
                <span v-if="!a.services.length" class="text-muted-color">None running</span>
              </div>
              <div class="text-sm min-w-0">
                <span v-if="hosts(a).length" class="block truncate" :title="hosts(a).join(', ')">
                  {{ hosts(a)[0] }}<span v-if="hosts(a).length > 1" class="text-muted-color"> and {{ hosts(a).length - 1 }} more</span>
                </span>
                <span v-else class="text-muted-color">No domain</span>
              </div>
              <span class="font-mono text-[0.8rem] text-muted-color truncate">{{ shortRelease(a.currentRelease) }}</span>
              <span class="text-sm text-muted-color lg:text-right whitespace-nowrap" :title="a.updatedAt">{{ timeAgo(a.updatedAt) }}</span>
            </NuxtLink>
          </li>
        </ul>
      </div>
    </section>

    <section v-if="(recent ?? []).length" aria-labelledby="recent-h">
      <h2 id="recent-h" class="font-display font-semibold text-[1.5rem] mb-3">Recent deployments</h2>
      <ul class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] divide-y divide-[var(--fr-line)]">
        <li v-for="d in recent" :key="d.id" class="recent-row">
          <span class="r-time text-sm text-muted-color whitespace-nowrap" :title="d.createdAt">{{ timeAgo(d.createdAt) }}</span>
          <NuxtLink :to="`/apps/${d.app}`" class="r-app font-medium text-primary hover:underline truncate">{{ d.app }}</NuxtLink>
          <span class="r-action text-sm">{{ d.action === "rollback" ? "Rollback" : "Deploy" }}</span>
          <span class="r-rel font-mono text-[0.8rem] text-muted-color truncate">{{ shortRelease(d.releaseId) }}</span>
          <StatusTag :state="d.status" class="r-status" />
        </li>
      </ul>
    </section>

  </div>
</template>

<style scoped>
.board {
  border: 1px solid var(--fr-line);
  border-radius: var(--p-border-radius-lg);
  background: var(--fr-panel);
  overflow: hidden;
}
.board-head,
.board-row {
  display: grid;
  grid-template-columns: minmax(11rem, 1.1fr) minmax(10rem, 1fr) minmax(10rem, 1.2fr) 10.5rem 7.5rem;
  gap: 1.25rem;
  align-items: center;
  padding: 0.85rem 1.25rem 0.85rem 1.5rem;
}
.board-head {
  padding-block: 0.5rem;
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  background: var(--fr-sunken);
  border-bottom: 1px solid var(--fr-line);
}
li + li .board-row { border-top: 1px solid var(--fr-line); }
.board-row {
  position: relative;
  color: inherit;
}
/* the status band down the left edge: the one splash of colour per row */
.board-row::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: var(--band);
}
.board-row[data-tone="ok"] { --band: var(--p-green-500); }
.board-row[data-tone="bad"] { --band: var(--p-red-500); }
.board-row[data-tone="idle"] { --band: var(--p-surface-300); }
.board-row:hover { background: color-mix(in srgb, var(--p-primary-color) 4%, var(--fr-panel)); }
.board-row:focus-visible { outline-offset: -2px; }

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

@media (max-width: 1023px) {
  .board-head { display: none; }
  .board-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "name time" "svc svc" "addr rel";
    gap: 0.5rem 1rem;
  }
  .board-row > :nth-child(1) { grid-area: name; }
  .board-row > :nth-child(2) { grid-area: svc; }
  .board-row > :nth-child(3) { grid-area: addr; }
  .board-row > :nth-child(4) { grid-area: rel; }
  .board-row > :nth-child(5) { grid-area: time; align-self: start; }
}
</style>
