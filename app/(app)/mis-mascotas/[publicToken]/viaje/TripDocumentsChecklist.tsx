"use client";

// "Lo tengo" per paper (PO 2026-10-01). Each document of the trip's
// papers-to-carry obligation gets its own small form posting to
// confirmTripDocumentAction — the use-case `POST /api/v1/pets/{publicToken}/
// travel` `confirm_trip_document` runs too. The obligation stays a warning
// until every document is ticked.
//
// The words record what the OWNER said ("Lo tenés, según indicaste"), never
// that the paper is valid: miMAR cannot see it.
//
// Each form carries hidden fields only, so a React 19 reset has nothing to lose,
// and its own idempotency key minted by the page on every render; the page
// reloads as a full document after a tick (N3 contract), which mints new ones.
//
// NOT `useActionState` + `<form action={fn}>` (bug found live on staging,
// 2026-10-01): every sibling row here binds the IDENTICAL server action
// reference (`confirmTripDocumentAction.bind(null, publicToken)`, shared by
// the whole checklist). With 2+ rows mounted, the declarative form-action
// path writes correctly server-side (confirmed via the DB and a manual
// reload) but the client never processes its OWN `redirectTo` back — no
// navigation, no error, no console message, forever. A single-instance form
// (CancelTripButton, CviForm, TripForm) never hits this; this is the first
// form on /viaje that repeats with a shared action reference. Same cure as
// DenunciaWizard / ResetCodeStep: call the action directly and navigate with
// the imperative `useActionNavigate`, which sidesteps `useActionState`
// entirely instead of fighting whatever Next 15.5.x does with it here.

import { type FormEvent, useState } from "react";

import { LnButton } from "@/components/ui/Button";
import type { TravelDocumentItem } from "@/lib/projections/travel-compliance";
import { useActionNavigate } from "@/lib/ui/use-action-redirect";
import type { TravelFormState } from "@/src/modules/pets/application/travel/types";

const initialState: TravelFormState = { error: null };

type FormAction = (prev: TravelFormState, formData: FormData) => Promise<TravelFormState>;

export const DOCUMENT_CONFIRMED_LINE = "Lo tenés, según indicaste";
export const DOCUMENT_PENDING_LINE = "Sin confirmar";

function DocumentRow({
  action,
  tripEventId,
  document,
  idempotencyKey,
}: {
  action: FormAction;
  tripEventId: string;
  document: TravelDocumentItem;
  idempotencyKey: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  // Imperative half of nav contract N3 (lib/ui/use-action-redirect.ts) — same
  // helper DenunciaWizard and ResetCodeStep use to call a server action
  // directly instead of through `useActionState`. `navigating` never comes
  // back down: there is nothing to come back to once the document is leaving.
  const [navigate, navigating] = useActionNavigate();
  const busy = isPending || navigating;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsPending(true);
    const formData = new FormData(event.currentTarget);
    try {
      const result = await action(initialState, formData);
      if (result.error) {
        setError(result.error);
        setIsPending(false);
      } else if (result.redirectTo) {
        navigate(result.redirectTo);
      } else {
        setIsPending(false);
      }
    } catch {
      setError("No pudimos guardar la confirmación. Intentá de nuevo.");
      setIsPending(false);
    }
  }

  return (
    <li className="flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-2.5">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-center justify-between gap-2">
        <input type="hidden" name="tripEventId" value={tripEventId} />
        <input type="hidden" name="document" value={document.label} />
        <input type="hidden" name="confirmed" value={document.confirmed ? "false" : "true"} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <div className="flex flex-col">
          <span className="text-sm">{document.label}</span>
          <span className="text-xs text-[var(--color-ln-mute)]">
            {document.confirmed ? DOCUMENT_CONFIRMED_LINE : DOCUMENT_PENDING_LINE}
          </span>
        </div>
        <LnButton
          type="submit"
          variant={document.confirmed ? "ghost" : "seal"}
          size="sm"
          loading={busy}
        >
          {document.confirmed ? "Desmarcar" : "Lo tengo"}
        </LnButton>
      </form>
      {error && (
        <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function TripDocumentsChecklist({
  action,
  tripEventId,
  documents,
  idempotencyKeys,
}: {
  action: FormAction;
  tripEventId: string;
  documents: TravelDocumentItem[];
  /** One per document, in the same order. */
  idempotencyKeys: string[];
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5" aria-label="Documentos del viaje">
      {documents.map((document, i) => (
        <DocumentRow
          key={document.label}
          action={action}
          tripEventId={tripEventId}
          document={document}
          idempotencyKey={idempotencyKeys[i] ?? ""}
        />
      ))}
    </ul>
  );
}
