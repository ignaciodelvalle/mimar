"use client";

// Registers public/sw.js for Web Push (PWA push v1). Mounted in the OWNER app
// shell only — push is an owner-side feature; public/institutional surfaces
// never register a worker.
//
// Renders nothing. Registration is best-effort: any failure is silently
// ignored so the app shell can never be affected by SW support quirks.
// Gated by NEXT_PUBLIC_PUSH_ENABLED (default OFF) + browser support checks.

import { useEffect } from "react";

const PUSH_ENABLED =
  process.env.NEXT_PUBLIC_PUSH_ENABLED === "1" || process.env.NEXT_PUBLIC_PUSH_ENABLED === "true";

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!PUSH_ENABLED) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Best-effort: a registration failure must never affect the app shell.
      // The /cuenta push card re-attempts and surfaces state when the user
      // actually interacts with the feature.
    });
  }, []);

  return null;
}
