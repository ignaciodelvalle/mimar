"use client";

// CoverageEditor — interactive province + locality picker with zone table.
//
// Province selection drives a searchParam update so the server can pass down
// the correct localities list (same pattern as JurisdictionSwitcher pages).
// Locality options are pre-loaded by the server page and passed as a prop.
//
// Design note (router-drop defect, same cure as components/gob/JurisdictionSwitcher.tsx):
// Next 15.5.18's App Router can silently drop a client transition's own fetch in
// production — the RSC request resolves 200 but the URL and UI never update.
// This page server-renders the locality options from `?province=` on every
// request, so a `router.replace` transition is exposed to the drop. A full
// document navigation (`window.location.assign`) is the one mechanism proven
// immune — the browser's native GET cannot be silently dropped, and it always
// re-runs the server component with the new searchParams.

import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { OpButton } from "@/components/ui/dashboard";
import type { OrganizationCoverage } from "@/db";
import type { LocalityOption } from "@/lib/infra/ar-localidades";
import type { Province } from "@/lib/reference/ar-provincias";
import { notifySaved } from "@/lib/ui/action-feedback";
import {
  addCoverageZoneAction,
  removeCoverageZoneAction,
  setPrimaryCoverageZoneAction,
} from "@/src/modules/organizations/actions";

const selectClasses =
  "min-h-11 px-3 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card text-md text-ln-op-ink " +
  "focus:border-ln-op-azul focus:outline-none focus:ring-1 focus:ring-ln-op-azul " +
  "disabled:opacity-50 disabled:cursor-not-allowed w-full";

const labelClasses = "text-sm font-medium text-ln-op-mute";

type Props = {
  orgToken: string;
  provinces: readonly Province[];
  localities: LocalityOption[];
  /** The province's CONFIRMED authority units (a draft governs nothing). */
  units?: ReadonlyArray<{ id: string; name: string }>;
  zones: OrganizationCoverage[];
  canManage: boolean;
};

const UNIT_PREFIX = "unit:";

/**
 * A locality's label in the picker: its name, plus its department whenever
 * another locality of the province shares the name (Mechita, partido Alberti
 * vs partido Bragado) — the option's VALUE is the catalogue row, so two
 * homonyms are two choices (localidades-por-id D5).
 */
function localityLabels(localities: LocalityOption[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const l of localities) counts.set(l.name, (counts.get(l.name) ?? 0) + 1);
  return new Map(
    localities.map((l) => [
      l.id ?? l.slug,
      (counts.get(l.name) ?? 0) > 1 && l.department ? `${l.name} (${l.department})` : l.name,
    ]),
  );
}

export function CoverageEditor({
  orgToken,
  provinces,
  localities,
  units = [],
  zones,
  canManage,
}: Props) {
  const labels = localityLabels(localities);
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const selectedProvinceCode = searchParams.get("province") ?? "";
  const selectedProvince = provinces.find((p) => p.code === selectedProvinceCode) ?? null;

  const [selectedLocality, setSelectedLocality] = useState<string>("");

  function handleProvinceChange(code: string) {
    setSelectedLocality("");
    setError(null);
    const params = new URLSearchParams(searchParams.toString());
    if (code) {
      params.set("province", code);
    } else {
      params.delete("province");
    }
    params.delete("locality");
    window.location.assign(`/org/${orgToken}/cobertura?${params.toString()}`);
  }

  function handleAdd() {
    if (!selectedProvince) return;
    setError(null);
    startTransition(async () => {
      const isUnit = selectedLocality.startsWith(UNIT_PREFIX);
      const result = await addCoverageZoneAction({
        orgToken,
        province: selectedProvince.name,
        locality: null,
        localityId: selectedLocality && !isUnit ? selectedLocality : null,
        unitId: isUnit ? selectedLocality.slice(UNIT_PREFIX.length) : null,
      });
      if ("error" in result) {
        setError(result.error);
      } else {
        setSelectedLocality("");
        notifySaved("Zona de cobertura agregada");
      }
    });
  }

  function handleRemove(coverageId: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeCoverageZoneAction({ orgToken, coverageId });
      if ("error" in result) {
        setError(result.error);
      } else {
        notifySaved("Zona de cobertura eliminada");
      }
    });
  }

  function handleSetPrimary(coverageId: string) {
    setError(null);
    startTransition(async () => {
      const result = await setPrimaryCoverageZoneAction({ orgToken, coverageId });
      if ("error" in result) {
        setError(result.error);
      } else {
        notifySaved("Zona marcada como principal");
      }
    });
  }

  return (
    <div className="space-y-6">
      {canManage && (
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-5 space-y-4">
          <h2 className="text-md font-semibold text-ln-op-ink">Agregar zona de cobertura</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="province-select" className={labelClasses}>
                Provincia
              </label>
              <select
                id="province-select"
                className={selectClasses}
                value={selectedProvinceCode}
                onChange={(e) => handleProvinceChange(e.target.value)}
                disabled={pending}
              >
                <option value="">Seleccioná una provincia…</option>
                {provinces.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="locality-select" className={labelClasses}>
                Localidad
              </label>
              <select
                id="locality-select"
                className={selectClasses}
                value={selectedLocality}
                onChange={(e) => setSelectedLocality(e.target.value)}
                disabled={pending || !selectedProvinceCode}
              >
                <option value="">Toda la provincia</option>
                {units.length > 0 && (
                  <optgroup label="Unidades de autoridad">
                    {units.map((u) => (
                      <option key={u.id} value={`${UNIT_PREFIX}${u.id}`}>
                        {u.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {localities
                  .filter((l) => l.id)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {labels.get(l.id as string)}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {error && (
            <p className="text-sm text-ln-op-danger" role="alert">
              {error}
            </p>
          )}

          <OpButton
            variant="primary"
            onClick={handleAdd}
            disabled={pending || !selectedProvinceCode}
          >
            {pending ? "Guardando…" : "Agregar zona"}
          </OpButton>
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-md font-semibold text-ln-op-ink">Zonas registradas ({zones.length})</h2>

        {zones.length === 0 ? (
          <p className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-4 py-6 text-center text-md text-ln-op-mute">
            Esta organización aún no tiene zonas de cobertura configuradas.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card">
            <table className="w-full text-md">
              <caption className="sr-only">
                Zonas de cobertura de la organización por provincia y localidad
              </caption>
              <thead>
                <tr className="border-b border-ln-op-line bg-ln-op-stripe">
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-sm font-medium text-ln-op-mute"
                  >
                    Provincia
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-sm font-medium text-ln-op-mute"
                  >
                    Localidad
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 text-left text-sm font-medium text-ln-op-mute"
                  >
                    Principal
                  </th>
                  {canManage && (
                    <th
                      scope="col"
                      className="px-4 py-3 text-right text-sm font-medium text-ln-op-mute"
                    >
                      Acciones
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-ln-op-line">
                {zones.map((zone) => (
                  <tr key={zone.id} className="hover:bg-ln-op-stripe/60">
                    <td className="px-4 py-3 text-ln-op-ink">{zone.jurisdictionProvince}</td>
                    <td className="px-4 py-3 text-ln-op-ink">
                      {zone.jurisdictionLocality ?? (
                        <span className="italic text-ln-op-mute">Toda la provincia</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {zone.isPrimary ? (
                        <span className="inline-flex items-center rounded-full bg-ln-op-blue-bg px-2.5 py-0.5 text-sm font-medium text-ln-op-azul border border-ln-op-blue-bd">
                          Principal
                        </span>
                      ) : (
                        <span className="text-ln-op-mute">—</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex gap-2">
                          {!zone.isPrimary && (
                            <OpButton
                              variant="ghost"
                              size="sm"
                              onClick={() => handleSetPrimary(zone.id)}
                              disabled={pending}
                            >
                              Marcar principal
                            </OpButton>
                          )}
                          <OpButton
                            variant="danger"
                            size="sm"
                            onClick={() => handleRemove(zone.id)}
                            disabled={pending}
                          >
                            Eliminar
                          </OpButton>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
