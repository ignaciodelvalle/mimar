"use client";

// Client-side search filter form for /turnos/buscar.
//
// Replaces the plain locality/province text inputs with LocalityPickerAcross
// so users get autocomplete across the full ar_localities catalog. The picker
// emits rich hidden inputs; we mirror the picked result into `locality` and
// `province` hidden inputs that the server page reads via searchParams —
// same wire contract as before.

import { useState } from "react";

import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox, LnInput, LnSelect } from "@/components/ui/Field";
import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";
import { SERVICE_KINDS } from "@/lib/reference/service-kinds";

type Props = {
  currentServiceKind: string;
  currentProvince: string;
  currentLocality: string;
  currentFechaDesde: string;
  currentSoloGratis: boolean;
};

export function SearchFiltersForm({
  currentServiceKind,
  currentProvince,
  currentLocality,
  currentFechaDesde,
  currentSoloGratis,
}: Props) {
  // Track the selected locality result so we can derive locality + province
  // for the GET params. Pre-filled from the current search-param values so
  // the form renders the active filter on page load.
  const [pickedLocality, setPickedLocality] = useState<string>(currentLocality);
  const [pickedProvince, setPickedProvince] = useState<string>(currentProvince);

  function handleSelect(result: LocalitySearchResult | null) {
    if (result) {
      setPickedLocality(result.localityName);
      setPickedProvince(result.provinceName);
    } else {
      setPickedLocality("");
      setPickedProvince("");
    }
  }

  // Free-text typing (no dropdown pick): submit the typed locality and clear
  // the derived province — it can't be inferred from raw text, and keeping a
  // previously-picked province would submit a stale value.
  function handleQueryChange(query: string) {
    setPickedLocality(query);
    setPickedProvince("");
  }

  return (
    <form method="GET" className="space-y-3">
      <div className="flex flex-wrap gap-2 items-end">
        <div className="space-y-1">
          <label htmlFor="service_kind_sel" className="text-xs text-[var(--color-ln-mute)]">
            Servicio
          </label>
          {/* LnSelect, not a hand-painted <select>: the recipe here carried its
              own padding and rendered at 31px, while the locality picker in the
              same row — which does go through the primitive — sat at 44px
              (adversarial review 2026-08-08, S1-F07 / S3-F08). */}
          <LnSelect id="service_kind_sel" name="service_kind" defaultValue={currentServiceKind}>
            {SERVICE_KINDS.map((k) => (
              <option key={k.code} value={k.code}>
                {k.label}
              </option>
            ))}
          </LnSelect>
        </div>

        {/* Locality autocomplete — replaces the two plain text inputs.
            LocalityPickerAcross searches ar_localities across all provinces.
            The picker renders its own hidden inputs (provinceCode, provinceName,
            localityName, localityNameIndecId) for other consumers; we
            additionally mirror the pick into `locality` and `province` hidden
            inputs which are the names the BuscarTurnosPage searchParams expect. */}
        <div className="space-y-1">
          <label htmlFor="locality_picker" className="text-xs text-[var(--color-ln-mute)]">
            Localidad
          </label>
          <div className="w-64">
            <LocalityPickerAcross
              id="locality_picker"
              defaultValue={{
                localityName: currentLocality || null,
                provinceName: currentProvince || null,
              }}
              placeholder="Ej: Palermo, La Plata…"
              onSelect={handleSelect}
              onQueryChange={handleQueryChange}
            />
          </div>
        </div>

        {/* Hidden inputs wired to the GET query string names the page expects. */}
        <input type="hidden" name="locality" value={pickedLocality} />
        <input type="hidden" name="province" value={pickedProvince} />

        {/* size="lg" + self-stretch. At 29px this was the SHORTEST control on
            the screen and also the one that submits the search.
            lg alone is 43px (21px line + 20px padding + 2px border), NOT the
            44px the fields use — measured, after the first version of this
            comment simply asserted they matched. The row is `items-end`, so
            `self-stretch` is what actually makes it agree with its neighbours.
            LnButton carries no height floor by design (buttons answer to WCAG
            2.5.8 AA, 24px); this is the call site's job, not the primitive's. */}
        <LnButton type="submit" variant="primary" size="lg" className="self-stretch">
          Buscar
        </LnButton>
      </div>

      {/* Fase 10: additional filters — fecha_desde + solo_gratis */}
      <div className="flex flex-wrap gap-4 items-end">
        <div className="space-y-1">
          <label htmlFor="fecha_desde_inp" className="text-xs text-[var(--color-ln-mute)]">
            Desde
          </label>
          <LnInput
            id="fecha_desde_inp"
            name="fecha_desde"
            type="date"
            defaultValue={currentFechaDesde}
          />
        </div>
        <LnCheckbox name="solo_gratis" value="true" defaultChecked={currentSoloGratis}>
          Solo campañas gratuitas
        </LnCheckbox>
      </div>
    </form>
  );
}
