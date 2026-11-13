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
  it("reads the braced form anywhere, so it can sit against other text", () => {
    expect(findReferences("redis://${self.USER}:${self.PASS}@${self.HOST}").map((r) => r.text)).toEqual(["${self.USER}", "${self.PASS}", "${self.HOST}"]);
    expect(findReferences("x${api.url}y${billing/api.PORT}${storage:up.url}${volume:media.path}").map((r) => r.text)).toEqual(["${api.url}", "${billing/api.PORT}", "${storage:up.url}", "${volume:media.path}"]);
    expect(findReferences("${HOME} ${PORT} ${api.nope} ${a.B")).toEqual([]); // not references: left as they are
    expect(substituteReferences("redis://${a.U}:${a.P}@${a.H} $${a.U} @@x", (r) => `<${r.attr}>`)).toBe("redis://<U>:<P>@<H> ${a.U} @x");
  });
  it("puts a literal @ in front of a reference with @@, as in user:pass@host", () => {
    expect(findReferences("redis://@self.USER:@self.PASS@@@self.HOST").map((r) => r.text)).toEqual(["@self.USER", "@self.PASS", "@self.HOST"]);
    expect(substituteReferences("redis://@a.U:@a.P@@@a.H", (r) => `<${r.attr}>`)).toBe("redis://<U>:<P>@<H>");
    expect(findReferences("bob@api.url")).toEqual([]);
  });
  it("replaces references and unescapes @@", () => {
    expect(substituteReferences("https://@api.domain/x @@api.domain", (r) => `<${r.service}>`)).toBe("https://<api>/x @api.domain");
  });
});

describe("manifest connections", () => {
  const api = "name: a\nservices:\n  api:\n    command: x\n";
  const web = (env: string) => `${api}  web:\n    command: y\n    environment:\n${env}`;
  it("accepts references to own services and their environment", () => {
    expect(() => parseManifest(`${api}    environment:\n      A: x\n  web:\n    command: y\n    environment:\n      B: "@api.url"\n      C: "@api.A"\n      D: "@other/svc.url"\n`)).not.toThrow();
  });
  it("rejects unknown services and unset or secret env keys", () => {
    expect(() => parseManifest(web('      A: "@nope.url"\n'))).toThrow(/has no service/);
    expect(() => parseManifest(web('      A: "@api.MISSING"\n'))).toThrow(/not set in the environment of api/);
    expect(() => parseManifest(`${api}    secrets:\n      - S\n  web:\n    command: y\n    environment:\n      A: "@api.S"\n`)).toThrow(/secrets can't be referenced/);
  });
  it("looks in the environment of the service it names, not of the one that holds it", () => {
    expect(() => parseManifest("name: a\nservices:\n  api:\n    command: x\n  web:\n    command: y\n    environment:\n      A: x\n      B: \"@api.A\"\n")).toThrow(/not set in the environment of api/);
  });
});

describe("connectionEdges", () => {
  it("makes the service that holds a reference its consumer, across apps too", async () => {
    const { connectionEdges } = await import("../src/index.ts");
    const m = parseManifest('name: a\nservices:\n  api:\n    command: x\n    environment:\n      PAY: "@billing/api.internal"\n  web:\n    command: y\n    environment:\n      API: "@api.url"\n  jobs:\n    command: z\n');
    const edges = connectionEdges(m).map((e) => `${e.from.service}>${e.to.app}/${e.to.service}.${e.attr}`).sort();
    expect(edges).toEqual(["api>billing/api.internal", "web>a/api.url"]);
  });
});

describe("storage references", () => {
  it("finds @storage:name.attr and leaves lookalikes alone", async () => {
    const { findReferences, storageEdges, referencedStorages } = await import("../src/index.ts");
    expect(findReferences("@storage:uploads.url/x")).toEqual([{ storage: "uploads", attr: "url", text: "@storage:uploads.url" }]);
    expect(findReferences("@storage:uploads.secretKey")[0]).toMatchObject({ attr: "secretKey" });
    expect(findReferences("@storage:uploads.nope")).toEqual([]);
    expect(findReferences("me@storage:uploads.url")).toEqual([]);
    expect(referencedStorages(["@storage:b.url", "@storage:a.region @storage:b.domain", "@api.url"])).toEqual(["a", "b"]);
    const m = parseManifest('name: a\nservices:\n  web:\n    command: x\n    environment:\n      S3: "@storage:up.url"\n');
    expect(storageEdges(m)).toEqual([{ from: { app: "a", service: "web" }, storage: "up", attr: "url", key: "S3" }]);
  });
  it("accepts them in a manifest without checking the storage exists", () => {
    expect(() => parseManifest('name: a\nservices:\n  web:\n    command: x\n    environment:\n      S3: "@storage:anything.url"\n')).not.toThrow();
  });
});

describe("volume references", () => {
  it("finds @volume:name.path", async () => {
    const { findReferences } = await import("../src/index.ts");
    expect(findReferences("dir=@volume:uploads.path/x")).toEqual([{ volume: "uploads", attr: "path", text: "@volume:uploads.path" }]);
    expect(findReferences("@volume:shared.path")[0]).toMatchObject({ volume: "shared" });
    expect(findReferences("@volume:uploads.nope")).toEqual([]);
    expect(findReferences("me@volume:uploads.path")).toEqual([]);
  });
  it("accepts the app's own volumes and shared, and rejects ones it doesn't have", () => {
    const svc = (env: string) => `name: a\nservices:\n  web:\n    command: x\n    volumes:\n      up: /data/up\n    environment:\n      D: "${env}"\n`;
    expect(() => parseManifest(svc("@volume:up.path"))).not.toThrow();
    expect(() => parseManifest(svc("@volume:shared.path"))).not.toThrow();
    expect(() => parseManifest(svc("@volume:nope.path"))).toThrow(/no volume .{1,3}nope/);
  });
  it("is not a connection between services", async () => {
    const { connectionEdges } = await import("../src/index.ts");
    const m = parseManifest('name: a\nservices:\n  web:\n    command: x\n    environment:\n      D: "@volume:shared.path"\n');
    expect(connectionEdges(m)).toEqual([]);
  });
});
