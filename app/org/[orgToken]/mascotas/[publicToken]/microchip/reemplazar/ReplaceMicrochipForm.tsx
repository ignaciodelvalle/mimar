"use client";

import { LnField, LnInput, LnRadio, LnTextarea } from "@/components/ui/Field";
import { OpButton } from "@/components/ui/dashboard";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { todayIsoInAr } from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";
import { useActionState } from "react";

const initialState: EventFormState = { error: null };

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

type ReasonOption = {
  value: string;
  label: string;
  hint?: string;
};

const VET_REASONS: ReasonOption[] = [
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
];

export function ReplaceMicrochipForm({
  action,
  currentChip,
}: {
  action: FormAction;
  currentChip: string;
}) {
  // Four of the five fields here were DOM-owned, and React 19 resets a
  // `<form action>` the moment its action settles — a refusal settles it. A vet
  // whose chip number was refused came back to a blank reason, a blank chip, a
  // blank "realizado por" and blank notes, with the date silently back at today.
  // That last one is the mean part: a form that LOOKS filled is the one nobody
  // notices was emptied. `useKeptFields` re-seeds from the form's own submitted
  // `FormData`; the measured contract is in
  // `__tests__/react19-form-reset-contract.test.tsx`. Twin of the admin form at
  // app/admin/observaciones/[publicToken]/microchip/reemplazar — same fix there.
  const { boundAction: keptAction, kept, keptChecked } = useKeptFields(action);
  const [state, formAction, isPending] = useActionState(keptAction, initialState);
  // N3: the action used to redirect() server-side, a transition the App Router
  // drops in production — the replacement committed and the screen never moved.
  // `navigating` keeps the button busy while the full document load is in
  // flight, so nobody re-submits a chip replacement over a page that is leaving.
  const navigating = useActionRedirect(state.redirectTo, state);
  const { key: idempotencyKey } = useIdempotencyKey();
  const today = todayIsoInAr();

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
      <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe px-4 py-3 text-md text-ln-op-ink-2">
        Chip actual: <span className="font-ln-mono font-medium text-ln-op-ink">{currentChip}</span>
      </div>

      <div className="space-y-1.5">
        <p className="block mb-2.5 text-[0.88em] font-semibold text-ln-op-mute">
          Motivo del reemplazo<span className="text-ln-op-danger ml-0.5">*</span>
        </p>
        <div className="flex flex-col gap-2">
          {VET_REASONS.map((r) => (
            <LnRadio
              key={r.value}
              name="reason"
              value={r.value}
              defaultChecked={keptChecked("reason", false, r.value)}
              required
            >
              <span className="space-y-0.5">
                {r.label}
                {r.hint && <span className="block text-xs! text-ln-op-mute!">{r.hint}</span>}
              </span>
            </LnRadio>
          ))}
        </div>
      </div>

      <LnField
        label="Nuevo número de microchip"
        hint='Dejalo vacío si solo se revoca el chip (válido para "Solicitud del dueño/a" o "Falla del dispositivo").'
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

      <LnField label="Notas" hint="Máx. 300 caracteres.">
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="notes"
            defaultValue={kept("notes")}
            rows={3}
            maxLength={300}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.error && (
        <p className="text-md text-ln-op-danger" role="alert">
          {state.error}
        </p>
      )}

      <OpButton type="submit" disabled={isPending || navigating} block>
        {isPending || navigating ? "Guardando..." : "Registrar reemplazo de chip"}
      </OpButton>
    </form>
  );
}
