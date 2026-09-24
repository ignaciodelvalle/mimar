"use client";

import { useState } from "react";

import Link from "next/link";

import { searchLocalitiesPublicAction } from "@/app/actions/localities";
import { Icon } from "@/components/Icon";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnCheckbox, LnInput, LnSelect } from "@/components/ui/Field";
import {
  ADOPTION_AGE_BUCKETS,
  ADOPTION_ENERGY_LEVELS,
  ADOPTION_SIZE_ESTIMATES,
  type AdoptionListingFilters,
  buildSearchParams,
} from "@/lib/infra/adoption-listing";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { speciesLabelPlural } from "@/lib/utils/format";

// URL-driven filters bar — every change submits a GET form so the URL
// stays the source of truth (D11). No client state, no hydration mismatch.

// Which species are browsable here is a product choice (no "other" bucket);
// how each one is SPELLED is not — that comes from the shared map, so the
// dropdown and the active-filter chip below can never drift apart.
const SPECIES_VALUES = ["dog", "cat", "rabbit", "guinea_pig", "ferret"] as const;
const SPECIES_OPTIONS = SPECIES_VALUES.map((value) => ({
  value,
  label: speciesLabelPlural(value),
}));

const AGE_LABELS: Record<string, string> = {
  puppy: "Cachorra/o",
  junior: "Junior",
  young: "Joven",
  adult: "Adulto/a",
  senior: "Senior",
};

const SIZE_LABELS: Record<string, string> = {
  small: "Chico",
  medium: "Mediano",
  large: "Grande",
  xl: "Extra grande",
};

const ENERGY_LABELS: Record<string, string> = {
  low: "Tranquilo",
  medium: "Moderado",
  high: "Activo",
};

// Build a URL that removes a single filter key. Used by removable chips.
function urlWithout(filters: AdoptionListingFilters, key: keyof AdoptionListingFilters): string {
  const next = { ...filters };
  delete next[key];
  return `/adoptar?${buildSearchParams(next, null).toString()}`;
}

// Visible label for each active filter chip.
const CHIP_LABELS: Partial<Record<keyof AdoptionListingFilters, (v: unknown) => string>> = {
  species: (v) => speciesLabelPlural(String(v)),
  province: (v) => `Provincia: ${v}`,
  locality: (v) => `Localidad: ${v}`,
  ageBucket: (v) =>
    ({
      puppy: "Cachorra/o",
      junior: "Junior",
      young: "Joven",
      adult: "Adulto/a",
      senior: "Senior",
    })[v as string] ?? String(v),
  sizeEstimate: (v) =>
    ({ small: "Chico", medium: "Mediano", large: "Grande", xl: "Extra grande" })[v as string] ??
    String(v),
  energyLevel: (v) =>
    ({ low: "Tranquilo", medium: "Moderado", high: "Activo" })[v as string] ?? String(v),
  goodWithKids: () => "Con chicos",
  goodWithDogs: () => "Con perros",
  goodWithCats: () => "Con gatos",
  needsYard: () => "Sin patio requerido",
  hasMicrochip: () => "Con microchip",
  searchQuery: (v) => `"${v}"`,
};

export function AdoptionFiltersBar({ filters }: { filters: AdoptionListingFilters }) {
  const hasActiveFilters = Object.values(filters).some((v) => v !== undefined);
  const [provinceName, setProvinceName] = useState(filters.province ?? "");
  const provinceCode = PROVINCES.find((p) => p.name === provinceName)?.code;

  // Active chips: collect filter keys that have a non-undefined value and
  // have a defined chip label. organizationToken is intentionally excluded
  // (it's a programmatic filter applied by org pages, not by the user).
  const activeChips = (Object.keys(filters) as Array<keyof AdoptionListingFilters>).filter(
    (k) => filters[k] !== undefined && k !== "organizationToken" && CHIP_LABELS[k],
  );

  return (
    <div className="space-y-2">
      <form
        action="/adoptar"
        method="GET"
        className="rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4 space-y-3"
      >
        {/* Search box */}
        <div>
          <label
            htmlFor="q"
            className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
          >
            Buscar por nombre o raza
          </label>
          <LnInput
            id="q"
            type="search"
            name="q"
            maxLength={100}
            defaultValue={filters.searchQuery ?? ""}
            placeholder='Ej: "Laika" o "Labrador"'
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <div>
            <label
              htmlFor="species"
              className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
            >
              Especie
            </label>
            <LnSelect id="species" name="species" defaultValue={filters.species ?? ""}>
              <option value="">Todas</option>
              {SPECIES_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </LnSelect>
          </div>

          <div>
            <label
              htmlFor="provincia"
              className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
            >
              Provincia
            </label>
            <LnSelect
              id="provincia"
              name="provincia"
              value={provinceName}
              onChange={(e) => setProvinceName(e.target.value)}
            >
              <option value="">Todas</option>
              {PROVINCES.map((p) => (
                <option key={p.code} value={p.name}>
                  {p.name}
                </option>
              ))}
            </LnSelect>
          </div>

          <div>
            <label
              htmlFor="localidad-input"
              className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
            >
              Localidad
            </label>
            <LocalityPickerAcross
              key={provinceCode ?? "all"}
              id="localidad"
              name="localidad"
              scopeProvinceCode={provinceCode}
              disabled={!provinceName}
              defaultValue={{
                localityName: filters.locality ?? null,
                provinceName: provinceName || null,
              }}
              placeholder={provinceName ? "Buscar localidad…" : "Elegí una provincia"}
              searchAction={searchLocalitiesPublicAction}
            />
          </div>

          <div>
            <label
              htmlFor="edad"
              className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
            >
              Edad
            </label>
            <LnSelect id="edad" name="edad" defaultValue={filters.ageBucket ?? ""}>
              <option value="">Cualquiera</option>
              {ADOPTION_AGE_BUCKETS.map((b) => (
                <option key={b} value={b}>
                  {AGE_LABELS[b]}
                </option>
              ))}
            </LnSelect>
          </div>

          <div>
            <label
              htmlFor="talle"
              className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
            >
              Talle
            </label>
            <LnSelect id="talle" name="talle" defaultValue={filters.sizeEstimate ?? ""}>
              <option value="">Cualquiera</option>
              {ADOPTION_SIZE_ESTIMATES.map((s) => (
                <option key={s} value={s}>
                  {SIZE_LABELS[s]}
                </option>
              ))}
            </LnSelect>
          </div>

          <div>
            <label
              htmlFor="energia"
              className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
            >
              Energía
            </label>
            <LnSelect id="energia" name="energia" defaultValue={filters.energyLevel ?? ""}>
              <option value="">Cualquiera</option>
              {ADOPTION_ENERGY_LEVELS.map((e) => (
                <option key={e} value={e}>
                  {ENERGY_LABELS[e]}
                </option>
              ))}
            </LnSelect>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 items-center pt-1">
          <FilterCheckbox
            name="con_chicos"
            checked={filters.goodWithKids === true}
            label="Convive bien con chicos"
          />
          <FilterCheckbox
            name="con_perros"
            checked={filters.goodWithDogs === true}
            label="Convive bien con perros"
          />
          <FilterCheckbox
            name="con_gatos"
            checked={filters.goodWithCats === true}
            label="Convive bien con gatos"
          />
          <FilterCheckbox
            name="sin_patio"
            checked={filters.needsYard === false}
            label="Sin patio requerido"
          />
          <FilterCheckbox
            name="con_chip"
            checked={filters.hasMicrochip === true}
            label="Con microchip"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          {hasActiveFilters && (
            <Link
              href="/adoptar"
              className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-1.5 text-xs text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
            >
              Limpiar
            </Link>
          )}
          <button
            type="submit"
            className="rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] px-4 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-ln-azul-700)]"
          >
            Aplicar filtros
          </button>
        </div>
      </form>

      {/* Removable active-filter chips */}
      {activeChips.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          {activeChips.map((key) => {
            const labelFn = CHIP_LABELS[key];
            const label = labelFn ? labelFn(filters[key]) : String(filters[key]);
            return (
              <Link
                key={key}
                href={urlWithout(filters, key)}
                className="inline-flex items-center gap-[5px] rounded-full border px-2.5 py-1 text-sm font-medium hover:bg-[var(--color-ln-stripe)]"
                style={{
                  background: "var(--color-ln-celeste-050)",
                  borderColor: "var(--color-ln-celeste-100)",
                  color: "var(--color-ln-azul-700)",
                }}
              >
                {label}
                <Icon name="close" size="sm" decorative />
              </Link>
            );
          })}
          <Link
            href="/adoptar"
            className="text-sm font-medium hover:underline"
            style={{ color: "var(--color-ln-mute)" }}
          >
            Limpiar filtros
          </Link>
        </div>
      )}
    </div>
  );
}

// Thin adapter over the Poncho <Checkbox> for the compact filter bar:
// keeps the terse name/checked/label call-site API and the bar's muted register
// via labelClassName, while delegating the control styling to the primitive.
function FilterCheckbox({
  name,
  checked,
  label,
}: {
  name: string;
  checked: boolean;
  label: string;
}) {
  return (
    <LnCheckbox
      name={name}
      value="true"
      defaultChecked={checked}
      labelClassName="text-xs! text-[var(--color-ln-ink-2)]!"
    >
      {label}
    </LnCheckbox>
  );
}
