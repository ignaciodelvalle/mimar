"use client";

import { LnField, LnInput, LnRadio, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState, useState } from "react";

const initialState: EventFormState = { error: null };

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

type ReasonOption = {
  value: string;
  label: string;
  hint?: string;
};

const ADMIN_REASONS: ReasonOption[] = [
  { value: "damaged", label: "Chip dañado físicamente" },
  { value: "unreadable", label: "Chip ilegible o sin señal" },
  { value: "owner_request", label: "Solicitud del dueño/a" },
  { value: "device_failure", label: "Falla del dispositivo" },
  { value: "other", label: "Otro motivo" },
  {
    value: "duplicate_detected",
    label: "Chip duplicado detectado",
    hint: "El chip ya está registrado en otra mascota — abre un caso de investigación automáticamente.",
  },
  {
    value: "fraud_detected",
    label: "Fraude detectado",
    hint: "Requiere una nota obligatoria que justifique la decisión.",
  },
];

export function ReplaceMicrochipForm({
  action,
  currentChip,
}: {
  action: FormAction;
  currentChip: string;
}) {
  // Four of the five fields here were DOM-owned, and React 19 resets a
  // `<form action>` the moment its action settles — a refusal settles it. The
  // stake is higher on this twin than on the vet one: "Fraude detectado"
  // REQUIRES a justifying note, so the refusal most likely to fire here is the
  // one that then threw the justification away and left the date silently back
  // at today, on a form that still looked filled. `useKeptFields` re-seeds from
  // the form's own submitted `FormData`; contract in
  // `__tests__/react19-form-reset-contract.test.tsx`. Twin of the vet form at
  // app/org/[orgToken]/mascotas/[publicToken]/microchip/reemplazar.
  const { boundAction: keptAction, kept, keptChecked } = useKeptFields(action);
  const [state, formAction, isPending] = useActionState(keptAction, initialState);
  // N3: the action returns where to go instead of redirect()-ing, because the
  // App Router drops a Server Action's own redirect in production.
  const navigating = useActionRedirect(state.redirectTo, state);
  const [selectedReason, setSelectedReason] = useState<string>("");
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();
  const isFraud = selectedReason === "fraud_detected";

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
      {/* Current chip info row */}
      <div className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe px-4 py-3 text-sm text-ln-op-ink-2">
        Chip actual:{" "}
        <span className="font-ln-mono font-semibold text-ln-op-ink">{currentChip}</span>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-semibold text-ln-op-ink-2">
          Motivo del reemplazo
          <span className="ml-0.5 text-ln-op-danger">*</span>
        </p>
        <div className="flex flex-col gap-2">
          {ADMIN_REASONS.map((r) => (
            <LnRadio
              key={r.value}
              name="reason"
              value={r.value}
              defaultChecked={keptChecked("reason", false, r.value)}
              required
              onChange={() => setSelectedReason(r.value)}
            >
              <span className="space-y-0.5">
                <span>{r.label}</span>
                {r.hint && <span className="block text-sm text-ln-op-mute">{r.hint}</span>}
              </span>
            </LnRadio>
          ))}
        </div>
      </div>

      <LnField
        label="Nuevo número de microchip"
        hint="Dejálo vacío para revocar sin reemplazar (válido para fraude, falla del dispositivo o solicitud del dueño/a)."
      >
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="newChipNumber"
            defaultValue={kept("newChipNumber")}
            type="text"
            placeholder="985141004321456"
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Realizado por">
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="replacedBy"
            defaultValue={kept("replacedBy")}
            type="text"
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
            defaultValue={kept("replacedAt") || today}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField
        label="Notas"
        required={isFraud}
        hint={
          isFraud
            ? "Obligatorio para fraude detectado (máx. 300 caracteres)."
            : "Opcional — máx. 300 caracteres."
        }
      >
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="notes"
            defaultValue={kept("notes")}
            rows={4}
            required={isFraud}
            maxLength={300}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {isFraud && (
        <div
          className="rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-4 py-3 text-sm text-ln-op-danger"
          role="alert"
        >
          Esta acción notifica a todos los administradores activos y abre un caso de investigación
          automáticamente.
        </div>
      )}

      {state.error && (
        <p className="text-sm text-ln-op-danger" role="alert">
          {state.error}
        </p>
      )}

      <OpButton
        type="submit"
        disabled={isPending || navigating}
        loading={isPending || navigating}
        variant="primary"
        block
      >
        {isPending || navigating ? "Guardando..." : "Registrar reemplazo de chip"}
      </OpButton>
    </form>
  );
}
