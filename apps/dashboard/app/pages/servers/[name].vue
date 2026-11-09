<script setup lang="ts">
import type { ServerRow } from "~/types";
import { upgradeActive } from "~/composables/queries";
import { daysUntil, formatBytes, formatDuration, timeAgo } from "~/utils/format";

const route = useRoute();
const router = useRouter();
const name = computed(() => String(route.params.name));
const { can } = useSession();
const confirm = useConfirm();
const notify = useNotify();

const { data: servers, isLoading } = useServers();
const server = computed<ServerRow | undefined>(() => servers.value?.find((s) => s.name === name.value));
const { data: apps } = useApps();
const hosted = computed(() => (apps.value ?? []).filter((a) => a.server === name.value));
const { data: controlCommit } = useControlVersion();
useHead({ title: computed(() => `${name.value} - Servers - Freighter`) });

const isAdmin = computed(() => can("admin"));
const remote = computed(() => server.value?.kind === "remote");
const usable = computed(() => !!server.value && server.value.status !== "pending");

// ---- the agent's software: what it runs, whose HAProxy it uses, how the last upgrade went ----
const watch_ = computed(() => isAdmin.value && usable.value);
const { data: software, error: softwareError } = useServerUpgrade(name, watch_);
const upgrading = computed(() => upgradeActive(software.value?.upgrade));
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : "–");
const behind = computed(() => remote.value && server.value?.status === "online" && !!software.value?.outdated);

// ---- check for updates: the agent runs git against the repository it was installed from ----
const check = useCheckUpdates();
const ref_ = ref("");
const result = computed(() => check.data.value ?? null);
const checkedRef = computed(() => ref_.value.trim() || undefined);
const validRef = computed(() => !ref_.value.trim() || (/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(ref_.value.trim()) && !ref_.value.includes("..")));
const runCheck = () => check.mutate({ server: name.value, ref: checkedRef.value });
const stateText = computed(() => {
  const r = result.value;
  if (!r) return "";
  switch (r.state) {
    case "up-to-date": return `Up to date with ${r.ref}.`;
    case "behind": return `${r.behind === null ? "Newer commits are" : r.behind === 1 ? "1 newer commit is" : `${r.behind} newer commits are`} available on ${r.ref}.`;
    case "ahead": return `This server is newer than ${r.ref}.`;
    default: return `${r.ref} and what's installed have diverged (another branch, rewritten history, or more than 50 commits apart).`;
  }
});

// ---- controls ----
const showUpgrade = ref(false);
const showContainers = ref(false);
const showStorage = ref(false);
const checkNow = useCheckServer();
const restart = useRestartService();
function askRestart() {
  confirm.require({
    header: `Restart the agent on ${name.value}?`,
    message: "The agent is unavailable for a few seconds. Apps keep running; a deployment that is in progress is interrupted.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Restart",
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => restart.mutate({ server: name.value, service: "agent" }, { onSuccess: () => notify.ok("Restarting the agent") }),
  });
}
const reenroll = useServerEnrollment();
const enrollment = ref<Awaited<ReturnType<typeof reenroll.mutateAsync>> | null>(null);
const showEnrollment = ref(false);
async function newToken() {
  const r = await reenroll.mutateAsync(name.value).catch(() => null);
  if (r) {
    enrollment.value = r;
    showEnrollment.value = true;
  }
}
const remove = useRemoveServer();
function askRemove() {
  confirm.require({
    header: `Remove ${name.value}?`,
    message: "The server is forgotten by this control plane. Its agent keeps running until you uninstall it.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Remove",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => remove.mutate(name.value, { onSuccess: () => void router.push("/servers") }),
  });
}

const s = computed(() => server.value);
const certDays = computed(() => daysUntil(s.value?.certExpiresAt));
const certText = computed(() => (certDays.value === null ? "None" : certDays.value < 0 ? "Expired" : `${certDays.value} days left`));
const certTone = computed(() => (certDays.value === null || certDays.value < 7 ? "text-red-600 dark:text-red-400" : certDays.value < 30 ? "text-amber-600 dark:text-amber-400" : ""));
const memUsed = computed(() => (s.value?.host ? formatBytes(s.value.host.memTotal - s.value.host.memFree) : "–"));
const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader :title="name">
      <template #before>
        <NuxtLink to="/servers" class="inline-flex items-center gap-1.5 text-sm text-muted-color hover:text-color mb-1.5">
          <i class="pi pi-arrow-left text-[0.7rem]" aria-hidden="true" />Servers
        </NuxtLink>
      </template>
      <template v-if="s" #beside>
        <StatusTag :state="s.status" />
        <span class="text-sm text-muted-color">{{ s.kind === "local" ? "This machine" : s.address }}</span>
      </template>
      <template v-if="s && isAdmin" #actions>
        <Button label="Check now" icon="pi pi-refresh" text size="small" severity="secondary" :loading="checkNow.isPending.value" @click="checkNow.mutate(name)" />
        <Button v-if="remote && s.status === 'online'" :label="behind ? 'Upgrade' : 'Upgrade…'" icon="pi pi-arrow-up" size="small" :text="!behind" :severity="behind ? undefined : 'secondary'" @click="showUpgrade = true" />
        <Button v-if="s.status === 'online'" label="Restart agent" icon="pi pi-power-off" text size="small" severity="secondary" :loading="restart.isPending.value" @click="askRestart" />
      </template>
    </PageHeader>

    <Skeleton v-if="isLoading" height="12rem" />
    <Message v-else-if="!s" severity="error">No server called “{{ name }}”.</Message>

    <template v-else>
      <Message v-if="s.status === 'pending'" severity="warn" size="small">
        <template v-if="s.enrollmentPending">Run the enrollment command on the server to connect it.</template>
        <template v-else>Enrolled. Start the agent on the server with <code>systemctl restart freighter-agent</code>.</template>
      </Message>
      <Message v-else-if="s.lastError" severity="error" size="small"><span :title="s.lastError">{{ s.lastError }}</span></Message>

      <section class="flex flex-col gap-3">
        <h2 class="font-display font-semibold text-[1.2rem]">Machine</h2>
        <Facts>
          <Fact label="Hostname" :title="s.hostname ?? ''">{{ s.hostname ?? "–" }}</Fact>
          <template v-if="s.host">
            <Fact label="Up for">{{ formatDuration(s.host.uptimeSeconds * 1000) }}</Fact>
            <Fact label="Load (1 min)">{{ s.host.load1.toFixed(2) }}</Fact>
            <Fact label="Memory used" :title="`${memUsed} of ${formatBytes(s.host.memTotal)}`">{{ memUsed }}<span class="text-muted-color font-normal"> of {{ formatBytes(s.host.memTotal) }}</span></Fact>
            <Fact label="Disk free">{{ formatBytes(s.host.diskFreeBytes) }}</Fact>
            <Fact label="Container images" :title="s.host.containers?.available ? `Podman ${s.host.containers.version ?? ''}` : 'Install with --with-containers to deploy images here'">{{ !s.host.containers ? "Agent too old" : s.host.containers.available ? `Podman ${s.host.containers.version ?? ""}`.trim() : "Podman not installed" }}</Fact>
            <Fact label="S3 storage" :title="s.host.storage?.available ? `rclone ${s.host.storage.version ?? ''}` : 'Install with --with-storage to serve storages here'">{{ !s.host.storage ? "Agent too old" : s.host.storage.available ? `rclone ${s.host.storage.version ?? ""}`.trim() : "rclone not installed" }}</Fact>
          </template>
          <Fact label="Last seen" :title="s.lastSeenAt ?? ''">{{ timeAgo(s.lastSeenAt) }}</Fact>
          <Fact label="Added">{{ date(s.createdAt) }}</Fact>
        </Facts>
      </section>

      <section class="flex flex-col gap-3">
        <h2 class="font-display font-semibold text-[1.2rem]">Apps on this server</h2>
        <p v-if="!hosted.length" class="text-muted-color text-sm">None yet.</p>
        <ul v-else class="flex flex-col rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] divide-y divide-[var(--fr-line)]">
          <li v-for="a in hosted" :key="a.name" class="flex items-center gap-3 px-5 py-3">
            <NuxtLink :to="`/apps/${a.name}`" class="font-medium text-primary hover:underline">{{ a.name }}</NuxtLink>
            <span class="text-sm text-muted-color">{{ a.services.length }} {{ a.services.length === 1 ? "service" : "services" }}</span>
            <StatusTag class="ml-auto" :state="a.status" />
          </li>
        </ul>
      </section>

      <section v-if="isAdmin && usable" class="flex flex-col gap-3">
        <h2 class="font-display font-semibold text-[1.2rem]">Agent and software</h2>
        <Message v-if="softwareError" severity="error" size="small">{{ (softwareError as Error).message }}</Message>
        <Message v-else-if="software && !software.supported" severity="warn" size="small">{{ software.reason }}</Message>
        <Facts>
          <Fact label="Agent version" mono :title="software?.commit ?? s.agentVersion ?? ''">{{ short(software?.commit ?? s.agentVersion) }}</Fact>
          <Fact label="Control plane runs" mono :title="controlCommit ?? ''">{{ short(controlCommit) }}</Fact>
          <Fact v-if="software?.haproxy" label="HAProxy">{{ software.haproxy.mode === "dedicated" ? "Freighter's own" : "Yours" }}</Fact>
          <Fact v-if="remote" label="Agent certificate"><span :class="certTone">{{ certText }}</span></Fact>
        </Facts>

        <div class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] px-5 py-4 flex flex-col gap-2" aria-label="Containers">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 class="font-medium">Containers</h3>
            <Tag v-if="s.host?.containers?.available" :value="`Podman ${s.host.containers.version ?? ''}`.trim()" severity="success" />
            <Tag v-else-if="s.host" :value="s.host.containers ? 'Podman not installed' : 'Agent too old'" severity="warn" />
          </div>
          <p v-if="s.host?.containers?.available" class="text-sm text-muted-color">Apps can run container images on this server.</p>
          <template v-else-if="s.host">
            <p class="text-sm text-muted-color">
              <template v-if="!s.host.containers">This agent predates container support. Upgrade it first.</template>
              <template v-else>Apps made of container images can't run here until Podman is installed.</template>
            </p>
            <div v-if="s.host.containers && remote && s.status === 'online'" class="flex flex-wrap items-center gap-3">
              <Button label="Add container support…" icon="pi pi-box" size="small" :disabled="upgrading" @click="showContainers = true" />
              <small v-if="upgrading" class="text-muted-color">An upgrade is running; wait for it to finish.</small>
            </div>
            <div v-else-if="s.host.containers && !remote" class="flex flex-col gap-1 text-sm">
              <span class="text-muted-color">This is the machine the dashboard runs on, so re-run its installer there:</span>
              <pre class="well !break-normal overflow-auto" tabindex="0">curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --with-agent --with-containers</pre>
            </div>
          </template>
        </div>

        <div class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] px-5 py-4 flex flex-col gap-2" aria-label="S3 storage">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 class="font-medium">S3 storage</h3>
            <Tag v-if="s.host?.storage?.available" :value="`rclone ${s.host.storage.version ?? ''}`.trim()" severity="success" />
            <Tag v-else-if="s.host" :value="s.host.storage ? 'rclone not installed' : 'Agent too old'" severity="warn" />
          </div>
          <template v-if="s.host && !s.host.storage?.available">
            <p v-if="!s.host.storage" class="text-sm text-muted-color">This agent predates storage support. Upgrade it first.</p>
            <div v-else-if="remote && s.status === 'online'" class="flex flex-wrap items-center gap-3">
              <Button label="Add storage support…" icon="pi pi-database" size="small" :disabled="upgrading" @click="showStorage = true" />
              <small v-if="upgrading" class="text-muted-color">An upgrade is running; wait for it to finish.</small>
            </div>
            <div v-else-if="!remote" class="flex flex-col gap-1 text-sm">
              <span class="text-muted-color">This is the machine the dashboard runs on, so re-run its installer there:</span>
              <pre class="well !break-normal overflow-auto" tabindex="0">curl -fsSL https://raw.githubusercontent.com/stavros-tsioulis/freighter/main/infra/install.sh | sudo sh -s -- --with-agent --with-storage</pre>
            </div>
          </template>
        </div>

        <div v-if="behind" class="flex flex-wrap items-center gap-3 text-sm">
          <span class="text-amber-600 dark:text-amber-400">This server runs an older version than this dashboard.</span>
          <Button label="Upgrade…" icon="pi pi-arrow-up" size="small" @click="showUpgrade = true" />
        </div>
        <div v-if="software?.upgrade" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span class="text-muted-color">Last upgrade</span>
          <StatusTag :state="software.upgrade.state" />
          <span class="text-muted-color">{{ software.upgrade.updatedAt ? timeAgo(software.upgrade.updatedAt) : "" }}</span>
          <span v-if="software.upgrade.message" class="w-full text-muted-color">{{ software.upgrade.message }}</span>
          <Button v-if="upgrading" label="Follow it" text size="small" @click="showUpgrade = true" />
        </div>

        <div class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] px-5 py-4 flex flex-col gap-3">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex flex-col gap-1">
              <label for="up-ref" class="text-sm font-medium">Check for updates</label>
              <InputText id="up-ref" v-model="ref_" placeholder="main" autocomplete="off" class="w-48" :invalid="!validRef" :disabled="!software?.supported" @keydown.enter="validRef && runCheck()" />
            </div>
            <Button label="Check for updates" icon="pi pi-cloud-download" size="small" severity="secondary" :disabled="!validRef || !software?.supported || upgrading" :loading="check.isPending.value" @click="runCheck" />
          </div>
          <small class="text-muted-color">
            The server asks the repository it was installed from, using its own git and network. A branch, tag or commit; empty means <code>main</code>. Nothing on the server changes.
          </small>

          <template v-if="result">
            <div class="flex flex-col gap-1 border-t border-[var(--fr-line)] pt-3 text-sm">
              <p :class="result.state === 'behind' ? 'font-medium' : ''">
                {{ stateText }}
                <span class="text-muted-color">Checked {{ timeAgo(result.checkedAt) }}.</span>
              </p>
              <p class="text-muted-color">
                Installed: <code>{{ short(result.installed?.commit) }}</code><span v-if="result.installed"> {{ result.installed.subject }} ({{ date(result.installed.committedAt) }})</span>
              </p>
              <p v-if="result.state !== 'up-to-date'" class="text-muted-color">
                {{ result.ref }}: <code>{{ short(result.latest.commit) }}</code> {{ result.latest.subject }} ({{ date(result.latest.committedAt) }})
              </p>
              <p v-if="result.target && result.target !== result.latest.commit.slice(0, 12)" class="text-muted-color">
                This dashboard runs <code>{{ short(result.target) }}</code>, which is not the same commit as {{ result.ref }}.
              </p>
            </div>
            <ul v-if="result.commits.length" class="text-sm flex flex-col gap-1">
              <li v-for="c in result.commits" :key="c.sha" class="flex gap-3"><code class="text-muted-color">{{ c.sha }}</code><span>{{ c.subject }}</span></li>
              <li v-if="result.behind && result.behind > result.commits.length" class="text-muted-color">… and {{ result.behind - result.commits.length }} more</li>
            </ul>
            <div v-if="remote && result.state === 'behind' && server?.status === 'online'">
              <Button :label="`Upgrade to ${result.ref}…`" icon="pi pi-arrow-up" size="small" @click="showUpgrade = true" />
            </div>
          </template>
        </div>
      </section>

      <section v-if="isAdmin && remote" class="flex flex-col gap-3">
        <h2 class="font-display font-semibold text-[1.2rem]">Connection</h2>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <Button label="Re-enroll" icon="pi pi-key" text size="small" severity="secondary" title="Create a new enrollment command" :loading="reenroll.isPending.value" @click="newToken" />
          <Button label="Remove server" icon="pi pi-trash" text size="small" severity="danger" :disabled="s.appCount > 0" :title="s.appCount > 0 ? 'Move or delete its apps first' : 'Remove server'" @click="askRemove" />
          <span v-if="s.appCount > 0" class="text-muted-color">A server with apps can't be removed.</span>
        </div>
      </section>
    </template>

    <UpgradeDialog v-if="showUpgrade" v-model="showUpgrade" :server="name" />
    <UpgradeDialog v-if="showContainers" v-model="showContainers" :server="name" containers />
    <UpgradeDialog v-if="showStorage" v-model="showStorage" :server="name" storage />
    <Dialog v-model:visible="showEnrollment" modal header="Connect the server" :style="{ width: '40rem' }">
      <EnrollmentCommand v-if="enrollment" :info="enrollment" />
      <template #footer><Button label="Done" @click="showEnrollment = false" /></template>
    </Dialog>
  </div>
</template>
