// OpPill — status pill for case / event states.
//
// Thin semantic wrapper over OpStatusPill; public API is unchanged.
// Maps the OpPill tone enum to canonical StatusTone values.
//
// Tones that map to st-* tokens (standard path):
//   open      → st-warn   (amber — needs action)
//   escalated → st-err    (red)
//   danger    → st-err    (red — escalated and danger share err)
//   closed    → st-ok     (green — resolved)
//   ok        → st-ok     (green)
//   progress  → st-info   (violet — in progress)
//
// Non-status tones (passthrough via neutral-like classes on OpStatusPill):
//   triaged   → uses ln-op-blue-* directly (not a status tone)
//   neutral   → neutral

import type { ReactNode } from "react";

import { OpStatusPill, type StatusTone } from "./OpStatusPill";

type Tone = "open" | "triaged" | "escalated" | "danger" | "progress" | "closed" | "ok" | "neutral";

type Props = {
  tone: Tone;
  children: ReactNode;
};

// Standard st-* tones — delegated to OpStatusPill TONE_CLASSES.
const ST_TONE_MAP: Partial<Record<Tone, StatusTone>> = {
  open: "st-warn",
  escalated: "st-err",
  danger: "st-err",
  closed: "st-ok",
  ok: "st-ok",
  progress: "st-info",
  neutral: "neutral",
};

// Non-status tones that cannot map to StatusTone — rendered with raw ln-op-* classes.
const RAW_TONE_CLASSES: Partial<Record<Tone, string>> = {
  triaged: "bg-ln-op-blue-bg text-ln-op-azul border-ln-op-blue-bd",
};

/**
 * Status pill for case / event states.
 * Mimics .gob-pill from the handoff.
 *
 * Geometry is now unified with OpStatusPill (--radius-op-chip, font-ln-mono).
 * All st-* tones delegate to OpStatusPill; triaged uses raw ln-op-blue-*.
 */
export function OpPill({ tone, children }: Props) {
  const stTone = ST_TONE_MAP[tone];

  if (stTone !== undefined) {
    return <OpStatusPill tone={stTone}>{children}</OpStatusPill>;
  }

  // triaged: uses raw operator blue palette (not a status tone)
  const rawClass = RAW_TONE_CLASSES[tone] ?? "";
  return (
    <span
      className={[
        "inline-flex items-center gap-[3px] rounded-[var(--radius-op-chip)] border px-[7px] py-0.5",
        "font-ln-mono text-xs font-bold uppercase tracking-[0.06em]",
        rawClass,
      ].join(" ")}
    >
      {children}
    </span>
  );
}
