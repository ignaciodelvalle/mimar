"use client";

import { Icon } from "@/components/Icon";
import { useState } from "react";

/**
 * Wave 2 Item 9 — mobile hardening applied to all LN form primitives:
 *  - font-size ≥ 16px on mobile (prevents iOS auto-zoom on focus)
 *  - min-height 44px on interactive controls (WCAG 2.5.5 touch-target)
 *  - inputMode / enterKeyHint forwarded from callers via standard HTML attrs
 */
import {
  Fragment,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useId,
} from "react";

/**
 * Libreta Nacional Field / Input / Select / Textarea primitives.
 *
 * Field anatomy (from handoff):
 *  - mono uppercase label (gray)
 *  - red-seal `*` for required fields
 *  - "opcional" suffix for optional fields
 *  - mono hint below the control
 *  - focus: border ln-azul + box-shadow 0 0 0 3px ln-celeste-050
 *
 * Exports:
 *  LnField      — wrapper (label + control slot + hint/error)
 *  LnInput      — <input> styled to spec; mono variant for codes/dates
 *  LnSelect     — <select> with custom chevron
 *  LnTextarea   — <textarea> resizable
 *  LnRow        — 2-column grid for field pairs
 *  LnSuffixWrap — input with appended unit label (e.g. "27.4 [kg]")
 *  LnCheckbox   — native uncontrolled checkbox with LN styling
 *  LnRadio      — native uncontrolled radio with LN styling
 */

// ---------- Hint / error typography ---------------------------------------
//
// One definition, used by every field-like wrapper in this file. LnField and
// LnRadioGroup used to render these inline with DIFFERENT values — 10.5px mono
// against 11px sans — so the same hint changed typeface depending on whether
// the control it described happened to be a radio group. Callers pass only the
// margin, because that genuinely differs: LnField's hint sits under the
// control, LnRadioGroup's sits above the options.

type FieldNoteProps = {
  id: string | undefined;
  className?: string;
  children: ReactNode;
};

function FieldHint({ id, className = "", children }: FieldNoteProps) {
  return (
    <p
      id={id}
      className={`font-ln-mono text-sm leading-[1.45] text-[var(--color-ln-mute)] ${className}`}
    >
      {children}
    </p>
  );
}

// The error's top margin is baked in rather than passed: every caller wants the
// same gap under the control, and duplicating it at each call site is how the
// two renderers drifted apart in the first place.
function FieldError({ id, className = "", children }: FieldNoteProps) {
  return (
    <p
      id={id}
      className={`mt-[5px] font-ln-mono text-sm text-[var(--color-ln-err)] ${className}`}
      role="alert"
    >
      {children}
    </p>
  );
}

// ---------- Field wrapper -------------------------------------------------

export type LnFieldRenderProps = {
  id: string;
  describedBy?: string;
  invalid: boolean;
};

export type LnFieldProps = {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  optional?: boolean;
  className?: string;
  children: (api: LnFieldRenderProps) => ReactNode;
};

export function LnField({
  label,
  hint,
  error,
  required,
  optional,
  className,
  children,
}: LnFieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const invalid = Boolean(error);
  const showOptional = optional ?? !required;

  // The label carries htmlFor={id}, but that association only holds if the
  // control carries the matching id. Rather than depend on every caller wiring
  // id={id} by hand (a forgotten id silently breaks screen-reader announcement
  // AND click-to-focus), inject it here; an explicit caller id still wins.
  // The visual `*` / red border likewise don't reach assistive tech
  // (WCAG 3.3.2 / 3.3.1), so aria-required / aria-invalid are injected too —
  // caller-set values always take precedence.
  const renderedControl = children({ id, describedBy, invalid });
  // isValidElement() is true for Fragments too, but a Fragment only accepts
  // key/children — cloning id/aria onto it is a no-op that warns in dev. Callers
  // that wrap the control in a Fragment keep the id on the inner control they
  // built, so skip the injection here (the label htmlFor still resolves to `id`).
  const controlEl =
    isValidElement(renderedControl) && renderedControl.type !== Fragment
      ? (renderedControl as ReactElement<{
          id?: string;
          "aria-required"?: boolean;
          "aria-invalid"?: boolean;
        }>)
      : null;
  // Effective id used for BOTH the label htmlFor and the control id so the two
  // never desync — even if a caller passes an explicit id instead of the
  // generated one handed to them via the render-prop.
  const controlId = controlEl?.props.id ?? id;
  const control = controlEl
    ? cloneElement(controlEl, {
        id: controlId,
        ...(required && controlEl.props["aria-required"] === undefined
          ? { "aria-required": true }
          : {}),
        ...(invalid && controlEl.props["aria-invalid"] === undefined
          ? { "aria-invalid": true }
          : {}),
      })
    : renderedControl;

  return (
    <div className={["flex flex-col", className].filter(Boolean).join(" ")}>
      {/* mono uppercase label */}
      <label
        htmlFor={controlId}
        className="mb-1.5 flex items-center gap-[5px] font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
      >
        {label}
        {required && (
          <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
            *
          </span>
        )}
        {showOptional && !required && (
          <span className="font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
            opcional
          </span>
        )}
      </label>

      {control}

      {hint && !error && (
        <FieldHint id={hintId} className="mt-[5px]">
          {hint}
        </FieldHint>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

// ---------- Radio group ----------------------------------------------------
//
// RA-9 BR-6 — hand-rolled `<fieldset><legend>… <span aria-hidden>*</span>` markup
// marked required radio groups with COLOUR + a GLYPH THAT IS HIDDEN FROM AT, and
// the radios carried neither `required` nor `aria-required`. On the anonymous
// public denuncia flow that means a screen-reader user cannot tell a mandatory
// question from an optional one until submit fails (WCAG 3.3.2).
//
// LnField cannot serve a radio GROUP: it renders one `<label htmlFor>` and clones
// the id/aria onto a SINGLE control, whereas a radio group needs a
// fieldset/legend and the requiredness on the group, not on each input. This is
// the group-shaped sibling of that primitive — same requiredness contract, same
// `*` + "opcional" affordances, applied to the container.

export type LnRadioGroupProps = {
  /** Group question, rendered as the `<legend>` — the AT group name. */
  legend: string;
  required?: boolean;
  /** Optional helper text below the legend, wired via aria-describedby. */
  hint?: string;
  /** Error text; sets aria-invalid on the group and renders a role="alert". */
  error?: string;
  className?: string;
  /** Extra classes for the `<legend>` (callers keep their own type scale). */
  legendClassName?: string;
  /** Extra classes for the options wrapper. */
  optionsClassName?: string;
  children: ReactNode;
};

export function LnRadioGroup({
  legend,
  required,
  hint,
  error,
  className,
  legendClassName,
  optionsClassName,
  children,
}: LnRadioGroupProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <fieldset
      // role="radiogroup" + aria-required is what carries requiredness to AT.
      // A native <fieldset> maps to `group`, which has no required state, so the
      // explicit radiogroup role is not redundant here.
      role="radiogroup"
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      className={className}
    >
      <legend
        className={
          legendClassName ?? "mb-2.5 text-[0.88em] font-semibold text-[var(--color-ln-mute)]"
        }
      >
        {legend}
        {required && (
          <>
            {/* The glyph is decoration; the sr-only word is the actual signal. */}
            <span className="ml-1 text-[var(--color-ln-err)]" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (obligatorio)</span>
          </>
        )}
        {!required && (
          <span className="ml-1 font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
            opcional
          </span>
        )}
      </legend>
      {hint && !error && (
        <FieldHint id={hintId} className="mb-2">
          {hint}
        </FieldHint>
      )}
      <div className={optionsClassName ?? "space-y-2"}>{children}</div>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </fieldset>
  );
}

// ---------- Localized native validation ------------------------------------
//
// Native HTML5 constraint bubbles ("Please fill out this field.") follow the
// BROWSER language, not the page's lang attribute — an es-AR product must not
// surface English validation (QA round 2 2026-07-03 #6). Every LN control
// localizes the bubble via setCustomValidity at `invalid` time and clears it
// on input so re-validation runs against the native constraints again.

type ValidatableControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** es-AR message for the control's current ValidityState. Exported for tests. */
export function localizedValidationMessage(el: ValidatableControl): string {
  const v = el.validity;
  if (v.valueMissing) return "Completá este campo.";
  if (v.typeMismatch && el instanceof HTMLInputElement && el.type === "email")
    return "Ingresá una dirección de email válida.";
  if (v.typeMismatch && el instanceof HTMLInputElement && el.type === "url")
    return "Ingresá una URL válida.";
  if (v.patternMismatch) return "Revisá el formato de este campo.";
  if (v.tooShort && "minLength" in el && el.minLength > 0)
    return `Usá al menos ${el.minLength} caracteres.`;
  if (v.tooLong && "maxLength" in el && el.maxLength > 0)
    return `Usá como máximo ${el.maxLength} caracteres.`;
  if (v.rangeUnderflow && el instanceof HTMLInputElement)
    return `El valor debe ser ${el.min} o mayor.`;
  if (v.rangeOverflow && el instanceof HTMLInputElement)
    return `El valor debe ser ${el.max} o menor.`;
  if (v.stepMismatch || v.badInput) return "Ingresá un valor válido.";
  return "Revisá este campo.";
}

// One scroll per submit attempt, aimed at the FIRST invalid control. The
// browser fires `invalid` on every failing control in DOM order and shows its
// transient bubble only on the first — in a long form (the org maltrato
// report was the live case, 2026-08-18) that bubble can appear far above the
// submit button the user is looking at and vanish before they scroll, so the
// click reads as "nothing happened". The re-arm window collapses the burst of
// invalid events from a single submit into one scroll.
let invalidScrollArmed = true;

/**
 * Compose the caller's handlers with the localization ones. The `invalid`
 * handler must set the message synchronously so the bubble the browser is
 * about to display already carries the es-AR copy; clearing on input lets the
 * next validation pass re-evaluate the native constraints from scratch.
 */
function withLocalizedValidity<E extends ValidatableControl>(rest: {
  onInvalid?: React.FormEventHandler<E>;
  onInput?: React.FormEventHandler<E>;
}): { onInvalid: React.FormEventHandler<E>; onInput: React.FormEventHandler<E> } {
  return {
    onInvalid: (e) => {
      rest.onInvalid?.(e);
      if (!e.defaultPrevented) {
        e.currentTarget.setCustomValidity(localizedValidationMessage(e.currentTarget));
      }
      if (invalidScrollArmed) {
        invalidScrollArmed = false;
        setTimeout(() => {
          invalidScrollArmed = true;
        }, 150);
        // Instant (non-smooth) — safe under prefers-reduced-motion without a
        // media query, and the jump itself is the signal. Optional call:
        // jsdom doesn't implement scrollIntoView, and an uncaught throw
        // inside this handler killed a whole vitest worker — the run
        // reported 1290/1292 files with zero failures, and only the summary
        // arithmetic (25 tests unaccounted) betrayed the missing file.
        e.currentTarget.scrollIntoView?.({ block: "center" });
      }
    },
    onInput: (e) => {
      e.currentTarget.setCustomValidity("");
      rest.onInput?.(e);
    },
  };
}

// ---------- Mobile keyboard focus scroll ------------------------------------
//
// On phones the software keyboard can cover the focused control, especially
// under sticky sheet footers (native-mobile audit §8). Scroll the control to
// the center of the viewport shortly after focus — the delay lets the keyboard
// finish resizing the visual viewport first. Mobile-width only: desktop
// keyboards never cover inputs, and mid-page jumps there would be noise.

function scrollControlIntoView(el: ValidatableControl) {
  if (typeof window === "undefined") return;
  if (!window.matchMedia("(max-width: 767px)").matches) return;
  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  window.setTimeout(() => {
    if (el.isConnected) el.scrollIntoView({ block: "center", behavior });
  }, 250);
}

/** Compose the caller's onFocus with the mobile keyboard-avoidance scroll. */
function withMobileFocusScroll<E extends ValidatableControl>(rest: {
  onFocus?: React.FocusEventHandler<E>;
}): { onFocus: React.FocusEventHandler<E> } {
  return {
    onFocus: (e) => {
      rest.onFocus?.(e);
      scrollControlIntoView(e.currentTarget);
    },
  };
}

// ---------- Shared control base classes -----------------------------------

// Wave 2 Item 9: text-base on mobile prevents iOS Safari auto-zoom on focus;
// sm:text-md restores the design-system size on wider viewports.
// min-h-[44px] ensures touch targets meet WCAG 2.5.5 (44×44 CSS px).
const controlBase =
  "w-full min-h-[44px] rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] " +
  "bg-[var(--color-ln-card)] px-3 py-2.5 " +
  "font-ln-sans text-base sm:text-md text-[var(--color-ln-ink)] " +
  "placeholder:text-[var(--color-ln-faint)] outline-none " +
  "focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)] " +
  "aria-[invalid=true]:border-[var(--color-ln-err)]";

const controlMono = `${controlBase} font-ln-mono tracking-[.02em]`;

/**
 * The LnInput chrome as a plain class string, for controls that are NOT a bare
 * `<input>` and therefore cannot render through LnInput — e.g. DateInputAr,
 * which owns its own visible input plus a hidden ISO twin. Exported so those
 * call sites wear the IDENTICAL chrome instead of re-declaring it (a copy would
 * drift, and would carry this file's grandfathered arbitrary font-size into a
 * file the design-tokens ratchet scans at a baseline of zero).
 *
 * `LN_CONTROL_MONO_CLASS` is the `mono` variant — codes, chip numbers, dates.
 */
export const LN_CONTROL_CLASS = controlBase;
export const LN_CONTROL_MONO_CLASS = controlMono;

// ---------- Input ---------------------------------------------------------

export type LnInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  /** Mono variant for codes, dates, chip/passport numbers */
  mono?: boolean;
};

export function LnInput({ invalid = false, mono = false, className = "", ...rest }: LnInputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={[mono ? controlMono : controlBase, className].filter(Boolean).join(" ")}
      {...rest}
      {...withLocalizedValidity<HTMLInputElement>(rest)}
      {...withMobileFocusScroll<HTMLInputElement>(rest)}
    />
  );
}

// ---------- Password input (con revelar) ----------------------------------

/**
 * LnPasswordInput — campo de contraseña con botón de revelar.
 *
 * POR QUÉ (crítica de diseño 2026-07-27, hallazgo U5): sin este toggle, "el
 * no-técnico tipea a ciegas en el teléfono y falla más". El hallazgo nombraba
 * sólo el login, pero el caso peor son signup y reseteo: ahí se tipea una
 * contraseña NUEVA a ciegas, dos veces, y un error se descubre recién al
 * comparar.
 *
 * Decisiones:
 * - `type="button"` — un botón sin type dentro de un form ES submit por
 *   defecto: revelar la contraseña enviaría el formulario.
 * - Vuelve a `password` al desmontar no hace falta, pero el estado es local por
 *   campo: revelar uno no revela el otro (importa en signup/reset, que tienen
 *   dos).
 * - 44px de área táctil (fence `lint:ui` / a11y-touch-targets), con el ícono
 *   más chico centrado adentro.
 * - `aria-pressed` en vez de cambiar el label: el lector de pantalla anuncia el
 *   estado sin que el nombre del control cambie bajo el foco.
 */
export function LnPasswordInput({ invalid = false, className = "", ...rest }: LnInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <LnInput
        {...rest}
        invalid={invalid}
        type={visible ? "text" : "password"}
        className={["pr-12", className].filter(Boolean).join(" ")}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
        title={visible ? "Ocultar contraseña" : "Mostrar contraseña"}
        className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]"
      >
        <Icon name={visible ? "anonimo" : "ojo"} size="sm" decorative />
      </button>
    </div>
  );
}

// ---------- Select --------------------------------------------------------

export type LnSelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  children: ReactNode;
};

export function LnSelect({ invalid = false, className = "", children, ...rest }: LnSelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={[
        controlBase,
        // Custom chevron via bg-image; hide native arrow
        "appearance-none pr-[30px]",
        // SVG chevron background
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236E7B84' stroke-width='1.5' fill='none'/%3E%3C/svg%3E\")] bg-no-repeat bg-[right_12px_center]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
      {...withLocalizedValidity<HTMLSelectElement>(rest)}
    >
      {children}
    </select>
  );
}

// ---------- Textarea ------------------------------------------------------

export type LnTextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  invalid?: boolean;
};

export function LnTextarea({ invalid = false, className = "", ...rest }: LnTextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={[controlBase, "resize-y leading-[1.5]", className].filter(Boolean).join(" ")}
      {...rest}
      {...withLocalizedValidity<HTMLTextAreaElement>(rest)}
      {...withMobileFocusScroll<HTMLTextAreaElement>(rest)}
    />
  );
}

// ---------- File input -----------------------------------------------------

// Citizen twin of OpFileInput (components/ui/dashboard/OpFileInput.tsx) — read
// the WHY there; it is the same problem in both skins. Short version: the file
// control is the ONE input whose trigger text and "no file selected" status are
// drawn by the USER AGENT, in the browser's language, so an es-AR form rendered
// "Choose File / No file chosen". The `file:` pseudo-element restyles that
// button's box but never its words, so hiding the native control and driving it
// from a <label> is the only way to own them.
//
// Skin differences from the operator twin, both deliberate: pill radius (see
// Button.tsx — the citizen tier is pill at every size, the operator tier keeps
// its 6px institutional rect) and the citizen focus-ring token. The 44px floor
// is NOT a skin difference — this label is the file field's control surface,
// and the floor is a field rule (LnButton does not carry it either).

export type LnFileInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  /** Visible trigger text. Defaults follow `multiple`. */
  label?: string;
  /** Selection summary. Pass `null` when the caller renders its own file list. */
  status?: string | null;
  /** Wrapper class — the trigger chrome itself is not overridable by design. */
  className?: string;
};

const LN_FILE_TRIGGER_CLASS =
  // No icon gap here (see the note on OpFileInput's trigger): LnButton's
  // arbitrary 7px gap separates an icon from a label, and this trigger has one
  // text child.
  "inline-flex items-center justify-center font-semibold " +
  "rounded-[var(--radius-pill)] border transition-colors cursor-pointer select-none " +
  "px-3.5 py-2 text-md min-h-[44px] " +
  "bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] border-[var(--color-ln-line-strong)] " +
  "hover:bg-[var(--color-ln-stripe)] active:scale-[0.98] active:opacity-90 " +
  "peer-disabled:cursor-not-allowed peer-disabled:opacity-60 " +
  "peer-focus-visible:outline-none peer-focus-visible:ring-[3px] " +
  "peer-focus-visible:ring-[var(--color-ln-celeste-050)]";

export function LnFileInput({
  label,
  status,
  className = "",
  multiple,
  id,
  ...rest
}: LnFileInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const statusId = `${inputId}-status`;

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      {/* Input BEFORE label: `peer-*` only reaches later siblings, so swapping
          these two silently drops the keyboard focus ring. */}
      <input
        {...rest}
        id={inputId}
        type="file"
        multiple={multiple}
        className="peer sr-only"
        aria-describedby={status === null ? undefined : statusId}
      />
      <label htmlFor={inputId} className={LN_FILE_TRIGGER_CLASS}>
        {label ?? (multiple ? "Elegir archivos" : "Elegir archivo")}
      </label>
      {status !== null && (
        <span id={statusId} aria-live="polite" className="text-sm text-[var(--color-ln-mute)]">
          {status || "Ningún archivo elegido"}
        </span>
      )}
    </div>
  );
}

// ---------- Row (2-column grid) -------------------------------------------

export function LnRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={["grid grid-cols-1 sm:grid-cols-2 gap-3", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

// ---------- Suffix wrap (e.g. "27.4 [kg]") --------------------------------

export type LnSuffixWrapProps = {
  suffix: string;
  children: ReactNode;
  className?: string;
};

export function LnSuffixWrap({ suffix, children, className = "" }: LnSuffixWrapProps) {
  return (
    <div
      className={[
        "flex items-stretch overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)]",
        "focus-within:border-[var(--color-ln-azul)] focus-within:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Input child gets border:0 via class override */}
      <div className="min-w-0 flex-1 [&>input]:border-0 [&>input]:shadow-none [&>input]:focus:border-0 [&>input]:focus:shadow-none">
        {children}
      </div>
      <span className="grid place-items-center border-l border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-[13px] font-ln-mono text-sm text-[var(--color-ln-mute)]">
        {suffix}
      </span>
    </div>
  );
}

// ---------- Checkbox -------------------------------------------------------
//
// INTENTIONAL cross-skin sharing (audit 2026-07-19, consistency/skin-validation):
// LnCheckbox hardcodes citizen tokens (ln-azul, ln-celeste-050, ln-err, ln-ink)
// but is also rendered on operator surfaces (/gob, /admin, /org). LnCheckbox's
// usage spans both skins broadly (signup, mis-mascotas, cuenta forms on the
// citizen side; gob/admin/org actions on the operator side), so a token swap
// here would be a wrong-skin fix for HALF its callers. Do not swap these
// tokens — this stays the citizen-skinned primitive.
//
// Follow-up SHIPPED (consistency/op-skin-followups, 2026-07-19):
// `OpCheckbox` now exists at components/ui/dashboard/OpField.tsx (ln-op-*
// tokens, identical structure/API). New operator call sites should use
// OpCheckbox; VerifiedFilterCheckbox and BulkApprovalQueueList were migrated.
// Remaining LnCheckbox usages under app/gob, app/admin, app/org are a known
// backlog — migrate opportunistically, not a hard blocker.
export type LnCheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> & {
  /** Sets aria-invalid="true" and applies error styling to the input. */
  invalid?: boolean;
  /** Label content. Omit for a label-less control (pass `aria-label` instead). */
  children?: ReactNode;
  /** Extra classes for the label text span. */
  labelClassName?: string;
};

export function LnCheckbox({
  invalid,
  children,
  className,
  labelClassName,
  id: idProp,
  ...rest
}: LnCheckboxProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;

  const input = (
    <input
      id={id}
      type="checkbox"
      aria-invalid={invalid || undefined}
      className={[
        "mt-0.5 h-4 w-4 shrink-0 cursor-pointer",
        "accent-[var(--color-ln-azul)]",
        "rounded-[var(--radius-sm)]",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]",
        invalid ? "outline outline-[1.5px] outline-[var(--color-ln-err)]" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
      {...withLocalizedValidity<HTMLInputElement>(rest)}
    />
  );

  // Label-less: render just the input — caller supplies aria-label.
  if (children == null) return input;

  return (
    <label htmlFor={id} className="flex items-start gap-2 cursor-pointer">
      {input}
      <span
        className={["text-md leading-tight text-[var(--color-ln-ink)]", labelClassName ?? ""]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </span>
    </label>
  );
}

// ---------- Radio ----------------------------------------------------------

export type LnRadioProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> & {
  /** Sets aria-invalid="true" and applies error styling to the input. */
  invalid?: boolean;
  /** Label content. Omit for a label-less control (pass `aria-label` instead). */
  children?: ReactNode;
  /** Extra classes for the label text span. */
  labelClassName?: string;
};

export function LnRadio({
  invalid,
  children,
  className,
  labelClassName,
  id: idProp,
  ...rest
}: LnRadioProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;

  const input = (
    <input
      id={id}
      type="radio"
      aria-invalid={invalid || undefined}
      className={[
        "mt-0.5 h-4 w-4 shrink-0 cursor-pointer",
        "accent-[var(--color-ln-azul)]",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]",
        invalid ? "outline outline-[1.5px] outline-[var(--color-ln-err)]" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
      {...withLocalizedValidity<HTMLInputElement>(rest)}
    />
  );

  // Label-less: render just the input — caller supplies aria-label.
  if (children == null) return input;

  return (
    <label htmlFor={id} className="flex items-start gap-2 cursor-pointer">
      {input}
      <span
        className={["text-md leading-tight text-[var(--color-ln-ink)]", labelClassName ?? ""]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </span>
    </label>
  );
}
