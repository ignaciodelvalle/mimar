"use client";

// Client component that selects and renders the right attendance form
// based on the offering's service_kind. Shared between org-side and pro-side
// detail pages.

import { useState, useTransition } from "react";

import { DewormingAttendanceForm } from "@/app/_components/attendance-forms/DewormingAttendanceForm";
import { GenericAttendanceForm } from "@/app/_components/attendance-forms/GenericAttendanceForm";
import { MicrochipAttendanceForm } from "@/app/_components/attendance-forms/MicrochipAttendanceForm";
import { SterilizationAttendanceForm } from "@/app/_components/attendance-forms/SterilizationAttendanceForm";
import { VaccinationAttendanceForm } from "@/app/_components/attendance-forms/VaccinationAttendanceForm";
import type { AttendancePayload, AttendanceResult } from "@/app/actions/attendance";
import { OpButton, OpInput } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

type Props = {
  appointmentToken: string;
  serviceKind: string;
  backUrl: string;
  onAttend: (token: string, payload: AttendancePayload) => Promise<AttendanceResult>;
  onNoShow: (token: string, reason: string) => Promise<{ ok: true } | { error: string }>;
  onCancel: (token: string, reason: string) => Promise<{ ok: true } | { error: string }>;
};

// Modes for the "other actions" section.
type ActionMode = "idle" | "noshow" | "cancel";

export function AttendanceFormDispatcher({
  appointmentToken,
  serviceKind,
  backUrl,
  onAttend,
  onNoShow,
  onCancel,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [actionMode, setActionMode] = useState<ActionMode>("idle");
  const [noShowReason, setNoShowReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  function handleSuccess() {
    // Attendance writes libreta events (vaccination, chip, …) — agenda and
    // pet medical SSR must both re-derive, so do one full document navigation
    // back instead of the soft push + router.refresh() pair (banned — see
    // lib/ui/full-page-action-nav.ts).
    navigateAfterActionSuccess(backUrl);
  }

  function submitNoShow() {
    setActionError(null);
    startTransition(async () => {
      const result = await onNoShow(appointmentToken, noShowReason);
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      handleSuccess();
    });
  }

  function submitCancel() {
    setActionError(null);
    startTransition(async () => {
      const result = await onCancel(appointmentToken, cancelReason);
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      handleSuccess();
    });
  }

  function resetAction() {
    setActionMode("idle");
    setNoShowReason("");
    setCancelReason("");
    setActionError(null);
  }

  // Per-service-kind form dispatcher.
  const isVaccination = serviceKind.startsWith("vaccination_");
  const isDeworming = serviceKind === "deworming";
  const isSterilization = serviceKind.startsWith("sterilization_");
  const isMicrochip = serviceKind === "microchip_implantation";

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-md font-semibold text-ln-op-ink mb-4">Registrar asistencia</h2>

        {isVaccination && (
          <VaccinationAttendanceForm
            appointmentToken={appointmentToken}
            onSubmit={(payload) => onAttend(appointmentToken, payload)}
            onSuccess={handleSuccess}
          />
        )}

        {isDeworming && (
          <DewormingAttendanceForm
            appointmentToken={appointmentToken}
            onSubmit={(payload) => onAttend(appointmentToken, payload)}
            onSuccess={handleSuccess}
          />
        )}

        {isSterilization && (
          <SterilizationAttendanceForm
            appointmentToken={appointmentToken}
            onSubmit={(payload) => onAttend(appointmentToken, payload)}
            onSuccess={handleSuccess}
          />
        )}

        {isMicrochip && (
          <MicrochipAttendanceForm
            appointmentToken={appointmentToken}
            onSubmit={(payload) => onAttend(appointmentToken, payload)}
            onSuccess={handleSuccess}
          />
        )}

        {!isVaccination && !isDeworming && !isSterilization && !isMicrochip && (
          <GenericAttendanceForm
            appointmentToken={appointmentToken}
            onSubmit={(payload) => onAttend(appointmentToken, payload)}
            onSuccess={handleSuccess}
          />
        )}
      </section>

      <section className="border-t border-ln-op-line pt-6 space-y-3">
        <h2 className="text-sm font-medium text-ln-op-mute uppercase tracking-[0.08em]">
          Otras acciones
        </h2>

        {actionError && (
          <p
            role="alert"
            className="rounded-[var(--radius-sm)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-sm text-ln-op-danger"
          >
            {actionError}
          </p>
        )}

        {actionMode === "idle" && (
          <div className="flex gap-3 flex-wrap">
            <OpButton variant="ghost" size="sm" onClick={() => setActionMode("noshow")}>
              No vino
            </OpButton>
            <OpButton variant="danger" size="sm" onClick={() => setActionMode("cancel")}>
              Cancelar turno
            </OpButton>
          </div>
        )}

        {actionMode === "noshow" && (
          <div className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg p-3">
            <label htmlFor="noshow-reason" className="block text-sm font-medium text-ln-op-ink">
              Motivo de la ausencia (opcional)
            </label>
            {/* These two fields used to tint their focus ring to the panel tone
                (warn here, danger below). Dropped on purpose: a focus indicator
                has to be recognizable as THE focus indicator everywhere, and a
                warn ring on a warn background is the lowest-contrast pairing on
                this screen. The panel already carries the tone. */}
            <OpInput
              id="noshow-reason"
              type="text"
              value={noShowReason}
              onChange={(e) => setNoShowReason(e.target.value)}
              placeholder="Ej: No se presentó sin aviso"
              size="sm"
            />
            <div className="flex gap-2">
              <OpButton variant="primary" size="sm" onClick={submitNoShow} disabled={pending}>
                {pending ? "Guardando…" : "Registrar ausencia"}
              </OpButton>
              <OpButton variant="ghost" size="sm" onClick={resetAction} disabled={pending}>
                Cancelar
              </OpButton>
            </div>
          </div>
        )}

        {actionMode === "cancel" && (
          <div className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg p-3">
            <label htmlFor="cancel-reason" className="block text-sm font-medium text-ln-op-ink">
              Motivo de la cancelación (opcional)
            </label>
            <OpInput
              id="cancel-reason"
              type="text"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Ej: Cancelado por el profesional"
              size="sm"
            />
            <div className="flex gap-2">
              <OpButton variant="danger" size="sm" onClick={submitCancel} disabled={pending}>
                {pending ? "Cancelando…" : "Cancelar turno"}
              </OpButton>
              <OpButton variant="ghost" size="sm" onClick={resetAction} disabled={pending}>
                Volver
              </OpButton>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
