"use client";

// The ENO diagnosis step of the clinical record (PO S2, 2026-09-26) — vet
// only. Shared by the web clinical record (/mis-mascotas/…/clinico/diagnostico)
// and the clinic panel's "Atender" (AtenderCaptureMounter), bound to each
// door's own server action; the fields are parsed server-side by
// src/modules/events/application/clinical/disease-diagnosis-form.ts.
//
// What it records is a legal act, so the form says so before the submit: the
// disease opens a notice to the health authority with a deadline counted from
// the diagnosis date (PO S5), not from today.

import { useActionState, useState } from "react";

import { Icon } from "@/components/Icon";
import { LocationFields } from "@/components/LocationFields";
import {
  LnField,
  LnInput,
  LnRadio,
  LnRadioGroup,
  LnSelect,
  LnTextarea,
} from "@/components/ui/Field";
import { LnSheetAccordion, LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { notifiableDiagnosisOptions } from "@/lib/reference/notifiable-diseases";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "disease-diagnosis-form";

type Method = "clinico" | "laboratorio";

export function DiseaseDiagnosisForm({
  action,
  species,
  showLocation = true,
}: {
  action: FormAction;
  /** The animal's species — the picker offers only its notifiable diseases. */
  species: string | null;
  /** The clinic panel names no place (the clinic is the place); the web asks. */
  showLocation?: boolean;
}) {
  const { boundAction, kept, keptChecked } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);

  const options = notifiableDiagnosisOptions(species);
  const [diseaseCode, setDiseaseCode] = useState("");
  const [method, setMethod] = useState<Method>("clinico");
  const [diagnosisDate, setDiagnosisDate] = useState(todayIsoInAr());
  const [labName, setLabName] = useState("");
  const [labReportReference, setLabReportReference] = useState("");
  const [notes, setNotes] = useState("");

  const chosen = options.find((o) => o.code === (kept("diseaseCode") || diseaseCode));

  return (
    <>
      <LnSheetHeader
        tone="azul"
        icon={<Icon name="clinico" decorative />}
        title="Diagnóstico de enfermedad de notificación obligatoria"
        subtitle="Queda firmado con tu matrícula"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <LnField
            label="Enfermedad"
            required
            hint={
              chosen
                ? `Abre un aviso a la autoridad sanitaria con plazo de ${chosen.notifyHours} h desde la fecha del diagnóstico.`
                : "Solo las enfermedades que la norma obliga a notificar para esta especie."
            }
          >
            {({ id, describedBy, invalid }) => (
              <LnSelect
                key={`disease-${kept("diseaseCode")}`}
                id={id}
                name="diseaseCode"
                required
                defaultValue={kept("diseaseCode") || diseaseCode}
                onChange={(e) => setDiseaseCode(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                <option value="">Elegí la enfermedad</option>
                {options.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </LnSelect>
            )}
          </LnField>
          <LnField label="Fecha del diagnóstico" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="diagnosisDate"
                type="date"
                required
                mono
                max={todayIsoInAr()}
                value={diagnosisDate}
                onChange={(e) => setDiagnosisDate(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          {/* Radios are uncontrolled (defaultChecked seeded by keptChecked) and
              remount on kept(): React 19's post-action reset would otherwise
              fall a checked radio back to its default (lib/ui/use-kept-fields.ts). */}
          <LnRadioGroup key={`method-${kept("method")}`} legend="Cómo se diagnosticó" required>
            <LnRadio
              name="method"
              value="clinico"
              defaultChecked={keptChecked("method", method === "clinico", "clinico")}
              onChange={() => setMethod("clinico")}
            >
              Diagnóstico clínico
            </LnRadio>
            <LnRadio
              name="method"
              value="laboratorio"
              defaultChecked={keptChecked("method", method === "laboratorio", "laboratorio")}
              onChange={() => setMethod("laboratorio")}
            >
              Confirmado por laboratorio
            </LnRadio>
          </LnRadioGroup>
          {method === "laboratorio" && (
            <>
              <LnField label="Laboratorio" required>
                {({ id, describedBy, invalid }) => (
                  <LnInput
                    id={id}
                    name="labName"
                    type="text"
                    required
                    value={labName}
                    onChange={(e) => setLabName(e.target.value)}
                    aria-describedby={describedBy}
                    invalid={invalid}
                  />
                )}
              </LnField>
              <LnField label="Número de protocolo o informe">
                {({ id, describedBy }) => (
                  <LnInput
                    id={id}
                    name="labReportReference"
                    type="text"
                    value={labReportReference}
                    onChange={(e) => setLabReportReference(e.target.value)}
                    aria-describedby={describedBy}
                  />
                )}
              </LnField>
            </>
          )}
          <LnField label="Notas clínicas">
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
          {showLocation && (
            <LnSheetAccordion num="+" title="Dónde ocurrió">
              <LocationFields mode="l1" cascade />
            </LnSheetAccordion>
          )}
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
        ctaLabel="Registrar diagnóstico"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
