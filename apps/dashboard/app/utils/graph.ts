import dagre from "@dagrejs/dagre";
import type { GraphApp, GraphEdge, GraphService, ProjectGraph } from "~/types";

/** Card geometry, in canvas pixels. Groups are sized from the number of services they hold. */
export const CARD = { w: 264, h: 66, gap: 12, pad: 14, head: 48 } as const;
/** Cards snap to this grid when dragged, and it is the spacing of the dots behind them. */
export const GRID = 22;
const snap = (n: number) => Math.round(n / GRID) * GRID;

export const appNodeId = (app: string) => `app:${app}`;
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

export interface FlowNode {
  id: string;
  type: "app" | "service";
  position: { x: number; y: number };
  parentNode?: string;
  extent?: "parent";
  draggable: boolean;
  selectable: boolean;
  focusable: boolean;
  zIndex: number;
  style?: Record<string, string>;
  data: { app: GraphApp; service?: GraphService; selected: boolean };
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
export function autoLayout(apps: GraphApp[], edges: GraphEdge[]): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 56, ranksep: 120, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const a of apps) {
    const { w, h } = groupSize(a.services.length);
    g.setNode(a.name, { width: w, height: h });
  }
  const seen = new Set<string>();
  for (const e of edges) {
    const k = `${e.from.app}>${e.to.app}`;
    if (e.from.app === e.to.app || seen.has(k) || !g.hasNode(e.from.app) || !g.hasNode(e.to.app)) continue;
    seen.add(k);
    g.setEdge(e.from.app, e.to.app);
  }
  dagre.layout(g);
  return Object.fromEntries(
    apps.map((a) => {
      const n = g.node(a.name)!;
      return [appNodeId(a.name), { x: snap(n.x - n.width / 2), y: snap(n.y - n.height / 2) }];
    }),
  );
}

/**
 * Vue Flow nodes and edges for a project graph. Saved positions win; the rest are laid out. Several references between
 * the same two services collapse into one arrow that carries all their labels. A reference to an app outside the
 * project has no node to point at, so it is returned in `unresolved` for the panel to list.
 */
export function buildFlow(graph: ProjectGraph, selected: { app: string; service?: string } | null) {
  const auto = autoLayout(graph.apps, graph.edges);
  const nodes: FlowNode[] = [];
  const services = new Set<string>();

  for (const a of graph.apps) {
    const id = appNodeId(a.name);
    const { w, h } = groupSize(a.services.length);
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
    a.services.forEach((s, i) => {
      services.add(serviceNodeId(a.name, s.name));
      nodes.push({
        id: serviceNodeId(a.name, s.name),
        type: "service",
        parentNode: id,
        extent: "parent",
        position: { x: CARD.pad, y: CARD.head + i * (CARD.h + CARD.gap) },
        draggable: false,
        selectable: true,
        focusable: true,
        zIndex: 1,
        style: { width: `${CARD.w}px`, height: `${CARD.h}px` },
        data: { app: a, service: s, selected: selected?.app === a.name && selected.service === s.name },
      });
    });
  }

  const merged = new Map<string, FlowEdge>();
  const unresolved: GraphEdge[] = [];
  for (const e of graph.edges) {
    const source = serviceNodeId(e.from.app, e.from.service);
    const target = serviceNodeId(e.to.app, e.to.service);
    if (!services.has(source) || !services.has(target)) {
      unresolved.push(e);
      continue;
    }
    const id = `${source}>${target}`;
    const edge =
      merged.get(id) ??
      ({ id, type: "connection", source, target, zIndex: 2, data: { labels: [], broken: false, highlight: false, dim: false } } satisfies FlowEdge);
    edge.data.labels.push({ attr: e.attr, key: e.key, broken: e.broken });
    edge.data.broken ||= e.broken !== null;
    merged.set(id, edge);
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
