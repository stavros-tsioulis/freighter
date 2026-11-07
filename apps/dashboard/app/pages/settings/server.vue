<script setup lang="ts">
import type { ConfigField, ConfigSaved } from "~/types";
import { errorMessage } from "~/composables/api";

definePageMeta({ role: "admin" });
const notify = useNotify();
const { data: servers } = useServers();
const server = ref("local");
const choices = computed(() => (servers.value ?? []).filter((s) => s.kind === "local" || s.status !== "pending").map((s) => ({ label: s.name, value: s.name })));
const { data: fields, isLoading, error } = useServerConfig(server);
const save = useSaveServerConfig();
const restart = useRestartService();

/** What each enum value means, for settings whose raw values read badly. */
const OPTION_LABELS: Record<string, Record<string, string>> = {
  "git.knownHosts": { "accept-new": "Trust on first use", yes: "Refuse unknown hosts" },
};
const optionsFor = (f: ConfigField) => (f.options ?? []).map((o) => ({ value: o, label: OPTION_LABELS[f.key]?.[o] ?? o }));

// ---- the form: one value per setting, plus the settings the person asked to put back to default ----
const form = reactive<Record<string, unknown>>({});
const resets = reactive(new Set<string>());
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** The empty string and an empty number box both mean "no value". */
const normalised = (f: ConfigField, v: unknown) => (f.type === "string" && v === "" ? null : v ?? null);

function load(list: ConfigField[]) {
  for (const k of Object.keys(form)) delete form[k];
  resets.clear();
  for (const f of list) form[f.key] = f.type === "list" ? [...((f.value as string[] | null) ?? [])] : f.value ?? (f.type === "string" ? "" : null);
}
watch(fields, (list) => list && load(list), { immediate: true });
watch(server, () => pending.value.clear());

const changes = computed(() => {
  const out: Record<string, unknown> = {};
  for (const f of fields.value ?? []) {
    if (resets.has(f.key)) {
      if (f.explicit) out[f.key] = null;
    } else if (!same(normalised(f, form[f.key]), f.value)) {
      out[f.key] = normalised(f, form[f.key]);
    }
  }
  return out;
});
const dirty = computed(() => Object.keys(changes.value).length);
const isDirty = (f: ConfigField) => f.key in changes.value;

function edited(f: ConfigField) {
  resets.delete(f.key);
}
function useDefault(f: ConfigField) {
  form[f.key] = f.type === "list" ? [...((f.default as string[] | null) ?? [])] : f.default ?? (f.type === "string" ? "" : null);
  if (f.explicit) resets.add(f.key);
}
/** Offer "Use default" while the setting is set in the file or differs from the default, until it has been reset. */
const showDefaultLink = (f: ConfigField) => !resets.has(f.key) && (f.explicit || !same(normalised(f, form[f.key]), f.default));

function show(f: ConfigField, v: unknown): string {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "none";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.join(", ");
  return OPTION_LABELS[f.key]?.[String(v)] ?? `${v}${f.unit ? " " + f.unit.split(" ")[0] : ""}`;
}

const sections = computed(() => {
  const out: { name: string; fields: ConfigField[] }[] = [];
  for (const f of fields.value ?? []) {
    let s = out.find((x) => x.name === f.section);
    if (!s) out.push((s = { name: f.section, fields: [] }));
    s.fields.push(f);
  }
  return out;
});

// ---- saving, and what has to happen afterwards ----
const pending = ref(new Set<"agent" | "api">());
const haproxyNote = ref<ConfigSaved["haproxy"]>("none");
async function submit() {
  const r = await save.mutateAsync({ server: server.value, changes: changes.value }).catch(() => null);
  if (!r) return;
  r.restart.forEach((s) => pending.value.add(s));
  haproxyNote.value = r.haproxy;
  notify.ok(r.changed.length ? "Settings saved" : "Nothing to change");
}
function discard() {
  if (fields.value) load(fields.value);
}
const SERVICE_NAME = { agent: "the Freighter agent", api: "the dashboard and API" } as const;
const pendingText = computed(() => [...pending.value].map((s) => SERVICE_NAME[s]).join(" and "));
async function restartPending() {
  const order = ([...pending.value] as ("agent" | "api")[]).sort((a) => (a === "api" ? 1 : -1)); // the API last: it carries this very request
  for (const service of order) {
    const ok = await restart.mutateAsync({ server: server.value, service }).then(() => true).catch(() => false);
    if (!ok) return;
  }
  pending.value.clear();
  notify.ok("Restarting", "The page may be unavailable for a few seconds.");
}
</script>

<template>
  <div class="flex flex-col gap-8 pb-24">
    <PageHeader title="Server settings">
      How this server issues certificates, takes web traffic and handles deploys. Saved to <code>/etc/freighter/config.yaml</code>, with your comments kept.
      <template #actions>
        <Select v-if="choices.length > 1" v-model="server" :options="choices" option-label="label" option-value="value" size="small" class="w-44" aria-label="Server" />
      </template>
    </PageHeader>

    <Message v-if="pending.size" severity="warn" :closable="false">
      <div class="flex flex-wrap items-center gap-3">
        <span>Saved. Restart {{ pendingText }} for the new settings to take effect. Running apps are not affected.</span>
        <Button label="Restart now" icon="pi pi-refresh" size="small" severity="warn" :loading="restart.isPending.value" @click="restartPending" />
      </div>
    </Message>
    <Message v-if="haproxyNote === 'applied'" severity="success" :closable="false">HAProxy now listens on the new ports.</Message>
    <Message v-else-if="haproxyNote === 'manual'" severity="info" :closable="false">
      This server uses an HAProxy configuration you maintain, so its ports were not changed. Update your <code>haproxy.cfg</code> to match; <code>freighter haproxy setup</code> prints the lines.
    </Message>

    <Skeleton v-if="isLoading" height="16rem" />
    <Message v-else-if="error" severity="error" :closable="false">Could not read this server's settings: {{ errorMessage(error) }}</Message>

    <section v-for="s in sections" v-else :key="s.name" class="flex flex-col gap-1">
      <h2 class="font-display font-semibold text-[1.5rem] leading-tight mb-2">{{ s.name }}</h2>
      <div class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] divide-y divide-[var(--fr-line)]">
        <div v-for="f in s.fields" :key="f.key" class="grid gap-x-8 gap-y-2 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          <div class="min-w-0">
            <label :for="`cfg-${f.key}`" class="font-medium">
              {{ f.label }}
              <span v-if="isDirty(f)" class="ml-1.5 text-xs font-normal text-[var(--p-amber-600)]">edited</span>
            </label>
            <p class="text-sm text-muted-color mt-0.5 max-w-[60ch]">{{ f.help }}</p>
            <p v-if="f.restart !== 'none'" class="text-xs text-muted-color mt-1">Needs a restart of {{ SERVICE_NAME[f.restart] }}.</p>
          </div>
          <div class="flex flex-col gap-1.5 md:items-stretch">
            <InputText v-if="f.type === 'string'" :id="`cfg-${f.key}`" v-model="form[f.key] as string" :placeholder="f.placeholder" fluid @update:model-value="edited(f)" />
            <div v-else-if="f.type === 'number'" class="flex items-center gap-2">
              <InputNumber :input-id="`cfg-${f.key}`" v-model="form[f.key] as number | null" :min="f.min" :max="f.max" :use-grouping="false" :placeholder="f.default === null ? 'none' : String(f.default)" class="w-32" @update:model-value="edited(f)" />
              <span v-if="f.unit" class="text-sm text-muted-color">{{ f.unit }}</span>
            </div>
            <div v-else-if="f.type === 'boolean'" class="flex items-center gap-2">
              <ToggleSwitch :input-id="`cfg-${f.key}`" v-model="form[f.key] as boolean" @update:model-value="edited(f)" />
              <span class="text-sm text-muted-color">{{ form[f.key] ? "On" : "Off" }}</span>
            </div>
            <Select v-else-if="f.type === 'enum'" :input-id="`cfg-${f.key}`" v-model="form[f.key] as string" :options="optionsFor(f)" option-label="label" option-value="value" fluid @update:model-value="edited(f)" />
            <AutoComplete v-else :input-id="`cfg-${f.key}`" v-model="form[f.key] as string[]" multiple :typeahead="false" :placeholder="f.placeholder" fluid add-on-blur separator="," @update:model-value="edited(f)" />
            <div class="flex items-center gap-2 text-xs text-muted-color min-h-5">
              <span>Default: {{ show(f, f.default) }}</span>
              <Button v-if="showDefaultLink(f)" label="Use default" text size="small" class="!py-0 !px-1 !text-xs" @click="useDefault(f)" />
            </div>
          </div>
        </div>
      </div>
    </section>

    <div v-if="dirty" class="fixed bottom-0 inset-x-0 z-20 border-t border-[var(--fr-line)] bg-[var(--fr-panel)]">
      <div class="mx-auto max-w-[72rem] px-5 py-3 flex items-center justify-end gap-3">
        <span class="text-sm text-muted-color mr-auto">{{ dirty }} unsaved {{ dirty === 1 ? "change" : "changes" }}</span>
        <Button label="Discard" text severity="secondary" size="small" @click="discard" />
        <Button label="Save changes" icon="pi pi-check" size="small" :loading="save.isPending.value" @click="submit" />
      </div>
    </div>
  </div>
</template>
