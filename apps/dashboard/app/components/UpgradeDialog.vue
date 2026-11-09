<script setup lang="ts">
import { useQueryClient } from "@tanstack/vue-query";
import { upgradeActive } from "~/composables/queries";

/** `containers`: install Podman (the installer's --with-containers) at the version that is installed, instead of upgrading. */
const props = defineProps<{ server: string; containers?: boolean }>();
const visible = defineModel<boolean>({ required: true });
const qc = useQueryClient();

const { data: view, error } = useServerUpgrade(toRef(props, "server"), visible);
const start = useStartUpgrade();
const ref_ = ref("");
const custom = ref(false);

const u = computed(() => view.value?.upgrade ?? null);
const active = computed(() => upgradeActive(u.value));
const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : "an unknown version");
// A run that was already over when the dialog opened is history: its result and log stay hidden, so the dialog opens
// cleared. A run in progress (Follow it) or any run started from here shows as usual, and the same goes for the moment
// of starting one: the screen stays empty until the new run reports.
const runKey = (i: typeof u.value) => (i ? `${i.startedAt}|${i.updatedAt}|${i.state}` : null);
const staleKey = ref<string | null>(null);
let looked = false;
watch(view, (v) => {
  if (looked || !v) return;
  looked = true;
  const i = v.upgrade;
  if (i && !upgradeActive(i)) staleKey.value = runKey(i);
}, { immediate: true });
const stale = computed(() => staleKey.value !== null && runKey(u.value) === staleKey.value);
const finished = computed(() => (u.value && !active.value && !stale.value && !start.isPending.value ? u.value.state : null));
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

async function go() {
  await start.mutateAsync(props.containers ? { server: props.server, containers: true } : { server: props.server, ref: custom.value && ref_.value.trim() ? ref_.value.trim() : undefined }).catch(() => null);
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="containers ? `Add container support to ${server}` : `Upgrade ${server}`" :style="{ width: '44rem' }" :closable="!start.isPending.value">
    <div class="flex flex-col gap-4">
      <Skeleton v-if="!view && !error" height="6rem" />
      <Message v-else-if="error && !active" severity="error" size="small">{{ (error as Error).message }}</Message>
      <Message v-else-if="view && !view.supported" severity="warn" size="small">{{ view.reason }}</Message>

      <template v-else-if="view">
        <template v-if="!u || !active">
          <Message v-if="finished === 'done'" severity="success" size="small">{{ u?.message }}</Message>
          <Message v-else-if="finished === 'rolled-back'" severity="warn" size="small">
            {{ containers ? "Adding container support" : "The upgrade" }} didn't work out, and {{ server }} is back on {{ short(u?.from) }}. {{ u?.message }}
          </Message>
          <Message v-else-if="finished === 'failed'" severity="error" size="small">{{ u?.message }}</Message>

          <div v-if="containers" class="flex flex-col gap-2 text-sm">
            <p><b>{{ server }}</b> runs <code>{{ short(view.commit) }}</code>. This installs Podman, which runs the apps you deploy as container images. The version of Freighter doesn't change.</p>
            <ul class="list-disc pl-5 text-muted-color flex flex-col gap-1">
              <li>The server installs Podman and a few helper packages with apt, then runs Freighter's installer again, which takes a few minutes. It needs internet access.</li>
              <li>Apps keep running. The agent is unavailable for a short while while it restarts.</li>
              <li>If this dashboard can't reach the agent afterwards, or the install fails, the server puts the previous agent back on its own. Packages that were installed stay.</li>
              <li>Don't deploy to {{ server }} meanwhile.</li>
            </ul>
          </div>
          <div v-else class="flex flex-col gap-2 text-sm">
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

        <pre v-if="view.log && !stale && !start.isPending.value" ref="box" class="terminal max-h-72" tabindex="0" aria-label="Upgrade log">{{ view.log }}</pre>
      </template>
    </div>
    <template #footer>
      <Button :label="active ? 'Close (it keeps going)' : 'Close'" severity="secondary" text @click="visible = false" />
      <Button
        v-if="view?.supported && !active"
        :label="finished ? 'Try again' : containers ? 'Add container support' : 'Upgrade'"
        :icon="containers ? 'pi pi-box' : 'pi pi-arrow-up'"
        :disabled="!containers && (!validRef || (!custom && !view.target) || (!custom && !!view && !view.outdated && !finished))"
        :loading="start.isPending.value"
        @click="go"
      />
    </template>
  </Dialog>
</template>
