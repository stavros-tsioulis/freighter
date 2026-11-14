<script setup lang="ts">
import type { ServerRow } from "~/types";
import { daysUntil, formatBytes, formatDuration, timeAgo } from "~/utils/format";
import { Activity, Boxes, CalendarDays, Clock3, Copy, Cpu, HardDrive, MemoryStick, Radio, Server, ShieldCheck } from "lucide-vue-next";

/** The server card: identity, the numbers worth glancing at, and the controls for one machine. */
const props = defineProps<{
  server: ServerRow;
  /** The dashboard's commit, so an older agent can be flagged. */
  behind?: boolean;
  /** Where "View details" goes; omitted on the server's own page. */
  to?: string;
  admin?: boolean;
  /** Offer "Restart agent" in the menu (the server's own page). */
  showRestart?: boolean;
  checking?: boolean;
}>();

const emit = defineEmits<{ check: []; upgrade: []; restart: []; reenroll: []; remove: [] }>();

const notify = useNotify();
const menu = ref<{ toggle: (e: Event) => void } | null>(null);

const host = computed(() => props.server.host);
const remote = computed(() => props.server.kind === "remote");
const online = computed(() => props.server.status === "online");
const local = computed(() => props.server.kind === "local");
const memPct = computed(() => (host.value && host.value.memTotal ? Math.round(((host.value.memTotal - host.value.memFree) / host.value.memTotal) * 100) : null));
const memUsed = computed(() => (host.value ? formatBytes(host.value.memTotal - host.value.memFree) : "–"));
const cpus = computed(() => host.value?.cpus ?? null);
const uptimeParts = computed(() => {
  if (!host.value) return [];
  const text = formatDuration(host.value.uptimeSeconds * 1000);
  return text.split(" ").map((token) => {
    const m = token.match(/^([\d.]+)([a-z]+)$/i);
    return m ? { value: m[1]!, unit: m[2]! } : { value: token, unit: "" };
  });
});
const certDays = computed(() => daysUntil(props.server.certExpiresAt));
const certText = computed(() => (certDays.value === null ? "None" : certDays.value < 0 ? "Expired" : `${certDays.value} days remaining`));
const certTone = computed(() => (certDays.value === null || certDays.value < 7 ? "bad" : certDays.value < 30 ? "warn" : "ok"));
const version = computed(() => props.server.agentVersion ?? "–");
const shortVersion = computed(() => (version.value.length > 12 ? version.value.slice(0, 12) : version.value));
const address = computed(() => props.server.address);
const addressText = computed(() => address.value ?? (local.value ? "This machine" : ""));

const actions = computed(() => {
  const items: { label?: string; icon?: string; command?: () => void; disabled?: boolean; style?: string; separator?: boolean }[] = [];
  if (remote.value) items.push({ label: "Re-enroll agent", icon: "pi pi-key", command: () => emit("reenroll") });
  if (props.showRestart && online.value) items.push({ label: "Restart agent", icon: "pi pi-power-off", command: () => emit("restart") });
  if (remote.value) {
    if (items.length) items.push({ separator: true });
    items.push({ label: "Remove server", icon: "pi pi-trash", command: () => emit("remove"), disabled: props.server.appCount > 0, style: "color: var(--p-red-500)" });
  }
  return items;
});

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify.ok("Copied", what);
  } catch (e) {
    notify.fail("Copy failed", e);
  }
}
</script>

<template>
  <article class="server-card" :class="{ 'is-offline': server.status === 'offline' || server.status === 'error' }" :aria-label="`${server.name} server`">
    <div class="server-head">
      <div class="identity">
        <div class="server-icon" aria-hidden="true"><Server :size="25" :stroke-width="1.65" /></div>
        <div class="identity-copy">
          <div class="name-line">
            <h2>
              <NuxtLink v-if="to" :to="to" :aria-label="`${server.name}: details and controls`">{{ server.name }}</NuxtLink>
              <template v-else>{{ server.name }}</template>
            </h2>
            <StatusTag pill :state="server.status" />
          </div>
          <p>
            <template v-if="server.hostname">{{ server.hostname }}</template>
            <span v-if="server.hostname && addressText" class="separator">/</span>
            <span v-if="addressText" class="inline-copy">
              {{ addressText }}
              <button v-if="address" type="button" class="copy-button" :aria-label="`Copy address of ${server.name}`" title="Copy address" @click="copy(address, address)"><Copy :size="13" /></button>
            </span>
          </p>
        </div>
      </div>

      <div class="actions">
        <Button v-if="admin" class="row-button" label="Check now" icon="pi pi-refresh" severity="secondary" outlined size="small" :loading="checking" @click="emit('check')" />
        <Button v-if="to" class="row-button" as="router-link" :to="to" label="View details" icon="pi pi-arrow-up-right" icon-pos="right" size="small" />
        <Button
          v-if="admin && remote && online"
          class="upgrade-button"
          :class="{ flagged: behind }"
          icon="pi pi-arrow-up"
          severity="secondary"
          outlined
          rounded
          size="small"
          :aria-label="`Upgrade agent for ${server.name}`"
          :title="behind ? 'A newer agent is available' : 'Upgrade this server’s agent'"
          @click="emit('upgrade')"
        />
        <Button
          v-if="admin && actions.length"
          icon="pi pi-ellipsis-h"
          severity="secondary"
          outlined
          rounded
          size="small"
          aria-haspopup="true"
          :aria-label="`More actions for ${server.name}`"
          title="More server actions"
          @click="menu?.toggle($event)"
        />
        <Menu ref="menu" :model="actions" popup />
      </div>
    </div>

    <div class="metrics" aria-label="Server statistics">
      <div class="metric">
        <div class="metric-label">Uptime <Clock3 :size="15" /></div>
        <div class="metric-value">
          <template v-if="uptimeParts.length"><template v-for="(part, i) in uptimeParts" :key="i">{{ part.value }}<span v-if="part.unit" class="unit">{{ part.unit }}</span> </template></template>
          <template v-else>–</template>
        </div>
        <p>{{ host ? "Running continuously" : "No readings yet" }}</p>
      </div>
      <div class="metric">
        <div class="metric-label">Load · 1 min <Activity :size="15" /></div>
        <div class="metric-value">{{ host ? host.load1.toFixed(2) : "–" }}</div>
        <p>{{ cpus ? `${cpus} CPU cores available` : "1 minute average" }}</p>
      </div>
      <div class="metric memory">
        <div class="metric-label">Memory used <MemoryStick :size="15" /></div>
        <div class="metric-value">
          <template v-if="host">{{ memUsed }} <span class="unit">/ {{ formatBytes(host.memTotal) }}</span></template>
          <template v-else>–</template>
        </div>
        <div v-if="memPct !== null" class="meter" role="img" :aria-label="`${memPct} percent memory used`"><span :style="{ width: `${memPct}%` }" /></div>
        <p>{{ memPct !== null ? `${memPct}% in use` : "No readings yet" }}</p>
      </div>
      <div class="metric">
        <div class="metric-label">Disk free <HardDrive :size="15" /></div>
        <div class="metric-value">{{ host && host.diskFreeBytes !== null ? formatBytes(host.diskFreeBytes) : "–" }}</div>
        <p>Available storage</p>
      </div>
      <div class="metric">
        <div class="metric-label">Apps <Boxes :size="15" /></div>
        <div class="metric-value">{{ server.appCount }}</div>
        <p>Deployed on this server</p>
      </div>
    </div>

    <div class="server-foot">
      <div class="foot-item">
        <span class="foot-icon"><Radio :size="16" /></span>
        <span><small>Last seen</small><strong :title="server.lastSeenAt ?? ''">{{ timeAgo(server.lastSeenAt) }}</strong></span>
      </div>
      <div class="foot-item">
        <span class="foot-icon"><Cpu :size="16" /></span>
        <span>
          <small>Agent version</small>
          <span class="inline-copy"><strong :title="version">{{ shortVersion }}</strong><button type="button" class="copy-button" aria-label="Copy agent version" title="Copy agent version" @click="copy(version, version)"><Copy :size="13" /></button></span>
        </span>
      </div>
      <div v-if="remote" class="foot-item">
        <span class="foot-icon"><ShieldCheck :size="16" /></span>
        <span><small>Agent certificate</small><strong :class="`tone-${certTone}`">{{ certText }}</strong></span>
      </div>
      <div v-else class="foot-item">
        <span class="foot-icon"><CalendarDays :size="16" /></span>
        <span><small>Added</small><strong>{{ new Date(server.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) }}</strong></span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.server-card {
  background: var(--fr-panel);
  border: 1px solid var(--fr-line);
  border-radius: 0.9rem;
  box-shadow: 0 20px 60px rgb(4 9 14 / 0.08);
  overflow: visible;
}
.server-head {
  min-height: 6.9rem;
  padding: 1.5rem 1.75rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.75rem;
}
.identity {
  display: flex;
  align-items: center;
  gap: 1.05rem;
  min-width: 0;
}
.server-icon {
  width: 3.1rem;
  height: 3.1rem;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--p-primary-color) 16%, var(--fr-panel));
  color: var(--p-primary-color);
}
.is-offline .server-icon {
  background: var(--fr-sunken);
  color: var(--p-text-muted-color);
}
.identity-copy {
  min-width: 0;
}
.name-line {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.name-line h2 {
  font-family: var(--font-display);
  font-size: 1.5rem;
  line-height: 1.2;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0;
}
.name-line h2 a:hover {
  text-decoration: underline;
}
.identity-copy p {
  font-size: 0.82rem;
  color: var(--p-text-muted-color);
  margin: 0.5rem 0 0;
}
.separator {
  padding: 0 0.4rem;
  opacity: 0.6;
}
.inline-copy {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  vertical-align: middle;
}
.copy-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.45rem;
  height: 1.45rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--p-text-muted-color);
  border-radius: 0.3rem;
}
.copy-button:hover,
.copy-button:focus-visible {
  background: var(--fr-sunken);
  color: var(--p-text-color);
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: none;
}
.upgrade-button.flagged {
  position: relative;
  color: var(--p-primary-color);
  border-color: color-mix(in srgb, var(--p-primary-color) 45%, var(--fr-line));
  background: color-mix(in srgb, var(--p-primary-color) 12%, transparent);
}
.upgrade-button.flagged:hover {
  background: color-mix(in srgb, var(--p-primary-color) 20%, transparent);
}
.upgrade-button.flagged::after {
  content: "";
  position: absolute;
  right: 0.28rem;
  top: 0.28rem;
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 50%;
  background: var(--p-primary-color);
  box-shadow: 0 0 0 2px var(--fr-panel);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-top: 1px solid var(--fr-line);
  border-bottom: 1px solid var(--fr-line);
  background: var(--fr-sunken);
}
.metric {
  min-height: 9.6rem;
  padding: 1.4rem 1.5rem;
  position: relative;
}
.metric:not(:last-child)::after {
  content: "";
  position: absolute;
  right: 0;
  top: 1.6rem;
  bottom: 1.6rem;
  width: 1px;
  background: var(--fr-line);
}
.metric-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  color: var(--p-text-muted-color);
  font-size: 0.76rem;
  white-space: nowrap;
}
.metric-label svg {
  opacity: 0.8;
}
.metric-value {
  font-size: clamp(1.5rem, 2.3vw, 1.95rem);
  line-height: 1.2;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  margin-top: 0.85rem;
  white-space: nowrap;
}
.unit {
  font-size: 0.6em;
  color: var(--p-text-muted-color);
  font-weight: 500;
}
.metric p {
  color: var(--p-text-muted-color);
  font-size: 0.72rem;
  margin: 0.55rem 0 0;
}
.meter {
  height: 0.32rem;
  border-radius: 999px;
  background: var(--fr-line);
  overflow: hidden;
  margin: 0.7rem 0 0;
}
.meter span {
  display: block;
  height: 100%;
  background: var(--p-primary-color);
  border-radius: inherit;
  transition: width 0.4s;
}

.server-foot {
  min-height: 4.7rem;
  padding: 1rem 1.75rem;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1.1rem clamp(1.5rem, 5vw, 4rem);
}
.foot-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
}
.foot-icon {
  color: var(--p-text-muted-color);
  display: inline-flex;
}
.foot-item small,
.foot-item strong {
  display: block;
  white-space: nowrap;
}
.foot-item small {
  font-size: 0.7rem;
  color: var(--p-text-muted-color);
  margin-bottom: 0.15rem;
}
.foot-item strong {
  font-size: 0.8rem;
  color: var(--p-text-color);
  font-weight: 600;
}
.tone-bad {
  color: var(--p-red-500);
}
.tone-warn {
  color: var(--p-amber-500);
}

@media (max-width: 1150px) {
  .metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .metric:nth-child(3)::after {
    display: none;
  }
  .metric:nth-child(n + 4) {
    border-top: 1px solid var(--fr-line);
  }
  .metric {
    min-height: 8.5rem;
  }
}
@media (max-width: 750px) {
  .server-head {
    align-items: stretch;
    flex-direction: column;
    padding: 1.35rem;
    gap: 1.1rem;
  }
  .actions {
    width: 100%;
    flex-wrap: wrap;
  }
  .actions .row-button {
    flex: 1;
  }
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .metric:nth-child(3)::after {
    display: block;
  }
  .metric:nth-child(2n)::after {
    display: none;
  }
  .metric:nth-child(3) {
    border-top: 1px solid var(--fr-line);
  }
  .metric {
    min-height: 7.6rem;
    padding: 1.1rem 1.2rem;
  }
  .server-foot {
    padding: 1.1rem 1.35rem;
  }
}
@media (max-width: 480px) {
  .identity {
    gap: 0.75rem;
  }
  .server-icon {
    width: 2.7rem;
    height: 2.7rem;
  }
  .name-line {
    gap: 0.5rem;
  }
  .name-line h2 {
    font-size: 1.3rem;
  }
  .metric {
    padding: 0.95rem 0.9rem;
  }
  .metric-label {
    font-size: 0.7rem;
  }
  .metric-label svg {
    display: none;
  }
  .metric-value {
    font-size: 1.4rem;
  }
  .metric p {
    font-size: 0.65rem;
  }
  .server-foot {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .foot-item strong {
    white-space: normal;
  }
  .foot-item:last-child {
    grid-column: 1 / -1;
  }
}
</style>
