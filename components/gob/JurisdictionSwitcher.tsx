"use client";

import { useSearchParams } from "next/navigation";
import { useId, useMemo } from "react";

import { serverNavCommit } from "@/lib/ui/filter-commit";

/**
 * Selector de jurisdicción: provincia → localidad.
 *
 * Dos `<select>` nativos. El primero lista las provincias permitidas para el usuario
 * (manejadas por `govt_assignments` en el call site). El segundo lista las localidades
 * de la provincia seleccionada (el caller es responsable de fetchear esa lista).
 *
 * Comportamiento:
 *  - Al cambiar provincia, la localidad se limpia automáticamente.
 *  - Los cambios actualizan los searchParams vía una navegación de documento completa
 *    (`window.location.assign`), preservando todos los demás params presentes en la
 *    URL — NO usa `router.replace`/`router.refresh` (ver nota de diseño más abajo).
 *  - Si `allowedProvinces` tiene más de un elemento, el select de provincia incluye
 *    una opción vacía "Todas" para scope nacional.
 *  - El select de localidad queda `disabled` si no hay provincia seleccionada o si
 *    `localities` está vacío.
 *
 * Accesibilidad:
 *  - Cada select tiene un `<label>` vinculado via `htmlFor`.
 *  - Touch target mínimo de 44px (`min-h-11`).
 */

export type JurisdictionScope = {
  /** Código ISO 3166-2:AR. Ej: "AR-C" para CABA. null = scope nacional. */
  province: string | null;
  /** Slug de localidad. null si no aplica o no se seleccionó. */
  locality: string | null;
};

export type JurisdictionSwitcherProps = {
  /**
   * Provincias a las que el usuario tiene acceso.
   * Array vacío = acceso solo nacional.
   */
  allowedProvinces: Array<{ code: string; name: string }>;
  /** Localidades de la provincia actualmente seleccionada. El caller las fetchea. */
  localities?: Array<{ slug: string; name: string }>;
  /**
   * Claves de searchParam usadas para persistir la selección.
   * Default: { province: "province", locality: "locality" }.
   */
  paramKeys?: { province: string; locality: string };
  /**
   * Params extra a ELIMINAR en cada cambio de scope (además de actualizar
   * provincia/localidad). El caller del panorama pasa las claves de cámara
   * (z/lat/lng): una cámara sólo es válida para el scope en que se capturó, así
   * que al cambiar de jurisdicción hay que soltarla para que el nuevo scope se
   * encuadre solo. Vacío por defecto (p. ej. /gob/vigilancia no tiene cámara).
   */
  dropParamsOnNavigate?: readonly string[];
  /**
   * MODO EMBEBIDO (panorama embedded-drill). Cuando se pasa, el switcher NO hace
   * una navegación de documento completa: delega el commit del scope al caller,
   * que lo aplica de forma cliente (shallow History pushState + refetch, sin
   * recarga). El switcher pasa a ser CONTROLADO por `selectedProvince` /
   * `selectedLocality` (los searchParams ya no reflejan un commit shallow en
   * producción). Ausente → comportamiento clásico (searchParams +
   * `window.location.assign`), intacto para /gob/vigilancia y demás páginas
   * server-rendered.
   */
  onScopeCommit?: (scope: JurisdictionScope) => void;
  /**
   * Provincia seleccionada (controlada). Solo se usa en modo embebido
   * (`onScopeCommit` presente); en el modo clásico el valor viene de los
   * searchParams. Código ISO 3166-2:AR, o null/"" para scope nacional.
   */
  selectedProvince?: string | null;
  /** Localidad seleccionada (controlada), análoga a `selectedProvince`. */
  selectedLocality?: string | null;
  className?: string;
};

// Operator-only component (rendered exclusively under /gob dashboards and
// OpFilterBar) — uses ln-op-* tokens, not the citizen ln-* palette (audit
// 2026-07-19, consistency/skin-validation).
const selectClasses =
  "min-h-11 px-3 rounded-lg border border-ln-op-line bg-ln-op-card text-sm text-ln-op-ink " +
  "focus:border-ln-op-azul focus:outline-none focus:ring-2 focus:ring-ln-op-azul/20 " +
  "disabled:opacity-50 disabled:cursor-not-allowed w-full";

const labelClasses = "text-sm font-medium text-ln-op-ink-2";

export function JurisdictionSwitcher({
  allowedProvinces,
  localities = [],
  paramKeys = { province: "province", locality: "locality" },
  dropParamsOnNavigate = [],
  onScopeCommit,
  selectedProvince: controlledProvince,
  selectedLocality: controlledLocality,
  className = "",
}: JurisdictionSwitcherProps) {
  const searchParams = useSearchParams();
  const uid = useId();

  const provinceId = `${uid}-province`;
  const localityId = `${uid}-locality`;

  // Modo embebido: el valor viene del caller (controlado). En producción un
  // commit shallow no actualiza useSearchParams(), así que un switcher embebido
  // debe leer el scope efectivo del caller, nunca de los searchParams.
  const embedded = onScopeCommit !== undefined;
  const selectedProvince = embedded
    ? (controlledProvince ?? "")
    : (searchParams.get(paramKeys.province) ?? "");
  const selectedLocality = embedded
    ? (controlledLocality ?? "")
    : (searchParams.get(paramKeys.locality) ?? "");

  const showNationalOption = allowedProvinces.length > 1;

  // Design note (router-drop defect, engram #621 / verify-report #617
  // CRITICAL-1): Next 15.5.18's App Router can silently drop a client
  // transition's own fetch in production — the RSC request resolves 200
  // but the URL and UI never update. lib/ui/sheet-nav.ts cures this for the
  // pet profile by writing the URL directly via the native History API
  // (shallow routing), which works there because that page's content is
  // client-rendered.
  //
  // /gob/vigilancia is different: every panel (choropleth, KPI tiles,
  // signals, trend) is SERVER-rendered from `searchParams` on each request.
  // A shallow `history.replaceState` would update the URL/selects but leave
  // stale server-rendered content on screen. Pairing it with
  // `router.refresh()` doesn't provably fix the drop bug either —
  // `refresh()` goes through the SAME client-router transition machinery as
  // `replace()`/`push()`, so it is not known-safe.
  //
  // The one mechanism guaranteed immune to a client-router defect is
  // bypassing the client router entirely: a full document navigation. The
  // browser's native GET cannot be silently dropped, and it always re-runs
  // the server component with the new searchParams.
  function updateParams(updates: Record<string, string | null>) {
    // Scope change → drop any caller-nominated params tied to the OLD scope
    // (the panorama passes its camera keys; a stale frame must not survive).
    serverNavCommit(searchParams.toString())(updates, dropParamsOnNavigate);
  }

  function commitScope(province: string | null, locality: string | null) {
    // Modo embebido: delegar en el caller (commit cliente, sin recarga). El
    // caller es dueño de la URL (pushState + drop de cámara) y del refetch.
    if (onScopeCommit) {
      onScopeCommit({ province: province || null, locality: locality || null });
      return;
    }
    // Modo clásico: navegación de documento completa (server-rendered pages).
    updateParams({
      [paramKeys.province]: province,
      [paramKeys.locality]: locality,
    });
  }

  function handleProvinceChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    // Al cambiar provincia siempre limpiamos la localidad.
    commitScope(value || null, null);
  }

  function handleLocalityChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    commitScope(selectedProvince || null, value || null);
  }

  const localityDisabled = !selectedProvince || localities.length === 0;

  // Homonymous localities within a province collapse to the same slug (e.g. two
  // "San Pedro" in Córdoba). They resolve to the same query, so a duplicate
  // <option> adds no value and produces duplicate React keys. Dedupe by slug.
  const uniqueLocalities = useMemo(
    () => Array.from(new Map(localities.map((l) => [l.slug, l])).values()),
    [localities],
  );

  return (
    <div className={`flex flex-col sm:flex-row gap-4 sm:items-end ${className}`.trim()}>
      {/* Provincia */}
      <div className="flex flex-col gap-1 flex-1">
        <label htmlFor={provinceId} className={labelClasses}>
          Provincia
        </label>
        <select
          id={provinceId}
          value={selectedProvince}
          onChange={handleProvinceChange}
          className={selectClasses}
        >
          {showNationalOption && <option value="">Todas</option>}
          {allowedProvinces.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Localidad */}
      <div className="flex flex-col gap-1 flex-1">
        <label htmlFor={localityId} className={labelClasses}>
          Localidad
        </label>
        <select
          id={localityId}
          value={selectedLocality}
          onChange={handleLocalityChange}
          disabled={localityDisabled}
          className={selectClasses}
        >
          <option value="">Todas</option>
          {uniqueLocalities.map((l) => (
            <option key={l.slug} value={l.slug}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
