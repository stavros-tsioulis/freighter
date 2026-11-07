<script setup lang="ts">
import type { Enrollment } from "~/types";
import { timeAgo } from "~/utils/format";

defineProps<{ info: Enrollment }>();
const notify = useNotify();

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok("Copied");
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <Message severity="warn" size="small">
      Shown once; expires {{ timeAgo(info.enrollment.expiresAt) }}.
    </Message>
    <p class="text-sm">Run on <b>{{ info.server.name }}</b> as root:</p>
    <div class="flex gap-2 items-start">
      <pre class="terminal flex-1" tabindex="0">{{ info.enrollment.command }}
systemctl restart freighter-agent</pre>
      <Button icon="pi pi-copy" aria-label="Copy command" @click="copy(info.enrollment.command)" />
    </div>
    <div class="text-xs text-muted-color">
      CA fingerprint: <code class="break-all">{{ info.enrollment.caFingerprint }}</code>
    </div>
    <small class="text-muted-color">Port {{ info.server.address?.split(":")[1] ?? 7443 }} must be reachable from this control plane.</small>
  </div>
</template>
