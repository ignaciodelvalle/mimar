"use client";

// OwnerInitiateReturnForm — owner proposes returning a pet to the originating org.
//
// Rendered when there is no pending custody_transfer_proposed and the pet was
// received via adoption (adoption_finalized event exists pointing to a source org).
//
// Fields (per design spec §5.5):
//   - razon   — select from custodyTransferReason values (Spanish labels)
//   - notas   — optional textarea
//   - fecha   — date input, default today
//
// On success → success banner; owner can navigate away.

import {
  type OwnerProposeReturnToOrgFormState,
  ownerProposeReturnToOrgFormAction,
} from "@/app/actions/return-to-owner-form";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import Link from "next/link";
import { useActionState, useState } from "react";

const RETURN_REASONS: Array<{ value: string; label: string }> = [
  { value: "post_adoption_failed_return", label: "Cambio de circunstancias / no me pude adaptar" },
  { value: "space_constraint", label: "Limitaciones de espacio o vivienda" },
  { value: "specialization_needed", label: "Necesita cuidados especiales que no puedo dar" },
  { value: "other", label: "Otro motivo" },
];

const initialState: OwnerProposeReturnToOrgFormState = { error: null };

function todayIso(): string {
  return todayIsoInAr();
}

export function OwnerInitiateReturnForm({
  petPublicToken,
  petName,
  orgDisplayName,
  backUrl,
}: {
  petPublicToken: string;
  petName: string;
  orgDisplayName: string;
  backUrl: string;
}) {
  const bound = ownerProposeReturnToOrgFormAction.bind(null, petPublicToken);
  // forms/react19-reset-data-loss-inventory: "reason" is an uncontrolled
  // <select> — a rejected submit falls it back to its first (disabled)
  // option, discarding the reason the owner picked.
  const { boundAction, kept } = useKeptFields<OwnerProposeReturnToOrgFormState>(bound);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);

  // Controlled field state — preserves typed input on validation error.
  const [notes, setNotes] = useState("");
  const [proposedAt, setProposedAt] = useState(todayIso());

  if (state.success) {
    return (
      <div
        className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] p-5 space-y-[10px]"
        role="alert"
      >
        <p className="font-ln-serif text-base font-semibold text-[var(--color-ln-ok)]">
          Devolución iniciada
        </p>
        <p className="text-md text-[var(--color-ln-ink-2)]">
          Tu propuesta fue enviada a <strong>{orgDisplayName}</strong>. El refugio la va a revisar y
          se va a poner en contacto con vos para coordinar la entrega.
        </p>
        <Link
          href={backUrl}
          className="inline-block text-sm text-[var(--color-ln-ok)] underline hover:opacity-80"
        >
          Ir a mis mascotas
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-[20px]">
      {/* Reason select */}
      <div className="flex flex-col">
        <label
          htmlFor="reason"
          className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
        >
          Razón de la devolución <span className="text-[var(--color-ln-seal)]">*</span>
        </label>
        <select
          id="reason"
          name="reason"
          key={`reason-${kept("reason")}`}
          required
          defaultValue={kept("reason")}
          className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-2.5 py-2 font-ln-sans text-md text-[var(--color-ln-ink)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)] appearance-none"
        >
          <option value="" disabled>
            Elegí un motivo…
          </option>
          {RETURN_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {/* Notes textarea */}
      <div className="flex flex-col">
        <label
          htmlFor="notes"
          className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
        >
          Notas{" "}
          <span className="font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
            opcional
          </span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={4}
          maxLength={1000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Contale al refugio detalles sobre la situación, el estado de la mascota, disponibilidad horaria…"
          className="resize-y rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-2.5 py-2 font-ln-sans text-md text-[var(--color-ln-ink)] placeholder:text-[var(--color-ln-faint)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
        />
      </div>

      {/* Proposed date */}
      <div className="flex flex-col">
        <label
          htmlFor="proposedAt"
          className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
        >
          Fecha sugerida para la entrega
        </label>
        <input
          id="proposedAt"
          name="proposedAt"
          type="date"
          value={proposedAt}
          onChange={(e) => setProposedAt(e.target.value)}
          className="w-[200px] rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-2.5 py-2 font-ln-mono text-md text-[var(--color-ln-ink)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
        />
      </div>

      {/* Error */}
      {state.error && (
        <p
          role="alert"
          className="rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] px-3 py-2 text-md text-[var(--color-ln-seal)]"
        >
          {state.error}
        </p>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-[var(--radius-pill)] bg-[var(--color-ln-seal)] px-4 py-2.5 font-ln-sans text-md font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {isPending ? "Enviando…" : `Confirmar devolución de ${petName}`}
      </button>

      <p className="text-sm text-[var(--color-ln-faint)]">
        El refugio recibe una notificación y coordina con vos la entrega. La custodia sigue en tus
        manos hasta que ellos acepten.
      </p>
    </form>
  );
}
