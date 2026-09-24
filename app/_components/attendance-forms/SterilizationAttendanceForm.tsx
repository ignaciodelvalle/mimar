"use client";

// Sterilization attendance form.
// Maps to the sterilization_performed event payload schema in lib/event-schemas.ts.

import { useState, useTransition } from "react";

import type { AttendanceResult, SterilizationPayload } from "@/app/actions/attendance";
import {
  OpFieldLabel,
  OpFormAlert,
  OpInput,
  OpSelect,
  OpSubmitButton,
} from "@/components/ui/dashboard";

type Props = {
  appointmentToken: string;
  onSubmit: (
    payload: { kind: "sterilization" } & SterilizationPayload,
  ) => Promise<AttendanceResult>;
  onSuccess?: () => void;
  submitLabel?: string;
};

export function SterilizationAttendanceForm({
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

    const procedure = String(data.get("procedure") ?? "castration") as "castration" | "spay";
    const payload = {
      kind: "sterilization" as const,
      procedure,
      performed_by: String(data.get("performed_by") ?? "").trim() || null,
      clinic: String(data.get("clinic") ?? "").trim() || null,
    };

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
        <OpFieldLabel htmlFor="ster-procedure">Procedimiento</OpFieldLabel>
        <OpSelect id="ster-procedure" name="procedure" defaultValue="castration">
          <option value="castration">Castración (macho)</option>
          <option value="spay">Ovariectomía / Castración (hembra)</option>
        </OpSelect>
      </div>

      <div>
        <OpFieldLabel htmlFor="ster-performed_by">Realizado por</OpFieldLabel>
        <OpInput
          id="ster-performed_by"
          name="performed_by"
          type="text"
          placeholder="Nombre del cirujano (opcional)"
        />
      </div>

      <div>
        <OpFieldLabel htmlFor="ster-clinic">Clínica / establecimiento</OpFieldLabel>
        <OpInput
          id="ster-clinic"
          name="clinic"
          type="text"
          placeholder="Nombre del lugar (opcional)"
        />
      </div>

      <OpSubmitButton pending={pending}>{submitLabel}</OpSubmitButton>
    </form>
  );
}
