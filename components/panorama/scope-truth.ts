// The panorama's ONE answer to "whose data am I looking at?" — pure, so every
// artifact the console emits (screen caption, dock meta line, exported PNG
// footer, printed informe) can cite the same derivation instead of re-deriving
// it.
//
// Why this file exists (QA 2026-08-01, government sanitary-authority walkthrough):
// the Registros table titled itself "Datos del mapa por unidad — Nacional,
// últimos 90 días." for an operator whose real reach was "CABA · 5 localidades".
// The caption read `buildViewMeta`'s scope label, which knows only whether the
// VIEW is drilled (province/locality filters), not what the OPERATOR is bounded
// to; with no drill it says "Nacional" for everyone. The masthead pill next to
// it already resolved the honest label through the `liveScopeLabel ||
// viewMeta.scopeLabel` cascade — but that cascade was hand-copied at each
// consumer, so a consumer that forgot it silently lied.
//
// The lesson is the general one: when two places COMPUTE the same thing instead
// of one CITING the other, they drift. `resolveScopeLabel` is that one place.

import { provinceByCode } from "@/lib/reference/ar-provincias";

/**
 * The scope label implied by the LIVE client scope state.
 *
 * An explicit province/locality drill names the drilled jurisdiction; no drill
 * falls back to the server-rendered default (`serverScopeLabel` — national for
 * an admin, the operator's real jurisdiction for a bounded govt account).
 *
 * Live-QA regression (2026-07-11): the masthead pill read the SERVER label
 * directly, so a shallow client drill (which never re-renders the server shell)
 * left it stuck on "Nacional · todas las provincias".
 *
 * Returns "" when there is no drill AND the caller supplied no server label
 * (embedded/test callers) — the empty string is the signal for
 * `resolveScopeLabel` to fall through to the view-derived label.
 */
export function deriveLiveScopeLabel(input: {
  /** Effective (URL or shallow-committed) province ISO code, or null. */
  province: string | null;
  /** Effective locality slug, or null. */
  locality: string | null;
  /** The server-rendered scope label for this operator, if the caller renders one. */
  serverScopeLabel: string | undefined;
  /** Provinces the operator may filter to (admin: all; govt: its own). */
  allowedProvinces: Array<{ code: string; name: string }> | undefined;
  /** Localities of the selected province (slug → display name). */
  localities: Array<{ slug: string; name: string }>;
}): string {
  const { province, locality, serverScopeLabel, allowedProvinces, localities } = input;
  // `!locality` is load-bearing, not defensive padding: a bounded govt operator's
  // province is IMPLICIT (the page passes `initialDivisionProvince`, and the
  // console keeps `effectiveScopeLocality` alive on that alone), so a locality
  // drill legitimately arrives with `province === null`. Dropping the clause
  // sends that drill back to the whole-jurisdiction label while the map shows
  // one barrio.
  if (!province && !locality) return serverScopeLabel ?? "";
  // QA fix (2026-07-11 adversarial cowork, §3): `allowedProvinces` only lists
  // provinces the OPERATOR is scoped to — an out-of-scope drill (forced via
  // ?province=, e.g. a govt-local operator probing AR-V/AR-Y) never appears in
  // it, so the lookup fell through to the raw ISO code ("AR-V") instead of a
  // name. provinceByCode is the full 24-province reference table (not
  // scope-gated), so it always resolves a real name for any valid code — the
  // fence itself (which data loads) is unaffected, this is display-only.
  const provinceName =
    (province ? allowedProvinces?.find((p) => p.code === province)?.name : undefined) ??
    (province ? provinceByCode(province)?.name : undefined) ??
    province ??
    "";
  if (locality) {
    const localityName = localities.find((l) => l.slug === locality)?.name ?? locality;
    return provinceName ? `${provinceName} · ${localityName}` : localityName;
  }
  return provinceName;
}

/**
 * THE scope-label cascade. Every artifact that names the scope must read this,
 * never `viewLabel` on its own.
 *
 * `liveLabel` (operator-aware: the bounded jurisdiction, or the drilled one)
 * outranks `viewLabel` (view-aware only: "Nacional" / "Provincia seleccionada"
 * / "Localidad seleccionada"). `viewLabel` survives only when there is no live
 * label at all — an embedded console with no server scope label — where the
 * coarse view label is the most honest thing available.
 */
export function resolveScopeLabel(liveLabel: string, viewLabel: string): string {
  return liveLabel || viewLabel;
}

/**
 * Caption of the dock's Registros table — the accessible per-unit projection of
 * what the map paints. Composed here so the caption and the label it states
 * cannot come apart.
 */
export function buildMapTableCaption(scopeLabel: string, periodLabel: string): string {
  return `Datos del mapa por unidad — ${scopeLabel}, ${periodLabel}.`;
}
