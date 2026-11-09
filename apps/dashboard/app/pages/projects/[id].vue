<script setup lang="ts">
import { parseSelection, selectionId } from "~/utils/graph";

definePageMeta({ layout: "canvas" });

const route = useRoute();
const router = useRouter();
const { can } = useSession();
const id = computed(() => String(route.params.id));
const { data: graph, isLoading, error } = useProjectGraph(id);
const { data: projects } = useProjects();
const save = useSaveLayout(id);

const project = computed(() => projects.value?.find((p) => p.id === id.value));
const title = computed(() => (id.value === "none" ? "No project" : (project.value?.name ?? "Project")));
useHead({ title: computed(() => `${title.value} - Freighter`) });

// The open node lives in the URL (?node=app or ?node=app/service), so reloads and shared links land on the same view.
const selected = computed(() => {
  const s = parseSelection(typeof route.query.node === "string" ? route.query.node : null);
  // forget a node that is gone (the app was deleted or moved out of the project)
  return s && graph.value?.apps.find((a) => a.name === s.app && (!s.service || a.services.some((x) => x.name === s.service))) ? s : null;
});
const select = (s: { app: string; service?: string } | null) =>
  void router.replace({ query: { ...route.query, node: s ? selectionId(s.app, s.service) : undefined } });

const canvas = ref<{ fit: () => void } | null>(null);
const wrap = ref<HTMLElement | null>(null);

// Only worth saying when something needs attention; counts are visible on the canvas itself.
const warning = computed(() => {
  const n = graph.value?.edges.filter((e) => e.broken).length ?? 0;
  return n ? `${n} connection${n === 1 ? "" : "s"} can't resolve.` : "";
});
</script>

<template>
  <div class="flex-1 min-h-0 flex flex-col" @keydown.esc="select(null)">
    <div class="shrink-0 px-4 sm:px-6 pt-5 pb-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-[var(--fr-line)]">
      <div class="min-w-0">
        <NuxtLink to="/apps" class="inline-flex items-center gap-1.5 text-sm text-muted-color hover:text-color mb-1">
          <i class="pi pi-arrow-left text-[0.7rem]" aria-hidden="true" />Apps
        </NuxtLink>
        <h1 class="font-display text-[1.9rem] leading-none font-semibold truncate">{{ title }}</h1>
        <p v-if="warning || project?.description" class="mt-1 text-sm" :class="warning ? 'text-red-600 dark:text-red-400' : 'text-muted-color'">{{ warning || project?.description }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button label="Fit" icon="pi pi-expand" size="small" severity="secondary" @click="canvas?.fit()" />
        <NuxtLink to="/apps"><Button label="List" icon="pi pi-list" size="small" severity="secondary" tabindex="-1" /></NuxtLink>
        <DeployMenu size="small" />
      </div>
    </div>

    <div ref="wrap" class="relative flex-1 min-h-0">
      <Skeleton v-if="isLoading" class="!h-full !rounded-none" />
      <Message v-else-if="error" severity="error" class="m-6">{{ error.message }}</Message>
      <div v-else-if="graph && !graph.apps.length" class="p-6 sm:p-10">
        <div class="max-w-xl rounded-[var(--p-border-radius-lg)] border border-dashed border-[var(--p-surface-300)] dark:border-[var(--p-surface-700)] px-6 py-8">
          <h2 class="font-display font-semibold text-2xl">No apps here yet</h2>
          <p class="mt-1.5 text-muted-color">Deploy an app and move it into this project from its page. Services show up here, with an arrow wherever one connects to another.</p>
        </div>
      </div>
      <template v-else-if="graph">
        <CanvasProjectCanvas
          ref="canvas"
          :graph="graph"
          :selected="selected"
          :editable="can('deployer')"
          @select="select"
          @layout="(p) => save.mutate(p)"
        />
        <Transition name="slide">
          <div v-if="selected" class="absolute inset-y-0 right-0 w-full sm:w-[27rem] z-10">
            <CanvasPanel :graph="graph" :selection="selected" @close="select(null)" @select="select" />
          </div>
        </Transition>
      </template>
    </div>
  </div>
</template>

<style scoped>
.slide-enter-active, .slide-leave-active { transition: transform 0.18s ease, opacity 0.18s ease; }
.slide-enter-from, .slide-leave-to { transform: translateX(1.5rem); opacity: 0; }
@media (prefers-reduced-motion: reduce) { .slide-enter-active, .slide-leave-active { transition: none; } }
</style>
