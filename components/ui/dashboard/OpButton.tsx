"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from "react";

/**
 * Operator-tier (op) button primitive.
 *
 * Mirrors the LnButton API (Button.tsx in components/ui/) but uses op-skin
 * tokens (ln-op-*) and the operator button radius (--radius-op-btn: 6px).
 *
 * Variants:
 *   primary — bg-ln-op-azul, white text — PRIMARY action (form submit, CTA)
 *   ghost   — outline on card bg — secondary / cancel
 *   danger  — bg-ln-op-danger, white text — destructive action
 *   ok      — bg-ln-op-ok, white text — EXPLICIT positive confirmation only
 *             (e.g. "Confirmar alta", NOT a generic primary)
 *
 * Sizes: sm | md | lg
 * Modifiers: block (full-width), loading (disabled + spinner)
 *
 * Decision: primary action = BLUE (ln-op-azul). Green (ok) is reserved for
 * explicit positive-confirmation flows only. This resolves the green/blue
 * inconsistency between OpSubmitButton (was green) and OpBulkBar (blue).
 *
 * Anchor mode: pass `href` to render a next/link `<Link>` instead of a native
 * button element — same base/sizes/variants maps, byte-identical look. Mirrors
 * LnButton's anchor mode (components/ui/Button.tsx) one tier down, and exists
 * for the same reason: a control that NAVIGATES must be a link (keyboard,
 * middle-click, shareable URL), and a `<button>` cannot legally sit inside an
 * `<a>` or vice versa (WCAG 4.1.2), so a plain `<OpButton>` cannot be dropped
 * into link position. First caller: CaseQueue's URL-driven sort toggle (SC-6,
 * 2026-08-07) — the sort has to reach the SQL ORDER BY, so it lives in the URL.
 * `loading` and `disabled` are button-only; a link has neither state.
 *
 * Uses --radius-op-btn (6px) defined in app/globals.css @theme.
 * Safe in components/ui/dashboard/ — excluded from lint:tokens guard.
 */

export type OpButtonVariant = "primary" | "ghost" | "danger" | "ok";
export type OpButtonSize = "sm" | "md" | "lg";

type CommonProps = {
  variant?: OpButtonVariant;
  size?: OpButtonSize;
  block?: boolean;
  className?: string;
  children?: ReactNode;
};

type OpButtonAsButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & {
    loading?: boolean;
    href?: undefined;
    /**
     * Forwarded to the underlying button element (React 19 ref-as-prop — no
     * forwardRef needed). Added 2026-07-30: ConfirmDialog needs a focus-restore
     * target, and every caller that wanted one had been dropping to a raw
     * element hand-styled to look like this component (IncomingTransferActions,
     * ReasignarButton, DevolverAlDuenoButton, RemoveMemberButton — see the note
     * in scripts/check-raw-buttons.mjs). Declaring the prop removes the reason
     * to fork the styling.
     */
    ref?: Ref<HTMLButtonElement>;
  };

type OpButtonAsAnchorProps = CommonProps &
  Omit<ComponentProps<typeof Link>, "className" | "children">;

export type OpButtonProps = OpButtonAsButtonProps | OpButtonAsAnchorProps;

const base =
  "inline-flex items-center justify-center gap-[7px] font-semibold " +
  "rounded-[var(--radius-op-btn,6px)] border transition-colors cursor-pointer select-none " +
  // Pressed feedback, mirrored from LnButton (Button.tsx:56-58) — operator
  // console had no touch/pressed affordance beyond hover, a real
  // citizen-vs-operator parity gap (audit-3-feedback §1). transition-colors
  // above intentionally does NOT include transform, so this scale/opacity
  // change applies instantly rather than animating — already reduced-motion
  // safe without needing a motion-reduce: override, same as LnButton.
  "active:scale-[0.98] active:opacity-90 " +
  "disabled:cursor-not-allowed disabled:opacity-60 " +
  "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-op-celeste-050)]";

// NO touch floor here, deliberately — mirroring LnButton (Button.tsx), which
// has none either. The 44px floor in this design system lives on FIELDS
// (Field.tsx, and now OpField): a form control is what a user aims at while
// reading and typing, and it is the surface WCAG 2.5.5 was measured against
// here. Buttons keep their padding-derived height in both tiers.
//
// This was briefly changed and reverted (2026-08-07): `md` is the DEFAULT size,
// so a floor here silently grows every unsized OpButton across /gob, /admin and
// /org — a console-wide visual change with no measurement behind it, and one
// that would have broken the very citizen/operator parity used to justify the
// field floor. A button that must match a field's height says so at its own
// call site (see DecomisoForm's "Buscar").
const sizes: Record<OpButtonSize, string> = {
  sm: "px-[11px] py-1.5 text-sm",
  md: "px-3.5 py-2 text-md",
  lg: "px-[18px] py-2.5 text-md",
};

const variants: Record<OpButtonVariant, string> = {
  primary:
    "bg-[var(--color-ln-op-azul)] text-white border-[var(--color-ln-op-azul)] " +
    "hover:bg-[var(--color-ln-op-azul-700)] hover:border-[var(--color-ln-op-azul-700)]",
  ghost:
    "bg-[var(--color-ln-op-card)] text-[var(--color-ln-op-ink)] border-[var(--color-ln-op-line)] " +
    "hover:bg-[var(--color-ln-op-stripe)]",
  // Darken, do not fade — the operator half of the change made to LnButton, and
  // the reasoning is written beside the tokens in app/globals.css rather than
  // repeated here. The number that matters on this surface: `ok` under
  // `opacity-90` measured 4.44:1, under the AA floor, on the button that closes
  // a case.
  danger:
    "bg-[var(--color-ln-op-danger)] text-white border-[var(--color-ln-op-danger)] " +
    "hover:bg-[var(--color-ln-op-danger-700)] hover:border-[var(--color-ln-op-danger-700)]",
  ok:
    "bg-[var(--color-ln-op-ok)] text-white border-[var(--color-ln-op-ok)] " +
    "hover:bg-[var(--color-ln-op-ok-700)] hover:border-[var(--color-ln-op-ok-700)]",
};

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

function classesFor(
  variant: OpButtonVariant,
  size: OpButtonSize,
  block: boolean,
  className: string,
): string {
  return [base, sizes[size], variants[variant], block ? "w-full" : "", className]
    .filter(Boolean)
    .join(" ");
}

export function OpButton(props: OpButtonProps) {
  if (props.href !== undefined) {
    const {
      variant = "primary",
      size = "md",
      block = false,
      className = "",
      children,
      href,
      ...anchorRest
    } = props;
    return (
      <Link
        href={href}
        // no-underline: the op tier's buttons are solid controls, and the
        // global anchor underline would read as a text link inside one.
        className={`${classesFor(variant, size, block, className)} no-underline`}
        {...anchorRest}
      >
        {children}
      </Link>
    );
  }

  const {
    variant = "primary",
    size = "md",
    block = false,
    loading = false,
    className = "",
    disabled,
    type = "button",
    children,
    ...rest
  } = props;
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classesFor(variant, size, block, className)}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
