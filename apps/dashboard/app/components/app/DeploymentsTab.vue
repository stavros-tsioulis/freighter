<script setup lang="ts">
import type { AppRow, DeploymentRow } from "~/types";
import { cancelable, isCanceled, shownStatus } from "~/utils/deployments";
import { durationBetween, formatDuration, shortRelease, timeAgo } from "~/utils/format";
import { commitUrl } from "~/utils/git";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const { data: deployments, isLoading } = useAppDeployments(appName);
const { data: releases } = useReleases(appName);
const { data: gitLink } = useGitLink(appName);

const showDeploy = ref(false);
const showRollback = ref(false);
const target = ref<string | undefined>();
const rollbackId = ref<string | null>(null);
const rollback = useRollback(appName);
const del = useDeleteDeployment();
const retry = useRetryDeployment();
const expanded = ref<Record<string, boolean>>({});

const choices = computed(() => {
  const list = (releases.value ?? []).filter((r) => !r.current).map((r) => ({ label: `${shortRelease(r.id)}${r.result === "failed" ? " (failed)" : ""}`, value: r.id })).reverse();
  if (target.value && !list.some((o) => o.value === target.value)) list.push({ label: `${shortRelease(target.value)} (this deployment)`, value: target.value });
  return list;
});

function openRollback(release?: string) {
  rollbackId.value = null;
  target.value = release;
  showRollback.value = true;
}
function startRollback() {
  rollback.mutate(target.value, { onSuccess: (r) => (rollbackId.value = r.id) });
}
const triggerLabel = (d: DeploymentRow) => ({ upload: "Upload", manual: "Deploy latest", webhook: "Git push", host: "Host CLI" })[d.trigger] ?? d.trigger;
const isGit = (d: DeploymentRow) => d.trigger === "manual" || d.trigger === "webhook";
const failedWithError = (d: DeploymentRow) => d.status === "failed" && !!d.error && !isCanceled(d);
const cancel = useCancelDeployment();
const confirm = useConfirm();

/** The deployment that put the release that is live now in place (the newest one, when it was deployed more than once). */
const activeId = computed(() => {
  const live = props.app.currentRelease;
  if (!live) return null;
  return (deployments.value ?? []).find((d) => d.status === "success" && d.releaseId === live)?.id ?? null;
});
const rowClass = (d: DeploymentRow) => (d.id === activeId.value ? "active-deployment" : "");
const allImages = computed(() => props.app.services.length > 0 && Object.keys(props.app.images ?? {}).length === props.app.services.length);
const canRollback = (d: DeploymentRow) => can("deployer") && d.status === "success" && !!d.releaseId && d.releaseId !== props.app.currentRelease;
const canRetry = (d: DeploymentRow) => can("deployer") && d.action === "deploy" && d.id === activeId.value && d.status === "success" && (!!gitLink.value || allImages.value);
const canDelete = (d: DeploymentRow) => can("deployer") && !cancelable(d);
const anyActions = (d: DeploymentRow) => (can("deployer") && cancelable(d)) || canRollback(d) || canRetry(d) || canDelete(d);
const commitHref = (d: DeploymentRow) => commitUrl(gitLink.value, d.commitSha);
const commitTitle = (d: DeploymentRow) => [d.commitSha, d.commitSubject].filter(Boolean).join(" ");

function askCancel(d: DeploymentRow) {
  confirm.require({
    header: "Cancel this deployment?",
    message: d.status === "queued" ? "It has not started and won't." : "It stops on the server. If the new release was already being switched in, the running one is kept or put back.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Cancel deployment",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Keep going" },
    accept: () => cancel.mutate(d.id),
  });
}
function askDelete(d: DeploymentRow) {
  confirm.require({
    header: "Delete this deployment?",
    message: "Its record and build log are forgotten here. The release keeps running and nothing on the server changes.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Delete",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => del.mutate(d.id),
  });
}
function retryDeployment(d: DeploymentRow) {
  retry.mutate({ id: d.id, app: props.app.name });
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="can('deployer')" class="flex flex-wrap items-center gap-2">
      <p class="text-sm text-muted-color mr-auto">Open a row for its build log and details.</p>
      <Button label="Roll back" icon="pi pi-history" severity="secondary" outlined size="small" @click="openRollback()" />
      <Button label="Upload archive" icon="pi pi-upload" size="small" @click="showDeploy = true" />
    </div>

    <DataTable scrollable v-model:expanded-rows="expanded" :value="deployments ?? []" :loading="isLoading" data-key="id" paginator :rows="10" :rows-per-page-options="[10, 25, 50]" :row-class="rowClass">
      <template #empty><span class="text-muted-color">No deployments recorded yet.</span></template>
      <Column expander style="width: 3rem" />
      <Column header="When">
        <template #body="{ data }"><span :title="data.createdAt">{{ timeAgo(data.createdAt) }}</span></template>
      </Column>
      <Column header="Action"><template #body="{ data }">{{ data.action === "rollback" ? "Rollback" : "Deploy" }}</template></Column>
      <Column header="Status">
        <template #body="{ data }">
          <div class="flex items-center gap-2">
            <StatusTag :state="shownStatus(data)" />
            <span v-if="data.id === activeId" class="active-badge" title="The release this deployment put live is running now">Active</span>
          </div>
        </template>
      </Column>
      <Column header="Release">
        <template #body="{ data }"><span class="font-mono text-xs">{{ shortRelease(data.releaseId) }}</span></template>
      </Column>
      <Column header="Commit" style="width: 12rem">
        <template #body="{ data }">
          <template v-if="data.commitSha">
            <a v-if="commitHref(data)" :href="commitHref(data) ?? undefined" target="_blank" rel="noopener noreferrer" class="commit-line" :title="`${commitTitle(data)}\nOpen the commit`">
              <span class="commit-subject">{{ data.commitSubject || "—" }}</span>
            </a>
            <span v-else class="commit-line" :title="commitTitle(data)">
              <span class="commit-subject">{{ data.commitSubject || "—" }}</span>
            </span>
          </template>
          <span v-else class="text-muted-color">–</span>
        </template>
      </Column>
      <Column header="From">
        <template #body="{ data }"><span class="font-mono text-xs text-muted-color">{{ shortRelease(data.previousRelease) }}</span></template>
      </Column>
      <Column header="Started by">
        <template #body="{ data }"><span class="text-sm text-muted-color whitespace-nowrap">{{ triggerLabel(data) }}</span></template>
      </Column>
      <Column header="Took">
        <template #body="{ data }">{{ formatDuration(durationBetween(data.startedAt, data.finishedAt)) }}</template>
      </Column>
      <Column header="Actions" style="width: 9rem">
        <template #body="{ data }">
          <div class="actions-cell">
            <Button v-if="can('deployer') && cancelable(data)" icon="pi pi-times" text rounded size="small" severity="danger" :loading="cancel.isPending.value && cancel.variables.value === data.id" :aria-label="`Cancel deployment ${shortRelease(data.releaseId)}`" title="Cancel deployment" @click.stop="askCancel(data)" />
            <Button v-if="canRollback(data)" icon="pi pi-history" text rounded size="small" severity="secondary" :aria-label="`Roll back to ${shortRelease(data.releaseId)}`" title="Roll back to this deployment" @click.stop="openRollback(data.releaseId ?? undefined)" />
            <Button v-if="canRetry(data)" icon="pi pi-refresh" text rounded size="small" severity="secondary" :loading="retry.isPending.value && retry.variables.value?.id === data.id" :aria-label="`Retry deployment ${shortRelease(data.releaseId)}`" title="Retry this deployment" @click.stop="retryDeployment(data)" />
            <Button v-if="canDelete(data)" icon="pi pi-trash" text rounded size="small" severity="danger" :loading="del.isPending.value && del.variables.value === data.id" :aria-label="`Delete deployment ${shortRelease(data.releaseId)}`" title="Delete deployment" @click.stop="askDelete(data)" />
            <span v-if="!anyActions(data)" class="text-muted-color">–</span>
          </div>
        </template>
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

    <Dialog v-model:visible="showRollback" modal header="Roll back" :style="{ width: '32rem' }">
      <div class="flex flex-col gap-3">
        <p v-if="!rollbackId" class="text-sm text-muted-color">Switches traffic back to an earlier release that is still on the server. Nothing is rebuilt.</p>
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

<style scoped>
/* Rows are read across, not wrapped: a long subject or error stays on its line and the table scrolls. */
:deep(.p-datatable-thead > tr > th),
:deep(.p-datatable-tbody > tr:not(.p-datatable-row-expansion) > td) {
  white-space: nowrap;
}
.commit-line {
  display: inline-flex;
  align-items: center;
  color: var(--p-text-color-secondary);
  gap: 0.45rem;
  min-width: 0;
  max-width: 12rem;
  color: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.commit-line .commit-subject {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a.commit-line:hover .commit-subject {
  text-decoration: underline;
}
.active-badge {
  padding: 0.08rem 0.45rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--p-primary-color) 35%, transparent);
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
  color: var(--p-primary-color);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.actions-cell {
  display: flex;
  align-items: center;
  justify-content: end;
  gap: 0.15rem;
}
:deep(.p-datatable-tbody > tr.active-deployment > td) {
  background: color-mix(in srgb, var(--p-primary-color) 7%, var(--fr-panel));
}
:deep(.p-datatable-tbody > tr.active-deployment > td:first-child) {
  box-shadow: inset 3px 0 0 var(--p-primary-color);
}
</style>
