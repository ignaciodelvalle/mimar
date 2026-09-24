"use client";

// LibroFilterFields — combined Provincia/Localidad + Desde/Hasta children-slot
// control for admin/libro's OpFilterBar. COMMITS ON CHANGE, no "Aplicar"
// button (PO consistency fix 2026-07-21: "¿por qué en libro tenemos que
// aplicar y en el resto de las pantallas no?" — every OTHER OpFilterBar
// control already commits on-change).
//
// ROOT-CAUSE FIX (R2, opfilterbar-sweep-2026-07-21): libro was the ONLY
// screen composing BOTH shared <JurisdictionFilterFields> AND
// <DateRangeFilterFields> side by side, each owning its OWN <form> +
// "Aplicar" — so libro rendered TWO "Aplicar" buttons where every other
// OpFilterBar screen had zero or one. That was replaced with this single
// combined control, built from the underlying fields-only primitives
// (<JurisdictionFilter>, <DateInputAr> — neither renders its own <form> or
// button).
//
// ON-CHANGE FOLLOW-UP (2026-07-21, same day): this control used to batch all
// four params behind one shared <form> + "Aplicar", because JurisdictionFilter's
// locality field is a typeahead (LocalityPickerAcross) with no safe "complete
// value" signal to commit on per keystroke the way a masked date does. Fixed
// by wiring each control to the ACTUAL commit-worthy signal it already emits,
// same idea as DateRangeFilterFields' DateInputAr.onValueChange fix earlier
// that day:
//   - Province <select> onChange commits immediately, AND clears the
//     `localidad` param in the SAME commit — a locality only makes sense
//     within its own province (mirrors JurisdictionFilter's own remount-on-
//     province-change behavior, which resets the locality typeahead).
//   - Locality typeahead commits on `onSelect` (fires only on an actual pick,
//     never per keystroke) and on a full clear (`onQueryChange` firing with
//     `""`) — never on partial typing.
//   - Desde/Hasta use DateInputAr's `onValueChange` (complete-valid-or-cleared
//     only), exactly like DateRangeFilterFields.
// Every commit reads the OTHER three controls' current tracked values so
// changing one never wipes another, and goes through the same
// serverNavCommit primitive every other OpFilterBar control uses.
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";

import { JurisdictionFilter } from "@/components/JurisdictionFilter";
import { DateInputAr } from "@/components/ui/DateInputAr";
import { serverNavCommit } from "@/lib/ui/filter-commit";
import { isoToArDateDisplay, parseArDateToIso } from "@/lib/utils/date-input-ar";

// Mirrors DateInputAr's own tamper-safety check: a defaultValue that doesn't
// round-trip through the dd/mm/aaaa parser (e.g. a hand-edited
// ?desde=2026-99-99) is dropped instead of carried forward as this control's
// "preserve the other bound" state.
function sanitizeIso(raw: string | null | undefined): string {
  if (!raw) return "";
  const display = isoToArDateDisplay(raw);
  return display && parseArDateToIso(display) ? raw : "";
}

const captionClasses = "text-sm font-medium text-ln-op-ink-2";
const labelClassName = "flex w-full flex-col gap-1 sm:w-auto";

const selectClasses =
  "min-h-11 w-full rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 text-sm " +
  "text-ln-op-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul sm:w-[10rem]";

const dateInputClasses =
  "h-11 w-full rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 text-sm " +
  "text-ln-op-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul sm:w-[9.5rem]";

export type LibroFilterFieldsProps = {
  /** Current province NAME searchParam value ("provincia"), or undefined when unset. */
  provinceValue?: string;
  /** Current locality NAME searchParam value ("localidad"), or undefined when unset. */
  localityValue?: string;
  /** Current ISO (yyyy-mm-dd) "desde" value, or undefined when unset. */
  fromValue?: string;
  /** Current ISO (yyyy-mm-dd) "hasta" value, or undefined when unset. */
  toValue?: string;
  /** Extra searchParam keys to drop on commit (e.g. the keyset `cursor`). */
  resetParamsOnChange?: readonly string[];
};

export function LibroFilterFields({
  provinceValue,
  localityValue,
  fromValue,
  toValue,
  resetParamsOnChange = [],
}: LibroFilterFieldsProps) {
  const searchParams = useSearchParams();
  const uid = useId();
  const fromId = `${uid}-from`;
  const toId = `${uid}-to`;

  // Tracks each control's last commit-worthy value so changing ONE control
  // commits the OTHER THREE's current values too, instead of a stale initial
  // prop (same pattern as DateRangeFilterFields).
  const [provincia, setProvincia] = useState(provinceValue ?? "");
  const [localidad, setLocalidad] = useState(localityValue ?? "");
  const [fromIso, setFromIso] = useState(() => sanitizeIso(fromValue));
  const [toIso, setToIso] = useState(() => sanitizeIso(toValue));

  function commit(next: {
    provincia?: string;
    localidad?: string;
    desde?: string;
    hasta?: string;
  }) {
    serverNavCommit(searchParams.toString())(
      {
        provincia: (next.provincia ?? provincia) || null,
        localidad: (next.localidad ?? localidad) || null,
        desde: (next.desde ?? fromIso) || null,
        hasta: (next.hasta ?? toIso) || null,
      },
      resetParamsOnChange,
    );
  }

  function handleProvinceChange(newProvincia: string) {
    setProvincia(newProvincia);
    // A locality only makes sense within its own province — clear it in the
    // SAME commit (JurisdictionFilter also remounts the locality typeahead on
    // this change, so the UI and the URL agree).
    setLocalidad("");
    commit({ provincia: newProvincia, localidad: "" });
  }

  function handleLocalitySelect(name: string | null) {
    const next = name ?? "";
    setLocalidad(next);
    commit({ localidad: next });
  }

  function handleLocalityQueryChange(query: string) {
    // Only a full clear is commit-worthy; partial typing is not (matches
    // DateInputAr's own "never fire on a partial edit" contract).
    if (query !== "") return;
    handleLocalitySelect("");
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <JurisdictionFilter
        provinceParam="provincia"
        localityParam="localidad"
        defaultProvince={provinceValue ?? ""}
        defaultLocality={localityValue ?? ""}
        labelClassName={labelClassName}
        selectClassName={selectClasses}
        onProvinceChange={handleProvinceChange}
        onLocalitySelect={handleLocalitySelect}
        onLocalityQueryChange={handleLocalityQueryChange}
      />
      <label htmlFor={fromId} className={labelClassName}>
        <span className={captionClasses}>Desde</span>
        <DateInputAr
          id={fromId}
          name="desde"
          defaultValue={fromValue}
          className={dateInputClasses}
          onValueChange={(iso) => {
            setFromIso(iso);
            commit({ desde: iso });
          }}
        />
      </label>
      <label htmlFor={toId} className={labelClassName}>
        <span className={captionClasses}>Hasta</span>
        <DateInputAr
          id={toId}
          name="hasta"
          defaultValue={toValue}
          className={dateInputClasses}
          onValueChange={(iso) => {
            setToIso(iso);
            commit({ hasta: iso });
          }}
        />
      </label>
    </div>
  );
}
