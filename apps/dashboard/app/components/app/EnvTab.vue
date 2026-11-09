<script setup lang="ts">
import type { AppRow } from "~/types";
import { ENV_KEY_RE } from "~/utils/validation";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const { data: names, isLoading } = useEnvNames(appName);
const setEnv = useSetEnv(appName);
const { data: variables, isLoading: loadingVars } = useVariables(appName);
const change = useVariableChange(appName);

// ---- variables ----
const showVar = ref(false);
const editing = ref<string | null>(null);
const varKey = ref("");
const varValue = ref("");
const varKeyError = computed(() => (varKey.value && !ENV_KEY_RE.test(varKey.value) ? "Use UPPER_SNAKE_CASE" : ""));
const varValid = computed(() => ENV_KEY_RE.test(varKey.value) && !/[\r\n]/.test(varValue.value));
function openVar(v?: { key: string; value: string }) {
  editing.value = v?.key ?? null;
  varKey.value = v?.key ?? "";
  varValue.value = v?.value ?? "";
  showVar.value = true;
}
function saveVar() {
  change.mutate({ key: varKey.value, value: varValue.value }, { onSuccess: () => (showVar.value = false) });
}

const show = ref(false);
const key = ref("");
const value = ref("");
const keyError = computed(() => (key.value && !ENV_KEY_RE.test(key.value) ? "Use UPPER_SNAKE_CASE" : ""));
const valid = computed(() => ENV_KEY_RE.test(key.value) && value.value.length > 0 && !/[\r\n]/.test(value.value));

const declared = computed(() => {
  const m = /^secrets:\s*\n((?:\s+-\s*\S+\s*\n?)+)/m.exec(props.app.manifestText ?? "");
  return m ? [...m[1]!.matchAll(/-\s*(\S+)/g)].map((x) => x[1]!) : [];
});
const missing = computed(() => declared.value.filter((d) => !(names.value ?? []).includes(d)));

function open(k = "") {
  key.value = k;
  value.value = "";
  show.value = true;
}
function save() {
  setEnv.mutate({ key: key.value, value: value.value }, { onSuccess: () => { show.value = false; value.value = ""; } });
}
</script>

<template>
  <div class="flex flex-col gap-8">
    <section aria-labelledby="vars-h" class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <h3 id="vars-h" class="font-display font-semibold text-[1.35rem] leading-tight">Variables</h3>
        <Button v-if="can('admin')" label="Add variable" icon="pi pi-plus" size="small" @click="openVar()" />
      </div>
      <Skeleton v-if="loadingVars" height="3rem" />
      <p v-else-if="!(variables ?? []).length" class="text-sm text-muted-color">None</p>
      <ul v-else class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] divide-y divide-[var(--fr-line)]">
        <li v-for="v in variables" :key="v.key" class="var-row">
          <code class="var-key">{{ v.key }}</code>
          <div class="min-w-0">
            <code class="var-val" :title="v.value">{{ v.value }}</code>
            <p v-if="v.reference && v.resolved !== null" class="var-res"><i class="pi pi-arrow-right text-[0.65rem]" aria-hidden="true" /><code :title="v.resolved">{{ v.resolved }}</code></p>
            <p v-else-if="v.secret" class="var-res"><i class="pi pi-lock text-[0.65rem]" aria-hidden="true" />hidden</p>
            <p v-else-if="v.error" class="var-res text-red-600 dark:text-red-400"><i class="pi pi-exclamation-triangle text-[0.7rem]" aria-hidden="true" />{{ v.error }}</p>
          </div>
          <div class="var-end">
            <span v-if="v.source !== 'added'" class="text-xs text-muted-color whitespace-nowrap">{{ v.source === "override" ? "overridden" : "app.yaml" }}</span>
            <template v-if="can('admin')">
              <Button icon="pi pi-pencil" text rounded size="small" severity="secondary" :aria-label="`Edit ${v.key}`" @click="openVar(v)" />
              <Button v-if="v.source !== 'app.yaml'" :icon="v.source === 'override' ? 'pi pi-undo' : 'pi pi-trash'" text rounded size="small" severity="secondary" :aria-label="v.source === 'override' ? `Reset ${v.key} to app.yaml` : `Remove ${v.key}`" :title="v.source === 'override' ? 'Back to the app.yaml value' : 'Remove'" :loading="change.isPending.value && change.variables.value?.key === v.key" @click="change.mutate({ key: v.key })" />
            </template>
          </div>
        </li>
      </ul>
    </section>

    <section aria-labelledby="secrets-h" class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <h3 id="secrets-h" class="font-display font-semibold text-[1.35rem] leading-tight">Secrets</h3>
        <Button v-if="can('admin')" label="Set secret" icon="pi pi-plus" size="small" @click="open()" />
      </div>
      <Message v-if="missing.length" severity="warn" size="small">Not set: <b>{{ missing.join(", ") }}</b>. Deploys fail until they are.</Message>
      <Skeleton v-if="isLoading" height="3rem" />
      <div v-else class="flex flex-wrap gap-2">
        <Tag v-for="n in names ?? []" :key="n" severity="secondary" class="font-mono">{{ n }}</Tag>
        <span v-if="!(names ?? []).length" class="text-muted-color text-sm">None</span>
      </div>
      <Button v-for="m in can('admin') ? missing : []" :key="m" :label="`Set ${m}`" size="small" outlined severity="warn" class="self-start" @click="open(m)" />
    </section>

    <Dialog v-model:visible="showVar" modal :header="editing ? `Edit ${editing}` : 'Add variable'" :style="{ width: '28rem' }" :closable="!change.isPending.value">
      <form class="flex flex-col gap-3" autocomplete="off" @submit.prevent="varValid && saveVar()">
        <div class="flex flex-col gap-1">
          <label for="var-key" class="text-sm font-medium">Name</label>
          <InputText id="var-key" v-model="varKey" class="font-mono" :disabled="!!editing" :invalid="!!varKeyError" autocomplete="off" />
          <small v-if="varKeyError" class="text-red-500">{{ varKeyError }}</small>
        </div>
        <div class="flex flex-col gap-1">
          <label for="var-value" class="text-sm font-medium">Value</label>
          <InputText id="var-value" v-model="varValue" class="font-mono" autocomplete="off" />
        </div>
        <button type="submit" class="hidden" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text :disabled="change.isPending.value" @click="showVar = false" />
        <Button label="Save" :disabled="!varValid" :loading="change.isPending.value" @click="saveVar" />
      </template>
    </Dialog>

    <Dialog v-model:visible="show" modal header="Set secret" :style="{ width: '28rem' }">
      <form class="flex flex-col gap-3" @submit.prevent="valid && save()">
        <div class="flex flex-col gap-1">
          <label for="env-key" class="text-sm font-medium">Name</label>
          <InputText id="env-key" v-model="key" class="font-mono" :invalid="!!keyError" autocomplete="off" />
          <small v-if="keyError" class="text-red-500">{{ keyError }}</small>
        </div>
        <div class="flex flex-col gap-1">
          <label for="env-value" class="text-sm font-medium">Value</label>
          <Password v-model="value" input-id="env-value" :feedback="false" toggle-mask fluid autocomplete="off" />
        </div>
        <button type="submit" class="hidden" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="show = false" />
        <Button label="Save secret" :disabled="!valid" :loading="setEnv.isPending.value" @click="save" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.var-row { display: grid; grid-template-columns: minmax(8rem, 14rem) minmax(0, 1fr) auto; gap: 0.25rem 1rem; padding: 0.55rem 0.9rem; align-items: start; }
.var-key { font-weight: 500; overflow-wrap: anywhere; }
.var-val { display: block; overflow-wrap: anywhere; color: var(--p-text-muted-color); }
.var-res { margin: 0.15rem 0 0; display: flex; align-items: baseline; gap: 0.4rem; font-size: 0.86rem; overflow-wrap: anywhere; }
.var-res i { flex: none; }
.var-end { display: flex; align-items: center; gap: 0.15rem; justify-self: end; }
@media (max-width: 639px) { .var-row { grid-template-columns: minmax(0, 1fr) auto; } .var-row > :nth-child(2) { grid-column: 1 / -1; grid-row: 2; } .var-row > :nth-child(3) { grid-column: 2; grid-row: 1; } }
</style>
