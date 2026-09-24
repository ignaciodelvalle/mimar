"use client";

import { Icon, type IconName } from "@/components/Icon";
import type { ReactNode } from "react";

/**
 * LnAlert — informative alert with semantic variants and dismiss support.
 *
 * Styled with LN tokens (no gob-* classes).
 *
 * Variants:
 *  - info    → azul tenue — neutral informative (default)
 *  - success → verde tenue — operation confirmed
 *  - warning → ámbar tenue — requires attention, not blocking
 *  - danger  → rojo tenue — error or critical condition
 *
 * Accessibility:
 *  - role="alert" so screen readers announce the content immediately.
 *  - Dismiss button has aria-label="Cerrar".
 *  - Icon is decorative; semantic context comes from the text.
 */

type AlertVariant = "info" | "success" | "warning" | "danger";

export type LnAlertProps = {
  variant?: AlertVariant;
  title?: string;
  icon?: IconName;
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
};

// Container: soft bg + tinted border, same pattern as LnSheet tone colors
const containerVariants: Record<AlertVariant, string> = {
  info: "bg-[var(--color-ln-celeste-050)] border-[var(--color-ln-celeste-100)] text-[var(--color-ln-ink)]",
  success: "bg-[var(--color-ln-ok-050)] border-[var(--color-ln-ok-100)] text-[var(--color-ln-ink)]",
  warning:
    "bg-[var(--color-ln-warn-050)] border-[var(--color-ln-warn-100)] text-[var(--color-ln-ink)]",
  danger:
    "bg-[var(--color-ln-err-050)] border-[var(--color-ln-err-100)] text-[var(--color-ln-ink)]",
};

const defaultIcons: Record<AlertVariant, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "warning",
  danger: "error",
};

const iconColors: Record<AlertVariant, string> = {
  info: "text-[var(--color-ln-azul)]",
  success: "text-[var(--color-ln-ok)]",
  warning: "text-[var(--color-ln-warn)]",
  danger: "text-[var(--color-ln-err)]",
};

export function LnAlert({
  variant = "info",
  title,
  icon,
  children,
  onDismiss,
  className = "",
}: LnAlertProps) {
  const resolvedIcon = icon ?? defaultIcons[variant];

  return (
    <div
      role="alert"
      className={[
        "flex gap-3 rounded-[var(--radius-sm)] border p-4",
        containerVariants[variant],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Icon */}
      <Icon
        name={resolvedIcon}
        size="1.25rem"
        className={["mt-0.5 shrink-0", iconColors[variant]].join(" ")}
        decorative
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {title && <p className="font-semibold mb-1 text-[var(--color-ln-ink)]">{title}</p>}
        <div className="text-sm text-[var(--color-ln-ink-2)]">{children}</div>
      </div>

      {/* Dismiss */}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cerrar"
          className="shrink-0 self-start text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink)] transition-colors"
        >
          <Icon name="close" size="1.1rem" decorative />
        </button>
      )}
    </div>
  );
}
