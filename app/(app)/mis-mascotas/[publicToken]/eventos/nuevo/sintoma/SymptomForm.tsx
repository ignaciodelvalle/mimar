"use client";

import { useActionState, useState } from "react";

import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { SymptomFormState } from "@/src/modules/events/actions";

const initialState: SymptomFormState = { error: null };
type FormAction = (prev: SymptomFormState, formData: FormData) => Promise<SymptomFormState>;
const FORM_ID = "symptom-form";

export function SymptomForm({
  action,
  petName,
  defaults,
}: {
  action: FormAction;
  petName: string;
  /** Optional prefill values forwarded from URL searchParams (captura-rápida). */
  defaults?: { freeText: string | null; onsetAt: string | null };
}) {
  // The select below keys off kept(), not live state: kept() stays "" until
  // the first submit settles, so it only forces a remount exactly once, at
  // the post-action reset — a key derived from live state remounts on EVERY
  // pick instead, the bug MinimalNewPetForm.test.tsx caught for `breed`.
  const { boundAction, kept } = useKeptFields<SymptomFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3 redirect contract: the action returns `redirectTo` on success and the
  // form performs the full document navigation (see lib/ui/use-action-redirect.ts).
  useActionRedirect(state.redirectTo, state);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();

  // Controlled field state
  const [freeText, setFreeText] = useState(defaults?.freeText ?? "");
  const [severity, setSeverity] = useState("");
  const [onsetAt, setOnsetAt] = useState(defaults?.onsetAt ?? "");

  return (
    <>
      <LnSheetHeader
        tone="warn"
        icon={<Icon name="sintoma" decorative />}
        title="Registrar síntoma"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          <LnField label="¿Qué estás viendo?" required error={state.error ?? undefined}>
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="freeText"
                required
                rows={5}
                placeholder={`Ej: hace dos días que ${petName} vomita y está decaída. Hoy no quiso comer.`}
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="¿Cuán grave te parece?">
            {({ id, describedBy, invalid }) => (
              <LnSelect
                // `value=`+`onChange=` alone falls back to its FIRST option
                // on React 19's post-action reset regardless (react-dom's
                // UPDATE path never rewrites `defaultSelected`, only MOUNT
                // does — see lib/ui/use-kept-fields.ts). `key` from `kept()`
                // (not from `severity`) so the remount happens exactly once,
                // at the post-action reset — not on every pick.
                key={`severity-${kept("severity")}`}
                id={id}
                name="severity"
                defaultValue={kept("severity") || severity}
                onChange={(e) => setSeverity(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              >
                <option value="">No sé / prefiero no decir</option>
                <option value="mild">Leve</option>
                <option value="moderate">Moderado</option>
                <option value="severe">Grave</option>
              </LnSelect>
            )}
          </LnField>
          <LnField label="¿Desde cuándo notás esto?">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="onsetAt"
                type="date"
                mono
                max={today}
                value={onsetAt}
                onChange={(e) => setOnsetAt(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <p className="font-ln-mono text-sm text-center text-[var(--color-ln-mute)]">
            Si los síntomas persisten o empeoran, consultá al veterinario.
          </p>
        </form>
      </LnSheetBody>
      {/* Wave 2 Item 9: verb fix — Rule 2 requires "Registrar X" with explicit object */}
      <LnSheetFooter
        tone="warn"
        ctaLabel="Registrar síntoma"
        formId={FORM_ID}
        isPending={isPending}
      />
    </>
  );
}
