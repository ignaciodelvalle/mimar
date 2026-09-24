import type { ReactNode } from "react";

/**
 * OpKpiSm — compact KPI tile, split out from OpKpi.tsx (W5c, design canon C9).
 *
 * WHY ITS OWN MODULE: OpKpi.tsx also hosts the full-size OpKpi tile — a
 * metric-contract engine (KPI_CATALOG, ProvenanceCard, a dynamic-imported
 * recharts sparkline). A caller that only needs the compact tile (e.g. the
 * landing's decorative console mock, components/landing/story-screens.tsx)
 * used to pull that whole module in as a static import: measured as a 35KB
 * chunk shipped to every anonymous landing visitor (LCP fix, R-2,
 * 2026-09-23). This file has NO heavy imports — just React types — so a
 * caller can import OpKpiSm directly from here and never touch OpKpi.tsx's
 * module graph. OpKpi.tsx re-exports OpKpiSm from here for backward
 * compatibility with existing importers.
 */

export type Tone = "neutral" | "danger" | "warn" | "ok" | "blue";

// Status tones use st-* tokens — resolved to ln-op-* values via .op-surface
// cascade (zero visual diff; see globals.css .op-surface block).
export const toneCard: Record<Tone, string> = {
  neutral: "bg-ln-op-card border-ln-op-line",
  danger: "bg-[var(--color-st-err-bg)] border-[var(--color-st-err-bd)]",
  warn: "bg-[var(--color-st-warn-bg)] border-[var(--color-st-warn-bd)]",
  ok: "bg-[var(--color-st-ok-bg)] border-[var(--color-st-ok-bd)]",
  blue: "bg-ln-op-blue-bg border-ln-op-blue-bd",
};

export const toneValue: Record<Tone, string> = {
  neutral: "text-ln-op-ink",
  danger: "text-[var(--color-st-err)]",
  warn: "text-[var(--color-st-warn)]",
  ok: "text-[var(--color-st-ok)]",
  blue: "text-ln-op-azul",
};

type SmProps = {
  label: string;
  value: ReactNode;
  tone?: Tone;
  sub?: ReactNode;
  href?: string;
};

/**
 * Longest string that still earns the display treatment.
 *
 * The 24px serif value slot is built for NUMBERS — that is what the tabular
 * figures, the tight negative tracking and the `leading-none` are all for. A
 * prose value borrows none of that and pays for it: on /gob/maltrato/[id] the
 * four tiles sit in one row, and "Media — requiere intervención pronto" wrapped
 * to two lines beside a "1 día" that used half of one, leaving the row visibly
 * lopsided (QA 2026-08-07).
 *
 * 16 keeps everything that reads as a value — "100%", "1.234", "12 días",
 * "Sin asignar", "Revisada" — in display, and drops only the sentences.
 */
export const SM_DISPLAY_MAX_CHARS = 16;

/**
 * Compact KPI tile. Smaller value (--text-2xl, 24px), text-xs label, optional
 * hint row. The label said "9px" until 2026-08-10; it renders text-xs, which is
 * 10px (globals.css:251). Same drift as OpStatusPill, same fix: name the token.
 *
 * A long STRING value automatically steps down to body size (see
 * SM_DISPLAY_MAX_CHARS). Automatic rather than a caller prop on purpose: the
 * callers that need it are exactly the ones whose value is computed at runtime,
 * so they cannot know at write time whether this render will be long.
 */
export function OpKpiSm({ label, value, tone = "neutral", sub, href }: SmProps) {
  const cardCls = [
    "flex flex-col rounded-[var(--radius-md)] border p-[11px_13px]",
    "no-underline text-inherit",
    toneCard[tone],
  ].join(" ");

  const isLongProse = typeof value === "string" && value.length > SM_DISPLAY_MAX_CHARS;

  const content = (
    <>
      <div className="mb-1 text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
        {label}
      </div>
      <div
        className={[
          isLongProse
            ? // Body size, normal leading, no tabular figures: this is a
              // sentence, and none of the numeric affordances apply to it.
              "font-ln-serif text-md font-semibold leading-snug"
            : "font-ln-serif text-2xl font-semibold leading-none tracking-[-0.02em] tabular-nums",
          toneValue[tone],
        ].join(" ")}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ln-op-mute">{sub}</div>}
    </>
  );

  if (href) {
    return (
      <a href={href} className={cardCls}>
        {content}
      </a>
    );
  }
  return <div className={cardCls}>{content}</div>;
}
