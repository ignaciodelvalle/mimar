"use client";

// Resolve one queued place to a catalogue locality (localidades-por-id D9).
//
// The candidates are every live row of the province whose name matches what
// was entered, each labelled with its department; none is pre-selected (P1:
// the admin chooses, the system never does). A reason is required — it is
// what the place_resolutions row keeps next to who and when.

import { useState } from "react";

import { resolvePlaceFromQueueAction } from "@/app/actions/authority-units";
import { OpButton, OpField, OpFormAlert, OpSelect, OpTextarea } from "@/components/ui/dashboard";

import { useUnitAction } from "./UnitEditorForms";

export type ResolvePlaceFormProps = {
  subjectTable: "cases" | "welfare_reports";
  subjectId: string;
  provinceCode: string;
  candidates: Array<{ localityId: string; name: string; department: string | null }>;
};

export function ResolvePlaceForm({
  subjectTable,
  subjectId,
  provinceCode,
  candidates,
}: ResolvePlaceFormProps) {
  const [localityId, setLocalityId] = useState("");
  const [reason, setReason] = useState("");
  const { error, pending, run } = useUnitAction();
  const canSubmit = localityId !== "" && reason.trim() !== "" && !pending;

  if (candidates.length === 0) {
    return (
      <p className="m-0 text-sm text-ln-op-mute">
        Ninguna localidad del catálogo tiene ese nombre en la provincia. Queda en la provincia hasta
        que se corrija el lugar.
      </p>
    );
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () => resolvePlaceFromQueueAction({ subjectTable, subjectId, localityId, reason }),
          () => `/admin/localidades/pendientes?provincia=${provinceCode}`,
        );
      }}
    >
      <OpField label="Localidad">
        {({ id }) => (
          <OpSelect id={id} value={localityId} onChange={(e) => setLocalityId(e.target.value)}>
            <option value="">Elegí la localidad…</option>
            {candidates.map((c) => (
              <option key={c.localityId} value={c.localityId}>
                {c.name}
                {c.department ? ` (${c.department})` : ""}
              </option>
            ))}
          </OpSelect>
        )}
      </OpField>
      <OpField label="Motivo" required>
        {({ id, describedBy }) => (
          <OpTextarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <OpButton type="submit" disabled={!canSubmit} loading={pending}>
        Resolver el lugar
      </OpButton>
    </form>
  );
}
