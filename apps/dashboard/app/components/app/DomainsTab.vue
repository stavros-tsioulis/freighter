<script setup lang="ts">
import type { AppRow } from "~/types";
import type { DomainRow } from "~/composables/queries";
import { timeAgo } from "~/utils/format";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const notify = useNotify();
const confirm = useConfirm();
const appName = computed(() => props.app.name);
const { data, isLoading } = useDomains(appName);
const add = useAddDomain(appName);
const verify = useVerifyDomain(appName);
const remove = useRemoveDomain(appName);

const domains = computed(() => data.value?.domains ?? []);
const records = computed(() => data.value?.dns.records ?? []);
const services = computed(() => props.app.services.map((s) => s.name));
const tls = [{ label: "Automatic HTTPS", value: "auto" }, { label: "HTTP only", value: "off" }];
const HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

// ---- add ----
const showAdd = ref(false);
const hostname = ref("");
const service = ref("");
const https = ref<"auto" | "off">("auto");
const clean = computed(() => hostname.value.trim().toLowerCase());
const hostError = computed(() => {
  if (!clean.value) return "";
  if (clean.value !== "localhost" && !HOST_RE.test(clean.value)) return "A lowercase DNS name such as shop.example.com (no wildcards).";
  if (domains.value.some((d) => d.hostname === clean.value)) return "Already added.";
  return "";
});
const validAdd = computed(() => HOST_RE.test(clean.value) && !hostError.value && !!service.value);

function openAdd() {
  hostname.value = "";
  service.value = services.value[0] ?? "";
  https.value = "auto";
  showAdd.value = true;
}
async function submitAdd() {
  const ok = await add.mutateAsync({ hostname: clean.value, service: service.value, tls: https.value }).then(() => true).catch(() => false);
  if (ok) showAdd.value = false;
}

// ---- verify / remove ----
const deployedId = ref<string | null>(null);
const showDeployment = ref(false);
const checking = computed(() => (verify.isPending.value ? verify.variables.value : null));
async function runVerify(d: DomainRow) {
  const r = await verify.mutateAsync(d.hostname).catch(() => null);
  if (!r) return;
  if (r.verified && r.id) {
    if (r.method === "http") notify.ok("Reached through Cloudflare's proxy", `${d.hostname} answers from this server.`);
    deployedId.value = r.id;
    showDeployment.value = true;
  } else {
    notify.fail(r.cloudflare ? "Couldn't reach the server through Cloudflare" : "DNS isn't set up yet", new Error(r.reason ?? "The records don't match."));
  }
}
function askRemove(d: DomainRow) {
  confirm.require({
    header: `Remove ${d.hostname}?`,
    message: d.status === "active" ? "The app stops being served on this hostname. Nothing is redeployed or rebuilt, and the services keep running." : "The domain is deleted from this app.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Remove",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: async () => {
      const r = await remove.mutateAsync(d.hostname).catch(() => null);
      if (r?.id) {
        deployedId.value = r.id;
        showDeployment.value = true;
      }
    },
  });
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok("Copied");
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}
const isLocalName = (h: string) => h === "localhost" || h.endsWith(".localhost");
const url = (d: DomainRow) => `${d.tls === "auto" ? "https" : "http"}://${d.hostname}`;
</script>

<template>
  <div class="flex flex-col gap-4 max-w-4xl">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-muted-color">Hostnames that route to this app's services.</p>
      <Button v-if="can('admin')" label="Add domain" icon="pi pi-plus" size="small" @click="openAdd" />
    </div>

    <Skeleton v-if="isLoading" height="6rem" />
    <p v-else-if="!domains.length" class="text-muted-color">No domains yet. Add one to serve the app on your own hostname.</p>

    <ul v-else class="flex flex-col gap-3">
      <li v-for="d in domains" :key="d.hostname" class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)]">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
          <div class="min-w-0 flex-1">
            <a v-if="d.status === 'active'" :href="url(d)" target="_blank" rel="noopener" class="font-medium text-primary hover:underline break-all">{{ d.hostname }}</a>
            <span v-else class="font-medium break-all">{{ d.hostname }}</span>
            <p class="text-sm text-muted-color">{{ d.service }}, {{ d.tls === "auto" ? "automatic HTTPS" : "HTTP only" }}</p>
          </div>
          <Tag :value="d.status === 'active' ? 'Live' : 'Waiting for DNS'" :severity="d.status === 'active' ? 'success' : 'warn'" />
          <div v-if="can('admin')" class="flex items-center gap-1">
            <Button v-if="d.status === 'pending'" label="Verify" icon="pi pi-check-circle" size="small" :loading="checking === d.hostname" @click="runVerify(d)" />
            <Button icon="pi pi-trash" text rounded severity="danger" size="small" aria-label="Remove domain" @click="askRemove(d)" />
          </div>
        </div>

        <div v-if="d.status === 'pending'" class="border-t border-[var(--fr-line)] px-5 py-4 flex flex-col gap-3 text-sm">
          <p v-if="isLocalName(d.hostname)">Names ending in <code>.localhost</code> need no DNS setup. Verify to put it live.</p>
          <template v-else-if="records.length">
            <p>At your DNS provider, add {{ records.length > 1 ? "these records" : "this record" }} for <b>{{ d.hostname }}</b>, then verify:</p>
            <div class="overflow-x-auto">
              <table class="text-left">
                <thead class="text-muted-color"><tr><th class="pr-6 font-normal">Type</th><th class="pr-6 font-normal">Name</th><th class="font-normal">Value</th></tr></thead>
                <tbody>
                  <tr v-for="r in records" :key="r.type + r.value">
                    <td class="pr-6 py-1 font-mono">{{ r.type }}</td>
                    <td class="pr-6 py-1 font-mono break-all">{{ d.hostname }}</td>
                    <td class="py-1 font-mono">{{ r.value }} <Button icon="pi pi-copy" text rounded size="small" severity="secondary" :aria-label="`Copy ${r.value}`" @click="copy(r.value)" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="text-muted-color">Your provider may ask for the name as <code>{{ d.hostname.split(".").slice(0, -2).join(".") || "@" }}</code> instead of the full hostname. Changes can take a few minutes to spread.</p>
            <p class="text-muted-color">Using Cloudflare? Either mode works: leave the record as <b>DNS only</b> (grey cloud) or <b>Proxied</b> (orange cloud). A proxied name can't show where it points, so Freighter checks that a request for it reaches this server instead.</p>
          </template>
          <p v-else>Freighter doesn't know this server's public IP address. Set <code>api.publicIps</code> in <code>/etc/freighter/config.yaml</code>, restart the dashboard, and the records to add will appear here.</p>
          <Message v-if="d.lastError" severity="warn" size="small">
            {{ d.lastError }}<span v-if="d.checkedAt" class="text-muted-color"> Checked {{ timeAgo(d.checkedAt) }}.</span>
          </Message>
        </div>
      </li>
    </ul>

    <Dialog v-model:visible="showAdd" modal header="Add domain" :style="{ width: '30rem' }" :closable="!add.isPending.value">
      <form class="flex flex-col gap-3" @submit.prevent="validAdd && submitAdd()">
        <div class="flex flex-col gap-1">
          <label for="dom-host" class="text-sm font-medium">Hostname</label>
          <InputText id="dom-host" v-model="hostname" placeholder="shop.example.com" autocomplete="off" :invalid="!!hostError" />
          <small v-if="hostError" class="text-red-500">{{ hostError }}</small>
        </div>
        <div class="flex flex-col gap-1">
          <label for="dom-service" class="text-sm font-medium">Service</label>
          <Select v-model="service" input-id="dom-service" :options="services" :placeholder="services.length ? 'Choose a service' : 'Deploy the app first'" :disabled="!services.length" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="dom-https" class="text-sm font-medium">HTTPS</label>
          <Select v-model="https" input-id="dom-https" :options="tls" option-label="label" option-value="value" />
        </div>
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="showAdd = false" />
        <Button label="Add domain" icon="pi pi-check" :disabled="!validAdd" :loading="add.isPending.value" @click="submitAdd" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showDeployment" modal header="Applying domain" :style="{ width: '40rem' }">
      <DeploymentStatus :id="deployedId" />
      <template #footer><Button label="Close" severity="secondary" text @click="showDeployment = false" /></template>
    </Dialog>
  </div>
</template>
