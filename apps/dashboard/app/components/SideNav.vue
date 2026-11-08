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
      { to: "/", label: "Apps", icon: "pi pi-th-large" },
      { to: "/servers", label: "Servers", icon: "pi pi-server" },
      { to: "/certs", label: "Certificates", icon: "pi pi-shield" },
    ],
  },
  ...(can("admin")
    ? [
        {
          label: "Configuration",
          items: [{ to: "/settings/server", label: "Server settings", icon: "pi pi-sliders-h" }],
        },
        {
          label: "Access",
          items: [
            { to: "/settings/tokens", label: "API tokens", icon: "pi pi-key" },
            { to: "/settings/ssh-keys", label: "SSH keys", icon: "pi pi-lock" },
            { to: "/settings/registries", label: "Registry logins", icon: "pi pi-box" },
            { to: "/settings/audit", label: "Audit log", icon: "pi pi-history" },
          ],
        },
      ]
    : []),
]);
const active = (to: string) => (to === "/" ? route.path === "/" || route.path.startsWith("/apps") : route.path.startsWith(to));
const roleLabel = computed(() => ({ viewer: "Viewer", deployer: "Deployer", admin: "Admin" })[me.value?.role ?? "viewer"]);
</script>

<template>
  <div class="h-full flex flex-col">
    <NuxtLink to="/" class="flex items-center gap-2.5 px-5 h-16 shrink-0 font-display font-semibold text-[1.45rem] tracking-[0.01em]" @click="emit('navigate')">
      <AppMark :size="24" />
      Freighter
    </NuxtLink>
    <nav class="flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-6" aria-label="Main">
      <div v-for="(g, i) in groups" :key="i" class="flex flex-col gap-px">
        <p v-if="g.label" class="px-3 pb-1.5 text-[0.8rem] text-muted-color">{{ g.label }}</p>
        <NuxtLink
          v-for="l in g.items"
          :key="l.to"
          :to="l.to"
          class="nav-link"
          :aria-current="active(l.to) ? 'page' : undefined"
          @click="emit('navigate')"
        >
          <i :class="l.icon" aria-hidden="true" />{{ l.label }}
        </NuxtLink>
      </div>
    </nav>
    <div class="border-t border-[var(--fr-line)] px-4 py-3 flex items-center gap-1 shrink-0">
      <div v-if="me" class="min-w-0 flex-1">
        <p class="text-sm font-medium truncate" :title="me.name">{{ me.name }}</p>
        <p class="text-[0.8rem] text-muted-color">{{ roleLabel }}</p>
      </div>
      <Button :icon="dark ? 'pi pi-sun' : 'pi pi-moon'" text rounded severity="secondary" size="small" :aria-label="dark ? 'Use light theme' : 'Use dark theme'" :title="dark ? 'Use light theme' : 'Use dark theme'" @click="toggle" />
      <Button icon="pi pi-sign-out" text rounded severity="secondary" size="small" aria-label="Sign out" title="Sign out" :loading="logout.isPending.value" @click="logout.mutate()" />
    </div>
  </div>
</template>

<style scoped>
.nav-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 0.75rem;
  border-radius: var(--p-border-radius-md);
  font-size: 0.95rem;
  color: var(--p-text-muted-color);
  border: 1px solid transparent;
}
.nav-link i { font-size: 0.9rem; width: 1rem; text-align: center; }
.nav-link:hover { color: var(--p-text-color); background: color-mix(in srgb, var(--p-text-color) 5%, transparent); }
.nav-link[aria-current="page"] {
  color: var(--p-text-color);
  font-weight: 500;
  background: var(--fr-panel);
  border-color: var(--fr-line);
}
.nav-link[aria-current="page"] i { color: var(--p-primary-color); }
</style>
