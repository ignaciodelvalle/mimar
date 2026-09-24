"use client";

import { LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { type AssignFosterFormState, assignFosterAction } from "@/src/modules/foster/actions";
import { useActionState, useState } from "react";

const initialState: AssignFosterFormState = { error: null };

export type FosterCandidate = {
  userId: string;
  displayName: string;
  role: string;
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  coordinator: "Coordinador/a",
  member: "Miembro",
  volunteer: "Voluntario/a",
  foster: "Tránsito",
  vet_individual: "Veterinario/a",
};

export function AssignFosterForm({
  orgToken,
  publicToken,
  candidates,
}: {
  orgToken: string;
  publicToken: string;
  candidates: FosterCandidate[];
}) {
  const action = assignFosterAction.bind(null, orgToken, publicToken);
  // forms/react19-reset-data-loss-inventory: "fosterUserId" is an
  // uncontrolled <select> — a rejected submit falls it back to its first
  // (disabled) option, discarding whichever volunteer was picked.
  const { boundAction, kept } = useKeptFields<AssignFosterFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns where to go and this navigates. It used to
  // redirect() server-side, a transition the App Router drops in production —
  // the write committed and the screen never moved.
  useActionRedirect(state.redirectTo, state);

  // Controlled field state — preserves typed input on validation error.
  const [expectedWeeks, setExpectedWeeks] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <form action={formAction} className="space-y-4">
      <LnField
        label="Voluntario/a"
        required
        hint={
          candidates.length === 0 ? "No hay miembros activos disponibles para tránsito." : undefined
        }
      >
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            name="fosterUserId"
            key={`fosterUserId-${kept("fosterUserId")}`}
            required
            defaultValue={kept("fosterUserId")}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            <option value="" disabled>
              Elegir miembro activo
            </option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.displayName} ({ROLE_LABELS[c.role] ?? c.role})
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      <LnField label="Semanas estimadas">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="expectedWeeks"
            type="number"
            min={0}
            max={104}
            placeholder="Opcional"
            value={expectedWeeks}
            onChange={(e) => setExpectedWeeks(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Notas para el tránsito">
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="notes"
            rows={3}
            maxLength={500}
            placeholder="Medicación, dieta especial, comportamientos a tener en cuenta…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.error && (
        <p className="text-sm rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-ln-op-danger">
          {state.error}
        </p>
      )}

      <OpButton type="submit" disabled={isPending || candidates.length === 0}>
        {isPending ? "Asignando…" : "Asignar tránsito"}
      </OpButton>
    </form>
  );
}
