"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/Icon";
import { LocationFields } from "@/components/LocationFields";
import { LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnSheetAccordion, LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "clinical-info-form";

const SUB_KINDS = [
  { value: "lab_work", label: "Análisis de laboratorio" },
  { value: "imaging", label: "Imagen / radiografía / ecografía" },
  { value: "surgery", label: "Cirugía" },
  { value: "allergy_detection", label: "Detección de alergia" },
  { value: "other", label: "Otro" },
] as const;

type SubKind = (typeof SUB_KINDS)[number]["value"];

const TITLE_PLACEHOLDERS: Record<SubKind, string> = {
  lab_work: "Hemograma completo",
  imaging: "Radiografía de tórax",
  surgery: "Castración",
  allergy_detection: "Alergia alimentaria detectada",
  other: "Descripción breve",
};

export function ClinicalInfoForm({
  action,
  defaults,
}: {
  action: FormAction;
  /** Optional prefill values forwarded from URL searchParams (captura-rápida). */
  defaults?: { occurredAt: string | null; notes: string | null };
}) {
  // The subKind select below keys off kept(), not live state: kept() stays
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
  const [subKind, setSubKind] = useState<SubKind>("lab_work");
  const today = todayIsoInAr();

  // Controlled field state
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [performedBy, setPerformedBy] = useState("");
  const [occurredAt, setOccurredAt] = useState(defaults?.occurredAt ?? today);
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  return (
    <>
      <LnSheetHeader
        tone="azul"
        icon={<Icon name="clinico" decorative />}
        title="Información clínica"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <LnField label="Tipo" required>
            {({ id, describedBy, invalid }) => (
              <LnSelect
                // `value=`+`onChange=` alone falls back to its FIRST option
                // on React 19's post-action reset regardless (react-dom's
                // UPDATE path never rewrites `defaultSelected`, only MOUNT
                // does — see lib/ui/use-kept-fields.ts). `key` from `kept()`
                // (not from `subKind`) so the remount happens exactly once,
                // at the post-action reset — not on every pick.
                key={`sub-kind-${kept("subKind")}`}
                id={id}
                name="subKind"
                required
                defaultValue={kept("subKind") || subKind}
                onChange={(e) => setSubKind(e.target.value as SubKind)}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                {SUB_KINDS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </LnSelect>
            )}
          </LnField>
          <LnField label="Título / nombre" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="title"
                type="text"
                required
                placeholder={TITLE_PLACEHOLDERS[subKind]}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Detalles, resultados, observaciones">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="details"
                rows={4}
                placeholder="Resultados, valores de referencia, comentarios del veterinario…"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>
          <LnField label="Realizado por (vet / clínica)">
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                name="performedBy"
                type="text"
                placeholder="Dr. García · Clínica Veterinaria X"
                value={performedBy}
                onChange={(e) => setPerformedBy(e.target.value)}
                aria-describedby={describedBy}
              />
            )}
          </LnField>
          <LnField label="Fecha" required>
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
          <LnField label="Notas adicionales">
            {({ id, describedBy }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                placeholder="Cualquier detalle extra que quieras recordar…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby={describedBy}
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
      {/* Wave 2 Item 9: verb fix — Rule 2 requires "Registrar X" for logging an observable event */}
      <LnSheetFooter
        tone="azul"
        ctaLabel="Registrar información clínica"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
