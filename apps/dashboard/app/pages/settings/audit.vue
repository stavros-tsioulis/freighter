<script setup lang="ts">
import { timeAgo } from "~/utils/format";

definePageMeta({ role: "admin" });
useHead({ title: "Audit log - Freighter" });
const { data: entries, isLoading } = useAudit();
const { data: tokens } = useTokens();
const who = (id: string | null) => (id ? (tokens.value?.find((t) => t.id === id)?.name ?? id) : "host");
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Audit log">Every change made through the API or this dashboard, newest first.</PageHeader>
    <DataTable scrollable :value="entries ?? []" :loading="isLoading" data-key="id" paginator :rows="25">
      <template #empty><span class="text-muted-color">No activity recorded.</span></template>
      <Column header="When"><template #body="{ data }"><span :title="data.at">{{ timeAgo(data.at) }}</span></template></Column>
      <Column header="Who"><template #body="{ data }"><span class="font-medium">{{ who(data.tokenId) }}</span></template></Column>
      <Column header="Action"><template #body="{ data }"><code>{{ data.action }}</code></template></Column>
      <Column header="App"><template #body="{ data }"><NuxtLink v-if="data.app" :to="`/apps/${data.app}`" class="text-primary hover:underline">{{ data.app }}</NuxtLink><span v-else class="text-muted-color">–</span></template></Column>
      <Column header="Detail"><template #body="{ data }"><code class="text-xs text-muted-color break-all">{{ Object.keys(data.detail).length ? JSON.stringify(data.detail) : "" }}</code></template></Column>
    </DataTable>
  </div>
</template>
