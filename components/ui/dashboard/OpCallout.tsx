import type { ReactNode } from "react";

type Props = {
  /** Short bold label. */
  title: string;
  /** Body text or content. */
  body?: ReactNode;
  /**
   * Icon slot rendered inside the tinted box (left side).
   * Pass any React node — emoji, SVG, or text glyph.
   */
  icon?: ReactNode;
  /**
   * Epistemic nature (C4, 2026-07-22 — plan-maestro-integridad §C4). Mirrors
   * LnEmptyState's `nature` prop for OpCallout's own use as an inline
   * "no rows" empty-state fallback (e.g. /admin/observaciones' "Sin
   * observaciones"). Omit for the default info/navy treatment — the
   * existing OpCallout callers (jurisdiction warnings, generic notices) are
   * the ratchet and are unaffected.
   *  - "measured-zero": default navy/info treatment is fine (a real zero).
   *  - "no-signal": miMAR received no report at all — renders a muted-warn
   *    treatment instead of the calm navy/info look, so an empty
   *    surveillance list can't read as "todo tranquilo".
   */
  nature?: "measured-zero" | "no-signal";
};

/**
 * Info callout with a left icon box.
 *
 * Visually derived from .gob-callout (redesign-a-gob.css L381-386).
 * Uses ln-op-card + ln-op-line for the card surface and ln-op-navy for the icon box.
 */
export function OpCallout({ title, body, icon, nature }: Props) {
  const isNoSignal = nature === "no-signal";
  return (
    <div
      role={isNoSignal ? "status" : undefined}
      className={[
        "mb-3 flex items-center gap-3.5 rounded-[var(--radius-md)]",
        isNoSignal
          ? "border border-ln-op-warn-bd bg-ln-op-warn-bg"
          : "border border-ln-op-line bg-ln-op-card",
        "px-[18px] py-[15px]",
      ].join(" ")}
    >
      {icon && (
        <div
          className={[
            "grid h-9 w-9 flex-shrink-0 place-items-center rounded-[var(--radius-md)] text-base text-white",
            isNoSignal ? "bg-ln-op-warn" : "bg-ln-op-navy",
          ].join(" ")}
        >
          {icon}
        </div>
      )}

      <div className="flex-1">
        <b
          className={[
            "mb-0.5 block text-md font-bold",
            isNoSignal ? "text-ln-op-warn" : "text-ln-op-ink",
          ].join(" ")}
        >
          {title}
        </b>
        {body && <span className="text-sm leading-[1.5] text-ln-op-ink-2">{body}</span>}
      </div>
    </div>
  );
}
