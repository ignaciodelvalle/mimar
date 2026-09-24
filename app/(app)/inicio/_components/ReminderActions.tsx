"use client";

// ReminderActions — Posponer + Agendar + Registrar buttons (handoff P4-4).
//
// Client island wrapping the server actions. "Posponer" calls
// snoozeReminderAction with optimistic UI (the reminder hides
// immediately; if the action fails it reappears and shows the error).
// "Agendar" navigates to /turnos/buscar with prefilters so the user
// books a real appointment for the vaccine. "Registrar" goes to the
// FULL vaccine form with reminderId — the canonical reminder-linked
// path (same one PetReminders uses). The old ?sheet=vacuna&text= link
// put the title in NOTES and dropped the reminder linkage, so the hot
// vencimiento path registered a nameless dose and never closed the
// reminder (flow audit 2026-07-03 #2; PO decision: reminder flows never
// hit the sheet — it stays ad-hoc quick capture only).

import { useState, useTransition } from "react";

import { snoozeReminderAction } from "@/app/actions/reminders";
import { notifySaved } from "@/lib/ui/action-feedback";
import { buildReminderVaccineUrl } from "@/lib/ui/reminder-urls";

interface Props {
  reminderId: string;
  petToken: string;
  /** Visual variant — controls primary button styling. */
  variant: "banner" | "row";
}

export function ReminderActions({ reminderId, petToken, variant }: Props) {
  const [pending, startTransition] = useTransition();
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registerHref = buildReminderVaccineUrl(petToken, reminderId);
  // /turnos/buscar reads `service_kind` (not `service`/`pet`). The pet is chosen
  // later at reserve time via the booking form's pet selector, so only the
  // service kind needs to travel. vaccination_rabies is the generic vaccination
  // entry point — applies to both dogs and cats, and the user can switch kinds
  // with the on-page service filter.
  const scheduleHref = "/turnos/buscar?service_kind=vaccination_rabies";

  if (hidden) return null;

  function postpone() {
    setError(null);
    // Optimistic hide — the reminder fades from the section immediately.
    // If the server fails, surface the error and re-show.
    setHidden(true);
    startTransition(async () => {
      const result = await snoozeReminderAction(reminderId);
      if ("error" in result && result.error) {
        setHidden(false);
        setError(result.error);
        return;
      }
      // Tier B: the optimistic hide IS the terminal UI state — no server
      // re-fetch needed (the next SSR render reads the new snoozed_until).
      // The old router.refresh() here was banned (silent-drop defect, see
      // lib/ui/full-page-action-nav.ts) and a dropped/failed refresh could
      // even resurrect the snoozed row visually. The toast is the
      // confirmation instead (mutation-feedback convention).
      notifySaved("Recordatorio pospuesto 7 días");
    });
  }

  const buttonBase =
    "inline-flex shrink-0 items-center justify-center rounded-full text-xs font-semibold";

  return (
    <div className={variant === "banner" ? "flex flex-wrap items-center gap-2" : "flex gap-1.5"}>
      <a
        href={scheduleHref}
        className={`${buttonBase} px-3 py-1.5 border border-[var(--color-ln-line-strong)] text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]`}
      >
        Agendar
      </a>
      <button
        type="button"
        onClick={postpone}
        disabled={pending}
        className={`${buttonBase} px-3 py-1.5 text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink)] disabled:opacity-50`}
      >
        {pending ? "Posponiendo…" : "Posponer 7 días"}
      </button>
      <a
        href={registerHref}
        className={`${buttonBase} ${
          variant === "banner" ? "px-5 py-2 text-sm" : "px-3 py-1.5"
        } bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)]`}
      >
        Registrar
      </a>
      {error && (
        <span className="text-xs text-[var(--color-ln-err)] ml-2" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
