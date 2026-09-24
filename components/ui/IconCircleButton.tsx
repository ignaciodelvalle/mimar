// IconCircleButton — shared circular icon-button styling (design-system
// audit finding 4, wave-3 D5). PetActionRow (pet-profile action bar) and
// FlipCard's "Girar" affordance used to hand-roll near-identical circular
// icon-button implementations independently.
//
// PetActionRow's interactive element MUST stay `SheetTriggerLink` (the
// router-hot-path fix — see components/pet-profile/PetActionRow.tsx's own
// docblock), so a single polymorphic component that also renders an <a>
// isn't the right shape here: `ui/` primitives shouldn't import a
// pet-profile-specific component either. Instead this file exports BOTH:
//   - `IconCircleButton` — a real <button>, for callers with a plain
//     onClick (FlipCard).
//   - `iconCircleButtonClass(variant, className)` — the same class builder,
//     for callers that need a different element (PetActionRow's
//     SheetTriggerLink-wrapped anchors).
// Both are one source of truth for the shape (44×44 min touch target,
// rounded-full, centered) and the named color/border variants.

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconCircleButtonVariant =
  | "primary"
  | "secondary"
  | "danger-outline"
  | "success"
  /** The lighter 1px-border look FlipCard's "Girar" affordance uses — a
   *  quieter treatment than "secondary" (3px), reserved for the flip
   *  control specifically so its existing appearance doesn't change. */
  | "flip";

const BASE =
  // active:scale — pressed feedback for touch (native-mobile audit §3).
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition-colors active:scale-[0.98] active:opacity-90";

const VARIANT_CLASSES: Record<IconCircleButtonVariant, string> = {
  primary: "bg-[var(--color-ln-azul)] text-white hover:bg-ln-azul-700",
  secondary:
    "border-[3px] border-[var(--color-ln-line)] bg-[var(--color-ln-card)] text-[var(--color-ln-azul)] hover:border-[var(--color-ln-line-strong)]",
  "danger-outline":
    "border-[3px] border-ln-err bg-transparent text-ln-err hover:bg-ln-err hover:text-white",
  success: "bg-ln-ok text-white hover:opacity-90",
  flip: "border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] text-[var(--color-ln-azul)] shadow-sm hover:border-[var(--color-ln-line-strong)]",
};

/** Builds the full className string — for callers that render a non-button element. */
export function iconCircleButtonClass(variant: IconCircleButtonVariant, className = ""): string {
  return [BASE, VARIANT_CLASSES[variant], className].filter(Boolean).join(" ");
}

export type IconCircleButtonProps = {
  variant: IconCircleButtonVariant;
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

/** Real <button> variant — for callers with a plain onClick (e.g. FlipCard). */
export function IconCircleButton({
  variant,
  children,
  className = "",
  type = "button",
  ...rest
}: IconCircleButtonProps) {
  return (
    <button type={type} className={iconCircleButtonClass(variant, className)} {...rest}>
      {children}
    </button>
  );
}
