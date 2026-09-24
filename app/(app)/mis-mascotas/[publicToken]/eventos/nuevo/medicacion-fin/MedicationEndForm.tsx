"use client";

import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState, useState } from "react";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "medication-end-form";

type OpenMedication = {
  id: string;
  drugName: string;
  startedDate: string;
};

export function MedicationEndForm({
  action,
  openMedications,
  defaults,
}: {
  action: FormAction;
  openMedications: OpenMedication[];
  /** Optional prefill values forwarded from URL searchParams (captura-rápida). */
  defaults?: { occurredAt: string | null; notes: string | null };
}) {
  // The select below keys off kept(), not live state: kept() stays "" until
  // the first submit settles, so it only forces a remount exactly once, at
  // the post-action reset — a key derived from live state remounts on EVERY
  // pick instead, the bug MinimalNewPetForm.test.tsx caught for `breed`.
  const { boundAction, kept } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();
  const [selectedMedicationId, setSelectedMedicationId] = useState("");
  const [occurredAt, setOccurredAt] = useState(defaults?.occurredAt ?? today);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState(defaults?.notes ?? "");

  return (
    <>
      <LnSheetHeader
        tone="violeta"
        icon={<Icon name="medicacion-fin" decorative />}
        title="Fin de medicación"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <LnField label="Medicación a cerrar" required>
            {({ id, describedBy, invalid }) => (
              <LnSelect
                // `value=`+`onChange=` alone falls back to its FIRST option
                // on React 19's post-action reset regardless (react-dom's
                // UPDATE path never rewrites `defaultSelected`, only MOUNT
                // does — see lib/ui/use-kept-fields.ts). `key` from `kept()`
                // (not from `selectedMedicationId`) so the remount happens
                // exactly once, at the post-action reset — not on every pick.
                key={`medication-${kept("medicationStartedEventId")}`}
                id={id}
                name="medicationStartedEventId"
                required
                defaultValue={kept("medicationStartedEventId") || selectedMedicationId}
                onChange={(e) => setSelectedMedicationId(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                <option value="" disabled>
                  Seleccioná un medicamento...
                </option>
                {openMedications.map((med) => (
                  <option key={med.id} value={med.id}>
                    {med.drugName} · iniciado {med.startedDate}
                  </option>
                ))}
              </LnSelect>
            )}
          </LnField>
          <LnField label="Fecha de fin" required>
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
          <LnField label="Motivo">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="reason"
                type="text"
                placeholder="Tratamiento completo, efectos adversos…"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
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
        tone="violeta"
        ctaLabel="Confirmar cierre de medicación"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
