"use client";

// Confirm a govt user's grants onto this authority unit (localidades-por-id
// D2, the partial-grant confirm flow).
//
// Moving a grant onto a unit changes what the operator sees and is paged for,
// so a person decides it, with a reason. When the unit governs localities the
// grants do not, each one is listed with its own checkbox and ALL must be
// marked: nothing is widened without being named. The server re-checks the
// exact set (confirmGrantUnit), so a stale page cannot widen either.

import { useState } from "react";

import { confirmGrantUnitAction } from "@/app/actions/authority-units";
import { OpButton, OpCheckbox, OpField, OpFormAlert, OpTextarea } from "@/components/ui/dashboard";

import { useUnitAction } from "./UnitEditorForms";

export type GrantUnitFormProps = {
  unitId: string;
  userId: string;
  displayName: string;
  grants: Array<{ assignmentId: string; locality: string }>;
  added: Array<{ localityId: string; name: string }>;
};

export function GrantUnitForm({ unitId, userId, displayName, grants, added }: GrantUnitFormProps) {
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  const { error, pending, run } = useUnitAction();
  const allAccepted = added.every((a) => accepted.has(a.localityId));
  const canSubmit = reason.trim() !== "" && allAccepted && !pending;

  function toggle(localityId: string, on: boolean) {
    setAccepted((prev) => {
      const next = new Set(prev);
      if (on) next.add(localityId);
      else next.delete(localityId);
      return next;
    });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        run(
          () =>
            confirmGrantUnitAction({
              userId,
              unitId,
              reason,
              acceptAdded: added.map((a) => a.localityId),
            }),
          () => `/admin/localidades/${unitId}`,
        );
      }}
    >
      <p className="m-0 text-sm text-ln-op-ink">
        <strong>{displayName}</strong> tiene hoy:{" "}
        {grants.map((g) => g.locality || "toda la provincia").join(", ")}.
      </p>
      {added.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm text-ln-op-mute">
            La unidad suma estas localidades a su concesión. Marcá cada una para confirmarlo:
          </legend>
          {added.map((a) => (
            <OpCheckbox
              key={a.localityId}
              checked={accepted.has(a.localityId)}
              onChange={(e) => toggle(a.localityId, e.target.checked)}
            >
              {a.name}
            </OpCheckbox>
          ))}
        </fieldset>
      )}
      <OpField label="Motivo" required>
        {({ id, describedBy }) => (
          <OpTextarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </OpField>
      {error && <OpFormAlert>{error}</OpFormAlert>}
      <OpButton type="submit" disabled={!canSubmit} loading={pending}>
        Pasar la concesión a esta unidad
      </OpButton>
    </form>
  );
}
