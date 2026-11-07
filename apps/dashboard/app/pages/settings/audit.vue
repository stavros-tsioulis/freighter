<script setup lang="ts">
import { timeAgo } from "~/utils/format";

definePageMeta({ role: "admin" });
const { data: entries, isLoading } = useAudit();
const { data: tokens } = useTokens();
const who = (id: string | null) => (id ? (tokens.value?.find((t) => t.id === id)?.name ?? id) : "host");
</script>

<template>
  <div class="flex flex-col gap-4">
    <h1 class="text-2xl font-semibold">Audit log</h1>
    <DataTable scrollable :value="entries ?? []" :loading="isLoading" size="small" striped-rows data-key="id" paginator :rows="25">
      <template #empty><span class="text-muted-color">No activity recorded.</span></template>
      <Column header="When"><template #body="{ data }"><span :title="data.at">{{ timeAgo(data.at) }}</span></template></Column>
      <Column header="Who"><template #body="{ data }">{{ who(data.tokenId) }}</template></Column>
      <Column header="Action" field="action" />
      <Column header="App"><template #body="{ data }">{{ data.app ?? "–" }}</template></Column>
      <Column header="Detail"><template #body="{ data }"><code class="text-xs">{{ Object.keys(data.detail).length ? JSON.stringify(data.detail) : "" }}</code></template></Column>
    </DataTable>
  </div>
</template>
