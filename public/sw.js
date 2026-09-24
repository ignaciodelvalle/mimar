// MiMAR service worker — Web Push delivery only (PWA push v1).
//
// Hand-written on purpose (no next-pwa or workbox): the whole file must stay
// small enough to audit line by line. There is NO caching / offline layer here
// — the SW exists solely so urgent notifications (avistajes / hallazgos /
// custodia) reach the owner even with the tab closed.
//
// Payload contract (JSON, produced by lib/infra/web-push.ts):
//   { title: string, body: string|null, url: string|null, tag: string|null }
//
// Bump SW_VERSION on any change to this file: it busts the icon URL query so
// browsers that byte-compare sw.js re-fetch and activate the new worker.

const SW_VERSION = "1";

const DEFAULT_URL = "/notificaciones";

self.addEventListener("install", () => {
  // Activate immediately — there is no cache state to migrate between versions.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: event.data.text() };
  }

  const title = payload.title || "MiMAR";
  const options = {
    body: payload.body || undefined,
    icon: `/icons/icon-192.png?v=${SW_VERSION}`,
    badge: `/icons/icon-192.png?v=${SW_VERSION}`,
    // Same tag (= the notification row's dedupeKey) collapses retry
    // double-sends into a single displayed notification.
    tag: payload.tag || undefined,
    data: { url: payload.url || DEFAULT_URL },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || DEFAULT_URL;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Reuse an open MiMAR tab when there is one; otherwise open a new one.
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
