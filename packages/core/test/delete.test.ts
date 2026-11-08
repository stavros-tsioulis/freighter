import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { deleteApp, deploy, envFilePath, readState, setDomains } from "../src/index.ts";
import { artifact, makeDeps, routed } from "./helpers.ts";

describe("deleteApp", () => {
  it("removes an app completely: routing, units, certificates, releases, shared data, secrets and the key", async () => {
    const h = await makeDeps();
    await deploy(h.deps, { ...routed("shop", "shop.example.com", "auto"), source: await artifact() });
    await deploy(h.deps, { ...routed("blog", "blog.example.com", "off"), source: await artifact() });
    await mkdir(h.deps.layout.envDir, { recursive: true });
    await writeFile(envFilePath(h.deps, "shop"), "TOKEN=1\n");
    await mkdir(`${h.deps.config.git.keyDir}/shop`, { recursive: true });
    await mkdir(`${h.deps.layout.appsRoot}/shop/shared`, { recursive: true });
    await writeFile(`${h.deps.layout.appsRoot}/shop/shared/data.db`, "precious");
    const pem = `${h.deps.config.haproxy.dir}/certs/shop.example.com.pem`;
    await mkdir(`${h.deps.config.haproxy.dir}/certs`, { recursive: true });
    await writeFile(pem, "PEM");
    const unit = (await readState(h.deps, "shop")).routed.web!.unit;
    expect(h.unitFiles()).toContain(unit);

    const r = await deleteApp(h.deps, "shop");

    expect(r.hostnames).toEqual(["shop.example.com"]);
    expect(r.units).toContain(unit);
    expect(h.unitFiles().filter((u) => h.unitText(u).includes("X-Freighter-App=shop"))).toEqual([]);
    expect(existsSync(`${h.deps.layout.appsRoot}/shop`)).toBe(false);
    expect(existsSync(envFilePath(h.deps, "shop"))).toBe(false);
    expect(existsSync(`${h.deps.config.git.keyDir}/shop`)).toBe(false);
    expect(existsSync(pem)).toBe(false);
    expect(h.calls.some((c) => c[0] === "certbot" && c.includes("delete") && c.includes("shop.example.com"))).toBe(true);
    // routing: shop is gone, blog is untouched
    const map = h.haproxyFile("hostnames.map")!;
    expect(map).not.toContain("shop.example.com");
    expect(map).toContain("blog.example.com be_blog_web");
    expect(existsSync(`${h.deps.layout.appsRoot}/blog`)).toBe(true);
    expect(h.unitFiles().some((u) => h.unitText(u).includes("X-Freighter-App=blog"))).toBe(true);
  });

  it("refuses unknown apps and invalid names, and needs root", async () => {
    const h = await makeDeps();
    await expect(deleteApp(h.deps, "ghost")).rejects.toThrow(/unknown app "ghost"/);
    await expect(deleteApp(h.deps, "../etc")).rejects.toThrow(/invalid app name/);
    await expect(deleteApp(h.deps, "Bad Name")).rejects.toThrow(/invalid app name/);
    const nonRoot = await makeDeps({ isRoot: false });
    await expect(deleteApp(nonRoot.deps, "shop")).rejects.toThrow(/must run as root/);
  });

  it("works for an app that never went live, and for one that only had domains saved", async () => {
    const h = await makeDeps();
    await setDomains(h.deps, "draft", [{ hostname: "draft.example.com", service: "web", tls: "off" }]);
    const r = await deleteApp(h.deps, "draft");
    expect(r).toMatchObject({ app: "draft", units: [], hostnames: ["draft.example.com"] });
    expect(existsSync(`${h.deps.layout.appsRoot}/draft`)).toBe(false);
  });

  it("removes the system user only if the installer's useradd made it", async () => {
    const withUser = async (passwd: string) => {
      const h = await makeDeps();
      await deploy(h.deps, { ...routed("shop", "shop.example.com", "off"), source: await artifact() });
      const real = h.deps.run;
      h.deps.run = async (cmd, args, o) => (cmd === "getent" ? { stdout: passwd, code: 0 } : real(cmd, args, o));
      await deleteApp(h.deps, "shop");
      return h.calls.some((c) => c[0] === "userdel");
    };
    expect(await withUser("shop:x:998:998::/home/shop:/usr/sbin/nologin\n")).toBe(true);
    // an existing service account that an app happened to be named after: left alone
    expect(await withUser("shop:x:105:112:PostgreSQL:/var/lib/postgresql:/bin/bash\n")).toBe(false);
    expect(await withUser("")).toBe(false);
  });
});
