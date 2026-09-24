"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from "react";

/**
 * Libreta Nacional Button.
 *
 * Variants:
 *  - primary  → azul institucional (#0e5a99), white text
 *  - seal     → rojo sello (#a23a2c) — danger/emergency actions
 *  - ghost    → outline, card bg — secondary/cancel
 *  - ok       → verde (#2e7d4f) — confirm/positive action
 *  - warn     → ámbar (#b0771a) — cautionary CTA (e.g. marcar perdida)
 *
 * Sizes: sm | md | lg
 * Modifiers: block (full-width), uppercase
 *
 * Anchor mode: pass `href` (and no `onClick`-only button semantics) to render
 * a next/link `<Link>` instead of a native button element — same classes, same
 * variant/size system. Needed anywhere an LnButton-styled CTA must navigate: a
 * native button element cannot legally nest inside another interactive element
 * and a `<Link>`'s `<a>` cannot legally contain one (WCAG 4.1.2), so a plain
 * `<LnButton>` can't be dropped into link position. Byte-identical look to
 * `<LnButton variant="primary">` — same base/sizes/variants maps.
 *
 * Uses ln-* semantic tokens from globals.css @theme.
 * Safe in components/ui/ (excluded from lint:tokens guard).
 */

export type LnButtonVariant = "primary" | "seal" | "ghost" | "ok" | "warn";
export type LnButtonSize = "sm" | "md" | "lg";

type CommonProps = {
  variant?: LnButtonVariant;
  size?: LnButtonSize;
  block?: boolean;
  className?: string;
  children?: ReactNode;
};

type LnButtonAsButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
    loading?: boolean;
    href?: undefined;
  };

type LnButtonAsAnchorProps = CommonProps &
  Omit<ComponentProps<typeof Link>, "className" | "children">;

export type LnButtonProps = LnButtonAsButtonProps | LnButtonAsAnchorProps;

// THE citizen button radius. This is one of exactly TWO places in the app where
// a button radius may be written — the other is OpButton's --radius-op-btn.
// Enforced by scripts/check-raw-buttons.mjs, so a third one fails the build.
//
// Pill, not a fixed px value, and the reason is maintenance rather than taste
// (X2-S2, PO decision 2026-07-29): 9999px is SCALE-INVARIANT. A fixed radius is
// coupled to button height — 3px read right on a small button and undersized on
// a tall CTA — and that coupling is how this codebase grew FOUR button radii,
// each one added by someone who needed the previous value to look right at a new
// size. A pill is correct at every size, so the question never comes back.
//
// The operator tier deliberately keeps its 6px institutional rect for dense
// admin tables. Two rules with a stated reason is a system; the four
// undocumented values this replaces were drift wearing a system's clothes.
const base =
  "inline-flex items-center justify-center gap-[7px] font-semibold " +
  "rounded-[var(--radius-pill)] border transition-colors cursor-pointer select-none " +
  // Pressed feedback (native-mobile audit §3): touch users get an immediate
  // tactile response instead of hover-only styling that never fires on touch.
  "active:scale-[0.98] active:opacity-90 " +
  "disabled:cursor-not-allowed disabled:opacity-60 " +
  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]";

const sizes: Record<LnButtonSize, string> = {
  sm: "px-[11px] py-1.5 text-sm",
  md: "px-3.5 py-2 text-md",
  lg: "px-[18px] py-2.5 text-md",
};

const variants: Record<LnButtonVariant, string> = {
  primary:
    "bg-[var(--color-ln-azul)] text-white border-[var(--color-ln-azul)] " +
    "hover:bg-[var(--color-ln-azul-700)] hover:border-[var(--color-ln-azul-700)]",
  // The three filled variants below hover by DARKENING, like `primary` — not by
  // fading. `hover:opacity-90` was never a design choice: it is what these three
  // fell back to because no `-700` token existed for them, and it fades the
  // white label along with the fill. Measured on the page ground: seal
  // 6.61 → 5.39, ok 5.68 → 4.63, warn 5.28 → 4.35 — the last one UNDER the
  // 4.5:1 AA floor that `--color-ln-warn`'s own comment records being darkened
  // to clear. Hover was undoing that work, on "Confirmar", "Marcar perdida" and
  // the other controls a person thinks twice before pressing.
  seal:
    "bg-[var(--color-ln-seal)] text-white border-[var(--color-ln-seal)] " +
    "hover:bg-[var(--color-ln-seal-700)] hover:border-[var(--color-ln-seal-700)]",
  ghost:
    "bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] border-[var(--color-ln-line-strong)] " +
    "hover:bg-[var(--color-ln-stripe)]",
  ok:
    "bg-[var(--color-ln-ok)] text-white border-[var(--color-ln-ok)] " +
    "hover:bg-[var(--color-ln-ok-700)] hover:border-[var(--color-ln-ok-700)]",
  warn:
    "bg-[var(--color-ln-warn)] text-white border-[var(--color-ln-warn)] " +
    "hover:bg-[var(--color-ln-warn-700)] hover:border-[var(--color-ln-warn-700)]",
};

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

// Shared by both render paths below (button + anchor) — the one place that
// turns variant/size/block/className into the final class string, so the
// two modes can never visually drift apart.
function lnButtonClasses({
  variant = "primary",
  size = "md",
  block = false,
  className = "",
}: Pick<CommonProps, "variant" | "size" | "block" | "className">): string {
  return [base, sizes[size], variants[variant], block ? "w-full" : "", className]
    .filter(Boolean)
    .join(" ");
}

export function LnButton(props: LnButtonProps) {
  if (props.href !== undefined) {
    const { variant, size, block, className, children, href, ...anchorRest } = props;
    // Buttons are never underlined by the browser; an <a> needs the explicit
    // reset so LnButton's anchor mode matches its button mode.
    const anchorClassName = `${lnButtonClasses({ variant, size, block, className })} no-underline`;
    return (
      <Link href={href} className={anchorClassName} {...anchorRest}>
        {children}
      </Link>
    );
  }

  const {
    variant,
    size,
    block,
    className,
    disabled,
    loading = false,
    type = "button",
    children,
    ...buttonRest
  } = props;

  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={lnButtonClasses({ variant, size, block, className })}
      {...buttonRest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
