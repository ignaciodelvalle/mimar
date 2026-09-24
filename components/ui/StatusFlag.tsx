import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { LIST_STATUS_SITUATION_ICON } from "@/lib/ui/pet-situation";
import { lostLabel, registeredAdjective } from "@/lib/utils/format";
import type { LnPetStatus } from "./Chip";

/**
 * Libreta Nacional Status Flag + Vstamp.
 *
 * LnStatusFlag — pet status chip: AL DÍA / EN TRATAMIENTO / PERDIDA / PREÑADA
 * LnVstamp     — vaccination status stamp: Vigente / Por vencer / Vencida
 */

// ---------- Status Flag ---------------------------------------------------

/**
 * A label that inflects with the animal's sex, or one that does not.
 *
 * `flagConfig` used to hold a fixed masculine "PERDIDO" next to a fixed
 * feminine "REGISTRADA", so Luna — a female dog — was flagged PERDIDO on the
 * owner's list while her own credential badge and her lost poster said PERDIDA,
 * in the same session (critique-libreta 2026-07-27, finding #5). The credential
 * had already been swept for exactly this (QA histórico 2026-07-08 #2, which is
 * where `registeredAdjective` comes from); the list was missed.
 *
 * So the two that inflect delegate to `lostLabel` and `registeredAdjective`
 * in lib/utils/format.ts rather than keeping a second opinion here. Note both
 * ALREADY EXISTED — `lostLabel` is used by /perdidas and by the mark-as-lost
 * page, with its own tests; this chip was simply the surface that never
 * adopted it. That includes the slashed "PERDIDO/A" / "REGISTRADO/A" for
 * unknown sex, which is what those surfaces and the credential badge already
 * show for the same pet, and which fits: at 9px mono both are shorter than
 * "EN TRATAMIENTO", which the chip already carries.
 *
 * The rest are invariable — "AL DÍA", "EN TRATAMIENTO", "EN MEMORIA" are noun
 * phrases, and `pregnant` is a female-only state, so it never regenders (same
 * exclusion `situationLabelForSex` documents).
 */
type FlagLabel = string | ((sex: string | null | undefined) => string);

function resolveLabel(label: FlagLabel, sex: string | null | undefined): string {
  return typeof label === "string" ? label : label(sex);
}

const flagConfig: Record<
  LnPetStatus,
  { label: FlagLabel; bg: string; text: string; border: string }
> = {
  ok: {
    label: "AL DÍA",
    bg: "bg-[var(--color-ln-ok-bg)]",
    text: "text-[var(--color-ln-ok)]",
    border: "border-[var(--color-ln-ok-100)]",
  },
  registered: {
    label: (sex) => registeredAdjective(sex).toUpperCase(),
    bg: "bg-[var(--color-ln-card)]",
    text: "text-[var(--color-ln-ink-2)]",
    border: "border-[var(--color-ln-line-strong)]",
  },
  sick: {
    label: "EN TRATAMIENTO",
    bg: "bg-[var(--color-ln-warn-050)]",
    text: "text-[var(--color-ln-warn)]",
    border: "border-[var(--color-ln-warn-100)]",
  },
  lost: {
    label: (sex) => lostLabel(sex).toUpperCase(),
    bg: "bg-[var(--color-ln-err-050)]",
    text: "text-[var(--color-ln-err)]",
    border: "border-[var(--color-ln-err-100)]",
  },
  pregnant: {
    label: "PREÑADA",
    bg: "bg-[var(--color-ln-rosa-bg)]",
    text: "text-[var(--color-ln-rosa)]",
    border: "border-[var(--color-ln-rosa-bd)]",
  },
  // A deceased pet is a closed life record — never "AL DÍA". The chip reads
  // "EN MEMORIA" wherever the single mapper resolves the pet as deceased
  // (PJ-M1), using the same memorial tokens as LnMemorialChip.
  deceased: {
    label: "EN MEMORIA",
    bg: "bg-[var(--color-ln-memorial-chip-bg)]",
    text: "text-[var(--color-ln-memorial-chip-text)]",
    border: "border-[var(--color-ln-memorial-chip-bd)]",
  },
};

export type LnStatusFlagProps = {
  status: LnPetStatus;
  /**
   * The animal's sex, for the labels that inflect (`lost`, `registered`).
   * Optional — omitting it yields the slashed inclusive form, the same one the
   * credential badge already shows when the sex is not on record. Pass it
   * wherever the pet is in hand; a caller that genuinely has no sex to pass is
   * making an honest statement rather than guessing a gender.
   */
  sex?: string | null;
  className?: string;
};

export function LnStatusFlag({ status, sex, className = "" }: LnStatusFlagProps) {
  const cfg = flagConfig[status];
  const label = resolveLabel(cfg.label, sex);
  // Situation icon — the shape-based signal that pairs with the tone + label so
  // the flag never relies on color alone (WCAG). Shared with the credential
  // skin via lib/ui/pet-situation, so a lost pet reads the SAME siren on the
  // list row and on its credential. `registered` is the quiet passive base — no
  // situation, no icon.
  const iconName = LIST_STATUS_SITUATION_ICON[status];
  return (
    <span
      className={[
        "inline-flex items-center gap-[5px] rounded-[var(--radius-xs)] border px-[7px] py-0.5",
        // whitespace-nowrap: a status pill is a single token and must never
        // break across two lines. It never wrapped while the font-family
        // utility was dead (SC-7) because the flag rendered in the inherited
        // Encode Sans; IBM Plex Mono is wider, and the narrowest caller — the
        // "AL DÍA" flag in the landing phone mock — lost by 0.9px and broke
        // into a two-line pill (measured 70x34.8 vs 70.9x20.4 for its
        // identical siblings). Nowrap fixes the whole primitive rather than
        // that one caller.
        "whitespace-nowrap",
        "font-ln-mono text-[9px] font-semibold uppercase tracking-[.12em]",
        cfg.bg,
        cfg.text,
        cfg.border,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {iconName && <Icon name={iconName} size={11} decorative />}
      {label}
    </span>
  );
}

// ---------- Vstamp --------------------------------------------------------

export type LnVstampVariant = "ok" | "due" | "over" | "unknown";

const vstampConfig: Record<
  LnVstampVariant,
  { label: string; bg: string; text: string; border: string }
> = {
  ok: {
    label: "VIGENTE",
    bg: "bg-[var(--color-ln-ok-050)]",
    text: "text-[var(--color-ln-ok)]",
    border: "border-[var(--color-ln-ok-100)]",
  },
  due: {
    label: "POR VENCER",
    bg: "bg-[var(--color-ln-warn-025)]",
    text: "text-[var(--color-ln-warn)]",
    border: "border-[var(--color-ln-warn-100)]",
  },
  over: {
    label: "VENCIDA",
    bg: "bg-[var(--color-ln-err-bg)]",
    text: "text-[var(--color-ln-err)]",
    border: "border-[var(--color-ln-err-100)]",
  },
  // No next_due_at on record — "we don't know" must never read as "vigente"
  // (state-honesty audit). Neutral tokens, same combo as LnBadge's `neutral`
  // variant and the appointment "cancelado" badges.
  unknown: {
    label: "SIN DATO",
    bg: "bg-[var(--color-ln-stripe)]",
    text: "text-[var(--color-ln-mute)]",
    border: "border-[var(--color-ln-line-strong)]",
  },
};

export type LnVstampProps = {
  variant: LnVstampVariant;
  /**
   * Overrides the variant's default word. Exists for the ONE caller whose stamp
   * is not a vaccine-currency claim: the credential's compliance summary, where
   * `ok` means "every obligation is met" and must read AL DÍA, not VIGENTE
   * (unified pill vocabulary, PO 2026-08-06 — three adjacent greens spoke three
   * grammars). Tone and geometry stay the variant's; only the word changes.
   */
  label?: string;
  /**
   * Trailing datum appended after a "·" — e.g. `hasta 14/01/2027`, so a VIGENTE
   * pill says until WHEN rather than making the reader hunt for the date in the
   * line below it. Omit when there is no date on record: the bare adjective is
   * the honest fallback, never a fabricated one.
   */
  detail?: string | null;
  className?: string;
};

export function LnVstamp({ variant, label, detail, className = "" }: LnVstampProps) {
  const cfg = vstampConfig[variant];
  return (
    <span
      className={[
        "inline-flex items-center gap-[5px] rounded-[var(--radius-xs)] border px-2 py-[3px]",
        // Same reason as LnStatusFlag above: a status pill is one token and must
        // never break across two lines — and the optional `detail` suffix makes
        // this stamp materially wider than it used to be.
        "whitespace-nowrap",
        "font-ln-mono text-xs font-semibold uppercase tracking-[.08em]",
        cfg.bg,
        cfg.text,
        cfg.border,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {label ?? cfg.label}
      {detail ? ` · ${detail}` : ""}
    </span>
  );
}

// ---------- Memorial chip -------------------------------------------------
// Used in the deceased profile sub-bar

export function LnMemorialChip({
  className = "",
  children,
}: {
  className?: string;
  /** Overrides the default "En memoria" label — e.g. to append a birth–death year range. */
  children?: ReactNode;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border border-[var(--color-ln-memorial-chip-bd)] bg-[var(--color-ln-memorial-chip-bg)] px-2.5 py-[3px]",
        "font-ln-mono text-xs uppercase tracking-[.1em] text-[var(--color-ln-memorial-chip-text)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children ?? "En memoria"}
    </span>
  );
}
