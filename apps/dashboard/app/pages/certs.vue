<script setup lang="ts">
import { daysUntil } from "~/utils/format";

useHead({ title: "Certificates - Freighter" });
const { can } = useSession();
const { data: certs, isLoading, error } = useCerts();
const renew = useRenewCerts();

const { data: servers } = useServers();
const multi = computed(() => (servers.value?.length ?? 0) > 1);
const rows = computed(() => (certs.value ?? []).map((c) => ({ ...c, days: daysUntil(c.expires) })).sort((a, b) => (a.days ?? -1e9) - (b.days ?? -1e9)));
const state = (days: number | null) => (days === null || days < 7 ? "failed" : days < 14 ? "expiring" : "success");
const label = (days: number | null) => (days === null ? "No certificate" : days < 0 ? "Expired" : days === 0 ? "Expires today" : `${days} days left`);
// 90 days is a Let's Encrypt certificate's lifetime; the bar shows how much of it remains.
const remaining = (days: number | null) => `${Math.max(0, Math.min(100, ((days ?? 0) / 90) * 100))}%`;
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Certificates">
      HTTPS certificates for domains with automatic HTTPS. Each renews on its own within 30 days of expiry.
      <template #actions>
        <Button v-if="can('admin')" label="Renew due certificates" icon="pi pi-refresh" size="small" severity="secondary" outlined :loading="renew.isPending.value" @click="renew.mutate(false)" />
      </template>
    </PageHeader>
    <Message v-if="error" severity="error">{{ error.message }}</Message>
    <DataTable scrollable :value="rows" :loading="isLoading" data-key="hostname">
      <template #empty><span class="text-muted-color">No domains use automatic HTTPS yet. Add one from an app's Domains tab.</span></template>
      <Column header="Domain" field="hostname">
        <template #body="{ data }"><span class="font-medium">{{ data.hostname }}</span></template>
      </Column>
      <Column v-if="multi" header="Server" field="server" />
      <Column header="Expires">
        <template #body="{ data }"><span class="num">{{ data.expires ? new Date(data.expires).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "–" }}</span></template>
      </Column>
      <Column header="Remaining" style="width: 16rem">
        <template #body="{ data }">
          <div class="flex flex-col gap-1.5">
            <StatusTag :state="state(data.days)" :label="label(data.days)" />
            <span class="life" :data-state="state(data.days)" :style="{ '--v': remaining(data.days) }" aria-hidden="true" />
          </div>
        </template>
      </Column>
    </DataTable>
  </div>
</template>

<style scoped>
.life {
  display: block;
  width: 10rem;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(to right, var(--c) var(--v), var(--fr-line) var(--v));
  --c: var(--p-green-500);
}
.life[data-state="expiring"] { --c: var(--p-amber-500); }
.life[data-state="failed"] { --c: var(--p-red-500); }
</style>
