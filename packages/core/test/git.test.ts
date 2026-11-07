import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { checkRemote, commitInfo, ensureDeployKey, exportTree, fetchMirror, generateSshKey, gitEnv, importSshKey, inspectRepo, listBranches, withGitEnv } from "../src/index.ts";
import { APP_YAML, makeRepo } from "./gitrepo.ts";
import { makeDeps } from "./helpers.ts";

describe("deploy keys", () => {
  it("creates a private ed25519 key once, reports its fingerprint, and rotates on request", async () => {
    const { deps } = await makeDeps();
    const a = await ensureDeployKey(deps, "shop");
    expect(a.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ freighter:shop$/);
    expect(a.fingerprint).toMatch(/^SHA256:/);
    expect((await stat(`${deps.config.git.keyDir}/shop/id_ed25519`)).mode & 0o777).toBe(0o600);
    expect((await ensureDeployKey(deps, "shop")).publicKey).toBe(a.publicKey);
    const b = await ensureDeployKey(deps, "shop", { rotate: true });
    expect(b.publicKey).not.toBe(a.publicKey);
    expect((await ensureDeployKey(deps, "blog")).publicKey).not.toBe(a.publicKey); // per app
  });
});

describe("fetching and exporting", () => {
  it("checks a remote, fetches a branch head and exports its tree", async () => {
    const { deps } = await makeDeps();
    const repo = await makeRepo({ "app.yaml": APP_YAML(), "server.mjs": "// v1\n", "docs/readme.md": "hi\n" });

    expect(await checkRemote(deps, "shop", repo.url, "main")).toBe(repo.first);
    const sha = await fetchMirror(deps, "shop", repo.url, "main");
    expect(sha).toBe(repo.first);
    const info = await commitInfo(deps, "shop", sha);
    expect(info).toEqual({ sha, subject: "initial commit", author: "Ada Dev" });

    const dest = `${deps.config.git.buildDir}/x/src`;
    await exportTree(deps, "shop", sha, "", dest);
    expect(await readFile(`${dest}/server.mjs`, "utf8")).toBe("// v1\n");
    expect(await readFile(`${dest}/docs/readme.md`, "utf8")).toBe("hi\n");
    await expect(stat(`${dest}/.git`)).rejects.toThrow(); // never a repository, only files
    await expect(stat(`${dest}.tar`)).rejects.toThrow(); // temp tarball cleaned up
  });

  it("follows new commits and other branches", async () => {
    const { deps } = await makeDeps();
    const repo = await makeRepo({ "app.yaml": APP_YAML(), "server.mjs": "// v1\n" });
    const second = await repo.commit({ "server.mjs": "// v2\n" }, "second change");
    expect(await fetchMirror(deps, "shop", repo.url, "main")).toBe(second);
    const feature = await repo.commit({ "server.mjs": "// feature\n" }, "on a branch", "feature/x");
    expect(await fetchMirror(deps, "shop", repo.url, "feature/x")).toBe(feature);
    const dest = `${deps.config.git.buildDir}/y/src`;
    await exportTree(deps, "shop", feature, "", dest);
    expect(await readFile(`${dest}/server.mjs`, "utf8")).toBe("// feature\n");
  });

  it("exports just a subdirectory for monorepos", async () => {
    const { deps } = await makeDeps();
    const repo = await makeRepo({ "apps/web/app.yaml": APP_YAML(), "apps/web/server.mjs": "//\n", "other/file": "x" });
    const sha = await fetchMirror(deps, "shop", repo.url, "main");
    const dest = `${deps.config.git.buildDir}/z/src`;
    await exportTree(deps, "shop", sha, "apps/web", dest);
    expect(await readFile(`${dest}/app.yaml`, "utf8")).toContain("name: shop");
    await expect(stat(`${dest}/other`)).rejects.toThrow();
    await expect(exportTree(deps, "shop", sha, "nope", `${dest}2`)).rejects.toThrow(/does "nope" exist/);
  });

  it("explains missing branches and unreachable repositories", async () => {
    const { deps } = await makeDeps();
    const repo = await makeRepo({ "app.yaml": APP_YAML() });
    await expect(checkRemote(deps, "shop", repo.url, "nope")).rejects.toThrow(/branch "nope" does not exist/);
    await expect(fetchMirror(deps, "shop", `${repo.url}-missing`, "main")).rejects.toThrow(/git fetch failed/);
  });
});

describe("what may reach the git command line", () => {
  it("refuses dangerous repository URLs, branches and subpaths", async () => {
    const { deps } = await makeDeps();
    for (const url of ["--upload-pack=touch /tmp/pwned", "-oProxyCommand=x", "ext::sh -c id", "git://example.com/a.git"]) {
      await expect(fetchMirror(deps, "shop", url, "main")).rejects.toThrow();
      await expect(checkRemote(deps, "shop", url, "main")).rejects.toThrow();
    }
    await expect(fetchMirror(deps, "shop", "https://github.com/a/b.git", "--upload-pack=x")).rejects.toThrow(/invalid branch/);
    await expect(exportTree(deps, "shop", "a".repeat(40), "../etc", "/tmp/never")).rejects.toThrow(/invalid subpath/);
  });

  it("only accepts local repositories when the host allows it", async () => {
    const { deps } = await makeDeps();
    const repo = await makeRepo({ "app.yaml": APP_YAML() });
    deps.config.git.allowLocal = false;
    await expect(fetchMirror(deps, "shop", repo.url, "main")).rejects.toThrow(/unsupported repository URL/);
  });
});

describe("imported SSH keys", () => {
  const gen = (dir: string, pass = "") => {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", pass, "-C", "ada@laptop", "-f", dir]);
    return readFileSync(dir, "utf8");
  };

  it("imports a plain key, returning its public half, fingerprint and type", async () => {
    const { deps } = await makeDeps();
    const dir = mkdtempSync(join(tmpdir(), "k-"));
    const pem = gen(join(dir, "id"));
    const k = await importSshKey(deps, pem);
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(k.fingerprint).toMatch(/^SHA256:/);
    expect(k.keyType).toBe("ed25519");
    expect(k.comment).toBe("ada@laptop");
    expect(k.privateKey.trim()).toBe(pem.trim());
  });

  it("decrypts a passphrase-protected key, and explains a missing or wrong passphrase", async () => {
    const { deps } = await makeDeps();
    const dir = mkdtempSync(join(tmpdir(), "k-"));
    const pem = gen(join(dir, "id"), "s3cret");
    await expect(importSshKey(deps, pem)).rejects.toThrow(/passphrase/);
    await expect(importSshKey(deps, pem, "nope")).rejects.toThrow(/passphrase/);
    const k = await importSshKey(deps, pem, "s3cret");
    expect(k.privateKey).not.toContain("ENCRYPTED");
    expect((await importSshKey(deps, k.privateKey)).fingerprint).toBe(k.fingerprint); // now usable without it
  });

  it("generates a usable ed25519 key pair that imports back to the same fingerprint", async () => {
    const { deps } = await makeDeps();
    const k = await generateSshKey(deps, "freighter:work");
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ freighter:work$/);
    expect(k.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect((await importSshKey(deps, k.privateKey)).fingerprint).toBe(k.fingerprint);
    expect(readdirSync(deps.config.git.keyDir).filter((n) => n.startsWith("import-"))).toEqual([]);
  });

  it("rejects garbage and leaves no key material behind", async () => {
    const { deps } = await makeDeps();
    await expect(importSshKey(deps, "not a key")).rejects.toThrow(/not a valid SSH private key/);
    expect(readdirSync(deps.config.git.keyDir).filter((n) => n.startsWith("import-"))).toEqual([]);
  });

  it("writes the key to a 0600 temp file only while git runs, then deletes it", async () => {
    const { deps } = await makeDeps();
    let file = "";
    await withGitEnv(deps, "shop", { sshKey: "KEY" }, async (env) => {
      file = /-i (\S+)/.exec(env.GIT_SSH_COMMAND!)![1]!;
      expect(readFileSync(file, "utf8")).toBe("KEY\n");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
    expect(existsSync(file)).toBe(false);
    await withGitEnv(deps, "shop", { sshKey: "KEY" }, async () => { throw new Error("boom"); }).catch(() => {});
    expect(readdirSync(`${deps.config.git.keyDir}/shop`).filter((n) => n.startsWith("k-"))).toEqual([]);
    expect(existsSync(`${deps.config.git.keyDir}/shop/id_ed25519`)).toBe(false); // no deploy key for an imported one
  });

  it("restricts git to ssh, https and (in tests) file", async () => {
    const { deps } = await makeDeps();
    expect(gitEnv(deps, "shop").GIT_ALLOW_PROTOCOL).toBe("ssh:https:file");
    deps.config.git.allowLocal = false;
    expect(gitEnv(deps, "shop").GIT_ALLOW_PROTOCOL).toBe("ssh:https");
  });
});

describe("listing and inspecting", () => {
  it("lists branches with the default first", async () => {
    const { deps } = await makeDeps();
    const repo = await makeRepo({ "app.yaml": APP_YAML() });
    execFileSync("git", ["-C", repo.work, "branch", "feature/x"]);
    execFileSync("git", ["-C", repo.work, "branch", "dev"]);
    execFileSync("git", ["-C", repo.work, "push", "-q", "origin", "dev", "feature/x"]);
    const r = await listBranches(deps, "_probe", repo.url);
    expect(r.defaultBranch).toBe("main");
    expect(r.branches.map((b) => b.name)).toEqual(["main", "dev", "feature/x"]);
    expect(r.branches[0]).toEqual({ name: "main", default: true });
  });

  it("reads the app name from app.yaml without checking anything out", async () => {
    const { deps } = await makeDeps();
    const repo = await makeRepo({ "app.yaml": APP_YAML(), "server.mjs": "//\n" });
    const r = await inspectRepo(deps, { repository: repo.url, branch: "main" });
    expect(r).toMatchObject({ sha: repo.first, hasManifest: true, valid: true, appName: "shop", error: null });
  });

  it("reports a missing or invalid manifest instead of throwing", async () => {
    const { deps } = await makeDeps();
    const none = await makeRepo({ "server.mjs": "//\n" });
    expect(await inspectRepo(deps, { repository: none.url, branch: "main" })).toMatchObject({ hasManifest: false, valid: false, appName: null });
    const bad = await makeRepo({ "app.yaml": "name: [", "server.mjs": "//\n" });
    expect(await inspectRepo(deps, { repository: bad.url, branch: "main" })).toMatchObject({ hasManifest: true, valid: false, appName: null });
    await expect(inspectRepo(deps, { repository: none.url, branch: "nope" })).rejects.toThrow();
  });
});
