import { applicationServerKey, deviceLabel, pushSupport, subscriptionId, type PushSupport } from "~/utils/push";
import { useSavePushSubscription, useRemovePushSubscription } from "./queries";

/** How long to wait for the service worker before concluding there is none (the development server has none). */
const WORKER_WAIT_MS = 4000;

/** This browser's side of web push: whether it can, whether it has permission, and the subscription it holds. */
export function usePushDevice() {
  const save = useSavePushSubscription();
  const remove = useRemovePushSubscription();
  const support = ref<PushSupport | "no-worker" | "checking">("checking");
  const permission = ref<NotificationPermission>("default");
  /** The id the control plane knows this browser's subscription by, once it has one. */
  const id = ref<string | null>(null);
  const busy = ref(false);
  const failure = ref<string | null>(null);

  const registration = async () => {
    const timeout = new Promise<undefined>((resolve) => setTimeout(resolve, WORKER_WAIT_MS));
    return Promise.race([navigator.serviceWorker.ready, timeout]);
  };

  async function refresh() {
    const ua = navigator.userAgent;
    const base = pushSupport({
      secure: window.isSecureContext,
      capable: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
      ios: /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
      standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true,
    });
    support.value = base;
    if (base !== "ready") return;
    permission.value = Notification.permission;
    const reg = await registration();
    if (!reg) return void (support.value = "no-worker");
    const existing = await reg.pushManager.getSubscription();
    id.value = existing ? await subscriptionId(existing.endpoint) : null;
  }
  onMounted(() => void refresh());

  /** Ask for permission (this has to come from a click), subscribe, and tell the control plane. */
  async function enable(publicKey: string): Promise<boolean> {
    busy.value = true;
    failure.value = null;
    try {
      permission.value = await Notification.requestPermission();
      if (permission.value !== "granted") return false;
      const reg = await registration();
      if (!reg) throw new Error("the service worker is not running");
      const subscription =
        (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) }));
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("the browser gave no keys for the subscription");
      const row = await save.mutateAsync({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, label: deviceLabel(navigator.userAgent) });
      id.value = row.id;
      return true;
    } catch (e) {
      failure.value = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** Stop notifications on this browser: forget the subscription there and on the control plane. */
  async function disable(): Promise<void> {
    busy.value = true;
    failure.value = null;
    try {
      const reg = await registration();
      const subscription = await reg?.pushManager.getSubscription();
      if (id.value) await remove.mutateAsync(id.value);
      await subscription?.unsubscribe();
      id.value = null;
    } catch (e) {
      failure.value = e instanceof Error ? e.message : String(e);
    } finally {
      busy.value = false;
    }
  }

  return { support, permission, id, busy, failure, enable, disable };
}
