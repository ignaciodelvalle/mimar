"use client";

// LostFeedItemReport — "Reportar" on one row of the lost-mode feed.
//
// WHY IT EXISTS. Google Play's IARC questionnaire declares this product as one
// where content CAN BE REPORTED. That describes the app as published, so the
// control has to exist — and to exist here too, because the web renders the
// same feed and a protection that depends on which screen you came in through
// is not a protection.
//
// WHAT IS REPORTED, AND WHY THERE IS NO "BLOCK". The two row kinds that carry
// this control were written by an ANONYMOUS stranger who scanned the QR in the
// street: there is no account behind them, so "block this user" has no subject.
// The only honest analogue would be a valve that stops the pet accepting
// reports, and a valve is a defence nobody uses at the moment they need it —
// somebody searching for their animal will not close the channel the message
// that finds it might arrive through.
//
// "Reportar", NEVER "denunciar": in this product `denuncia` already names a
// Ley 14.346 cruelty complaint routed to a real authority.
//
// THE ORG PATH DOES NOT GET THIS CONTROL. `LostCaseBlock` withholds the action
// on its org variant because the server refuses `report_content` there — the
// hide is pet-global, and an organization holding custody could otherwise make
// a finder's "tengo a tu perro" vanish from the owner's own cockpit.
//
// `"use client"` WITH A PRE-BOUND ACTION, the same pattern as
// `LostDisclosureCard`: `LostScanFeed` is a Server Component (it imports
// `lib/infra/lost-mode` → `@/db`), so the interaction lives in this island and
// the action arrives already bound to the `publicToken`.
//
// FULL DOCUMENT NAVIGATION, NOT A LOCAL PATCH AND NOT `router.refresh()`.
// Hiding is a DERIVATION: the reported event is untouched and the list is
// recomputed by subtracting reported ids on EVERY read. Removing the row from
// the DOM by hand would be a second implementation of that subtraction, and the
// first time the two disagreed nobody would know which to trust.
// `router.refresh()` would have been the obvious choice and is BANNED in this
// repo — empty allowlist, `lint:nav` — because it rides the same App Router
// transition machinery that drops silently in production (engram #621/#622).
// The first draft of this file used it anyway; the test caught it, not a
// re-reading.

import { useState, useTransition } from "react";

import { LnButton } from "@/components/ui/Button";
import { notifyActionError, notifySaved } from "@/lib/ui/action-feedback";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import type { ContentReportCategory } from "@dim/contract/events";
import { CONTENT_REPORT_CATEGORIES } from "@dim/contract/events";

/** es-AR copy per motive. Exhaustive over the contract's list. */
const CATEGORY_LABELS: Record<ContentReportCategory, string> = {
  spam: "Publicidad o me piden plata",
  harassment: "Me insultan o me amenazan",
  false_information: "Es información inventada",
  personal_data: "Publica datos de otra persona",
  other: "Otro motivo",
};

/**
 * What happens and — more importantly — what does NOT.
 *
 * The two things people assume wrongly are that the message is erased and that
 * its author is told. Neither is true, and this product promises on every other
 * screen that events are never edited or deleted: a feature that appeared to
 * contradict that would erode the promise which makes the credential worth
 * anything.
 */
const INTRO =
  "El mensaje deja de aparecer en tu búsqueda. No se borra del historial y quien lo escribió no recibe ningún aviso.";

/** The length the spine accepts. Saying so up front beats a 400 afterwards. */
const REASON_MAX = 500;

interface Props {
  /** The row's `id` — which IS a `pet_events.id`. Echoed, never constructed. */
  targetEventId: string;
  /** Server Action pre-bound to the `publicToken` by the Server Component. */
  reportAction: (
    targetEventId: string,
    category: ContentReportCategory,
    reason: string | null,
  ) => Promise<{ error: string | null }>;
}

export function LostFeedItemReport({ targetEventId, reportAction }: Props) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ContentReportCategory | null>(null);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const fieldId = `lp-report-${targetEventId}`;

  function submit() {
    if (category === null) {
      notifyActionError("Elegí un motivo.");
      return;
    }
    const trimmed = reason.trim();
    startTransition(async () => {
      // THE RESULT IS READ, NOT A THROW CAUGHT. In production Next REDACTS the
      // message of an error crossing a Server Action boundary, so a `catch` here
      // would show "An error occurred in the Server Components render" on the one
      // branch a person actually reaches: the list went stale and the item is
      // gone. The `try` stays for what is genuinely exceptional — the call not
      // arriving at all.
      try {
        const result = await reportAction(targetEventId, category, trimmed === "" ? null : trimmed);
        if (result.error !== null) {
          notifyActionError(result.error);
          return;
        }
        notifySaved("Listo. Ese mensaje ya no aparece en tu búsqueda.");
        setOpen(false);
        // TO THE SAME URL: the page is re-derived server-side and the row is
        // gone. It keeps the active face/tab because `href` carries it.
        navigateAfterActionSuccess(window.location.href);
      } catch {
        notifyActionError("No pudimos reportar ese mensaje. Revisá tu conexión.");
      }
    });
  }

  if (!open) {
    return (
      <div className="mt-1.5">
        {/* Deliberately quiet. Reporting must be WITHIN REACH and must not
            compete for attention with "marcá que la encontraste" on the same
            screen. */}
        <LnButton
          variant="ghost"
          size="sm"
          onClick={() => setOpen(true)}
          aria-label="Reportar este mensaje"
        >
          Reportar
        </LnButton>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-ln-line-strong p-3">
      <p className="m-0 text-sm font-semibold text-ln-ink">Reportar un mensaje</p>
      <p className="mt-1 text-xs text-ln-mute">{INTRO}</p>

      <fieldset className="mt-2 border-0 p-0">
        <legend className="text-xs font-semibold text-ln-ink-2">¿Qué pasa con este mensaje?</legend>
        <div className="mt-1 flex flex-col gap-1">
          {CONTENT_REPORT_CATEGORIES.map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm text-ln-ink">
              <input
                type="radio"
                name={fieldId}
                value={option}
                checked={category === option}
                disabled={pending}
                onChange={() => setCategory(option)}
              />
              {CATEGORY_LABELS[option]}
            </label>
          ))}
        </div>
      </fieldset>

      <label
        htmlFor={`${fieldId}-reason`}
        className="mt-2 block text-xs font-semibold text-ln-ink-2"
      >
        Contanos más (opcional)
      </label>
      <textarea
        id={`${fieldId}-reason`}
        value={reason}
        maxLength={REASON_MAX}
        rows={2}
        disabled={pending}
        onChange={(e) => setReason(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ln-line-strong bg-ln-card p-2 text-sm text-ln-ink"
      />

      <div className="mt-2 flex gap-2">
        {/* NO confirmation step, unlike "marcar encontrada": that one closes a
            search and notifies everyone who was looking; this removes a row from
            one person's list and notifies nobody. Putting a safety affordance
            further from the hand than it needs to be is its own failure. */}
        <LnButton size="sm" loading={pending} onClick={submit}>
          Reportar
        </LnButton>
        <LnButton variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
          Cancelar
        </LnButton>
      </div>
    </div>
  );
}
