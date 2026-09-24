"use client";

import type { ComponentPropsWithRef, InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

import { OpButton } from "@/components/ui/dashboard/OpButton";

/**
 * Operator-tier (op) form primitives.
 *
 * These components own the ln-op-* control chrome for the whole operator
 * surface (/gob, /admin, /org). They started as a pure extraction from the
 * attendance forms; they are now the single definition that ~155 controls
 * across app/ and components/ render through.
 *
 * Exports:
 *   OpField        — compound field wrapper (label + required * + hint + error + aria linkage)
 *   OpFormAlert    — role="alert" error banner (danger box)
 *   OpFieldLabel   — block label wrapper; pass full children including any asterisk
 *   OpFieldHint    — subdued hint line below a control
 *   OpInput        — <input> with op control classes
 *   OpSelect       — <select> with op control classes
 *   OpTextarea     — <textarea> with op control classes
 *   OP_CONTROL_CLASS / OP_CONTROL_CLASS_SM — the same chrome as a class string,
 *                    for composed controls that cannot render through the above
 *   OpSubmitButton — full-width submit button with pending/idle label
 *   OpCheckbox     — native uncontrolled checkbox with op-tier styling
 */

// ---------------------------------------------------------------------------
// OpField compound wrapper
// ---------------------------------------------------------------------------

export type OpFieldRenderProps = {
  /** Stable id for the control — wire to the control's id prop. */
  id: string;
  /**
   * Space-separated ids of the hint and/or error elements.
   * Wire to aria-describedby on the control. Undefined when there is neither
   * hint nor error, so spreading is safe.
   */
  describedBy: string | undefined;
  /** True when the field has an error — wire to aria-invalid on the control. */
  invalid: boolean;
};

export type OpFieldProps = {
  /** Visible label text. */
  label: string;
  /** Hint text rendered below the control. */
  hint?: string;
  /** Inline error message rendered below the control (replaces hint). */
  error?: string;
  /** When true, shows a red required asterisk and the control should carry required. */
  required?: boolean;
  /** Extra class names for the outer wrapper div. */
  className?: string;
  /** Render-prop — receives aria linkage props; return the form control. */
  children: (api: OpFieldRenderProps) => ReactNode;
};

/**
 * Compound field wrapper for operator-tier forms.
 *
 * Generates stable ids for the control, hint, and error elements, and exposes
 * them via a render-prop so the wrapped control can wire aria-describedby and
 * aria-invalid without any manual id management by the consumer.
 *
 * Usage:
 *   <OpField label="Número de matrícula" required error={state.fieldError?.matricula}>
 *     {({ id, describedBy, invalid }) => (
 *       <OpInput id={id} name="matriculaNumber" required
 *                aria-describedby={describedBy} aria-invalid={invalid || undefined} />
 *     )}
 *   </OpField>
 */
export function OpField({ label, hint, error, required, className, children }: OpFieldProps) {
  const uid = useId();
  const hintId = hint ? `${uid}-hint` : undefined;
  const errorId = error ? `${uid}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error);

  return (
    <div className={["space-y-1.5", className].filter(Boolean).join(" ")}>
      <label htmlFor={uid} className="block text-xs font-medium text-ln-op-ink-2">
        {label}
        {required && (
          <span className="ml-0.5 text-ln-op-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>

      {children({ id: uid, describedBy, invalid })}

      {hint && !error && (
        <p id={hintId} className="text-xs text-ln-op-mute">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-ln-op-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error alert banner
// ---------------------------------------------------------------------------

type OpFormAlertProps = {
  children: ReactNode;
};

/**
 * Danger alert box rendered when a form has a top-level error.
 *
 * Emits:
 *   <p role="alert" className="rounded-[var(--radius-sm)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-sm text-ln-op-danger">
 */
export function OpFormAlert({ children }: OpFormAlertProps) {
  return (
    <p
      role="alert"
      className="rounded-[var(--radius-sm)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-sm text-ln-op-danger"
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Field label
// ---------------------------------------------------------------------------

type OpFieldLabelProps = {
  /** id of the form control this label is for. */
  htmlFor: string;
  /**
   * Label content — pass the full label text including any required asterisk span,
   * exactly as it would appear in the original form markup.
   */
  children: ReactNode;
};

/**
 * Block label for an op-tier form field.
 *
 * Emits:
 *   <label htmlFor={...} className="block text-xs font-medium text-ln-op-ink-2 mb-1">
 */
export function OpFieldLabel({ htmlFor, children }: OpFieldLabelProps) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium text-ln-op-ink-2 mb-1">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Field hint
// ---------------------------------------------------------------------------

type OpFieldHintProps = {
  children: ReactNode;
};

/**
 * Subdued hint line rendered below a control.
 *
 * Emits:
 *   <p className="text-xs text-ln-op-mute mt-1">
 */
export function OpFieldHint({ children }: OpFieldHintProps) {
  return <p className="text-xs text-ln-op-mute mt-1">{children}</p>;
}

// ---------------------------------------------------------------------------
// Shared control class string (input / select / textarea)
// ---------------------------------------------------------------------------
//
// THE operator control chrome. Before this was the single source of truth, 92
// raw <input>/<select>/<textarea> elements across app/gob, app/org, app/admin
// and components/ hand-rolled it in ~35 near-identical spellings (token audit,
// "biggest structural gap"). Two things the spread had drifted on:
//
//  1. FOCUS TRIGGER. ~90 of those sites used `focus:ring-*`, so the ring
//     flashed on every mouse click. OpButton deliberately uses `focus-visible:`
//     (OpButton.tsx) — keyboard users get the ring, pointer users don't. Text
//     controls follow the same rule here. This is NOT the "inputs always show
//     a ring" exception people expect it to be: browsers already match
//     :focus-visible on text fields focused by ANY means (the spec's text-entry
//     heuristic), so switching the selector keeps the keyboard ring on inputs
//     while dropping it from selects clicked with a mouse — which is the intent.
//  2. RING COLOUR. This file previously shipped `ring-ln-op-ok` (GREEN) while
//     every hand-rolled site used `ring-ln-op-azul`. Green is the operator
//     skin's positive-confirmation tone (see OpSubmitButton's note), never a
//     focus affordance. Azul wins — it is both the majority and the correct
//     semantic.
//
// Mirrors LN_CONTROL_CLASS / LN_CONTROL_MONO_CLASS in components/ui/Field.tsx
// (the citizen equivalents) so the two skins stay learnable as one system.

const controlBase =
  "rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card " +
  "text-ln-op-ink placeholder:text-ln-op-faint " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul " +
  "disabled:cursor-not-allowed disabled:opacity-60 " +
  "aria-[invalid=true]:border-ln-op-danger";

/**
 * Density steps. LnInput needs none — citizen forms are single-density — but
 * the operator surface genuinely runs three, and the census of the 92
 * hand-rolled controls measured them rather than inventing them:
 *
 *   md  `px-3 py-2 text-md`     54 sites — the form default
 *   sm  `px-3 py-1.5 text-sm`   14 sites — panel filters, compact forms
 *   xs  `px-2 py-1.5 text-sm`    7 sites — inline row/table-cell controls
 *
 * (The handful of sites written with arbitrary 5px/7px vertical padding fold
 * into the step above them, per the round-up convention app/globals.css
 * documents for the spacing scale.)
 *
 * TOUCH FLOOR. `md` carries `min-h-[44px]`; `sm`/`xs` deliberately do not.
 * The citizen sibling has enforced this since Wave 2 (Field.tsx:364-366,
 * "min-h-[44px] ensures touch targets meet WCAG 2.5.5"), and the header note
 * below claims this file mirrors it — but the mirror was broken on exactly the
 * accessibility property: `md` rendered 38px (8+8 padding + 20px line box + 2px
 * border). QA 2026-08-07 measured it on the two longest operator forms
 * (DecomisoForm, org intake). The floor lands on `md` only because `sm` and
 * `xs` exist to sit INSIDE table rows and queue toolbars, where 44px would
 * break the row rhythm; both clear WCAG 2.5.8 AA (24px) on their own. `lg`
 * takes it too, so the steps stay monotonic (its 41px would otherwise render
 * SHORTER than `md`).
 *
 * OpButton does NOT get this floor, and neither does LnButton: in both tiers
 * the 44px rule is a FIELD rule. A button that must match a field's height
 * states it at its own call site (DecomisoForm's "Buscar"), because `md` is
 * OpButton's default size — a floor there would silently grow every unsized
 * button in the console.
 *
 * These HAVE to be a prop rather than className extras. `text-md` vs `text-sm`
 * and `px-3` vs `px-2` are the same Tailwind utility group, so which one wins
 * is decided by generated-CSS order, not by the order of the class attribute —
 * this repo deliberately has no `tailwind-merge` (see REGISTRY.md), so a
 * caller passing `text-sm` would override the base only by luck.
 */
const controlSize = {
  md: "px-3 py-2 text-md min-h-[44px]",
  sm: "px-3 py-1.5 text-sm",
  xs: "px-2 py-1.5 text-sm",
} as const;

export type OpControlSize = keyof typeof controlSize;

function opControlClass(
  size: OpControlSize,
  mono: boolean,
  block: boolean,
  className?: string,
): string {
  return [
    block ? "w-full" : "",
    controlBase,
    controlSize[size],
    mono ? "font-ln-mono" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The op control chrome as a plain class string, for controls that are NOT a
 * bare `<input>`/`<select>`/`<textarea>` and therefore cannot render through the
 * components above — e.g. a composed control owning a visible field plus a
 * hidden twin. Exported so those call sites wear the IDENTICAL chrome instead
 * of re-declaring it (a copy drifts — that is exactly how 92 controls ended up
 * spelling this 35 different ways). Mirrors `LN_CONTROL_CLASS`
 * (components/ui/Field.tsx).
 *
 * Both include `w-full`, matching the components' `block` default.
 */
export const OP_CONTROL_CLASS = `w-full ${controlBase} ${controlSize.md}`;
export const OP_CONTROL_CLASS_SM = `w-full ${controlBase} ${controlSize.sm}`;

/** Props every op control shares. Mirrors LnInputProps' `invalid` / `mono`. */
type OpControlCommonProps = {
  /** Sets aria-invalid="true" and applies the danger border. */
  invalid?: boolean;
  /** Mono variant — codes, chip/passport numbers, tokens. */
  mono?: boolean;
  /** Density step — `md` (default) forms, `sm` panel filters, `xs` inline rows. */
  size?: OpControlSize;
  /**
   * Full-width (default). Pass `block={false}` for a control that should size
   * to its content — an inline row filter, a select next to a button. Same
   * reason as `size`: `w-auto` in className cannot reliably beat a `w-full`
   * baked into the base.
   */
  block?: boolean;
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type OpInputProps = Omit<ComponentPropsWithRef<"input">, "size"> & OpControlCommonProps;

/**
 * <input> styled with op-tier control tokens.
 *
 * All standard input attributes (id, name, type, value, defaultValue,
 * onChange, required, placeholder, pattern, maxLength, inputMode, …)
 * are forwarded via spread.
 *
 * `size` is REDEFINED away from the native HTML `size` attribute (a character
 * count nobody in this codebase uses) and onto the density step, so the op and
 * citizen primitives keep one vocabulary. Callers that truly need the HTML
 * attribute can still set it via a `ref`.
 */
export function OpInput({
  className,
  invalid,
  mono = false,
  size = "md",
  block = true,
  ...rest
}: OpInputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={opControlClass(size, mono, block, className)}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export type OpSelectProps = Omit<ComponentPropsWithRef<"select">, "size"> &
  OpControlCommonProps & {
    children: ReactNode;
  };

/**
 * <select> styled with op-tier control tokens.
 * Pass <option> elements as children.
 */
export function OpSelect({
  className,
  invalid,
  mono = false,
  size = "md",
  block = true,
  children,
  ...rest
}: OpSelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={opControlClass(size, mono, block, className)}
      {...rest}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

export type OpTextareaProps = ComponentPropsWithRef<"textarea"> & OpControlCommonProps;

/**
 * <textarea> styled with op-tier control tokens.
 *
 * Deliberately sets NO `resize-*` utility: `resize-y` in the base and
 * `resize-none` from a caller's className are the same Tailwind layer, so which
 * one won would be decided by generated-CSS order rather than by the caller.
 * The base leaves the browser default alone and call sites that care pass their
 * own `resize-none` / `resize-y`, which then has nothing to fight.
 */
export function OpTextarea({
  className,
  invalid,
  mono = false,
  size = "md",
  block = true,
  ...rest
}: OpTextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={opControlClass(size, mono, block, className)}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Submit button
// ---------------------------------------------------------------------------

type OpSubmitButtonProps = {
  /** Whether the form submission is in-flight. */
  pending: boolean;
  /** Label shown while pending. Defaults to "Guardando…". */
  pendingLabel?: string;
  /** Label shown in idle state. */
  children: ReactNode;
};

/**
 * Full-width submit button for op-tier attendance forms.
 *
 * Renders OpButton variant="primary" (blue, ln-op-azul) — not green.
 * Green (ok variant) is reserved for explicit positive-confirmation flows.
 *
 * Public props (pending, pendingLabel, children) are unchanged; call-sites
 * do not need to change.
 */
export function OpSubmitButton({
  pending,
  pendingLabel = "Guardando…",
  children,
}: OpSubmitButtonProps) {
  return (
    <OpButton type="submit" variant="primary" block loading={pending}>
      {pending ? pendingLabel : children}
    </OpButton>
  );
}

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------
//
// Operator-skinned counterpart to LnCheckbox (components/ui/Field.tsx) — same
// structure/API, but ln-op-* tokens (op accent/line/card/ink) instead of the
// citizen ln-azul/ln-celeste-050/ln-err/ln-ink. Closes the token gap that
// LnCheckbox's file-level comment documents as an intentional, tracked-for-
// later follow-up (consistency/skin-validation audit, 2026-07-19): LnCheckbox
// is a real cross-skin primitive with too many citizen callers to re-skin in
// place, so operator surfaces get their own checkbox instead.
//
// Unlike LnCheckbox, this does NOT wire the localized-validity / mobile-focus-
// scroll helpers — OpInput/OpSelect/OpTextarea in this same file don't either,
// so this stays consistent with its op-tier siblings rather than reaching into
// Field.tsx's private helpers.

export type OpCheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> & {
  /** Sets aria-invalid="true" and applies error styling to the input. */
  invalid?: boolean;
  /** Label content. Omit for a label-less control (pass `aria-label` instead). */
  children?: ReactNode;
  /** Extra classes for the label text span. */
  labelClassName?: string;
};

export function OpCheckbox({
  invalid,
  children,
  className,
  labelClassName,
  id: idProp,
  ...rest
}: OpCheckboxProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;

  const input = (
    <input
      id={id}
      type="checkbox"
      aria-invalid={invalid || undefined}
      className={[
        "mt-0.5 h-4 w-4 shrink-0 cursor-pointer",
        "accent-[var(--color-ln-op-azul)]",
        "rounded-[var(--radius-sm)]",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-op-celeste-050)]",
        invalid ? "outline outline-[1.5px] outline-[var(--color-ln-op-danger)]" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );

  // Label-less: render just the input — caller supplies aria-label.
  if (children == null) return input;

  return (
    <label htmlFor={id} className="flex items-start gap-2 cursor-pointer">
      {input}
      <span
        className={["text-sm leading-tight text-[var(--color-ln-op-ink)]", labelClassName ?? ""]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </span>
    </label>
  );
}
