import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import type { FirewallPolicy, FirewallStatus } from "~/types";
import { ApiRequestError, api } from "./api";

const base = (server: string) => `/servers/${server}/firewall`;

/** The firewall of a server: whether it is on, its policies and its rules. */
export const useFirewall = (server: MaybeRef<string>, enabled: MaybeRef<boolean> = true) =>
  useQuery({
    queryKey: ["firewall", server],
    enabled: computed(() => toValue(enabled)),
    queryFn: () => api<FirewallStatus>(base(toValue(server))),
    refetchInterval: 20_000,
    retry: false,
  });

export interface RuleForm {
  action: "allow" | "deny" | "reject" | "limit";
  direction: "in" | "out";
  proto: "tcp" | "udp" | "any";
  port: string;
  from: string;
  to: string;
  comment: string;
  position?: number;
}

/**
 * Every change returns the firewall as it is afterwards. One that would cut off SSH, the web ports or the agent comes
 * back as a `lockout` error carrying the reason: `confirmed(error)` tells the caller to ask, and to send it again with
 * `acknowledged`.
 */
export function useFirewallActions(server: MaybeRef<string>) {
  const qc = useQueryClient();
  const notify = useNotify();
  const s = () => toValue(server);
  const done = (r: FirewallStatus) => qc.setQueryData(["firewall", s()], r);
  const mutation = <V>(fn: (v: V) => Promise<FirewallStatus>, failed: string) =>
    useMutation({ mutationFn: fn, onSuccess: done, onError: (e) => (isLockout(e) ? undefined : notify.fail(failed, e)) });
  return {
    add: mutation((v: RuleForm & { acknowledged?: boolean }) => api<FirewallStatus>(`${base(s())}/rules`, { method: "POST", body: clean(v) }), "Could not add the rule"),
    remove: mutation((v: { number: number; signature: string; twin: boolean; acknowledged?: boolean }) => api<FirewallStatus>(`${base(s())}/rules/delete`, { method: "POST", body: v }), "Could not remove the rule"),
    enable: mutation((v: { open?: number[] }) => api<FirewallStatus>(`${base(s())}/enable`, { method: "POST", body: v }), "Could not turn the firewall on"),
    disable: mutation(() => api<FirewallStatus>(`${base(s())}/disable`, { method: "POST" }), "Could not turn the firewall off"),
    setDefault: mutation((v: { direction: "incoming" | "outgoing"; policy: FirewallPolicy; acknowledged?: boolean }) => api<FirewallStatus>(`${base(s())}/default`, { method: "PUT", body: v }), "Could not change the default"),
  };
}

export const isLockout = (e: unknown): e is ApiRequestError => e instanceof ApiRequestError && e.code === "lockout";

/** Only what was filled in. */
function clean(v: RuleForm & { acknowledged?: boolean }) {
  return {
    action: v.action,
    direction: v.direction,
    proto: v.proto,
    ...(v.port.trim() ? { port: v.port.trim() } : {}),
    ...(v.from.trim() ? { from: v.from.trim() } : {}),
    ...(v.to.trim() ? { to: v.to.trim() } : {}),
    ...(v.comment.trim() ? { comment: v.comment.trim() } : {}),
    ...(v.position ? { position: v.position } : {}),
    ...(v.acknowledged ? { acknowledged: true } : {}),
  };
}
