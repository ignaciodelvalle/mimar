// ConfidenceBadge — compact chip showing a pet event's confidence tier.
//
// Decision A7 (plan 2026-05-22): labels are descriptive ("Verificado por
// veterinario matriculado"), NOT judgmental ("high confidence"). The owner
// must not feel degraded when their self-reported event shows a lower tier.
//
// Styling follows Libreta Nacional token set (ln-* CSS custom properties).
//
// RA-10 (d), radius consolidation. This was the badge family's ONLY untokenized
// corner: a bare `rounded` (Tailwind's 4px default). It reads as a status stamp
// and it renders side by side with LnVstamp and LnBadge on the two surfaces that
// matter most — the public credential's "Vacunación:" row and the owner's
// libreta — where both of those are `--radius-xs` (2px). Three shapes for one
// role on one card was the visible defect; this is now the third of three.
//
// The rest of the survey came out CORRECT-PER-ROLE and was deliberately left
// alone: citizen chips are pills (CaseBadge/AuthorChip/AmendedBadge/LnChip),
// operator badges share the repo-wide 3px geometry that OpStatusPill documents
// and components/ui/REGISTRY.md pins, and LnChip's status DOTS vary their
// corners on purpose — shape carries the meaning so the state is never
// signalled by color alone.

import { type ConfidenceTier, confidenceLabel } from "@/lib/events/event-confidence";

interface Props {
  tier: ConfidenceTier;
  className?: string;
}

const TIER_STYLES: Record<ConfidenceTier, string> = {
  institutional_verified: "bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]",
  professional_verified: "bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]",
  // org_registered (VET keystone #43): a record, not a verification — a neutral
  // tone that never reads as the green/celeste "verified" chips above it.
  org_registered: "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
  corroborated: "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]",
  self_reported: "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
  unverified: "bg-[var(--color-ln-stripe)] text-[var(--color-ln-faint)]",
};

export function ConfidenceBadge({ tier, className = "" }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-xs)] px-1.5 py-0.5 text-xs font-medium ${TIER_STYLES[tier]} ${className}`.trim()}
    >
      {confidenceLabel(tier)}
    </span>
  );
}
