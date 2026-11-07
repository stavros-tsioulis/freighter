<script setup lang="ts">
import { shortRelease, timeAgo } from "~/utils/format";

const route = useRoute();
const router = useRouter();
const name = computed(() => String(route.params.app));
const { data: app, isLoading, error } = useApp(name);
useHead({ title: computed(() => `${name.value} - Freighter`) });

// The open tab lives in the URL, so reloads and shared links land on the same tab.
const TABS = ["services", "domains", "deployments", "source", "logs", "env"] as const;
const tab = computed({
  get: () => (TABS.includes(route.query.tab as never) ? String(route.query.tab) : "services"),
  set: (t: string) => void router.replace({ query: { ...route.query, tab: t === "services" ? undefined : t } }),
});

const running = computed(() => app.value?.services.filter((s) => s.activeState === "active").length ?? 0);
const failed = computed(() => app.value?.services.some((s) => s.activeState === "failed") ?? false);
const servicesLabel = computed(() => {
  const n = app.value?.services.length ?? 0;
  return n === 0 ? "None" : running.value === n ? `${n} running` : `${running.value} of ${n} running`;
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <PageHeader :title="name">
      <template #before>
        <NuxtLink to="/" class="inline-flex items-center gap-1.5 text-sm text-muted-color hover:text-color mb-1.5">
          <i class="pi pi-arrow-left text-[0.7rem]" aria-hidden="true" />Apps
        </NuxtLink>
      </template>
      <template v-if="app" #beside>
        <StatusTag :state="failed && app.status === 'deployed' ? 'failed' : app.status" :label="failed && app.status === 'deployed' ? 'Service failed' : undefined" />
      </template>
    </PageHeader>

    <Skeleton v-if="isLoading" height="12rem" />
    <Message v-else-if="error" severity="error">{{ error.message }}</Message>
    <template v-else-if="app">
      <Facts>
        <Fact label="Server">{{ app.server }}</Fact>
        <Fact label="Services">{{ servicesLabel }}</Fact>
        <Fact label="Current release" mono :title="app.currentRelease ?? ''">{{ shortRelease(app.currentRelease) }}</Fact>
        <Fact label="Previous release" mono :title="app.previousRelease ?? ''">{{ shortRelease(app.previousRelease) }}</Fact>
        <Fact label="Last synced" :title="app.syncedAt ?? ''">{{ timeAgo(app.syncedAt) }}</Fact>
      </Facts>

      <Tabs v-model:value="tab" lazy>
        <TabList>
          <Tab value="services">Services</Tab>
          <Tab value="domains">Domains</Tab>
          <Tab value="deployments">Deployments</Tab>
          <Tab value="source">Source</Tab>
          <Tab value="logs">Logs</Tab>
          <Tab value="env">Secrets</Tab>
        </TabList>
        <TabPanels>
          <TabPanel value="services"><AppServicesTab :app="app" /></TabPanel>
          <TabPanel value="domains"><AppDomainsTab :app="app" /></TabPanel>
          <TabPanel value="deployments"><AppDeploymentsTab :app="app" /></TabPanel>
          <TabPanel value="source"><AppSourceTab :app="app" /></TabPanel>
          <TabPanel value="logs"><AppLogsTab :app="app" /></TabPanel>
          <TabPanel value="env"><AppEnvTab :app="app" /></TabPanel>
        </TabPanels>
      </Tabs>
    </template>
  </div>
</template>
