import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { FsBulk, FsListing, HostSample, ProcessList } from "~/types";
import { api } from "./api";
import { joinPath } from "~/utils/files";

const base = (server: string) => `/servers/${server}/fs`;

/** A folder on a server. The previous listing stays on screen while the next one loads. */
export const useFsList = (server: MaybeRef<string>, path: MaybeRef<string>, enabled: MaybeRef<boolean> = true) =>
  useQuery({
    queryKey: ["fs", server, path],
    enabled: computed(() => toValue(enabled)),
    queryFn: () => api<FsListing>(base(toValue(server)), { query: { path: toValue(path) } }),
    placeholderData: (prev) => prev,
    retry: false,
    staleTime: 0,
  });

/** The server's users and groups, to suggest as owners. */
export const useFsIdentities = (server: MaybeRef<string>, enabled: MaybeRef<boolean> = true) =>
  useQuery({
    queryKey: ["fs-identities", server],
    enabled: computed(() => toValue(enabled)),
    queryFn: () => api<{ users: { name: string; id: number }[]; groups: { name: string; id: number }[] }>(`${base(toValue(server))}/identities`),
    staleTime: 60_000,
    retry: false,
  });

/** Every process on a server. Read again every few seconds while `live`. */
export const useProcesses = (server: MaybeRef<string>, live: MaybeRef<boolean>, enabled: MaybeRef<boolean> = true) =>
  useQuery({
    queryKey: ["processes", server],
    enabled: computed(() => toValue(enabled)),
    queryFn: () => api<ProcessList>(`/servers/${toValue(server)}/processes`),
    refetchInterval: () => (toValue(live) ? 3000 : false),
    placeholderData: (prev) => prev,
    retry: false,
  });

export function useSignalProcess(server: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  return useMutation({
    mutationFn: (v: { pid: number; starttime: number; signal: "TERM" | "KILL" | "HUP" | "INT" | "STOP" | "CONT"; name?: string }) =>
      api(`/servers/${toValue(server)}/processes/signal`, { method: "POST", body: v }),
    onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ["processes", toValue(server)] }), 600),
    onError: (e) => notify.fail("Could not signal the process", e),
  });
}

export const useHostMetrics = (server: MaybeRef<string>, minutes: MaybeRef<number>, enabled: MaybeRef<boolean> = true) =>
  useQuery({
    queryKey: ["host-metrics", server, minutes],
    enabled: computed(() => toValue(enabled)),
    queryFn: () => api<{ points: HostSample[] }>(`/servers/${toValue(server)}/metrics`, { query: { minutes: toValue(minutes) } }).then((r) => r.points),
    refetchInterval: 15_000,
    retry: false,
  });

/** What a storage holds: `/` lists its buckets, `/bucket/folder` the keys inside. */
export interface StorageEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtimeMs: number;
}
export interface StorageListing {
  path: string;
  parent: string | null;
  entries: StorageEntry[];
  truncated: boolean;
}
const storageBase = (name: string) => `/storages/${name}/files`;
export const storageFilesRoot = storageBase;
export const useStorageList = (name: MaybeRef<string>, path: MaybeRef<string>, enabled: MaybeRef<boolean> = true) =>
  useQuery({
    queryKey: ["storage-files", name, path],
    enabled: computed(() => toValue(enabled)),
    queryFn: () => api<StorageListing>(storageBase(toValue(name)), { query: { path: toValue(path) } }),
    placeholderData: (prev) => prev,
    retry: false,
    staleTime: 0,
  });
export const storageDownloadUrl = (name: string, path: string) => `/api/v1${storageBase(name)}/download?path=${encodeURIComponent(path)}`;
export function useStorageActions(name: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  const n = () => toValue(name);
  const refresh = () => qc.invalidateQueries({ queryKey: ["storage-files", n()] });
  const mutation = <V, R>(fn: (v: V) => Promise<R>, failed: string) => useMutation({ mutationFn: fn, onSettled: refresh, onError: (e) => notify.fail(failed, e) });
  return {
    mkdir: mutation((v: { path: string }) => api(`${storageBase(n())}/mkdir`, { method: "POST", body: v }), "Could not create it"),
    rename: mutation((v: { path: string; newName: string }) => api<{ path: string }>(`${storageBase(n())}/rename`, { method: "POST", body: v }), "Could not rename"),
    remove: mutation((v: { paths: string[] }) => api<FsBulk>(`${storageBase(n())}/delete`, { method: "POST", body: v }), "Could not delete"),
    refresh,
  };
}

/** The things you can do to files. Each one refreshes the listings afterwards, whatever happened. */
export function useFsActions(server: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  const s = () => toValue(server);
  const refresh = () => qc.invalidateQueries({ queryKey: ["fs", s()] });
  const mutation = <V, R>(fn: (v: V) => Promise<R>, failed: string) => useMutation({ mutationFn: fn, onSettled: refresh, onError: (e) => notify.fail(failed, e) });
  return {
    mkdir: mutation((v: { path: string }) => api(`${base(s())}/mkdir`, { method: "POST", body: v }), "Could not create the folder"),
    rename: mutation((v: { path: string; name: string }) => api<{ path: string }>(`${base(s())}/rename`, { method: "POST", body: v }), "Could not rename"),
    copy: mutation((v: { paths: string[]; to: string; onConflict?: "fail" | "overwrite" | "rename" }) => api<FsBulk>(`${base(s())}/copy`, { method: "POST", body: v }), "Could not copy"),
    move: mutation((v: { paths: string[]; to: string; onConflict?: "fail" | "overwrite" | "rename" }) => api<FsBulk>(`${base(s())}/move`, { method: "POST", body: v }), "Could not move"),
    extract: mutation((v: { paths: string[]; to?: string; onConflict?: "fail" | "overwrite" | "rename" }) => api<FsBulk>(`${base(s())}/extract`, { method: "POST", body: v }), "Could not extract"),
    chown: mutation((v: { paths: string[]; owner?: string; group?: string; recursive?: boolean }) => api<FsBulk>(`${base(s())}/chown`, { method: "POST", body: v }), "Could not change the owner"),
    remove: mutation((v: { paths: string[] }) => api<FsBulk>(`${base(s())}/delete`, { method: "POST", body: v }), "Could not delete"),
    refresh,
  };
}

/** Make the browser download `url` (it is the server that names the file). */
export function startDownload(url: string, name?: string) {
  const a = document.createElement("a");
  a.href = url;
  if (name) a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The API path of a server's files (for `useUploader`). */
export const serverFilesRoot = (server: string) => base(server);

export const fileDownloadUrl = (server: string, path: string) => `/api/v1${base(server)}/download?path=${encodeURIComponent(path)}`;

/** A zip of several paths: they are registered first, and the link that comes back holds a ticket. */
export async function downloadArchive(server: string, paths: string[]) {
  const { ticket, name } = await api<{ ticket: string; name: string }>(`${base(server)}/archive`, { method: "POST", body: { paths } });
  startDownload(`/api/v1${base(server)}/archive/${ticket}`, name);
}

export interface UploadJob {
  id: number;
  name: string;
  path: string;
  size: number;
  loaded: number;
  state: "queued" | "uploading" | "done" | "error" | "canceled";
  error?: string;
}
export interface UploadItem {
  file: File;
  /** Where it goes, absolute. */
  path: string;
}

/** Upload files one request each, three at a time, with progress. `root` is the API path that has `upload` and `mkdir` under it. Folders to create first go in `dirs`. */
export function useUploader(root: MaybeRef<string>, onDone: () => void) {
  const jobs = ref<UploadJob[]>([]);
  const requests = new Map<number, XMLHttpRequest>();
  let next = 1;
  let running = 0;
  const waiting: { job: UploadJob; item: UploadItem; overwrite: boolean }[] = [];

  function pump() {
    while (running < 3 && waiting.length > 0) {
      const { job, item, overwrite } = waiting.shift()!;
      if (job.state === "canceled") continue;
      running++;
      job.state = "uploading";
      const xhr = new XMLHttpRequest();
      requests.set(job.id, xhr);
      xhr.open("PUT", `/api/v1${toValue(root)}/upload?path=${encodeURIComponent(item.path)}&overwrite=${overwrite ? 1 : 0}`);
      xhr.setRequestHeader("x-requested-with", "freighter");
      xhr.upload.onprogress = (e) => void (job.loaded = e.loaded);
      const finish = (state: UploadJob["state"], error?: string) => {
        requests.delete(job.id);
        running--;
        if (job.state !== "canceled") {
          job.state = state;
          job.error = error;
        }
        if (state === "done") job.loaded = job.size;
        pump();
        if (running === 0 && waiting.length === 0) onDone();
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return finish("done");
        let message = `${xhr.status}`;
        try {
          message = (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          /* keep the status */
        }
        finish("error", message);
      };
      xhr.onerror = () => finish("error", "the connection was lost");
      xhr.onabort = () => finish("canceled");
      xhr.send(item.file);
    }
  }

  return {
    jobs,
    /** `dirs` are made first (an existing one is fine). */
    async add(items: UploadItem[], opts: { overwrite: boolean; dirs?: string[] }) {
      for (const dir of opts.dirs ?? []) {
        await api(`${toValue(root)}/mkdir`, { method: "POST", body: { path: dir } }).catch(() => undefined);
      }
      for (const item of items) {
        const job: UploadJob = reactive({ id: next++, name: item.path, path: item.path, size: item.file.size, loaded: 0, state: "queued" });
        jobs.value.push(job);
        waiting.push({ job, item, overwrite: opts.overwrite });
      }
      pump();
    },
    cancel(id: number) {
      const job = jobs.value.find((j) => j.id === id);
      if (!job) return;
      if (job.state === "uploading") requests.get(id)?.abort();
      else if (job.state === "queued") job.state = "canceled";
    },
    clearFinished() {
      jobs.value = jobs.value.filter((j) => j.state === "queued" || j.state === "uploading");
    },
  };
}

/** What a drop or a folder picker gave us: the files with their place under the target folder, and the folders to make. */
export interface Collected {
  files: { file: File; rel: string }[];
  dirs: string[];
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const more = () => reader.readEntries((batch) => (batch.length === 0 ? resolve(all) : (all.push(...batch), more())), reject);
    more();
  });
}

export async function collectDropped(dt: DataTransfer): Promise<Collected> {
  const out: Collected = { files: [], dirs: [] };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (entries.length === 0) {
    out.files = [...dt.files].map((file) => ({ file, rel: file.name }));
    return out;
  }
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const rel = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.files.push({ file, rel });
    } else if (entry.isDirectory) {
      out.dirs.push(rel);
      for (const child of await readEntries((entry as FileSystemDirectoryEntry).createReader())) await walk(child, `${rel}/`);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

/** The chosen files of a folder picker (`webkitdirectory`), with their folders. */
export function collectPicked(files: FileList): Collected {
  const out: Collected = { files: [], dirs: [] };
  const dirs = new Set<string>();
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    out.files.push({ file, rel });
    const parts = rel.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  out.dirs = [...dirs].sort((a, b) => a.length - b.length);
  return out;
}

/** Collected files as upload items under `dir`, and the absolute folders to make. */
export function toUploads(dir: string, c: Collected): { items: UploadItem[]; dirs: string[] } {
  return { items: c.files.map((f) => ({ file: f.file, path: joinPath(dir, f.rel) })), dirs: c.dirs.map((d) => joinPath(dir, d)) };
}
