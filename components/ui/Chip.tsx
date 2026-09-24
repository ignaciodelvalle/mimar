"use client";

import type { ReactNode } from "react";

/**
 * Libreta Nacional Chip / Pill.
 *
 * Selectable: active state = azul border + celeste-050 background.
 * Tone variants: default (azul) | rojo | amber
 *
 * LnChip     — selectable tag chip (allergy, condition, etc.)
 * LnPetPill  — pet selector pill with status dot (used in capture bar)
 */

// ---------- Status dot ----------------------------------------------------

// "ok" (AL DÍA) is a COMPLIANCE claim — callers may only pass it when the
// pet's tracked obligations are all satisfied (deriveComplianceState).
// "registered" is the neutral resting state for an active pet that hasn't
// earned the compliance claim (QA 2026-07-03: header said AL DÍA while the
// compliance panel said 0 de 3 al día).
export type LnPetStatus = "ok" | "registered" | "sick" | "lost" | "pregnant" | "deceased";

const statusDotColors: Record<LnPetStatus, string> = {
  ok: "bg-[var(--color-ln-ok)]",
  registered: "bg-[var(--color-ln-mute)]",
  sick: "bg-[var(--color-ln-warn)] rounded-[var(--radius-xs)]",
  lost: "bg-[var(--color-ln-err)] rounded-[1px]",
  pregnant: "bg-[var(--color-ln-rosa)]",
  deceased: "bg-[var(--color-ln-memorial-chip-text)]",
};

export type LnStatusDotProps = {
  status: LnPetStatus;
  size?: "sm" | "md";
};

export function LnStatusDot({ status, size = "sm" }: LnStatusDotProps) {
  const dim = size === "sm" ? "w-[8px] h-[8px]" : "w-[12px] h-[12px]";
  return (
    <span
      className={[dim, "rounded-full flex-shrink-0", statusDotColors[status]]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
    />
  );
}

// ---------- Chip ----------------------------------------------------------

export type LnChipTone = "azul" | "rojo" | "amber";

export type LnChipProps = {
  selected?: boolean;
  onChange?: (next: boolean) => void;
  tone?: LnChipTone;
  children: ReactNode;
  className?: string;
};

const selectedClasses: Record<LnChipTone, string> = {
  azul: "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul-700)]",
  rojo: "border-[var(--color-ln-err)] bg-[var(--color-ln-err-050)] text-[var(--color-ln-err)]",
  amber: "border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]",
};

export function LnChip({
  selected = false,
  onChange,
  tone = "azul",
  children,
  className = "",
}: LnChipProps) {
  const base =
    "inline-flex cursor-pointer items-center rounded-full border px-[11px] py-[5px] text-sm font-medium transition-colors " +
    "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]";
  const inactive =
    "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink-2)]";

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onChange?.(!selected)}
      className={[base, selected ? selectedClasses[tone] : inactive, className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  );
}

// ---------- Chip Group ---------------------------------------------------

export type LnChipGroupItem = {
  key: string;
  label: string;
  tone?: LnChipTone;
};

export type LnChipGroupProps = {
  items: LnChipGroupItem[];
  selected: string[];
  onChange: (selected: string[]) => void;
  className?: string;
};

export function LnChipGroup({ items, selected, onChange, className = "" }: LnChipGroupProps) {
  function toggle(key: string) {
    if (selected.includes(key)) {
      onChange(selected.filter((k) => k !== key));
    } else {
      onChange([...selected, key]);
    }
  }

  return (
    <div className={["flex flex-wrap gap-1.5", className].filter(Boolean).join(" ")}>
      {items.map((item) => (
        <LnChip
          key={item.key}
          selected={selected.includes(item.key)}
          onChange={() => toggle(item.key)}
          tone={item.tone}
        >
          {item.label}
        </LnChip>
      ))}
    </div>
  );
}

// ---------- Pet Pill (capture bar) ----------------------------------------

export type LnPetPillProps = {
  name: string;
  status?: LnPetStatus;
  active?: boolean;
  onClick?: () => void;
};

export function LnPetPill({ name, status = "ok", active = false, onClick }: LnPetPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex cursor-pointer items-center gap-[7px] rounded-full border px-[11px] py-1 pl-[5px] text-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]",
        active
          ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul-700)]"
          : "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink-2)]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Pet dot avatar */}
      <span className="relative h-[18px] w-[18px] flex-shrink-0 overflow-hidden rounded-full border border-[var(--color-ln-line-strong)] bg-[repeating-linear-gradient(135deg,var(--pattern-no-photo-a)_0_4px,var(--pattern-no-photo-b)_4px_8px)]">
        {/* Status indicator */}
        <span
          className={[
            "absolute bottom-[-2px] right-[-2px] h-[8px] w-[8px] border-[1.5px] border-[var(--color-ln-card)] rounded-full",
            statusDotColors[status],
          ]
            .filter(Boolean)
            .join(" ")}
        />
      </span>
      {name}
    </button>
  );
}
