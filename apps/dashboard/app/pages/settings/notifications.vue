<script setup lang="ts">
import type { PushSubscriptionRow } from "~/types";
import { timeAgo } from "~/utils/format";

const notify = useNotify();
const { data: info, isLoading } = usePushInfo();
const device = usePushDevice();
const setEvents = useSetPushEvents();
const remove = useRemovePushSubscription();
const test = useTestPush();

const events = computed(() => info.value?.events ?? []);
const here = computed(() => info.value?.subscriptions.find((s) => s.id === device.id.value));
const elsewhere = computed(() => (info.value?.subscriptions ?? []).filter((s) => s.id !== device.id.value));
const eventLabel = (kind: string) => events.value.find((e) => e.kind === kind)?.label ?? kind;

async function turnOn() {
  if (!info.value) return;
  if (await device.enable(info.value.publicKey)) notify.ok("Notifications are on for this device");
}
function toggle(sub: PushSubscriptionRow, kind: string, on: boolean) {
  const next = on ? [...sub.events, kind] : sub.events.filter((k) => k !== kind);
  setEvents.mutate({ id: sub.id, events: next });
}

const problem = computed(() => {
  switch (device.support.value) {
    case "insecure": return "Notifications need the dashboard to be served over HTTPS. Open it at its https:// address.";
    case "needs-install": return "On an iPhone or iPad, notifications work once Freighter is added to the Home Screen: tap Share, then “Add to Home Screen”, and open it from there.";
    case "unsupported": return "This browser can’t receive notifications from a website.";
    case "no-worker": return "The background worker that receives notifications isn’t running. It is only part of the built dashboard, not the development server.";
    default: return device.permission.value === "denied" ? "This browser is blocking notifications from the dashboard. Allow them in the site settings of the address bar, then reload." : null;
  }
});
</script>

<template>
  <div class="flex flex-col gap-8">
    <PageHeader title="Notifications">
      Get a notification on your phone or computer when something needs you: a deployment fails, a service crashes, a server stops answering. They arrive even when the dashboard is closed.
    </PageHeader>

    <section class="flex flex-col gap-4 border border-[var(--fr-line)] rounded-lg bg-[var(--fr-panel)] p-5" aria-labelledby="here-title">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="here-title" class="font-medium">This device</h2>
          <p class="text-sm text-muted-color">
            <template v-if="device.support.value === 'checking' || isLoading">Checking…</template>
            <template v-else-if="here">Notifications are on.</template>
            <template v-else>Notifications are off.</template>
          </p>
        </div>
        <div class="flex gap-2">
          <Button v-if="here" label="Send a test" icon="pi pi-send" severity="secondary" outlined size="small" :loading="test.isPending.value" @click="test.mutate(here.id)" />
          <Button v-if="here" label="Turn off" severity="secondary" text size="small" :loading="device.busy.value" @click="device.disable()" />
          <Button v-else label="Turn on notifications" icon="pi pi-bell" size="small" :disabled="problem !== null || device.support.value === 'checking' || !info" :loading="device.busy.value" @click="turnOn" />
        </div>
      </div>

      <Message v-if="problem" severity="warn" size="small">{{ problem }}</Message>
      <Message v-if="device.failure.value" severity="error" size="small">{{ device.failure.value }}</Message>
      <Message v-if="here?.lastError" severity="error" size="small">The last notification could not be delivered: {{ here.lastError }}</Message>

      <fieldset v-if="here" class="flex flex-col gap-3 border-t border-[var(--fr-line)] pt-4">
        <legend class="sr-only">What to be told about on this device</legend>
        <p class="text-sm text-muted-color">Tell me when</p>
        <label v-for="e in events" :key="e.kind" class="flex items-center gap-3 cursor-pointer">
          <ToggleSwitch :model-value="here.events.includes(e.kind)" :input-id="`ev-${e.kind}`" @update:model-value="toggle(here, e.kind, $event)" />
          <span>{{ e.label }}</span>
        </label>
      </fieldset>
    </section>

    <section v-if="elsewhere.length" class="flex flex-col gap-3" aria-labelledby="others-title">
      <h2 id="others-title" class="font-medium">Your other devices</h2>
      <DataTable scrollable :value="elsewhere" data-key="id">
        <Column header="Device" field="label"><template #body="{ data }"><span class="font-medium">{{ data.label }}</span></template></Column>
        <Column header="Tells you about">
          <template #body="{ data }">
            <span v-if="data.events.length === 0" class="text-muted-color">Nothing</span>
            <span v-else class="text-sm">{{ data.events.map(eventLabel).join(", ") }}</span>
          </template>
        </Column>
        <Column header="Last delivered"><template #body="{ data }"><span :class="{ 'text-red-500': data.lastError }" :title="data.lastError ?? undefined">{{ data.lastError ? "Failed" : data.lastDeliveredAt ? timeAgo(data.lastDeliveredAt) : "never" }}</span></template></Column>
        <Column header="" class="text-right" style="width: 7rem">
          <template #body="{ data }"><Button label="Remove" text severity="danger" size="small" :loading="remove.isPending.value" @click="remove.mutate(data.id)" /></template>
        </Column>
      </DataTable>
    </section>
  </div>
</template>
