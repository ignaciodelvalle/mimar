// Panorama IA v2 §3.3 — "Peores N" ranking (pure domain helper).
//
// Collapses a layer's FeatureCollection into an ordered list of the worst
// administrative units — the same projection the map draws, re-expressed as a
// ranked list (and, via PanoramaDataTable, an accessible <table>). Framework-
// free: no React, no DB, no maplibre.
//
// PRIVACY INVARIANT (§5.1): a ranked row is NEVER derived from a k-anon
// suppressed cell. Suppressed cells carry value/count = null and are dropped
// before any ordering — no rate or count ever leaks from a < k=5 cell.
//
// POLARITY INVARIANT: "worst" is a claim about MEANING, not about magnitude.
// This module used to sort every non-rate layer descending, which silently
// assumed that more of anything is worse. That holds for harm counts and for
// days without veterinary activity; it inverts for the layers where a high value
// is the good news (visitas veterinarias por 1.000, índice de cumplimiento
// 0-100), and "Peores 10" over the ten BEST-served provinces is a lie a
// government console cannot ship. Polarity is therefore taken from the layer:
// explicitly (`higherIsBetter`) or, equivalently, from an attainment `target`.

import type { FeatureCollection } from "./types";

/** How a layer is ranked: rate → gap vs meta; density → raw magnitude. */
export type RankingKind = "rate" | "density";

/** One ranked administrative unit (row in RankedUnitsPanel / PanoramaDataTable). */
export type RankedUnit = {
  /** Stable identity for map↔row hover sync (province code or place label). */
  key: string;
  /** es-AR display label for the unit. */
  label: string;
  /** The metric value: the rate percentage (rate) or the event count (density). */
  value: number;
  /** target − value for rate layers (how far below meta); null for density. */
  gap: number | null;
};

type RankOptions = {
  kind: RankingKind;
  /**
   * The layer's ATTAINMENT target (PanoramaLayer.complianceTarget).
   *
   * Required for rate ranking. Also honoured for a DENSITY-kind layer that
   * declares one (`indice-territorial`): a target is always a floor to reach, so
   * its presence already answers "which end is bad" — the ranking orders by the
   * gap to it, worst gap first, exactly as it does for a rate.
   */
  target?: number;
  /** Worst-N cap (PO decision #2 = 10). */
  limit?: number;
  /**
   * POLARITY of a target-less magnitude (PanoramaLayer.higherIsBetter): `true`
   * when a HIGH value is GOOD news, so the WORST unit is the LOWEST one.
   *
   * Absent = higher is worse — the reading every count/duration/delta layer
   * needs (mortalidad, denuncias, días sin actividad) and the behaviour this
   * module had before polarity existed, so the default is a no-op.
   *
   * Ignored when a `target` is present: an attainment target is itself a
   * polarity declaration and the gap ordering already runs worst-first.
   */
  higherIsBetter?: boolean;
};

const DEFAULT_LIMIT = 10;

/**
 * ATTAINMENT ordering — rank by the gap to a target instead of by raw magnitude.
 *
 * True for every `rate` layer and for any layer that declares a target, whatever
 * its `dataType`. Reading the target (not the dataType) is what lets a
 * higher-is-better layer rank honestly at the EXISTING call sites: the console
 * already passes `target: rankingLayer.complianceTarget` for every layer it
 * ranks, so a density layer that declares one is ordered worst-first without any
 * caller change.
 */
function ranksByAttainment(opts: RankOptions): boolean {
  return opts.kind === "rate" || typeof opts.target === "number";
}

/**
 * Compare two magnitudes so the WORSE unit sorts first.
 *
 * WHY THIS MATTERS FOR THE HEADING. The panel title is not derived from any
 * polarity flag — `PanoramaDataTable` builds it from the row count and the
 * layer's measure label ("Peores {n} · {métrica}"), and the informe mirrors it.
 * So the title asserts exactly one thing: that the rows are the WORST ones. The
 * fix for a higher-is-better layer is therefore the ORDER, not the words — get
 * the order right and "Peores 10 · acceso veterinario" becomes true (the ten
 * least-served jurisdictions); leave it wrong and no rewording can save it.
 */
function worseFirst(a: number, b: number, higherIsBetter: boolean): number {
  return higherIsBetter ? a - b : b - a;
}

type UnitProps = {
  provinceCode?: unknown;
  label?: unknown;
  place?: unknown;
  name?: unknown;
  /** Province display name carried by the choropleth features (build-features). */
  province?: unknown;
  /** Locality display name carried by the locality-choropleth features. */
  locality?: unknown;
  value?: unknown;
  count?: unknown;
  suppressed?: unknown;
};

/**
 * Pick the stable key + display label from any panorama feature-props shape.
 *
 * Bug fix (2026-07-10): the province/locality CHOROPLETH features
 * (build-features.ts ProvinceChoroplethProps / ChoroplethProps) carry their
 * display name in `province`/`locality`, NOT `label`/`place`/`name` — so this
 * used to return null for EVERY cobertura (rate) cell, leaving rankWorstUnits
 * empty and the panel falsely reporting "Sin jurisdicciones bajo meta" even when
 * every jurisdiction was under meta. `locality` is preferred over `province` so
 * a locality-level cell labels as its locality, not its (repeated) province.
 */
function identify(p: UnitProps): { key: string; label: string } | null {
  const label =
    (typeof p.label === "string" && p.label) ||
    (typeof p.place === "string" && p.place) ||
    (typeof p.name === "string" && p.name) ||
    (typeof p.locality === "string" && p.locality) ||
    (typeof p.province === "string" && p.province) ||
    null;
  const key =
    (typeof p.provinceCode === "string" && p.provinceCode) ||
    (typeof p.place === "string" && p.place) ||
    (typeof p.name === "string" && p.name) ||
    (typeof p.locality === "string" && p.locality) ||
    (typeof p.province === "string" && p.province) ||
    label;
  if (!label || !key) return null;
  return { key, label };
}

/**
 * Rank the worst administrative units for a layer.
 *
 *  - ATTAINMENT (rate, or any layer with a `target`): units strictly BELOW the
 *    target, ordered by the largest gap first. An empty result means "no
 *    jurisdiction below meta in this scope".
 *  - MAGNITUDE (target-less density): units ordered worst first — highest count
 *    first by default, LOWEST first when the layer declares `higherIsBetter`
 *    (visitas veterinarias, índice de cumplimiento). gap = null either way.
 *
 * Suppressed / non-numeric cells are excluded (privacy invariant). Returns at
 * most `limit` rows (default 10).
 */
export function rankWorstUnits(features: FeatureCollection, opts: RankOptions): RankedUnit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const byAttainment = ranksByAttainment(opts);
  const higherIsBetter = opts.higherIsBetter ?? false;
  const rows: RankedUnit[] = [];

  for (const f of features.features) {
    const p = f.properties as UnitProps;
    // Never derive a value from a suppressed cell.
    if (p.suppressed === true) continue;

    const id = identify(p);
    if (id === null) continue;

    if (byAttainment) {
      if (typeof p.value !== "number") continue;
      const target = opts.target ?? 0;
      const gap = target - p.value;
      if (gap <= 0) continue; // at/above meta — not a "worst" unit
      rows.push({ key: id.key, label: id.label, value: p.value, gap });
    } else {
      // Aggregated cells carry their magnitude in `count`, but some density
      // layers (mortalidad) carry it in `value` — the same both-fields
      // precedence the dock's own total uses. Reading only `count` skipped
      // EVERY unit of those layers, so the ranking came back empty while the
      // dock showed 154 records for the same view (found live 2026-07-25).
      const magnitude = typeof p.count === "number" ? p.count : p.value;
      if (typeof magnitude !== "number") continue;
      rows.push({ key: id.key, label: id.label, value: magnitude, gap: null });
    }
  }

  rows.sort((a, b) =>
    byAttainment ? (b.gap ?? 0) - (a.gap ?? 0) : worseFirst(a.value, b.value, higherIsBetter),
  );
  return rows.slice(0, limit);
}

/**
 * Rank EVERY administrative unit in scope by the metric — the small-scope
 * fallback (Cowork QA ronda 3 §4, P2.5). A jurisdiction operator with fewer
 * than a full Worst-N of units (e.g. CABA · 5 comunas) never has "10 worst
 * jurisdictions" to show; `rankWorstUnits` (rate) drops every at/above-meta
 * unit, so it can come back empty and the panel wrongly reads "sin datos
 * suficientes" while Registros lists the same units with values. This orders
 * ALL non-suppressed units so the operator sees "tus N unidades, ordenadas por
 * {métrica}":
 *
 *  - ATTAINMENT (rate, or any layer with a `target`): every unit with a numeric
 *    value, WORST attainment first (value ascending). `gap` = target − value
 *    only when strictly below meta (so the panel's "−N pts" chip still shows for
 *    below-meta units and is omitted for at/above-meta ones — no misleading
 *    "−(negative)").
 *  - MAGNITUDE (target-less density): identical to `rankWorstUnits` — all units
 *    worst first, which is highest-count first unless the layer declares
 *    `higherIsBetter`, in which case it is lowest first.
 *
 * Suppressed / non-numeric cells are excluded (privacy invariant), exactly as
 * `rankWorstUnits`. Returns at most `limit` rows (default 10).
 */
export function rankUnitsInScope(features: FeatureCollection, opts: RankOptions): RankedUnit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const byAttainment = ranksByAttainment(opts);
  const higherIsBetter = opts.higherIsBetter ?? false;
  const rows: RankedUnit[] = [];

  for (const f of features.features) {
    const p = f.properties as UnitProps;
    if (p.suppressed === true) continue;

    const id = identify(p);
    if (id === null) continue;

    if (byAttainment) {
      if (typeof p.value !== "number") continue;
      const target = opts.target ?? 0;
      const gap = target - p.value;
      // Keep the unit regardless of meta; only carry a gap when below meta.
      rows.push({ key: id.key, label: id.label, value: p.value, gap: gap > 0 ? gap : null });
    } else {
      // Same both-fields precedence as rankWorstUnits — see the note there.
      const magnitude = typeof p.count === "number" ? p.count : p.value;
      if (typeof magnitude !== "number") continue;
      rows.push({ key: id.key, label: id.label, value: magnitude, gap: null });
    }
  }

  // attainment → worst attainment first (lowest value); magnitude → worst first
  // under the layer's own polarity (highest count, or lowest when high is good).
  rows.sort((a, b) =>
    byAttainment ? a.value - b.value : worseFirst(a.value, b.value, higherIsBetter),
  );
  return rows.slice(0, limit);
}
