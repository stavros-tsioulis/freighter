<script setup lang="ts">
import type { Enrollment, ServerRow } from "~/types";
import { IDENT_RE } from "~/utils/validation";
import { daysUntil, formatBytes, formatDuration, timeAgo } from "~/utils/format";

const { can } = useSession();
const { data: servers, isLoading } = useServers();
const add = useAddServer();
const reenroll = useServerEnrollment();
const check = useCheckServer();
const remove = useRemoveServer();
const confirm = useConfirm();
const { data: controlCommit } = useControlVersion();
const upgrading = ref<string | null>(null);
const showUpgrade = computed({ get: () => upgrading.value !== null, set: (v) => { if (!v) upgrading.value = null; } });
const behind = (s: ServerRow) => s.kind === "remote" && s.status === "online" && !!s.agentVersion && !!controlCommit.value && s.agentVersion !== controlCommit.value;

const showAdd = ref(false);
const name = ref("");
const address = ref("");
const enrollment = ref<Enrollment | null>(null);
const showEnrollment = ref(false);

const nameError = computed(() => (name.value && (!IDENT_RE.test(name.value) || name.value === "local") ? "Lowercase letters, digits and single hyphens (not “local”)" : ""));
const validAdd = computed(() => IDENT_RE.test(name.value) && name.value !== "local" && /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/.test(address.value.trim()));

function openAdd() {
  name.value = "";
  address.value = "";
  showAdd.value = true;
}
async function submitAdd() {
  const r = await add.mutateAsync({ name: name.value, address: address.value.trim() }).catch(() => null);
  if (r) {
    showAdd.value = false;
    enrollment.value = r;
    showEnrollment.value = true;
  }
}
async function newToken(s: ServerRow) {
  const r = await reenroll.mutateAsync(s.name).catch(() => null);
  if (r) {
    enrollment.value = r;
    showEnrollment.value = true;
  }
}
function askRemove(s: ServerRow) {
  confirm.require({
    header: `Remove ${s.name}?`,
    message: "The server is forgotten by this control plane. Its agent keeps running until you uninstall it.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Remove",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => remove.mutate(s.name),
  });
}

useHead({ title: "Servers - Freighter" });
const certDays = (s: ServerRow) => daysUntil(s.certExpiresAt);
const memUsed = (s: ServerRow) => (s.host ? formatBytes(s.host.memTotal - s.host.memFree) : "–");
const memPct = (s: ServerRow) => (s.host && s.host.memTotal ? Math.round(((s.host.memTotal - s.host.memFree) / s.host.memTotal) * 100) : null);
const certText = (s: ServerRow) => {
  const d = certDays(s);
  return d === null ? "None" : d < 0 ? "Expired" : `${d} days left`;
};
const certTone = (s: ServerRow) => {
  const d = certDays(s);
  return d === null || d < 7 ? "text-red-600 dark:text-red-400" : d < 30 ? "text-amber-600 dark:text-amber-400" : "";
};
const online = computed(() => (servers.value ?? []).filter((s) => s.status === "online").length);
const summary = computed(() => {
  const list = servers.value ?? [];
  if (!list.length) return "";
  const down = list.filter((s) => s.status === "offline" || s.status === "error").map((s) => s.name);
  return down.length ? `${online.value} of ${list.length} online. Can't reach ${down.join(", ")}.` : `${list.length === 1 ? "The server is" : `All ${list.length} servers are`} online.`;
});
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Servers">
      {{ summary || "Machines that run your apps." }}
      <template #actions>
        <Button v-if="can('admin')" label="Add server" icon="pi pi-plus" size="small" @click="openAdd" />
      </template>
    </PageHeader>

    <Skeleton v-if="isLoading" height="10rem" />
    <ul v-else class="flex flex-col gap-5">
      <li v-for="s in servers" :key="s.name" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 class="font-display font-semibold text-[1.5rem] leading-tight">{{ s.name }}</h2>
          <StatusTag :state="s.status" />
          <span class="text-sm text-muted-color truncate">{{ s.address ?? "This machine" }}</span>
          <div v-if="can('admin')" class="ml-auto flex gap-1">
            <Button label="Check now" icon="pi pi-refresh" text size="small" severity="secondary" :loading="check.isPending.value && check.variables.value === s.name" @click="check.mutate(s.name)" />
            <template v-if="s.kind === 'remote'">
              <Button v-if="s.status === 'online'" :label="behind(s) ? 'Upgrade' : 'Upgrade…'" icon="pi pi-arrow-up" :text="!behind(s)" size="small" :severity="behind(s) ? undefined : 'secondary'" title="Upgrade this server's agent" @click="upgrading = s.name" />
              <Button label="Re-enroll" icon="pi pi-key" text size="small" severity="secondary" title="Create a new enrollment command" @click="newToken(s)" />
              <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Remove server" :title="s.appCount > 0 ? 'Move or delete its apps first' : 'Remove server'" :disabled="s.appCount > 0" @click="askRemove(s)" />
            </template>
          </div>
        </div>
        <Message v-if="s.status === 'pending'" severity="warn" size="small">
          <template v-if="s.enrollmentPending">Run the enrollment command on the server to connect it.</template>
          <template v-else>Enrolled. Start the agent on the server with <code>systemctl restart freighter-agent</code>.</template>
        </Message>
        <Message v-else-if="s.lastError" severity="error" size="small"><span class="line-clamp-2" :title="s.lastError">{{ s.lastError }}</span></Message>

        <Facts>
          <template v-if="s.host">
            <Fact label="Hostname" :title="s.hostname ?? ''">{{ s.hostname }}</Fact>
            <Fact label="Up for">{{ formatDuration(s.host.uptimeSeconds * 1000) }}</Fact>
            <Fact label="Load (1 min)">{{ s.host.load1.toFixed(2) }}</Fact>
            <Fact label="Memory used" :title="`${memUsed(s)} of ${formatBytes(s.host.memTotal)}`">
              {{ memUsed(s) }}<span class="text-muted-color font-normal"> of {{ formatBytes(s.host.memTotal) }}</span>
              <span class="meter" :style="{ '--v': `${memPct(s) ?? 0}%` }" aria-hidden="true" />
            </Fact>
            <Fact label="Disk free">{{ formatBytes(s.host.diskFreeBytes) }}</Fact>
          </template>
          <Fact label="Apps">{{ s.appCount }}</Fact>
          <Fact label="Last seen" :title="s.lastSeenAt ?? ''">{{ timeAgo(s.lastSeenAt) }}</Fact>
          <Fact label="Agent" :title="behind(s) ? `This dashboard runs ${controlCommit}` : ''">
            {{ s.agentVersion ?? "–" }}
            <span v-if="behind(s) && can('admin')" class="text-amber-600 dark:text-amber-400 font-normal text-sm"> · update available</span>
          </Fact>
          <Fact v-if="s.kind === 'remote'" label="Agent certificate"><span :class="certTone(s)">{{ certText(s) }}</span></Fact>
        </Facts>
      </li>
    </ul>

    <Dialog v-model:visible="showAdd" modal header="Add a server" :style="{ width: '30rem' }">
      <form class="flex flex-col gap-4" @submit.prevent="validAdd && submitAdd()">
        <p class="text-sm text-muted-color">Freighter gives you a one-time command to run on the new server. The agent then connects back to this dashboard.</p>
        <div class="flex flex-col gap-1">
          <label for="srv-name" class="text-sm font-medium">Name</label>
          <InputText id="srv-name" v-model="name" placeholder="vps-fra-1" :invalid="!!nameError" autocomplete="off" />
          <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
        </div>
        <div class="flex flex-col gap-1">
          <label for="srv-addr" class="text-sm font-medium">Agent address</label>
          <InputText id="srv-addr" v-model="address" placeholder="vps1.example.com or 203.0.113.7:7443" autocomplete="off" />
          <small class="text-muted-color">Host name or IP this dashboard connects to. Port 7443 unless you add one.</small>
        </div>
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="showAdd = false" />
        <Button label="Add server" :disabled="!validAdd" :loading="add.isPending.value" @click="submitAdd" />
      </template>
    </Dialog>

    <UpgradeDialog v-if="upgrading" v-model="showUpgrade" :server="upgrading" />

    <Dialog v-model:visible="showEnrollment" modal header="Connect the server" :style="{ width: '40rem' }">
      <EnrollmentCommand v-if="enrollment" :info="enrollment" />
      <template #footer><Button label="Done" @click="showEnrollment = false" /></template>
    </Dialog>
  </div>
</template>

<style scoped>
.meter {
  display: block;
  height: 3px;
  margin-top: 0.4rem;
  border-radius: 2px;
  background: linear-gradient(to right, var(--p-primary-color) var(--v), var(--fr-line) var(--v));
}
</style>
