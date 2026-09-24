"use client";

/**
 * WeightForm — Libreta Nacional redesign.
 * Action, useActionState wiring, field names, and submit logic: untouched.
 */

import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnRow, LnSuffixWrap, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState } from "react";
import { AttachmentField } from "../AttachmentField";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "weight-form";

export type WeightFormDefaults = {
  kg: string | null;
  occurredAt: string | null;
  notes: string | null;
};

export function WeightForm({
  action,
  defaults,
}: {
  action: FormAction;
  defaults?: WeightFormDefaults;
}) {
  // forms/react19-reset-data-loss-inventory: "kg"/"occurredAt"/"notes" all
  // had a STATIC defaultValue derived from `defaults` — a rejected submit
  // put back the ORIGINAL defaults, discarding whatever the owner had just
  // typed.
  const { boundAction, kept } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();

  return (
    <>
      <LnSheetHeader
        tone="azul"
        icon={<Icon name="peso" decorative />}
        title="Registrar peso"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <LnField label="Peso" required error={state.error ?? undefined}>
            {({ id, describedBy, invalid }) => (
              <LnSuffixWrap suffix="kg">
                {/* Wave 2 Item 9: inputMode="decimal" + enterKeyHint="done" for mobile number pad */}
                <LnInput
                  id={id}
                  name="kg"
                  type="number"
                  step="0.1"
                  min="0"
                  required
                  inputMode="decimal"
                  enterKeyHint="done"
                  defaultValue={kept("kg", defaults?.kg ?? "")}
                  placeholder="Ej: 12.5"
                  aria-describedby={describedBy}
                  invalid={invalid}
                />
              </LnSuffixWrap>
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
                defaultValue={kept("occurredAt", defaults?.occurredAt ?? today)}
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
                defaultValue={kept("notes", defaults?.notes ?? "")}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <AttachmentField />
        </form>
      </LnSheetBody>
      <LnSheetFooter tone="azul" ctaLabel="Registrar peso" formId={FORM_ID} isPending={isPending} />
    </>
  );
}
