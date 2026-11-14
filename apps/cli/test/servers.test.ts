import { AgentError } from "@freighter/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { cli, startApi } from "./harness.ts";

type Api = Awaited<ReturnType<typeof startApi>>;
let api: Api | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

const fw = (o: Partial<{ active: boolean; rules: object[] }> = {}) => ({
  installed: true,
  active: o.active ?? true,
  defaults: { incoming: "deny", outgoing: "allow", routed: "disabled" },
  logging: null,
  rules: o.rules ?? [
    { number: 1, to: "22/tcp", action: "allow", direction: "in", from: "Anywhere", comment: "ssh", v6: false },
    { number: 2, to: "22/tcp (v6)", action: "allow", direction: "in", from: "Anywhere (v6)", comment: "ssh", v6: true },
  ],
  essential: [{ port: 22, what: "SSH" }, { port: 443, what: "HTTPS" }],
});

async function setup(handlers: Record<string, (a: any) => unknown> = {}) {
  api = await startApi({ handlers });
  api.registry.servers.create({ name: "contabo-1", address: "203.0.113.9:7443" });
  return { env: { ...api.env(api.admin), FREIGHTER_POLL_MS: "50" }, registry: api.registry };
}

describe("servers", () => {
  it("lists and shows them", async () => {
    const { env } = await setup();
    const list = await cli(["server", "list"], { env });
    expect(list.stdout).toMatch(/SERVER\s+STATE\s+AGENT\s+LOAD\s+MEMORY\s+DISK FREE\s+APPS/);
    expect(list.stdout).toMatch(/local\s+online/);
    expect(list.stdout).toMatch(/contabo-1\s+waiting to enroll/);
    expect((await cli(["server", "list", "-q"], { env })).stdout).toBe("local\ncontabo-1\n");
    const show = await cli(["server", "show", "contabo-1"], { env });
    expect(show.stdout).toMatch(/address\s+203\.0\.113\.9:7443/);
    expect((await cli(["server", "show", "ghost"], { env })).status).toBe(4);
  });

  it("adds a server and prints the command that enrolls it, then issues another", async () => {
    const { env } = await setup();
    const add = await cli(["server", "add", "hetzner-1", "--address", "198.51.100.4"], { env });
    expect(add.status).toBe(0);
    expect(add.stdout).toMatch(/freighter-agent enroll --control http:\/\/127\.0\.0\.1:\d+ --token \S+ --ca-fingerprint SHA256:/);
    expect((await cli(["server", "add", "hetzner-1", "--address", "198.51.100.4"], { env })).status).toBe(1); // taken
    const again = await cli(["server", "token", "hetzner-1", "--json"], { env });
    expect(JSON.parse(again.stdout).enrollment.command).toContain("freighter-agent enroll");
    expect((await cli(["server", "remove", "hetzner-1"], { env })).status).toBe(1); // asks first
    expect((await cli(["server", "remove", "hetzner-1", "--yes"], { env })).stdout).toContain("Removed hetzner-1.");
    expect((await cli(["server", "remove", "local", "--yes"], { env })).status).toBe(1);
  });

  it("follows an upgrade to its end, and exits 5 when it was rolled back", async () => {
    let calls = 0;
    let end: "done" | "rolled-back" = "done";
    const status = () => {
      const state = ++calls < 3 ? "running" : end;
      return { supported: true, reason: null, commit: "bbbbbbbbbbbb", upgrade: { state, from: "aaaaaaa", to: "bbbbbbb", message: state === "running" ? "installing the new version" : state === "done" ? "the new agent is confirmed" : "the new agent did not answer" }, log: "" };
    };
    const { env, registry } = await setup({ ping: () => ({ version: "0", time: "t", capabilities: [] }), "upgrade.start": () => ({}), "upgrade.status": status });
    registry.servers.markSeen("contabo-1", { agentVersion: "aaaaaaa", hostname: "contabo-1" }); // online
    const ok = await cli(["server", "upgrade", "contabo-1", "--ref", "main"], { env });
    expect(ok.status).toBe(0);
    expect(ok.stderr).toContain("Upgrading contabo-1");
    expect(ok.stderr).toContain("installing the new version");
    expect(ok.stderr).toContain("contabo-1 is on bbbbbbb");
    expect(api!.calls.find((c) => c.op === "upgrade.start")!.args).toEqual({ ref: "main" });

    calls = 0;
    end = "rolled-back";
    const bad = await cli(["server", "upgrade", "contabo-1", "--ref", "main"], { env });
    expect(bad.status).toBe(5);
    expect(bad.stderr).toContain("was rolled back: the new agent did not answer");

    expect((await cli(["server", "upgrade", "contabo-1", "--with", "nope"], { env })).status).toBe(2);
    expect((await cli(["server", "upgrade", "contabo-1", "--with", "containers,storage"], { env })).status).toBe(2);
    const fast = await cli(["server", "upgrade", "contabo-1", "--ref", "main", "--no-wait", "-q"], { env });
    expect(fast.status).toBe(0);
  });

  it("shows a server's settings and changes one, saying what needs a restart", async () => {
    const { env } = await setup({
      "config.get": () => ({ fields: [{ key: "agent.console.idleMinutes", section: "Console", label: "Idle", help: "", type: "number", scope: "agent", restart: "agent", value: 30, default: 30, explicit: false }, { key: "agent.console.enabled", section: "Console", label: "On", help: "", type: "boolean", scope: "agent", restart: "none", value: true, default: true, explicit: false }] }),
      "config.set": () => ({ changed: ["agent.console.idleMinutes"], restart: ["agent"], haproxy: "none" }),
    });
    const show = await cli(["server", "config", "local"], { env });
    expect(show.stdout).toMatch(/KEY\s+VALUE\s+DEFAULT/);
    expect(show.stdout).toMatch(/agent\.console\.idleMinutes\s+30/);
    const set = await cli(["server", "config", "local", "set", "agent.console.idleMinutes=45"], { env });
    expect(set.stdout).toContain("Changed agent.console.idleMinutes.");
    expect(set.stdout).toContain("freighter server restart local");
    expect(api!.calls.find((c) => c.op === "config.set")!.args).toEqual({ changes: { "agent.console.idleMinutes": 45 } });
    expect((await cli(["server", "config", "local", "set", "agent.console.idleMinutes=soon"], { env })).status).toBe(2);
    expect((await cli(["server", "config", "local", "set", "nope=1"], { env })).status).toBe(4);
    expect((await cli(["server", "restart", "local"], { env: { ...env } })).status).toBeLessThan(2);
  });
});

describe("firewall", () => {
  it("shows the state and rules, hiding the IPv6 copies", async () => {
    const { env } = await setup({ "firewall.status": () => fw() });
    const r = await cli(["firewall", "local"], { env });
    expect(r.stdout).toContain("Firewall on (incoming: deny, outgoing: allow)");
    expect(r.stdout).toMatch(/1\s+allow\s+22\/tcp\s+Anywhere\s+ssh/);
    expect(r.stdout).not.toContain("(v6)");
  });

  it("adds, removes and sets defaults, and asks before it would lock you out", async () => {
    const { env } = await setup({
      "firewall.status": () => fw(),
      "firewall.add": (a: any) => {
        if (a.action === "deny" && !a.acknowledged) throw Object.assign(new Error("This would block SSH (22/tcp). Confirm to do it anyway."), { code: "bad_request" });
        return fw();
      },
      "firewall.delete": () => fw({ rules: [] }),
      "firewall.default": () => fw(),
      "firewall.enable": () => fw(),
      "firewall.disable": () => fw({ active: false }),
    });
    const allow = await cli(["firewall", "local", "allow", "5432/tcp", "--from", "203.0.113.7", "--comment", "reporting"], { env });
    expect(allow.status).toBe(0);
    expect(api!.calls.find((c) => c.op === "firewall.add")!.args).toMatchObject({ action: "allow", port: "5432", proto: "tcp", from: "203.0.113.7", comment: "reporting" });
    expect((await cli(["firewall", "local", "allow", "5432/icmp"], { env })).status).toBe(2);
    expect((await cli(["firewall", "local", "allow"], { env })).status).toBe(2);

    const del = await cli(["firewall", "local", "delete", "1"], { env });
    expect(del.status).toBe(0);
    expect(api!.calls.find((c) => c.op === "firewall.delete")!.args).toMatchObject({ number: 1, signature: "22/tcp|allow|in|Anywhere", twin: true }); // its IPv6 copy goes with it
    expect((await cli(["firewall", "local", "delete", "9"], { env })).status).toBe(4);

    expect((await cli(["firewall", "local", "default", "incoming", "deny"], { env })).status).toBe(0);
    expect((await cli(["firewall", "local", "default", "sideways", "deny"], { env })).status).toBe(2);
    expect((await cli(["firewall", "local", "enable", "--open", "5432,8080"], { env })).stdout).toContain("22, 443, 5432, 8080");
    expect((await cli(["firewall", "local", "disable"], { env })).status).toBe(1); // asks first
    expect((await cli(["firewall", "local", "disable", "--yes"], { env })).stdout).toContain("The firewall is off.");
  });
});

describe("firewall lockout", () => {
  it("refuses a change that would cut off access, with the reason, and goes through with --yes", async () => {
    const { env } = await setup({
      "firewall.status": () => fw(),
      "firewall.add": (a: any) => {
        if (!a.acknowledged) throw new AgentError("conflict", "This would block SSH on port 22, which is how you reach this server. Confirm to do it anyway.");
        return fw();
      },
    });
    const refused = await cli(["firewall", "local", "deny", "22/tcp"], { env });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("This would block SSH on port 22");
    expect(refused.stderr).toContain("pass --yes to do it anyway");
    expect(refused.stderr).not.toContain("Confirm to do it anyway");
    const forced = await cli(["firewall", "local", "deny", "22/tcp", "--yes"], { env });
    expect(forced.status).toBe(0);
    expect(api!.calls.filter((c) => c.op === "firewall.add").map((c) => c.args.acknowledged ?? false)).toEqual([false, false, true]);
  });
});

describe("processes and settings", () => {
  it("lists processes by memory, and signals one only after asking", async () => {
    const proc = (pid: number, name: string, rss: number, cpu: number) => ({ pid, ppid: 1, name, command: `/usr/bin/${name}`, user: "root", state: "S", cpu, rss, threads: 1, startedMs: 1, starttime: pid * 10, unit: null, managed: null });
    const { env } = await setup({ "processes.list": () => ({ processes: [proc(10, "small", 1000, 9), proc(11, "big", 9_000_000, 1)], cpus: 4, memTotal: 8e9, uptimeSeconds: 1 }), "processes.signal": () => ({}) });
    const r = await cli(["process", "list", "local"], { env });
    expect(r.stdout.split("\n")[1]).toMatch(/^11\s+root\s+1\.0%\s+9\.0 MB\s+big/);
    expect((await cli(["process", "list", "local", "--sort", "cpu", "-q"], { env })).stdout).toBe("10\n11\n");
    expect((await cli(["process", "signal", "local", "11", "KILL"], { env })).status).toBe(1); // asks first
    const sent = await cli(["process", "signal", "local", "11", "kill", "--yes"], { env });
    expect(sent.stdout).toContain("Sent KILL to big (11).");
    expect(api!.calls.find((c) => c.op === "processes.signal")!.args).toMatchObject({ pid: 11, starttime: 110, signal: "KILL" });
    expect((await cli(["process", "signal", "local", "11", "HUGE"], { env })).status).toBe(2);
    expect((await cli(["process", "signal", "local", "999", "HUP"], { env })).status).toBe(4);
  });

  it("shows the control server's settings", async () => {
    const { env } = await setup();
    const r = await cli(["settings"], { env });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/KEY\s+VALUE\s+DEFAULT/);
    expect((await cli(["settings", "set", "nope=1"], { env })).status).toBe(4);
  });
});

