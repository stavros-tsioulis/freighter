<script setup lang="ts">
const open = ref(false);
const route = useRoute();
watch(() => route.fullPath, () => { open.value = false; });
</script>

<template>
  <div class="min-h-screen lg:flex">
    <!-- wide screens: fixed sidebar -->
    <aside class="hidden lg:block w-60 shrink-0 border-r border-surface bg-surface-0 dark:bg-surface-900 sticky top-0 h-screen">
      <SideNav />
    </aside>

    <div class="flex-1 min-w-0 flex flex-col">
      <!-- narrow screens: top bar with a menu button; the sidebar opens as a drawer -->
      <header class="lg:hidden sticky top-0 z-10 h-14 px-2 flex items-center gap-1 border-b border-surface bg-surface-0 dark:bg-surface-900">
        <Button icon="pi pi-bars" text rounded severity="secondary" aria-label="Open menu" aria-haspopup="dialog" @click="open = true" />
        <NuxtLink to="/" class="flex items-center gap-2 font-semibold"><i class="pi pi-box text-primary" />Freighter</NuxtLink>
      </header>
      <Drawer v-model:visible="open" :show-close-icon="false" :pt="{ header: { class: 'hidden' }, content: { class: 'p-0' } }" :style="{ width: 'min(18rem, 85vw)' }">
        <SideNav @navigate="open = false" />
      </Drawer>

      <main class="w-full max-w-7xl mx-auto px-4 sm:px-6 py-6 flex-1">
        <slot />
      </main>
    </div>
  </div>
</template>
