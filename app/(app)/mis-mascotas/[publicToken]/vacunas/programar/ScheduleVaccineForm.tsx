"use client";

import type { ReminderFormState } from "@/app/actions/reminders";
import { LnField, LnInput, LnTextarea } from "@/components/ui/Field";
import { suggestNextDueDate } from "@/lib/domain/libreta-health-status";
import { vaccinesForSpecies } from "@/lib/reference/lookups";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { todayIsoInAr } from "@/lib/utils/format";
import { useActionState, useState } from "react";

const initialState: ReminderFormState = { error: null };

type FormAction = (prev: ReminderFormState, formData: FormData) => Promise<ReminderFormState>;

/**
 * ISO date string (YYYY-MM-DD) for today + N months, in the Argentine calendar.
 *
 * Was `new Date()` -> setMonth -> toISOString().slice(0,10), which reads the
 * date back in UTC: in ART (UTC-3) any local time from 21:00 onwards had
 * already rolled over, so scheduling an Antirrabica reminder at 22:00 on
 * 2026-08-19 pre-filled 2027-08-20. Found in the pre-push review of 2026-08-19
 * as the sibling of the vaccine-sheet defect fixed in 8709fc32 — a different
 * job (this form genuinely means "today + N", it has no application date) but
 * the same slip.
 *
 * Both forms now count months through the same helper the server uses to
 * derive next_due_at, so no two surfaces can disagree about the calendar.
 */
function isoDateFromNowPlusMonths(months: number): string {
  return suggestNextDueDate(todayIsoInAr(), months);
}

export function ScheduleVaccineForm({
  action,
  species,
}: {
  action: FormAction;
  species: string;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  // Nav contract N3 — the use-case returns redirectTo instead of calling
  // redirect(); this performs the full document navigation.
  const isNavigating = useActionRedirect(state.redirectTo, state);
  const vaccines = vaccinesForSpecies(species);
  const [suggestedDate, setSuggestedDate] = useState<string>("");
  const [dateValue, setDateValue] = useState<string>("");
  const [vaccineName, setVaccineName] = useState<string>("");
  const [description, setDescription] = useState<string>("");

  function handleVaccineChange(name: string) {
    setVaccineName(name);
    const def = vaccines.find((v) => v.name.toLowerCase() === name.trim().toLowerCase());
    if (def?.intervalMonths) {
      const suggested = isoDateFromNowPlusMonths(def.intervalMonths);
      setSuggestedDate(suggested);
      // Pre-fill the date only if the user hasn't already entered one.
      setDateValue((prev) => (prev ? prev : suggested));
    }
  }

  return (
    <form action={formAction} className="space-y-5">
      <LnField label="Vacuna" required>
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="vaccineName"
            type="text"
            required
            list="schedule-vaccine-options"
            placeholder="Empezá a tipear o elegí…"
            autoComplete="off"
            aria-describedby={describedBy}
            invalid={invalid}
            value={vaccineName}
            onChange={(e) => handleVaccineChange(e.target.value)}
          />
        )}
      </LnField>
      <datalist id="schedule-vaccine-options">
        {vaccines.map((v) => (
          <option key={v.name} value={v.name} />
        ))}
      </datalist>

      <LnField
        label="Fecha estimada"
        required
        hint={
          suggestedDate
            ? "Fecha sugerida según el intervalo de la vacuna. Podés ajustarla."
            : undefined
        }
      >
        {({ id, describedBy, invalid }) => (
          <LnInput
            id={id}
            name="dueAt"
            type="date"
            required
            value={dateValue}
            onChange={(e) => setDateValue(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      <LnField label="Notas">
        {({ id, describedBy, invalid }) => (
          <LnTextarea
            id={id}
            name="description"
            rows={3}
            placeholder="Cualquier detalle (clínica habitual, dosis, etc.)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </LnField>

      {state.error && (
        <p className="text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || isNavigating}
        className="w-full px-4 py-3 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] text-white font-medium hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending || isNavigating ? "Guardando..." : "Programar vacuna"}
      </button>
    </form>
  );
}
