/**
 * How a KPI target renders as copy — extracted from kpi-catalog.ts on
 * 2026-08-01 under the same file-size pressure as kpi-guards.ts. It belongs
 * with the guards rather than with the descriptors: both answer "how does
 * this descriptor render HONESTLY", not "what does it measure".
 */
import type { KpiTarget, KpiUnit } from "./kpi-catalog";

/**
 * Render a target+source pair honestly, per `sourceKind` — the SINGLE place
 * that combines `target.value` and `target.source` into copy, so every
 * consumer (OpKpi's ⓘ popover, briefing-alerts' title) renders identically
 * and a future KPI can't reintroduce the "meta X% (Ley Y)" conflation.
 *
 * PURE — no DB, no React.
 */
export function formatKpiTarget(target: KpiTarget, unit: KpiUnit): string {
  const valueStr = `${target.value}${unit === "percent" ? "%" : ""}`;
  if (target.sourceKind === "programmatic-target") {
    return `Obligación: ${target.source} · Meta programática: ${valueStr}`;
  }
  // statutory-obligation and benchmark: the number and the source are either
  // the same fact (statutory) or carry no legal weight to conflate with
  // (benchmark) — one plain "Meta: X — fuente" form stays honest for both.
  //
  // SEPARATOR, NOT PARENTHESES (2026-08-17). This used to wrap the source in
  // parentheses, and several sources carry their own: the briefing's top alert
  // rendered "Meta: 80% (meta programática de identificación (sin mandato legal
  // argentino))" on the first screen a funcionario sees. The nesting was not a
  // one-off — it hit every source with a parenthetical, and those parentheticals
  // are load-bearing (the identification one exists because a legal review found
  // the earlier copy asserted a chip mandate no Argentine statute contains).
  // A dash separates without competing, and matches the `·` the
  // programmatic-target branch above already uses.
  return `Meta: ${valueStr} — ${target.source}`;
}
