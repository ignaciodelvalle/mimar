"use client";

// FirstStepsChecklist — "Primeros pasos" owner-onboarding checklist row list.
//
// Renders the PENDING rows from deriveFirstStepsChecklist (lib/projections/
// first-steps-checklist.ts): a step is either done (derived live from the
// pet's own data — the row disappears on its own) or dismissed ("Omitir" —
// this component's only client behavior). Each row links to the sheet that
// lets the owner act ("Hacerlo") via SheetTriggerLink, the canonical way to
// open a `?sheet=` on this page (see that component's docblock).
//
// Dismiss is OPTIMISTIC-TERMINAL (Tier B, same posture as FutureLedgerList's
// "Posponer 7 días"): on success the row hides immediately client-side; the
// next SSR render reads the persisted dismissedFirstSteps array, so nothing
// re-fetches. Dismissing never disables the underlying capability — the
// owner can still open the same sheet later from anywhere else on the
// profile; "Omitir" only silences THIS nudge.
//
// The whole section (including its "Primeros pasos" divider) is owned by the
// caller (CredentialFace) — this component renders nothing when the visible
// list empties out, so the caller's `items.length > 0` gate and this
// component's own empty state never disagree.

import { useState, useTransition } from "react";

import { dismissFirstStepAction } from "@/app/actions/pet-onboarding";
import { Icon } from "@/components/Icon";
import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";
import type { FirstStepItem } from "@/lib/projections/first-steps-checklist";
import { notifySaved } from "@/lib/ui/action-feedback";

function FirstStepRow({
  item,
  petPublicToken,
  onDismissed,
}: {
  item: FirstStepItem;
  petPublicToken: string;
  onDismissed: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function omit() {
    startTransition(async () => {
      await dismissFirstStepAction(petPublicToken, item.key);
      onDismissed();
      // Optimistic-terminal, no reload — the toast is the confirmation
      // (mutation-feedback convention, lib/ui/action-feedback.ts).
      notifySaved("Paso omitido");
    });
  }

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        aria-hidden
        className={[
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)]",
          item.star
            ? "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]"
            : "bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink-2)]",
        ].join(" ")}
      >
        <Icon name={item.star ? "star" : "circle-dot"} size="sm" decorative />
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium text-[var(--color-ln-ink)]">
        {item.label}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <SheetTriggerLink
          href={item.actionHref}
          className="font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          {item.actionLabel} →
        </SheetTriggerLink>
        <button
          type="button"
          onClick={omit}
          disabled={pending}
          className="text-xs text-[var(--color-ln-mute)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-ln-ink-2)] disabled:opacity-50"
        >
          {pending ? "…" : "Omitir"}
        </button>
      </span>
    </li>
  );
}

export function FirstStepsChecklist({
  items,
  petPublicToken,
}: {
  items: FirstStepItem[];
  petPublicToken: string;
}) {
  // Rows hidden after a successful "Omitir" — optimistic-terminal, same
  // contract as FutureLedgerList's snoozedIds.
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const visible = items.filter((item) => !dismissedIds.has(item.key));
  if (visible.length === 0) return null;

  return (
    <ul data-section="first-steps-list" className="divide-y divide-[var(--color-ln-line)]">
      {visible.map((item) => (
        <FirstStepRow
          key={item.key}
          item={item}
          petPublicToken={petPublicToken}
          onDismissed={() =>
            setDismissedIds((prev) => {
              const next = new Set(prev);
              next.add(item.key);
              return next;
            })
          }
        />
      ))}
    </ul>
  );
}
