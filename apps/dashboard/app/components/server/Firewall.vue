<script setup lang="ts">
import type { FirewallPolicy, FirewallRule, HostStatus } from "~/types";
import { isLockout, useFirewall, useFirewallActions, type RuleForm } from "~/composables/firewall";
import { PRESETS, describeTo, hasV6Twin, ruleProblem, ruleSignature, v4Twin } from "~/utils/firewall";

/** The server's firewall: whether it is on, what it does with traffic nobody wrote a rule for, and the rules. */
const props = defineProps<{ server: string; host: HostStatus | null; online: boolean }>();
const emit = defineEmits<{ install: [] }>();
const confirm = useConfirm();
const notify = useNotify();

const available = computed(() => props.online && !!props.host?.firewall?.enabled);
const { data: fw, error, isFetching } = useFirewall(computed(() => props.server), computed(() => available.value && !!props.host?.firewall?.installed));
const actions = useFirewallActions(computed(() => props.server));
const readOnly = computed(() => !!props.host?.firewall?.readOnly);
const errorText = computed(() => (error.value as Error | null)?.message ?? "");

const showCopies = ref(false);
const rules = computed(() => {
  const all = fw.value?.rules ?? [];
  return showCopies.value ? all : all.filter((r) => !v4Twin(r, all));
});
const copies = computed(() => (fw.value?.rules ?? []).filter((r) => v4Twin(r, fw.value!.rules)).length);

/** Run a change; one that would cut off a way in is explained and sent again only when confirmed. */
async function guarded<T>(run: (acknowledged: boolean) => Promise<T>, doing: string): Promise<boolean> {
  try {
    await run(false);
    return true;
  } catch (e) {
    if (!isLockout(e)) return false;
    return new Promise((resolve) => {
      confirm.require({
        header: "This could lock you out",
        message: e.message.replace(/\s*Confirm to do it anyway\.$/, ""),
        icon: "pi pi-exclamation-triangle",
        acceptLabel: doing,
        acceptProps: { severity: "danger" },
        rejectProps: { severity: "secondary", text: true, label: "Cancel" },
        accept: async () => resolve(await run(true).then(() => true, () => false)),
        reject: () => resolve(false),
      });
    });
  }
}

// ---- on and off ----
const enabling = ref(false);
const extra = ref("");
const extraPorts = computed(() => extra.value.split(/[\s,]+/).filter(Boolean));
const extraBad = computed(() => extraPorts.value.some((p) => !/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535));
function askEnable() {
  extra.value = "";
  enabling.value = true;
}
async function enable() {
  const ok = await actions.enable.mutateAsync({ open: extraPorts.value.map(Number) }).then(() => true, () => false);
  if (ok) {
    enabling.value = false;
    notify.ok("Firewall is on");
  }
}
function askDisable() {
  confirm.require({
    header: "Turn the firewall off?",
    message: "Every port that a service listens on is reachable again. Your rules are kept and apply when you turn it back on.",
    icon: "pi pi-exclamation-triangle",
    acceptLabel: "Turn off",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => void actions.disable.mutateAsync(undefined as never).then(() => notify.ok("Firewall is off")).catch(() => undefined),
  });
}

// ---- defaults ----
const POLICIES: { label: string; value: FirewallPolicy }[] = [{ label: "Deny", value: "deny" }, { label: "Reject", value: "reject" }, { label: "Allow", value: "allow" }];
const changeDefault = (direction: "incoming" | "outgoing", policy: FirewallPolicy) =>
  void guarded((acknowledged) => actions.setDefault.mutateAsync({ direction, policy, acknowledged }), "Change it anyway");

// ---- adding a rule ----
const adding = ref(false);
const blank = (): RuleForm => ({ action: "allow", direction: "in", proto: "tcp", port: "", from: "", to: "", comment: "" });
const form = ref<RuleForm>(blank());
const advanced = ref(false);
const problem = computed(() => ruleProblem(form.value));
const ACTIONS = [
  { label: "Allow", value: "allow" },
  { label: "Deny", value: "deny" },
  { label: "Reject", value: "reject" },
  { label: "Limit", value: "limit" },
] as const;
const ACTION_HELP: Record<string, string> = {
  allow: "Let the traffic in.",
  deny: "Drop it silently; the sender gets no answer.",
  reject: "Refuse it, and tell the sender.",
  limit: "Allow it, but refuse an address that connects too often (six times in 30 seconds): for SSH.",
};
function askAdd(preset?: (typeof PRESETS)[number]) {
  form.value = { ...blank(), ...(preset ? { port: preset.port, proto: preset.proto, comment: preset.label } : {}) };
  advanced.value = false;
  adding.value = true;
}
function usePreset(p: (typeof PRESETS)[number]) {
  form.value = { ...form.value, port: p.port, proto: p.proto, comment: form.value.comment || p.label };
}
async function submitAdd() {
  if (problem.value) return;
  const ok = await guarded((acknowledged) => actions.add.mutateAsync({ ...form.value, acknowledged }), "Add it anyway");
  if (ok) {
    adding.value = false;
    notify.ok("Rule added");
  }
}

// ---- removing ----
function askRemove(r: FirewallRule) {
  const both = hasV6Twin(r, fw.value?.rules ?? []);
  confirm.require({
    header: "Remove this rule?",
    message: `${r.action.toUpperCase()} ${describeTo(r.to)} from ${r.from}${both ? ". Its IPv6 copy goes with it" : ""}.`,
    icon: "pi pi-trash",
    acceptLabel: "Remove",
    acceptProps: { severity: "danger" },
    rejectProps: { severity: "secondary", text: true, label: "Cancel" },
    accept: () => void guarded((acknowledged) => actions.remove.mutateAsync({ number: r.number, signature: ruleSignature(r), twin: both, acknowledged }), "Remove it anyway"),
  });
}
const tone = (a: FirewallRule["action"]) => ({ allow: "success", deny: "danger", reject: "danger", limit: "warn" })[a] as "success" | "danger" | "warn";
</script>

<template>
  <div class="flex flex-col gap-5">
    <Message v-if="!online" severity="warn" size="small" :closable="false">The server isn't reachable right now, so its firewall can't be read.</Message>
    <Message v-else-if="host && !host.firewall" severity="info" size="small" :closable="false">This agent predates the firewall. Upgrade it first.</Message>
    <Message v-else-if="host?.firewall && !host.firewall.enabled" severity="info" size="small" :closable="false">The firewall tab is turned off on this server (<code>agent.firewall.enabled</code> in its config.yaml).</Message>

    <div v-else-if="host?.firewall && !host.firewall.installed" class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] px-5 py-4 flex flex-col gap-3">
      <h3 class="font-medium">The firewall (ufw) isn't installed</h3>
      <p class="text-sm text-muted-color">Installing it leaves it off. You turn it on from here, and that first allows SSH, the web ports and the agent, so you can't lock yourself out.</p>
      <Button label="Add the firewall…" icon="pi pi-shield" size="small" class="self-start" @click="emit('install')" />
    </div>

    <template v-else-if="available">
      <Message v-if="errorText && !fw" severity="error" size="small">{{ errorText }}</Message>
      <Skeleton v-else-if="!fw" height="8rem" />
      <template v-else>
        <!-- is it on, and what happens to traffic nobody wrote a rule for -->
        <section class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] bg-[var(--fr-panel)] px-5 py-4 flex flex-col gap-4" aria-label="Firewall state">
          <div class="flex flex-wrap items-center gap-3">
            <StatusTag :state="fw.active ? 'active' : 'inactive'" :label="fw.active ? 'On' : 'Off'" />
            <span class="text-sm text-muted-color">{{ fw.active ? "Incoming traffic is checked against the rules below." : "Nothing is blocked. Turn it on to start enforcing rules." }}</span>
            <div class="ml-auto flex gap-2">
              <Button v-if="!fw.active" label="Turn on…" icon="pi pi-shield" size="small" :disabled="readOnly" :loading="actions.enable.isPending.value" @click="askEnable" />
              <Button v-else label="Turn off" icon="pi pi-power-off" size="small" severity="secondary" outlined :disabled="readOnly" :loading="actions.disable.isPending.value" @click="askDisable" />
            </div>
          </div>
          <div v-if="fw.defaults" class="grid sm:grid-cols-2 gap-4">
            <div class="flex flex-col gap-1">
              <label for="fw-in" class="text-sm font-medium">Incoming traffic with no rule</label>
              <SelectButton input-id="fw-in" :model-value="fw.defaults.incoming" :options="POLICIES" option-label="label" option-value="value" :allow-empty="false" size="small" :disabled="readOnly" aria-label="Default for incoming traffic" @update:model-value="(v: FirewallPolicy) => v !== fw!.defaults!.incoming && changeDefault('incoming', v)" />
              <small class="text-muted-color">Deny is the safe choice: only what a rule allows gets in.</small>
            </div>
            <div class="flex flex-col gap-1">
              <label for="fw-out" class="text-sm font-medium">Outgoing traffic with no rule</label>
              <SelectButton input-id="fw-out" :model-value="fw.defaults.outgoing" :options="POLICIES" option-label="label" option-value="value" :allow-empty="false" size="small" :disabled="readOnly" aria-label="Default for outgoing traffic" @update:model-value="(v: FirewallPolicy) => v !== fw!.defaults!.outgoing && changeDefault('outgoing', v)" />
              <small class="text-muted-color">Leave it on Allow unless you know what this server needs to reach.</small>
            </div>
          </div>
        </section>

        <!-- the rules -->
        <section class="flex flex-col gap-3" aria-labelledby="fw-rules">
          <div class="flex flex-wrap items-center gap-2">
            <h3 id="fw-rules" class="font-display font-semibold text-[1.35rem] leading-tight">Rules</h3>
            <span class="text-sm text-muted-color">{{ rules.length }}</span>
            <label v-if="copies" class="ml-auto flex items-center gap-2 text-sm"><ToggleSwitch v-model="showCopies" input-id="fw-v6" /><span>Show IPv6 copies ({{ copies }})</span></label>
            <Button label="Add rule" icon="pi pi-plus" size="small" :class="{ 'ml-auto': !copies }" :disabled="readOnly || !fw.active" :title="fw.active ? '' : 'Turn the firewall on first'" @click="askAdd()" />
          </div>
          <Message v-if="!fw.active" severity="info" size="small" :closable="false">Rules are managed while the firewall is on. Turning it on first allows <b v-for="(e, i) in fw.essential" :key="e.port">{{ i ? ", " : "" }}{{ e.what.split(" (")[0] }} ({{ e.port }})</b>.</Message>
          <DataTable v-else :value="rules" data-key="number" size="small" :loading="isFetching && !rules.length">
            <template #empty><span class="text-muted-color">No rules. With incoming traffic denied, nothing can reach this server.</span></template>
            <Column header="Action" style="width: 7rem"><template #body="{ data: r }"><Tag :value="r.action.toUpperCase()" :severity="tone(r.action)" class="!text-[0.7rem]" /></template></Column>
            <Column header="What">
              <template #body="{ data: r }">
                <span class="font-mono text-sm">{{ r.to }}</span>
                <span class="text-sm text-muted-color ml-2">{{ describeTo(r.to) }}</span>
                <Tag v-if="r.direction !== 'in'" :value="r.direction.toUpperCase()" severity="secondary" class="ml-2 !text-[0.65rem]" />
                <Tag v-if="r.v6" value="IPv6" severity="secondary" class="ml-2 !text-[0.65rem]" />
              </template>
            </Column>
            <Column header="From"><template #body="{ data: r }"><span class="font-mono text-sm">{{ r.from.replace(/ \(v6\)$/, "") }}</span></template></Column>
            <Column header="Comment" class="hidden md:table-cell" header-class="hidden md:table-cell"><template #body="{ data: r }"><span class="text-sm text-muted-color">{{ r.comment }}</span></template></Column>
            <Column header="" style="width: 3rem" body-class="text-right">
              <template #body="{ data: r }"><Button icon="pi pi-trash" text rounded size="small" severity="danger" :disabled="readOnly" :aria-label="`Remove rule ${r.number}`" @click="askRemove(r)" /></template>
            </Column>
          </DataTable>
          <p v-if="readOnly" class="text-sm text-amber-600 dark:text-amber-400">Read-only on this server (<code>agent.firewall.readOnly</code>).</p>
        </section>
      </template>
    </template>

    <Dialog v-model:visible="enabling" modal header="Turn the firewall on" :style="{ width: '32rem' }" :closable="!actions.enable.isPending.value">
      <div class="flex flex-col gap-3 text-sm">
        <p>Incoming traffic that no rule allows will be dropped. These stay open so you and Freighter can still reach the server:</p>
        <ul class="rounded-[var(--p-border-radius-lg)] border border-[var(--fr-line)] divide-y divide-[var(--fr-line)]">
          <li v-for="e in fw?.essential" :key="e.port" class="flex items-baseline gap-3 px-3 py-1.5"><code class="w-14">{{ e.port }}/tcp</code><span class="text-muted-color">{{ e.what }}</span></li>
        </ul>
        <div class="flex flex-col gap-1">
          <label for="fw-extra" class="font-medium">Also open (optional)</label>
          <InputText id="fw-extra" v-model="extra" placeholder="5432, 8080" autocomplete="off" class="font-mono" :invalid="extraBad" />
          <small v-if="extraBad" class="text-red-500">Ports are numbers from 1 to 65535, separated by commas.</small>
          <small v-else class="text-muted-color">Ports other services on this server listen on to the outside.</small>
        </div>
        <Message severity="warn" size="small" :closable="false">If SSH runs on a port that isn't in this list, or something else is how you reach this machine, open it here first.</Message>
      </div>
      <template #footer>
        <Button label="Cancel" severity="secondary" text :disabled="actions.enable.isPending.value" @click="enabling = false" />
        <Button label="Turn on" icon="pi pi-shield" :disabled="extraBad" :loading="actions.enable.isPending.value" @click="enable" />
      </template>
    </Dialog>

    <Dialog v-model:visible="adding" modal header="Add a rule" :style="{ width: '34rem' }" :closable="!actions.add.isPending.value">
      <form class="flex flex-col gap-4" autocomplete="off" @submit.prevent="submitAdd">
        <div class="flex flex-wrap gap-1.5" aria-label="Common services">
          <Button v-for="p in PRESETS" :key="p.label" :label="`${p.label} ${p.port}`" size="small" severity="secondary" outlined type="button" @click="usePreset(p)" />
        </div>
        <div class="flex flex-col gap-1">
          <span id="fw-action" class="text-sm font-medium">Action</span>
          <SelectButton v-model="form.action" :options="[...ACTIONS]" option-label="label" option-value="value" :allow-empty="false" size="small" aria-labelledby="fw-action" />
          <small class="text-muted-color">{{ ACTION_HELP[form.action] }}</small>
        </div>
        <div class="grid grid-cols-[1fr_8rem] gap-3">
          <div class="flex flex-col gap-1">
            <label for="fw-port" class="text-sm font-medium">Port</label>
            <InputText id="fw-port" v-model="form.port" placeholder="empty: every port. 80, 8000:8100, 80,443" class="font-mono" autocomplete="off" />
          </div>
          <div class="flex flex-col gap-1">
            <label for="fw-proto" class="text-sm font-medium">Protocol</label>
            <Select input-id="fw-proto" v-model="form.proto" :options="[{ label: 'TCP', value: 'tcp' }, { label: 'UDP', value: 'udp' }, { label: 'Any', value: 'any' }]" option-label="label" option-value="value" fluid />
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <label for="fw-from" class="text-sm font-medium">From</label>
          <InputText id="fw-from" v-model="form.from" placeholder="empty: anywhere. 203.0.113.7 or 10.0.0.0/8" class="font-mono" autocomplete="off" />
        </div>
        <div class="flex flex-col gap-1">
          <label for="fw-comment" class="text-sm font-medium">Comment</label>
          <InputText id="fw-comment" v-model="form.comment" placeholder="what it is for" maxlength="80" autocomplete="off" />
        </div>
        <button type="button" class="self-start text-sm text-muted-color hover:text-color" @click="advanced = !advanced"><i :class="advanced ? 'pi pi-chevron-down' : 'pi pi-chevron-right'" class="text-[0.65rem] mr-1" aria-hidden="true" />More</button>
        <div v-if="advanced" class="grid grid-cols-3 gap-3">
          <div class="flex flex-col gap-1">
            <span id="fw-dir" class="text-sm font-medium">Direction</span>
            <SelectButton v-model="form.direction" :options="[{ label: 'In', value: 'in' }, { label: 'Out', value: 'out' }]" option-label="label" option-value="value" :allow-empty="false" size="small" aria-labelledby="fw-dir" />
          </div>
          <div class="flex flex-col gap-1">
            <label for="fw-to" class="text-sm font-medium">To address</label>
            <InputText id="fw-to" v-model="form.to" placeholder="any" class="font-mono" autocomplete="off" />
          </div>
          <div class="flex flex-col gap-1">
            <label for="fw-pos" class="text-sm font-medium">Position</label>
            <InputNumber input-id="fw-pos" v-model="form.position" :min="1" placeholder="last" :use-grouping="false" fluid />
          </div>
        </div>
        <small v-if="problem" class="text-red-500">{{ problem }}</small>
        <p v-else class="text-sm text-muted-color">The first rule that matches decides, so put a deny before a broader allow. A rule with no address also gets an IPv6 copy.</p>
        <button type="submit" class="hidden" />
      </form>
      <template #footer>
        <Button label="Cancel" severity="secondary" text :disabled="actions.add.isPending.value" @click="adding = false" />
        <Button label="Add rule" icon="pi pi-plus" :disabled="!!problem" :loading="actions.add.isPending.value" @click="submitAdd" />
      </template>
    </Dialog>
  </div>
</template>
