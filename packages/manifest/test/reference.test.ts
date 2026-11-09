import { describe, expect, it } from "vitest";
import { findReferences, parseManifest, substituteReferences } from "../src/index.ts";

describe("findReferences", () => {
  it("finds service, app-qualified and env references", () => {
    expect(findReferences("@api.url")).toEqual([{ app: undefined, service: "api", attr: "url", text: "@api.url" }]);
    expect(findReferences("@shop/api-v2.internal/v1 and @web.NODE_ENV").map((r) => [r.app, r.service, r.attr])).toEqual([
      ["shop", "api-v2", "internal"],
      [undefined, "web", "NODE_ENV"],
    ]);
  });
  it("ignores email addresses, escapes and unknown lowercase attributes", () => {
    expect(findReferences("me@api.domain")).toEqual([]);
    expect(findReferences("@@api.url")).toEqual([]);
    expect(findReferences("@api.nope")).toEqual([]);
    expect(findReferences("@api.url_x")).toEqual([]);
  });
});

describe("substituteReferences", () => {
  it("replaces references and unescapes @@", () => {
    expect(substituteReferences("https://@api.domain/x @@api.domain", (r) => `<${r.service}>`)).toBe("https://<api>/x @api.domain");
  });
});

describe("manifest connections", () => {
  const base = "name: a\nservices:\n  api:\n    command: x\n  web:\n    command: y\n";
  it("accepts references to own services and environment", () => {
    expect(() => parseManifest(`${base}environment:\n  A: "@api.url"\n  B: "@api.A"\n  C: "@other/svc.url"\n`)).not.toThrow();
  });
  it("rejects unknown services and unset or secret env keys", () => {
    expect(() => parseManifest(`${base}environment:\n  A: "@nope.url"\n`)).toThrow(/has no service/);
    expect(() => parseManifest(`${base}environment:\n  A: "@api.MISSING"\n`)).toThrow(/not set in environment/);
    expect(() => parseManifest(`${base}environment:\n  A: "@api.S"\nsecrets:\n  - S\n`)).toThrow(/secrets can't be referenced/);
  });
});

describe("connectionEdges", () => {
  it("makes every other service of the app a consumer, across apps too", async () => {
    const { connectionEdges } = await import("../src/index.ts");
    const m = parseManifest('name: a\nservices:\n  api:\n    command: x\n  web:\n    command: y\n  jobs:\n    command: z\nenvironment:\n  API: "@api.url"\n  PAY: "@billing/api.internal"\n');
    const edges = connectionEdges(m).map((e) => `${e.from.service}>${e.to.app}/${e.to.service}.${e.attr}`).sort();
    expect(edges).toEqual(["api>billing/api.internal", "jobs>a/api.url", "jobs>billing/api.internal", "web>a/api.url", "web>billing/api.internal"]);
  });
});

describe("storage references", () => {
  it("finds @storage:name.attr and leaves lookalikes alone", async () => {
    const { findReferences, storageEdges, referencedStorages } = await import("../src/index.ts");
    expect(findReferences("@storage:uploads.url/x")).toEqual([{ storage: "uploads", attr: "url", text: "@storage:uploads.url" }]);
    expect(findReferences("@storage:uploads.secretKey")[0]).toMatchObject({ attr: "secretKey" });
    expect(findReferences("@storage:uploads.nope")).toEqual([]);
    expect(findReferences("me@storage:uploads.url")).toEqual([]);
    expect(referencedStorages({ A: "@storage:b.url", B: "@storage:a.region @storage:b.domain", C: "@api.url" })).toEqual(["a", "b"]);
    const m = parseManifest('name: a\nservices:\n  web:\n    command: x\nenvironment:\n  S3: "@storage:up.url"\n');
    expect(storageEdges(m)).toEqual([{ from: { app: "a", service: "web" }, storage: "up", attr: "url", key: "S3" }]);
  });
  it("accepts them in a manifest without checking the storage exists", () => {
    expect(() => parseManifest('name: a\nservices:\n  web:\n    command: x\nenvironment:\n  S3: "@storage:anything.url"\n')).not.toThrow();
  });
});
