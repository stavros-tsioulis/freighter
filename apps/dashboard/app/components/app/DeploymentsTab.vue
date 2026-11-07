<script setup lang="ts">
import type { AppRow, DeploymentRow } from "~/types";
import { durationBetween, formatDuration, shortRelease, timeAgo } from "~/utils/format";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const { data: deployments, isLoading } = useAppDeployments(appName);
const { data: releases } = useReleases(appName);

const showDeploy = ref(false);
const showRollback = ref(false);
const target = ref<string | undefined>();
const rollbackId = ref<string | null>(null);
const rollback = useRollback(appName);
const expanded = ref<Record<string, boolean>>({});

const choices = computed(() => (releases.value ?? []).filter((r) => !r.current).map((r) => ({ label: `${shortRelease(r.id)}${r.result === "failed" ? " (failed)" : ""}`, value: r.id })).reverse());
watch(showRollback, (v) => {
  if (v) {
    rollbackId.value = null;
    target.value = undefined;
  }
});

function startRollback() {
  rollback.mutate(target.value, { onSuccess: (r) => (rollbackId.value = r.id) });
}
const triggerLabel = (d: DeploymentRow) => ({ upload: "upload", manual: "deploy latest", webhook: "push", host: "host CLI" })[d.trigger] ?? d.trigger;
const isGit = (d: DeploymentRow) => d.trigger === "manual" || d.trigger === "webhook";
const failedWithError = (d: DeploymentRow) => d.status === "failed" && !!d.error;
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="can('deployer')" class="flex gap-2 justify-end">
      <Button label="Roll back" icon="pi pi-history" severity="secondary" outlined size="small" @click="showRollback = true" />
      <Button label="Deploy" icon="pi pi-upload" size="small" @click="showDeploy = true" />
    </div>

    <DataTable scrollable v-model:expanded-rows="expanded" :value="deployments ?? []" :loading="isLoading" data-key="id" size="small" striped-rows paginator :rows="10" :rows-per-page-options="[10, 25, 50]">
      <template #empty><span class="text-muted-color">No deployments recorded yet.</span></template>
      <Column expander style="width: 3rem" />
      <Column header="When">
        <template #body="{ data }"><span :title="data.createdAt">{{ timeAgo(data.createdAt) }}</span></template>
      </Column>
      <Column header="Action" field="action" />
      <Column header="Status">
        <template #body="{ data }"><StatusTag :state="data.status" /></template>
      </Column>
      <Column header="Release">
        <template #body="{ data }"><span class="font-mono text-xs">{{ shortRelease(data.releaseId) }}</span></template>
      </Column>
      <Column header="Commit">
        <template #body="{ data }">
          <div v-if="data.commitSha" class="max-w-64">
            <code class="text-xs">{{ data.commitSha.slice(0, 7) }}</code>
            <div class="text-xs text-muted-color truncate" :title="data.commitSubject ?? ''">{{ data.commitSubject }}</div>
          </div>
          <span v-else class="text-muted-color">–</span>
        </template>
      </Column>
      <Column header="From">
        <template #body="{ data }"><span class="font-mono text-xs text-muted-color">{{ shortRelease(data.previousRelease) }}</span></template>
      </Column>
      <Column header="Trigger">
        <template #body="{ data }"><Tag :value="triggerLabel(data)" severity="secondary" /></template>
      </Column>
      <Column header="Took">
        <template #body="{ data }">{{ formatDuration(durationBetween(data.startedAt, data.finishedAt)) }}</template>
      </Column>
      <template #expansion="{ data }">
        <div class="p-3 text-sm flex flex-col gap-2">
          <div class="grid grid-cols-[8rem_1fr] gap-y-1">
            <span class="text-muted-color">Deployment</span><span class="font-mono text-xs">{{ data.id }}</span>
            <span class="text-muted-color">Requested by</span><span class="font-mono text-xs">{{ data.requestedBy ?? "host CLI" }}</span>
            <template v-if="data.artifactSha256"><span class="text-muted-color">SHA-256</span><span class="font-mono text-xs break-all">{{ data.artifactSha256 }}</span></template>
          </div>
          <div v-if="data.commitSha" class="text-sm">
            <code class="text-xs">{{ data.commitSha }}</code> {{ data.commitSubject }}
            <span v-if="data.commitAuthor" class="text-muted-color">{{ data.commitAuthor }}</span>
          </div>
          <BuildLog v-if="isGit(data)" :id="data.id" :running="data.status === 'queued' || data.status === 'running'" />
          <Message v-for="w in data.warnings" :key="w" severity="warn" size="small">{{ w }}</Message>
          <Message v-if="failedWithError(data)" severity="error" size="small"><pre class="whitespace-pre-wrap font-mono text-xs">{{ data.error }}</pre></Message>
        </div>
      </template>
    </DataTable>

    <DeployDialog v-model:visible="showDeploy" :app="app.name" />

    <Dialog v-model:visible="showRollback" modal header="Roll back" :style="{ width: '30rem' }">
      <div class="flex flex-col gap-3">
        <div v-if="!rollbackId" class="flex flex-col gap-1">
          <label for="rb-target" class="text-sm font-medium">Release</label>
          <Select id="rb-target" v-model="target" :options="choices" option-label="label" option-value="value" placeholder="Previous good release (default)" show-clear />
        </div>
        <DeploymentStatus v-if="rollbackId" :id="rollbackId" />
      </div>
      <template #footer>
        <Button :label="rollbackId ? 'Close' : 'Cancel'" severity="secondary" text @click="showRollback = false" />
        <Button v-if="!rollbackId" label="Roll back" icon="pi pi-history" :loading="rollback.isPending.value" @click="startRollback" />
      </template>
    </Dialog>
  </div>
</template>
