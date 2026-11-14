import type { DeploymentRow, PushTarget, ServerRow, ServiceRow } from "@freighter/registry";
import webpush from "web-push";
import type { ApiContext } from "./context.ts";

/** What can be pushed: the kind (what a subscription chooses), how the dashboard words it, and whether a new subscription starts with it. */
export const NOTIFY_EVENTS = [
  { kind: "deploy.failed", label: "A deployment fails", on: true },
  { kind: "service.crashed", label: "A service crashes or keeps restarting", on: true },
  { kind: "service.recovered", label: "A service is running again", on: true },
  { kind: "server.offline", label: "A server goes offline", on: true },
  { kind: "server.online", label: "A server is reachable again", on: true },
  { kind: "deploy.succeeded", label: "A deployment succeeds", on: false },
] as const;

export type NotifyKind = (typeof NOTIFY_EVENTS)[number]["kind"];

export const isNotifyKind = (x: unknown): x is NotifyKind => NOTIFY_EVENTS.some((e) => e.kind === x);
export const defaultNotifyKinds = (): NotifyKind[] => NOTIFY_EVENTS.filter((e) => e.on).map((e) => e.kind);

export interface NotifyEvent {
  kind: NotifyKind;
  title: string;
  body: string;
  /** Where the notification opens in the dashboard (a path). */
  url: string;
  /** A newer notification with the same tag replaces the one on screen. */
  tag: string;
}

/** What the service worker receives. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface VapidKeys {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Sends one push. Rejects with a `statusCode` when the push service refuses it (the default is the `web-push` library). */
export type PushSender = (target: PushTarget, payload: PushPayload, vapid: VapidKeys, urgency: "high" | "normal") => Promise<void>;

export interface Notifier {
  /** The public half of the VAPID key pair: what a browser needs to subscribe. */
  publicKey(): string;
  /** Push an event to every subscription that asked for its kind. Never throws; failures are recorded on the subscription. */
  emit(event: NotifyEvent, opts?: { throttleMs?: number }): Promise<void>;
  /** Push a test message to one subscription; resolves to why it failed, or null. */
  test(id: string): Promise<string | null>;
}

const PUSH_TTL_SECONDS = 60 * 60;
const FALLBACK_SUBJECT = "mailto:freighter@localhost";
/** A push service that answers with one of these has forgotten the subscription: it will never work again. */
const GONE = new Set([404, 410]);
/** How many throttle entries to keep before dropping the stale ones. */
const THROTTLE_LIMIT = 1000;
/** The kinds whose arrival ends what an earlier one announced. */
const ENDS: Partial<Record<NotifyKind, NotifyKind>> = { "service.recovered": "service.crashed", "server.online": "server.offline" };

const sendWithWebPush: PushSender = async (target, payload, vapid, urgency) => {
  await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(payload), {
    TTL: PUSH_TTL_SECONDS,
    urgency,
    vapidDetails: vapid,
    timeout: 15_000,
  });
};

const reason = (e: unknown) => {
  const status = (e as { statusCode?: number }).statusCode;
  const text = e instanceof Error ? e.message : String(e);
  return status ? `${status}: ${text}` : text;
};

export function createNotifier(ctx: ApiContext): Notifier {
  const send = ctx.pushSender ?? sendWithWebPush;
  const now = () => (ctx.now ?? (() => new Date()))().getTime();
  const lastSent = new Map<string, number>();

  const keys = () => {
    const existing = ctx.registry.pushSubscriptions.keys();
    if (existing) return existing;
    const made = webpush.generateVAPIDKeys();
    ctx.registry.pushSubscriptions.setKeys(made);
    return made;
  };
  /** The VAPID subject names who sends: the dashboard's own address when it has a secure one. */
  const subjectFor = (target: PushTarget) => {
    const origin = target.origin ?? ctx.publicUrl;
    return origin?.startsWith("https://") ? origin : FALLBACK_SUBJECT;
  };

  /** Push to one subscription and record what came of it; a subscription the push service has dropped is forgotten. */
  async function deliver(target: PushTarget, event: NotifyEvent): Promise<string | null> {
    const { publicKey, privateKey } = keys();
    const urgent = event.kind === "deploy.failed" || event.kind === "service.crashed" || event.kind === "server.offline";
    try {
      await send(target, { title: event.title, body: event.body, url: event.url, tag: event.tag }, { subject: subjectFor(target), publicKey, privateKey }, urgent ? "high" : "normal");
      ctx.registry.pushSubscriptions.markResult(target.id, null);
      return null;
    } catch (e) {
      if (GONE.has((e as { statusCode?: number }).statusCode ?? 0)) ctx.registry.pushSubscriptions.remove(target.id);
      else ctx.registry.pushSubscriptions.markResult(target.id, reason(e));
      return reason(e);
    }
  }

  const throttled = (tag: string, ms: number) => {
    const t = now();
    const last = lastSent.get(tag);
    if (last !== undefined && t - last < ms) return true;
    if (lastSent.size >= THROTTLE_LIMIT) for (const [k, at] of lastSent) if (t - at >= ms) lastSent.delete(k);
    lastSent.set(tag, t);
    return false;
  };

  return {
    publicKey: () => keys().publicKey,
    async emit(event, opts) {
      try {
        const targets = ctx.registry.pushSubscriptions.targets().filter((t) => t.events.includes(event.kind));
        if (targets.length === 0) return;
        // It is up again: the next time it goes down is news.
        const ended = ENDS[event.kind];
        if (ended) lastSent.delete(`${ended}:${event.tag}`);
        if (opts?.throttleMs && throttled(`${event.kind}:${event.tag}`, opts.throttleMs)) return;
        await Promise.all(targets.map((t) => deliver(t, event)));
      } catch (e) {
        console.warn("[freighter] push notification failed:", reason(e));
      }
    },
    async test(id) {
      const target = ctx.registry.pushSubscriptions.targets().find((t) => t.id === id);
      if (!target) return "unknown subscription";
      return deliver(target, { kind: "deploy.succeeded", title: "Freighter", body: "Notifications work on this device.", url: "/settings/notifications", tag: "test" });
    },
  };
}

const firstLine = (text: string, max = 160) => {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The notification for a finished deployment; null for one that was canceled (the person who did it knows). */
export function deploymentEvent(d: Pick<DeploymentRow, "id" | "app" | "action" | "status" | "error" | "releaseId">, canceled: string): NotifyEvent | null {
  const what = d.action === "rollback" ? "Rollback" : "Deployment";
  const url = `/apps/${d.app}?tab=deployments`;
  if (d.status === "success") return { kind: "deploy.succeeded", title: `${what} of ${d.app} succeeded`, body: d.releaseId ? `Release ${d.releaseId} is live.` : "It is live.", url, tag: `deploy:${d.app}` };
  if (d.status !== "failed" || d.error?.startsWith(canceled)) return null;
  return { kind: "deploy.failed", title: `${what} of ${d.app} failed`, body: firstLine(d.error ?? "") || "No reason was given.", url, tag: `deploy:${d.app}` };
}

const isDown = (s: Pick<ServiceRow, "activeState" | "subState">) => s.activeState === "failed" || (s.activeState === "activating" && s.subState === "auto-restart");

/** What changed in an app's services between two looks at them, as notifications: one for each that went down or restarted, one for each that came back. */
export function serviceEvents(app: string, before: ServiceRow[], after: ServiceRow[]): NotifyEvent[] {
  const events: NotifyEvent[] = [];
  const previous = new Map(before.map((s) => [s.name, s]));
  for (const now of after) {
    const was = previous.get(now.name);
    if (!was) continue;
    const url = `/apps/${app}`;
    const tag = `service:${app}:${now.name}`;
    const restarts = was.unit === now.unit ? now.restarts - was.restarts : 0;
    if (isDown(now) && !isDown(was)) {
      events.push({ kind: "service.crashed", title: `${app}: ${now.name} is down`, body: `The service is ${now.activeState} (${now.subState}).`, url, tag });
    } else if (restarts > 0) {
      events.push({ kind: "service.crashed", title: `${app}: ${now.name} crashed`, body: `It restarted ${restarts} ${restarts === 1 ? "time" : "times"} since the last check.`, url, tag });
    } else if (isDown(was) && now.activeState === "active") {
      events.push({ kind: "service.recovered", title: `${app}: ${now.name} is running again`, body: "The service is back up.", url, tag });
    }
  }
  return events;
}

export function serverEvent(server: string, was: ServerRow["status"], now: ServerRow): NotifyEvent | null {
  const url = `/servers/${server}`;
  const tag = `server:${server}`;
  if (was === "online" && now.status !== "online") return { kind: "server.offline", title: `${server} is offline`, body: firstLine(now.lastError ?? "") || "The server is not answering.", url, tag };
  if (was !== "online" && now.status === "online") return { kind: "server.online", title: `${server} is reachable again`, body: "The server is answering.", url, tag };
  return null;
}
