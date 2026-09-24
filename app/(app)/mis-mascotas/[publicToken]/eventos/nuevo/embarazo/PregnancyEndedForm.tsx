"use client";

import { useActionState, useState } from "react";

import type { PregnancyFormState } from "@/app/actions/pregnancy";
import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader, LnSubCard } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";

const initialState: PregnancyFormState = { error: null };
type FormAction = (prev: PregnancyFormState, formData: FormData) => Promise<PregnancyFormState>;
const FORM_ID = "pregnancy-ended-form";

const OUTCOMES = [
  { value: "live_birth", label: "Parto exitoso" },
  { value: "stillbirth", label: "Óbito fetal" },
  { value: "miscarriage", label: "Aborto espontáneo" },
  { value: "termination", label: "Terminación médica" },
  { value: "unknown", label: "No sé / no me consta" },
] as const;

type Outcome = (typeof OUTCOMES)[number]["value"];

export function PregnancyEndedForm({ action }: { action: FormAction }) {
  // React 19 resets this form when the action settles — INCLUDING on error —
  // and this form had NO controlled field surviving that: date, radio
  // outcome, live-birth count, vet and notes all went back to blank or to
  // the mount default (see lib/ui/use-kept-fields.ts). `useKeptFields`
  // re-seeds every field from the FormData actually submitted.
  const { boundAction, kept, keptChecked } = useKeptFields<PregnancyFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns where to go and this navigates. It used to
  // redirect() server-side, a transition the App Router drops in production —
  // the write committed and the screen never moved.
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const [outcome, setOutcome] = useState<Outcome>("live_birth");
  const today = todayIsoInAr();

  return (
    <>
      <LnSheetHeader
        tone="rosa"
        icon={<Icon name="lactancia" decorative />}
        title="Cerrar gestación"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <LnField label="Fecha del cierre" required>
            {({ id, describedBy, invalid }) => (
              // `kept("occurredAt") || today` — fresh-context review, T4-F1
              // batch 2: a legitimately EMPTY resubmission would fall through
              // to `today` too. `required` below is what actually rules that
              // out — the browser refuses to submit an empty date, so the
              // fallback only ever fires pre-submit.
              <LnInput
                id={id}
                name="occurredAt"
                type="date"
                required
                mono
                defaultValue={kept("occurredAt") || today}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>

          {/* Outcome radio group */}
          <div className="flex flex-col gap-1.5">
            <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
              Resultado{" "}
              <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
                *
              </span>
            </p>
            <div className="flex flex-col gap-1.5">
              {OUTCOMES.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 text-md text-[var(--color-ln-ink)]"
                >
                  <input
                    type="radio"
                    name="outcome"
                    value={o.value}
                    defaultChecked={keptChecked("outcome", o.value === "live_birth", o.value)}
                    onChange={() => setOutcome(o.value)}
                    required
                    className="accent-[var(--color-ln-rosa)]"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </div>

          {outcome === "live_birth" && (
            <LnField label="Cantidad de crías nacidas vivas" required>
              {({ id, describedBy, invalid }) => (
                // Wave 2 Item 9: inputMode="numeric" for whole-number birth count
                <LnInput
                  id={id}
                  name="liveBirthsCount"
                  type="number"
                  min={1}
                  max={20}
                  required={outcome === "live_birth"}
                  inputMode="numeric"
                  enterKeyHint="done"
                  placeholder="1–20"
                  defaultValue={kept("liveBirthsCount")}
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </LnField>
          )}

          <LnField label="Veterinario que asistió">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="vetConsulted"
                type="text"
                placeholder="Dr. García · Clínica Veterinaria X"
                defaultValue={kept("vetConsulted")}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Notas adicionales">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                placeholder="Detalles que quieras recordar…"
                defaultValue={kept("notes")}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>

          <LnSubCard>
            <p className="text-sm text-[var(--color-ln-mute)]">
              Tras este registro la mascota podrá ser candidata para futuros embarazos. Si querés
              evitarlo, considerá registrar también una esterilización.
            </p>
          </LnSubCard>

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
        ctaLabel="Confirmar fin de gestación"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
