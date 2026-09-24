"use client";

// JurisdictionFilterFields — shared Provincia/Localidad children-slot control
// for OpFilterBar screens that filter by jurisdiction NAME (not the ISO
// code + locality-slug pair <JurisdictionSwitcher>/OpFilterBar's own
// `jurisdiction` prop expects). Wraps the canonical <JurisdictionFilter>
// (province <select> + province-scoped locality typeahead over the full
// ~4000-row ar_localities catalog — see JurisdictionFilter.tsx for why a
// typeahead, not a <select>, is the only workable locality control at that
// scale) in a small self-contained <form> that commits BOTH fields together
// on one "Aplicar" click, via the SAME serverNavCommit primitive every other
// OpFilterBar control uses (full-document nav, immune to the Next 15.5.18
// router-drop defect, engram #621/#622) — mirrors DateRangeFilterFields'
// rationale exactly (a per-keystroke axis-style commit would fire on every
// character typed into the locality typeahead).
//
// NOT an `axis`: OpFilterBar's `jurisdiction` prop is built for
// <JurisdictionSwitcher> (ISO code + locality slug, requires the caller to
// have already fetched the selected province's localities server-side).
// Screens whose existing jurisdiction filter is keyed on province/locality
// NAMES (the JurisdictionFilter wire contract) render it here instead of
// forcing a conversion between the two schemes (F-migration 2026-07-21,
// admin/libro).
import { useSearchParams } from "next/navigation";
import { type FormEvent, useId } from "react";

import type { SearchLocalitiesResult } from "@/app/actions/localities";
import { JurisdictionFilter } from "@/components/JurisdictionFilter";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import { serverNavCommit } from "@/lib/ui/filter-commit";

const selectClasses =
  "min-h-11 w-full rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 text-sm " +
  "text-ln-op-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul sm:w-[10rem]";

export type JurisdictionFilterFieldsProps = {
  /** searchParam key for the province NAME. Default "province". */
  provinceParam?: string;
  /** searchParam key for the locality NAME. Default "locality". */
  localityParam?: string;
  /** Current province NAME, or null/undefined when unset. */
  provinceValue?: string | null;
  /** Current locality NAME, or null/undefined when unset. */
  localityValue?: string | null;
  /** Extra searchParam keys to drop on commit (e.g. a keyset `cursor`). */
  resetParamsOnChange?: readonly string[];
  /** Forwarded to JurisdictionFilter — pass the public search action for anonymous surfaces. */
  searchAction?: (input: {
    provinceCode?: string;
    query: string;
  }) => Promise<SearchLocalitiesResult>;
};

export function JurisdictionFilterFields({
  provinceParam = "province",
  localityParam = "locality",
  provinceValue,
  localityValue,
  resetParamsOnChange = [],
  searchAction,
}: JurisdictionFilterFieldsProps) {
  const searchParams = useSearchParams();
  const uid = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const province = (data.get(provinceParam) as string | null) || null;
    const locality = (data.get(localityParam) as string | null) || null;
    serverNavCommit(searchParams.toString())(
      { [provinceParam]: province, [localityParam]: locality },
      resetParamsOnChange,
    );
  }

  return (
    <form
      id={uid}
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3"
      aria-label="Filtro de jurisdicción"
    >
      <JurisdictionFilter
        provinceParam={provinceParam}
        localityParam={localityParam}
        defaultProvince={provinceValue ?? ""}
        defaultLocality={localityValue ?? ""}
        labelClassName="flex w-full flex-col gap-1 sm:w-auto"
        selectClassName={selectClasses}
        searchAction={searchAction}
      />
      <OpButton type="submit" variant="primary" size="sm" className="h-11 px-4">
        Aplicar
      </OpButton>
    </form>
  );
}
