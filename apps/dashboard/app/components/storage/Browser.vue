<script setup lang="ts">
import { collectDropped, collectPicked, startDownload, storageDownloadUrl, storageFilesRoot, toUploads, useStorageActions, useStorageList, useUploader, type StorageEntry } from "~/composables/files";
import { baseName, breadcrumbs, items, joinPath, parentOf } from "~/utils/files";
import { formatBytes } from "~/utils/format";

/** The buckets of a storage and the keys in them: browse, upload, download, rename, delete. */
const props = defineProps<{ name: string; /** Where its S3 endpoint is, to show in the S3 URL of a key. */ endpoint?: string | null }>();
const path = defineModel<string>("path", { default: "/" });

const confirm = useConfirm();
const notify = useNotify();
const { data: listing, error, isFetching } = useStorageList(computed(() => props.name), path);
const actions = useStorageActions(computed(() => props.name));
const uploader = useUploader(computed(() => storageFilesRoot(props.name)), () => void actions.refresh());

const atRoot = computed(() => path.value === "/");
const bucket = computed(() => path.value.split("/").filter(Boolean)[0] ?? "");
const crumbs = computed(() => breadcrumbs(path.value).map((c, i) => (i === 0 ? { ...c, name: "Buckets" } : c)));
const errorText = computed(() => (error.value as Error | null)?.message ?? "");

// ---- what is shown ----
const filter = ref("");
const sortKey = ref<"name" | "size" | "mtime">("name");
const desc = ref(false);
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const all = listing.value?.entries ?? [];
  const dir = desc.value ? -1 : 1;
  return [...(q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all)].sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const by = sortKey.value === "size" ? a.size - b.size : sortKey.value === "mtime" ? a.mtimeMs - b.mtimeMs : byName;
    return by !== 0 ? by * dir : byName;
  });
});
function sort(key: "name" | "size" | "mtime") {
  if (sortKey.value === key) desc.value = !desc.value;
  else { sortKey.value = key; desc.value = false; }
}
const selection = ref<StorageEntry[]>([]);
const chosen = computed(() => selection.value.filter((e) => shown.value.some((s) => s.name === e.name)));
const chosenPaths = computed(() => chosen.value.map((e) => joinPath(path.value, e.name)));
const single = computed(() => (chosen.value.length === 1 ? chosen.value[0]! : null));
watch(path, () => { selection.value = []; filter.value = ""; });

const s3Uri = (p: string) => `s3:/${p}`;
const urlOf = (p: string) => (props.endpoint ? `${props.endpoint}${p}` : null);
async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok(`${what} copied`);
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}

function open(e: StorageEntry) {
  const target = joinPath(path.value, e.name);
  if (e.type === "dir") path.value = target;
  else startDownload(storageDownloadUrl(props.name, target));
}

// ---- new bucket / folder, rename ----
const nameDialog = ref<{ kind: "rename" | "new"; from?: string } | null>(null);
const nameInput = ref("");
const showName = computed({ get: () => nameDialog.value !== null, set: (v) => { if (!v) nameDialog.value = null; } });
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const nameError = computed(() => {
  const v = nameInput.value.trim();
  if (!v) return "";
  if (v.includes("/")) return "A name can't contain /";
  if ([".", ".."].includes(v)) return "Not a valid name";
  if (nameDialog.value?.kind === "new" && atRoot.value && !BUCKET_RE.test(v)) return "3–63 characters: lowercase letters, digits, dots and hyphens";
  return "";
});
const creatingBucket = computed(() => nameDialog.value?.kind === "new" && atRoot.value);
function askNew() {
  nameInput.value = "";
  nameDialog.value = { kind: "new" };
}
function askRename() {
  const e = single.value;
  if (!e) return;
  nameInput.value = e.name;
  nameDialog.value = { kind: "rename", from: joinPath(path.value, e.name) };
  nextTick(() => { const el = document.getElementById("sb-name") as HTMLInputElement | null; el?.focus(); el?.setSelectionRange(0, e.name.lastIndexOf(".") > 0 ? e.name.lastIndexOf(".") : e.name.length); });
}
async function submitName() {
  const d = nameDialog.value;
  const value = nameInput.value.trim();
  if (!d || !value || nameError.value) return;
  const ok = await (d.kind === "rename" ? actions.rename.mutateAsync({ path: d.from!, newName: value }) : actions.mkdir.mutateAsync({ path: joinPath(path.value, value) })).then(() => true, () => false);
  if (ok) nameDialog.value = null;
}

// ---- delete ----
const problems = ref<{ title: string; failed: { path: string; error: string }[] } | null>(null);
const showProblems = computed({ get: () => problems.value !== null, set: (v) => { if (!v) problems.value = null; } });
function askDelete(paths = chosenPaths.value) {
  if (!paths.length) return;
  const buckets = atRoot.value;
  confirm.require({
    header: `Delete ${paths.length === 1 ? baseName(paths[0]!) : items(paths.length)}?`,
    message: buckets ? "Everything in the bucket is deleted with it. This can't be undone." : "Folders go with everything in them. This can't be undone.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Delete",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: async () => {
      const r = await actions.remove.mutateAsync({ paths }).catch(() => null);
      if (!r) return;
      selection.value = [];
      if (r.failed.length === 0) return notify.ok("Deleted", items(r.done.length));
      if (r.done.length) notify.ok("Deleted", `${items(r.done.length)} done`);
      problems.value = { title: `${items(r.failed.length)} could not be deleted`, failed: r.failed };
    },
  });
}

// ---- upload ----
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const dragging = ref(0);
async function upload(c: { files: { file: File; rel: string }[]; dirs: string[] }) {
  if (c.files.length === 0 && c.dirs.length === 0) return;
  if (atRoot.value) return notify.fail("Open a bucket first", new Error("Files go in a bucket. Create one, then open it."));
  const { items: list, dirs } = toUploads(path.value, c);
  const top = [...new Set(c.files.map((f) => f.rel.split("/")[0]!))];
  const taken = top.filter((n) => (listing.value?.entries ?? []).some((e) => e.name === n));
  const go = (overwrite: boolean) => void uploader.add(list, { overwrite, dirs });
  if (taken.length === 0) return go(false);
  confirm.require({
    header: `Replace ${items(taken.length)}?`,
    message: `${taken.slice(0, 6).join(", ")}${taken.length > 6 ? ", …" : ""} already ${taken.length === 1 ? "exists" : "exist"} here.`,
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Replace",
    rejectLabel: "Cancel",
    rejectProps: { severity: "secondary", text: true },
    accept: () => go(true),
  });
}
async function onDrop(e: DragEvent) {
  dragging.value = 0;
  if (!e.dataTransfer) return;
  await upload(await collectDropped(e.dataTransfer));
}
function picked(e: Event, folder: boolean) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  void upload(folder ? collectPicked(input.files) : { files: [...input.files].map((file) => ({ file, rel: file.name })), dirs: [] });
  input.value = "";
}
const busyUploads = computed(() => uploader.jobs.value.filter((j) => j.state === "uploading" || j.state === "queued").length);

// ---- menus and keys ----
const menu = ref();
const menuItems = computed(() => {
  const e = single.value;
  const url = e && e.type === "file" ? urlOf(joinPath(path.value, e.name)) : null;
  return [
    ...(e ? [{ label: e.type === "dir" ? "Open" : "Download", icon: e.type === "dir" ? "pi pi-folder-open" : "pi pi-download", command: () => open(e) }] : []),
    { separator: true },
    { label: "Copy S3 URI", icon: "pi pi-link", command: () => void copy(chosenPaths.value.map(s3Uri).join("\n"), "S3 URI") },
    ...(url ? [{ label: "Copy URL", icon: "pi pi-globe", command: () => void copy(url, "URL") }] : []),
    { separator: true },
    { label: "Rename", icon: "pi pi-pencil", disabled: !e, command: () => askRename() },
    { label: "Delete", icon: "pi pi-trash", command: () => askDelete() },
  ];
});
function onContext(e: { originalEvent: Event; data: StorageEntry }) {
  if (!chosen.value.some((s) => s.name === e.data.name)) selection.value = [e.data];
  menu.value?.show(e.originalEvent);
}
function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLInputElement;
  const typing = (target.tagName === "INPUT" && !["checkbox", "radio", "file"].includes(target.type)) || target.tagName === "TEXTAREA" || target.isContentEditable;
  if (typing) return;
  if ((e.metaKey || e.ctrlKey) && e.key === "a") { e.preventDefault(); selection.value = [...shown.value]; }
  else if (e.key === "Delete" && chosen.value.length) { e.preventDefault(); askDelete(); }
  else if (e.key === "F2" && single.value) { e.preventDefault(); askRename(); }
  else if (e.key === "Backspace" && !atRoot.value) { e.preventDefault(); path.value = parentOf(path.value); }
  else if (e.key === "Enter" && single.value) { e.preventDefault(); open(single.value); }
}
const when = (ms: number) => (ms ? new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
const icon = (e: StorageEntry) => (e.type === "dir" ? (atRoot.value ? "pi pi-inbox" : "pi pi-folder") : /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(e.name) ? "pi pi-image" : /\.(zip|tar|gz|tgz|xz|bz2|7z)$/i.test(e.name) ? "pi pi-box" : "pi pi-file");
</script>

<template>
  <div
    class="flex flex-col gap-3"
    tabindex="-1"
    @keydown="onKey"
    @dragenter.prevent="dragging++"
    @dragover.prevent
    @dragleave.prevent="dragging = Math.max(0, dragging - 1)"
    @drop.prevent="onDrop"
  >
    <!-- where you are -->
    <div class="flex flex-wrap items-center gap-2">
      <Button icon="pi pi-arrow-up" text rounded size="small" severity="secondary" aria-label="Up one level" title="Up (Backspace)" :disabled="atRoot" @click="path = parentOf(path)" />
      <Button icon="pi pi-refresh" text rounded size="small" severity="secondary" aria-label="Refresh" :loading="isFetching" @click="actions.refresh()" />
      <nav class="crumbs flex-1 min-w-[12rem]" aria-label="Location">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="text-muted-color" aria-hidden="true">/</span>
          <button type="button" class="crumb" :class="{ 'font-semibold': i === crumbs.length - 1 }" @click="path = c.path">{{ c.name }}</button>
        </template>
      </nav>
    </div>

    <!-- what you can do -->
    <div class="flex flex-wrap items-center gap-2">
      <Button v-if="!atRoot" label="Upload" icon="pi pi-upload" size="small" @click="fileInput?.click()" />
      <Button :label="atRoot ? 'New bucket' : 'New folder'" :icon="atRoot ? 'pi pi-plus' : 'pi pi-folder-plus'" size="small" :severity="atRoot ? undefined : 'secondary'" @click="askNew" />
      <Button v-if="!atRoot" label="Upload a folder" icon="pi pi-sitemap" size="small" severity="secondary" text @click="folderInput?.click()" />
      <span class="w-px h-5 bg-[var(--fr-line)] mx-1" aria-hidden="true" />
      <Button label="Download" icon="pi pi-download" size="small" severity="secondary" text :disabled="!single || single.type !== 'file'" @click="single && open(single)" />
      <Button label="Copy S3 URI" icon="pi pi-link" size="small" severity="secondary" text :disabled="!chosen.length" @click="copy(chosenPaths.map(s3Uri).join('\n'), 'S3 URI')" />
      <Button label="Rename" icon="pi pi-pencil" size="small" severity="secondary" text :disabled="!single" @click="askRename" />
      <Button label="Delete" icon="pi pi-trash" size="small" severity="danger" text :disabled="!chosen.length" :loading="actions.remove.isPending.value" @click="askDelete()" />
      <IconField class="ml-auto">
        <InputIcon class="pi pi-search" />
        <InputText v-model="filter" size="small" placeholder="Filter" aria-label="Filter this list" autocomplete="off" class="w-44" />
      </IconField>
    </div>
    <input ref="fileInput" type="file" multiple class="hidden" tabindex="-1" @change="picked($event, false)" />
    <input ref="folderInput" type="file" webkitdirectory class="hidden" tabindex="-1" @change="picked($event, true)" />

    <Message v-if="errorText && !listing" severity="error" size="small">{{ errorText }}</Message>
    <Message v-else-if="errorText" severity="warn" size="small">{{ errorText }}</Message>
    <Message v-if="listing?.truncated" severity="warn" size="small">There are more entries than are shown. Use the filter, or open a deeper folder.</Message>

    <div class="relative">
      <DataTable
        v-model:selection="selection"
        :value="shown"
        data-key="name"
        selection-mode="multiple"
        :meta-key-selection="true"
        context-menu
        scrollable
        scroll-height="60vh"
        size="small"
        :loading="isFetching && !listing"
        @row-dblclick="open($event.data)"
        @row-contextmenu="onContext"
      >
        <template #empty>
          <div class="py-6 text-center text-muted-color">
            <template v-if="filter">Nothing here matches.</template>
            <template v-else-if="errorText" />
            <template v-else-if="atRoot">No buckets yet. Create one, then drop files into it.</template>
            <template v-else>Empty. Drop files here, or press Upload.</template>
          </div>
        </template>
        <Column selection-mode="multiple" header-style="width: 2.75rem" />
        <Column field="name">
          <template #header><button type="button" class="sort" @click.stop="sort('name')">{{ atRoot ? "Bucket" : "Name" }}<i v-if="sortKey === 'name'" :class="desc ? 'pi pi-arrow-down' : 'pi pi-arrow-up'" class="text-[0.65rem]" aria-hidden="true" /></button></template>
          <template #body="{ data }">
            <span class="inline-flex items-center gap-2 min-w-0">
              <i :class="icon(data)" class="text-muted-color shrink-0" aria-hidden="true" />
              <span class="truncate" :title="data.name">{{ data.name }}</span>
            </span>
          </template>
        </Column>
        <Column field="size" header-class="text-right" body-class="text-right" style="width: 7rem">
          <template #header><button type="button" class="sort ml-auto" @click.stop="sort('size')">Size<i v-if="sortKey === 'size'" :class="desc ? 'pi pi-arrow-down' : 'pi pi-arrow-up'" class="text-[0.65rem]" aria-hidden="true" /></button></template>
          <template #body="{ data }"><span class="num text-muted-color">{{ data.type === "dir" ? "–" : formatBytes(data.size) }}</span></template>
        </Column>
        <Column field="mtimeMs" style="width: 11rem" class="hidden sm:table-cell" header-class="hidden sm:table-cell">
          <template #header><button type="button" class="sort" @click.stop="sort('mtime')">Modified<i v-if="sortKey === 'mtime'" :class="desc ? 'pi pi-arrow-down' : 'pi pi-arrow-up'" class="text-[0.65rem]" aria-hidden="true" /></button></template>
          <template #body="{ data }"><span class="text-muted-color text-sm">{{ when(data.mtimeMs) }}</span></template>
        </Column>
      </DataTable>
      <div v-if="dragging && !atRoot" class="drop" aria-hidden="true"><i class="pi pi-upload text-2xl" /><span>Drop to upload to <code>{{ path }}</code></span></div>
    </div>
    <ContextMenu ref="menu" :model="menuItems" />

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-color">
      <span>{{ items(listing?.entries.length ?? 0) }}<template v-if="filter"> · {{ shown.length }} shown</template></span>
      <span v-if="chosen.length">{{ chosen.length }} selected</span>
      <span v-if="!atRoot" class="font-mono truncate" :title="s3Uri(path)">{{ s3Uri(path) }}</span>
      <span class="ml-auto hidden md:inline">Delete · F2 · Enter or double-click to open</span>
    </div>

    <aside v-if="uploader.jobs.value.length" class="uploads" aria-label="Uploads" aria-live="polite">
      <div class="flex items-center gap-2 mb-1">
        <b class="text-sm">{{ busyUploads ? `Uploading ${busyUploads}…` : "Uploads" }}</b>
        <Button v-if="!busyUploads" label="Clear" size="small" text severity="secondary" class="ml-auto" @click="uploader.clearFinished()" />
      </div>
      <ul class="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
        <li v-for="j in uploader.jobs.value" :key="j.id" class="text-xs">
          <div class="flex items-center gap-2">
            <span class="truncate flex-1" :title="j.path">{{ baseName(j.path) }}</span>
            <span v-if="j.state === 'error'" class="text-red-600 dark:text-red-400 truncate" :title="j.error">{{ j.error }}</span>
            <span v-else-if="j.state === 'done'" class="text-green-600 dark:text-green-400">done</span>
            <span v-else-if="j.state === 'canceled'" class="text-muted-color">canceled</span>
            <span v-else class="num text-muted-color">{{ formatBytes(j.loaded) }} / {{ formatBytes(j.size) }}</span>
            <button v-if="j.state === 'uploading' || j.state === 'queued'" type="button" class="text-muted-color hover:text-color" :aria-label="`Cancel ${baseName(j.path)}`" @click="uploader.cancel(j.id)"><i class="pi pi-times text-[0.65rem]" /></button>
          </div>
          <ProgressBar v-if="j.state === 'uploading'" :value="j.size ? Math.round((j.loaded / j.size) * 100) : 100" :show-value="false" style="height: 4px" />
        </li>
      </ul>
    </aside>

    <Dialog v-model:visible="showName" modal :header="nameDialog?.kind === 'rename' ? 'Rename' : creatingBucket ? 'New bucket' : 'New folder'" :style="{ width: '26rem' }">
      <form class="flex flex-col gap-1" @submit.prevent="submitName">
        <label for="sb-name" class="text-sm font-medium">Name</label>
        <InputText id="sb-name" v-model="nameInput" autocomplete="off" spellcheck="false" :invalid="!!nameError" />
        <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
        <button type="submit" class="hidden" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="nameDialog = null" />
        <Button :label="nameDialog?.kind === 'rename' ? 'Rename' : 'Create'" :disabled="!nameInput.trim() || !!nameError" :loading="actions.rename.isPending.value || actions.mkdir.isPending.value" @click="submitName" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showProblems" modal :header="problems?.title" :style="{ width: '36rem' }">
      <ul class="flex flex-col gap-1 text-sm max-h-72 overflow-y-auto">
        <li v-for="f in problems?.failed" :key="f.path"><code class="break-all">{{ f.path }}</code><br /><span class="text-muted-color">{{ f.error }}</span></li>
      </ul>
      <template #footer><Button label="Close" severity="secondary" text @click="problems = null" /></template>
    </Dialog>
  </div>
</template>

<style scoped>
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 0.1rem 0.25rem; padding: 0.3rem 0.6rem; border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-md); background: var(--fr-panel); min-height: 2.2rem; font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.9rem; }
.crumb { background: none; border: 0; padding: 0.1rem 0.25rem; border-radius: 0.3rem; cursor: pointer; color: inherit; }
.crumb:hover { background: var(--p-content-hover-background, rgb(0 0 0 / 0.06)); }
.sort { display: inline-flex; align-items: center; gap: 0.3rem; background: none; border: 0; padding: 0; font: inherit; font-weight: 600; color: inherit; cursor: pointer; }
.drop { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; background: color-mix(in srgb, var(--p-primary-color) 12%, var(--fr-panel)); border: 2px dashed var(--p-primary-color); border-radius: var(--p-border-radius-lg); pointer-events: none; }
.uploads { position: sticky; bottom: 0.5rem; align-self: flex-end; width: min(26rem, 100%); padding: 0.7rem 0.9rem; background: var(--fr-panel); border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-lg); box-shadow: 0 8px 24px rgb(0 0 0 / 0.14); z-index: 6; }
:deep(.p-datatable-tbody > tr) { cursor: default; user-select: none; }
</style>
