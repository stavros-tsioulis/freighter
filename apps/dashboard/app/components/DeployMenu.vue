<script setup lang="ts">
import { Rocket } from "lucide-vue-next";
/**
 * The one "Deploy" button: asks what to deploy, then shows that kind's form. Each form has a Back button that
 * returns here. What is offered follows the signed-in role (Git links are admin-only, the others need a deployer).
 */
const props = defineProps<{ size?: "small" }>();
const { can } = useSession();

type Kind = "git" | "image" | "archive";
const choosing = ref(false);
const kind = ref<Kind | null>(null);

const options = computed(() =>
  [
    { kind: "git" as const, icon: "pi pi-github", title: "Git repository", text: "Build and deploy on every push, from a repository you link.", show: can("admin") },
    { kind: "image" as const, icon: "pi pi-box", title: "Container image", text: "Run an image from a registry, pulled by the server.", show: can("deployer") },
    { kind: "archive" as const, icon: "pi pi-upload", title: "Archive", text: "Upload a .tar.gz with an app.yaml you built yourself.", show: can("deployer") },
  ].filter((o) => o.show),
);

const open = () => {
  kind.value = null;
  choosing.value = true;
};
function pick(k: Kind) {
  choosing.value = false;
  kind.value = k;
}
function back() {
  kind.value = null;
  choosing.value = true;
}
/** A form's own visibility: closing it (cancel or x) ends the flow, Back returns to the chooser. */
const shown = (k: Kind) =>
  computed({
    get: () => kind.value === k,
    set: (v: boolean) => { if (!v && kind.value === k) kind.value = null; },
  });
const showGit = shown("git");
const showImage = shown("image");
const showArchive = shown("archive");
</script>

<template>
  <Button v-if="can('deployer')" label="Deploy" :size="props.size" @click="open">
    <template #icon><Rocket :size="props.size === 'small' ? 15 : 17" :stroke-width="2" aria-hidden="true" /></template>
  </Button>

  <Dialog v-model:visible="choosing" modal header="What do you want to deploy?" :style="{ width: '34rem' }">
    <div class="flex flex-col gap-2" role="group" aria-label="Kinds of deployment">
      <button
        v-for="o in options"
        :key="o.kind"
        type="button"
        class="flex items-start gap-4 text-left rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] px-4 py-3 hover:border-[var(--p-primary-color)] hover:bg-[var(--p-content-hover-background)] focus-visible:outline-2 focus-visible:outline-[var(--p-primary-color)]"
        @click="pick(o.kind)"
      >
        <i :class="o.icon" class="text-xl mt-0.5 text-[var(--p-primary-color)]" aria-hidden="true" />
        <span class="flex flex-col">
          <span class="font-medium">{{ o.title }}</span>
          <span class="text-sm text-muted-color">{{ o.text }}</span>
        </span>
      </button>
    </div>
  </Dialog>

  <NewFromGitDialog v-model:visible="showGit" @back="back" />
  <NewImageDialog v-model:visible="showImage" @back="back" />
  <DeployDialog v-model:visible="showArchive" @back="back" />
</template>
