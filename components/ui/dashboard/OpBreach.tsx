import type { ReactNode } from "react";

type Props = {
  /** Short bold title (e.g. "SLA breach — 3 open cases past deadline"). */
  title: string;
  /** Optional secondary detail line. */
  detail?: ReactNode;
  /** Optional leading icon node (any React content). */
  icon?: ReactNode;
};

/**
 * Danger SLA banner.
 *
 * Visually derived from .gob-breach (redesign-a-gob.css L357-363).
 * Uses ln-op-danger-* tokens for background, border, and text.
 */
export function OpBreach({ title, detail, icon }: Props) {
  return (
    <div
      role="alert"
      className={[
        "mb-[18px] flex items-center gap-3.5 rounded-[var(--radius-md)]",
        "border border-ln-op-danger-bd border-l-[4px] border-l-ln-op-danger",
        "bg-ln-op-danger-bg px-4 py-3",
      ].join(" ")}
    >
      {icon && <span className="flex-shrink-0 text-lg text-ln-op-danger">{icon}</span>}

      <div className="min-w-0 flex-1">
        <b className="block text-md font-bold text-ln-op-danger">{title}</b>
        {detail && <span className="text-sm text-ln-op-danger opacity-85">{detail}</span>}
      </div>
    </div>
  );
}
