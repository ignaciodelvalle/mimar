"use client";

// "Para llevar": one checkbox per paper (PO 2026-10-01; v14 "Viaje en pasos",
// design pin 22). Each paper of the trip's papers-to-carry obligation gets its
// own small form posting to confirmTripDocumentAction — the use-case
// `POST /api/v1/pets/{publicToken}/travel` `confirm_trip_document` runs too.
// The obligation stays a warning until every paper is ticked.
//
// v14: a CHECKBOX, not a wide "Lo tengo" button. Same command, same idempotency
// key per (trip, paper, direction), same words. Only papers reach this list
// since `required_documents` lists papers only (QA 2026-10-07, copy 2): a
// microchip the libreta says is missing can no longer be ticked here.
//
// The words record what the OWNER said ("Lo tenés, según indicaste"), never
// that the paper is valid: miMAR cannot see it.
//
// Each form carries hidden fields only plus the box, which shows the SERVER's
// state (`document.confirmed`) and submits on change; the page reloads as a
// full document after a tick (N3 contract), which mints new keys. A failed
// tick puts the box back and says why.
//
// NOT `useActionState` + `<form action={fn}>` (bug found live on staging,
// 2026-10-01): every sibling row here binds the IDENTICAL server action
// reference (`confirmTripDocumentAction.bind(null, publicToken)`, shared by
// the whole checklist). With 2+ rows mounted, the declarative form-action
// path writes correctly server-side (confirmed via the DB and a manual
// reload) but the client never processes its OWN `redirectTo` back — no
// navigation, no error, no console message, forever. Same cure as
// DenunciaWizard / ResetCodeStep: call the action directly and navigate with
// the imperative `useActionNavigate`.

import { type FormEvent, useRef, useState } from "react";

import { LnCheckbox } from "@/components/ui/Field";
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
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  // What the box shows while the tick is in flight; the server's word otherwise.
  const [shown, setShown] = useState(document.confirmed);
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
        setShown(document.confirmed);
        setIsPending(false);
      } else if (result.redirectTo) {
        navigate(result.redirectTo);
      } else {
        setIsPending(false);
      }
    } catch {
      setError("No pudimos guardar la confirmación. Intentá de nuevo.");
      setShown(document.confirmed);
      setIsPending(false);
    }
  }

  return (
    <li className="flex flex-col gap-1 px-3.5 py-3">
      <form ref={formRef} onSubmit={handleSubmit} aria-busy={busy || undefined}>
        <input type="hidden" name="tripEventId" value={tripEventId} />
        <input type="hidden" name="document" value={document.label} />
        <input type="hidden" name="confirmed" value={document.confirmed ? "false" : "true"} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <LnCheckbox
          key={`${document.label}-${shown}`}
          defaultChecked={shown}
          onChange={(e) => {
            setShown(e.currentTarget.checked);
            formRef.current?.requestSubmit();
          }}
          disabled={busy}
          className="h-6 w-6"
        >
          <span className="flex flex-col">
            <span className="text-sm">{document.label}</span>
            <span className="text-xs text-[var(--color-ln-mute)]">
              {document.confirmed ? DOCUMENT_CONFIRMED_LINE : DOCUMENT_PENDING_LINE}
            </span>
          </span>
        </LnCheckbox>
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
    <ul
      className="flex flex-col divide-y divide-[var(--color-ln-line-2)]"
      aria-label="Documentos del viaje"
    >
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
