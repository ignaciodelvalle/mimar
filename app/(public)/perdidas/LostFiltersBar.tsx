"use client";

import { useState } from "react";

import { searchLocalitiesPublicAction } from "@/app/actions/localities";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox, LnInput, LnSelect } from "@/components/ui/Field";
import { LOST_TIME_BUCKETS, type LostListingFilters } from "@/lib/infra/lost-listing";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { speciesLabelPlural } from "@/lib/utils/format";

// URL-driven filters bar — every change submits a GET form so the URL
// stays the source of truth (D11). No client state, no hydration mismatch.
// Visual idiom mirrors AdoptionFiltersBar.tsx: LN tokens, same grid layout.

// Same split as AdoptionFiltersBar: the value set is a product choice, the
// spelling comes from the shared map.
const SPECIES_VALUES = ["dog", "cat", "rabbit", "guinea_pig", "ferret"] as const;
const SPECIES_OPTIONS = SPECIES_VALUES.map((value) => ({
  value,
  label: speciesLabelPlural(value),
}));

const VISTO_LABELS: Record<string, string> = {
  today: "Hoy",
  week: "Esta semana",
  month: "Este mes",
};

export function LostFiltersBar({ filters }: { filters: LostListingFilters }) {
  const hasActiveFilters = Object.values(filters).some((v) => v !== undefined);
  const [provinceName, setProvinceName] = useState(filters.province ?? "");
  const provinceCode = PROVINCES.find((p) => p.name === provinceName)?.code;

  return (
    <form
      action="/perdidas"
      method="GET"
      className="rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4 space-y-3"
    >
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
            htmlFor="color"
            className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
          >
            Color
          </label>
          <LnInput
            id="color"
            type="text"
            name="color"
            defaultValue={filters.color ?? ""}
            placeholder="Ej: negro, atigrado"
          />
        </div>

        <div>
          <label
            htmlFor="visto"
            className="block font-ln-mono text-xs uppercase tracking-[0.1em] font-semibold text-[var(--color-ln-mute)] mb-1"
          >
            ¿Cuándo se perdió?
          </label>
          <LnSelect id="visto" name="visto" defaultValue={filters.visto ?? ""}>
            <option value="">Cualquier momento</option>
            {LOST_TIME_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {VISTO_LABELS[b]}
              </option>
            ))}
          </LnSelect>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-center pt-1">
        <FilterCheckbox
          name="con_chip"
          checked={filters.hasMicrochip === true}
          label="Con microchip"
        />
        <FilterCheckbox
          name="castrado"
          checked={filters.isSterilized === true}
          label="Castrado/a"
        />
        <FilterCheckbox
          name="criticidad"
          value="critical"
          checked={filters.criticality === "critical"}
          label="Crítica (últimas 24h)"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        {hasActiveFilters && (
          // LnButton in anchor mode (it renders a next/link when given `href`),
          // so the reset sits in the same family as the submit beside it. As a
          // hand-styled Link it kept a square corner next to a pill button —
          // two shapes for two halves of one control pair.
          <LnButton href="/perdidas" variant="ghost" size="sm">
            Limpiar
          </LnButton>
        )}
        {/* Was a raw <button> painted with --color-ln-err — the DANGER red — for
            a search. Nothing about filtering a public list is destructive, and
            err is reserved for states that are (X2-S2, review 2026-07-27). It
            was also the only square button left on this page once the citizen
            radius became the pill, which is what made it obvious. */}
        <LnButton type="submit" variant="primary" size="sm">
          Buscar
        </LnButton>
      </div>
    </form>
  );
}

function FilterCheckbox({
  name,
  checked,
  label,
  value = "true",
}: {
  name: string;
  checked: boolean;
  label: string;
  value?: string;
}) {
  return (
    <LnCheckbox
      name={name}
      value={value}
      defaultChecked={checked}
      labelClassName="text-xs! text-[var(--color-ln-ink-2)]!"
    >
      {label}
    </LnCheckbox>
  );
}
