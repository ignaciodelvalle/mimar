"use client";

// Generic attendance form — fallback for service_kinds without a specific schema.
// Maps to the vet_visit_logged event payload schema in lib/event-schemas.ts.

import { useState, useTransition } from "react";

import type { AttendanceResult, VetVisitPayload } from "@/app/actions/attendance";
import { OpFieldLabel, OpFormAlert, OpInput, OpSubmitButton } from "@/components/ui/dashboard";

type Props = {
  appointmentToken: string;
  onSubmit: (payload: { kind: "vet_visit" } & VetVisitPayload) => Promise<AttendanceResult>;
  onSuccess?: () => void;
  submitLabel?: string;
};

export function GenericAttendanceForm({
  appointmentToken,
  onSubmit,
  onSuccess,
  submitLabel = "Marcar asistencia",
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);

    const payload = {
      kind: "vet_visit" as const,
      reason: String(data.get("reason") ?? "").trim(),
      diagnosis: String(data.get("diagnosis") ?? "").trim() || null,
      vet_name: String(data.get("vet_name") ?? "").trim() || null,
      clinic: String(data.get("clinic") ?? "").trim() || null,
    };

    if (!payload.reason) {
      setError("El motivo de la consulta es obligatorio.");
      return;
    }

    startTransition(async () => {
      const result = await onSubmit(payload);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onSuccess?.();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <div>
        <OpFieldLabel htmlFor="gen-reason">
          Motivo de la consulta <span className="text-ln-op-danger">*</span>
        </OpFieldLabel>
        <OpInput
          id="gen-reason"
          name="reason"
          type="text"
          required
          placeholder="Ej: Control de rutina, revisación"
        />
      </div>

      <div>
        <OpFieldLabel htmlFor="gen-diagnosis">Diagnóstico / observaciones</OpFieldLabel>
        <OpInput id="gen-diagnosis" name="diagnosis" type="text" placeholder="Opcional" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <OpFieldLabel htmlFor="gen-vet_name">Veterinario/a</OpFieldLabel>
          <OpInput id="gen-vet_name" name="vet_name" type="text" placeholder="Nombre (opcional)" />
        </div>
        <div>
          <OpFieldLabel htmlFor="gen-clinic">Clínica</OpFieldLabel>
          <OpInput id="gen-clinic" name="clinic" type="text" placeholder="Opcional" />
        </div>
      </div>

      <OpSubmitButton pending={pending}>{submitLabel}</OpSubmitButton>
    </form>
  );
}
