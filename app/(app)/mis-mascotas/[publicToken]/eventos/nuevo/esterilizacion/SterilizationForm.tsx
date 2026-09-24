"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnRadio, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "sterilization-form";

export function SterilizationForm({
  action,
  defaults,
}: {
  action: FormAction;
  defaults?: {
    occurredAt: string | null;
    notes: string | null;
    /** Preselects the procedure radio the confirm link already names — the
     * atender card's summary displays the same value, so this discloses
     * nothing; the radio stays editable. Owner-flow callers omit it. */
    procedure?: string | null;
  };
}) {
  // forms/react19-reset-data-loss-inventory: "procedure" is an uncontrolled
  // radio group with a STATIC defaultChecked derived from `defaults` — a
  // rejected submit puts back the ORIGINAL default, discarding whichever
  // procedure was actually picked.
  const { boundAction, keptChecked } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();

  // Controlled field state — preserves typed input on validation error.
  const [occurredAt, setOccurredAt] = useState(defaults?.occurredAt ?? today);
  const [performedBy, setPerformedBy] = useState("");
  const [clinic, setClinic] = useState("");
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  return (
    <>
      <LnSheetHeader
        tone="rosa"
        icon={<Icon name="esterilizacion" decorative />}
        title="Registrar esterilización"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <div className="flex flex-col gap-1.5">
            <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
              Procedimiento{" "}
              <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
                *
              </span>
            </p>
            <div className="flex flex-col gap-1.5">
              <LnRadio
                name="procedure"
                value="castration"
                required
                defaultChecked={keptChecked(
                  "procedure",
                  defaults?.procedure === "castration",
                  "castration",
                )}
              >
                Castración
              </LnRadio>
              <LnRadio
                name="procedure"
                value="spay"
                defaultChecked={keptChecked("procedure", defaults?.procedure === "spay", "spay")}
              >
                Ovariectomía
              </LnRadio>
            </div>
          </div>
          <LnField label="Fecha de la cirugía" required>
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
          <LnField label="Realizada por (veterinario/a)">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="performedBy"
                type="text"
                value={performedBy}
                onChange={(e) => setPerformedBy(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Clínica">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="clinic"
                type="text"
                value={clinic}
                onChange={(e) => setClinic(e.target.value)}
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
          {state.error && (
            <p
              ref={errorRef}
              className="font-ln-mono text-sm text-[var(--color-ln-err)]"
              role="alert"
              tabIndex={-1}
            >
              {state.error}
            </p>
          )}
        </form>
      </LnSheetBody>
      <LnSheetFooter
        tone="rosa"
        ctaLabel="Registrar esterilización"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
