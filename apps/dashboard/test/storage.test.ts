import { describe, expect, it } from "vitest";
import { backendProblem, describeBackend, emptyBackend, endpointOf, usageSnippet } from "../app/utils/storage";

describe("backendProblem", () => {
  it("accepts local, and asks for what a remote backend is missing", () => {
    expect(backendProblem({ kind: "local" }, {})).toBeNull();
    const sftp = { ...emptyBackend("sftp"), host: "files.example.com", user: "me" } as Extract<ReturnType<typeof emptyBackend>, { kind: "sftp" }>;
    expect(backendProblem({ ...sftp, host: "" }, {})).toMatch(/host/);
    expect(backendProblem(sftp, { password: "x" })).toMatch(/host key/);
    const pinned = { ...sftp, hostKey: "files.example.com ssh-ed25519 AAAA" };
    expect(backendProblem(pinned, {})).toMatch(/password/);
    expect(backendProblem(pinned, { password: "x" })).toBeNull();
    expect(backendProblem({ ...pinned, auth: "key" }, {})).toMatch(/private key/);
    expect(backendProblem({ ...pinned, auth: "key" }, { privateKey: "k" })).toBeNull();
    expect(backendProblem(pinned, {}, true)).toBeNull(); // editing: empty means unchanged
    expect(backendProblem({ ...pinned, path: "../etc" }, { password: "x" })).toMatch(/path/);
    expect(backendProblem({ ...pinned, port: 70000 }, { password: "x" })).toMatch(/port/);
  });
  it("checks SMB shares", () => {
    const smb = { ...emptyBackend("smb"), host: "nas.local", user: "me", share: "media" } as ReturnType<typeof emptyBackend>;
    expect(backendProblem(smb, { password: "x" })).toBeNull();
    expect(backendProblem({ ...smb, share: "" } as never, { password: "x" })).toMatch(/share/);
    expect(backendProblem(smb, {})).toMatch(/password/);
  });
});

describe("describing", () => {
  it("summarizes backends and finds the endpoint", () => {
    expect(describeBackend({ kind: "local" })).toBe("Local disk");
    expect(describeBackend({ kind: "sftp", host: "h", user: "u", path: "s3", auth: "key", port: 2222 })).toBe("sftp://u@h:2222/s3");
    expect(describeBackend({ kind: "smb", host: "nas", user: "u", share: "media", path: "b" })).toBe("smb://nas/media/b");
    expect(endpointOf({ hostnames: ["s3.example.com"], port: 20100 })).toBe("https://s3.example.com");
    expect(endpointOf({ hostnames: [], port: 20100 })).toBe("http://127.0.0.1:20100");
    expect(endpointOf({ hostnames: [], port: 0 })).toBeNull();
    expect(usageSnippet("up")).toContain('S3_SECRET_ACCESS_KEY: "@storage:up.secretKey"');
  });
});
