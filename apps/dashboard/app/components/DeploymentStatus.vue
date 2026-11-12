<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { formatDuration, durationBetween } from "~/utils/format";
import { cancelable, isCanceled, shownStatus } from "~/utils/deployments";
import { imageHost } from "~/utils/settings";

const props = defineProps<{ id: string | null }>();
const emit = defineEmits<{ finished: [status: "success" | "failed"] }>();
const idRef = computed(() => props.id);
const { data } = useDeployment(idRef as Ref<string | null>);
const qc = useQueryClient();
const { can } = useSession();
const cancel = useCancelDeployment();

/** A failed image pull that looks like a missing or wrong login: the registry to add one for. */
const AUTH_FAIL = /unauthori[sz]ed|denied|authentication required|\b40[13]\b|incorrect username or password/i;
const authHost = computed(() => {
  const e = data.value?.error;
  const ref = e && AUTH_FAIL.test(e) ? /pulling (\S+) failed/.exec(e)?.[1] : undefined;
  return ref ? imageHost(ref) : null;
});
const loginOpen = ref(false);

watch(
  () => data.value?.status,
  (s) => {
    if (s === "success" || s === "failed") {
      void qc.invalidateQueries({ queryKey: ["app"] });
      void qc.invalidateQueries({ queryKey: ["apps"] });
      void qc.invalidateQueries({ queryKey: ["domains"] });
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
      <StatusTag :state="shownStatus(data)" />
      <Button v-if="can('deployer') && cancelable(data)" label="Cancel" size="small" text severity="danger" :loading="cancel.isPending.value" @click="cancel.mutate(data.id)" />
      <span v-if="data.releaseId" class="text-sm text-muted-color font-mono">{{ data.releaseId }}</span>
      <span v-if="data.finishedAt" class="text-sm text-muted-color">{{ formatDuration(durationBetween(data.startedAt, data.finishedAt)) }}</span>
    </div>
    <div v-if="data.commitSha" class="text-sm">
      <code class="text-xs">{{ data.commitSha.slice(0, 7) }}</code> {{ data.commitSubject }}
      <span v-if="data.commitAuthor" class="text-muted-color">{{ data.commitAuthor }}</span>
    </div>
    <BuildLog v-if="data.trigger === 'manual' || data.trigger === 'webhook'" :id="data.id" :running="data.status === 'queued' || data.status === 'running'" />
    <Message v-for="w in data.warnings" :key="w" severity="warn" size="small">{{ w }}</Message>
    <Message v-if="data.status === 'failed' && !isCanceled(data)" severity="error" size="small"><pre class="whitespace-pre-wrap font-mono text-xs">{{ data.error }}</pre></Message>
    <Message v-if="data.status === 'failed' && !isCanceled(data) && authHost" severity="warn" size="small" :closable="false">
      <div class="flex flex-wrap items-center gap-3">
        <span>This looks like a private image, or a wrong login, for <code>{{ authHost }}</code>.</span>
        <Button v-if="can('admin')" label="Add or replace the login" icon="pi pi-key" size="small" @click="loginOpen = true" />
        <span v-else>Ask an admin to add a registry login for it, then deploy again.</span>
      </div>
    </Message>
    <RegistryLoginDialog v-if="authHost" v-model:visible="loginOpen" :host="authHost" />
  </div>
  <Skeleton v-else-if="id" height="2rem" />
</template>
