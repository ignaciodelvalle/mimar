// Per-cápita encoding domain — province grain, v1 (panorama-percapita).
//
// The panorama's count layers paint ABSOLUTE province counts, so Buenos Aires
// always dwarfs Tierra del Fuego regardless of incidence. The per-cápita
// encoding renormalizes a count-shaped province cell by the INDEC census
// population: value10k = count / population × 10.000 — the same convention (and
// the SAME denominator table, `jurisdictions_census`) the "Mordeduras / 10.000
// habitantes" KPI (lib/analytics/govt-home-kpis.fetchBitesPer10k) already uses,
// so the map and the KPI can never disagree on what "por 10.000 hab." means.
//
// V1 IS PROVINCE-GRAIN ONLY: `jurisdictions_census` holds 24 province rows
// (Censo 2022) and NO department/locality populations. Below province framing
// per-cápita is NOT computable — the UI shows a disabled roadmap affordance
// ("Per cápita por departamento (en desarrollo)", requires an INDEC department
// import) and falls back to counts EXPLICITLY, never silently.
//
// PRIVACY (v1): the k=5 numerator suppression is applied UPSTREAM (repository
// rollups); a suppressed count reaches this module as null and STAYS null — no
// rate is ever derived from a hidden count. Every census population is >
// 190.000 (smallest: Tierra del Fuego, 190.641) — comfortably above
// MIN_PERCAPITA_DENOMINATOR below — so this floor is currently a no-op at
// province grain (regression-tested: province rates are byte-for-byte
// unchanged by its introduction).
//
// PHASE 2 (department grain) IS BLOCKED ON DATA: `jurisdictions_census` holds
// ONLY the 24 province rows (Censo 2022) — no department/locality
// populations exist yet (a separate workstream loads them; see AGENTS.md
// jurisdiction-compliance track). Department grain also stays OFF in the UI
// here: `AggregationLevel` (types.ts) has no "department" member and
// `percapitaEligibleFor` below still hard-gates `level !== "province"`. This
// module only builds the DENOMINATOR PRIVACY FLOOR (MIN_PERCAPITA_DENOMINATOR
// + isBelowPercapitaFloor) so that whichever future change wires department
// cells through `enrichPerCapita` inherits the floor "for free" — a
// data-arrival + flag-flip, not a re-derivation of this reasoning.
//
// THE FLOOR'S RATIONALE — why a denominator (not just the k=5 numerator) needs
// its own guard: department populations "go down to ~3 digits" (per the
// AGENTS.md gap note), and a rate's SENSITIVITY to one single case grows as
// its denominator shrinks (Δrate for +1 case = 10.000 / population). Below
// MIN_PERCAPITA_DENOMINATOR = 10.000, a single case moves the published rate
// by MORE than a full point (>1,00 por 10.000 hab.) — a jump precise and
// visible enough to read as "a case happened here" even for a numerator that
// individually cleared the k=5 bar, and precise enough that a DIFFERENCING
// attacker (subtracting visible per-cápita counts, reconstructed from the
// rate + the public census population, from an unsuppressed group/regional
// total — the same subtraction `complementarySuppress` in lib/metrics/
// anonymity.ts defends against at the COUNT level) can isolate a neighboring
// k-suppressed sibling's exact count with far less ambiguity than the raw
// suppression band (1..4) allows. The floor is DEFENSE IN DEPTH at the
// PRIMITIVE (perCapitaRate): it protects every future consumer, not only the
// one call site (enrichPerCapita) that remembers to check the upstream
// `suppressed` flag first.
//
// Pure module — NO @/db, NO next, NO React (hexagonal domain purity, enforced
// by the biome noRestrictedImports override for src/modules/*/domain/**).

import { getLayer } from "./layers";
import type { AggregationLevel, FeatureCollection, LayerId, PanoramaFeature } from "./types";

// ---------------------------------------------------------------------------
// Layer eligibility — a DECLARED per-layer property (the
// PROVINCE_ONLY_CHOROPLETH_IDS / NATIONAL_DEPARTMENT_GRAIN_IDS precedent).
// ---------------------------------------------------------------------------

/**
 * The layers whose PROVINCE cells are raw event/report COUNTS for which a
 * human-population denominator is meaningful — the per-cápita eligible set.
 *
 * WHY these four:
 *  - `perdidas`   — lost-pet reports per province: per-inhabitant incidence is
 *                   the honest cross-province comparison (population ∝ pets).
 *  - `mordeduras` — bite incidents: the KPI strip ALREADY reads this concept as
 *                   "Mordeduras / 10.000 habitantes" (fetchBitesPer10k) over the
 *                   SAME `jurisdictions_census` denominator. The MAP layer serves
 *                   raw counts (loadMordedurassByUnit) — dividing here is the
 *                   first and only division (no double-divide).
 *  - `denuncias`  — welfare reports per province: per-inhabitant report rate.
 *  - `sintomas`   — syndromic-surveillance reports: per-inhabitant incidence.
 *
 * WHY the rest are excluded:
 *  - cobertura / esterilizacion / microchip / ppp / antiparasitario — % rates
 *    over a PET denominator; dividing a percentage by humans is meaningless.
 *  - reunificacion — a ratePct signal (0-100), same reason.
 *  - acceso-veterinario — ALREADY normalized (visits per 1.000 pets); a second
 *    division would double-normalize.
 *  - indice-territorial — a 0-100 attainment index, not a count.
 *  - zoonosis — renders DEPARTMENT grain even at the national vista
 *    (NATIONAL_DEPARTMENT_GRAIN_IDS): its cells are departments, and v1 has no
 *    department census denominator (that is exactly the phase-2 gap).
 *  - mortalidad — deceased-pet counts: the meaningful denominator is the PET
 *    registry (like acceso-veterinario's per-1.000 pets), not the human census;
 *    a per-inhabitant pet-mortality rate would imply an incidence claim the
 *    denominator cannot support. (It is also the one count choropleth the admin
 *    cube serves — keeping it out keeps every eligible layer on the live
 *    province rollup path, per the "cube untouched" constraint.)
 *  - refugios / clinicas / decomisos — reference pins (individual entities),
 *    never per-unit counts.
 */
export const PERCAPITA_ELIGIBLE_IDS: ReadonlySet<LayerId> = new Set<LayerId>([
  "perdidas",
  "mordeduras",
  "denuncias",
  "sintomas",
]);

/** True when the layer's province cells may be re-encoded per 10.000 habitantes. */
export function isPercapitaEligible(id: LayerId): boolean {
  return PERCAPITA_ELIGIBLE_IDS.has(id);
}

/**
 * View-level gate predicate: the per-cápita encoding is offered iff
 *  - the view reads the PROVINCE axis (v1 has no finer census denominator), and
 *  - EVERY aggregating (non-reference) active layer is per-cápita eligible, and
 *    at least one is.
 *
 * The "every aggregating layer" rule exists because the graduated-symbol scale
 * is SHARED across the active count layers (graduatedMaxCount): transforming
 * only the base while a raw-count signal (zoonosis) rides the same scale would
 * mix units in one legend — a label≠map lie. Reference layers (refugios /
 * decomisos / clinicas) are pins, not counts; they never block. Mirrors the
 * bivariate P2 precedent: pin v1 to the sets the encoding can render honestly.
 */
export function percapitaEligibleFor(layers: readonly LayerId[], level: AggregationLevel): boolean {
  if (level !== "province") return false;
  let aggregating = 0;
  for (const id of layers) {
    const layer = getLayer(id);
    if (!layer || layer.dataType === "reference") continue;
    if (!isPercapitaEligible(id)) return false;
    aggregating += 1;
  }
  return aggregating > 0;
}

// ---------------------------------------------------------------------------
// The denominator privacy floor
// ---------------------------------------------------------------------------

/**
 * Minimum population a per-cápita denominator may have before its rate is
 * SUPPRESSED regardless of the numerator's own k-anon status. See the module
 * header for the full rationale; in short: below 10.000 hab. a single case
 * moves the published rate by more than a full point (10.000 / population >
 * 1,00), precise enough to defeat the numerator-side k=5 suppression via
 * differencing against an unsuppressed group/regional total.
 *
 * No-op today: every province population is > 190.000 (min: Tierra del Fuego,
 * 190.641). Exists so department grain (phase 2, BLOCKED on census data — see
 * module header) is safe the moment it ships, without re-deriving this rule.
 */
export const MIN_PERCAPITA_DENOMINATOR = 10_000;

/**
 * True when a population is present but too small to safely publish a
 * per-cápita rate over (see {@link MIN_PERCAPITA_DENOMINATOR}). A null/
 * missing/non-positive population is NOT "below the floor" — that is the
 * separate "no census match" no-data case ({@link perCapitaRate} already
 * returns null for it); this predicate answers "is a rate meaningful in
 * principle, but not privacy-safe to show."
 */
export function isBelowPercapitaFloor(population: number | null | undefined): boolean {
  return (
    typeof population === "number" &&
    Number.isFinite(population) &&
    population > 0 &&
    population < MIN_PERCAPITA_DENOMINATOR
  );
}

// ---------------------------------------------------------------------------
// The math
// ---------------------------------------------------------------------------

/**
 * value10k = count / population × 10.000 — the RAW, UNROUNDED rate.
 *
 * F2: a 2-decimal round here collapsed a tiny-but-real rate (1..8 events over
 * Buenos Aires's 17,5 M hab. ≈ 0,0006..0,0046) to 0 — a fabricated "no
 * incidence". A positive count must NEVER project to 0, so the math stays exact
 * and the SCALE (buildGraduatedScale) is the only place a max is quantized (for
 * binning), while {@link per10kDisplayValue} owns the honest small-rate LABEL.
 *
 * Returns null — NEVER 0 — when any arm is unusable: a null count (k-anon
 * suppressed upstream), a missing/non-positive population (no census row), or
 * a population below {@link MIN_PERCAPITA_DENOMINATOR} (the denominator
 * privacy floor — a rate over a tiny population is suppressed the same as a
 * rate over a hidden count, never fabricated as 0).
 */
export function perCapitaRate(
  count: number | null | undefined,
  population: number | null | undefined,
): number | null {
  if (typeof count !== "number" || !Number.isFinite(count)) return null;
  if (typeof population !== "number" || !Number.isFinite(population) || population <= 0) {
    return null;
  }
  if (isBelowPercapitaFloor(population)) return null;
  return (count / population) * 10_000;
}

/**
 * Honest es-AR display string for a per-10k rate (F2). The map paints the RAW
 * rate (see perCapitaRate), but a 2-decimal readout of a very small positive
 * rate rounds to "0,00" and reads as "no incidence". This display:
 *  - null / non-finite → "" (the caller renders its own no-data copy);
 *  - 0 < v < 0,005     → "<0,01" (positive, but below the 2-decimal grid);
 *  - otherwise         → es-AR with EXACTLY 2 decimals (a genuine 0 → "0,00").
 */
export function per10kDisplayValue(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value > 0 && value < 0.005) return "<0,01";
  return value.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// The census join (server-side enrichment)
// ---------------------------------------------------------------------------

/** The census lookup the repository loads from `jurisdictions_census` (24 rows). */
export type CensusLookup = {
  /** population keyed by CANONICAL province display name (the table's PK). */
  populations: Readonly<Record<string, number>>;
  /** Four-digit census year (e.g. 2022). */
  year: number;
  /** Human-readable source citation (e.g. "INDEC Censo 2022"). */
  source: string;
};

/**
 * Normalize a province name for the rollup↔census join: case/space tolerant and
 * accent-stripped (NFD + diacritic removal) — the SAME rule the bivariate join
 * uses (domain/bivariate.ts normName), so "Córdoba" matches "Cordoba" even if
 * one side lost its accent upstream. Both sides speak the canonical province
 * vocabulary (pets.jurisdiction_province ↔ jurisdictions_census.province_name,
 * schema comment on migration 0067), so this is belt-and-suspenders, not a
 * fuzzy match: an unmatched name stays unmatched → honest no-data.
 */
export function normalizeProvinceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** The structural props subset the enrichment reads (an AggregatedPointProps). */
type ProvinceCountProps = Record<string, unknown> & {
  province?: unknown;
  level?: unknown;
  count?: unknown;
  suppressed?: unknown;
};

/** Extra props the enrichment adds to a PROVINCE cell. Carried ON THE FEATURE
 * (not a side channel) so every payload path — Data Cache, first-visit seed,
 * saved boards — preserves them wherever the features travel. */
export type PerCapitaProps = {
  /** Census population for the cell's province; null = no census row matched. */
  population: number | null;
  /** count / population × 10.000 (2 decimals); null = suppressed or no census. */
  per10k: number | null;
  censusYear: number;
  censusSource: string;
};

/**
 * Join province-grain aggregated cells to the census lookup by normalized
 * province name, adding `population` / `per10k` / census metadata to each
 * PROVINCE feature. Non-province features pass through untouched. The raw
 * `count` is NOT modified here — {@link projectPerCapita} performs the swap at
 * render time, so the same enriched payload serves BOTH encodings.
 *
 * Honesty rules:
 *  - unmatched province → population null, per10k null (no-data, never 0);
 *  - suppressed / null count → per10k null (no rate from a hidden count);
 *  - population below {@link MIN_PERCAPITA_DENOMINATOR} (the denominator
 *    privacy floor — currently a no-op at province grain, live once a future
 *    change wires department cells through here) → per10k null AND the
 *    outgoing `suppressed` flag is forced true, so the map paints the SAME
 *    k-anon hatch treatment ("datos protegidos") a numerator-suppressed cell
 *    gets. A floor-suppressed unit must never render as a plain blank
 *    no-data cell — that would read as "no incidence" rather than
 *    "protected", the same honesty rule per10kDisplayValue's "<0,01" already
 *    enforces on the LABEL side.
 */
export function enrichPerCapita(
  features: FeatureCollection,
  lookup: CensusLookup,
): FeatureCollection {
  const byNorm = new Map<string, number>();
  for (const [name, population] of Object.entries(lookup.populations)) {
    byNorm.set(normalizeProvinceName(name), population);
  }
  return {
    type: "FeatureCollection",
    features: features.features.map((f) => {
      const p = f.properties as ProvinceCountProps;
      if (p.level !== "province" || typeof p.province !== "string") return f;
      const population = byNorm.get(normalizeProvinceName(p.province)) ?? null;
      const numeratorSuppressed = p.suppressed === true;
      const belowFloor = isBelowPercapitaFloor(population);
      const count = typeof p.count === "number" ? p.count : null;
      const per10k = numeratorSuppressed ? null : perCapitaRate(count, population);
      const enriched: PerCapitaProps = {
        population,
        per10k,
        censusYear: lookup.year,
        censusSource: lookup.source,
      };
      return {
        ...f,
        properties: {
          ...f.properties,
          ...enriched,
          suppressed: numeratorSuppressed || belowFloor,
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The render-time projection (client-side)
// ---------------------------------------------------------------------------

/**
 * Project an enriched province collection into its per-cápita encoding: `count`
 * becomes `per10k` so the graduated scale, legend, popup and table all read the
 * normalized value through the SAME property the count encoding uses (two
 * surfaces reading one value cannot diverge).
 *
 *  - suppressed cell → count null, `suppressed` PRESERVED (renders muted, the
 *    popup says "protegido" — k-anon propagates, per the bivariate precedent);
 *  - no census match → count null, suppressed false (honest no-data, never 0);
 *  - un-enriched feature (stale cache / census unavailable) → count null: the
 *    denominator is unknown, so no rate is claimed.
 */
export function projectPerCapita(features: FeatureCollection): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: features.features.map((f) => {
      const p = f.properties as ProvinceCountProps & Partial<PerCapitaProps>;
      if (p.level !== "province") return f;
      const per10k = typeof p.per10k === "number" ? p.per10k : null;
      return {
        ...f,
        properties: { ...f.properties, count: per10k, perCapita: true },
      } as PanoramaFeature;
    }),
  };
}

// ---------------------------------------------------------------------------
// Census metadata → the honest footer
// ---------------------------------------------------------------------------

/** Census metadata for the caption footer, read from the enriched features. */
export type CensusMeta = { year: number; source: string };

/** Read the census metadata off an enriched collection (null when absent —
 * the footer is then omitted rather than fabricated). */
export function censusMetaOf(features: FeatureCollection): CensusMeta | null {
  for (const f of features.features) {
    const p = f.properties as Partial<PerCapitaProps>;
    if (typeof p.censusYear === "number" && typeof p.censusSource === "string") {
      return { year: p.censusYear, source: p.censusSource };
    }
  }
  return null;
}

/** es-AR unit phrase — shared by the layer label, legend and popup surfaces. */
export const PERCAPITA_UNIT_LABEL = "por 10.000 hab.";

/**
 * The honest footer line, built from the census TABLE's own metadata (year +
 * source institution), never hardcoded: "Tasas por 10.000 habitantes — Censo
 * 2022 (INDEC)". The institution is the source citation's leading word (the
 * seeded rows read "INDEC Censo 2022"); a full-citation fallback keeps an
 * unexpected format honest rather than truncated wrong.
 */
export function percapitaFooterLabel(meta: CensusMeta): string {
  const institution = meta.source.trim().split(/[\s,]+/)[0] || meta.source;
  return `Tasas por 10.000 habitantes — Censo ${meta.year} (${institution})`;
}

/** Layer label with the per-10k unit appended — the ONE transform every surface
 * that names the layer (legend, popup, panel row) applies while the encoding is
 * active, so the unit switch is visible wherever the name is. */
export function percapitaLayerLabel(label: string): string {
  return `${label} (${PERCAPITA_UNIT_LABEL})`;
}
