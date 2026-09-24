"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnRadio, LnTextarea } from "@/components/ui/Field";
import { MutationErrorCard } from "@/components/ui/MutationErrorCard";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { useRetryableAction } from "@/lib/ui/use-retryable-action";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "deworming-form";

export function DewormingForm({
  action,
  defaults,
}: {
  action: FormAction;
  defaults?: { product: string | null; occurredAt: string | null; notes: string | null };
}) {
  const { key: idempotencyKey } = useIdempotencyKey();
  // degraded-states: a rejected dispatch (503/abort) becomes a recoverable
  // `transientFailure` state instead of an error-boundary unmount. Retry
  // replays the same form — same hidden clientIdempotencyKey — so the server
  // dedupe resolves a persisted write as confirmation, not a duplicate.
  // forms/react19-reset-data-loss-inventory: "type" is an uncontrolled radio
  // group with no defaultChecked at all — a rejected submit leaves every
  // option unticked, discarding whichever type was picked.
  const { boundAction: keptAction, keptChecked } = useKeptFields<EventFormState>(action);
  // useKeptFields's boundAction is typed S | Promise<S> (matches useActionState's
  // own action type); useRetryableAction requires strictly Promise<S>. This
  // async wrapper's return type is always a Promise, which satisfies it.
  const retryableAction = useRetryableAction(
    async (prev: EventFormState, formData: FormData) => keptAction(prev, formData),
    { idempotencyKey },
  );
  const [state, formAction, isPending] = useActionState(retryableAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const today = todayIsoInAr();

  // Controlled field state — preserves typed input on validation error.
  const [product, setProduct] = useState(defaults?.product ?? "");
  const [occurredAt, setOccurredAt] = useState(defaults?.occurredAt ?? today);
  const [nextDueAt, setNextDueAt] = useState("");
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  const formRef = useRef<HTMLFormElement>(null);

  // P4 item 4 — SUSPICIOUS same-day duplicate warn (non-blocking). Mirrors
  // VaccinationForm.tsx / the P2 soft-dedupe pattern in MinimalNewPetForm.tsx.
  const [overrideSameDay, setOverrideSameDay] = useState(false);
  const resubmitAfterOverride = useRef(false);

  useEffect(() => {
    if (overrideSameDay && resubmitAfterOverride.current) {
      resubmitAfterOverride.current = false;
      formRef.current?.requestSubmit();
    }
  }, [overrideSameDay]);

  function confirmSameDay() {
    resubmitAfterOverride.current = true;
    setOverrideSameDay(true);
  }

  const sameDayPrompt = !overrideSameDay ? state.sameDayPrompt : undefined;

  return (
    <>
      <LnSheetHeader
        tone="verde"
        icon={<Icon name="medicacion" decorative />}
        title="Registrar antiparasitario"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} ref={formRef} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="sameDayOverride" value={overrideSameDay ? "1" : "0"} />
          <LnField label="Producto" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="product"
                type="text"
                required
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder="Frontline, Advocate, Milbemax…"
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <div className="flex flex-col gap-1.5">
            <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
              Tipo{" "}
              <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
                *
              </span>
            </p>
            <div className="flex flex-col gap-1.5">
              <LnRadio
                name="type"
                value="internal"
                defaultChecked={keptChecked("type", false, "internal")}
                required
              >
                Interno
              </LnRadio>
              <LnRadio
                name="type"
                value="external"
                defaultChecked={keptChecked("type", false, "external")}
              >
                Externo
              </LnRadio>
              <LnRadio name="type" value="both" defaultChecked={keptChecked("type", false, "both")}>
                Ambos
              </LnRadio>
            </div>
          </div>
          <LnField label="Fecha de aplicación" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="occurredAt"
                type="date"
                required
                mono
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Próxima dosis" hint="Opcional — crea un recordatorio automático.">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="nextDueAt"
                type="date"
                mono
                value={nextDueAt}
                onChange={(e) => setNextDueAt(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Notas">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <AttachmentField />
          {state.error && !state.transientFailure && (
            <p
              ref={errorRef}
              className="font-ln-mono text-sm text-[var(--color-ln-err)]"
              role="alert"
              tabIndex={-1}
            >
              {state.error}
            </p>
          )}

          {/* degraded-states: recoverable transport failure — the card owns the
              cause line (the plain error <p> above is gated off to avoid saying
              it twice) and replays this same form with the same key. */}
          <MutationErrorCard
            transientFailure={state.transientFailure}
            error={state.error}
            formRef={formRef}
          />

          {sameDayPrompt && (
            <LnCallout tone="warn" title="¿Registrar de nuevo?">
              <p className="m-0" role="alert">
                {sameDayPrompt.message}
              </p>
            </LnCallout>
          )}
        </form>
      </LnSheetBody>
      <LnSheetFooter
        tone="verde"
        ctaLabel="Registrar antiparasitario"
        formId={FORM_ID}
        isPending={isPending}
        customCta={
          sameDayPrompt ? (
            <button
              type="button"
              onClick={confirmSameDay}
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 active:scale-[0.98] active:opacity-90"
            >
              Sí, registrar otro igual
            </button>
          ) : undefined
        }
      />
    </>
  );
}
