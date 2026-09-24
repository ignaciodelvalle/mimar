"use client";

// Client wrapper for the slot booking form.
// Surfaces server-action errors (e.g. race-condition "Sin cupo disponible.")
// using useActionState. On success the action RETURNS its destination and this
// form navigates (nav contract N3) — it used to redirect() server-side, which
// the App Router drops in production: the slot was booked and the user was left
// looking at the form.

import { useActionState, useEffect, useState } from "react";

import { type BookSlotResult, bookSlotAction } from "@/app/actions/booking";
import { LnButton } from "@/components/ui/Button";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";

type BookingState = { error: string | null; redirectTo?: string | null };

const initialState: BookingState = { error: null };

// Adapter: useActionState requires (prevState, formData) => state.
function makeFormAction(slotId: string) {
  return async (_prev: BookingState, formData: FormData): Promise<BookingState> => {
    const petId = String(formData.get("petId") ?? "").trim();
    if (!petId) return { error: "Seleccioná una mascota." };
    const result: BookSlotResult = await bookSlotAction(slotId, petId);
    if ("error" in result) return { error: result.error };
    return { error: null, redirectTo: result.redirectTo ?? null };
  };
}

export function BookingFormClient({
  slotId,
  userPets,
}: {
  slotId: string;
  userPets: Array<{ id: string; name: string; species: string }>;
}) {
  const formAction = makeFormAction(slotId);
  // forms/react19-reset-data-loss-inventory: "petId" is an uncontrolled
  // <select> — a rejected submit (e.g. "Sin cupo disponible.") falls it back
  // to its first (empty) option, discarding whichever pet was chosen.
  const { boundAction, kept } = useKeptFields<BookingState>(formAction);
  const [state, dispatch, pending] = useActionState(boundAction, initialState);
  useActionRedirect(state.redirectTo, state);

  // Hydration gate (the documented task-#39 dropped-click class, QA repro on
  // this form): `dispatch` is a CLIENT closure, so this form gets no
  // progressive-enhancement POST — a click before hydration attaches handlers
  // silently no-ops. Ship the button disabled in the SSR HTML (honest
  // affordance: LnButton's disabled opacity/cursor) and enable it in the
  // mount effect, which by definition runs only once hydration made the
  // submit actionable. Same mounted-flag idiom as DegradedFallback /
  // MilestoneNav.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <form action={dispatch} className="flex flex-col gap-4">
      <div>
        <label
          htmlFor="pet_select"
          className="mb-1.5 block font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
        >
          ¿Para qué mascota?
        </label>
        <select
          id="pet_select"
          name="petId"
          key={`pet_select-${kept("petId")}`}
          required
          defaultValue={kept("petId")}
          className="w-full appearance-none rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2.5 font-ln-sans text-md text-[var(--color-ln-ink)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
        >
          <option value="">Elegí una mascota…</option>
          {userPets.map((pet) => (
            <option key={pet.id} value={pet.id}>
              {pet.name}
            </option>
          ))}
        </select>
      </div>

      {state.error && (
        <p className="text-sm font-medium text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}

      {/* loading (not bare disabled) while the action runs: spinner + aria-busy
          make the in-flight state visible instead of a mute disabled button. */}
      <LnButton
        type="submit"
        variant="primary"
        size="lg"
        block
        disabled={!hydrated}
        loading={pending}
      >
        {pending ? "Reservando…" : "Confirmar reserva"}
      </LnButton>
    </form>
  );
}
