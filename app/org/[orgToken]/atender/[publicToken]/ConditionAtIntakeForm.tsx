"use client";

// "Estado al ingreso" — how the animal arrived, recorded by the vet at the start
// of an atención (vet-visit-record, 2026-09-29).
//
// Only the general condition is required: a vet in a hurry records "Regular"
// and moves on, and the record is still worth having. Every vital is optional
// and validated on the server with a sentence about the field
// (condition-at-intake-form.ts) — the bounds live there, once, so this form
// does not carry a second copy that could drift.
//
// Weight entered here is written as its own weight_recorded event, the single
// source of the animal's weight, in the same transaction as the intake.
//
// Inputs are uncontrolled and re-seeded from what was submitted (useKeptFields)
// so a refusal does not wipe what the vet typed.

import { useActionState } from "react";

import { Icon } from "@/components/Icon";
import {
  LnField,
  LnInput,
  LnRadio,
  LnRadioGroup,
  LnSelect,
  LnTextarea,
} from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import {
  INTAKE_CONDITION_LABELS,
  INTAKE_HYDRATION_LABELS,
  INTAKE_MUCOUS_LABELS,
} from "@/lib/domain/visit-labels";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { EventFormState } from "@/src/modules/events/actions";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "condition-at-intake-form";

const BODY_CONDITION_SCORES = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function ConditionAtIntakeForm({ action }: { action: FormAction }) {
  const { boundAction, kept, keptChecked } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  useActionRedirect(state.redirectTo, state);
  const { key: idempotencyKey } = useIdempotencyKey();

  const numberField = (
    name: string,
    label: string,
    opts: { placeholder: string; integer?: boolean },
  ) => (
    <LnField label={label}>
      {({ id, describedBy, invalid }) => (
        <LnInput
          key={`${name}-${kept(name)}`}
          id={id}
          name={name}
          inputMode={opts.integer ? "numeric" : "decimal"}
          mono
          defaultValue={kept(name)}
          placeholder={opts.placeholder}
          aria-describedby={describedBy}
          invalid={invalid}
        />
      )}
    </LnField>
  );

  return (
    <>
      <LnSheetHeader
        tone="azul"
        icon={<Icon name="clinico" decorative />}
        title="Estado al ingreso"
        subtitle="Cómo llegó el animal a la atención"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />

          {state.error && (
            <p role="alert" className="text-sm text-[var(--color-ln-err)]">
              {state.error}
            </p>
          )}

          <LnRadioGroup
            key={`generalCondition-${kept("generalCondition")}`}
            legend="Estado general"
            required
            optionsClassName="grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {Object.entries(INTAKE_CONDITION_LABELS).map(([value, label]) => (
              <LnRadio
                key={value}
                name="generalCondition"
                value={value}
                required
                defaultChecked={keptChecked("generalCondition", false, value)}
              >
                {label}
              </LnRadio>
            ))}
          </LnRadioGroup>

          <LnField label="Motivo de consulta">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                key={`presentingComplaint-${kept("presentingComplaint")}`}
                id={id}
                name="presentingComplaint"
                rows={2}
                defaultValue={kept("presentingComplaint")}
                placeholder="Lo que cuenta quien trae al animal"
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {numberField("weightKg", "Peso (kg)", { placeholder: "12,5" })}
            {numberField("temperatureC", "Temperatura (°C)", { placeholder: "38,5" })}
            {numberField("heartRateBpm", "Frec. cardíaca (lpm)", {
              placeholder: "100",
              integer: true,
            })}
            {numberField("respiratoryRateRpm", "Frec. respiratoria (rpm)", {
              placeholder: "24",
              integer: true,
            })}
            <LnField label="Condición corporal (1–9)">
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  key={`bodyConditionScore-${kept("bodyConditionScore")}`}
                  id={id}
                  name="bodyConditionScore"
                  defaultValue={kept("bodyConditionScore")}
                  aria-describedby={describedBy}
                  invalid={invalid}
                >
                  <option value="">Sin dato</option>
                  {BODY_CONDITION_SCORES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </LnSelect>
              )}
            </LnField>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <LnField label="Hidratación">
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  key={`hydration-${kept("hydration")}`}
                  id={id}
                  name="hydration"
                  defaultValue={kept("hydration")}
                  aria-describedby={describedBy}
                  invalid={invalid}
                >
                  <option value="">Sin dato</option>
                  {Object.entries(INTAKE_HYDRATION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </LnSelect>
              )}
            </LnField>
            <LnField label="Mucosas">
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  key={`mucousMembranes-${kept("mucousMembranes")}`}
                  id={id}
                  name="mucousMembranes"
                  defaultValue={kept("mucousMembranes")}
                  aria-describedby={describedBy}
                  invalid={invalid}
                >
                  <option value="">Sin dato</option>
                  {Object.entries(INTAKE_MUCOUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </LnSelect>
              )}
            </LnField>
          </div>

          <LnField label="Hallazgos">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                key={`findings-${kept("findings")}`}
                id={id}
                name="findings"
                rows={3}
                defaultValue={kept("findings")}
                placeholder="Lo que encontraste al revisarlo"
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
        </form>
      </LnSheetBody>
      <LnSheetFooter
        tone="azul"
        ctaLabel="Registrar estado al ingreso"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
