<script setup lang="ts">
definePageMeta({ layout: "blank" });
useHead({ title: "Sign in - Freighter" });
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
  <div class="w-full max-w-[25rem]">
    <div class="flex items-center gap-2.5 mb-6 font-display font-semibold text-[1.9rem]">
      <AppMark :size="30" />
      Freighter
    </div>
    <div class="rounded-[var(--p-border-radius-xl)] border border-[var(--fr-line)] bg-[var(--fr-panel)] p-6 sm:p-7">
      <h1 class="font-display font-semibold text-2xl leading-tight">Sign in</h1>
      <p class="mt-1 text-muted-color">Paste an API token to open the dashboard.</p>
      <form class="mt-5 flex flex-col gap-3" @submit.prevent="submit">
        <label for="token" class="text-sm font-medium">API token</label>
        <Password v-model="token" input-id="token" placeholder="fr_…" :feedback="false" toggle-mask fluid autocomplete="off" :invalid="!!error" input-class="font-mono" />
        <Message v-if="error" severity="error" size="small">{{ error }}</Message>
        <Button type="submit" label="Sign in" :loading="login.isPending.value" :disabled="!token.trim()" class="mt-1" />
      </form>
    </div>
    <div class="mt-5 px-1 text-sm text-muted-color">
      <p>No token yet? Create one on the server:</p>
      <pre class="well mt-2">freighter token create --name you --role admin</pre>
    </div>
  </div>
</template>
