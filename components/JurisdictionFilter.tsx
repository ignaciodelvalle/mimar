"use client";

// JurisdictionFilter — the single canonical province + locality control for
// filter bars across the system. Replaces the ad-hoc free-text province/
// locality inputs so a user can ONLY pick existing values:
//
//   - Province: a <select> over the canonical 24-province list (ar-provincias).
//   - Locality: a province-scoped typeahead (LocalityPickerAcross) that searches
//     the real ar_localities catalog for the chosen province. Instant ("option
//     B"): changing the province re-scopes the locality search immediately, and
//     the previously-picked locality is cleared.
//
// Why locality is a typeahead and not a <select>: there are ~4000 localities; a
// dropdown of hundreds per province would be unusable. The typeahead still
// guarantees "from-existing" — you pick from search results.
//
// Wire contract: submits the province NAME under `provinceParam` and the
// locality NAME under `localityParam` (the names the filter pages already read
// from searchParams). LocalityPickerAcross also emits its own provinceName/
// provinceCode/IndecId hidden inputs; pages that don't read them simply ignore
// the extra query params.

import { useState } from "react";

import type { SearchLocalitiesResult } from "@/app/actions/localities";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { PROVINCES } from "@/lib/reference/ar-provincias";

type Props = {
  /** GET param name carrying the province NAME. Default "province". */
  provinceParam?: string;
  /** GET param name carrying the locality NAME. Default "locality". */
  localityParam?: string;
  /** Active province NAME from the current filter (e.g. "Buenos Aires"). */
  defaultProvince?: string;
  /** Active locality NAME from the current filter. */
  defaultLocality?: string;
  labelProvince?: string;
  labelLocality?: string;
  /** Class for each field's <label> wrapper (match the host form). */
  labelClassName?: string;
  /** Class for the province <select> (match the host form's inputs). */
  selectClassName?: string;
  /** Injectable search action forwarded to LocalityPickerAcross. Defaults to the
   * auth-required variant. Pass searchLocalitiesPublicAction for public pages. */
  searchAction?: (input: {
    provinceCode?: string;
    query: string;
  }) => Promise<SearchLocalitiesResult>;
  /** Called with the new province NAME whenever the province choice changes
   * (in addition to the internal state update that re-scopes the locality
   * search). Lets a commit-on-change consumer (e.g. LibroFilterFields) fire
   * its own URL commit without owning a form/"Aplicar". */
  onProvinceChange?: (provinceName: string) => void;
  /** Forwarded to LocalityPickerAcross's `onSelect` — fires only on an actual
   * pick from the results list, never per keystroke. */
  onLocalitySelect?: (localityName: string | null) => void;
  /** Forwarded to LocalityPickerAcross's `onQueryChange` — fires on every
   * keystroke (typing, not just a pick). A commit-on-change consumer that
   * only cares about a full CLEAR should ignore every call except `""`. */
  onLocalityQueryChange?: (query: string) => void;
};

export function JurisdictionFilter({
  provinceParam = "province",
  localityParam = "locality",
  defaultProvince = "",
  defaultLocality = "",
  labelProvince = "Provincia",
  labelLocality = "Localidad",
  labelClassName,
  selectClassName,
  searchAction,
  onProvinceChange,
  onLocalitySelect,
  onLocalityQueryChange,
}: Props) {
  const [provinceName, setProvinceName] = useState(defaultProvince);

  // Province code drives the locality search scope. Derived from the canonical
  // list so it is always a valid province (or undefined for "Todas").
  const provinceCode = PROVINCES.find((p) => p.name === provinceName)?.code;

  return (
    <>
      <label className={labelClassName}>
        {labelProvince}
        <select
          name={provinceParam}
          value={provinceName}
          onChange={(e) => {
            setProvinceName(e.target.value);
            onProvinceChange?.(e.target.value);
          }}
          className={selectClassName}
        >
          <option value="">Todas</option>
          {PROVINCES.map((p) => (
            <option key={p.code} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label htmlFor="jurisdiction-filter-locality-input" className={labelClassName}>
        {labelLocality}
        <LocalityPickerAcross
          // Remount on province change so the query + picked locality reset —
          // a locality from the previous province is never carried over.
          key={provinceCode ?? "all"}
          id="jurisdiction-filter-locality"
          name={localityParam}
          scopeProvinceCode={provinceCode}
          disabled={!provinceName}
          defaultValue={{
            localityName: defaultLocality || null,
            provinceName: defaultProvince || null,
          }}
          placeholder={provinceName ? "Buscar localidad…" : "Elegí una provincia"}
          searchAction={searchAction}
          onSelect={onLocalitySelect ? (r) => onLocalitySelect(r?.localityName ?? null) : undefined}
          onQueryChange={onLocalityQueryChange}
        />
      </label>
    </>
  );
}
