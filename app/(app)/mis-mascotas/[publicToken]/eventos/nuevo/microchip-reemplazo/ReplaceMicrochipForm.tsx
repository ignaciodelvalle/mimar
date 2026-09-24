"use client";

import { Icon } from "@/components/Icon";
import { LnField, LnInput, LnRadio, LnTextarea } from "@/components/ui/Field";
import { LnSheetBody, LnSheetFooter, LnSheetHeader, LnSubCard } from "@/components/ui/Sheet";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useFormErrorFocus } from "@/lib/ui/use-form-error-focus";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState, useState } from "react";

const initialState: EventFormState = { error: null };
type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;
const FORM_ID = "replace-microchip-form";

const OWNER_REASONS = [
  { value: "damaged", label: "Chip dañado físicamente" },
  { value: "unreadable", label: "Chip ilegible o sin señal" },
  { value: "owner_request", label: "Solicitud del dueño/a" },
  { value: "device_failure", label: "Falla del dispositivo" },
  { value: "other", label: "Otro motivo" },
];

export function ReplaceMicrochipForm({
  action,
  currentChip,
}: {
  action: FormAction;
  currentChip: string;
}) {
  // forms/react19-reset-data-loss-inventory: "reason" is an uncontrolled
  // radio group with no defaultChecked at all — a rejected submit leaves
  // every option unticked, discarding whichever reason was picked.
  const { boundAction, keptChecked } = useKeptFields<EventFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns where to go instead of redirect()-ing, because the
  // App Router drops a Server Action's own redirect in production.
  const navigating = useActionRedirect(state.redirectTo, state);
  const errorRef = useFormErrorFocus<HTMLParagraphElement>(state.error);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();

  // Controlled field state — preserves typed input on validation error.
  const [newChipNumber, setNewChipNumber] = useState("");
  const [replacedBy, setReplacedBy] = useState("");
  const [replacedAt, setReplacedAt] = useState(today);
  const [notes, setNotes] = useState("");

  return (
    <>
      <LnSheetHeader
        tone="azul"
        icon={<Icon name="microchip-reemplazo" decorative />}
        title="Reemplazar microchip"
        subtitle="Libreta sanitaria oficial"
      />
      <LnSheetBody>
        <form id={FORM_ID} action={formAction} className="contents">
          <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
          {/* Current chip display */}
          <LnSubCard>
            <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">Chip actual</p>
            <p className="font-ln-mono text-md font-semibold text-[var(--color-ln-ink)]">
              {currentChip}
            </p>
          </LnSubCard>

          {/* Reason */}
          <div className="flex flex-col gap-1.5">
            <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
              Motivo del reemplazo{" "}
              <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
                *
              </span>
            </p>
            <div className="flex flex-col gap-1.5">
              {OWNER_REASONS.map((r) => (
                <LnRadio
                  key={r.value}
                  name="reason"
                  value={r.value}
                  defaultChecked={keptChecked("reason", false, r.value)}
                  required
                >
                  {r.label}
                </LnRadio>
              ))}
            </div>
          </div>

          <LnField label="Nuevo número de microchip" hint="Dejalo vacío si solo se revoca el chip.">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="newChipNumber"
                type="text"
                value={newChipNumber}
                onChange={(e) => setNewChipNumber(e.target.value)}
                placeholder="985141004321456"
                aria-describedby={describedBy}
                invalid={invalid}
                mono
              />
            )}
          </LnField>
          <LnField label="Realizado por (veterinario/a)">
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="replacedBy"
                type="text"
                value={replacedBy}
                onChange={(e) => setReplacedBy(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Fecha del reemplazo" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="replacedAt"
                type="date"
                required
                mono
                value={replacedAt}
                onChange={(e) => setReplacedAt(e.target.value)}
                aria-describedby={describedBy}
                invalid={invalid}
              />
            )}
          </LnField>
          <LnField label="Notas" hint="Máx. 300 caracteres.">
            {({ id, describedBy, invalid }) => (
              <LnTextarea
                id={id}
                name="notes"
                rows={3}
                maxLength={300}
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
        tone="azul"
        ctaLabel="Confirmar reemplazo de chip"
        formId={FORM_ID}
        isPending={isPending || navigating}
      />
    </>
  );
}
