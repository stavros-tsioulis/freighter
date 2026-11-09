<script setup lang="ts">
import type { AppRow } from "~/types";

/** Where the app's remote volumes stand: mounted or not, and the SMB password (write-only). */
const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const { data: volumes } = useVolumes(appName);
const setPassword = useSetVolumePassword(appName);
const rows = computed(() => Object.entries(volumes.value ?? {}));

const target = ref<string | null>(null);
const password = ref("");
const show = computed({ get: () => target.value !== null, set: (v) => { if (!v) target.value = null; } });
function open(name: string) {
  password.value = "";
  target.value = name;
}
async function save() {
  await setPassword.mutateAsync({ name: target.value!, password: password.value }).then(() => (target.value = null)).catch(() => {});
}
</script>

<template>
  <section v-if="rows.length" class="flex flex-col gap-2" aria-label="Remote volumes">
    <h3 class="font-medium">Remote volumes</h3>
    <ul class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] divide-y divide-[var(--fr-line)]">
      <li v-for="[name, v] in rows" :key="name" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
        <code class="font-medium">{{ name }}</code>
        <Tag :value="v.type.toUpperCase()" severity="secondary" />
        <Tag :value="v.state" :severity="v.state === 'mounted' ? 'success' : 'warn'" />
        <span v-if="v.password === false" class="text-sm text-amber-600 dark:text-amber-400">No password yet</span>
        <Button v-if="v.password !== null && can('admin')" :label="v.password ? 'Change password' : 'Set password'" size="small" severity="secondary" text class="ml-auto" @click="open(name)" />
      </li>
    </ul>
  </section>

  <Dialog v-model:visible="show" modal :header="`Password for ${target}`" :style="{ width: '26rem' }">
    <form class="flex flex-col gap-3" @submit.prevent="password && save()">
      <Password v-model="password" input-id="vol-pw" :feedback="false" toggle-mask fluid autocomplete="off" aria-label="Password" />
      <button type="submit" class="hidden" />
    </form>
    <template #footer>
      <Button label="Cancel" severity="secondary" text @click="target = null" />
      <Button label="Save password" :disabled="!password" :loading="setPassword.isPending.value" @click="save" />
    </template>
  </Dialog>
</template>
