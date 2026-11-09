<script setup lang="ts">
import type { AppRow } from "~/types";
import { troubled } from "~/utils/apps";
import { shortRelease, timeAgo } from "~/utils/format";

/** The table of apps: status band, services, address, release. Used on the overview and on the apps page. */
defineProps<{ apps: AppRow[] }>();
const { data: servers } = useServers();
const multi = computed(() => (servers.value?.length ?? 0) > 1);
const tone = (a: AppRow) => (troubled(a) ? "bad" : a.status === "deployed" ? "ok" : "idle");
const hosts = (a: AppRow) => [...new Set(a.services.flatMap((s) => s.hostnames))];
</script>

<template>
  <div class="board">
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
