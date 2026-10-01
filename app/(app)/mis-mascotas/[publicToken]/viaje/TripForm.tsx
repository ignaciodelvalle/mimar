"use client";

// Record a trip (viajes-fase-2, task 5.3). Posts to recordTripAction
// (src/modules/pets/travel-actions.ts) — the same use-case
// `POST /api/v1/pets/{publicToken}/travel` `record_trip` runs.
//
// IDEMPOTENCY. The hidden `idempotencyKey` is minted by the page (server) for
// the first submit and renewed here after each success, so a double submit of
// one filled form is ONE trip — the replay answers the first write.
//
// React 19 resets the form when the action settles, error included, so every
// field re-seeds from useKeptFields; after a SUCCESS it re-seeds from nothing,
// which is what clears the form for the next trip.

import { useActionState, useEffect, useState } from "react";

import { LnButton } from "@/components/ui/Button";
import { DateInputAr } from "@/components/ui/DateInputAr";
import { LN_CONTROL_MONO_CLASS, LnField, LnSelect } from "@/components/ui/Field";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { TravelFormState } from "@/src/modules/pets/application/travel/types";

const initialState: TravelFormState = { error: null };

type FormAction = (prev: TravelFormState, formData: FormData) => Promise<TravelFormState>;

export type TripFormOption = { id: string; label: string };

const MODE_OPTIONS: TripFormOption[] = [
  { id: "air", label: "En avión" },
  { id: "land", label: "Por tierra" },
  { id: "sea", label: "En barco" },
];

const MODALITY_OPTIONS: TripFormOption[] = [
  { id: "cabin", label: "En cabina" },
  { id: "hold", label: "En bodega" },
  { id: "cargo", label: "Como carga" },
];

export function TripForm({
  action,
  corridors,
  airlines,
  initialIdempotencyKey,
}: {
  action: FormAction;
  corridors: TripFormOption[];
  airlines: TripFormOption[];
  initialIdempotencyKey: string;
}) {
  const { boundAction, kept } = useKeptFields<TravelFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [idempotencyKey, setIdempotencyKey] = useState(initialIdempotencyKey);
  // The page reloads as a full document onto the new trip (N3 contract).
  const navigating = useActionRedirect(state.redirectTo, state);
  const busy = isPending || navigating;

  // A success is a new trip on the spine: the next submit is a different one.
  useEffect(() => {
    if (state.ok) setIdempotencyKey(crypto.randomUUID());
  }, [state]);

  // After a success nothing is kept — the form clears for the next trip.
  const seed = (name: string) => (state.ok ? "" : kept(name));

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <LnField label="Destino" required>
        {({ id, describedBy }) => (
          <LnSelect
            id={id}
            name="corridorId"
            key={`corridorId-${seed("corridorId")}-${idempotencyKey}`}
            defaultValue={seed("corridorId")}
            required
            aria-describedby={describedBy}
          >
            <option value="">Elegí el país</option>
            {corridors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      <LnField label="Fecha de salida" required>
        {({ id, describedBy, invalid }) => (
          <DateInputAr
            key={`travelDate-${seed("travelDate")}-${idempotencyKey}`}
            id={id}
            name="travelDate"
            defaultValue={seed("travelDate")}
            required
            ariaDescribedBy={describedBy}
            aria-invalid={invalid}
            className={LN_CONTROL_MONO_CLASS}
          />
        )}
      </LnField>

      <LnField
        label="Cómo viaja"
        hint="Si elegís una aerolínea, queda registrado como viaje en avión."
      >
        {({ id, describedBy }) => (
          <LnSelect
            id={id}
            name="mode"
            key={`mode-${seed("mode")}-${idempotencyKey}`}
            defaultValue={seed("mode")}
            aria-describedby={describedBy}
          >
            <option value="">Sin indicar</option>
            {MODE_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      <LnField label="Aerolínea">
        {({ id, describedBy }) => (
          <LnSelect
            id={id}
            name="airlineId"
            key={`airlineId-${seed("airlineId")}-${idempotencyKey}`}
            defaultValue={seed("airlineId")}
            aria-describedby={describedBy}
          >
            <option value="">Sin aerolínea elegida</option>
            {airlines.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </LnSelect>
        )}
      </LnField>

      <LnField
        label="Dónde viaja la mascota"
        hint="Cada aerolínea tiene reglas distintas para cabina, bodega y carga."
      >
        {({ id, describedBy }) => (
          <LnSelect
            id={id}
            name="intendedModality"
            key={`intendedModality-${seed("intendedModality")}-${idempotencyKey}`}
            defaultValue={seed("intendedModality")}
            aria-describedby={describedBy}
          >
            <option value="">Sin indicar</option>
            {MODALITY_OPTIONS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
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
      {state.ok && (
        <output className="block text-sm text-[var(--color-ln-ok)]">Viaje registrado.</output>
      )}

      <LnButton type="submit" variant="primary" size="lg" block loading={busy}>
        {busy ? "Registrando…" : "Registrar viaje"}
      </LnButton>
    </form>
  );
}
