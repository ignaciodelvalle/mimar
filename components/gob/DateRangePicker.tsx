"use client";

import { type ChangeEvent, useId } from "react";

/**
 * Selector de rango de fechas con dos inputs nativos tipo `date`.
 *
 * - Los valores son strings ISO `yyyy-mm-dd` (o `null` cuando está vacío).
 * - Clamping automático: si el usuario elige `from > to`, `to` se iguala a `from`
 *   antes de emitir el cambio. Igualmente, si `to < from`, `from` se iguala a `to`.
 *   Esto mantiene siempre la invariante `from <= to`.
 * - Los props `minDate` / `maxDate` se pasan a los atributos `min` / `max` de los
 *   inputs nativos para restricción browser-nativa.
 * - Los labels son en español por defecto ("Desde" / "Hasta").
 *
 * @example
 * ```tsx
 * const [range, setRange] = useState({ from: null, to: null });
 * <DateRangePicker value={range} onChange={setRange} />
 * ```
 */

export type DateRange = {
  from: string | null;
  to: string | null;
};

export type DateRangePickerProps = {
  value: DateRange;
  onChange: (next: DateRange) => void;
  minDate?: string;
  maxDate?: string;
  fromLabel?: string;
  toLabel?: string;
  className?: string;
};

// Operator-only component (rendered exclusively inside PeriodPicker, itself
// operator-only) — uses ln-op-* tokens, not the citizen ln-* palette
// (audit 2026-07-19, consistency/skin-validation).
const inputClasses =
  "min-h-11 px-3 rounded-lg border border-ln-op-line bg-ln-op-card " +
  "text-sm text-ln-op-ink " +
  "focus:border-ln-op-azul focus:outline-none focus:ring-2 focus:ring-ln-op-azul/20 " +
  "w-full";

const labelClasses = "text-sm font-medium text-ln-op-ink-2";

export function DateRangePicker({
  value,
  onChange,
  minDate,
  maxDate,
  fromLabel = "Desde",
  toLabel = "Hasta",
  className = "",
}: DateRangePickerProps) {
  const uid = useId();
  const fromId = `${uid}-from`;
  const toId = `${uid}-to`;

  function handleFromChange(e: ChangeEvent<HTMLInputElement>) {
    const from = e.target.value || null;
    let to = value.to;

    // Clamping: si from > to, forzamos to = from
    if (from && to && from > to) {
      to = from;
    }

    onChange({ from, to });
  }

  function handleToChange(e: ChangeEvent<HTMLInputElement>) {
    const to = e.target.value || null;
    let from = value.from;

    // Clamping: si to < from, forzamos from = to
    if (to && from && to < from) {
      from = to;
    }

    onChange({ from, to });
  }

  return (
    <div className={`flex flex-col sm:flex-row gap-3 sm:items-end ${className}`.trim()}>
      {/* From */}
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className={labelClasses}>
          {fromLabel}
        </label>
        <input
          id={fromId}
          type="date"
          value={value.from ?? ""}
          onChange={handleFromChange}
          min={minDate}
          max={maxDate}
          className={inputClasses}
        />
      </div>

      {/* To */}
      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className={labelClasses}>
          {toLabel}
        </label>
        <input
          id={toId}
          type="date"
          value={value.to ?? ""}
          onChange={handleToChange}
          min={value.from ?? minDate}
          max={maxDate}
          className={inputClasses}
        />
      </div>
    </div>
  );
}
