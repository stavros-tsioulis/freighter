<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <Toast position="bottom-right" />
  <Toast position="bottom-right" group="link">
    <template #message="{ message }">
      <div class="flex flex-col gap-1 flex-auto">
        <span class="font-medium">{{ message.summary }}</span>
        <span v-if="message.detail" class="text-sm">{{ message.detail }}</span>
        <NuxtLink :to="`/apps/${message.detail}?tab=deployments`" class="text-sm font-medium underline">View deployments</NuxtLink>
      </div>
    </template>
  </Toast>
  <ConfirmDialog />
</template>
