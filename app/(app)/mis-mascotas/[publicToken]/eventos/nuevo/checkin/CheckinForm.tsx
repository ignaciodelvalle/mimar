"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import type { CheckinFormState } from "@/app/actions/checkin";
import { Icon } from "@/components/Icon";
import { LocationFields } from "@/components/LocationFields";
import { LnField, LnTextarea } from "@/components/ui/Field";
import { LnSheetAccordion, LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { formIsSilentlyValid } from "@/lib/ui/silent-form-validity";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { AttachmentField } from "../AttachmentField";

const initialState: CheckinFormState = { error: null };
type FormAction = (prev: CheckinFormState, formData: FormData) => Promise<CheckinFormState>;
const FORM_ID = "checkin-form";

export function CheckinForm({
  action,
  defaults,
  autoConfirm,
  windowDueLabel,
}: {
  action: FormAction;
  defaults?: { notes: string | null };
  /**
   * Formatted due date of the OPEN reminder window this submission answers.
   * Check-ins are milestone-based (30d/90d/…): submitting one closes only the
   * soonest window, so re-opening the page legitimately shows the form again
   * for the NEXT window. Without naming the window, that read as "my submit
   * didn't register" (9-role external run, 2026-08-18) — the date changing is
   * the visible proof the previous one was consumed.
   */
  windowDueLabel?: string;
  /**
   * Notification quick-reply autoconfirm (capture-console surface #4) — see
   * VaccinationForm's autoConfirm doc for the full contract. CheckinForm has
   * no `required` inputs, so `checkValidity()` is trivially true whenever the
   * page reached this form at all (i.e. an open reminder exists — the page
   * itself 404s/redirects otherwise). Still routed through the same guard
   * for consistency and in case a future required field is added here.
   */
  autoConfirm?: boolean;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  // Nav contract N3 — the use-case returns redirectTo instead of calling
  // redirect(); this performs the full document navigation.
  const isNavigating = useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const { key: idempotencyKey } = useIdempotencyKey();
  const formRef = useRef<HTMLFormElement>(null);
  // forms/react19-reset-data-loss-inventory: was uncontrolled
  // (`defaultValue={defaults?.notes ?? ""}`, a STATIC prop) — a rejected
  // submit wiped whatever the person had typed. Only field on this form, so
  // lifting it to local React state (a controlled textarea survives the
  // React 19 post-action reset on its own) is simpler than wiring the whole
  // useKeptFields hook for one field.
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  const autoConfirmSubmitted = useRef(false);
  useEffect(() => {
    if (!autoConfirm || autoConfirmSubmitted.current) return;
    autoConfirmSubmitted.current = true;
    const form = formRef.current;
    // Silent check, NOT checkValidity() — see VaccinationForm's autoconfirm
    // effect: firing `invalid` from a mount effect now scrolls the viewport.
    if (form && formIsSilentlyValid(form)) {
      form.requestSubmit();
    }
  }, [autoConfirm]);

  return (
    <>
      <LnSheetHeader
        tone="azul"
        icon={<Icon name="checkin" decorative />}
        title="Check-in"
        subtitle={
          windowDueLabel
            ? `Ventana de seguimiento que vence el ${windowDueLabel}`
            : "Libreta sanitaria oficial"
        }
      />
      <LnSheetBody>
        <form id={FORM_ID} ref={formRef} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <LnField label="¿Cómo está?">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={5}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Salud, ánimo, adaptación al hogar… lo que el refugio querría saber."
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnSheetAccordion num="+" title="Ubicación">
            <LocationFields mode="l1" cascade />
          </LnSheetAccordion>
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
        tone="azul"
        ctaLabel="Enviar check-in"
        formId={FORM_ID}
        isPending={isPending || isNavigating}
      />
    </>
  );
}
