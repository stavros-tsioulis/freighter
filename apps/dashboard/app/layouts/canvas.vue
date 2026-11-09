<script setup lang="ts">
/** Like the default layout, but the page fills the screen: a canvas wants all the room it can get. */
const open = ref(false);
const route = useRoute();
watch(() => route.fullPath, () => { open.value = false; });
</script>

<template>
  <div class="h-screen lg:flex overflow-hidden">
    <aside class="hidden lg:block w-60 shrink-0 border-r border-[var(--fr-line)] bg-[var(--fr-rail)] h-screen">
      <SideNav />
    </aside>
    <div class="flex-1 min-w-0 min-h-0 flex flex-col h-full">
      <header class="lg:hidden shrink-0 h-14 px-2 flex items-center gap-1 border-b border-[var(--fr-line)] bg-[var(--fr-rail)]">
        <Button icon="pi pi-bars" text rounded severity="secondary" aria-label="Open menu" aria-haspopup="dialog" @click="open = true" />
        <NuxtLink to="/" class="flex items-center gap-2 font-display font-semibold text-xl"><AppMark />Freighter</NuxtLink>
      </header>
      <Drawer v-model:visible="open" :show-close-icon="false" :pt="{ root: { style: 'background: var(--fr-rail)' }, header: { class: 'hidden' }, content: { class: 'p-0' } }" :style="{ width: 'min(17rem, 85vw)' }">
        <SideNav @navigate="open = false" />
      </Drawer>
      <main class="flex-1 min-h-0 flex flex-col"><slot /></main>
    </div>
  </div>
</template>
