// Pure transforms: repository rows → typed GeoJSON FeatureCollections, per layer.
//
// Kept separate from the infrastructure repository (the DB layer) so the
// error-prone GeoJSON shaping is unit-testable WITHOUT a database. The
// repository's only job is to SELECT the row shapes these functions consume;
// all coordinate/null/property handling lives here on top of the domain
// geojson helpers.

import { ANONYMITY_K, suppressSmallCells } from "@/lib/metrics/anonymity";
import { DEPARTMENT_REPRESENTATIVE_POINTS } from "@/src/modules/panorama/domain/geo-representative-points";
import { featureCollection, pointFeature } from "@/src/modules/panorama/domain/geojson";
import type { FeatureCollection } from "@/src/modules/panorama/domain/types";

// --- perdidas (lost / sighting point layer) ---------------------------------

/** Row shape the repository must produce for the perdidas layer. lat/lng arrive
 * as strings from postgres numeric(10,7); either may be null. */
export type LostPointRow = {
  publicToken: string;
  name: string;
  species: string;
  status: string;
  locationLat: string | null;
  locationLng: string | null;
  lastSeenAt: string | null;
  /**
   * panorama-event-points Slice 1: how the sighting coordinate was captured
   * ('gps' | 'pin_manual' | 'geocodificada'), from the note_added payload. Null
   * for legacy sightings written before the field existed (forward-only). Drives
   * a subtle precision hint in the dot popup — carries NO PII.
   */
  locationSource: string | null;
};

/** GeoJSON feature properties for a perdidas point.
 *
 * PRIVACY INVARIANT (review A3/D7): carries only the public token + the
 * public-by-consent sighting facts (name, species, status, last-seen) and the
 * capture-precision hint. It deliberately carries NO `province` — that keeps
 * `shouldFetchHistory` false on a dot click (no k-anon unit-history double-fetch)
 * and the disclosure uniformly airtight for public-by-consent sightings. Do NOT
 * add `province` here. */
export type LostPointProps = {
  token: string;
  name: string;
  species: string;
  status: string;
  lastSeenAt: string | null;
  /** Coordinate-capture precision hint ('gps' | 'pin_manual' | 'geocodificada'); null when unknown. */
  locationSource: string | null;
};

/**
 * Build the perdidas FeatureCollection from repository rows. Non-located rows
 * (missing coordinate pair) are dropped — a point layer never emits null
 * geometry. Coordinate order + parsing is handled by the domain pointFeature.
 */
export function buildPerdidasFeatures(
  rows: readonly LostPointRow[],
): FeatureCollection<LostPointProps> {
  const features = rows
    .map((r) =>
      pointFeature<LostPointProps>(r.locationLat, r.locationLng, {
        token: r.publicToken,
        name: r.name,
        species: r.species,
        status: r.status,
        lastSeenAt: r.lastSeenAt,
        locationSource: r.locationSource,
      }),
    )
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- mordeduras (bite incident point layer) ---------------------------------

/** Row shape the repository produces for the mordeduras layer. */
export type BiteRow = {
  id: string;
  locationLat: string | null;
  locationLng: string | null;
  /** bite_inflicted | bite_suffered (incident_reported payload). */
  incidentType: string;
  severity: string | null;
  occurredAt: string | null;
};

export type BiteProps = {
  id: string;
  incidentType: string;
  severity: string | null;
  occurredAt: string | null;
};

export function buildMordedurasFeatures(rows: readonly BiteRow[]): FeatureCollection<BiteProps> {
  const features = rows
    .map((r) =>
      pointFeature<BiteProps>(r.locationLat, r.locationLng, {
        id: r.id,
        incidentType: r.incidentType,
        severity: r.severity,
        occurredAt: r.occurredAt,
      }),
    )
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- denuncias (welfare reports, COARSE locality-centroid) -------------------

/** Row shape the repository produces for the denuncias layer. The coordinate is
 * ALREADY the locality centroid — the exact report coord never reaches here
 * (privacy=coarse, spec §8). */
export type DenunciaCentroidRow = {
  centroidLat: string | null;
  centroidLng: string | null;
  province: string | null;
  locality: string | null;
  severity: string | null;
  kind: string | null;
  createdAt: string | null;
};

export type DenunciaProps = {
  /** Coarse marker — always true; signals the popup must NOT imply a precise spot. */
  coarse: true;
  province: string | null;
  locality: string | null;
  severity: string | null;
  kind: string | null;
  createdAt: string | null;
};

export function buildDenunciasFeatures(
  rows: readonly DenunciaCentroidRow[],
): FeatureCollection<DenunciaProps> {
  const features = rows
    .map((r) =>
      pointFeature<DenunciaProps>(r.centroidLat, r.centroidLng, {
        coarse: true,
        province: r.province,
        locality: r.locality,
        severity: r.severity,
        kind: r.kind,
        createdAt: r.createdAt,
      }),
    )
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- zoonosis (outbreak_signal point layer) ---------------------------------

export type OutbreakRow = {
  id: string;
  locationLat: string | null;
  locationLng: string | null;
  diseaseCode: string | null;
  diseaseLabel: string | null;
  occurredAt: string | null;
};

export type OutbreakProps = {
  id: string;
  diseaseCode: string | null;
  diseaseLabel: string | null;
  occurredAt: string | null;
};

export function buildZoonosisFeatures(
  rows: readonly OutbreakRow[],
): FeatureCollection<OutbreakProps> {
  const features = rows
    .map((r) =>
      pointFeature<OutbreakProps>(r.locationLat, r.locationLng, {
        id: r.id,
        diseaseCode: r.diseaseCode,
        diseaseLabel: r.diseaseLabel,
        occurredAt: r.occurredAt,
      }),
    )
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- refugios (shelter organizations point layer) ---------------------------

export type ShelterRow = {
  id: string;
  publicToken: string;
  displayName: string;
  locationLat: string | null;
  locationLng: string | null;
  verified: boolean;
};

export type ShelterProps = {
  token: string;
  name: string;
  verified: boolean;
};

export function buildRefugiosFeatures(
  rows: readonly ShelterRow[],
): FeatureCollection<ShelterProps> {
  const features = rows
    .map((r) =>
      pointFeature<ShelterProps>(r.locationLat, r.locationLng, {
        token: r.publicToken,
        name: r.displayName,
        verified: r.verified,
      }),
    )
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- decomisos (custody_episode cases point layer) --------------------------

// A case row carries NO point: cases_subject_location_consistency forbids a
// lat/lng on a registered-pet case. So a decomiso plots at its locality
// CENTROID (resolved in the repository from the case jurisdiction) — coarse,
// like denuncias, surfaced as such in the drawer.
export type DecomisoRow = {
  id: string;
  publicCode: string;
  status: string;
  centroidLat: string | null;
  centroidLng: string | null;
  openedAt: string | null;
};

export type DecomisoProps = {
  code: string;
  status: string;
  openedAt: string | null;
  /** Plotted at the locality centroid (the case carries no exact point). */
  coarse: true;
};

export function buildDecomisosFeatures(
  rows: readonly DecomisoRow[],
): FeatureCollection<DecomisoProps> {
  const features = rows
    .map((r) =>
      pointFeature<DecomisoProps>(r.centroidLat, r.centroidLng, {
        code: r.publicCode,
        status: r.status,
        openedAt: r.openedAt,
        coarse: true,
      }),
    )
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- choropleth (graduated-symbol centroid) layers --------------------------

/**
 * A k-anon-suppressed per-locality rollup cell.
 *
 * The map now HAS division polygons for a single-province scope (CABA barrios in
 * caba-barrios.geojson; departamentos in ar-departments.geojson), so a locality
 * choropleth cell is joined to its division and rendered as a POLYGON FILL when a
 * match exists. The centroid circle is retained ONLY as a fallback for a cell
 * whose locality has no polygon match (e.g. a non-CABA locality with no
 * `departmentCode`, or a name that matched no ar_localities row). `value` is null
 * for suppressed cells (count < k=5) — the real count NEVER leaves the repository
 * for those; a suppressed cell renders as an OUTLINE-only division (no fill) or a
 * muted "suprimido" dot when it falls back to the centroid.
 */
export type ChoroplethCell = {
  key: string;
  province: string;
  locality: string;
  centroidLat: string | null;
  centroidLng: string | null;
  /** INDEC 5-digit department code (ar_localities) — the departamento roll-up
   * join key. Null when the locality had no ar_localities match. Ignored for
   * CABA, where the barrio slug is derived client-side from `locality`. */
  departmentCode: string | null;
  /** Department display name for the division popup/legend (null when unmatched). */
  departmentName: string | null;
  /** The plotted value, or null when the cell is suppressed. */
  value: number | null;
  suppressed: boolean;
};

export type ChoroplethProps = {
  province: string;
  locality: string;
  /** Department roll-up join key (see ChoroplethCell.departmentCode). */
  departmentCode: string | null;
  /** Department display name (null when the locality had no ar_localities match). */
  departmentName: string | null;
  /** Real value for visible cells; null for suppressed ones. */
  value: number | null;
  suppressed: boolean;
};

/**
 * Build a locality-choropleth FeatureCollection. Each cell carries its centroid
 * (the polygon-fill fallback), its department code/name (the departamento
 * roll-up key), and its value/suppressed flag. Cells with no resolvable centroid
 * are dropped (a fully-unlocatable cell can neither fill a polygon nor plot a
 * dot). The map joins these cells to the active province's division polygons —
 * barrios for CABA, departamentos elsewhere — and falls back to the centroid
 * circle for any cell without a polygon match.
 */
export function buildChoroplethFeatures(
  cells: readonly ChoroplethCell[],
): FeatureCollection<ChoroplethProps> {
  const features = cells
    .map((c) =>
      pointFeature<ChoroplethProps>(c.centroidLat, c.centroidLng, {
        province: c.province,
        locality: c.locality,
        departmentCode: c.departmentCode,
        departmentName: c.departmentName,
        value: c.suppressed ? null : c.value,
        suppressed: c.suppressed,
      }),
    )
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- detail-tier DEPARTMENT aggregation (pure) ------------------------------
//
// The Panorama detail tier draws real administrative DIVISION polygons: barrios
// for CABA (caba-barrios.geojson), departamentos/partidos everywhere else
// (ar-departments.geojson). But the per-(province, locality) rollups aggregated —
// and k-anon-suppressed (k=5) — the DATA at LOCALITY granularity, one or two
// orders of magnitude finer than the polygon the operator actually sees. At
// panorama-seed scale that suppressed ~all cells (locality counts sit in 1–4, all
// below k=5), so the detail map read as empty even where a department had ample
// signal.
//
// The fix (PO decision "Option A"): make the DATA unit match the POLYGON unit —
// aggregate the locality rollup up to the department (CABA up to the barrio, which
// IS its locality and has no department in ar_localities) BEFORE k-anon. k=5 then
// applies at the department, which clears the threshold far more often (multiple
// localities per department), so the detail tier stops being suppressed-by-
// construction while the privacy floor is unchanged (a coarser unit is strictly
// MORE anonymising, never less).
//
// This is a PURE fold over the already-resolved locality rollup rows: each
// locality was pinned to ONE department via MIN(department_code) upstream, so
// summing localities into departments counts every pet exactly once even where a
// locality NAME is ambiguous across departments (57/3953 seed pairs). Kept here
// (not in the @/db repository) so it is unit-testable without a database.

/** Minimal per-locality rollup row shape the department fold reads/produces. It
 * mirrors the repository's internal RollupRow (a subset the pure fold needs). */
export type DepartmentRollupRow = {
  key: string;
  province: string;
  /** Locality name on input; on output it carries the DETAIL UNIT label
   * (department/partido name, or the barrio name for CABA). */
  locality: string;
  centroidLat: string | null;
  centroidLng: string | null;
  departmentCode?: string | null;
  departmentName?: string | null;
  count: number;
};

/** The province whose detail unit is the BARRIO (no ar_localities department). */
const BARRIO_ONLY_PROVINCE = "CABA";

/**
 * Fold a per-(province, locality) rollup up to the DETAIL UNIT:
 *  - CABA          → the barrio (the locality itself; carries no departmentCode).
 *  - every other   → the INDEC department/partido (via the row's departmentCode).
 *  - a locality that resolved NO department keeps its own bucket, so its pets are
 *    never dropped from the province total (preserves the U5 sum-reconciliation
 *    invariant: a province total still equals the sum of its detail cells).
 *
 * Counts are SUMMED (each pet is in exactly one locality → exactly one unit).
 *
 * The centroid is the department's PRECOMPUTED representative point
 * (DEPARTMENT_REPRESENTATIVE_POINTS — a point-on-surface anchor derived from
 * the department polygon itself, see domain/geo-representative-points.ts),
 * looked up by `departmentCode`. This replaces the old unweighted average of
 * the constituent locality centroids, which had no guarantee of landing
 * inside a concave/multi-part department polygon. A locality bucket that
 * resolved NO departmentCode (the `loc:` fallback bucket — no department to
 * look up a representative point for) keeps the locality-centroid average as
 * a fallback; CABA folds to the barrio itself, whose own (real) centroid is
 * unaffected by this change. The returned row's `locality` becomes the unit
 * display label and `departmentCode` the division-fill join key (null for
 * CABA — the map derives the barrio slug from the label).
 */
export function aggregateCellsToDepartment(
  localityRows: readonly DepartmentRollupRow[],
): DepartmentRollupRow[] {
  type Acc = {
    province: string;
    label: string;
    departmentCode: string | null;
    departmentName: string | null;
    latSum: number;
    lngSum: number;
    centroidN: number;
    count: number;
  };
  const byUnit = new Map<string, Acc>();

  for (const r of localityRows) {
    const isBarrio = r.province === BARRIO_ONLY_PROVINCE;
    const unitCode = isBarrio
      ? `barrio:${r.locality}`
      : r.departmentCode
        ? `dept:${r.departmentCode}`
        : `loc:${r.locality}`;
    const key = `${r.province}|${unitCode}`;

    let acc = byUnit.get(key);
    if (!acc) {
      acc = {
        province: r.province,
        label: isBarrio ? r.locality : (r.departmentName ?? r.locality),
        departmentCode: isBarrio ? null : (r.departmentCode ?? null),
        departmentName: isBarrio ? null : (r.departmentName ?? null),
        latSum: 0,
        lngSum: 0,
        centroidN: 0,
        count: 0,
      };
      byUnit.set(key, acc);
    } else if (
      // SUGGESTION 10 (dev-only): the rollup pins departmentCode + departmentName
      // via INDEPENDENT MIN() aggregates, so an ambiguous (province, locality) can
      // pin a code from one ar_localities row and a name from another → a latent
      // mislabel. Flag it in dev when two localities fold into the same code bucket
      // under divergent names. No-op in production (never a user-facing throw).
      process.env.NODE_ENV !== "production" &&
      !isBarrio &&
      acc.departmentCode &&
      acc.departmentName &&
      r.departmentName &&
      r.departmentName !== acc.departmentName
    ) {
      console.warn(
        `[panorama fold] department_code ${acc.departmentCode} maps to divergent names: "${acc.departmentName}" vs "${r.departmentName}" (province ${r.province}) — possible MIN(code)/MIN(name) mislabel`,
      );
    }
    acc.count += r.count;
    const lat = r.centroidLat != null ? Number(r.centroidLat) : Number.NaN;
    const lng = r.centroidLng != null ? Number(r.centroidLng) : Number.NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      acc.latSum += lat;
      acc.lngSum += lng;
      acc.centroidN += 1;
    }
  }

  const out: DepartmentRollupRow[] = [];
  for (const [key, acc] of byUnit) {
    // Prefer the department's precomputed representative point (guaranteed to
    // land on the department's own landmass); fall back to the averaged
    // locality centroid only when there's no departmentCode to look one up by
    // (the `loc:` bucket, or the point-on-surface asset is missing the code).
    const repPoint = acc.departmentCode
      ? DEPARTMENT_REPRESENTATIVE_POINTS[acc.departmentCode]
      : undefined;
    const centroidLat = repPoint
      ? String(repPoint.lat)
      : acc.centroidN > 0
        ? String(acc.latSum / acc.centroidN)
        : null;
    const centroidLng = repPoint
      ? String(repPoint.lng)
      : acc.centroidN > 0
        ? String(acc.lngSum / acc.centroidN)
        : null;
    out.push({
      key,
      province: acc.province,
      locality: acc.label,
      centroidLat,
      centroidLng,
      departmentCode: acc.departmentCode,
      departmentName: acc.departmentName,
      count: acc.count,
    });
  }
  return out;
}

// --- F1 aggregated point layer (one graduated symbol per administrative unit) -

/**
 * A per-unit aggregation cell for a density or signal point layer (F1).
 *
 * The repository produces one row per (province) or (province, locality) group
 * by executing COUNT(*) over the relevant event table. The centroid resolves
 * from ar_localities for locality-level cells; province-level cells carry the
 * province centroid (or null when no centroid is available for that province).
 *
 * `count` is ALWAYS the real event count — suppression at k=5 is applied before
 * the row reaches this transform for locality-level cells (matching the choropleth
 * path). Province-level cells carry the real count without suppression (province
 * cells are large; same asymmetry as the choropleth province path).
 */
export type AggregatedPointCell = {
  /** Composite key: `"${province}"` at province level, `"${province}|${locality}"` at locality. */
  key: string;
  province: string;
  locality?: string | null;
  /** INDEC department code (the fold's actual group key, MIN(department_code)) —
   * carried so a department drill can re-filter member localities by CODE, not the
   * ambiguous department NAME (re-identification guard, unit-history WARNING 3).
   * Null for province-level cells and CABA barrios (which have no department). */
  departmentCode?: string | null;
  /** Latitude of the centroid (province or locality). */
  centroidLat: string | null;
  /** Longitude of the centroid. */
  centroidLng: string | null;
  /** Event count for this unit. For suppressed locality cells this is null
   * (the real count never leaves the repository for k-anon). */
  count: number | null;
  /** True for suppressed locality cells (count < k=5). Province cells are never
   * suppressed. Suppressed cells render muted; their popup says "suprimido". */
  suppressed: boolean;
};

export type AggregatedPointProps = {
  /** The administrative unit label (locality + province, or province alone). */
  place: string;
  province: string;
  locality: string | null;
  /** INDEC department code for a folded detail cell (null at province level / CABA).
   * Threaded to the unit-history drill so member localities are matched by CODE. */
  departmentCode: string | null;
  /** "province" or "locality" — lets the popup and legend know the aggregation level. */
  level: "province" | "locality";
  /** Event count for this unit; null for k-anon suppressed cells. */
  count: number | null;
  suppressed: boolean;
};

/**
 * Build a graduated-symbol FeatureCollection from per-unit aggregation cells
 * (F1 density+signal layers). One Point feature per unit at its centroid;
 * cells without a resolvable centroid are dropped. Suppressed locality cells keep
 * their location but carry count=null so the map renders them muted.
 *
 * This is the pure-function counterpart to `buildChoroplethFeatures`: identical
 * in shape but driven by event counts rather than pet-state rollups.
 */
export function buildAggregatedPointFeatures(
  cells: readonly AggregatedPointCell[],
): FeatureCollection<AggregatedPointProps> {
  const features = cells
    .map((c) => {
      const level: "province" | "locality" = c.locality != null ? "locality" : "province";
      const place = c.locality != null ? `${c.locality}, ${c.province}` : c.province;
      return pointFeature<AggregatedPointProps>(c.centroidLat, c.centroidLng, {
        place,
        province: c.province,
        locality: c.locality ?? null,
        departmentCode: c.departmentCode ?? null,
        level,
        count: c.suppressed ? null : c.count,
        suppressed: c.suppressed,
      });
    })
    .filter((f) => f.geometry !== null);
  return featureCollection(features);
}

// --- province choropleth (U5: filled polygons, no centroid geometry) ---------

/**
 * A per-PROVINCE rollup cell (U5 aggregation level = province). Unlike the
 * locality cell it carries NO centroid: the map data-joins this to the LOCAL
 * ar-provinces basemap polygons by `provinceCode` and fills them by `value`.
 *
 * k-ANON AT PROVINCE GRAIN (task #40). This type used to declare "province cells
 * are large, so there is NO k-anon suppression here". That was true of a
 * province's POPULATION and false of its DENOMINATOR, which is what k-anonymity
 * is actually about: on a RATE layer Santa Cruz publishes 100% over 11 dogs and
 * its `value` is 100, not 11 — a threshold read off the value sees a big number
 * and publishes a cell describing eleven identifiable animals. Cells are now
 * built through `provinceCell`, whose signature makes the denominator
 * OBLIGATORY so no call site can repeat that mistake.
 */
export type ProvinceChoroplethCell = {
  /** ISO 3166-2:AR code, the join key against the basemap polygon `code`. */
  provinceCode: string;
  /** Canonical province display name (popup label). */
  label: string;
  /** NULL when k-anon suppressed — a protected cell has NO value, not a hidden
   *  one and never a zero (a false zero reads as real data AND leaks sub-k). */
  value: number | null;
  /** True when the cell's DENOMINATOR fell under k: render hatched, never
   *  stippled as "sin datos" and never absent. */
  suppressed: boolean;
};

/**
 * Properties for a province choropleth feature. The geometry is NULL (the fill
 * comes from the basemap polygon, matched by `provinceCode`); this feature is a
 * pure value carrier the SituationalMap reads to build the polygon fill+popup.
 */
export type ProvinceChoroplethProps = {
  provinceCode: string;
  province: string;
  /** null ⇔ `suppressed` (see ProvinceChoroplethCell.value). */
  value: number | null;
  suppressed: boolean;
};

/**
 * The k-anonymity threshold at province grain — the SAME k the locality and
 * department grains use (`suppressSmallCells`, AGENTS.md "Aggregation & privacy
 * policy"). Read from the shared primitive's default rather than re-declared, so
 * a future change to the policy moves every grain at once.
 */
export const PROVINCE_K = ANONYMITY_K;

/**
 * Build ONE province choropleth cell, deciding k-anon suppression from the
 * cell's `denominator`.
 *
 * THE DENOMINATOR IS A REQUIRED PARAMETER ON PURPOSE. Every province loader has
 * one (rabies → `total`, microchip → `active`, PPP → `flaggedCount`, density →
 * the count itself), and the one composite that does NOT (`indice-territorial`,
 * a mean of attainments) is excluded rather than fed a guess — see the note at
 * `loadTerritorialIndexByProvince`. Making it positional-and-required means the
 * compiler, not a reviewer, enumerates the sites where the question must be
 * answered.
 *
 * `suppressSmallCells` is the single source of the rule (k and the `>= k`
 * comparison both come from it); this function only routes one row through it.
 *
 * THE ZERO NUANCE, and why it is not an oversight: a denominator of EXACTLY 0 is
 * NOT protected. An empty group re-identifies nobody, so there is nothing for
 * k-anonymity to hide — and labelling it "protegido por privacidad" would be a
 * lie in the OTHER direction: it would dress a genuine data gap ("no hay
 * mascotas activas acá") as a deliberate withholding, hiding a coverage problem
 * behind a privacy badge. Such a province has no value and renders as no-data.
 * This matches the nuance already written into `suppressDelta` and
 * `isProtectedCount` (lib/open-data/province-suppression.ts) — all three grains
 * now protect the SAME interval, (0, k).
 */
export function provinceCell(
  provinceCode: string,
  label: string,
  value: number,
  denominator: number,
): ProvinceChoroplethCell {
  if (denominator <= 0) return { provinceCode, label, value, suppressed: false };
  const { suppressedCount } = suppressSmallCells([denominator], {
    count: (n) => n,
    key: () => provinceCode,
  });
  const suppressed = suppressedCount > 0;
  return { provinceCode, label, value: suppressed ? null : value, suppressed };
}

/**
 * The ONE sanctioned way to build a province cell whose suppression was ALREADY
 * decided upstream by a different (but equally k-anchored) rule, so the cell has
 * no single denominator to hand `provinceCell`.
 *
 * Two callers, both documented at their site:
 *  · TENDENCIA — a two-window delta. Its rule is the DIFFERENCING rule
 *    (`suppressDelta`, same k): a cell is protected when EITHER window carries a
 *    protected count, and no single denominator expresses that.
 *  · DESIERTO VETERINARIO — its active-pet universe is run through
 *    `suppressSmallCells` before the share is computed, so the decision (and the
 *    raw count that drove it) is already gone by the time the cell is built.
 *
 * It exists so those two cannot quietly hand-roll `{ …, suppressed: true }`: a
 * suppressed cell is STILL EMITTED (value null), never dropped. This is the
 * whole point — a cell that DISAPPEARS when it crosses k makes absence the
 * disclosure channel, and the map then stipples it as "nadie reportó acá",
 * which is both false and a tell that this province is different.
 */
export function provinceCellPreDecided(
  provinceCode: string,
  label: string,
  value: number | null,
  suppressed: boolean,
): ProvinceChoroplethCell {
  return { provinceCode, label, value: suppressed ? null : value, suppressed };
}

/**
 * Build a province choropleth FeatureCollection. Each cell becomes a feature
 * with NULL geometry — the map colors the matching ar-provinces polygon by
 * `value` (data-join on provinceCode), it does NOT plot a point. Cells with no
 * provinceCode (unmappable province name) are dropped.
 *
 * A SUPPRESSED cell is emitted, not dropped: it carries `value: null` +
 * `suppressed: true` so the render can hatch it. Dropping it would make absence
 * itself the disclosure channel — a province that vanishes from one frame to the
 * next tells you its count crossed k.
 */
export function buildProvinceChoroplethFeatures(
  cells: readonly ProvinceChoroplethCell[],
): FeatureCollection<ProvinceChoroplethProps> {
  const features = cells
    .filter((c) => c.provinceCode.length > 0)
    .map((c) => ({
      type: "Feature" as const,
      geometry: null,
      properties: {
        provinceCode: c.provinceCode,
        province: c.label,
        // Belt-and-braces: a suppressed cell publishes null even if a caller
        // hand-built the cell with a stale value alongside the flag.
        value: c.suppressed ? null : (c.value ?? null),
        // `=== true` is not redundant: a JS caller (a test mock, a cube row
        // read back as `undefined`) can hand us a missing flag, and an
        // `undefined` here would be DROPPED by JSON.stringify — the property
        // would vanish from the serialized feature entirely, so a reader could
        // not even tell the layer HAS a suppression dimension. Always a boolean.
        suppressed: c.suppressed === true,
      },
    }));
  return featureCollection(features);
}
