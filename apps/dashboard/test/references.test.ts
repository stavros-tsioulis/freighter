import { describe, expect, it } from "vitest";
import { referenceAt, suggest, type ReferenceSources } from "../app/utils/references";

const src: ReferenceSources = {
  services: ["web", "api"],
  env: { api: ["REGION", "MODE"] },
  peers: [{ app: "billing", services: ["api", "ledger"] }],
  storages: ["uploads"],
};

describe("referenceAt", () => {
  it("finds the reference being typed", () => {
    expect(referenceAt("@", 1)).toEqual({ start: 1, query: "" });
    expect(referenceAt("https://@ap", 11)).toEqual({ start: 9, query: "ap" });
    expect(referenceAt("x=@api.u and more", 8)).toEqual({ start: 3, query: "api.u" });
    expect(referenceAt("@billing/api.", 13)).toEqual({ start: 1, query: "billing/api." });
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
    expect(labels("")).toEqual(["web", "api", "billing/api", "billing/ledger", "storage:uploads"]);
    expect(labels("a")).toEqual(["api", "billing/api", "storage:uploads"]); // best matches first, then the rest that contain it
    expect(labels("led")).toEqual(["billing/ledger"]);
    expect(labels("stor")).toEqual(["storage:uploads"]);
    expect(labels("zzz")).toEqual([]);
  });
  it("continues with the attributes of the chosen service, including its variables", () => {
    expect(suggest("api", src)[0]).toMatchObject({ insert: "api.", more: true });
    expect(labels("api.")).toEqual(["domain", "url", "internal", "port", "REGION", "MODE"]);
    expect(labels("api.u")).toEqual(["url"]);
    expect(labels("api.reg")).toEqual(["REGION"]);
    expect(suggest("api.u", src)[0]).toMatchObject({ insert: "api.url", more: false });
    expect(labels("billing/api.")).toEqual(["domain", "url", "internal", "port"]);
  });
  it("knows the attributes of a storage", () => {
    expect(labels("storage:uploads.")).toEqual(["url", "domain", "internal", "region", "accessKey", "secretKey"]);
    expect(labels("storage:uploads.sec")).toEqual(["secretKey"]);
  });
});
