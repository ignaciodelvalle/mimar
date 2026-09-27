"use client";

// The platform admin's reversals on one authority unit (jurisdiction-admin
// Phase 6.4): send a confirmed unit back to draft, and take a funcionario's
// grants off the unit. Platform-only by design — they live here, under
// /admin, and never among the shared components/institutional forms a
// jurisdiction admin's pages render. Their actions keep requireAdminOrRedirect
// and their writers keep requirePlatformAdmin.
//
// Both ask for a reason (it lands in audit_log with who and when) and both
// warn, before they are made, whom they reach.

import { useState } from "react";

import {
  unconfirmAuthorityUnitAction,
  unconfirmGrantUnitAction,
} from "@/app/actions/authority-unit-reversals";
import { useUnitAction } from "@/components/institutional/UnitEditorForms";
import { OpButton, OpField, OpFormAlert, OpInput } from "@/components/ui/dashboard";

const UNITS_BASE = "/admin/localidades";

/** "Volver a borrador": the unit stops governing until it is confirmed again. */
export function UnconfirmUnitForm({
  unitId,
  pinnedHolders,
}: {
  unitId: string;
  /** Who holds grants pinned to this unit: they stop covering its localities. */
  pinnedHolders: string[];
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { error, pending, run } = useUnitAction();
  const canSubmit = reason.trim() !== "" && !pending;

  if (!open) {
    return (
      <OpButton type="button" variant="ghost" onClick={() => setOpen(true)}>
        Volver a borrador
      </OpButton>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () => unconfirmAuthorityUnitAction({ unitId, reason }),
          () => `${UNITS_BASE}/${unitId}`,
        );
      }}
    >
      <p className="text-sm text-ln-op-ink-2">
        Una unidad en borrador no gobierna ninguna localidad.{" "}
        {pinnedHolders.length > 0
          ? `Las concesiones pasadas a esta unidad dejan de cubrir sus localidades hasta que se confirme de nuevo: ${pinnedHolders.join(", ")}.`
          : "Ninguna concesión de gobierno está pasada a esta unidad."}
      </p>
      <OpField label="Motivo para volver a borrador" required>
        {({ id }) => (
          <OpInput
            id={id}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <div className="flex gap-2">
        <OpButton type="submit" variant="danger" disabled={!canSubmit} loading={pending}>
          Volver a borrador
        </OpButton>
        <OpButton type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </OpButton>
      </div>
    </form>
  );
}

/** Take one funcionario's grants off this unit (back to covering by name). */
export function UnconfirmGrantForm({
  unitId,
  userId,
  displayName,
}: {
  unitId: string;
  userId: string;
  displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { error, pending, run } = useUnitAction();
  const canSubmit = reason.trim() !== "" && !pending;

  if (!open) {
    return (
      <OpButton type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Sacar de la unidad
      </OpButton>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () => unconfirmGrantUnitAction({ unitId, userId, reason }),
          () => `${UNITS_BASE}/${unitId}`,
        );
      }}
    >
      <OpField label={`Motivo para sacar de la unidad la concesión de ${displayName}`} required>
        {({ id }) => (
          <OpInput
            id={id}
            size="sm"
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <div className="flex gap-2">
        <OpButton type="submit" variant="danger" size="sm" disabled={!canSubmit} loading={pending}>
          Sacar de la unidad
        </OpButton>
        <OpButton type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </OpButton>
      </div>
    </form>
  );
}
