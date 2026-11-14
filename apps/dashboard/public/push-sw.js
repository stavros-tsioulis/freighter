// Added to the service worker (workbox.importScripts in nuxt.config.ts): shows the notifications the control plane
// pushes, and opens the dashboard at the right page when one is clicked.

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(message.title || "Freighter", {
      body: message.body || "",
      // A newer notification about the same thing (a service that came back) replaces the one on screen.
      tag: message.tag || undefined,
      renotify: Boolean(message.tag),
      icon: "/pwa-192.png",
      badge: "/pwa-192.png",
      data: { url: message.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin);
  // Only ever open this dashboard's own pages.
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if ("navigate" in open) await open.navigate(target.href).catch(() => {});
      } else {
        await self.clients.openWindow(target.href);
      }
    })(),
  );
});
