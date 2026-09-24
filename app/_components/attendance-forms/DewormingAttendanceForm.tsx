"use client";

// Deworming attendance form.
// Maps to the deworming_administered event payload schema in lib/event-schemas.ts.

import { useState, useTransition } from "react";

import type { AttendanceResult, DewormingPayload } from "@/app/actions/attendance";
import {
  OpFieldLabel,
  OpFormAlert,
  OpInput,
  OpSelect,
  OpSubmitButton,
} from "@/components/ui/dashboard";

type Props = {
  appointmentToken: string;
  onSubmit: (payload: { kind: "deworming" } & DewormingPayload) => Promise<AttendanceResult>;
  onSuccess?: () => void;
  submitLabel?: string;
};

export function DewormingAttendanceForm({
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

    const type = String(data.get("type") ?? "internal") as "internal" | "external" | "both";
    const payload = {
      kind: "deworming" as const,
      product: String(data.get("product") ?? "").trim(),
      type,
      next_due_at: String(data.get("next_due_at") ?? "").trim() || null,
    };

    if (!payload.product) {
      setError("El nombre del producto es obligatorio.");
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
        <OpFieldLabel htmlFor="dew-product">
          Producto / antiparasitario <span className="text-ln-op-danger">*</span>
        </OpFieldLabel>
        <OpInput
          id="dew-product"
          name="product"
          type="text"
          required
          placeholder="Ej: Nexgard, Milbemax"
        />
      </div>

      <div>
        <OpFieldLabel htmlFor="dew-type">Tipo de desparasitación</OpFieldLabel>
        <OpSelect id="dew-type" name="type" defaultValue="internal">
          <option value="internal">Interna</option>
          <option value="external">Externa</option>
          <option value="both">Ambas</option>
        </OpSelect>
      </div>

      <div>
        <OpFieldLabel htmlFor="dew-next_due_at">Próxima dosis (fecha)</OpFieldLabel>
        <OpInput id="dew-next_due_at" name="next_due_at" type="date" />
      </div>

      <OpSubmitButton pending={pending}>{submitLabel}</OpSubmitButton>
    </form>
  );
}
