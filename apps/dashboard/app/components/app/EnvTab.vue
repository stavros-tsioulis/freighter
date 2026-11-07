<script setup lang="ts">
import type { AppRow } from "~/types";
import { ENV_KEY_RE } from "~/utils/validation";

const props = defineProps<{ app: AppRow }>();
const { can } = useSession();
const appName = computed(() => props.app.name);
const { data: names, isLoading } = useEnvNames(appName);
const setEnv = useSetEnv(appName);

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
  <div class="flex flex-col gap-3">
    <Message v-if="missing.length" severity="warn" size="small">
      Declared in <code>app.yaml</code> but not set: <b>{{ missing.join(", ") }}</b>. Deploys fail until they exist.
    </Message>
    <div class="flex items-center justify-between">
      <h3 class="font-medium">Secrets</h3>
      <Button v-if="can('admin')" label="Set secret" icon="pi pi-plus" size="small" @click="open()" />
    </div>
    <Skeleton v-if="isLoading" height="3rem" />
    <div v-else class="flex flex-wrap gap-2">
      <Tag v-for="n in names ?? []" :key="n" severity="secondary" class="font-mono">{{ n }}</Tag>
      <span v-if="!(names ?? []).length" class="text-muted-color text-sm">No secrets set.</span>
    </div>
    <Button v-for="m in can('admin') ? missing : []" :key="m" :label="`Set ${m}`" size="small" outlined severity="warn" class="self-start" @click="open(m)" />

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
        <Button label="Save" icon="pi pi-check" :disabled="!valid" :loading="setEnv.isPending.value" @click="save" />
      </template>
    </Dialog>
  </div>
</template>
