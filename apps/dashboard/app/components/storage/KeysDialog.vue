<script setup lang="ts">
/** The key pair of a storage, shown once: when it is created and when its secret is rotated. */
defineProps<{ name: string; accessKey: string; secretKey: string; rotated?: boolean }>();
const visible = defineModel<boolean>({ required: true });
const notify = useNotify();
async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok(`${what} copied`);
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}
</script>

<template>
  <Dialog v-model:visible="visible" modal :header="rotated ? 'New secret key' : `${name} is being created`" :style="{ width: '34rem' }">
    <div class="flex flex-col gap-4">
      <Message severity="warn" size="small" :closable="false">The secret key is shown once. Apps get it by connecting to the storage.</Message>
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 text-sm">
        <span class="text-muted-color">Access key</span>
        <code class="break-all">{{ accessKey }}</code>
        <Button icon="pi pi-copy" text rounded size="small" severity="secondary" aria-label="Copy access key" @click="copy(accessKey, 'Access key')" />
        <span class="text-muted-color">Secret key</span>
        <code class="break-all">{{ secretKey }}</code>
        <Button icon="pi pi-copy" text rounded size="small" severity="secondary" aria-label="Copy secret key" @click="copy(secretKey, 'Secret key')" />
      </div>
    </div>
    <template #footer><Button label="Done" @click="visible = false" /></template>
  </Dialog>
</template>
