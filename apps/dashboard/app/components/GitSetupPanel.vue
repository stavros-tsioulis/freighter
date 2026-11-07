<script setup lang="ts">
import type { GitLink } from "~/types";

const props = defineProps<{ link: GitLink; webhookSecret?: string }>();
const notify = useNotify();

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok(`${what} copied`);
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}

const host = computed(() => ({ github: "GitHub", gitlab: "GitLab", other: "your git host" })[props.link.provider]);
const keySteps = computed(() =>
  props.link.provider === "gitlab"
    ? "In GitLab: the project → Settings → Repository → Deploy keys → Add new key. Paste the key; leave “Grant write permissions” off."
    : "In GitHub: the repository → Settings → Deploy keys → Add deploy key. Paste the key; leave “Allow write access” off.",
);
const hookSteps = computed(() =>
  props.link.provider === "gitlab"
    ? "In GitLab: Settings → Webhooks → Add new webhook. Paste the URL and the secret token, tick “Push events” and set the branch filter to the branch above."
    : "In GitHub: Settings → Webhooks → Add webhook. Paste the payload URL, set Content type to application/json, paste the secret, and choose “Just the push event”.",
);
</script>

<template>
  <div class="flex flex-col gap-5">
    <section v-if="link.sshKey" class="flex flex-col gap-1">
      <h3 class="font-medium">Read access</h3>
      <p class="text-sm text-muted-color">Cloning with the key <b>{{ link.sshKey.name }}</b> ({{ link.sshKey.fingerprint }}).</p>
    </section>

    <section v-else class="flex flex-col gap-2">
      <h3 class="font-medium">Read access (deploy key)</h3>
      <p class="text-sm text-muted-color">{{ keySteps }}</p>
      <div class="flex gap-2 items-start">
        <pre class="well flex-1" tabindex="0">{{ link.publicKey }}</pre>
        <Button icon="pi pi-copy" aria-label="Copy deploy key" @click="copy(link.publicKey, 'Deploy key')" />
      </div>
      <small class="text-muted-color break-all">Fingerprint {{ link.keyFingerprint }}.</small>
    </section>

    <section class="flex flex-col gap-2">
      <h3 class="font-medium">Deploy on push (webhook)</h3>
      <p class="text-sm text-muted-color">{{ hookSteps }}</p>
      <div class="grid grid-cols-[7rem_1fr_auto] gap-x-2 gap-y-2 items-center text-sm">
        <span class="text-muted-color">URL</span>
        <code class="break-all">{{ link.webhookUrl }}</code>
        <Button icon="pi pi-copy" text rounded size="small" severity="secondary" aria-label="Copy webhook URL" @click="copy(link.webhookUrl, 'Webhook URL')" />
        <span class="text-muted-color">Secret</span>
        <code v-if="webhookSecret" class="break-all">{{ webhookSecret }}</code>
        <span v-else class="text-muted-color">hidden — rotate it to get a new one</span>
        <Button v-if="webhookSecret" icon="pi pi-copy" text rounded size="small" severity="secondary" aria-label="Copy webhook secret" @click="copy(webhookSecret, 'Webhook secret')" />
        <span v-else />
      </div>
      <Message v-if="webhookSecret" severity="warn" size="small">The secret is shown once.</Message>
      <small class="text-muted-color">The URL must be reachable from {{ host }}.</small>
    </section>
  </div>
</template>
