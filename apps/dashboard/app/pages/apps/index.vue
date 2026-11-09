<script setup lang="ts">
import type { AppRow, Project } from "~/types";
import { troubled } from "~/utils/apps";

useHead({ title: "Apps - Freighter" });
const { can } = useSession();
const { data: allApps, isLoading } = useApps();
const { data: projects, isLoading: loadingProjects } = useProjects();
const del = useDeleteProject();

const query = ref("");
const matches = (a: AppRow) => a.name.toLowerCase().includes(query.value.trim().toLowerCase());
// Apps that need attention float to the top of their group; the rest keep the API's order.
const ordered = (list: AppRow[]) =>
  list
    .map((a, i) => ({ a, i }))
    .sort((x, y) => Number(troubled(y.a)) - Number(troubled(x.a)) || x.i - y.i)
    .map((x) => x.a);

const groups = computed(() => {
  const known = new Set((projects.value ?? []).map((p) => p.id));
  const found = (allApps.value ?? []).filter(matches);
  const list = (projects.value ?? []).map((p) => ({ project: p, apps: ordered(found.filter((a) => a.projectId === p.id)) }));
  // an app whose project is unknown to us (deleted a moment ago) is shown as ungrouped
  const loose = ordered(found.filter((a) => a.projectId === null || !known.has(a.projectId)));
  return { list, loose };
});
const searching = computed(() => query.value.trim() !== "");
const visibleGroups = computed(() => groups.value.list.filter((g) => !searching.value || g.apps.length > 0));
const total = computed(() => allApps.value?.length ?? 0);
const hasProjects = computed(() => (projects.value?.length ?? 0) > 0);

const summary = computed(() => {
  if (!total.value) return "";
  const n = projects.value?.length ?? 0;
  return `${total.value} app${total.value === 1 ? "" : "s"}${n ? ` in ${n} project${n === 1 ? "" : "s"}` : ""}.`;
});

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
    <PageHeader title="Apps">
      {{ summary || "Apps you deploy show up here, optionally organized in projects." }}
      <template #actions>
        <IconField v-if="total > 4">
          <InputIcon class="pi pi-search" />
          <InputText v-model="query" placeholder="Find an app" size="small" class="w-48" aria-label="Find an app" />
        </IconField>
        <Button v-if="can('admin')" label="New project" icon="pi pi-folder-plus" severity="secondary" size="small" @click="openNew" />
        <DeployMenu size="small" />
      </template>
    </PageHeader>

    <Skeleton v-if="isLoading || loadingProjects" height="9rem" />
    <div v-else-if="!total && !hasProjects" class="rounded-[var(--p-border-radius-lg)] border border-dashed border-[var(--p-surface-300)] dark:border-[var(--p-surface-700)] px-6 py-10 sm:px-10 max-w-3xl">
      <h2 class="font-display font-semibold text-2xl">Nothing here yet</h2>
      <p class="mt-1.5 text-muted-color max-w-[56ch]">Deploy an app, then group related apps into projects, such as a web app, its API and its workers.</p>
      <div class="mt-5 flex flex-wrap gap-2">
        <DeployMenu />
        <Button v-if="can('admin')" label="New project" icon="pi pi-folder-plus" severity="secondary" @click="openNew" />
      </div>
    </div>

    <template v-else>
      <section v-for="g in visibleGroups" :key="g.project.id" :aria-label="g.project.name" class="flex flex-col gap-3">
        <header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div class="min-w-0">
            <h2 class="font-display font-semibold text-[1.5rem] leading-tight flex items-center gap-2.5">
              <i class="pi pi-folder text-[1.1rem] text-muted-color" aria-hidden="true" />
              <span class="truncate">{{ g.project.name }}</span>
              <span class="text-sm font-normal text-muted-color">{{ g.project.appCount }} {{ g.project.appCount === 1 ? "app" : "apps" }}</span>
            </h2>
            <p v-if="g.project.description" class="text-sm text-muted-color mt-0.5">{{ g.project.description }}</p>
          </div>
          <div v-if="can('admin')" class="flex gap-1">
            <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" :aria-label="`Edit ${g.project.name}`" title="Rename or describe" @click="openEdit(g.project)" />
            <Button icon="pi pi-trash" text rounded size="small" severity="secondary" :aria-label="`Delete ${g.project.name}`" title="Delete the project (its apps are kept)" @click="removing = g.project" />
          </div>
        </header>
        <AppBoard v-if="g.apps.length" :apps="g.apps" />
        <p v-else class="rounded-[var(--p-border-radius-lg)] border border-dashed border-[var(--fr-line)] px-5 py-4 text-sm text-muted-color">
          No apps in this project yet. Open an app and pick this project in its header to move it here.
        </p>
      </section>

      <section v-if="groups.loose.length" :aria-label="hasProjects ? 'Apps without a project' : 'Apps'" class="flex flex-col gap-3">
        <header v-if="hasProjects">
          <h2 class="font-display font-semibold text-[1.5rem] leading-tight flex items-center gap-2.5">
            <i class="pi pi-inbox text-[1.1rem] text-muted-color" aria-hidden="true" />
            No project
            <span class="text-sm font-normal text-muted-color">{{ groups.loose.length }} {{ groups.loose.length === 1 ? "app" : "apps" }}</span>
          </h2>
        </header>
        <AppBoard :apps="groups.loose" />
      </section>

      <p v-if="searching && !groups.loose.length && !visibleGroups.length" class="text-muted-color">No app matches "{{ query }}".</p>
    </template>

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
