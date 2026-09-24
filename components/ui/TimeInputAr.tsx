"use client";

import { useId, useRef, useState } from "react";

import { maskArTimeInput, parseArTimeToHm } from "@/lib/utils/date-input-ar";

/**
 * Browser-independent HH:mm (24-hour) time input — the time twin of DateInputAr.
 *
 * WHY THIS EXISTS: native `<input type="time">` renders its visible text per
 * the browser's OS locale, exactly like `<input type="date">`. A viewer on an
 * en-US machine gets a 12-hour "07:30 PM" spinner sitting inside es-AR copy
 * that says 24 h, and every timestamp the product renders back is 24-hour — so
 * the entry idiom and the read idiom disagree on the most sensitive citizen
 * flows (a sighting hour, a time of death). This control renders an
 * author-owned TEXT input that displays and accepts `HH:mm` IDENTICALLY on
 * every browser, and emits that same "HH:mm" string via a hidden field.
 *
 * WIRING: mirrors DateInputAr exactly — the form reads `name`, which lives on
 * the HIDDEN input; the visible text input is intentionally NOT named so it is
 * never submitted. Pair it with a DateInputAr and compose the two halves
 * client-side when the consumer needs a single "YYYY-MM-DDTHH:mm" field (see
 * PetSightingForm, the canonical consumer).
 *
 * VALIDATION: the hidden value is kept in sync ON EVERY CHANGE — an implicit
 * Enter submit does not blur first, so the hidden field must already hold the
 * typed time. Blur normalizes and, for an out-of-range time (25:00, 12:75),
 * clears the hidden value and shows an inline es-AR hint so a wrong hour is
 * never submitted. The invalid blur also calls `setCustomValidity`, so the
 * hint is a real submit BLOCK rather than paint: the visible input is a plain
 * TEXT field, and "25:00" satisfies every native constraint a text field has
 * while the hidden value sits empty (same reasoning as DateInputAr's).
 *
 * A11Y: real text input with `inputMode="numeric"`, associated error via
 * `aria-describedby`/`aria-invalid`, fully keyboard-operable (no clock popup to
 * trap focus). Provide either an `id` targeted by an external `<label htmlFor>`
 * or an `aria-label`.
 */

const PLACEHOLDER = "hh:mm";
const INVALID_MESSAGE = "Hora inválida (usá hh:mm, 24 h)";

export type TimeInputArProps = {
  /** Submitted field name — carried by the hidden HH:mm input. */
  name: string;
  /** Initial "HH:mm" value (or null/empty for a blank field). */
  defaultValue?: string | null;
  /** Id for the visible text input, so an external `<label htmlFor>` binds it. */
  id?: string;
  /** Accessible name when there is no associated visible `<label>`. */
  ariaLabel?: string;
  /**
   * Extra element id(s) to describe the visible input — e.g. a form-level error
   * paragraph. Merged with (never replaced by) this control's own inline
   * invalid-time hint when that is showing.
   */
  ariaDescribedBy?: string;
  /** Classes applied to the visible text input (preserves per-surface styling). */
  className?: string;
  /**
   * External invalid flag, merged (OR) with the control's own inline
   * invalid-time state. Named with the hyphen ON PURPOSE: LnField's `invalid`
   * clones `"aria-invalid": true` onto its render-prop child, and a component
   * that doesn't accept the prop silently drops it — the visible input never
   * hears about a server-side validation error (panel review 2026-08-07, W4).
   */
  "aria-invalid"?: boolean;
  /**
   * Fires with the current "HH:mm" value ONLY when it is COMMIT-WORTHY: a
   * complete, in-range time, or the field was fully cleared (empty string).
   * Never fires for a partial/out-of-range in-progress edit — so a caller can
   * wire this straight into a per-keystroke-unsafe consumer (a composed hidden
   * field, a URL-navigating filter commit) without debouncing.
   */
  onValueChange?: (hm: string) => void;
  /**
   * Mirrors the HIDDEN input's value on EVERY change and blur — including the
   * empty string for an incomplete or out-of-range in-progress time. For
   * consumers that don't submit this control's own hidden field but COMPOSE its
   * value into another one (PetSightingForm pairs it with a DateInputAr into a
   * single "YYYY-MM-DDTHH:mm").
   *
   * NOT interchangeable with `onValueChange` — see DateInputAr's twin prop for
   * the full rationale: a composing consumer that only heard commit-worthy
   * values would keep submitting the PREVIOUS time while the field shows
   * something else.
   */
  onHiddenValueChange?: (hm: string) => void;
};

export function TimeInputAr({
  name,
  defaultValue,
  id,
  ariaLabel,
  ariaDescribedBy,
  className,
  "aria-invalid": externalInvalid,
  onValueChange,
  onHiddenValueChange,
}: TimeInputArProps) {
  const reactId = useId();
  const inputId = id ?? `${reactId}-time`;
  const errorId = `${reactId}-error`;

  // Only accept an IN-RANGE default, so a tampered/garbage value renders blank
  // rather than a nonsense "99:99" that would silently re-submit on an
  // unedited form (same fail-closed rule DateInputAr applies to its ISO default).
  const initialHm = parseArTimeToHm(defaultValue) ?? "";
  const [display, setDisplay] = useState(initialHm);
  const [hm, setHm] = useState(initialHm);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** Single writer for the hidden value, so its mirror callback can never be missed. */
  function writeHm(next: string) {
    setHm(next);
    onHiddenValueChange?.(next);
  }

  /**
   * Single writer for the invalid state, so the PAINTED error and the NATIVE
   * constraint can never disagree — an inline "Hora inválida" next to a form
   * that submits anyway is the defect this pairing exists to prevent.
   */
  function writeInvalid(next: boolean) {
    setInvalid(next);
    inputRef.current?.setCustomValidity(next ? INVALID_MESSAGE : "");
  }

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const masked = maskArTimeInput(event.target.value);
    setDisplay(masked);
    event.target.setCustomValidity("");
    if (invalid) writeInvalid(false);
    if (masked === "") {
      writeHm("");
      onValueChange?.("");
      return;
    }
    const parsed = parseArTimeToHm(masked);
    writeHm(parsed ?? "");
    // Only a COMPLETE, in-range time is commit-worthy — a partial or impossible
    // in-progress time (parsed === null) must not fire.
    if (parsed) onValueChange?.(parsed);
  }

  function handleBlur() {
    const trimmed = display.trim();
    if (!trimmed) {
      writeHm("");
      writeInvalid(false);
      return;
    }
    const parsed = parseArTimeToHm(trimmed);
    if (!parsed) {
      writeHm("");
      writeInvalid(true);
      return;
    }
    writeHm(parsed);
    setDisplay(parsed);
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
        aria-invalid={invalid || externalInvalid || undefined}
        aria-describedby={
          [ariaDescribedBy, invalid ? errorId : null].filter(Boolean).join(" ") || undefined
        }
        value={display}
        onChange={handleChange}
        onBlur={handleBlur}
        className={className}
      />
      <input type="hidden" name={name} value={hm} />
      {invalid ? (
        <p id={errorId} role="alert" className="text-sm text-[var(--color-st-err)]">
          {INVALID_MESSAGE}
        </p>
      ) : null}
    </>
  );
}
