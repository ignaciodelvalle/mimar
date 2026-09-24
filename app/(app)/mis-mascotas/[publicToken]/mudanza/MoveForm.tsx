"use client";

// Move form (FULL-LOCK jurisdiction path, PO decision #40). Jurisdiction is
// read-only on the profile-edit form; an owner changes a pet's locality here.
// recordMoveAction is the ONLY owner-facing writer of movement_recorded /
// jurisdiction_changed and canonicalizes the destination against the INDEC
// catalog before the event + denormalization.

import { LocationFields } from "@/components/LocationFields";
import { LnField, LnInput } from "@/components/ui/Field";
import { provinceByName } from "@/lib/reference/ar-provincias";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { NewPetFormState } from "@/src/modules/pets/actions";
import { type FormEvent, useActionState, useState } from "react";

const initialState: NewPetFormState = { error: null };

type FormAction = (prev: NewPetFormState, formData: FormData) => Promise<NewPetFormState>;

export function MoveForm({
  action,
  petName,
  currentProvince,
  currentLocality,
}: {
  action: FormAction;
  petName: string;
  currentProvince: string | null;
  currentLocality: string | null;
}) {
  // forms/react19-reset-data-loss-inventory: "reason" is a bare uncontrolled
  // field — a rejected submit (e.g. missing locality) wipes it.
  const { boundAction, kept } = useKeptFields<NewPetFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: recordMoveAction returns the destination; this navigates. It used to
  // redirect() server-side, which the App Router drops — the move was recorded
  // and the owner stayed on the form.
  useActionRedirect(state.redirectTo, state);
  const [clientError, setClientError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    const localityValue = String(new FormData(e.currentTarget).get("localityName") ?? "").trim();
    if (!localityValue) {
      e.preventDefault();
      setClientError("Seleccioná la localidad de destino.");
      return;
    }
    setClientError(null);
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} className="flex flex-col gap-3.5">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        Registrá la nueva localidad de <strong>{petName}</strong>. El movimiento queda asentado en
        la libreta y actualiza la jurisdicción de la mascota.
      </p>

      <div className="flex flex-col gap-1.5">
        <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
          Localidad actual:{" "}
          <strong>
            {[currentLocality, currentProvince].filter(Boolean).join(", ") || "Sin localidad"}
          </strong>
        </p>
        <LocationFields
          mode="l1"
          required
          cascade
          defaultValue={{
            provinceCode: provinceByName(currentProvince)?.code ?? null,
            localityName: currentLocality,
          }}
        />
      </div>

      <LnField label="Motivo (opcional)">
        {({ id, describedBy }) => (
          <LnInput
            id={id}
            name="reason"
            type="text"
            defaultValue={kept("reason")}
            placeholder="Mudanza, cambio de tenencia…"
            aria-describedby={describedBy}
          />
        )}
      </LnField>

      {(clientError ?? state.error) && (
        <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
          {clientError ?? state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className={[
          "inline-flex w-full cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border px-4 py-2.5 text-md font-semibold text-white transition-colors",
          "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] hover:bg-[var(--color-ln-azul-700)] hover:border-[var(--color-ln-azul-700)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
        ].join(" ")}
      >
        {isPending ? "Guardando..." : "Registrar mudanza"}
      </button>
    </form>
  );
}
