"use client";

import { useId, useRef, useState } from "react";

import { isoToArDateDisplay, maskArDateInput, parseArDateToIso } from "@/lib/utils/date-input-ar";

/**
 * Browser-independent dd/mm/aaaa date input.
 *
 * Born on the operator filter surfaces; also used on citizen forms (paired with
 * TimeInputAr — see PetSightingForm). The inline error therefore uses the
 * SKIN-NEUTRAL `--color-st-err` token, which resolves to ln-op-danger inside
 * `.op-surface` (zero visual diff for the operator consumers) and to ln-err on
 * a citizen page, instead of hard-coding the operator red on both.
 *
 * WHY THIS EXISTS: native `<input type="date">` renders its visible text per
 * the browser's OS locale. `lang="es-AR"` only works in Chromium — Safari and
 * Firefox ignore it and show mm/dd/yyyy on an en-US machine, so an es-AR
 * operator typing "03/07" (7-March) has it submitted as 3-July. This control
 * renders an author-owned TEXT input that displays and accepts `dd/mm/aaaa`
 * IDENTICALLY on every browser, while still emitting an ISO `yyyy-mm-dd` value
 * to the surrounding form via a hidden field.
 *
 * WIRING: the form reads `name` — that lives on the HIDDEN input carrying ISO.
 * The visible text input is intentionally NOT named, so it is never submitted
 * and the query still receives the exact same ISO value the native input did.
 * Drop-in for a `<input type="date" name=… defaultValue={iso}>` inside any GET
 * filter form.
 *
 * VALIDATION: the hidden ISO is kept in sync ON EVERY CHANGE — as soon as the
 * text forms a complete valid date it becomes the submitted value, so pressing
 * Enter (implicit GET-form submit, which does NOT blur first) submits the typed
 * date, not a stale/empty one. Blur normalizes the display and, for an
 * impossible/incomplete date (32/13/2026), clears the hidden ISO and shows an
 * inline es-AR hint so a wrong range is never submitted.
 *
 * …and that hint is backed by a NATIVE CONSTRAINT, not just paint. The visible
 * input is a plain TEXT field, so `required` is satisfied by any non-empty
 * string — "32/13/2026" passes it while the hidden ISO sits empty, and the
 * action receives occurredAt="". The invalid blur therefore also calls
 * `setCustomValidity(INVALID_MESSAGE)`, which is what the native `<input
 * type="date">` this control replaced got from `badInput` for free. Cleared on
 * the next edit and on a successful blur, so a corrected date submits again.
 *
 * A11Y: real text input with `inputMode="numeric"`, associated error via
 * `aria-describedby`/`aria-invalid`, fully keyboard-operable (no calendar
 * popup to trap focus). Provide either an `id` targeted by an external
 * `<label htmlFor>` or an `aria-label`.
 */

const PLACEHOLDER = "dd/mm/aaaa";
const INVALID_MESSAGE = "Fecha inválida (usá dd/mm/aaaa)";
// Native constraint bubbles follow the BROWSER language, not the page's `lang`
// — an es-AR product must not surface "Please fill out this field." (same rule
// components/ui/Field.tsx applies to every LN control). `valueMissing` is the
// only constraint this input can violate: it is a plain text field with no
// pattern/min/max, so one message covers the whole ValidityState surface.
const REQUIRED_MESSAGE = "Completá este campo.";

export type DateInputArProps = {
  /** Submitted field name — carried by the hidden ISO input. */
  name: string;
  /** Initial ISO `yyyy-mm-dd` value (or null/empty for a blank field). */
  defaultValue?: string | null;
  /** Id for the visible text input, so an external `<label htmlFor>` binds it. */
  id?: string;
  /** Accessible name when there is no associated visible `<label>`. */
  ariaLabel?: string;
  /**
   * Extra element id(s) to describe the visible input — e.g. a form-level error
   * paragraph. Merged with (never replaced by) this control's own inline
   * invalid-date hint when that is showing.
   */
  ariaDescribedBy?: string;
  /**
   * External invalid flag, merged (OR) with the control's own inline
   * invalid-date state. Named with the hyphen ON PURPOSE: LnField's `invalid`
   * clones `"aria-invalid": true` onto its render-prop child, and a component
   * that doesn't accept the prop silently drops it — the visible input never
   * hears about a server-side validation error (panel review 2026-08-07, W4).
   */
  "aria-invalid"?: boolean;
  /** Classes applied to the visible text input (preserves per-surface styling). */
  className?: string;
  /**
   * Marks the field mandatory on the VISIBLE input — native `required` (so the
   * browser still blocks an empty submit, exactly as `<input type="date"
   * required>` did) plus the implicit `aria-required` that comes with it.
   *
   * It cannot live on the hidden ISO input: hidden inputs are barred from
   * constraint validation, so a `required` there is silently ignored. The
   * visible input is unnamed and therefore never submitted, but it IS a form
   * control, so its constraint still gates submission.
   */
  required?: boolean;
  /**
   * Fires with the current ISO value ONLY when it is COMMIT-WORTHY: a
   * complete, calendar-valid date, or the field was fully cleared (empty
   * string). Never fires for a partial/incomplete/invalid in-progress edit —
   * so a caller can wire this straight into a per-keystroke-unsafe action
   * (e.g. a URL-navigating filter commit) without debouncing or a submit
   * button; see DateRangeFilterFields for the canonical consumer.
   */
  onValueChange?: (iso: string) => void;
  /**
   * Mirrors the HIDDEN input's value on EVERY change and blur — including the
   * empty string for an incomplete or impossible in-progress date. For
   * consumers that don't submit this control's own hidden field but COMPOSE its
   * value into another one (PetSightingForm pairs it with a TimeInputAr into a
   * single "YYYY-MM-DDTHH:mm").
   *
   * NOT interchangeable with `onValueChange`: that one deliberately stays
   * silent while a date is half-typed, so a URL-navigating consumer doesn't
   * navigate mid-keystroke. A composing consumer needs the opposite — if it
   * only heard about commit-worthy values, a field edited down to "03/0" would
   * keep submitting the PREVIOUS date while showing something else.
   */
  onHiddenValueChange?: (iso: string) => void;
};

export function DateInputAr({
  name,
  defaultValue,
  id,
  ariaLabel,
  ariaDescribedBy,
  className,
  required,
  "aria-invalid": externalInvalid,
  onValueChange,
  onHiddenValueChange,
}: DateInputArProps) {
  const reactId = useId();
  const inputId = id ?? `${reactId}-date`;
  const errorId = `${reactId}-error`;

  // Only accept a CALENDAR-valid ISO default (round-trip through the parser), so a
  // tampered URL like ?from=2026-99-99 renders blank, not a nonsense "99/99/2026"
  // that would silently re-submit garbage on an unedited form.
  const initialIso = (() => {
    const display = isoToArDateDisplay(defaultValue);
    return display && parseArDateToIso(display) ? (defaultValue ?? "") : "";
  })();
  const [display, setDisplay] = useState(isoToArDateDisplay(initialIso));
  const [iso, setIso] = useState(initialIso);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Single writer for the hidden ISO, so its mirror callback can never be missed. */
  function writeIso(next: string) {
    setIso(next);
    onHiddenValueChange?.(next);
  }

  /**
   * Single writer for the invalid state, so the PAINTED error and the NATIVE
   * constraint can never disagree — the whole defect being fixed is an inline
   * "Fecha inválida" sitting next to a form that submits happily.
   */
  function writeInvalid(next: boolean) {
    setInvalid(next);
    inputRef.current?.setCustomValidity(next ? INVALID_MESSAGE : "");
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const masked = maskArDateInput(event.target.value);
    setDisplay(masked);
    // Clear any custom message so the next validation pass re-evaluates the
    // native constraint from scratch (mirrors Field.tsx's withLocalizedValidity).
    event.target.setCustomValidity("");
    if (invalid) writeInvalid(false);
    // Keep the submitted ISO in sync on EVERY keystroke, not just on blur: an
    // implicit Enter submit does not fire blur, so the hidden field must already
    // hold the typed date. Empty → clear; a complete valid date → its ISO; an
    // incomplete/partial date → clear (blur will flag it invalid if the operator
    // leaves it that way).
    if (masked === "") {
      writeIso("");
      onValueChange?.("");
      return;
    }
    const parsed = parseArDateToIso(masked);
    writeIso(parsed ?? "");
    // Only a COMPLETE, calendar-valid date is commit-worthy — a partial or
    // impossible in-progress date (parsed === null) must not fire, or a
    // caller committing straight to a URL nav would navigate mid-keystroke.
    if (parsed) onValueChange?.(parsed);
  }

  function handleBlur() {
    const trimmed = display.trim();
    if (!trimmed) {
      writeIso("");
      writeInvalid(false);
      return;
    }
    const parsed = parseArDateToIso(trimmed);
    if (!parsed) {
      writeIso("");
      writeInvalid(true);
      return;
    }
    writeIso(parsed);
    setDisplay(isoToArDateDisplay(parsed));
    writeInvalid(false);
  }

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        id={inputId}
        inputMode="numeric"
        autoComplete="off"
        placeholder={PLACEHOLDER}
        aria-label={ariaLabel}
        required={required}
        onInvalid={(event) => {
          // Only the EMPTY-field case gets rewritten. An unparseable date has
          // already set its own custom message (writeInvalid), and validity
          // reports it as customError — overwriting it here would tell the
          // operator to "complete" a field they did complete, just wrongly.
          if (event.currentTarget.validity.valueMissing) {
            event.currentTarget.setCustomValidity(REQUIRED_MESSAGE);
          }
        }}
        aria-invalid={invalid || externalInvalid || undefined}
        aria-describedby={
          [ariaDescribedBy, invalid ? errorId : null].filter(Boolean).join(" ") || undefined
        }
        value={display}
        onChange={handleChange}
        onBlur={handleBlur}
        className={className}
      />
      <input type="hidden" name={name} value={iso} />
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-[var(--color-st-err)]">
          {INVALID_MESSAGE}
        </p>
      ) : null}
    </>
  );
}
