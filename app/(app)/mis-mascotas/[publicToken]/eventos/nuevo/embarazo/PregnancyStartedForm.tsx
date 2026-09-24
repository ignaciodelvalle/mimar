"use client";

import { useActionState, useState } from "react";

import type { PregnancyFormState } from "@/app/actions/pregnancy";
import { Icon } from "@/components/Icon";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnRow, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { todayIsoInAr } from "@/lib/utils/format";

const initialState: PregnancyFormState = { error: null };
type FormAction = (prev: PregnancyFormState, formData: FormData) => Promise<PregnancyFormState>;
const FORM_ID = "pregnancy-started-form";

export function PregnancyStartedForm({ action }: { action: FormAction }) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  // N3: the action returns where to go and this navigates. It used to
  // redirect() server-side, a transition the App Router drops in production —
  // the write committed and the screen never moved.
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const today = todayIsoInAr();

  const [occurredAt, setOccurredAt] = useState(today);
  const [weeksAtDiagnosis, setWeeksAtDiagnosis] = useState("");
  const [vetConsulted, setVetConsulted] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <>
      <LnSheetHeader
        tone="rosa"
        icon={<Icon name="embarazo" decorative />}
        title="Registrar embarazo"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <LnCallout tone="warn">
            Esta acción dispara recordatorios automáticos de controles veterinarios cada dos
            semanas.
          </LnCallout>
          <LnField label="Fecha estimada de inicio" required>
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
          <LnRow>
            <LnField label="Semanas al diagnóstico" hint="Si tu vet te dio una estimación.">
              {({ id, describedBy, invalid }) => (
                // Wave 2 Item 9: inputMode="numeric" for whole-number weeks
                <LnInput
                  id={id}
                  name="weeksAtDiagnosis"
                  type="number"
                  min={0}
                  max={12}
                  inputMode="numeric"
                  enterKeyHint="next"
                  placeholder="0–12"
                  value={weeksAtDiagnosis}
                  onChange={(e) => setWeeksAtDiagnosis(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </LnField>
            <LnField label="Veterinario consultado">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  name="vetConsulted"
                  type="text"
                  placeholder="Dr. García · Clínica X"
                  value={vetConsulted}
                  onChange={(e) => setVetConsulted(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </LnField>
          </LnRow>
          <LnField label="Notas adicionales">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                placeholder="Detalles que quieras recordar…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
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
        ctaLabel="Registrar embarazo"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
