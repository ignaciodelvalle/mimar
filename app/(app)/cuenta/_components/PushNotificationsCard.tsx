"use client";

// "Notificaciones push" card for /cuenta — Web Push v1 (feature-flagged).
//
// Renders NOTHING unless NEXT_PUBLIC_PUSH_ENABLED and the VAPID public key are
// set, so the flag-off deploy is visually identical to today. With the flag
// on, the card offers one toggle:
//   ON  → Notification permission → pushManager.subscribe (VAPID) →
//         savePushSubscriptionAction upsert.
//   OFF → revokePushSubscriptionAction (soft-revoke server-side) +
//         pushManager unsubscribe (browser-side).
//
// The server row is the source of truth for delivery; the browser subscription
// is the transport. Both sides are torn down on toggle-off so a revoked user
// can never keep receiving pushes.

import { useCallback, useEffect, useState } from "react";

import {
  isPushSubscriptionActiveAction,
  revokePushSubscriptionAction,
  savePushSubscriptionAction,
} from "@/app/actions/push-subscriptions";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnToggle } from "@/components/ui/Toggle";
import { notifySaved } from "@/lib/ui/action-feedback";

const PUSH_ENABLED =
  process.env.NEXT_PUBLIC_PUSH_ENABLED === "1" || process.env.NEXT_PUBLIC_PUSH_ENABLED === "true";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

type CardStatus = "detecting" | "unsupported" | "off" | "on" | "busy";

/** Decode the base64url VAPID public key into the BufferSource
 * pushManager.subscribe expects. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function browserSupportsPush(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function PushNotificationsCard() {
  const [status, setStatus] = useState<CardStatus>("detecting");
  const [error, setError] = useState<string | null>(null);

  // Detect current state: an existing browser subscription with granted
  // permission renders the toggle ON.
  useEffect(() => {
    if (!PUSH_ENABLED || !VAPID_PUBLIC_KEY) return;
    if (!browserSupportsPush()) {
      setStatus("unsupported");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (cancelled) return;
        if (!subscription || Notification.permission !== "granted") {
          setStatus("off");
          return;
        }
        // AND THE SERVER HAS TO AGREE. The browser's answer alone was the bug:
        // `revoked_at` is also set by the delivery path when the push service
        // returns 410/404 for a dead endpoint, and in that case the browser
        // still holds its subscription and permission is still granted. The
        // switch read ON forever while the server had stopped sending — a
        // settings screen promising someone they will hear that their lost pet
        // was seen, when they will not.
        const { active } = await isPushSubscriptionActiveAction(subscription.endpoint);
        if (cancelled) return;
        setStatus(active ? "on" : "off");
      } catch {
        if (!cancelled) setStatus("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setStatus("busy");
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("off");
        setError(
          "El navegador tiene bloqueadas las notificaciones para miMAR. Habilitalas en la configuración del sitio y volvé a intentar.",
        );
        return;
      }

      // register() is idempotent — the shell registrar usually did this already.
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
        }));

      const json = subscription.toJSON();
      if (!json.keys?.p256dh || !json.keys?.auth) {
        await subscription.unsubscribe();
        setStatus("off");
        setError("No pudimos activar las notificaciones en este navegador.");
        return;
      }

      const result = await savePushSubscriptionAction({
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      if (!result.ok) {
        // Server rejected: tear the browser side down so state stays coherent.
        await subscription.unsubscribe();
        setStatus("off");
        setError(result.error);
        return;
      }
      setStatus("on");
      // In-place toggle, no reload — the toast is the confirmation
      // (mutation-feedback convention, lib/ui/action-feedback.ts).
      notifySaved("Notificaciones activadas");
    } catch {
      setStatus("off");
      setError("No pudimos activar las notificaciones. Probá de nuevo.");
    }
  }, []);

  const disable = useCallback(async () => {
    setStatus("busy");
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        // Server first (the delivery gate), then the browser transport.
        await revokePushSubscriptionAction(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setStatus("off");
      notifySaved("Notificaciones desactivadas");
    } catch {
      setStatus("off");
      setError("No pudimos desactivar del todo. Revisá los permisos del sitio en tu navegador.");
    }
  }, []);

  if (!PUSH_ENABLED || !VAPID_PUBLIC_KEY) return null;

  return (
    <LnCard className="mb-8">
      <LnCardHead title="Notificaciones push" />
      <LnCardBody>
        <p className="mb-3 text-md leading-[1.5] text-[var(--color-ln-ink-2)]">
          Recibí un aviso al instante en este dispositivo si alguien reporta un avistaje o hallazgo
          de tu mascota, o si hay novedades de una custodia — incluso con miMAR cerrado.
        </p>
        {status === "unsupported" ? (
          <p className="text-sm text-[var(--color-ln-mute)]">
            Este navegador no soporta notificaciones push.
          </p>
        ) : (
          <LnToggle
            checked={status === "on"}
            onChange={(next) => {
              if (status === "busy" || status === "detecting") return;
              if (next) void enable();
              else void disable();
            }}
            label="Recibir notificaciones en este dispositivo"
            description="Podés desactivarlas cuando quieras, desde acá o desde la configuración del navegador."
          />
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-[var(--color-ln-err)]">
            {error}
          </p>
        )}
      </LnCardBody>
    </LnCard>
  );
}
