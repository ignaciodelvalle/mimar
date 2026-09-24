"use client";

import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";

/**
 * Libreta Nacional Tabs.
 *
 * Active tab: azul underline + azul text + celeste-050 count badge.
 * Inactive: mute text + stripe count badge.
 *
 * LnTabs     — tabs bar
 * LnAccordion — native <details> accordion; chevron rotates; "✓ completo" when closed
 */

// ---------- Tabs ----------------------------------------------------------

export type LnTabItem = {
  key: string;
  label: string;
  /** Numeric or short count shown in a mono pill */
  count?: number | string;
};

export type LnTabsProps = {
  tabs: LnTabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
};

export function LnTabs({ tabs, active, onChange, className = "" }: LnTabsProps) {
  return (
    <div
      className={["flex gap-0 border-b border-[var(--color-ln-line)]", className]
        .filter(Boolean)
        .join(" ")}
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.key)}
            className={[
              "inline-flex cursor-pointer items-center gap-[7px] border-b-2 px-[18px] py-2.5 text-md font-semibold transition-colors",
              "-mb-px", // overlap the tablist bottom border
              "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]",
              isActive
                ? "border-b-[var(--color-ln-azul)] text-[var(--color-ln-azul)]"
                : "border-b-transparent text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink-2)]",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={[
                  "rounded-full px-1.5 py-px font-ln-mono text-xs",
                  isActive
                    ? "bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]"
                    : "bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Accordion -----------------------------------------------------

export type LnAccordionProps = {
  /** Mono number prefix (e.g. "01", "02") */
  num?: string;
  title: string;
  /** When closed, show "✓ completo" badge */
  complete?: boolean;
  open?: boolean;
  children: ReactNode;
  className?: string;
};

export function LnAccordion({
  num,
  title,
  complete = false,
  open = false,
  children,
  className = "",
}: LnAccordionProps) {
  return (
    <details
      open={open}
      className={[
        "op-disclosure group overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <summary
        className={[
          "flex cursor-pointer list-none items-center gap-2.5 px-[15px] py-[13px]",
          "font-ln-serif text-md font-semibold text-[var(--color-ln-ink)]",
          "group-open:border-b group-open:border-[var(--color-ln-line-2)] group-open:bg-[var(--color-ln-stripe)]",
          // Remove default marker
          "[&::-webkit-details-marker]:hidden",
          "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {num && (
          <span className="font-ln-mono text-sm font-semibold text-[var(--color-ln-azul)]">
            {num}
          </span>
        )}
        <span className="flex-1">{title}</span>

        {/* "✓ completo" — only shown when closed */}
        {complete && (
          <span className="flex items-center gap-1 font-ln-mono text-xs text-[var(--color-ln-ok)] group-open:hidden">
            <Icon name="check" size={14} decorative /> completo
          </span>
        )}

        {/* Chevron rotates 90° when open */}
        <span className="ml-auto text-md text-[var(--color-ln-mute)] transition-transform duration-150 group-open:rotate-90">
          ›
        </span>
      </summary>

      <div className="flex flex-col gap-[13px] p-[15px]">{children}</div>
    </details>
  );
}

export type LnAccordionGroupProps = {
  children: ReactNode;
  className?: string;
};

export function LnAccordionGroup({ children, className = "" }: LnAccordionGroupProps) {
  return (
    <div className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}>{children}</div>
  );
}
