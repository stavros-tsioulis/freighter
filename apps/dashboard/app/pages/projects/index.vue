<script setup lang="ts">
import type { Project } from "~/types";
import { troubled } from "~/utils/apps";

useHead({ title: "Projects - Freighter" });
const { can } = useSession();
const { data: allApps, isLoading } = useApps();
const { data: projects, isLoading: loadingProjects } = useProjects();
const del = useDeleteProject();

const known = computed(() => new Set((projects.value ?? []).map((p) => p.id)));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One card per project, plus "No project" for apps that belong to none (or to a project we don't know). */
const cards = computed(() => {
  const apps = allApps.value ?? [];
  const card = (id: string, name: string, description: string, list: typeof apps, project?: Project) => ({
    id, name, description, project,
    apps: list,
    services: list.reduce((n, a) => n + a.services.length, 0),
    bad: list.filter(troubled).length,
  });
  const out = (projects.value ?? []).map((p) => card(p.id, p.name, p.description, apps.filter((a) => a.projectId === p.id), p));
  const loose = apps.filter((a) => a.projectId === null || !known.value.has(a.projectId));
  if (loose.length) out.push(card("none", "No project", "Apps that are not in a project.", loose));
  return out;
});
const total = computed(() => allApps.value?.length ?? 0);

const editing = ref<Project | undefined>();
const showDialog = ref(false);
const openNew = () => {
  editing.value = undefined;
  showDialog.value = true;
};
const openEdit = (p: Project) => {
  editing.value = p;
  showDialog.value = true;
};
const removing = ref<Project | null>(null);
async function confirmRemove() {
  if (!removing.value) return;
  await del.mutateAsync(removing.value.id).catch(() => undefined);
  removing.value = null;
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Projects">
      {{ total ? `${plural(total, "app")} in ${plural(projects?.length ?? 0, "project")}.` : "Group related apps, such as a web app, its API and its workers, and see how they connect." }}
      <template #actions>
        <Button v-if="can('admin')" label="New project" icon="pi pi-folder-plus" severity="secondary" size="small" @click="openNew" />
        <DeployMenu size="small" />
      </template>
    </PageHeader>

    <Skeleton v-if="isLoading || loadingProjects" height="9rem" />
    <div v-else-if="!cards.length" class="rounded-[var(--p-border-radius-lg)] border border-dashed border-[var(--p-surface-300)] dark:border-[var(--p-surface-700)] px-6 py-10 sm:px-10 max-w-3xl">
      <h2 class="font-display font-semibold text-2xl">Nothing here yet</h2>
      <p class="mt-1.5 text-muted-color max-w-[56ch]">Create a project, then deploy apps and move them into it. Each project gets a canvas that shows its services and the connections between them.</p>
      <div class="mt-5 flex flex-wrap gap-2">
        <Button v-if="can('admin')" label="New project" icon="pi pi-folder-plus" @click="openNew" />
        <DeployMenu />
      </div>
    </div>

    <ul v-else class="grid gap-4 grid-cols-[repeat(auto-fill,minmax(19rem,1fr))]">
      <li v-for="c in cards" :key="c.id" class="card" :data-bad="c.bad || undefined">
        <div class="flex items-start justify-between gap-2">
          <h2 class="font-display font-semibold text-[1.5rem] leading-tight min-w-0">
            <NuxtLink :to="`/projects/${c.id}`" class="stretch flex items-center gap-2.5">
              <i :class="c.project ? 'pi pi-folder' : 'pi pi-inbox'" class="text-[1.05rem] text-muted-color" aria-hidden="true" />
              <span class="truncate">{{ c.name }}</span>
            </NuxtLink>
          </h2>
          <div v-if="c.project && can('admin')" class="relative z-10 flex gap-0.5 -mr-2 -mt-1">
            <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" :aria-label="`Edit ${c.name}`" title="Rename or describe" @click="openEdit(c.project)" />
            <Button icon="pi pi-trash" text rounded size="small" severity="secondary" :aria-label="`Delete ${c.name}`" title="Delete the project (its apps are kept)" @click="removing = c.project" />
          </div>
        </div>
        <p class="text-sm text-muted-color min-h-[1.3rem]">{{ c.description }}</p>
        <div class="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>{{ plural(c.apps.length, "app") }}</span>
          <span class="text-muted-color">{{ plural(c.services, "service") }}</span>
          <StatusTag v-if="c.bad" state="failed" :label="`${c.bad} need${c.bad === 1 ? 's' : ''} attention`" class="!text-[0.85rem]" />
        </div>
        <ul v-if="c.apps.length" class="flex flex-wrap gap-1.5" aria-label="Apps">
          <li v-for="a in c.apps.slice(0, 6)" :key="a.name" class="chip"><StatusTag :state="troubled(a) ? 'failed' : a.status" :label="a.name" class="!text-[0.82rem] !font-normal" /></li>
          <li v-if="c.apps.length > 6" class="chip text-muted-color">+{{ c.apps.length - 6 }}</li>
        </ul>
      </li>
    </ul>

    <ProjectDialog v-model:visible="showDialog" :project="editing" />
    <Dialog :visible="!!removing" modal :header="`Delete ${removing?.name}?`" :style="{ width: '28rem' }" @update:visible="(v: boolean) => !v && (removing = null)">
      <p class="text-sm">
        This removes the project only. Its {{ removing?.appCount === 1 ? "app keeps" : `${removing?.appCount ?? 0} apps keep` }} running and {{ removing?.appCount === 1 ? "moves" : "move" }} to <b>No project</b>.
      </p>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="removing = null" />
        <Button label="Delete project" severity="danger" :loading="del.isPending.value" @click="confirmRemove" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-height: 9.5rem;
  padding: 1rem 1.15rem 1.05rem;
  background: var(--fr-panel);
  border: 1px solid var(--fr-line);
  border-radius: var(--p-border-radius-lg);
  transition: border-color 0.12s, background 0.12s;
}
.card:hover { border-color: var(--p-surface-400); background: color-mix(in srgb, var(--p-primary-color) 3%, var(--fr-panel)); }
.card[data-bad] { border-color: color-mix(in srgb, var(--p-red-500) 45%, var(--fr-line)); }
/* the whole card is the link; the edit and delete buttons sit above it */
.stretch::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
.chip { padding: 0.1rem 0.55rem; border: 1px solid var(--fr-line); border-radius: 999px; background: var(--fr-sunken); font-size: 0.82rem; }
</style>
