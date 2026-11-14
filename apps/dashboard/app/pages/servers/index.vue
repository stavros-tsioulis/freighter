<script setup lang="ts">
import type { Enrollment, ServerRow } from "~/types";
import { IDENT_RE } from "~/utils/validation";

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
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Servers">
      <template #actions>
        <Button v-if="can('admin')" label="Add server" icon="pi pi-plus" size="small" @click="openAdd" />
      </template>
    </PageHeader>

    <Skeleton v-if="isLoading" height="12rem" />
    <p v-else-if="!servers?.length" class="text-muted-color">No servers yet. Add one to start deploying.</p>
    <ul v-else class="flex flex-col gap-6">
      <li v-for="s in servers" :key="s.name" class="flex flex-col gap-2.5">
        <ServerCard
          :server="s"
          :to="`/servers/${s.name}`"
          :behind="behind(s)"
          :admin="can('admin')"
          :checking="check.isPending.value && check.variables.value === s.name"
          @check="check.mutate(s.name)"
          @upgrade="upgrading = s.name"
          @reenroll="newToken(s)"
          @remove="askRemove(s)"
        />
        <Message v-if="s.status === 'pending'" severity="warn" size="small">
          <template v-if="s.enrollmentPending">Run the enrollment command on the server to connect it.</template>
          <template v-else>Enrolled. Start the agent on the server with <code>systemctl restart freighter-agent</code>.</template>
        </Message>
        <Message v-else-if="s.lastError" severity="error" size="small"><span class="line-clamp-2" :title="s.lastError">{{ s.lastError }}</span></Message>
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

