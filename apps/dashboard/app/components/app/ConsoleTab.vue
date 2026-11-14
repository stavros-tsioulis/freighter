<script setup lang="ts">
import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { AppRow } from "~/types";
import { consoleUrl, dataMessage, exitText, parseServerMessage, pingMessage, resizeMessage, type ConsoleInfo } from "~/utils/console";

/** An interactive shell in a service: in its directory as its user, or inside its container. Without `service`, the service is chosen here. */
const props = defineProps<{ app: AppRow; service?: string }>();
const serviceNames = computed(() => (props.app.services ?? []).map((s) => s.name));
const picked = ref("");
const current = computed(() => props.service ?? (serviceNames.value.includes(picked.value) ? picked.value : (serviceNames.value[0] ?? "")));
const isContainer = computed(() => !!props.app.imageDetails?.[current.value]);

const status = ref<"idle" | "connecting" | "open" | "closed">("idle");
const info = ref<ConsoleInfo | null>(null);
const why = ref("");
const host = ref<HTMLElement | null>(null);

let term: Terminal | undefined;
let fit: FitAddon | undefined;
let socket: WebSocket | undefined;
let observer: ResizeObserver | undefined;
let pinger: ReturnType<typeof setInterval> | undefined;
const encoder = new TextEncoder();

function teardown() {
  clearInterval(pinger);
  observer?.disconnect();
  if (socket) {
    socket.onclose = null;
    socket.onmessage = null;
    socket.close();
  }
  term?.dispose();
  socket = term = fit = observer = undefined;
}

async function connect() {
  teardown();
  info.value = null;
  why.value = "";
  status.value = "connecting";
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  await nextTick();
  if (!host.value) return;
  const t = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: { background: "#0f161d", foreground: "#e3e8ed", cursor: "#95a3f0", selectionBackground: "#39434d" },
  });
  const f = new FitAddon();
  t.loadAddon(f);
  t.open(host.value);
  f.fit();
  term = t;
  fit = f;

  const ws = new WebSocket(consoleUrl(window.location, props.app.name, current.value, { cols: t.cols, rows: t.rows }));
  ws.binaryType = "arraybuffer";
  socket = ws;
  ws.onmessage = (ev) => {
    const m = parseServerMessage(new Uint8Array(ev.data as ArrayBuffer));
    if (m.type === "data") t.write(m.bytes);
    else if (m.type === "ready") {
      info.value = m.info;
      status.value = "open";
      t.focus();
    } else if (m.type === "exit") {
      why.value = exitText(m.code);
    } else if (m.type === "error") {
      why.value = m.message;
    }
  };
  ws.onclose = () => {
    clearInterval(pinger);
    status.value = "closed";
    t.options.cursorBlink = false;
    if (!why.value) why.value = "The connection closed.";
  };
  ws.onopen = () => {
    pinger = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(pingMessage()), 15_000);
  };
  t.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(dataMessage(encoder.encode(d))));
  t.onResize(({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(resizeMessage(cols, rows)));
  observer = new ResizeObserver(() => fit?.fit());
  observer.observe(host.value);
}

function disconnect() {
  teardown();
  status.value = "idle";
  info.value = null;
}

// another service is another shell
watch(current, () => {
  if (status.value !== "idle") disconnect();
});
onBeforeUnmount(teardown);

// where a host shell starts; a container has no directory worth naming
const where = computed(() => (info.value?.kind === "host" ? `${info.value.user} in ${info.value.cwd}` : ""));
</script>

<template>
  <div class="flex flex-col gap-4">
    <div v-if="!service && serviceNames.length > 1">
      <SelectButton :model-value="current" :options="serviceNames" :allow-empty="false" size="small" aria-label="Service" @update:model-value="(v: string | null) => v && (picked = v)" />
    </div>
    <p v-if="!current" class="text-sm text-muted-color">No services yet</p>
    <template v-else>
      <div class="flex flex-wrap items-center gap-3">
        <template v-if="status === 'idle'">
          <Button label="Open console" icon="pi pi-desktop" size="small" @click="connect" />
          <span class="text-sm text-muted-color">{{ isContainer ? "A shell inside the container of " : "A shell as the user of " }}<b>{{ current }}</b>, with its environment and secrets. Every session is in the audit log.</span>
        </template>
        <template v-else>
          <StatusTag :state="status === 'open' ? 'active' : status === 'connecting' ? 'activating' : 'inactive'" :label="status === 'open' ? 'Connected' : status === 'connecting' ? 'Connecting' : 'Closed'" />
          <span v-if="where" class="text-sm font-mono text-muted-color truncate">{{ where }}</span>
          <div class="ml-auto flex gap-2">
            <Button v-if="status === 'closed'" label="Reconnect" icon="pi pi-refresh" size="small" @click="connect" />
            <Button label="Disconnect" icon="pi pi-times" size="small" severity="secondary" outlined @click="disconnect" />
          </div>
        </template>
      </div>
      <Message v-if="why && status === 'closed'" severity="info" size="small" :closable="false">{{ why }}</Message>
      <div v-show="status !== 'idle'" class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[#0f161d] p-2 h-[26rem] overflow-hidden" role="region" aria-label="Console">
        <div ref="host" class="h-full w-full" />
      </div>
    </template>
  </div>
</template>
