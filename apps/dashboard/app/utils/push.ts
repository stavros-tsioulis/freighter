/** Why this browser can or cannot receive notifications, in the order the person can fix it. */
export type PushSupport = "ready" | "insecure" | "needs-install" | "unsupported";

export interface PushEnvironment {
  /** Served over https (or from localhost): service workers and push need it. */
  secure: boolean;
  /** The browser has service workers, the Push API and notifications. */
  capable: boolean;
  ios: boolean;
  /** Opened from the home screen rather than a browser tab. */
  standalone: boolean;
}

export function pushSupport(env: PushEnvironment): PushSupport {
  if (!env.secure) return "insecure";
  // iPhones and iPads only have the Push API for a web app that was added to the home screen.
  if (env.ios && !env.standalone) return "needs-install";
  return env.capable ? "ready" : "unsupported";
}

/** The VAPID public key (base64url) as the bytes `pushManager.subscribe` wants. */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "=");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The id the control plane gives a subscription: the start of the SHA-256 of its endpoint, in hex. */
export async function subscriptionId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** A name for this browser to tell devices apart: "Firefox on Linux". */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const system = /iPhone|iPad/.test(userAgent) ? "iOS" : /Android/.test(userAgent) ? "Android" : /Mac OS X/.test(userAgent) ? "macOS" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  return system ? `${browser} on ${system}` : browser;
}
