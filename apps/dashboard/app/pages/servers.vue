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

const statusSeverity = (s: ServerRow["status"]) => ({ online: "success", offline: "danger", pending: "warn", error: "danger" })[s] as "success" | "danger" | "warn";
const certDays = (s: ServerRow) => daysUntil(s.certExpiresAt);
const used = (s: ServerRow) => (s.host ? formatBytes(s.host.memTotal - s.host.memFree) + " / " + formatBytes(s.host.memTotal) : "–");
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-semibold">Servers</h1>
      <Button v-if="can('admin')" label="Add server" icon="pi pi-plus" size="small" @click="openAdd" />
    </div>

    <Skeleton v-if="isLoading" height="8rem" />
    <ul v-else class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <li v-for="s in servers" :key="s.name" class="relative rounded-lg border border-surface bg-surface-0 dark:bg-surface-900 p-5 flex flex-col gap-4">
        <span class="absolute -top-1.5 -left-1.5 size-3.5 rounded-full ring-4 ring-surface-0 dark:ring-surface-950" :class="s.status === 'online' ? 'bg-green-500' : s.status === 'pending' ? 'bg-amber-500' : 'bg-red-500'" aria-hidden="true" />
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="font-semibold text-lg truncate">{{ s.name }}</h2>
            <p class="text-sm text-muted-color truncate">{{ s.address ?? "this host" }}</p>
          </div>
          <Tag :value="s.status" :severity="statusSeverity(s.status)" />
        </div>
        <p v-if="s.status === 'pending'" class="text-sm text-muted-color">{{ s.enrollmentPending ? "Waiting for enrollment" : "Token used; start the agent" }}</p>
        <p v-else-if="s.lastError" class="text-sm text-red-500 line-clamp-2" :title="s.lastError">{{ s.lastError }}</p>

        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <template v-if="s.host">
            <dt class="text-muted-color">Host</dt><dd class="truncate">{{ s.hostname }}, up {{ formatDuration(s.host.uptimeSeconds * 1000) }}</dd>
            <dt class="text-muted-color">Load</dt><dd>{{ s.host.load1.toFixed(2) }}</dd>
            <dt class="text-muted-color">Memory</dt><dd>{{ used(s) }}</dd>
            <dt class="text-muted-color">Disk free</dt><dd>{{ formatBytes(s.host.diskFreeBytes) }}</dd>
          </template>
          <dt class="text-muted-color">Agent</dt><dd>{{ s.agentVersion ?? "–" }}</dd>
          <dt class="text-muted-color">Last seen</dt><dd :title="s.lastSeenAt ?? ''">{{ timeAgo(s.lastSeenAt) }}</dd>
          <template v-if="s.kind === 'remote'">
            <dt class="text-muted-color">Certificate</dt>
            <dd>
              <Tag v-if="certDays(s) === null" value="none" severity="secondary" />
              <Tag v-else :value="certDays(s)! < 0 ? 'expired' : `${certDays(s)} days`" :severity="certDays(s)! < 7 ? 'danger' : certDays(s)! < 30 ? 'warn' : 'success'" />
            </dd>
          </template>
          <dt class="text-muted-color">Apps</dt><dd>{{ s.appCount }}</dd>
        </dl>

        <div v-if="can('admin')" class="flex gap-1 justify-end mt-auto -mb-2 -mr-2">
          <Button icon="pi pi-heart" text rounded size="small" severity="secondary" aria-label="Check now" :loading="check.isPending.value && check.variables.value === s.name" @click="check.mutate(s.name)" />
          <template v-if="s.kind === 'remote'">
            <Button icon="pi pi-key" text rounded size="small" severity="secondary" aria-label="New enrollment token" @click="newToken(s)" />
            <Button icon="pi pi-trash" text rounded size="small" severity="danger" aria-label="Remove server" :disabled="s.appCount > 0" @click="askRemove(s)" />
          </template>
        </div>
      </li>
    </ul>

    <Dialog v-model:visible="showAdd" modal header="Add a server" :style="{ width: '30rem' }">
      <form class="flex flex-col gap-3" @submit.prevent="validAdd && submitAdd()">
        <div class="flex flex-col gap-1">
          <label for="srv-name" class="text-sm font-medium">Name</label>
          <InputText id="srv-name" v-model="name" placeholder="e.g. vps-fra-1" :invalid="!!nameError" autocomplete="off" />
          <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
        </div>
        <div class="flex flex-col gap-1">
          <label for="srv-addr" class="text-sm font-medium">Agent address</label>
          <InputText id="srv-addr" v-model="address" placeholder="vps1.example.com or 203.0.113.7:7443" autocomplete="off" />
          <small class="text-muted-color">Host name or IP the control plane connects to (default port 7443).</small>
        </div>
        <button type="submit" class="hidden" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="showAdd = false" />
        <Button label="Add" icon="pi pi-check" :disabled="!validAdd" :loading="add.isPending.value" @click="submitAdd" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showEnrollment" modal header="Enroll the server" :style="{ width: '40rem' }">
      <EnrollmentCommand v-if="enrollment" :info="enrollment" />
      <template #footer><Button label="Done" @click="showEnrollment = false" /></template>
    </Dialog>
  </div>
</template>
