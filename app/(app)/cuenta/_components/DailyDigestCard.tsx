"use client";

// "Resumen diario por correo" card for /cuenta (T2-N1).
//
// One toggle, server-confirmed round trip (no optimistic flip): the whole
// state this card manages is a single boolean column on the caller's own
// row, so there is nothing to reconcile client-side beyond "did the write
// succeed". Rendered unconditionally, like PushNotificationsCard — an
// account that never becomes a digest recipient (no pending queue, ever)
// just toggles a preference that never fires, which is harmless.

import { useState } from "react";

import { setDailyDigestOptOutAction } from "@/app/actions/profile-self-service";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnToggle } from "@/components/ui/Toggle";
import { notifySaved } from "@/lib/ui/action-feedback";

export function DailyDigestCard({ initialOptOut }: { initialOptOut: boolean }) {
  const [optOut, setOptOut] = useState(initialOptOut);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onChange = async (nextEnabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const nextOptOut = !nextEnabled;
    try {
      const result = await setDailyDigestOptOutAction(nextOptOut);
      setOptOut(result.optOut);
      notifySaved(result.optOut ? "Resumen diario desactivado" : "Resumen diario activado");
    } catch {
      setError("No pudimos guardar el cambio. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <LnCard className="mb-8">
      <LnCardHead title="Resumen diario por correo" />
      <LnCardBody>
        <p className="mb-3 text-md leading-[1.5] text-[var(--color-ln-ink-2)]">
          Si tu cuenta tiene pendientes en un organismo u organización (aprobaciones, denuncias
          derivadas, transferencias, etc.), te mandamos un resumen por correo una vez al día. Solo
          se envía cuando hay algo pendiente.
        </p>
        <LnToggle
          checked={!optOut}
          onChange={(next) => void onChange(next)}
          label="Recibir el resumen diario por correo"
          description="Podés desactivarlo acá o desde el enlace al pie de cada correo."
        />
        {busy && <p className="mt-2 text-sm text-[var(--color-ln-mute)]">Guardando…</p>}
        {error && (
          <p role="alert" className="mt-2 text-sm text-[var(--color-ln-err)]">
            {error}
          </p>
        )}
      </LnCardBody>
    </LnCard>
  );
}
