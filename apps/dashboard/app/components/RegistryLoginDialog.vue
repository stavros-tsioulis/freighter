<script setup lang="ts">
/** Save (or replace) the login for one container registry. Used from the settings page and wherever a private image comes up. */
const props = defineProps<{ /** Fixes the registry (the one an image comes from, or the one being replaced). */ host?: string; username?: string }>();
const visible = defineModel<boolean>("visible", { required: true });
const emit = defineEmits<{ saved: [host: string] }>();
const save = useSaveRegistry();

const host = ref("");
const username = ref("");
const password = ref("");
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
const valid = computed(() => HOST_RE.test(host.value.trim().toLowerCase()) && username.value.trim() !== "" && password.value !== "");
const replacing = computed(() => !!props.username);

watch(visible, (v) => {
  if (!v) return;
  host.value = props.host ?? "";
  username.value = props.username ?? "";
  password.value = "";
  save.reset();
});

async function submit() {
  const h = host.value.trim().toLowerCase();
  const r = await save.mutateAsync({ host: h, username: username.value.trim(), password: password.value }).catch(() => null);
  password.value = ""; // do not keep the secret in the page longer than needed
  if (r) {
    visible.value = false;
    emit("saved", h);
  }
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="replacing ? `Replace the login for ${host}` : host && props.host ? `Add a login for ${host}` : 'Add a registry login'" :style="{ width: '32rem' }" :closable="!save.isPending.value">
    <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="valid && submit()">
      <div class="flex flex-col gap-1">
        <label for="reg-host" class="text-sm font-medium">Registry</label>
        <InputText id="reg-host" v-model="host" placeholder="ghcr.io" autocomplete="off" spellcheck="false" :disabled="!!props.host" />
        <small class="text-muted-color">The host in the image name. Docker Hub is <code>docker.io</code>.</small>
      </div>
      <div class="flex flex-col gap-1">
        <label for="reg-user" class="text-sm font-medium">User name</label>
        <InputText id="reg-user" v-model="username" autocomplete="off" />
      </div>
      <div class="flex flex-col gap-1">
        <label for="reg-pass" class="text-sm font-medium">Password or access token</label>
        <Password id="reg-pass" v-model="password" :feedback="false" toggle-mask fluid input-class="w-full" autocomplete="new-password" />
        <small class="text-muted-color">Stored encrypted, sent to a server only for the pull, never shown again. Prefer a token that can only read packages.</small>
      </div>
      <Message v-if="save.error.value" severity="error" size="small">{{ save.error.value.message }}</Message>
      <button type="submit" class="hidden" tabindex="-1" aria-hidden="true" />
    </form>
    <template #footer>
      <Button label="Cancel" severity="secondary" text @click="visible = false" />
      <Button :label="replacing ? 'Replace login' : 'Save login'" :disabled="!valid" :loading="save.isPending.value" @click="submit" />
    </template>
  </Dialog>
</template>
