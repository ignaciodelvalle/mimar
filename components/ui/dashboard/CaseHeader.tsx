// CaseHeader — shared presentational header for case-shaped detail pages.
//
// One header grammar for every "expediente"-like record: an optional code
// badge, a status chip, an optional inline aside (e.g. severity), the kind
// title, and a mono meta line.
//
// The status chip is DELIBERATELY decoupled from any single domain enum: the
// caller passes an already-resolved `{ label, tone }`. This lets records whose
// status enum does NOT match `CaseStatus` (e.g. welfareReports:
// open/triaged/in_progress/closed/duplicate/invalid) reuse the exact same
// header without forcing an enum mismatch — each caller maps its own status to
// the canonical StatusTone vocabulary.
//
// Presentational only: no data fetching, no domain logic.

import type { ReactNode } from "react";

import { OpStatusPill, type StatusTone } from "./OpStatusPill";

export interface CaseHeaderStatus {
  label: string;
  tone: StatusTone;
}

export interface CaseHeaderProps {
  /** Case kind / heading title. */
  title: string;
  /**
   * Already-resolved status chip. Each caller maps its own domain enum to a
   * canonical `{ label, tone }` so this primitive stays enum-agnostic.
   */
  status: CaseHeaderStatus;
  /**
   * Optional code badge (publicCode / referenceCode). Rendered before the
   * status chip in the badge row. Callers typically pass an <OpCodeBadge>.
   */
  code?: ReactNode;
  /**
   * Optional extra inline element after the status chip (e.g. a severity
   * label). Rendered in the same badge row.
   */
  aside?: ReactNode;
  /** Mono meta line under the title (timestamps, reference code, etc.). */
  meta?: ReactNode;
}

/**
 * Shared case-detail header. Apply to every case-shaped detail surface so the
 * title + status + meta presentation is identical cross-kind.
 */
export function CaseHeader({ title, status, code, aside, meta }: CaseHeaderProps) {
  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {code}
        <OpStatusPill tone={status.tone}>{status.label}</OpStatusPill>
        {aside}
      </div>
      <h1 className="font-ln-serif text-2xl font-semibold tracking-[-0.02em] text-ln-op-ink">
        {title}
      </h1>
      {meta ? <p className="font-ln-mono text-sm text-ln-op-mute">{meta}</p> : null}
    </header>
  );
}
