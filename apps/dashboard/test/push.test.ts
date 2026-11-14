import { describe, expect, it } from "vitest";
import { applicationServerKey, deviceLabel, pushSupport, subscriptionId } from "../app/utils/push";

const env = { secure: true, capable: true, ios: false, standalone: false };

describe("pushSupport", () => {
  it("is ready where the browser can do it", () => {
    expect(pushSupport(env)).toBe("ready");
  });
  it("needs HTTPS first, then the home screen on iOS, then a capable browser", () => {
    expect(pushSupport({ ...env, secure: false, ios: true })).toBe("insecure");
    expect(pushSupport({ ...env, ios: true, capable: false })).toBe("needs-install");
    expect(pushSupport({ ...env, ios: true, standalone: true })).toBe("ready");
    expect(pushSupport({ ...env, capable: false })).toBe("unsupported");
  });
});

describe("applicationServerKey", () => {
  it("decodes base64url, with or without padding", () => {
    expect([...applicationServerKey("AQID")]).toEqual([1, 2, 3]);
    expect([...applicationServerKey("_-8")]).toEqual([255, 239]);
  });
  it("decodes a real VAPID key to 65 bytes", () => {
    const key = applicationServerKey("BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM");
    expect(key).toHaveLength(65);
    expect(key[0]).toBe(4);
  });
});

describe("subscriptionId", () => {
  it("matches the id the control plane computes (the first 32 hex characters of the endpoint's SHA-256)", async () => {
    expect(await subscriptionId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223");
  });
});

describe("deviceLabel", () => {
  it("names the browser and the system", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0")).toBe("Firefox on Linux");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124.0")).toBe("Edge on Windows");
    expect(deviceLabel("curl/8")).toBe("Browser");
  });
});
