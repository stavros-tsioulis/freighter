<script setup lang="ts">
import type { AppRow } from "~/types";

const props = defineProps<{ app: AppRow }>();
const visible = defineModel<boolean>({ required: true });
const router = useRouter();

const del = useDeleteApp();
const appName = computed(() => props.app.name);
const { data: domains } = useDomains(appName);
const live = computed(() => (domains.value?.domains ?? []).filter((d) => d.status === "active").map((d) => d.hostname));
const missing = computed(() => props.app.status === "missing");

const typed = ref("");
const forget = ref(false);
const matches = computed(() => typed.value === props.app.name);
watch(visible, (v) => {
  if (v) {
    typed.value = "";
    forget.value = false;
    del.reset();
  }
});
// Only worth offering once deleting failed: the server may be gone for good.
const offerForget = computed(() => del.isError.value && !missing.value);

async function go() {
  const ok = await del.mutateAsync({ app: props.app.name, forget: forget.value }).then(() => true, () => false);
  if (ok) {
    visible.value = false;
    await router.push("/apps");
  }
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="`Delete ${app.name}?`" :style="{ width: '34rem' }" :closable="!del.isPending.value">
    <div class="flex flex-col gap-4 text-sm">
      <Message v-if="missing" severity="warn" size="small">{{ app.server }} no longer reports this app, so only the dashboard's records are removed.</Message>
      <template v-else>
        <p>This permanently deletes <b>{{ app.name }}</b> from <b>{{ app.server }}</b>:</p>
        <ul class="list-disc pl-5 flex flex-col gap-1">
          <li>its {{ app.services.length === 1 ? "service" : `${app.services.length} services` }}, stopped and removed</li>
          <li v-if="live.length">routing for {{ live.join(", ") }}, and their certificates</li>
          <li>every release, and the shared directory, which is where databases and uploaded files live</li>
          <li>its secrets, and its Git deploy key</li>
          <li>its deployment history here</li>
        </ul>
        <p class="text-muted-color">Its Git repository is not touched. There is no undo.</p>
      </template>

      <div class="flex flex-col gap-1">
        <label for="del-name">Type <b>{{ app.name }}</b> to confirm</label>
        <InputText id="del-name" v-model="typed" autocomplete="off" :placeholder="app.name" @keydown.enter="matches && go()" />
      </div>

      <div v-if="offerForget" class="flex items-start gap-2">
        <Checkbox v-model="forget" input-id="del-forget" binary />
        <label for="del-forget">
          {{ app.server }} can't be reached and isn't coming back: remove only the dashboard's records and leave whatever is still on that server.
        </label>
      </div>
    </div>
    <template #footer>
      <Button label="Cancel" severity="secondary" text :disabled="del.isPending.value" @click="visible = false" />
      <Button label="Delete app" icon="pi pi-trash" severity="danger" :disabled="!matches" :loading="del.isPending.value" @click="go" />
    </template>
  </Dialog>
</template>
