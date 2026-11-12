<script setup lang="ts">
import type { FsBulk, FsEntry } from "~/types";
import { collectDropped, collectPicked, downloadArchive, fileDownloadUrl, startDownload, toUploads, useFsActions, useFsIdentities, serverFilesRoot, useFsList, useUploader } from "~/composables/files";
import { baseName, breadcrumbs, clashes, entryIcon, formatMode, isArchive, items, joinPath, opensAsFolder, parentOf, resolveTyped, sortEntries, type SortKey } from "~/utils/files";
import { formatBytes } from "~/utils/format";

/** Every file on a server, as root: browse, upload, download, and act on several at once. */
const props = defineProps<{ server: string; readOnly?: boolean }>();
const path = defineModel<string>("path", { default: "/" });

const confirm = useConfirm();
const notify = useNotify();
const { data: listing, error, isFetching } = useFsList(computed(() => props.server), path);
const actions = useFsActions(computed(() => props.server));
const uploader = useUploader(computed(() => serverFilesRoot(props.server)), () => void actions.refresh());

// ---- what is shown ----
const filter = ref("");
const sortKey = ref<SortKey>("name");
const desc = ref(false);
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const all = listing.value?.entries ?? [];
  return sortEntries(q ? all.filter((e) => e.name.toLowerCase().includes(q)) : all, sortKey.value, desc.value);
});
const selection = ref<FsEntry[]>([]);
const chosen = computed(() => selection.value.filter((e) => shown.value.some((s) => s.name === e.name)));
const chosenPaths = computed(() => chosen.value.map((e) => joinPath(path.value, e.name)));
const chosenSize = computed(() => chosen.value.reduce((n, e) => n + e.size, 0));
watch(path, () => { selection.value = []; filter.value = ""; });
function sort(key: SortKey) {
  if (sortKey.value === key) desc.value = !desc.value;
  else { sortKey.value = key; desc.value = false; }
}

// ---- moving around ----
const editing = ref(false);
const typed = ref("");
const crumbs = computed(() => breadcrumbs(path.value));
function go(to: string) { path.value = to; }
function startEdit() { typed.value = path.value; editing.value = true; nextTick(() => (document.getElementById("fx-path") as HTMLInputElement | null)?.select()); }
function commitEdit() { editing.value = false; go(resolveTyped(typed.value, path.value)); }
const places = [["/", "pi pi-server"], ["/srv/apps", "pi pi-box"], ["/etc/freighter", "pi pi-cog"], ["/var/log", "pi pi-list"], ["/tmp", "pi pi-clock"], ["/root", "pi pi-home"]] as const;
function open(e: FsEntry) {
  const target = joinPath(path.value, e.name);
  if (opensAsFolder(e)) go(e.type === "link" && e.link ? resolveTyped(e.link.target, path.value) : target);
  else if (e.type === "file" || (e.type === "link" && e.link?.type === "file")) startDownload(fileDownloadUrl(props.server, target));
}

// ---- clipboard (shared between folders, not between servers) ----
const clipboard = useState<{ mode: "copy" | "cut"; server: string; paths: string[] } | null>("file-clipboard", () => null);
const canPaste = computed(() => !props.readOnly && clipboard.value?.server === props.server && clipboard.value.paths.length > 0);
const cut = (paths = chosenPaths.value) => (clipboard.value = { mode: "cut", server: props.server, paths });
const copy = (paths = chosenPaths.value) => (clipboard.value = { mode: "copy", server: props.server, paths });
const isCut = (e: FsEntry) => clipboard.value?.mode === "cut" && clipboard.value.server === props.server && clipboard.value.paths.includes(joinPath(path.value, e.name));

const problems = ref<{ title: string; failed: FsBulk["failed"]; retry?: { mode: "copy" | "move"; paths: string[]; to: string } } | null>(null);
const showProblems = computed({ get: () => problems.value !== null, set: (v) => { if (!v) problems.value = null; } });
function report(title: string, r: FsBulk, retry?: { mode: "copy" | "move"; paths: string[]; to: string }) {
  if (r.failed.length === 0) return notify.ok(title, items(r.done.length));
  if (r.done.length > 0) notify.ok(title, `${items(r.done.length)} done`);
  const clash = retry ? r.failed.filter((f) => /already exists/.test(f.error)) : [];
  problems.value = { title: `${r.failed.length === 1 ? "1 item" : `${r.failed.length} items`} could not be done`, failed: r.failed, retry: clash.length ? { ...retry!, paths: clash.map((f) => f.path) } : undefined };
}
async function paste() {
  const c = clipboard.value;
  if (!c || !canPaste.value) return;
  const to = path.value;
  const sameFolder = c.paths.every((p) => parentOf(p) === to);
  if (c.mode === "cut" && sameFolder) { clipboard.value = null; return; }
  const mode = c.mode === "copy" ? "copy" : "move";
  const r = await (mode === "copy" ? actions.copy : actions.move).mutateAsync({ paths: c.paths, to, onConflict: mode === "copy" && sameFolder ? "rename" : "fail" }).catch(() => null);
  if (!r) return;
  if (c.mode === "cut") clipboard.value = r.failed.length ? { ...c, paths: r.failed.map((f) => f.path) } : null;
  report(mode === "copy" ? "Copied" : "Moved", r, { mode, paths: c.paths, to });
}
// ---- ownership ----
const owning = ref(false);
const ownerInput = ref("");
const groupInput = ref("");
const recursive = ref(false);
const { data: identities } = useFsIdentities(computed(() => props.server), owning);
const hasFolder = computed(() => chosen.value.some(opensAsFolder));
function askOwner() {
  if (props.readOnly || !chosen.value.length) return;
  // Start from what the selection has in common, so changing one half leaves the other alone.
  const same = (f: (e: FsEntry) => string) => (chosen.value.every((e) => f(e) === f(chosen.value[0]!)) ? f(chosen.value[0]!) : "");
  ownerInput.value = same((e) => e.owner ?? String(e.uid));
  groupInput.value = same((e) => e.group ?? String(e.gid));
  recursive.value = false;
  owning.value = true;
}
const ownerChanged = computed(() => {
  const same = (f: (e: FsEntry) => string, v: string) => chosen.value.every((e) => f(e) === v);
  return { owner: ownerInput.value.trim() !== "" && !same((e) => e.owner ?? String(e.uid), ownerInput.value.trim()), group: groupInput.value.trim() !== "" && !same((e) => e.group ?? String(e.gid), groupInput.value.trim()) };
});
async function submitOwner() {
  const owner = ownerChanged.value.owner ? ownerInput.value.trim() : undefined;
  const group = ownerChanged.value.group ? groupInput.value.trim() : undefined;
  // Applying to the inside of a folder is a change even when the folder itself already has these.
  if (!owner && !group && !(recursive.value && hasFolder.value)) { owning.value = false; return; }
  const o = owner ?? (recursive.value ? ownerInput.value.trim() || undefined : undefined);
  const g = group ?? (recursive.value ? groupInput.value.trim() || undefined : undefined);
  const r = await actions.chown.mutateAsync({ paths: chosenPaths.value, owner: o, group: g, recursive: recursive.value && hasFolder.value }).catch(() => null);
  if (!r) return;
  owning.value = false;
  report("Ownership changed", r);
}

// ---- extract ----
const extractable = computed(() => chosen.value.length > 0 && chosen.value.every((e) => (e.type === "file" || (e.type === "link" && e.link?.type === "file")) && isArchive(e.name)));
async function extract() {
  if (!extractable.value) return;
  const r = await actions.extract.mutateAsync({ paths: chosenPaths.value }).catch(() => null);
  if (r) report("Extracted", r);
}
async function resolveClash(onConflict: "overwrite" | "rename") {
  const retry = problems.value?.retry;
  problems.value = null;
  if (!retry) return;
  const r = await (retry.mode === "copy" ? actions.copy : actions.move).mutateAsync({ paths: retry.paths, to: retry.to, onConflict }).catch(() => null);
  if (r) report(retry.mode === "copy" ? "Copied" : "Moved", r);
}

// ---- delete, rename, new folder ----
function askDelete(paths = chosenPaths.value) {
  if (props.readOnly || paths.length === 0) return;
  const names = paths.slice(0, 6).map(baseName).join(", ") + (paths.length > 6 ? `, and ${paths.length - 6} more` : "");
  confirm.require({
    header: `Delete ${items(paths.length)}?`,
    message: `${names}. This can't be undone, and folders go with everything in them.`,
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Delete",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: async () => {
      const r = await actions.remove.mutateAsync({ paths }).catch(() => null);
      if (!r) return;
      selection.value = [];
      report("Deleted", r);
    },
  });
}
const nameDialog = ref<{ kind: "rename" | "folder"; from?: string } | null>(null);
const nameInput = ref("");
const showName = computed({ get: () => nameDialog.value !== null, set: (v) => { if (!v) nameDialog.value = null; } });
const nameError = computed(() => (nameInput.value.includes("/") ? "A name can't contain /" : nameInput.value.trim() === "" ? "" : [".", ".."].includes(nameInput.value.trim()) ? "Not a valid name" : ""));
function askRename(e = chosen.value[0]) {
  if (!e || props.readOnly) return;
  nameInput.value = e.name;
  nameDialog.value = { kind: "rename", from: joinPath(path.value, e.name) };
  nextTick(() => { const el = document.getElementById("fx-name") as HTMLInputElement | null; el?.focus(); el?.setSelectionRange(0, e.name.lastIndexOf(".") > 0 ? e.name.lastIndexOf(".") : e.name.length); });
}
function askFolder() {
  if (props.readOnly) return;
  nameInput.value = "";
  nameDialog.value = { kind: "folder" };
}
async function submitName() {
  const d = nameDialog.value;
  const name = nameInput.value.trim();
  if (!d || !name || nameError.value) return;
  const ok = await (d.kind === "rename" ? actions.rename.mutateAsync({ path: d.from!, name }) : actions.mkdir.mutateAsync({ path: joinPath(path.value, name) })).then(() => true, () => false);
  if (ok) nameDialog.value = null;
}

// ---- download ----
const single = computed(() => (chosen.value.length === 1 && (chosen.value[0]!.type === "file" || (chosen.value[0]!.type === "link" && chosen.value[0]!.link?.type === "file")) ? chosen.value[0]! : null));
async function download() {
  if (single.value) return startDownload(fileDownloadUrl(props.server, joinPath(path.value, single.value.name)));
  await zip();
}
async function zip(paths = chosenPaths.value) {
  if (paths.length === 0) return;
  await downloadArchive(props.server, paths).catch((e) => notify.fail("Could not start the download", e));
}

// ---- upload ----
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const dragging = ref(0);
async function upload(c: { files: { file: File; rel: string }[]; dirs: string[] }) {
  if (props.readOnly || c.files.length === 0 && c.dirs.length === 0) return;
  const { items: list, dirs } = toUploads(path.value, c);
  const top = [...new Set(c.files.map((f) => f.rel.split("/")[0]!))];
  const taken = clashes(top, listing.value?.entries ?? []);
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
  if (!e.dataTransfer || props.readOnly) return;
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
  const many = chosen.value.length > 1;
  const e = chosen.value[0];
  const ro = !!props.readOnly;
  return [
    ...(!many && e ? [{ label: opensAsFolder(e) ? "Open" : "Download", icon: opensAsFolder(e) ? "pi pi-folder-open" : "pi pi-download", command: () => open(e) }] : []),
    { label: "Download as zip", icon: "pi pi-box", command: () => void zip() },
    ...(extractable.value ? [{ label: "Extract", icon: "pi pi-file-export", disabled: ro, command: () => void extract() }] : []),
    { separator: true },
    { label: "Copy", icon: "pi pi-copy", disabled: ro, command: () => copy() },
    { label: "Cut", icon: "pi pi-eraser", disabled: ro, command: () => cut() },
    { label: "Paste here", icon: "pi pi-clipboard", disabled: !canPaste.value, command: () => void paste() },
    { separator: true },
    { label: "Rename", icon: "pi pi-pencil", disabled: ro || many, command: () => askRename() },
    { label: "Change owner…", icon: "pi pi-user-edit", disabled: ro, command: () => askOwner() },
    { label: "Copy path", icon: "pi pi-link", command: () => void navigator.clipboard?.writeText(chosenPaths.value.join("\n")) },
    { separator: true },
    { label: "Delete", icon: "pi pi-trash", disabled: ro, command: () => askDelete() },
  ];
});
function onContext(e: { originalEvent: Event; data: FsEntry }) {
  if (!chosen.value.some((s) => s.name === e.data.name)) selection.value = [e.data];
  menu.value?.show(e.originalEvent);
}
function onKey(e: KeyboardEvent) {
  const target = e.target as HTMLInputElement;
  const typing = (target.tagName === "INPUT" && !["checkbox", "radio", "file"].includes(target.type)) || target.tagName === "TEXTAREA" || target.isContentEditable;
  if (typing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "a") { e.preventDefault(); selection.value = [...shown.value]; }
  else if (mod && e.key === "c" && chosen.value.length) { e.preventDefault(); copy(); }
  else if (mod && e.key === "x" && chosen.value.length && !props.readOnly) { e.preventDefault(); cut(); }
  else if (mod && e.key === "v" && canPaste.value) { e.preventDefault(); void paste(); }
  else if (e.key === "Delete" && chosen.value.length) { e.preventDefault(); askDelete(); }
  else if (e.key === "F2" && chosen.value.length === 1) { e.preventDefault(); askRename(); }
  else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); go(parentOf(path.value)); }
  else if (e.key === "Enter" && chosen.value.length === 1) { e.preventDefault(); open(chosen.value[0]!); }
  else if (e.key === "Escape") selection.value = [];
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const errorText = computed(() => (error.value as Error | null)?.message ?? "");
</script>

<template>
  <div
    class="fx flex flex-col gap-3 outline-none"
    tabindex="0"
    @keydown="onKey"
    @dragenter.prevent="dragging++"
    @dragover.prevent
    @dragleave.prevent="dragging = Math.max(0, dragging - 1)"
    @drop.prevent="onDrop"
  >
    <!-- where you are -->
    <div class="flex flex-wrap items-center gap-2">
      <Button icon="pi pi-arrow-up" text rounded size="small" severity="secondary" aria-label="Up one folder" title="Up (Backspace)" :disabled="path === '/'" @click="go(parentOf(path))" />
      <Button icon="pi pi-refresh" text rounded size="small" severity="secondary" aria-label="Refresh" :loading="isFetching" @click="actions.refresh()" />
      <form v-if="editing" class="flex-1 min-w-[12rem]" @submit.prevent="commitEdit">
        <InputText id="fx-path" v-model="typed" class="font-mono w-full" aria-label="Path" autocomplete="off" spellcheck="false" @blur="editing = false" @keydown.esc.stop="editing = false" />
      </form>
      <nav v-else class="crumbs flex-1 min-w-[12rem]" aria-label="Path" @dblclick="startEdit">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 1" class="text-muted-color" aria-hidden="true">/</span>
          <button type="button" class="crumb" :class="{ 'font-semibold': i === crumbs.length - 1 }" @click="c.path === path ? startEdit() : go(c.path)">{{ c.name }}</button>
        </template>
        <button type="button" class="ml-auto text-muted-color hover:text-color" aria-label="Type a path" title="Type a path" @click="startEdit"><i class="pi pi-pencil text-xs" /></button>
      </nav>
    </div>
    <div class="flex flex-wrap gap-1.5" aria-label="Places">
      <button v-for="[p, icon] in places" :key="p" type="button" class="place" :class="{ active: path === p }" @click="go(p)"><i :class="icon" class="text-xs" aria-hidden="true" />{{ p }}</button>
    </div>

    <!-- what you can do -->
    <div class="flex flex-wrap items-center gap-2">
      <template v-if="!readOnly">
        <Button label="Upload" icon="pi pi-upload" size="small" @click="fileInput?.click()" />
        <Button icon="pi pi-folder-plus" label="New folder" size="small" severity="secondary" @click="askFolder" />
        <Button label="Upload a folder" icon="pi pi-sitemap" size="small" severity="secondary" text @click="folderInput?.click()" />
      </template>
      <span class="w-px h-5 bg-[var(--fr-line)] mx-1" aria-hidden="true" />
      <Button :label="single || !chosen.length ? 'Download' : 'Download zip'" :icon="single ? 'pi pi-download' : 'pi pi-box'" size="small" severity="secondary" :disabled="!chosen.length" :title="single ? 'Download' : 'Download as a zip'" @click="download" />
      <template v-if="!readOnly">
        <Button label="Copy" icon="pi pi-copy" size="small" severity="secondary" text :disabled="!chosen.length" @click="copy()" />
        <Button label="Cut" icon="pi pi-eraser" size="small" severity="secondary" text :disabled="!chosen.length" @click="cut()" />
        <Button :label="clipboard && clipboard.server === server ? `Paste ${items(clipboard.paths.length)}` : 'Paste'" icon="pi pi-clipboard" size="small" severity="secondary" text :disabled="!canPaste" :loading="actions.copy.isPending.value || actions.move.isPending.value" @click="paste" />
        <Button v-if="extractable" label="Extract" icon="pi pi-file-export" size="small" severity="secondary" text :loading="actions.extract.isPending.value" @click="extract" />
        <Button label="Owner" icon="pi pi-user-edit" size="small" severity="secondary" text :disabled="!chosen.length" title="Change owner and group" @click="askOwner" />
        <Button label="Rename" icon="pi pi-pencil" size="small" severity="secondary" text :disabled="chosen.length !== 1" @click="askRename()" />
        <Button label="Delete" icon="pi pi-trash" size="small" severity="danger" text :disabled="!chosen.length" :loading="actions.remove.isPending.value" @click="askDelete()" />
      </template>
      <IconField class="ml-auto">
        <InputIcon class="pi pi-search" />
        <InputText v-model="filter" size="small" placeholder="Filter" aria-label="Filter this folder" autocomplete="off" class="w-44" />
      </IconField>
    </div>
    <input ref="fileInput" type="file" multiple class="hidden" tabindex="-1" @change="picked($event, false)" />
    <input ref="folderInput" type="file" webkitdirectory class="hidden" tabindex="-1" @change="picked($event, true)" />

    <Message v-if="errorText && !listing" severity="error" size="small">{{ errorText }}</Message>
    <Message v-else-if="errorText" severity="warn" size="small">{{ errorText }}</Message>
    <Message v-if="listing?.truncated" severity="warn" size="small">This folder has more entries than are shown. Use the filter, or open a deeper folder.</Message>

    <!-- the folder -->
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
        :row-class="(e: FsEntry) => (isCut(e) ? 'cut' : '')"
        @row-dblclick="open($event.data)"
        @row-contextmenu="onContext"
      >
        <template #empty><span class="text-muted-color">{{ filter ? "Nothing here matches." : errorText ? "" : "This folder is empty." }}</span></template>
        <Column selection-mode="multiple" header-style="width: 2.75rem" />
        <Column field="name" header="Name">
          <template #header>
            <button type="button" class="sort" @click.stop="sort('name')">Name<i v-if="sortKey === 'name'" :class="desc ? 'pi pi-arrow-down' : 'pi pi-arrow-up'" class="text-[0.65rem]" aria-hidden="true" /></button>
          </template>
          <template #body="{ data }">
            <span class="inline-flex items-center gap-2 min-w-0">
              <i :class="entryIcon(data)" class="text-muted-color shrink-0" aria-hidden="true" />
              <span class="truncate" :title="data.name">{{ data.name }}</span>
              <span v-if="data.link" class="text-xs text-muted-color truncate" :title="data.link.target">→ {{ data.link.target }}<template v-if="data.link.type === 'missing'"> (missing)</template></span>
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
        <Column header="Owner" style="width: 9rem" class="hidden md:table-cell" header-class="hidden md:table-cell">
          <template #body="{ data }"><span class="text-muted-color text-sm">{{ data.owner ?? data.uid }}:{{ data.group ?? data.gid }}</span></template>
        </Column>
        <Column header="Mode" style="width: 8rem" class="hidden lg:table-cell" header-class="hidden lg:table-cell">
          <template #body="{ data }"><code class="text-xs text-muted-color">{{ formatMode(data.mode) }}</code></template>
        </Column>
      </DataTable>
      <div v-if="dragging && !readOnly" class="drop" aria-hidden="true"><i class="pi pi-upload text-2xl" /><span>Drop to upload to <code>{{ path }}</code></span></div>
    </div>
    <ContextMenu ref="menu" :model="menuItems" />

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-color">
      <span>{{ items(listing?.entries.length ?? 0) }}<template v-if="filter"> · {{ shown.length }} shown</template></span>
      <span v-if="chosen.length">{{ chosen.length }} selected · {{ formatBytes(chosenSize) }}</span>
      <span v-if="readOnly" class="text-amber-600 dark:text-amber-400">Read-only on this server</span>
      <span class="ml-auto hidden md:inline">Ctrl/⌘+C, X, V · Delete · F2 · double-click to open</span>
    </div>

    <!-- uploads -->
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

    <Dialog v-model:visible="showName" modal :header="nameDialog?.kind === 'rename' ? 'Rename' : 'New folder'" :style="{ width: '26rem' }">
      <form class="flex flex-col gap-1" @submit.prevent="submitName">
        <label for="fx-name" class="text-sm font-medium">Name</label>
        <InputText id="fx-name" v-model="nameInput" autocomplete="off" spellcheck="false" :invalid="!!nameError" />
        <small v-if="nameError" class="text-red-500">{{ nameError }}</small>
        <button type="submit" class="hidden" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="nameDialog = null" />
        <Button :label="nameDialog?.kind === 'rename' ? 'Rename' : 'Create'" :disabled="!nameInput.trim() || !!nameError" :loading="actions.rename.isPending.value || actions.mkdir.isPending.value" @click="submitName" />
      </template>
    </Dialog>

    <Dialog v-model:visible="owning" modal header="Change owner" :style="{ width: '28rem' }">
      <form class="flex flex-col gap-3" @submit.prevent="submitOwner">
        <p class="text-sm text-muted-color">{{ chosen.length === 1 ? chosen[0]?.name : items(chosen.length) }}. A name or a number; leave empty to keep it.</p>
        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1">
            <label for="fx-owner" class="text-sm font-medium">Owner</label>
            <SuggestInput id="fx-owner" v-model="ownerInput" :choices="(identities?.users ?? []).map((u) => ({ value: u.name, detail: String(u.id) }))" />
          </div>
          <div class="flex flex-col gap-1">
            <label for="fx-group" class="text-sm font-medium">Group</label>
            <SuggestInput id="fx-group" v-model="groupInput" :choices="(identities?.groups ?? []).map((g) => ({ value: g.name, detail: String(g.id) }))" />
          </div>
        </div>
        <label v-if="hasFolder" class="flex items-center gap-2 text-sm"><Checkbox v-model="recursive" binary input-id="fx-rec" /><span>Apply to everything inside the folders</span></label>
        <button type="submit" class="hidden" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text @click="owning = false" />
        <Button label="Change" :disabled="!ownerChanged.owner && !ownerChanged.group && !(recursive && hasFolder)" :loading="actions.chown.isPending.value" @click="submitOwner" />
      </template>
    </Dialog>

    <Dialog v-model:visible="showProblems" modal :header="problems?.title" :style="{ width: '36rem' }">
      <ul class="flex flex-col gap-1 text-sm max-h-72 overflow-y-auto">
        <li v-for="f in problems?.failed" :key="f.path"><code class="break-all">{{ f.path }}</code><br /><span class="text-muted-color">{{ f.error }}</span></li>
      </ul>
      <template #footer>
        <Button label="Close" severity="secondary" text @click="problems = null" />
        <template v-if="problems?.retry">
          <Button label="Keep both" severity="secondary" @click="resolveClash('rename')" />
          <Button :label="`Replace ${items(problems.retry.paths.length)}`" severity="danger" @click="resolveClash('overwrite')" />
        </template>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 0.1rem 0.25rem; padding: 0.3rem 0.6rem; border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-md); background: var(--fr-panel); min-height: 2.2rem; font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.9rem; }
.crumb { background: none; border: 0; padding: 0.1rem 0.25rem; border-radius: 0.3rem; cursor: pointer; color: inherit; }
.crumb:hover { background: var(--p-content-hover-background, rgb(0 0 0 / 0.06)); }
.place { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid var(--fr-line); background: transparent; font-size: 0.8rem; font-family: var(--font-mono, ui-monospace, monospace); cursor: pointer; color: var(--p-text-muted-color); }
.place:hover, .place.active { color: var(--p-text-color); border-color: var(--p-primary-color); }
.sort { display: inline-flex; align-items: center; gap: 0.3rem; background: none; border: 0; padding: 0; font: inherit; font-weight: 600; color: inherit; cursor: pointer; }
.drop { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; background: color-mix(in srgb, var(--p-primary-color) 12%, var(--fr-panel)); border: 2px dashed var(--p-primary-color); border-radius: var(--p-border-radius-lg); pointer-events: none; }
.uploads { position: sticky; bottom: 0.5rem; align-self: flex-end; width: min(26rem, 100%); padding: 0.7rem 0.9rem; background: var(--fr-panel); border: 1px solid var(--fr-line); border-radius: var(--p-border-radius-lg); box-shadow: 0 8px 24px rgb(0 0 0 / 0.14); z-index: 6; }
:deep(tr.cut) { opacity: 0.5; }
:deep(.p-datatable-tbody > tr) { cursor: default; user-select: none; }
</style>
