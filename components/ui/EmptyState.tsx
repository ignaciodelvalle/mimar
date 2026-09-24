import { Icon, type IconName } from "@/components/Icon";
import type { ReactNode } from "react";

/**
 * LnEmptyState — generic empty state for lists, panels, and sections.
 *
 * Styled with the sk-* and st-* indirection tokens (globals.css): this component
 * renders on BOTH skins (65 callers, 41 of them operator surfaces), so its
 * neutrals and warn treatment must resolve per context instead of hardcoding
 * citizen ln-* values on a navy operator canvas (token audit 2026-08-06).
 *
 * Vertical centred structure:
 *  [large muted icon]
 *  [title — font-semibold]
 *  [description — small muted, optional]
 *  [action — slot for a CTA, optional]
 *
 * Variants:
 *  - "plain" (default): no border; used for full-page or padded panel empty states.
 *  - "dashed": adds a dashed rounded border (ln-line-strong) for inline section
 *    empty states that need a visual boundary within a content area.
 *
 * Epistemic nature (C4, 2026-07-22 — plan-maestro-integridad §C4, kills the
 * rest of S4): Wave 2's state system guarantees a state EXISTS, not that it
 * tells the epistemic truth. An empty surveillance list reads as "todo
 * tranquilo" when the honest reading can be "miMAR no recibió señales — el
 * silencio no implica ausencia de enfermedad" (red-team #10 zeros=green, #6
 * 690 bites + 0 observations read as "under control"). `nature` names the
 * two readings explicitly:
 *  - "measured-zero": miMAR queried and the honest answer IS 0 (a real
 *    count). Renders the existing neutral/plain look — no visual change.
 *  - "no-signal": nothing was reported INTO the system — miMAR is blind on
 *    this question, not calm. Renders a distinct muted-warn treatment
 *    (never the neutral/success look, never alarm-red either) so a silent
 *    surveillance surface can't be misread as "under control".
 * Omitting the prop keeps today's behavior (identical to "measured-zero") —
 * the ~90 existing callers are the ratchet; only new surveillance-safety
 * surfaces are required to declare it (see scripts/check-state-coverage.ts).
 *
 * Accessibility:
 *  - Static state; does not change dynamically. `nature="no-signal"` adds
 *    `role="status"` since it is information the operator should notice,
 *    not decorative chrome.
 *  - Icon is decorative (aria-hidden).
 *
 * `action` (copy audit 2026-08-04, S8): an empty state without a next step is
 * a dead end, not a status message — pass a Link/LnButton here whenever there
 * is something the user could do about it (a CTA to create the first record,
 * a "Limpiar filtros" link, a link back to a related screen). NEVER pair an
 * `action` with `nature="no-signal"`/`"protected"` copy that is disclosing a
 * k-anonymity suppression or a "we don't have this data" epistemic gap — a
 * cheerful CTA over a suppression notice misrepresents which one this is.
 * Table/queue primitives that pre-date this component and take a plain
 * `emptyMessage` string (no ReactNode slot) — e.g.
 * components/ui/dashboard/CaseQueue.tsx — get the same treatment via a
 * sibling `emptyAction?: ReactNode` prop instead of this one.
 */

export type LnEmptyStateProps = {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
  /** @default "plain" */
  variant?: "plain" | "dashed";
  /**
   * Epistemic nature of this empty state. Omit for today's behavior
   * (equivalent to "measured-zero"). See the block comment above.
   */
  nature?: "measured-zero" | "no-signal" | "protected";
  className?: string;
};

export function LnEmptyState({
  icon,
  title,
  description,
  action,
  variant = "plain",
  nature,
  className = "",
}: LnEmptyStateProps) {
  // "protected" shares no-signal's warning treatment: in BOTH the operator is
  // being told they cannot see something, which is the state that must never
  // read as reassurance. What differs is the CAUSE, and the copy says which.
  const isNoSignal = nature === "no-signal" || nature === "protected";
  return (
    <div
      role={isNoSignal ? "status" : undefined}
      className={[
        "flex flex-col items-center justify-center text-center py-12 px-4 gap-3",
        variant === "dashed"
          ? "rounded-[var(--radius-sm)] border border-dashed border-[var(--color-sk-line-strong)]"
          : "",
        isNoSignal
          ? "rounded-[var(--radius-sm)] border border-[var(--color-st-warn-bd)] bg-[var(--color-sk-warn-wash)]"
          : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && (
        <Icon
          name={icon}
          size="3rem"
          className={isNoSignal ? "text-[var(--color-st-warn)]" : "text-[var(--color-sk-faint)]"}
          decorative
        />
      )}
      <p
        className={[
          "text-lg font-semibold",
          isNoSignal ? "text-[var(--color-st-warn)]" : "text-[var(--color-sk-ink)]",
        ].join(" ")}
      >
        {title}
      </p>
      {description && <p className="text-sm text-[var(--color-sk-mute)]">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
