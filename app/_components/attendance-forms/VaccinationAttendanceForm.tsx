"use client";

// Vaccination attendance form.
// Maps to the vaccination_administered event payload schema in lib/event-schemas.ts.

import { useState, useTransition } from "react";

import type { AttendanceResult, VaccinationPayload } from "@/app/actions/attendance";
import {
  OpFieldHint,
  OpFieldLabel,
  OpFormAlert,
  OpInput,
  OpSubmitButton,
} from "@/components/ui/dashboard";

type Props = {
  appointmentToken: string;
  onSubmit: (payload: { kind: "vaccination" } & VaccinationPayload) => Promise<AttendanceResult>;
  onSuccess?: () => void;
  submitLabel?: string;
};

export function VaccinationAttendanceForm({
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
      kind: "vaccination" as const,
      vaccine_name: String(data.get("vaccine_name") ?? "").trim(),
      brand: String(data.get("brand") ?? "").trim() || null,
      batch: String(data.get("batch") ?? "").trim() || null,
      administered_by: String(data.get("administered_by") ?? "").trim() || null,
      next_due_at: String(data.get("next_due_at") ?? "").trim() || null,
    };

    if (!payload.vaccine_name) {
      setError("El nombre de la vacuna es obligatorio.");
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
        <OpFieldLabel htmlFor="vacc-vaccine_name">
          Nombre de la vacuna <span className="text-ln-op-danger">*</span>
        </OpFieldLabel>
        <OpInput
          id="vacc-vaccine_name"
          name="vaccine_name"
          type="text"
          required
          placeholder="Ej: Antirrábica"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <OpFieldLabel htmlFor="vacc-brand">Marca / laboratorio</OpFieldLabel>
          <OpInput id="vacc-brand" name="brand" type="text" placeholder="Opcional" />
        </div>
        <div>
          <OpFieldLabel htmlFor="vacc-batch">Lote / número de batch</OpFieldLabel>
          <OpInput id="vacc-batch" name="batch" type="text" placeholder="Opcional" />
        </div>
      </div>

      <div>
        <OpFieldLabel htmlFor="vacc-administered_by">Administrado por</OpFieldLabel>
        <OpInput
          id="vacc-administered_by"
          name="administered_by"
          type="text"
          placeholder="Nombre del profesional (opcional)"
        />
      </div>

      <div>
        <OpFieldLabel htmlFor="vacc-next_due_at">Próxima dosis (fecha)</OpFieldLabel>
        <OpInput id="vacc-next_due_at" name="next_due_at" type="date" />
        <OpFieldHint>Si se completa, se crea un recordatorio automático para el dueño.</OpFieldHint>
      </div>

      <OpSubmitButton pending={pending}>{submitLabel}</OpSubmitButton>
    </form>
  );
}
