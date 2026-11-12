import dagre from "@dagrejs/dagre";
import type { GraphApp, GraphEdge, GraphService, GraphStorage, GraphStorageEdge, ProjectGraph } from "~/types";

/** Card geometry, in canvas pixels. Groups are sized from the number of services they hold. */
export const CARD = { w: 264, h: 66, gap: 12, pad: 14, head: 48 } as const;
/** Cards snap to this grid when dragged, and it is the spacing of the dots behind them. */
export const GRID = 22;
const snap = (n: number) => Math.round(n / GRID) * GRID;

export const appNodeId = (app: string) => `app:${app}`;
export const STORAGE_CARD = { w: 232, h: 66 } as const;
export const storageNodeId = (name: string) => `storage:${name}`;
export const serviceNodeId = (app: string, service: string) => `svc:${app}/${service}`;
/** What the URL's `?node=` holds: `app` or `app/service`. */
export const selectionId = (app: string, service?: string) => (service ? `${app}/${service}` : app);
export const parseSelection = (s: string | null | undefined): { app: string; service?: string } | null => {
  if (!s) return null;
  const [app, service] = s.split("/");
  return app ? { app, service: service || undefined } : null;
};

export function groupSize(services: number) {
  const n = Math.max(services, 1);
  return { w: CARD.w + CARD.pad * 2, h: CARD.head + n * CARD.h + (n - 1) * CARD.gap + CARD.pad };
}

type Point = { x: number; y: number };

/**
 * Where each service sits inside its app's box (relative to the box). A service the user has moved keeps the place saved
 * in the layout; the others are stacked, below everything placed so far. Never above or left of the box's padding.
 */
export function serviceSlots(app: Pick<GraphApp, "name" | "services">, layout: Record<string, Point> = {}): Record<string, Point> {
  const slots: Record<string, Point> = {};
  const unplaced: string[] = [];
  for (const s of app.services) {
    const saved = layout[serviceNodeId(app.name, s.name)];
    if (saved) slots[s.name] = { x: Math.max(CARD.pad, saved.x), y: Math.max(CARD.head, saved.y) };
    else unplaced.push(s.name);
  }
  let y = Object.values(slots).reduce<number>((bottom, p) => Math.max(bottom, p.y + CARD.h + CARD.gap), CARD.head);
  // with nothing saved this is the plain stack, in the order the services come
  for (const name of unplaced) {
    slots[name] = { x: CARD.pad, y };
    y += CARD.h + CARD.gap;
  }
  return slots;
}

/** The box that holds the services at these places. */
export function boxAround(slots: Record<string, Point>): { w: number; h: number } {
  const all = Object.values(slots);
  if (!all.length) return groupSize(0);
  return { w: Math.max(...all.map((p) => p.x)) + CARD.w + CARD.pad, h: Math.max(...all.map((p) => p.y)) + CARD.h + CARD.pad };
}

/**
 * After services were dragged: put the first of them back at the box's padding and move the box by the same amount, so
 * nothing moves on screen and the box stays snug around its services. `at` is where the box is, `rel` where the
 * services are inside it.
 */
export function settleGroup(at: Point, rel: Record<string, Point>): { at: Point; rel: Record<string, Point> } {
  const all = Object.values(rel);
  if (!all.length) return { at, rel };
  const dx = Math.min(...all.map((p) => p.x)) - CARD.pad;
  const dy = Math.min(...all.map((p) => p.y)) - CARD.head;
  return { at: { x: at.x + dx, y: at.y + dy }, rel: Object.fromEntries(Object.entries(rel).map(([k, p]) => [k, { x: p.x - dx, y: p.y - dy }])) };
}

export interface FlowNode {
  id: string;
  type: "app" | "service" | "storage";
  position: { x: number; y: number };
  parentNode?: string;
  extent?: "parent";
  draggable: boolean;
  selectable: boolean;
  focusable: boolean;
  zIndex: number;
  style?: Record<string, string>;
  data: { app?: GraphApp; service?: GraphService; storage?: GraphStorage; selected: boolean };
}
export interface EdgeLabel {
  attr: string;
  key: string;
  broken: string | null;
}
export interface FlowEdge {
  id: string;
  type: "connection";
  source: string;
  target: string;
  zIndex: number;
  data: { labels: EdgeLabel[]; broken: boolean; highlight: boolean; dim: boolean };
}

/** Where apps without a saved position go: left to right in the order the connections flow (dagre). */
export function autoLayout(apps: GraphApp[], edges: GraphEdge[], storages: GraphStorage[] = [], storageEdges: GraphStorageEdge[] = [], layout: Record<string, Point> = {}): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 56, ranksep: 120, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const a of apps) {
    const { w, h } = boxAround(serviceSlots(a, layout));
    g.setNode(a.name, { width: w, height: h });
  }
  for (const st of storages) g.setNode(`storage:${st.name}`, { width: STORAGE_CARD.w, height: STORAGE_CARD.h });
  const seen = new Set<string>();
  for (const e of storageEdges) {
    const k = `${e.from.app}>storage:${e.storage}`;
    if (seen.has(k) || !g.hasNode(e.from.app) || !g.hasNode(`storage:${e.storage}`)) continue;
    seen.add(k);
    g.setEdge(e.from.app, `storage:${e.storage}`);
  }
  for (const e of edges) {
    const k = `${e.from.app}>${e.to.app}`;
    if (e.from.app === e.to.app || seen.has(k) || !g.hasNode(e.from.app) || !g.hasNode(e.to.app)) continue;
    seen.add(k);
    g.setEdge(e.from.app, e.to.app);
  }
  dagre.layout(g);
  const at = (id: string, key: string) => {
    const n = g.node(id)!;
    return [key, { x: snap(n.x - n.width / 2), y: snap(n.y - n.height / 2) }] as const;
  };
  return Object.fromEntries([...apps.map((a) => at(a.name, appNodeId(a.name))), ...storages.map((st) => at(`storage:${st.name}`, storageNodeId(st.name)))]);
}

/**
 * Vue Flow nodes and edges for a project graph. Saved positions win; the rest are laid out. Several references between
 * the same two services collapse into one arrow that carries all their labels. A reference to an app outside the
 * project has no node to point at, so it is returned in `unresolved` for the panel to list.
 */
export function buildFlow(graph: ProjectGraph, selected: { app: string; service?: string } | null) {
  const auto = autoLayout(graph.apps, graph.edges, graph.storages ?? [], graph.storageEdges ?? [], graph.layout);
  const nodes: FlowNode[] = [];
  const services = new Set<string>();

  for (const a of graph.apps) {
    const id = appNodeId(a.name);
    const slots = serviceSlots(a, graph.layout);
    const { w, h } = boxAround(slots);
    nodes.push({
      id,
      type: "app",
      position: graph.layout[id] ?? auto[id]!,
      draggable: true,
      selectable: true,
      focusable: true,
      zIndex: 0,
      style: { width: `${w}px`, height: `${h}px` },
      data: { app: a, selected: selected?.app === a.name && !selected.service },
    });
    a.services.forEach((s) => {
      services.add(serviceNodeId(a.name, s.name));
      nodes.push({
        id: serviceNodeId(a.name, s.name),
        type: "service",
        parentNode: id,
        position: slots[s.name]!,
        draggable: true,
        selectable: true,
        focusable: true,
        zIndex: 1,
        style: { width: `${CARD.w}px`, height: `${CARD.h}px` },
        data: { app: a, service: s, selected: selected?.app === a.name && selected.service === s.name },
      });
    });
  }

  for (const st of graph.storages ?? []) {
    const id = storageNodeId(st.name);
    services.add(id);
    nodes.push({
      id,
      type: "storage",
      position: graph.layout[id] ?? auto[id]!,
      draggable: true,
      selectable: true,
      focusable: true,
      zIndex: 1,
      style: { width: `${STORAGE_CARD.w}px`, height: `${STORAGE_CARD.h}px` },
      data: { storage: st, selected: false },
    });
  }

  const merged = new Map<string, FlowEdge>();
  const unresolved: GraphEdge[] = [];
  const addEdge = (source: string, target: string, label: EdgeLabel) => {
    const id = `${source}>${target}`;
    const edge = merged.get(id) ?? ({ id, type: "connection", source, target, zIndex: 2, data: { labels: [], broken: false, highlight: false, dim: false } } satisfies FlowEdge);
    edge.data.labels.push(label);
    edge.data.broken ||= label.broken !== null;
    merged.set(id, edge);
  };
  for (const e of graph.storageEdges ?? []) {
    const source = serviceNodeId(e.from.app, e.from.service);
    const target = storageNodeId(e.storage);
    if (services.has(source) && services.has(target)) addEdge(source, target, { attr: e.attr, key: e.key, broken: e.broken });
  }
  for (const e of graph.edges) {
    const source = serviceNodeId(e.from.app, e.from.service);
    const target = serviceNodeId(e.to.app, e.to.service);
    if (!services.has(source) || !services.has(target)) {
      unresolved.push(e);
      continue;
    }
    addEdge(source, target, { attr: e.attr, key: e.key, broken: e.broken });
  }
  const edges = [...merged.values()];
  if (selected) {
    const touches = (e: FlowEdge) => {
      const ids = [e.source, e.target];
      return selected.service ? ids.includes(serviceNodeId(selected.app, selected.service)) : ids.some((n) => n.startsWith(`svc:${selected.app}/`));
    };
    for (const e of edges) {
      e.data.highlight = touches(e);
      e.data.dim = !e.data.highlight;
    }
  }
  return { nodes, edges, unresolved };
}

/** Short text for an arrow's label: `url`, or `url +1` when several references share it. */
export function edgeLabel(labels: EdgeLabel[]): string {
  const attrs = [...new Set(labels.map((l) => l.attr))];
  return attrs.length === 1 ? attrs[0]! : `${attrs[0]} +${attrs.length - 1}`;
}

/** The connections of a node: what it reads from (uses) and what reads from it (usedBy). */
export function connectionsOf(graph: ProjectGraph, sel: { app: string; service?: string }) {
  const mine = (end: { app: string; service: string }) => end.app === sel.app && (!sel.service || end.service === sel.service);
  const uses = graph.edges.filter((e) => mine(e.from) && !(e.to.app === sel.app && !sel.service));
  const usedBy = graph.edges.filter((e) => mine(e.to) && !(e.from.app === sel.app && !sel.service));
  return { uses, usedBy };
}
