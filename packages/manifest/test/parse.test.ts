import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { domainsSchema, parseDuration, parseManifest, routedServices, routingProblems, routingWarnings } from "../src/index.ts";

const example = readFileSync(new URL("../../../examples/app.yaml", import.meta.url), "utf8");

describe("parseManifest", () => {
  it("parses the example manifest", () => {
    const m = parseManifest(example);
    expect(m.name).toBe("myapp");
    expect(m.services.web?.port).toBe(3100);
    expect(m.services.worker?.restart).toBe("on-failure");
  });
  it("refuses domains in app.yaml (they belong to the app), but tolerates them in old releases", () => {
    const text = "name: a\nservices:\n  web:\n    command: x\ndomains:\n  - hostname: h.example.com\n    service: web\n";
    expect(() => parseManifest(text)).toThrow(/not part of app.yaml/);
    expect(parseManifest(text, { legacy: true }).name).toBe("a");
  });
});

describe("parseManifest validation", () => {
  const base = "name: a\nservices:\n  web:\n    command: x\n";
  it("rejects bad service names", () => {
    expect(() => parseManifest("name: a\nservices:\n  Web:\n    command: x\n")).toThrow();
    expect(() => parseManifest("name: a\nservices:\n  w--b:\n    command: x\n")).toThrow();
  });
  it("rejects bad env keys and secrets", () => {
    expect(() => parseManifest(`${base}environment:\n  lower: x\n`)).toThrow();
    expect(() => parseManifest(`${base}secrets:\n  - "A B"\n`)).toThrow();
  });
  it("rejects a name used as both env and secret", () => {
    expect(() => parseManifest(`${base}environment:\n  K: v\nsecrets:\n  - K\n`)).toThrow(/both/);
  });
});

describe("phase 3 manifest fields", () => {
  const base = "name: a\nservices:\n  web:\n    command: x\n";
  it("defaults healthcheck.timeout and releases.keep", () => {
    const m = parseManifest("name: a\nservices:\n  web:\n    command: x\n    port: 1\n    healthcheck:\n      path: /h\n");
    expect(m.services.web?.healthcheck?.timeout).toBe("30s");
    expect(m.releases.keep).toBe(5);
  });
  it("bounds releases.keep", () => {
    expect(() => parseManifest(`${base}releases:\n  keep: 1\n`)).toThrow();
    expect(parseManifest(`${base}releases:\n  keep: 3\n`).releases.keep).toBe(3);
  });
  it("parses durations", () => {
    expect([parseDuration("500ms"), parseDuration("30s"), parseDuration("2m"), parseDuration("1h")]).toEqual([500, 30_000, 120_000, 3_600_000]);
    expect(() => parseDuration("5")).toThrow();
  });
});

describe("domains", () => {
  const m = parseManifest("name: a\nservices:\n  web:\n    command: x\n    healthcheck:\n      path: /h\n  jobs:\n    command: y\n");
  const dom = (hostname: string, service = "web") => ({ hostname, service, tls: "auto" as const });
  it("a domain routes a service; a port-less healthcheck is only flagged until it has one", () => {
    expect([...routedServices([dom("a.example.com")])]).toEqual(["web"]);
    expect(routingWarnings(m, [])).toEqual([expect.stringMatching(/web: the healthcheck is skipped/)]);
    expect(routingWarnings(m, [dom("a.example.com")])).toEqual([]);
  });
  it("reports domains that point at services the manifest does not define", () => {
    expect(routingProblems(m, [dom("a.example.com"), dom("b.example.com", "nope")])).toEqual([expect.stringMatching(/b.example.com points at service "nope"/)]);
  });
  it("validates and de-duplicates hostnames", () => {
    for (const bad of ["Example.com", "*.example.com", "localhost", "a_b.example.com"]) {
      expect(() => domainsSchema.parse([{ hostname: bad, service: "web" }])).toThrow();
    }
    expect(() => domainsSchema.parse([{ hostname: "a.example.com", service: "web" }, { hostname: "a.example.com", service: "web" }])).toThrow(/duplicate hostname/);
  });
});

describe("image services", () => {
  const svc = (body: string) => `name: a\nservices:\n  web:\n${body}`;
  it("accepts an image instead of a command", () => {
    const m = parseManifest(svc("    image: ghcr.io/org/app:1.2\n    containerPort: 8080\n    volumes:\n      data: /var/lib/data\n"));
    expect(m.services.web?.image).toBe("ghcr.io/org/app:1.2");
    expect(m.services.web?.command).toBeUndefined();
    expect(m.services.web?.containerPort).toBe(8080);
  });
  it("accepts digests, registries with ports and bare names", () => {
    for (const image of ["nginx", "localhost:5000/team/app:latest", `ghcr.io/o/a@sha256:${"a".repeat(64)}`]) {
      expect(parseManifest(svc(`    image: ${image}\n`)).services.web?.image).toBe(image);
    }
  });
  it("requires exactly one of command and image", () => {
    expect(() => parseManifest(svc("    port: 1\n"))).toThrow(/exactly one/);
    expect(() => parseManifest(svc("    command: x\n    image: nginx\n"))).toThrow(/exactly one/);
  });
  it("rejects image fields on command services", () => {
    expect(() => parseManifest(svc("    command: x\n    containerPort: 80\n"))).toThrow(/image services/);
    expect(() => parseManifest(svc("    command: x\n    volumes:\n      d: /d\n"))).toThrow(/image services/);
  });
  it("rejects image references that could escape a unit file", () => {
    for (const image of ['"nginx --privileged"', '"a;b"', '"a\\nb"', "Nginx", "'-v /:/host'"]) {
      expect(() => parseManifest(svc(`    image: ${image}\n`))).toThrow();
    }
  });
  it("requires absolute volume paths", () => {
    expect(() => parseManifest(svc("    image: nginx\n    volumes:\n      d: relative\n"))).toThrow(/absolute/);
  });
});
