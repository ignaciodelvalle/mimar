"use client";

// Microchip-implantation attendance form.
// Maps to the microchip_implanted event payload schema in lib/event-schemas.ts
// (chip_number, country_code, implanted_by, location_on_body). The writer
// (markAppointmentAttendedWriter) also performs the canonical
// pet_identifications dual-write for this kind.

import { useState, useTransition } from "react";

import type { AttendanceResult, MicrochipPayload } from "@/app/actions/attendance";
import {
  OpFieldLabel,
  OpFormAlert,
  OpInput,
  OpSelect,
  OpSubmitButton,
} from "@/components/ui/dashboard";

type Props = {
  appointmentToken: string;
  onSubmit: (payload: { kind: "microchip" } & MicrochipPayload) => Promise<AttendanceResult>;
  onSuccess?: () => void;
  submitLabel?: string;
};

// ISO 3166 numeric country code for Argentina — the default for chips
// implanted locally (matches the createMicrochip flow default).
// NOTE: 858 is Uruguay's code, not Argentina's (Argentina = 032) — was
// mislabeled here; fixed as part of the QA nits sweep 2026-07.
const DEFAULT_COUNTRY_CODE = "032";

// Implantation-site options mirror chipImplantSiteFromLocation's recognized
// inputs (src/modules/pets/domain/pet-rules.ts) so the canonical row maps to a
// known enum value.
const LOCATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Sin especificar" },
  { value: "interscapular", label: "Interescapular (entre los omóplatos)" },
  { value: "neck_left", label: "Lateral cuello izquierdo" },
  { value: "neck_right", label: "Lateral cuello derecho" },
];

export function MicrochipAttendanceForm({
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

    const chipNumber = String(data.get("chip_number") ?? "").trim();
    const payload = {
      kind: "microchip" as const,
      chip_number: chipNumber,
      country_code: String(data.get("country_code") ?? "").trim() || null,
      implanted_by: String(data.get("implanted_by") ?? "").trim() || null,
      location_on_body: String(data.get("location_on_body") ?? "").trim() || null,
    };

    if (!payload.chip_number) {
      setError("El número de microchip es obligatorio.");
      return;
    }
    if (!/^\d{15}$/.test(payload.chip_number)) {
      setError("El microchip debe tener exactamente 15 dígitos.");
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
        <OpFieldLabel htmlFor="chip-chip_number">
          Número de microchip <span className="text-ln-op-danger">*</span>
        </OpFieldLabel>
        <OpInput
          id="chip-chip_number"
          name="chip_number"
          type="text"
          required
          inputMode="numeric"
          pattern="\d{15}"
          maxLength={15}
          placeholder="15 dígitos ISO 11784/11785"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <OpFieldLabel htmlFor="chip-country_code">Código de país (ISO)</OpFieldLabel>
          <OpInput
            id="chip-country_code"
            name="country_code"
            type="text"
            defaultValue={DEFAULT_COUNTRY_CODE}
            placeholder="032 (Argentina)"
          />
        </div>
        <div>
          <OpFieldLabel htmlFor="chip-location_on_body">Ubicación de implante</OpFieldLabel>
          <OpSelect id="chip-location_on_body" name="location_on_body" defaultValue="">
            {LOCATION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </OpSelect>
        </div>
      </div>

      <div>
        <OpFieldLabel htmlFor="chip-implanted_by">Implantado por</OpFieldLabel>
        <OpInput
          id="chip-implanted_by"
          name="implanted_by"
          type="text"
          placeholder="Nombre del profesional (opcional)"
        />
      </div>

      <OpSubmitButton pending={pending}>{submitLabel}</OpSubmitButton>
    </form>
  );
}
