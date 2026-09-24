"use client";

// Inline-confirm controls for pause (toggle) and archive (soft-delete).
// Mirrors the LeaveOrgButton pattern: two-step confirm, no modal dependency.

import { useState, useTransition } from "react";

import {
  archiveServiceOfferingAction,
  pauseServiceOfferingAction,
  unpauseServiceOfferingAction,
} from "@/app/actions/service-offerings";
import { OpButton } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type Props = {
  orgToken: string;
  offeringToken: string;
  status: string;
};

type ActionKey = "pause" | "unpause" | "archive" | null;

export function OfferingActions({ orgToken, offeringToken, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<ActionKey>(null);
  const [error, setError] = useState<string | null>(null);
  // Tier B optimistic status: pause/unpause flip the local label immediately
  // and revert on error — no router.refresh() (banned, silent-drop defect;
  // see lib/ui/full-page-action-nav.ts). Seeded from the SSR prop.
  const [localStatus, setLocalStatus] = useState(status);

  const isPaused = localStatus === "paused";
  const isArchived = localStatus === "archived";

  function run(action: NonNullable<ActionKey>) {
    setError(null);
    const previousStatus = localStatus;
    if (action === "pause") setLocalStatus("paused");
    if (action === "unpause") setLocalStatus("active");
    setConfirming(null);
    startTransition(async () => {
      let result: { ok: true } | { error: string };
      if (action === "pause") {
        result = await pauseServiceOfferingAction(orgToken, offeringToken);
      } else if (action === "unpause") {
        result = await unpauseServiceOfferingAction(orgToken, offeringToken);
      } else {
        result = await archiveServiceOfferingAction(orgToken, offeringToken);
      }

      if ("error" in result) {
        setLocalStatus(previousStatus);
        setError(result.error);
        return;
      }

      if (action === "archive") {
        // Full document navigation back to the list — a soft router.push
        // after a mutation is the same drop-prone transition machinery
        // (see lib/ui/full-page-action-nav.ts).
        navigateAfterActionSuccess(`/org/${orgToken}/servicios`);
      }
    });
  }

  if (isArchived) return null;

  if (confirming !== null) {
    const isDestructive = confirming === "archive";
    const labelMap: Record<NonNullable<ActionKey>, string> = {
      pause: "¿Pausar el servicio? Dejará de aparecer en búsquedas.",
      unpause: "¿Reactivar el servicio?",
      archive: "¿Eliminar el servicio? Esta acción no se puede deshacer.",
    };
    const confirmLabel: Record<NonNullable<ActionKey>, string> = {
      pause: "Pausar",
      unpause: "Reactivar",
      archive: "Eliminar",
    };
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-ln-op-mute">{labelMap[confirming]}</p>
        {error && (
          <p className="text-sm text-ln-op-danger" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <OpButton
            variant={isDestructive ? "danger" : "primary"}
            size="sm"
            onClick={() => run(confirming)}
            disabled={pending}
          >
            {pending ? "Procesando..." : confirmLabel[confirming]}
          </OpButton>
          <OpButton
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirming(null);
              setError(null);
            }}
            disabled={pending}
          >
            Cancelar
          </OpButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && (
        <p className="w-full text-sm text-ln-op-danger" role="alert">
          {error}
        </p>
      )}
      <OpButton
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(isPaused ? "unpause" : "pause")}
      >
        {isPaused ? "Reactivar servicio" : "Pausar servicio"}
      </OpButton>
      <OpButton variant="danger" size="sm" onClick={() => setConfirming("archive")}>
        Eliminar
      </OpButton>
    </div>
  );
}
