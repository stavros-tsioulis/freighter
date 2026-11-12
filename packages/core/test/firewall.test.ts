import { describe, expect, it } from "vitest";
import { FirewallError, addRule, deleteRule, disableFirewall, enableFirewall, firewallStatus, parseDefaults, parseRules, parseVerbose, ruleArgs, setDefaultPolicy, signature, unprotected } from "../src/index.ts";
import { makeDeps } from "./helpers.ts";

const NUMBERED = `Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 22/tcp                     ALLOW IN    Anywhere
[ 2] 80,443/tcp                 ALLOW IN    Anywhere                   # web
[ 3] 5432/tcp                   ALLOW IN    10.0.0.0/8
[ 4] Anywhere on eth0           DENY IN     203.0.113.7
[ 5] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
[ 6] 25/tcp                     REJECT OUT  Anywhere
[ 7] 2222/tcp                   LIMIT IN    Anywhere                   # ssh, rate limited
`;

describe("reading ufw", () => {
  it("reads numbered rules: what, action, direction, who, the comment, the IPv6 twin", () => {
    const r = parseRules(NUMBERED);
    expect(r).toHaveLength(7);
    expect(r[0]).toEqual({ number: 1, to: "22/tcp", action: "allow", direction: "in", from: "Anywhere", comment: "", v6: false });
    expect(r[1]).toMatchObject({ to: "80,443/tcp", comment: "web" });
    expect(r[2]).toMatchObject({ number: 3, from: "10.0.0.0/8" });
    expect(r[3]).toMatchObject({ to: "Anywhere on eth0", action: "deny", from: "203.0.113.7" });
    expect(r[4]).toMatchObject({ v6: true, to: "22/tcp (v6)" });
    expect(r[5]).toMatchObject({ action: "reject", direction: "out" });
    expect(r[6]).toMatchObject({ action: "limit", comment: "ssh, rate limited" });
  });
  it("reads whether it is on and the default policies, and the file's when it is off", () => {
    expect(parseVerbose("Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n")).toEqual({ active: true, logging: "on (low)", defaults: { incoming: "deny", outgoing: "allow", routed: "disabled" } });
    expect(parseVerbose("Status: inactive\n")).toEqual({ active: false, logging: null, defaults: null });
    expect(parseDefaults('DEFAULT_INPUT_POLICY="DROP"\nDEFAULT_OUTPUT_POLICY="ACCEPT"\nDEFAULT_FORWARD_POLICY="DROP"\n')).toEqual({ incoming: "deny", outgoing: "allow", routed: "deny" });
  });
});

describe("rules as ufw arguments", () => {
  it("builds the arguments with no shell in between, and refuses what isn't a rule", () => {
    expect(ruleArgs({ action: "allow", proto: "tcp", port: "443" })).toEqual(["allow", "in", "proto", "tcp", "from", "any", "to", "any", "port", "443"]);
    expect(ruleArgs({ action: "deny", direction: "out", port: "25", from: "10.0.0.0/8", comment: "no mail" }, 2)).toEqual(["insert", "2", "deny", "out", "from", "10.0.0.0/8", "to", "any", "port", "25", "comment", "no mail"]);
    expect(ruleArgs({ action: "allow", proto: "udp", port: "6000:6007", from: "2001:db8::/32" }).slice(-4)).toEqual(["to", "any", "port", "6000:6007"]);
    const bad = (r: Parameters<typeof ruleArgs>[0], re: RegExp) => expect(() => ruleArgs(r)).toThrow(re);
    bad({ action: "allow", port: "0" }, /not a port/);
    bad({ action: "allow", port: "70000", proto: "tcp" }, /not a port/);
    bad({ action: "allow", port: "9:1", proto: "tcp" }, /not a port/);
    bad({ action: "allow", port: "80; rm -rf /" }, /not a port/);
    bad({ action: "allow", port: "8000:8100" }, /needs tcp or udp/);
    bad({ action: "allow", from: "10.0.0.0/33" }, /not an IP/);
    bad({ action: "allow", from: "evil.example.com" }, /not an IP/);
    bad({ action: "allow", to: "1.2.3.4 or any" }, /not an IP/);
    bad({ action: "pass" as never }, /allow, deny, reject or limit/);
    bad({ action: "limit", proto: "udp", port: "53" }, /tcp only/);
    bad({ action: "allow", comment: "a'b; reboot" }, /comment/);
  });
});

describe("the firewall of a server", () => {
  it("says it isn't installed, and what it keeps open to stay manageable", async () => {
    const h = await makeDeps();
    h.ctl.ufw.installed = false;
    const none = await firewallStatus(h.deps);
    expect(none).toMatchObject({ installed: false, active: false, rules: [] });
    expect(none.essential.map((e) => e.port)).toEqual([22, 80, 443]);
    await expect(addRule(h.deps, { action: "allow", port: "80" })).rejects.toMatchObject({ code: "unavailable" });
    h.ctl.ufw.installed = true;
    h.ctl.ufw.sshd = "port 22\nport 2222\n";
    h.deps.config.agent.remote.enabled = true;
    expect((await firewallStatus(h.deps)).essential.map((e) => [e.port, e.what.split(" ")[0]])).toEqual([[22, "SSH"], [2222, "SSH"], [80, "HTTP"], [443, "HTTPS"], [7443, "the"]]);
  });

  it("turns on only after the ways in are allowed, and takes extra ports along", async () => {
    const h = await makeDeps();
    h.ctl.ufw.sshd = "port 2222\n";
    expect(await firewallStatus(h.deps)).toMatchObject({ installed: true, active: false, defaults: { incoming: "deny", outgoing: "allow" } });
    const on = await enableFirewall(h.deps, [5432]);
    expect(on.active).toBe(true);
    expect(on.rules.filter((r) => !r.v6).map((r) => r.to)).toEqual(["2222/tcp", "80/tcp", "443/tcp", "5432/tcp"]);
    expect(on.rules.find((r) => r.to === "2222/tcp")!.comment).toBe("freighter: SSH");
    // the allows came before the switch
    const order = h.calls.filter((c) => c[0] === "ufw").map((c) => c.slice(1).join(" "));
    expect(order.findIndex((c) => c.includes("--force enable"))).toBeGreaterThan(order.findIndex((c) => c.includes("port 5432")));
    expect(unprotected(on.rules, on.essential)).toEqual([]);
    await expect(enableFirewall(h.deps, [99999])).resolves.toMatchObject({ active: true }); // already on: nothing more to do
    expect((await disableFirewall(h.deps)).active).toBe(false);
  });

  it("adds a rule, only while it is on", async () => {
    const h = await makeDeps();
    await expect(addRule(h.deps, { action: "allow", port: "8080", proto: "tcp" })).rejects.toThrow(/turn the firewall on first/);
    await enableFirewall(h.deps);
    const st = await addRule(h.deps, { action: "allow", proto: "tcp", port: "5432", from: "10.0.0.0/8", comment: "db" });
    expect(st.rules.find((r) => r.to === "5432/tcp")).toMatchObject({ action: "allow", from: "10.0.0.0/8", comment: "db", v6: false });
    const at = await addRule(h.deps, { action: "deny", port: "9999", from: "203.0.113.7" }, { position: 1 });
    expect(at.rules[0]).toMatchObject({ number: 1, action: "deny", from: "203.0.113.7" });
  });

  it("refuses a rule that would cut off SSH, the web ports or the agent until it is confirmed", async () => {
    const h = await makeDeps();
    h.deps.config.agent.remote.enabled = true;
    await enableFirewall(h.deps);
    const shut = (port?: string) => addRule(h.deps, { action: "deny", proto: "tcp", port });
    await expect(shut("22")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/SSH \(port 22\)/) });
    await expect(shut("7000:8000")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/the Freighter agent/) });
    await expect(addRule(h.deps, { action: "reject" })).rejects.toMatchObject({ code: "conflict" }); // every port
    // a rule that only touches one address, another port or another protocol is fine
    await addRule(h.deps, { action: "deny", proto: "tcp", port: "22", from: "203.0.113.7" });
    await addRule(h.deps, { action: "deny", proto: "tcp", port: "8080" });
    await addRule(h.deps, { action: "deny", proto: "udp", port: "22" });
    // and confirming lets it through
    expect((await addRule(h.deps, { action: "deny", proto: "tcp", port: "22" }, { acknowledged: true })).rules.some((r) => r.action === "deny" && r.to === "22/tcp" && r.from === "Anywhere")).toBe(true);
  });

  it("removes the rule that was shown, not whatever has its number now", async () => {
    const h = await makeDeps();
    await enableFirewall(h.deps);
    await addRule(h.deps, { action: "allow", proto: "tcp", port: "5432", from: "10.0.0.0/8" });
    await addRule(h.deps, { action: "allow", proto: "tcp", port: "6379", from: "10.0.0.0/8" });
    const before = await firewallStatus(h.deps);
    const pg = before.rules.find((r) => r.to === "5432/tcp")!;
    const redis = before.rules.find((r) => r.to === "6379/tcp")!;
    // the rule at that number moved while the page was open
    await deleteRule(h.deps, pg.number, signature(pg));
    await expect(deleteRule(h.deps, redis.number, signature(redis))).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/rules changed/) });
    const now = await firewallStatus(h.deps);
    expect(now.rules.some((r) => r.to === "5432/tcp")).toBe(false);
    expect(now.rules.some((r) => r.to === "6379/tcp")).toBe(true);
    const redisNow = now.rules.find((r) => r.to === "6379/tcp")!;
    expect((await deleteRule(h.deps, redisNow.number, signature(redisNow))).rules.some((r) => r.to === "6379/tcp")).toBe(false);
  });

  it("removes a rule together with its IPv6 twin when asked", async () => {
    const h = await makeDeps();
    await enableFirewall(h.deps);
    await addRule(h.deps, { action: "allow", proto: "tcp", port: "8080", comment: "app" });
    await addRule(h.deps, { action: "allow", proto: "tcp", port: "9090", from: "10.0.0.0/8" }); // an address: no twin
    const st = await firewallStatus(h.deps);
    expect(st.rules.filter((r) => r.to.startsWith("8080"))).toHaveLength(2);
    const v4 = st.rules.find((r) => r.to === "8080/tcp")!;
    const gone = await deleteRule(h.deps, v4.number, signature(v4), { twin: true });
    expect(gone.rules.some((r) => r.to.startsWith("8080"))).toBe(false);
    const ten = gone.rules.find((r) => r.to === "9090/tcp")!;
    expect((await deleteRule(h.deps, ten.number, signature(ten), { twin: true })).rules.some((r) => r.to.startsWith("9090"))).toBe(false);
  });

  it("refuses to remove the last rule that keeps something essential open, until confirmed", async () => {
    const h = await makeDeps();
    await enableFirewall(h.deps);
    const ssh = (await firewallStatus(h.deps)).rules.find((r) => r.to === "22/tcp" && !r.v6)!;
    await expect(deleteRule(h.deps, ssh.number, signature(ssh))).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/SSH \(port 22\)/) });
    // a second rule that also allows it makes the first one removable
    await addRule(h.deps, { action: "allow", proto: "tcp", port: "20:30" });
    const again = (await firewallStatus(h.deps)).rules.find((r) => r.to === "22/tcp" && !r.v6)!;
    await expect(deleteRule(h.deps, again.number, signature(again))).resolves.toMatchObject({ active: true });
    const last = (await firewallStatus(h.deps)).rules.find((r) => r.to === "20:30/tcp" && !r.v6)!;
    await expect(deleteRule(h.deps, last.number, signature(last))).rejects.toMatchObject({ code: "conflict" });
    await expect(deleteRule(h.deps, last.number, signature(last), { acknowledged: true })).resolves.toBeTruthy();
  });

  it("changes a default policy, and won't deny incoming traffic while something essential has no allow rule", async () => {
    const h = await makeDeps();
    expect((await setDefaultPolicy(h.deps, "outgoing", "deny")).defaults?.outgoing).toBe("allow"); // off: the file says, until it is on
    await enableFirewall(h.deps);
    expect((await setDefaultPolicy(h.deps, "outgoing", "deny")).defaults).toMatchObject({ outgoing: "deny", incoming: "deny" });
    for (const r of (await firewallStatus(h.deps)).rules.filter((r) => !r.v6 && r.to === "80/tcp")) await deleteRule(h.deps, r.number, signature(r), { acknowledged: true });
    await expect(setDefaultPolicy(h.deps, "incoming", "reject")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/HTTP/) });
    expect((await setDefaultPolicy(h.deps, "incoming", "allow")).defaults?.incoming).toBe("allow"); // opening up is never a lockout
    await expect(setDefaultPolicy(h.deps, "incoming", "nope" as never)).rejects.toBeInstanceOf(FirewallError);
  });
});
