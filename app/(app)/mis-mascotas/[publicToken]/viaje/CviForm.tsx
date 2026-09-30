"use client";

// Record a SENASA CVI (viajes-fase-2, task 5.3). Posts to recordCviAction
// (src/modules/pets/travel-actions.ts) — the same use-case
// `POST /api/v1/pets/{publicToken}/travel` `record_cvi` runs.
//
// miMAR never issues a CVI: this records that the owner HAS one, copied off the
// certificate. The idempotency key and the kept-fields reset follow TripForm.

import { useActionState, useEffect, useState } from "react";

import { LnButton } from "@/components/ui/Button";
import { DateInputAr } from "@/components/ui/DateInputAr";
import { LN_CONTROL_MONO_CLASS, LnField, LnInput } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { TravelFormState } from "@/src/modules/pets/application/travel/types";

const initialState: TravelFormState = { error: null };

type FormAction = (prev: TravelFormState, formData: FormData) => Promise<TravelFormState>;

export function CviForm({
  action,
  initialIdempotencyKey,
}: {
  action: FormAction;
  initialIdempotencyKey: string;
}) {
  const { boundAction, kept } = useKeptFields<TravelFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [idempotencyKey, setIdempotencyKey] = useState(initialIdempotencyKey);

  useEffect(() => {
    if (state.ok) setIdempotencyKey(crypto.randomUUID());
  }, [state]);

  const seed = (name: string) => (state.ok ? "" : kept(name));

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <LnField label="Número de CVI" required>
        {({ id, describedBy }) => (
          <LnInput
            key={`cviNumber-${idempotencyKey}`}
            id={id}
            name="cviNumber"
            type="text"
            mono
            required
            autoComplete="off"
            defaultValue={state.ok ? "" : kept("cviNumber")}
            aria-describedby={describedBy}
          />
        )}
      </LnField>

      <LnField label="Fecha de emisión" required>
        {({ id, describedBy, invalid }) => (
          <DateInputAr
            key={`issuedDate-${seed("issuedDate")}-${idempotencyKey}`}
            id={id}
            name="issuedDate"
            defaultValue={seed("issuedDate")}
            required
            ariaDescribedBy={describedBy}
            aria-invalid={invalid}
            className={LN_CONTROL_MONO_CLASS}
          />
        )}
      </LnField>

      <LnField label="Válido hasta" hint="Si figura en el certificado.">
        {({ id, describedBy, invalid }) => (
          <DateInputAr
            key={`validUntil-${seed("validUntil")}-${idempotencyKey}`}
            id={id}
            name="validUntil"
            defaultValue={seed("validUntil")}
            ariaDescribedBy={describedBy}
            aria-invalid={invalid}
            className={LN_CONTROL_MONO_CLASS}
          />
        )}
      </LnField>

      {state.error && (
        <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && (
        <output className="block text-sm text-[var(--color-ln-ok)]">CVI registrado.</output>
      )}

      <LnButton type="submit" variant="primary" size="lg" block loading={isPending}>
        {isPending ? "Registrando…" : "Registrar CVI"}
      </LnButton>
    </form>
  );
}
