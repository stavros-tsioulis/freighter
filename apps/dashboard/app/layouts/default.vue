<script setup lang="ts">
const open = ref(false);
const route = useRoute();
watch(() => route.fullPath, () => { open.value = false; });
</script>

<template>
  <div class="min-h-screen lg:flex">
    <!-- wide screens: fixed sidebar -->
    <aside class="hidden lg:block w-60 shrink-0 border-r border-[var(--fr-line)] bg-[var(--fr-rail)] sticky top-0 h-screen">
      <SideNav />
    </aside>

    <div class="flex-1 min-w-0 flex flex-col">
      <!-- narrow screens: top bar with a menu button; the sidebar opens as a drawer -->
      <header class="lg:hidden sticky top-0 z-10 h-14 px-2 flex items-center gap-1 border-b border-[var(--fr-line)] bg-[var(--fr-rail)]">
        <Button icon="pi pi-bars" text rounded severity="secondary" aria-label="Open menu" aria-haspopup="dialog" @click="open = true" />
        <NuxtLink to="/" class="flex items-center gap-2 font-display font-semibold text-xl"><AppMark />Freighter</NuxtLink>
      </header>
      <Drawer v-model:visible="open" :show-close-icon="false" :pt="{ root: { style: 'background: var(--fr-rail)' }, header: { class: 'hidden' }, content: { class: 'p-0' } }" :style="{ width: 'min(17rem, 85vw)' }">
        <SideNav @navigate="open = false" />
      </Drawer>

      <main class="w-full max-w-[76rem] px-4 sm:px-8 pt-7 pb-16 flex-1">
        <slot />
      </main>
    </div>
  </div>
</template>
