<script setup lang="ts">
/**
 * A status lamp: a coloured dot and a plain word. Colour does the alerting, so healthy states stay quiet and
 * only failures colour their text. States in progress pulse.
 */
const props = defineProps<{ state: string | null | undefined; label?: string; /** systemd's finer state: "auto-restart" with `activating` is a crashed service about to be started again. */ sub?: string | null }>();

type Tone = "ok" | "bad" | "warn" | "busy" | "idle";
const STATES: Record<string, [Tone, string]> = {
  // apps
  deployed: ["ok", "Deployed"],
  undeployed: ["idle", "Not deployed"],
  missing: ["bad", "Missing"],
  // systemd units
  active: ["ok", "Running"],
  inactive: ["idle", "Stopped"],
  failed: ["bad", "Failed"],
  activating: ["busy", "Starting"],
  deactivating: ["busy", "Stopping"],
  reloading: ["busy", "Reloading"],
  retrying: ["warn", "Retrying"],
  // deployments
  queued: ["busy", "Queued"],
  running: ["busy", "In progress"],
  success: ["ok", "Succeeded"],
  // servers
  online: ["ok", "Online"],
  offline: ["bad", "Offline"],
  pending: ["busy", "Waiting to enroll"],
  error: ["bad", "Error"],
  // agent upgrades
  verifying: ["busy", "Checking the new version"],
  "rolling-back": ["warn", "Rolling back"],
  "rolled-back": ["warn", "Rolled back"],
  done: ["ok", "Upgraded"],
  // certificates
  expiring: ["warn", "Expiring soon"],
};
const entry = computed(() => STATES[props.state === "activating" && props.sub === "auto-restart" ? "retrying" : (props.state ?? "")] ?? (["idle", props.state ? props.state[0]!.toUpperCase() + props.state.slice(1) : "Unknown"] as [Tone, string]));
</script>

<template>
  <span class="lamp" :data-tone="entry[0]"><span class="dot" aria-hidden="true" />{{ label ?? entry[1] }}</span>
</template>

<style scoped>
.lamp {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  font-size: 0.9rem;
  font-weight: 500;
  white-space: nowrap;
  line-height: 1.3;
}
.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  flex: none;
  background: var(--tone);
}
[data-tone="ok"] { --tone: var(--p-green-500); }
[data-tone="bad"] { --tone: var(--p-red-500); color: var(--p-red-600); }
:global(.app-dark) [data-tone="bad"] { color: var(--p-red-400); }
[data-tone="warn"],
[data-tone="busy"] { --tone: var(--p-amber-500); }
[data-tone="busy"] .dot { animation: pulse 1.4s ease-in-out infinite; }
[data-tone="idle"] { --tone: var(--p-surface-400); color: var(--p-text-muted-color); }
@keyframes pulse { 50% { opacity: 0.35; } }
</style>
