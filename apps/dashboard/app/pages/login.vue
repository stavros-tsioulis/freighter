<script setup lang="ts">
definePageMeta({ layout: "blank" });
const token = ref("");
const login = useLogin();
const error = ref("");

async function submit() {
  error.value = "";
  try {
    await login.mutateAsync(token.value.trim());
    token.value = "";
    await navigateTo("/");
  } catch (e) {
    error.value = errorMessage(e);
  }
}
</script>

<template>
  <Card class="w-full max-w-sm">
    <template #title>
      <div class="flex items-center gap-2"><i class="pi pi-box text-primary" /> Freighter</div>
    </template>
    <template #subtitle>Sign in with an API token</template>
    <template #content>
      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <label for="token" class="sr-only">API token</label>
        <Password v-model="token" input-id="token" placeholder="fr_…" :feedback="false" toggle-mask fluid autocomplete="off" :invalid="!!error" />
        <Message v-if="error" severity="error" size="small">{{ error }}</Message>
        <Button type="submit" label="Sign in" icon="pi pi-sign-in" :loading="login.isPending.value" :disabled="!token.trim()" />
      </form>
    </template>
  </Card>
</template>
