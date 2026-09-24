type Props = {
  /** Short code displayed in mono bold (e.g. "UNIVERSAL", "CABA"). */
  code: string;
  /** Optional secondary label (e.g. scope descriptor). */
  label?: string;
  /**
   * "default" = navy (gob tier); "superadmin" = danger red; "org" = teal (org tier);
   * "neutral" = outline/muted — secondary chrome that never out-weighs the page H1 (D1).
   */
  variant?: "default" | "superadmin" | "org" | "neutral";
};

/**
 * Scope chip shown in the topbar to identify the operator's jurisdiction.
 *
 * The "neutral" variant (D1) is an outline chip in --ln-op-* tokens: it reads as
 * secondary chrome, lighter than the page H1, instead of a saturated badge that
 * competes with the heading.
 *
 * Mobile (<md): the secondary `label` (the mandate text, e.g. "3 provincias")
 * is hidden so the chip collapses to its short form — the portal code only.
 * This is disclosure CHROME, not lost information: every page carries its own
 * ViewScopeCaption, and the full mandate returns at >=md. Without this the chip
 * clipped mid-word under the topbar search field at 390px.
 */
export function OpScopeChip({ code, label, variant = "default" }: Props) {
  if (variant === "neutral") {
    return (
      <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card px-2.5 py-[3px] text-sm text-ln-op-ink-2">
        <span className="font-ln-mono font-semibold tracking-[0.04em] text-ln-op-ink-2">
          {code}
        </span>
        {label && (
          <span className="hidden text-xs uppercase tracking-[0.04em] text-ln-op-mute md:inline">
            · {label}
          </span>
        )}
      </span>
    );
  }

  const bgClass =
    variant === "superadmin"
      ? "bg-ln-op-danger"
      : variant === "org"
        ? "bg-[var(--color-ln-tl-rail)]"
        : "bg-ln-op-navy";

  return (
    <span
      className={[
        "inline-flex flex-shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1",
        bgClass,
        "text-sm text-white",
      ].join(" ")}
    >
      <span className="font-ln-mono font-bold tracking-[0.04em]">{code}</span>
      {label && (
        <span className="hidden text-xs uppercase tracking-[0.04em] text-ln-op-rail-mute md:inline">
          · {label}
        </span>
      )}
    </span>
  );
}
