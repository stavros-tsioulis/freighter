<script setup lang="ts">
import { shortRelease, timeAgo } from "~/utils/format";

const route = useRoute();
const name = computed(() => String(route.params.app));
const { data: app, isLoading, error } = useApp(name);
const tab = ref("services");
useHead({ title: computed(() => `${name.value} - Freighter`) });
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <NuxtLink to="/" class="text-muted-color hover:text-color" aria-label="Back to overview"><i class="pi pi-arrow-left" /></NuxtLink>
      <h1 class="text-2xl font-semibold">{{ name }}</h1>
      <StatusTag v-if="app" :state="app.status" />
      <Tag v-if="app" :value="app.server" severity="secondary" icon="pi pi-server" />
    </div>

    <Skeleton v-if="isLoading" height="12rem" />
    <Message v-else-if="error" severity="error">{{ error.message }}</Message>
    <template v-else-if="app">
      <div class="flex flex-wrap gap-x-8 gap-y-1 text-sm">
        <div><span class="text-muted-color">Release </span><span class="font-mono">{{ shortRelease(app.currentRelease) }}</span></div>
        <div><span class="text-muted-color">Previous </span><span class="font-mono">{{ shortRelease(app.previousRelease) }}</span></div>
        <div><span class="text-muted-color">Synced </span><span :title="app.syncedAt ?? ''">{{ timeAgo(app.syncedAt) }}</span></div>
      </div>

      <Tabs v-model:value="tab" lazy>
        <TabList>
          <Tab value="services">Services</Tab>
          <Tab value="domains">Domains</Tab>
          <Tab value="deployments">Deployments</Tab>
          <Tab value="source">Source</Tab>
          <Tab value="logs">Logs</Tab>
          <Tab value="env">Environment</Tab>
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
