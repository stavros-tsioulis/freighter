<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { upgradeActive } from "~/composables/queries";

const props = defineProps<{ server: string }>();
const visible = defineModel<boolean>({ required: true });
const qc = useQueryClient();

const { data: view, error } = useServerUpgrade(toRef(props, "server"), visible);
const start = useStartUpgrade();
const ref_ = ref("");
const custom = ref(false);

const u = computed(() => view.value?.upgrade ?? null);
const active = computed(() => upgradeActive(u.value));
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : "an unknown version");
const finished = computed(() => (u.value && !active.value ? u.value.state : null));
const validRef = computed(() => !custom.value || !ref_.value.trim() || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(ref_.value.trim()) && !ref_.value.includes(".."));

// The server's agent restarts partway through: while it is away the poll fails, which is expected, not an error to show.
const away = computed(() => !!error.value && active.value);

const box = ref<HTMLElement | null>(null);
watch(() => view.value?.log, async () => {
  const el = box.value;
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  await nextTick();
  if (near) el.scrollTop = el.scrollHeight;
});
watch(finished, (f) => {
  if (f) void qc.invalidateQueries({ queryKey: ["servers"] });
});

const notify = useNotify();
async function copyInstructions() {
  try {
    await navigator.clipboard.writeText(view.value?.haproxy?.instructions ?? "");
    notify.ok("Copied");
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}

async function go() {
  await start.mutateAsync({ server: props.server, ref: custom.value && ref_.value.trim() ? ref_.value.trim() : undefined }).catch(() => null);
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="`Upgrade ${server}`" :style="{ width: '44rem' }" :closable="!start.isPending.value">
    <div class="flex flex-col gap-4">
      <Skeleton v-if="!view && !error" height="6rem" />
      <Message v-else-if="error && !active" severity="error" size="small">{{ (error as Error).message }}</Message>
      <Message v-else-if="view && !view.supported" severity="warn" size="small">{{ view.reason }}</Message>

      <template v-else-if="view">
        <template v-if="!u || !active">
          <Message v-if="finished === 'done'" severity="success" size="small">{{ u?.message }}</Message>
          <Message v-if="finished === 'done' && view.haproxy?.instructions" severity="warn" size="small">
            <div class="flex flex-col gap-2">
              <b>One more step: {{ server }} uses an HAProxy that was already there.</b>
              <span>Freighter never edits that config, so the new rules are yours to add. Until you do, domains behind Cloudflare's proxy can't be verified. Domains pointing straight at the server are not affected.</span>
              <pre class="terminal max-h-56" tabindex="0" aria-label="HAProxy instructions">{{ view.haproxy.instructions }}</pre>
              <Button label="Copy" icon="pi pi-copy" size="small" severity="secondary" class="self-start" @click="copyInstructions" />
            </div>
          </Message>
          <Message v-else-if="finished === 'rolled-back'" severity="warn" size="small">
            The upgrade didn't work out, and {{ server }} is back on {{ short(u?.from) }}. {{ u?.message }}
          </Message>
          <Message v-else-if="finished === 'failed'" severity="error" size="small">{{ u?.message }}</Message>

          <div class="flex flex-col gap-2 text-sm">
            <p>
              <b>{{ server }}</b> runs <code>{{ short(view.commit) }}</code>.
              <template v-if="!view.target && !custom">This dashboard can't tell which version it runs (it isn't running from a git checkout), so choose the version to upgrade to below.</template>
              <template v-else-if="view.target && !custom">This dashboard runs <code>{{ short(view.target) }}</code><span v-if="!view.outdated">, so it's up to date</span>.</template>
            </p>
            <ul class="list-disc pl-5 text-muted-color flex flex-col gap-1">
              <li>The server fetches the new version and builds it itself, which takes a few minutes. It needs internet access.</li>
              <li>Apps keep running. The agent is unavailable for a short while, and HAProxy restarts once at the end (a brief blip for traffic).</li>
              <li>If this dashboard can't reach the new agent afterwards, or the install fails, the server puts the old version back on its own.</li>
              <li>Don't deploy to {{ server }} while it upgrades.</li>
            </ul>
            <div class="flex flex-col gap-1 mt-1">
              <div class="flex items-center gap-2">
                <Checkbox v-model="custom" input-id="up-custom" binary />
                <label for="up-custom">Upgrade to a different version</label>
              </div>
              <template v-if="custom">
                <InputText v-model="ref_" aria-label="Version" placeholder="a branch, tag or commit, e.g. main" autocomplete="off" :invalid="!validRef" />
                <small class="text-muted-color">Empty: {{ short(view.target) }}, the version this dashboard runs.</small>
              </template>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="flex items-center gap-3">
            <StatusTag :state="u!.state" />
            <span class="text-sm text-muted-color">{{ short(u!.from) }} → {{ short(u!.to ?? u!.ref) }}</span>
          </div>
          <p class="text-sm">{{ u!.message }}</p>
          <Message v-if="away" severity="secondary" size="small">The agent is restarting. This page keeps checking.</Message>
        </template>

        <pre v-if="view.log" ref="box" class="terminal max-h-72" tabindex="0" aria-label="Upgrade log">{{ view.log }}</pre>
      </template>
    </div>
    <template #footer>
      <Button :label="active ? 'Close (it keeps going)' : 'Close'" severity="secondary" text @click="visible = false" />
      <Button
        v-if="view?.supported && !active"
        :label="finished ? 'Try again' : 'Upgrade'"
        icon="pi pi-arrow-up"
        :disabled="!validRef || (!custom && !view.target) || (!custom && !!view && !view.outdated && !finished)"
        :loading="start.isPending.value"
        @click="go"
      />
    </template>
  </Dialog>
</template>
