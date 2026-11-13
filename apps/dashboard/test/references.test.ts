import { describe, expect, it } from "vitest";
import { referenceAt, suggest, type ReferenceSources } from "../app/utils/references";

const src: ReferenceSources = {
  services: ["web", "api"],
  env: { api: ["REGION", "MODE"] },
  peers: [{ app: "billing", services: ["api", "ledger"] }],
  storages: ["uploads"],
  volumes: ["media"],
};

describe("referenceAt", () => {
  it("completes inside ${...}, which can sit against other text", () => {
    const v = "redis://${self.USER}:${self.PASS}@${se";
    expect(referenceAt(v, v.length)).toEqual({ start: v.length - 2, query: "se", braced: true });
    expect(referenceAt("${self.USER}@se", 15)).toEqual({ start: 13, query: "se", braced: false }); // the brace is closed: an @ after it starts a reference
    expect(referenceAt("$${se", 5)).toBeNull(); // $${ is a literal
    expect(referenceAt("${HOME}x ${", 11)).toEqual({ start: 11, query: "", braced: true });
  });
  it("completes after a literal @ written as @@, as in user:pass@@@host, and not inside the escape", () => {
    const v = "redis://@self.USER:@self.PASS@@@se";
    expect(referenceAt(v, v.length)).toEqual({ start: v.length - 2, query: "se", braced: false });
    expect(referenceAt("me@se", 5)).toBeNull(); // an email address
    expect(referenceAt("@@se", 4)).toBeNull(); // the escape itself
  });
  it("finds the reference being typed", () => {
    expect(referenceAt("@", 1)).toEqual({ start: 1, query: "", braced: false });
    expect(referenceAt("https://@ap", 11)).toEqual({ start: 9, query: "ap", braced: false });
    expect(referenceAt("x=@api.u and more", 8)).toEqual({ start: 3, query: "api.u", braced: false });
    expect(referenceAt("@billing/api.", 13)).toEqual({ start: 1, query: "billing/api.", braced: false });
  });
  it("ignores email addresses, the @@ escape and finished text", () => {
    expect(referenceAt("me@exam", 7)).toBeNull();
    expect(referenceAt("@@api", 5)).toBeNull();
    expect(referenceAt("@api.url and", 12)).toBeNull();
    expect(referenceAt("none", 4)).toBeNull();
  });
});

describe("suggest", () => {
  const labels = (q: string) => suggest(q, src).map((s) => s.label);
  it("offers services, other apps' services and storages, filtered by what is typed", () => {
    expect(labels("")).toEqual(["web", "api", "billing/api", "billing/ledger", "storage:uploads", "volume:shared", "volume:media"]);
    expect(labels("a")).toEqual(["api", "billing/api", "storage:uploads", "volume:shared", "volume:media"]); // best matches first, then the rest that contain it
    expect(labels("led")).toEqual(["billing/ledger"]);
    expect(labels("stor")).toEqual(["storage:uploads"]);
    expect(labels("zzz")).toEqual([]);
  });
  it("offers @self for the variables of the service being edited, when it is given", () => {
    expect(labels("")).not.toContain("self");
    const self = (q: string, o: { publicOnly?: boolean } = {}) => suggest(q, src, { self: ["DB_HOST", "DB_PORT"], ...o });
    expect(self("")[0]).toMatchObject({ insert: "self.", label: "self", more: true });
    expect(self("sel")[0]!.label).toBe("self");
    expect(self("self.").map((x) => x.label)).toEqual(["DB_HOST", "DB_PORT", "domain", "url", "internal", "port"]);
    expect(self("self.DB_P")[0]).toMatchObject({ insert: "self.DB_PORT", more: false });
    expect(self("", { publicOnly: true }).map((x) => x.label)).not.toContain("self"); // a build has no service of its own
  });
  it("continues with the attributes of the chosen service, including its variables", () => {
    expect(suggest("api", src)[0]).toMatchObject({ insert: "api.", more: true });
    expect(labels("api.")).toEqual(["domain", "url", "internal", "port", "REGION", "MODE"]);
    expect(labels("api.u")).toEqual(["url"]);
    expect(labels("api.reg")).toEqual(["REGION"]);
    expect(suggest("api.u", src)[0]).toMatchObject({ insert: "api.url", more: false });
    expect(labels("billing/api.")).toEqual(["domain", "url", "internal", "port"]);
  });
  it("offers the shared directory and the app's volumes, then their path", () => {
    expect(labels("vol")).toEqual(["volume:shared", "volume:media"]);
    expect(labels("med")).toEqual(["volume:media"]);
    expect(suggest("volume:media", src)[0]).toMatchObject({ insert: "volume:media.", more: true });
    expect(suggest("volume:media.", src)).toEqual([{ insert: "volume:media.path", label: "path", detail: expect.any(String), more: false }]);
  });
  it("knows the attributes of a storage", () => {
    expect(labels("storage:uploads.")).toEqual(["url", "domain", "internal", "publicUrl", "region", "accessKey", "secretKey"]);
    expect(labels("storage:uploads.sec")).toEqual(["secretKey"]);
  });
});

describe("suggestions for a build", () => {
  it("offers only the services and their public address", async () => {
    const { suggest } = await import("../app/utils/references");
    const src = { services: ["web"], env: { web: ["REGION"] }, peers: [{ app: "api", services: ["http"] }], storages: ["up"], volumes: ["media"] };
    expect(suggest("", src, { publicOnly: true }).map((s) => s.label)).toEqual(["web", "api/http"]);
    expect(suggest("web.", src, { publicOnly: true }).map((s) => s.label)).toEqual(["domain", "url"]);
    expect(suggest("web.", src).map((s) => s.label)).toContain("REGION");
    expect(suggest("", src).map((s) => s.label)).toContain("storage:up");
  });
});

describe("filterChoices", () => {
  it("lists everything when nothing is typed, then what starts with it, then what contains it", async () => {
    const { filterChoices } = await import("../app/utils/references");
    const c = [{ value: "uploads", detail: "x" }, { value: "media", detail: "remote folder" }, { value: "cache" }, { value: "user-media" }];
    expect(filterChoices(c, "")).toEqual(c);
    expect(filterChoices(c, "me").map((x) => x.value)).toEqual(["media", "user-media"]);
    expect(filterChoices(c, "REMOTE").map((x) => x.value)).toEqual(["media"]); // the note counts too
    expect(filterChoices(c, "media").map((x) => x.value)).toEqual(["user-media"]); // what is already there is not offered again
    expect(filterChoices(c, "zzz")).toEqual([]);
  });
});
