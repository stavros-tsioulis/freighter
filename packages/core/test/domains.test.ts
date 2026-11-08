import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildLogChunk, currentRelease, deploy, domainsPath, openDeployLog, listReleaseIds, readDomains, readState, setDomains } from "../src/index.ts";
import { artifact, makeDeps, routed, routedManifest } from "./helpers.ts";

const dom = (hostname: string, service = "web", tls: "auto" | "off" = "off") => ({ hostname, service, tls });

describe("domains belong to the app, not to app.yaml", () => {
  it("rejects an app.yaml that still lists domains", async () => {
    const h = await makeDeps();
    const text = `${routedManifest()}domains:\n  - hostname: shop.example.com\n    service: web\n`;
    await expect(deploy(h.deps, { manifestText: text, source: await artifact() })).rejects.toThrow(/not part of app.yaml/);
  });

  it("domains saved before the first deploy are routed by it", async () => {
    const h = await makeDeps();
    expect((await setDomains(h.deps, "shop", [dom("Shop.Example.com")])).deploy).toBeNull();
    expect(await readDomains(h.deps, "shop")).toEqual([dom("shop.example.com")]);
    const r = await deploy(h.deps, { manifestText: routedManifest(), source: await artifact() });
    expect(r.hostnames).toEqual(["shop.example.com"]);
    expect(h.haproxyFile("hostnames.map")).toContain("shop.example.com be_shop_web\n");
  });

  it("adding a domain to a running app redeploys the same release with routing, with no downtime step skipped", async () => {
    const h = await makeDeps();
    const first = await deploy(h.deps, { manifestText: routedManifest(), source: await artifact({ v: "1" }) });
    expect(h.haproxyFile("hostnames.map") ?? "").not.toContain("shop.example.com"); // no domain yet: nothing to route
    expect((await readState(h.deps, "shop")).routed).toEqual({});

    const r = await setDomains(h.deps, "shop", [dom("shop.example.com")]);
    expect(r.deploy?.hostnames).toEqual(["shop.example.com"]);
    expect(r.deploy?.previous).toBe(first.releaseId);
    expect(await currentRelease(h.deps, "shop")).toBe(r.deploy!.releaseId);
    expect(h.haproxyFile("hostnames.map")).toContain("shop.example.com be_shop_web\n");
    // same code, new release
    const code = (id: string) => readFile(`${h.deps.layout.appsRoot}/shop/releases/${id}/v`, "utf8");
    expect(await code(r.deploy!.releaseId)).toBe(await code(first.releaseId));
    expect(await listReleaseIds(h.deps, "shop")).toHaveLength(2);

    // nothing to do when nothing changed
    expect((await setDomains(h.deps, "shop", [dom("shop.example.com")])).deploy).toBeNull();
  });

  it("removing a domain only changes routing: no new release, no restart, no build", async () => {
    const h = await makeDeps();
    const live = await deploy(h.deps, { ...routed("shop", "shop.example.com", "off"), source: await artifact() });
    await setDomains(h.deps, "shop", [dom("shop.example.com"), dom("www.example.com")]);
    expect(h.haproxyFile("hostnames.map")).toContain("www.example.com be_shop_web");

    const before = h.mutating().length;
    const r = await setDomains(h.deps, "shop", [dom("shop.example.com")]);
    expect(r).toMatchObject({ mode: "routing", deploy: null });
    expect(h.haproxyFile("hostnames.map")).not.toContain("www.example.com");
    expect(h.haproxyFile("hostnames.map")).toContain("shop.example.com be_shop_web");
    expect(await currentRelease(h.deps, "shop")).toBe(live.releaseId);
    expect(await listReleaseIds(h.deps, "shop")).toHaveLength(1);
    // the only things that ran are the HAProxy check and reload
    const ran = h.mutating().slice(before).map((c) => c[0]);
    expect(ran.every((c) => c === "haproxy" || c === "systemctl")).toBe(true);
    expect(h.mutating().slice(before).some((c) => c[0] === "systemctl" && ["start", "restart", "stop"].includes(c[1]!))).toBe(false);
  });

  it("removing every domain stops routing, but the service keeps running until the next deploy", async () => {
    const h = await makeDeps();
    const live = await deploy(h.deps, { ...routed("shop", "shop.example.com", "off"), source: await artifact() });
    const unit = (await readState(h.deps, "shop")).routed.web!.unit;

    const r = await setDomains(h.deps, "shop", []);
    expect(r.mode).toBe("routing");
    expect(await readDomains(h.deps, "shop")).toEqual([]);
    expect(h.haproxyFile("hostnames.map") ?? "").not.toContain("shop.example.com");
    // still the same instance on the same port, just without a hostname
    expect((await readState(h.deps, "shop")).routed.web).toMatchObject({ unit, hostnames: [] });
    expect(h.unitFiles()).toContain(unit);
    expect(await currentRelease(h.deps, "shop")).toBe(live.releaseId);

    // adding it back is routing-only too: the instance is still there
    expect((await setDomains(h.deps, "shop", [dom("shop.example.com")])).mode).toBe("routing");
    expect(h.haproxyFile("hostnames.map")).toContain("shop.example.com be_shop_web");

    // the next deploy settles it: with no domain the service is no longer routed and the old instance goes
    await setDomains(h.deps, "shop", []);
    await deploy(h.deps, { manifestText: routedManifest(), source: await artifact({ v: "2" }) });
    expect((await readState(h.deps, "shop")).routed).toEqual({});
    expect(h.unitFiles()).not.toContain(unit);
  });

  it("another domain for a service that is already routed is routing-only; the first one still redeploys", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: routedManifest(), source: await artifact() });
    expect((await setDomains(h.deps, "shop", [dom("a.example.com")])).mode).toBe("deploy"); // web gets its first domain
    expect((await setDomains(h.deps, "shop", [dom("a.example.com"), dom("b.example.com")])).mode).toBe("routing");
    expect(await listReleaseIds(h.deps, "shop")).toHaveLength(2); // the first deploy and the one for the first domain, not three
    expect(h.haproxyFile("hostnames.map")).toContain("b.example.com be_shop_web");
  });

  it("drops the certificate of a removed tls: auto domain, and issues one for an added one", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("shop", "shop.example.com", "auto"), source: await artifact() });
    const pem = `${h.deps.config.haproxy.dir}/certs/shop.example.com.pem`;
    await mkdir(`${h.deps.config.haproxy.dir}/certs`, { recursive: true });
    await writeFile(pem, "PEM");
    h.ctl.issued.length = 0;
    await setDomains(h.deps, "shop", [dom("shop.example.com", "web", "auto"), dom("new.example.com", "web", "auto")]);
    expect(h.ctl.issued).toEqual(["new.example.com"]); // the existing one is left alone
    await setDomains(h.deps, "shop", [dom("new.example.com", "web", "auto")]);
    expect(existsSync(pem)).toBe(false);
  });

  it("puts the old domains back when HAProxy rejects the new routing", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("shop", "shop.example.com", "off"), source: await artifact() });
    await setDomains(h.deps, "shop", [dom("shop.example.com"), dom("www.example.com")]);
    const map = h.haproxyFile("hostnames.map");
    h.ctl.haproxyCheckCode = 1;
    await expect(setDomains(h.deps, "shop", [dom("shop.example.com")])).rejects.toThrow(/config check failed/);
    expect((await readDomains(h.deps, "shop")).map((x) => x.hostname)).toEqual(["shop.example.com", "www.example.com"]);
    expect(h.haproxyFile("hostnames.map")).toBe(map);
    expect((await readState(h.deps, "shop")).routed.web!.hostnames.map((x) => x.hostname)).toEqual(["shop.example.com", "www.example.com"]);
  });

  it("refuses a service the release lacks, and a hostname another app has", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { manifestText: routedManifest(), source: await artifact() });
    await expect(setDomains(h.deps, "shop", [dom("a.example.com", "nope")])).rejects.toThrow(/points at service "nope"/);
    expect(await readDomains(h.deps, "shop")).toEqual([]);

    await setDomains(h.deps, "shop", [dom("a.example.com")]);
    await expect(setDomains(h.deps, "other", [dom("a.example.com")])).rejects.toThrow(/already used by app "shop"/); // even before "other" is deployed
    await expect(setDomains(h.deps, "shop", [dom("a.example.com"), dom("a.example.com")])).rejects.toThrow(/duplicate hostname/);
  });

  it("a change that cannot go live is undone: domains and routing stay as they were", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("shop", "shop.example.com", "off"), source: await artifact() });
    const before = h.haproxyFile("hostnames.map");
    h.ctl.failIssue = true; // the new tls: auto domain cannot get a certificate
    await expect(setDomains(h.deps, "shop", [dom("shop.example.com"), dom("new.example.com", "web", "auto")])).rejects.toThrow(/certbot failed/);
    expect((await readDomains(h.deps, "shop")).map((x) => x.hostname)).toEqual(["shop.example.com"]);
    expect(h.haproxyFile("hostnames.map")).toBe(before);
    expect(await readFile(domainsPath(h.deps, "shop"), "utf8")).toContain("shop.example.com");
  });

  it("domains survive redeploys and rollbacks", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("shop", "shop.example.com", "off"), source: await artifact({ v: "1" }) });
    const b = await deploy(h.deps, { manifestText: routedManifest(), source: await artifact({ v: "2" }) }); // no domains given: keep them
    expect(b.hostnames).toEqual(["shop.example.com"]);
  });

  describe("the deployment log", () => {
    const collect = () => {
      const lines: string[] = [];
      return { lines, log: (l: string) => void lines.push(l), text: () => lines.join("\n") };
    };

    it("says what a redeploy for a first domain is doing, step by step", async () => {
      const h = await makeDeps();
      await deploy(h.deps, { manifestText: routedManifest(), source: await artifact() });
      const c = collect();
      await setDomains(h.deps, "shop", [dom("shop.example.com", "web", "auto")], { log: c.log });
      const t = c.text();
      expect(t).toContain("domains for shop: shop.example.com -> web");
      expect(t).toContain("web gets its first domain");
      expect(t).toContain("the same files, no build");
      expect(t).toContain("certificate for shop.example.com");
      expect(t).toMatch(/starting web as a new instance \(freighter-shop--web--r[\d-]+\.service\) on port 2000\d/);
      expect(t).toContain("restarting worker in place");
      expect(t).toContain("waiting for 2 services to be healthy");
      expect(t).toContain("switching HAProxy to shop.example.com");
      expect(t).toMatch(/release r[\d-]+ is live/);
    });

    it("says that a routing-only change touched nothing but HAProxy", async () => {
      const h = await makeDeps();
      await deploy(h.deps, { ...routed("shop", "shop.example.com", "off"), source: await artifact() });
      const c = collect();
      await setDomains(h.deps, "shop", [], { log: c.log });
      const t = c.text();
      expect(t).toContain("routing only");
      expect(t).toContain("nothing is rebuilt, redeployed or restarted");
      expect(t).toContain("no longer routing shop.example.com");
      expect(t).not.toContain("starting");
      expect(t).not.toContain("staging release");

      const same = collect();
      await setDomains(h.deps, "shop", [], { log: same.log });
      expect(same.text()).toContain("nothing changed");
    });

    it("shows why a redeploy failed, with the service's own output, and that the old release is back", async () => {
      const h = await makeDeps();
      await deploy(h.deps, { manifestText: routedManifest(), source: await artifact() });
      const bad = await artifact({ BAD: "" });
      await deploy(h.deps, { manifestText: routedManifest(), source: bad }).catch(() => undefined); // an unhealthy release can't be the one we redeploy
      const c = collect();
      await deploy(h.deps, { manifestText: routedManifest(), source: bad, domains: [dom("shop.example.com")], log: c.log }).catch(() => undefined);
      const t = c.text();
      expect(t).toContain("waiting for");
      expect(t).toMatch(/web: no healthy response/);
      expect(t).toContain("boom: something broke"); // the journal tail, as `describeFailures` prints it
      expect(t).toContain("the new release did not come up");
      expect(t).toMatch(/release r[\d-]+ failed; going back to r[\d-]+/);
    });

    it("is written where `build.log` reads it", async () => {
      const h = await makeDeps();
      const log = await openDeployLog(h.deps, "0a1b2c3d-1111-2222-3333-444455556666");
      await log("==> one");
      await log("    two");
      expect((await buildLogChunk(h.deps, "0a1b2c3d-1111-2222-3333-444455556666")).text).toBe("==> one\n    two\n");
      expect((await buildLogChunk(h.deps, "0a1b2c3d-1111-2222-3333-444455556666", 8)).text).toBe("    two\n");
    });
  });
});
