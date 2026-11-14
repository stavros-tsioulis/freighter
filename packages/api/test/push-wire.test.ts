import { createECDH, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRegistry } from "@freighter/registry";
import { createNotifier, type ApiContext } from "../src/index.ts";

const b64url = (b: Buffer) => b.toString("base64url");

afterEach(() => vi.restoreAllMocks());

describe("the real push sender", () => {
  it("sends an encrypted notification, signed with the control plane's VAPID key", async () => {
    // the browser's side of the subscription
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const auth = randomBytes(16);

    const requests: { options: https.RequestOptions; body: Buffer[] }[] = [];
    vi.spyOn(https, "request").mockImplementation(((options: https.RequestOptions, callback: (res: unknown) => void) => {
      const req = Object.assign(new EventEmitter(), {
        body: [] as Buffer[],
        write(chunk: Buffer) { this.body.push(Buffer.from(chunk)); },
        end(chunk?: Buffer) {
          if (chunk) this.body.push(Buffer.from(chunk));
          requests.push({ options, body: this.body });
          const res = Object.assign(new EventEmitter(), { statusCode: 201, headers: {}, setEncoding() {} });
          callback(res);
          res.emit("end");
        },
        setTimeout() {},
        abort() {},
        destroy() {},
      });
      return req;
    }) as never);

    const registry = openRegistry(":memory:");
    const ctx = { registry, now: () => new Date("2026-11-14T10:00:00Z") } as ApiContext;
    const notifier = createNotifier(ctx);
    const row = registry.pushSubscriptions.upsert({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: b64url(browser.getPublicKey()),
      auth: b64url(auth),
      tokenId: "tok_a",
      label: "Test",
      origin: "https://freighter.example.com",
      events: ["server.offline"],
    });

    await notifier.emit({ kind: "server.offline", title: "box is offline", body: "connection refused", url: "/servers/box", tag: "server:box" });

    expect(requests).toHaveLength(1);
    const { options, body } = requests[0]!;
    expect(options.hostname).toBe("fcm.googleapis.com");
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.Urgency).toBe("high");
    // VAPID: a JWT for the push service's origin, from the subject we gave, with the public key beside it
    const [scheme, token] = headers.Authorization!.split(" ");
    expect(scheme).toBe("vapid");
    const claims = JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://freighter.example.com" });
    expect(headers.Authorization).toContain(`k=${notifier.publicKey()}`);

    // the body is the encrypted payload: the words of the notification are not in it
    const encrypted = Buffer.concat(body);
    expect(encrypted.includes("connection refused")).toBe(false);
    expect(registry.pushSubscriptions.get(row.id)).toMatchObject({ lastError: null, lastDeliveredAt: expect.any(String) });
  });
});
