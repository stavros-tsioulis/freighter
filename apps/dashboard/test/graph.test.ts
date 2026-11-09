import { describe, expect, it } from "vitest";
import type { GraphApp, GraphEdge, ProjectGraph } from "../app/types";
import { CARD, appNodeId, buildFlow, connectionsOf, edgeLabel, groupSize, parseSelection, serviceNodeId } from "../app/utils/graph";

const svc = (name: string) => ({ name, activeState: "active", subState: "running", port: 1, hostnames: [], restarts: 0, memoryBytes: null, image: null, command: "x" });
const app = (name: string, ...services: string[]): GraphApp => ({ name, server: "local", status: "deployed", currentRelease: "r1", services: services.map(svc) });
const edge = (fa: string, fs: string, ta: string, ts: string, attr = "url", key = "K", broken: string | null = null): GraphEdge => ({ from: { app: fa, service: fs }, to: { app: ta, service: ts }, attr, key, broken });
const graph = (over: Partial<ProjectGraph> = {}): ProjectGraph => ({
  project: "p",
  storages: [],
  storageEdges: [],
  apps: [app("web", "web", "worker"), app("billing", "api")],
  edges: [edge("web", "web", "billing", "api"), edge("web", "web", "billing", "api", "internal", "B"), edge("web", "web", "ghost", "x", "url", "G", "not in this project")],
  layout: {},
  ...over,
});

describe("buildFlow", () => {
  it("makes a group per app with its services stacked inside, and merges parallel references", () => {
    const { nodes, edges, unresolved } = buildFlow(graph(), null);
    expect(nodes.filter((n) => n.type === "app").map((n) => n.id)).toEqual(["app:web", "app:billing"]);
    const worker = nodes.find((n) => n.id === serviceNodeId("web", "worker"))!;
    expect(worker).toMatchObject({ parentNode: "app:web", position: { x: CARD.pad, y: CARD.head + CARD.h + CARD.gap }, draggable: false });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.data.labels.map((l) => l.attr)).toEqual(["url", "internal"]);
    expect(unresolved.map((e) => e.to.app)).toEqual(["ghost"]);
  });
  it("sizes a group from its services, and an empty app still gets room", () => {
    expect(groupSize(2).h).toBeGreaterThan(groupSize(1).h);
    expect(groupSize(0)).toEqual(groupSize(1));
  });
  it("keeps saved positions and lays out the rest left to right along the connections", () => {
    const placed = buildFlow(graph({ layout: { "app:web": { x: 500, y: 40 } } }), null).nodes;
    expect(placed.find((n) => n.id === appNodeId("web"))!.position).toEqual({ x: 500, y: 40 });
    const auto = buildFlow(graph(), null).nodes;
    expect(auto.find((n) => n.id === appNodeId("billing"))!.position.x).toBeGreaterThan(auto.find((n) => n.id === appNodeId("web"))!.position.x);
  });
  it("highlights the arrows of the selection and dims the rest", () => {
    const g = graph({ apps: [app("web", "web"), app("billing", "api", "db"), app("x", "y")], edges: [edge("web", "web", "billing", "api"), edge("billing", "db", "x", "y")] });
    const sel = buildFlow(g, { app: "web", service: "web" });
    expect(sel.edges.map((e) => [e.data.highlight, e.data.dim])).toEqual([[true, false], [false, true]]);
    expect(sel.nodes.filter((n) => n.data.selected).map((n) => n.id)).toEqual(["svc:web/web"]);
    expect(buildFlow(g, { app: "billing" }).edges.every((e) => e.data.highlight)).toBe(true);
  });
  it("flags an arrow as broken when any of its references is", () => {
    const g = graph({ edges: [edge("web", "web", "billing", "api"), edge("web", "web", "billing", "api", "internal", "B", "has no port")] });
    expect(buildFlow(g, null).edges[0]!.data.broken).toBe(true);
  });
});

describe("helpers", () => {
  it("parses a selection and labels arrows", () => {
    expect(parseSelection("billing/api")).toEqual({ app: "billing", service: "api" });
    expect(parseSelection("billing")).toEqual({ app: "billing", service: undefined });
    expect(parseSelection(null)).toBeNull();
    expect(edgeLabel([{ attr: "url", key: "A", broken: null }])).toBe("url");
    expect(edgeLabel([{ attr: "url", key: "A", broken: null }, { attr: "internal", key: "B", broken: null }])).toBe("url +1");
  });
  it("lists what a node uses and what uses it", () => {
    const g = graph();
    expect(connectionsOf(g, { app: "web", service: "web" }).uses).toHaveLength(3);
    expect(connectionsOf(g, { app: "billing", service: "api" }).usedBy).toHaveLength(2);
    expect(connectionsOf(g, { app: "billing" }).usedBy).toHaveLength(2);
  });
});

describe("storages on the canvas", () => {
  const st = { name: "up", kind: "local" as const, server: "local", hostnames: ["s3.example.com"], activeState: "active" };
  const links = [
    { from: { app: "web", service: "web" }, storage: "up", attr: "url", key: "A", broken: null },
    { from: { app: "web", service: "web" }, storage: "up", attr: "secretKey", key: "B", broken: null },
    { from: { app: "web", service: "worker" }, storage: "up", attr: "url", key: "A", broken: "no domain" },
    { from: { app: "web", service: "web" }, storage: "ghost", attr: "url", key: "C", broken: "no storage" },
  ];
  it("adds a node per storage and one arrow per consuming service, merging parallel references", () => {
    const { nodes, edges } = buildFlow(graph({ storages: [st], storageEdges: links }), null);
    const node = nodes.find((n) => n.id === "storage:up")!;
    expect(node).toMatchObject({ type: "storage", draggable: true, data: { storage: { name: "up" } } });
    expect(node.parentNode).toBeUndefined();
    const toStorage = edges.filter((e) => e.target === "storage:up");
    expect(toStorage.map((e) => [e.source, e.data.labels.map((l) => l.attr), e.data.broken])).toEqual([["svc:web/web", ["url", "secretKey"], false], ["svc:web/worker", ["url"], true]]);
    expect(edges.some((e) => e.target.includes("ghost"))).toBe(false); // no node to point at
  });
  it("lays storages out to the right of the apps that use them, and keeps a saved position", () => {
    const g = graph({ storages: [st], storageEdges: links });
    const auto = buildFlow(g, null).nodes;
    expect(auto.find((n) => n.id === "storage:up")!.position.x).toBeGreaterThan(auto.find((n) => n.id === "app:web")!.position.x);
    const saved = buildFlow({ ...g, layout: { "storage:up": { x: 22, y: 44 } } }, null).nodes;
    expect(saved.find((n) => n.id === "storage:up")!.position).toEqual({ x: 22, y: 44 });
  });
  it("highlights a selected service's arrow to its storage", () => {
    const { edges } = buildFlow(graph({ storages: [st], storageEdges: links }), { app: "web", service: "worker" });
    expect(edges.find((e) => e.id === "svc:web/worker>storage:up")!.data.highlight).toBe(true);
    expect(edges.find((e) => e.id === "svc:web/web>storage:up")!.data.dim).toBe(true);
  });
});
