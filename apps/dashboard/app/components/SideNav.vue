<script setup lang="ts">
const emit = defineEmits<{ navigate: [] }>();
const { me, can } = useSession();
const { dark, toggle } = useTheme();
const logout = useLogout();
const route = useRoute();

const groups = computed(() => [
  {
    label: "",
    items: [
      { to: "/", label: "Overview", icon: "pi pi-th-large" },
      { to: "/servers", label: "Servers", icon: "pi pi-server" },
      { to: "/certs", label: "Certificates", icon: "pi pi-lock" },
    ],
  },
  ...(can("admin")
    ? [
        {
          label: "Settings",
          items: [
            { to: "/settings/ssh-keys", label: "SSH keys", icon: "pi pi-lock-open" },
            { to: "/settings/tokens", label: "Tokens", icon: "pi pi-key" },
            { to: "/settings/audit", label: "Audit log", icon: "pi pi-history" },
          ],
        },
      ]
    : []),
]);
const active = (to: string) => (to === "/" ? route.path === "/" || route.path.startsWith("/apps") : route.path.startsWith(to));
</script>

<template>
  <div class="h-full flex flex-col">
    <NuxtLink to="/" class="flex items-center gap-2 font-semibold text-lg px-4 h-14 shrink-0" @click="emit('navigate')">
      <i class="pi pi-box text-primary" />
      Freighter
    </NuxtLink>
    <nav class="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-4" aria-label="Main">
      <div v-for="(g, i) in groups" :key="i" class="flex flex-col gap-0.5">
        <p v-if="g.label" class="px-3 pb-1 text-sm text-muted-color">{{ g.label }}</p>
        <NuxtLink
          v-for="l in g.items"
          :key="l.to"
          :to="l.to"
          class="px-3 py-2 rounded-md text-sm flex items-center gap-3 hover:bg-surface-100 dark:hover:bg-surface-800"
          :class="active(l.to) ? 'bg-surface-100 dark:bg-surface-800 font-medium' : 'text-muted-color'"
          :aria-current="active(l.to) ? 'page' : undefined"
          @click="emit('navigate')"
        >
          <i :class="l.icon" />{{ l.label }}
        </NuxtLink>
      </div>
    </nav>
    <div class="border-t border-surface p-3 flex items-center gap-2 shrink-0">
      <div class="min-w-0 flex-1">
        <p v-if="me" class="text-sm font-medium truncate" :title="me.name">{{ me.name }}</p>
        <p v-if="me" class="text-xs text-muted-color">{{ me.role }}</p>
      </div>
      <Button :icon="dark ? 'pi pi-sun' : 'pi pi-moon'" text rounded severity="secondary" :aria-label="dark ? 'Switch to light theme' : 'Switch to dark theme'" @click="toggle" />
      <Button icon="pi pi-sign-out" text rounded severity="secondary" aria-label="Sign out" :loading="logout.isPending.value" @click="logout.mutate()" />
    </div>
  </div>
</template>
