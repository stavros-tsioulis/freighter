<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { formatDuration, durationBetween } from "~/utils/format";

const props = defineProps<{ id: string | null }>();
const emit = defineEmits<{ finished: [status: "success" | "failed"] }>();
const idRef = computed(() => props.id);
const { data } = useDeployment(idRef as Ref<string | null>);
const qc = useQueryClient();

watch(
  () => data.value?.status,
  (s) => {
    if (s === "success" || s === "failed") {
      void qc.invalidateQueries({ queryKey: ["app"] });
      void qc.invalidateQueries({ queryKey: ["apps"] });
      void qc.invalidateQueries({ queryKey: ["app-deployments"] });
      void qc.invalidateQueries({ queryKey: ["deployments"] });
      emit("finished", s);
    }
  },
);
</script>

<template>
  <div v-if="data" class="flex flex-col gap-2" aria-live="polite">
    <div class="flex items-center gap-2">
      <StatusTag :state="data.status" />
      <span v-if="data.releaseId" class="text-sm text-muted-color font-mono">{{ data.releaseId }}</span>
      <span v-if="data.finishedAt" class="text-sm text-muted-color">{{ formatDuration(durationBetween(data.startedAt, data.finishedAt)) }}</span>
    </div>
    <div v-if="data.commitSha" class="text-sm">
      <code class="text-xs">{{ data.commitSha.slice(0, 7) }}</code> {{ data.commitSubject }}
      <span v-if="data.commitAuthor" class="text-muted-color">{{ data.commitAuthor }}</span>
    </div>
    <BuildLog v-if="data.trigger === 'manual' || data.trigger === 'webhook'" :id="data.id" :running="data.status === 'queued' || data.status === 'running'" />
    <Message v-for="w in data.warnings" :key="w" severity="warn" size="small">{{ w }}</Message>
    <Message v-if="data.status === 'failed'" severity="error" size="small"><pre class="whitespace-pre-wrap font-mono text-xs">{{ data.error }}</pre></Message>
  </div>
  <Skeleton v-else-if="id" height="2rem" />
</template>
