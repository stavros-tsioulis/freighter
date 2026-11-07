<script setup lang="ts">
import { daysUntil } from "~/utils/format";

const { can } = useSession();
const { data: certs, isLoading, error } = useCerts();
const renew = useRenewCerts();

const { data: servers } = useServers();
const multi = computed(() => (servers.value?.length ?? 0) > 1);
const rows = computed(() => (certs.value ?? []).map((c) => ({ ...c, days: daysUntil(c.expires) })));
const severity = (days: number | null) => (days === null ? "danger" : days < 7 ? "danger" : days < 14 ? "warn" : "success");
const label = (days: number | null) => (days === null ? "no certificate" : days < 0 ? "expired" : `${days} days left`);
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-semibold">Certificates</h1>
      <Button v-if="can('admin')" label="Renew now" icon="pi pi-refresh" size="small" severity="secondary" outlined :loading="renew.isPending.value" @click="renew.mutate(false)" />
    </div>
    <Message v-if="error" severity="error">{{ error.message }}</Message>
    <DataTable scrollable :value="rows" :loading="isLoading" size="small" striped-rows data-key="hostname">
      <template #empty><span class="text-muted-color">No <code>tls: auto</code> domains.</span></template>
      <Column v-if="multi" header="Server" field="server" />
      <Column header="Hostname" field="hostname" />
      <Column header="Expires">
        <template #body="{ data }">{{ data.expires ? new Date(data.expires).toLocaleDateString() : "–" }}</template>
      </Column>
      <Column header="Status">
        <template #body="{ data }"><Tag :value="label(data.days)" :severity="severity(data.days)" /></template>
      </Column>
    </DataTable>
    <small class="text-muted-color">Renewed automatically within 30 days of expiry.</small>
  </div>
</template>
