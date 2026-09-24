"use client";

// MedicationStartForm — Libreta Nacional redesign (violet tone, §9 handoff).
// Presentation ONLY: action, useActionState wiring, field names, and submit
// logic are untouched.

import { Icon } from "@/components/Icon";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnRow, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { type DrugDef, drugsForSpecies, findDrugByLabel } from "@/lib/reference/drugs";
import { FREQUENCY_LABELS } from "@/lib/reference/medication-schedule";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { nowLocalDatetimeInAr, todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState, useState } from "react";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

const FORM_ID = "medication-start-form";

export function MedicationStartForm({
  action,
  species,
  defaultNotes,
  defaultOccurredAt,
}: {
  action: FormAction;
  species: string | null | undefined;
  defaultNotes?: string;
  defaultOccurredAt?: string;
}) {
  // The frequency select below keys off kept(), not live state: kept() stays
  // "" until the first submit settles, so it only forces a remount exactly
  // once, at the post-action reset — a key derived from live state remounts
  // on EVERY pick instead, the bug MinimalNewPetForm.test.tsx caught for
  // `breed`.
  const { boundAction, kept } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const { key: idempotencyKey } = useIdempotencyKey();

  // AR wall clock, like every other datetime-local default in the app — the
  // hand-rolled getters read the BROWSER's ambient zone, which is only correct
  // for a viewer physically in AR and diverges for everyone else (and from the
  // server's parse, which reads the submitted string as AR wall clock).
  const localDatetime = nowLocalDatetimeInAr();
  const today = todayIsoInAr();

  const catalogDrugs = drugsForSpecies(species);
  const [matchedDrug, setMatchedDrug] = useState<DrugDef | null>(null);
  const [drugName, setDrugName] = useState("");
  const [doseValue, setDoseValue] = useState("");
  const [frequency, setFrequency] = useState<string>(matchedDrug?.typicalFrequency ?? "");
  const [showCustomHours, setShowCustomHours] = useState(false);
  const [customHours, setCustomHours] = useState("");
  const [firstDoseAt, setFirstDoseAt] = useState(localDatetime);
  const [durationDays, setDurationDays] = useState("");
  const [prescribedBy, setPrescribedBy] = useState("");
  const [occurredAt, setOccurredAt] = useState(defaultOccurredAt ?? today);
  const [notes, setNotes] = useState(defaultNotes ?? "");

  function handleDrugNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setDrugName(val);
    const found = findDrugByLabel(val);
    setMatchedDrug(found);
    if (found) {
      setDoseValue(found.typicalDose);
      setFrequency(found.typicalFrequency);
      setShowCustomHours(found.typicalFrequency === "custom");
    }
  }

  function handleFrequencyChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    setFrequency(val);
    setShowCustomHours(val === "custom");
  }

  return (
    <>
      <LnSheetHeader
        tone="violeta"
        icon={<Icon name="medicacion" decorative />}
        title="Inicio de medicación"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />

          {/* Drug name with datalist */}
          <LnField
            label="Medicamento"
            required
            hint={
              matchedDrug
                ? `Categoría: ${matchedDrug.category}${
                    matchedDrug.brandNames?.length
                      ? ` · Marcas: ${matchedDrug.brandNames.join(", ")}`
                      : ""
                  }`
                : undefined
            }
          >
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="drugName"
                type="text"
                list="drug-options"
                required
                placeholder="Amoxicilina, Metronidazol…"
                value={drugName}
                onChange={handleDrugNameChange}
                autoComplete="off"
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <datalist id="drug-options">
            {catalogDrugs.map((d) => (
              <option key={d.code} value={d.label} />
            ))}
          </datalist>

          <LnRow>
            {/* Dose */}
            <LnField
              label="Dosis"
              required
              hint={
                matchedDrug
                  ? `Sugerencia: ${matchedDrug.label}. Ajustá según indicación.`
                  : undefined
              }
            >
              {({ id, describedBy, invalid }) => (
                // Wave 2 Item 9: inputMode="decimal" for numeric dose values on mobile
                <LnInput
                  id={id}
                  name="dose"
                  type="text"
                  required
                  inputMode="decimal"
                  enterKeyHint="next"
                  value={doseValue}
                  onChange={(e) => setDoseValue(e.target.value)}
                  placeholder="10 mg/kg, 1 comp…"
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </LnField>

            {/* Frequency */}
            <LnField label="Frecuencia" required>
              {({ id, describedBy, invalid }) => (
                <LnSelect
                  // `value=`+`onChange=` alone falls back to its FIRST
                  // option on React 19's post-action reset regardless
                  // (react-dom's UPDATE path never rewrites
                  // `defaultSelected`, only MOUNT does — see
                  // lib/ui/use-kept-fields.ts). `key` from `kept()` (not from
                  // `frequency`) so the remount happens exactly once, at the
                  // post-action reset — not on every pick.
                  key={`frequency-${kept("frequency")}`}
                  id={id}
                  name="frequency"
                  required
                  defaultValue={kept("frequency") || frequency}
                  onChange={handleFrequencyChange}
                  aria-describedby={describedBy}
                  invalid={invalid}
                >
                  <option value="">Seleccioná</option>
                  {(Object.entries(FREQUENCY_LABELS) as [string, string][]).map(
                    ([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ),
                  )}
                </LnSelect>
              )}
            </LnField>
          </LnRow>

          {/* Custom hours — revealed when frequency === "custom" */}
          {showCustomHours && (
            <LnField
              label="Cada cuántas horas"
              required
              hint="Ingresá un valor entre 1 y 24 horas."
            >
              {({ id, describedBy, invalid }) => (
                // Wave 2 Item 9: inputMode="numeric" for whole-number hours
                <LnInput
                  id={id}
                  name="customHours"
                  type="number"
                  min="1"
                  max="24"
                  required
                  inputMode="numeric"
                  enterKeyHint="next"
                  placeholder="Ej. 8"
                  value={customHours}
                  onChange={(e) => setCustomHours(e.target.value)}
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              )}
            </LnField>
          )}

          {/* First dose datetime */}
          <LnField
            label="Primera dosis"
            required
            hint="Desde este momento se van a generar los recordatorios de dosis."
          >
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="firstDoseAt"
                type="datetime-local"
                required
                mono
                value={firstDoseAt}
                onChange={(e) => setFirstDoseAt(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>

          <LnRow>
            {/* Duration */}
            <LnField label="Duración (días)" hint="Sin duración: 14 días de recordatorios.">
              {({ id, describedBy }) => (
                // Wave 2 Item 9: inputMode="numeric" for whole-number day count
                <LnInput
                  id={id}
                  name="durationDays"
                  type="number"
                  min="1"
                  max="90"
                  inputMode="numeric"
                  enterKeyHint="next"
                  placeholder="Ej. 7"
                  value={durationDays}
                  onChange={(e) => setDurationDays(e.target.value)}
                  aria-describedby={describedBy}
                />
              )}
            </LnField>

            {/* Prescribed by */}
            <LnField label="Prescripto por">
              {({ id, describedBy }) => (
                <LnInput
                  id={id}
                  name="prescribedBy"
                  type="text"
                  placeholder="Nombre del veterinario/a"
                  value={prescribedBy}
                  onChange={(e) => setPrescribedBy(e.target.value)}
                  aria-describedby={describedBy}
                />
              )}
            </LnField>
          </LnRow>

          {/* Start date — "día de inicio" (may differ from firstDoseAt) */}
          <LnField
            label="Día de inicio"
            required
            hint="Fecha en que empezó el tratamiento (puede diferir de la primera dosis registrada)."
          >
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

          <LnCallout tone="warn" title="Recordatorios programados">
            Sin duración, generamos recordatorios para los próximos 14 días. Cuando el tratamiento
            termine, marcalo como fin y cancelamos los pendientes.
          </LnCallout>

          <LnField label="Notas">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby={describedBy}
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
      {/* Wave 2 Item 9: verb fix — Rule 2 requires object after verb */}
      <LnSheetFooter
        tone="violeta"
        ctaLabel="Registrar inicio de medicación"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
