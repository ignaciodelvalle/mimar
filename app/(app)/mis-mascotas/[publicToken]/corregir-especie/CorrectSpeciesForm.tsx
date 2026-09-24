"use client";

// Species correction form (FULL-LOCK, PO decision #40). Species is read-only on
// the profile-edit form; a genuine correction flows through this dedicated
// affordance, which calls correctPetSpeciesAction — the action emits a
// pet_profile_updated event (audit trail) before updating the column.

import { LnField, LnSelect } from "@/components/ui/Field";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { speciesOptions } from "@/lib/utils/format";
import type { NewPetFormState } from "@/src/modules/pets/actions";
import { useActionState } from "react";

const initialState: NewPetFormState = { error: null };

type FormAction = (prev: NewPetFormState, formData: FormData) => Promise<NewPetFormState>;

// Las seis especies del dominio. Los valores son el enum; la ortografía sale de
// speciesLabel, que es la única fuente.
const SPECIES_OPTIONS = speciesOptions(["dog", "cat", "rabbit", "guinea_pig", "ferret", "other"]);

export function CorrectSpeciesForm({
  action,
  currentSpecies,
  petName,
}: {
  action: FormAction;
  currentSpecies: string;
  petName: string;
}) {
  // THE WORST DIRECTION A RESET CAN TAKE, and this form is the clearest case
  // of it in the repo. React 19 resets a `<form action>` when the action
  // settles, error included, and a `<select>` goes back to its `defaultValue`
  // attribute. Here that attribute is `currentSpecies` — the WRONG species the
  // person opened this screen to correct. So a rejected submit does not leave
  // them with an empty field to refill; it silently puts the mistake back, and
  // a wrong value looks like an answer. The species feeds the PPP /
  // dangerous-breed rules, so it is not cosmetic.
  const { boundAction, kept } = useKeptFields(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  // N3: the action returns where to go and this navigates. It used to
  // redirect() server-side — a transition the App Router drops in production,
  // so the edit saved and the screen never moved.
  useActionRedirect(state.redirectTo, state);

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        Corregí la especie de <strong>{petName}</strong> solo si se cargó mal. El cambio queda
        registrado en la libreta y vuelve a evaluar las reglas PPP.
      </p>

      <LnField label="Especie correcta" required>
        {({ id, describedBy, invalid }) => (
          <LnSelect
            id={id}
            name="species"
            required
            key={`species-${kept("species") || currentSpecies}`}
            defaultValue={kept("species") || currentSpecies}
            aria-describedby={describedBy}
            invalid={invalid}
          >
            {SPECIES_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      {state.error && (
        <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
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
        {isPending ? "Guardando..." : "Corregir especie"}
      </button>
    </form>
  );
}
