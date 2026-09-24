"use client";

// DateRangeFilterFields — shared Desde/Hasta children-slot control for
// OpFilterBar screens whose date range has NO default bound (F-migration
// 2026-07-21 cluster 2: /admin/alertas, /admin/auditoria — /admin/libro
// composes the DIFFERENT LibroFilterFields, see that file). Unlike
// OpFilterBar's own `period` prop — which always resolves to a preset
// default (e.g. trailing12m) — these screens treat "no from/no to" as
// genuinely unbounded ("todas las fechas"), so routing them through `period`
// would silently introduce a default preset that never existed.
//
// COMMITS ON CHANGE, no "Aplicar" button (PO consistency fix 2026-07-21:
// "¿por qué en libro tenemos que aplicar y en el resto de las pantallas no?"
// — every OTHER OpFilterBar control already commits on-change). This used to
// need an explicit submit because a masked dd/mm/aaaa input can't commit
// per-keystroke (partial digits aren't a valid date). DateInputAr's
// `onValueChange` solves that at the source: it fires ONLY when a field is a
// COMPLETE valid date or has been fully CLEARED, never on a partial/invalid
// in-progress edit — so wiring it straight to serverNavCommit is exactly as
// safe as any other axis's onChange. Setting either bound preserves the
// OTHER bound's current value (tracked in local state, sanitized the same
// way DateInputAr blanks a tampered/invalid URL default) and navigates via
// the SAME serverNavCommit primitive every other OpFilterBar control uses.
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";

import { DateInputAr } from "@/components/ui/DateInputAr";
import { serverNavCommit } from "@/lib/ui/filter-commit";
import { isoToArDateDisplay, parseArDateToIso } from "@/lib/utils/date-input-ar";

// Mirrors DateInputAr's own tamper-safety check: a defaultValue that doesn't
// round-trip through the dd/mm/aaaa parser (e.g. a hand-edited
// ?from=2026-99-99) is dropped instead of carried forward as this control's
// "preserve the other bound" state.
function sanitizeIso(raw: string | null | undefined): string {
  if (!raw) return "";
  const display = isoToArDateDisplay(raw);
  return display && parseArDateToIso(display) ? raw : "";
}

const captionClasses = "text-sm font-medium text-ln-op-ink-2";

const dateInputClasses =
  "h-11 w-full rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 text-sm " +
  "text-ln-op-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul sm:w-[9.5rem]";

export type DateRangeFilterFieldsProps = {
  /** searchParam key for the range start. Default "from". */
  fromKey?: string;
  /** searchParam key for the range end. Default "to". */
  toKey?: string;
  /** Current ISO (yyyy-mm-dd) value of each bound, or null/undefined when unset. */
  fromValue?: string | null;
  toValue?: string | null;
  /** Extra searchParam keys to drop on commit (e.g. a keyset `cursor`). */
  resetParamsOnChange?: readonly string[];
};

export function DateRangeFilterFields({
  fromKey = "from",
  toKey = "to",
  fromValue,
  toValue,
  resetParamsOnChange = [],
}: DateRangeFilterFieldsProps) {
  const searchParams = useSearchParams();
  const uid = useId();
  const fromId = `${uid}-from`;
  const toId = `${uid}-to`;

  // Tracks each bound's last commit-worthy ISO so changing ONE field commits
  // the OTHER's current value too, instead of a stale initial prop.
  const [fromIso, setFromIso] = useState(() => sanitizeIso(fromValue));
  const [toIso, setToIso] = useState(() => sanitizeIso(toValue));

  function commit(next: { from?: string; to?: string }) {
    const from = next.from ?? fromIso;
    const to = next.to ?? toIso;
    serverNavCommit(searchParams.toString())(
      { [fromKey]: from || null, [toKey]: to || null },
      resetParamsOnChange,
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label htmlFor={fromId} className="flex w-full flex-col gap-1 sm:w-auto">
        <span className={captionClasses}>Desde</span>
        <DateInputAr
          id={fromId}
          name={fromKey}
          defaultValue={fromValue}
          className={dateInputClasses}
          onValueChange={(iso) => {
            setFromIso(iso);
            commit({ from: iso });
          }}
        />
      </label>
      <label htmlFor={toId} className="flex w-full flex-col gap-1 sm:w-auto">
        <span className={captionClasses}>Hasta</span>
        <DateInputAr
          id={toId}
          name={toKey}
          defaultValue={toValue}
          className={dateInputClasses}
          onValueChange={(iso) => {
            setToIso(iso);
            commit({ to: iso });
          }}
        />
      </label>
    </div>
  );
}
