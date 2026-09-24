"use client";

/**
 * MisTurnosSheetMounter — deep-link driven sheets for the appointment detail page.
 *
 * Opens the appropriate sheet based on `?sheet=<id>` URL state.
 * Closing removes the `sheet` param from the URL via closeSheetNav (native
 * History API — router-hot-path fix, see lib/ui/sheet-nav.ts).
 *
 * Supported sheet IDs:
 *   cancelar-turno
 */

import { LnButton } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/VaulSheet";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav, closeSheetNavWithFullReload } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState, useTransition } from "react";

import { cancelAppointmentByOwnerAction } from "@/app/actions/booking";

type Props = {
  appointmentToken: string;
};

export function MisTurnosSheetMounter({ appointmentToken }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sheet = searchParams.get("sheet");

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    closeSheetNav(buildCloseSheetUrl(pathname, params));
  }, [pathname, searchParams]);

  // Cancelling the appointment mutates server-rendered content elsewhere on
  // the page (the status badge + this very cancel button, both rendered by
  // the server page.tsx) that a shallow close does NOT re-fetch — same
  // rationale as SheetMounter's closeAfterEmergencyContactSave. This used to
  // be router.refresh() + close(), but router.refresh() rides the same
  // client-router transition machinery that silently drops in production
  // (see closeSheetNavWithFullReload's docblock), so it uses the full-reload
  // close variant instead.
  const closeAfterCancel = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    closeSheetNavWithFullReload(buildCloseSheetUrl(pathname, params));
  }, [pathname, searchParams]);

  if (sheet === "cancelar-turno") {
    const action = cancelAppointmentByOwnerAction.bind(null, appointmentToken);
    return (
      <Sheet id="cancelar-turno" title="Cancelar turno" open onClose={close} size="sm">
        <CancelarTurnoConfirmation
          action={action}
          onCancel={close}
          onCancelled={closeAfterCancel}
        />
      </Sheet>
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// CancelarTurnoConfirmation — inline confirmation form for the cancelar-turno sheet
// ---------------------------------------------------------------------------

function CancelarTurnoConfirmation({
  action,
  onCancel,
  onCancelled,
}: {
  action: () => Promise<{ ok: true } | { error: string }>;
  onCancel: () => void;
  onCancelled: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        // Show the error inline — keep the sheet open so the user can retry.
        setError(result.error);
        return;
      }
      // Status badge + cancel button are server-rendered — close via the
      // full-reload variant so they pick up the new state (see onCancelled).
      onCancelled();
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        ¿Seguro que querés cancelar este turno? Esta acción no se puede deshacer.
      </p>
      {error && (
        <p className="text-sm text-[var(--color-ln-err)]" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-3">
        <LnButton type="button" variant="seal" size="md" loading={pending} onClick={handleSubmit}>
          Sí, cancelar
        </LnButton>
        <LnButton type="button" variant="ghost" size="md" disabled={pending} onClick={onCancel}>
          Volver
        </LnButton>
      </div>
    </div>
  );
}
