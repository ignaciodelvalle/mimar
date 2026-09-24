// lib/metrics/briefing-alerts.ts — THE BRIEFING alert engine (C6b, dim-interno:docs/reviews/
// results/2026-07-22-plan-maestro-integridad.md §C6 "Capa 1: BRIEFING").
//
// WHY THIS EXISTS
// ----------------
// C6's "toda pantalla declara su decisión dueña" makes /gob home a BRIEFING:
// "¿qué 3 cosas priorizo hoy?" (lib/ui/screen-manifest.ts's GOB_PANEL entry).
// A briefing needs a ranked, bounded list of "what's off-target right now" —
// not a wall of KPI tiles the operator has to interpret themselves. This
// module is the PURE composition step: given the metric values the /gob home
// page ALREADY fetches (zero new query fan-out — hard constraint) plus their
// lib/metrics/kpi-catalog.ts descriptors (targets, guards, confidence —
// C1's contract), produce a ranked, capped-at-5 list of alerts.
//
// GUARDS (non-negotiable — this is the fence that keeps the briefing honest):
//   - No `target`, or `semaphore.paintAgainst !== "target"` → never alerts.
//     No target means no gap; a semaphore explicitly excluded from painting a
//     legal-verdict tone (e.g. ppp_registry_compliance) must not be reframed
//     as an urgent gap either — same C1 principle, applied one layer up.
//   - `zeroDenominatorGate` fires (n===0 and the descriptor declares
//     guards.zeroDenominator) → never alerts. An alert built from a 0/0 ratio
//     is exactly the fabricated-signal class C1 killed at the tile level;
//     this engine must not resurrect it at the briefing level.
//   - `smallNGate` fires (0 < n < guards.smallN.min) → never alerts. A
//     confident-sounding gap over a handful of cases is not a priority — it's
//     noise dressed as urgency.
//   - value already meets or beats the target (tone === "ok") → never alerts.
//     A briefing only surfaces gaps; a met target is evidence, not an alert
//     (it still shows in the "Brechas vs meta" KPI strip under the alerts).
//
// SCOPE NOTE — higher-is-better only: every candidate this module currently
// resolves an action for (see ALERT_ACTIONS) is a "more is better" ratio
// (coverage/penetration/traceability/reunification/completion/compliance).
// `custody_return_rate` (lower-is-better) is deliberately NOT registered —
// this engine's tone/gap math assumes higherIsBetter, and no /gob-home
// candidate reads a lower-is-better ratio today. Wiring a lower-is-better KPI
// through this engine needs an explicit direction parameter, not a silent
// sign flip; left as a documented gap rather than guessed at.
//
// PURE — no DB, no React. Every export is unit-tested in briefing-alerts.test.ts.

import { getScreenManifestEntry } from "@/lib/ui/screen-manifest";
import { formatCount, formatPercent, pluralizeEs } from "@/lib/utils/format";
import { type ForecastTrendPoint, forecastToTarget, resourceGap } from "./forecast-to-target";
import type { KpiDefinition, KpiId, KpiUnit } from "./kpi-catalog";
import { KPI_CATALOG, formatKpiTarget } from "./kpi-catalog";
import { type MandateProvinces, formatMetricLegalBasis } from "./metric-legal-basis";
import { smallNGate, zeroDenominatorGate } from "./presentation-guards";
import { toneForTarget } from "./targets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BriefingAlertSeverity = "alta" | "media";
export type BriefingAlertConfidence = "alta" | "media" | "baja";

/**
 * One metric value the /gob home page already fetched, offered as a
 * candidate for the briefing. The engine decides whether it actually
 * produces an alert (guards above) — passing a candidate never guarantees
 * an alert is emitted.
 */
export type BriefingAlertCandidate = {
  /** Catalog id — the descriptor supplies target/semaphore/guards/confidence. */
  kpiId: KpiId;
  /** Current observed value, same unit as the descriptor (percent: 0–100). */
  value: number;
  /**
   * Sample size / denominator the guard engine checks against — e.g.
   * `registryDenominator` for rabies coverage, `mortality.total` for
   * disposal traceability. This is NOT the rate itself.
   */
  n: number;
  /**
   * Whether a descriptor-declared secondary confidence input (e.g. a census
   * row) is actually present for this render. Omit when the descriptor's
   * confidence prose has no such conditional input — confidence then derives
   * from `n`/guards/caveat alone.
   */
  auxPresent?: boolean;
  /**
   * FORECAST-A-META: the metric's OWN trend series, if this candidate's KPI
   * carries a `forecast` descriptor (lib/metrics/kpi-catalog.ts's
   * KpiForecast) AND the caller's page already fetched it (zero new query
   * fan-out — the same rule the module header's guards enforce for
   * target/gap math). Omit when no such trend is at hand; the alert still
   * fires on target/gap alone, simply without a forecast line (see the
   * "insufficient" guard note below).
   */
  trend?: ForecastTrendPoint[];
};

/** The numbers behind an alert — rendered as the tile's evidence line. */
export type BriefingAlertEvidence = {
  value: number;
  target: number;
  unit: KpiUnit;
  /** Sample size the ratio was computed over. */
  n: number;
  /** Legal/programmatic source of the target (Ley/programa/benchmark). */
  source: string;
  /**
   * FORECAST-A-META: the forecast-to-target line (lib/metrics/
   * forecast-to-target.ts's `.line`), appended to the alert's evidence when
   * the descriptor carries `forecast` AND the candidate supplied a `trend`
   * with enough points. Undefined — never a fabricated line — whenever the
   * descriptor has no `forecast`, no trend was passed, or the engine itself
   * guards out (insufficient/met, though "met" cannot reach here — a met
   * target never becomes an alert in the first place, see below).
   */
  forecastLine?: string;
  /**
   * PO-interview decision 2, item 2: the resource-gap line (lib/metrics/
   * forecast-to-target.ts's resourceGap().line) — "faltan ~N dosis sobre el
   * padrón registrado". Undefined whenever the descriptor has no
   * `resourceUnit` (kpi-catalog.ts), or the engine itself has nothing honest
   * to say (met/no-denominator/negligible) — never a fabricated line.
   */
  resourceLine?: string;
};

/**
 * NUMBER-FIRST ANATOMY (UI review A4, PO-approved 2026-08-06).
 *
 * `title` is ONE long single-weight sentence with the number buried mid-clause
 * ("Disposición trazable de fallecimientos 18,8% — Obligación: CABA: Ley 5470 ·
 * Meta programática: 75%"), so the most important block of the briefing was
 * also its greyest. The card now renders the same facts as three lines — name,
 * hero number, metadata — matching the "Brechas vs meta" tiles right below it
 * (serif value under a small label), instead of inventing a second idiom.
 *
 * Split HERE, at the composition site, rather than regex-parsing `title` in the
 * view: the three parts are already separate values in this module, and a view
 * that re-derives them from prose would drift the first time a clause changes.
 * `title` is kept verbatim and unchanged — it is still the alert's accessible
 * sentence (the card announces it as one phrase) and every existing consumer
 * reads it untouched. This is additive, never a replacement.
 */
export type BriefingAlertDisplay = {
  /** Line 1 — the short alert name (the KPI's catalog label). */
  name: string;
  /**
   * Line 2 — the hero number, already formatted through the same helpers the
   * title uses (so the two can never disagree). Undefined when the alert has
   * no single headline number; the card then renders name + metadata only,
   * never an empty hero slot.
   */
  value?: string;
  /**
   * Line 3 — EVERYTHING else the title said (obligation, target, the pairing's
   * second term, the non-verdict caveat). This is a reordering, not a cut: no
   * fact that reached the title may be missing here.
   */
  metadata: string;
};

export type BriefingAlert = {
  id: KpiId;
  /** es-AR, states the GAP: "Trazabilidad de disposición 33% — meta 75% (Ley 5470)". */
  title: string;
  /** The same sentence, split into the card's three lines — see above. */
  display: BriefingAlertDisplay;
  evidence: BriefingAlertEvidence;
  severity: BriefingAlertSeverity;
  confidence: BriefingAlertConfidence;
  actionHref: string;
  actionLabel: string;
};

export const MAX_BRIEFING_ALERTS = 5;

// ---------------------------------------------------------------------------
// Coverage — WHY the briefing is empty (A1, 2026-07-31)
// ---------------------------------------------------------------------------
//
// THE BUG THIS KILLS: /gob rendered "Sin alertas activas — las métricas con
// meta están dentro de rango." from `alerts.length === 0` alone. Every guard
// above drops its candidate SILENTLY, so a scope where NOTHING was measured
// (0 dogs in the padrón, 0 deaths recorded, 0 pets active) produced the exact
// same empty list as a scope where every target was genuinely met — and the
// screen read the empty list as a green verdict. That is the fabricated-signal
// class C1 killed at the tile level, resurrected as an EMPTY-STATE claim: a
// municipality with no data loaded was told its metrics were in range.
//
// The engine already knows which of the three things happened to each
// candidate; it just threw that away. `BriefingCoverage` is the same single
// pass, keeping the reason instead of discarding it. No new math, no second
// opinion — the buckets are literally the guard branches.
export type BriefingCoverage = {
  /** Measured, evaluated against its target, and at/above it — a real green. */
  met: KpiId[];
  /** zeroDenominatorGate fired: n === 0. Nothing was measured in this scope
   *  or period — NOT a 0% and NOT "within range". */
  unmeasured: KpiId[];
  /** smallNGate fired: real data exists, but the sample sits under the
   *  descriptor's `guards.smallN.min` floor, so no verdict is defensible. */
  suppressed: KpiId[];
  /** The engine cannot produce a verdict at all: no target, a semaphore that
   *  refuses to paint one, or no owning screen registered. Deliberately kept
   *  OUT of the "métricas con meta" count — these were never part of the
   *  claim, so counting them either way would misstate it. */
  notEvaluated: KpiId[];
};

/** The alerts AND the reason the ones that are missing are missing. */
export type BriefingBoard = {
  alerts: BriefingAlert[];
  coverage: BriefingCoverage;
};

// ---------------------------------------------------------------------------
// Owning-screen resolution — lib/ui/screen-manifest.ts is the single source.
// ---------------------------------------------------------------------------
//
// Registered for every catalog KPI that CAN produce a gap alert (has a
// `target` + `semaphore.paintAgainst: "target"`, higher-is-better) — not only
// the ones /gob/page.tsx passes as candidates today. This is deliberately
// forward-compatible: a future candidate for reunification_rate or
// campaign_completion_rate (once their fetchers join the home page's bounded
// Promise.all) resolves its action for free, without touching this map.
//
// `route` is validated against SCREEN_MANIFEST at resolve time (not just
// trusted as a string) — a route that gets renamed/removed there silently
// drops the alert instead of linking to a manifest-orphaned URL.
//
// `query` (optional): appended verbatim to the validated `entry.route` to
// land on a specific tab of a fused hub (F2, 2026-07-22) — the manifest only
// tracks the bare hub route, not per-tab deep links, so the tab selector
// lives here instead.
const ALERT_ACTIONS: Partial<Record<KpiId, { route: string; label: string; query?: string }>> = {
  // Programa layer — "¿el programa cumple sus metas de cobertura?" IS the
  // owning decision for a coverage-gap alert (deliberately NOT /gob/analytics:
  // that screen's decision is about background TRENDS, "profundidad" layer —
  // a different question than "is this metric off its target today").
  rabies_coverage_dogs_12m: { route: "/gob/programa", label: "Ver en Programa" },
  microchip_penetration: { route: "/gob/programa", label: "Ver en Programa" },
  // Mortalidad owns its own decision 1:1 — exact match.
  mortality_disposal_traceability: {
    route: "/gob/mortalidad",
    label: "Ver en Mortalidad y disposición",
  },
  // Situación layer — perdidas' decision is literally about reunification follow-up.
  reunification_rate: { route: "/gob/perdidas", label: "Ver en Pérdidas" },
  // G8 (obligations-worklist, 2026-08): the deadline-breach alert counts
  // observations already PAST the 10-day legal window — an act-now signal,
  // not a trend to study. It now lands on the deadline worklist
  // (/gob/acciones), where those exact observations rank first and each row
  // carries its "Cerrar →" resolution, instead of the Vigilancia dashboard
  // (which keeps owning the analytical escalation-gap alert below).
  rabies_observation_compliance_10d: {
    route: "/gob/acciones",
    label: "Ver en Acciones que vencen",
  },
  // Campañas owns its own completion-rate decision 1:1. F2 fusion (2026-07-22):
  // /gob/campanas is now the Operativos hub's "campanas" tab (the hub's
  // default is "alcance", so the query suffix is required to land on the
  // right tab, not just the hub route).
  campaign_completion_rate: {
    route: "/gob/operativos",
    label: "Ver en Campañas",
    query: "?vista=campanas",
  },
  // ENO SLA is a bandeja-de-salida delivery concern.
  eno_sla_compliance: { route: "/gob/outbox", label: "Ver en Bandeja de salida" },
  // Vigilancia also owns the escalation-gap transparency pairing (claim #4,
  // cursor red-team 2026-07-23) — same screen as rabies_observation_compliance_10d.
  bite_escalation_gap: { route: "/gob/vigilancia", label: "Ver en Vigilancia" },
};

/** Resolve a candidate's action, validating the route still exists in the
 *  manifest. Returns undefined when unmapped or manifest-orphaned — the
 *  candidate is dropped rather than linking to an unverified destination. */
function resolveAlertAction(kpiId: KpiId): { href: string; label: string } | undefined {
  const action = ALERT_ACTIONS[kpiId];
  if (!action) return undefined;
  const entry = getScreenManifestEntry(action.route);
  if (!entry) return undefined;
  return { href: `${entry.route}${action.query ?? ""}`, label: action.label };
}

// ---------------------------------------------------------------------------
// Confidence derivation
// ---------------------------------------------------------------------------

/**
 * Derive the alert's confidence label from what's ACTUALLY at hand for this
 * render — never from the descriptor's prose alone (that's fixed at
 * catalog-write time; a live render can be thinner than the catalog's best
 * case, e.g. no census row this month).
 *
 *  - "baja": n sits under 2× the descriptor's smallN floor — the guard
 *    didn't fire (n is above the floor), but the sample is still thin enough
 *    that a confident-sounding gap deserves an explicit caveat.
 *  - "media": a declared secondary input is explicitly absent
 *    (`auxPresent === false`, e.g. no census row), OR the descriptor's own
 *    caveat flags seed-thin/low-density data, OR the descriptor hasn't been
 *    reached by the C1 confidence-prose sweep yet (no `confidence` field —
 *    don't claim "alta" on undocumented trust).
 *  - "alta": none of the above — a real target, a comfortable sample, and a
 *    documented confidence basis.
 */
export function deriveAlertConfidence(
  descriptor: Pick<KpiDefinition, "guards" | "confidence" | "caveat">,
  input: { n: number; auxPresent?: boolean },
): BriefingAlertConfidence {
  const smallNMin = descriptor.guards?.smallN?.min;
  if (smallNMin !== undefined && input.n < smallNMin * 2) return "baja";
  if (input.auxPresent === false) return "media";
  if (descriptor.caveat?.toLowerCase().includes("seed-density")) return "media";
  if (!descriptor.confidence) return "media";
  return "alta";
}

// ---------------------------------------------------------------------------
// Title / value formatting
// ---------------------------------------------------------------------------

// Bug fix (qa-triage-2026-07-23, finding #6 — rounding drift): this used to
// render `${Math.round(value)}%` (a bare 0-decimal integer), while every KPI
// tile the alert links to (OpKpi via formatPercent) renders 1 decimal — e.g.
// the SAME underlying value read "34%" in an alert and "33,7%" on its own
// tile. Routing through the shared `formatPercent` (lib/utils/format.ts, the
// ONE rounding rule for every rate in the app) makes the alert's number
// byte-identical to the tile it points at — never a second, independently
// -rounded opinion of the same metric.
function formatValue(value: number, unit: KpiUnit): string {
  if (unit === "percent") return formatPercent(value);
  return `${Math.round(value)}`;
}

/** The alert's copy: the one long sentence AND the number-first split of the
 *  exact same clauses (see BriefingAlertDisplay). Both come out of a single
 *  formatting pass, so the sentence and the card can never disagree. */
function buildAlertCopy(
  descriptor: KpiDefinition,
  value: number,
  sourceOverride?: string,
): { title: string; display: BriefingAlertDisplay } {
  // C1 fix (claim #6, cursor red-team 2026-07-23): route the target+source
  // clause through formatKpiTarget so a law-sourced but non-statutory target
  // (e.g. rabies coverage's 80%) never reads as "the law set this number" —
  // see KpiTargetSourceKind. `descriptor.target` is guaranteed by the caller
  // (buildBriefingAlerts only reaches here after its `!descriptor.target`
  // guard already dropped the candidate).
  //
  // `sourceOverride` (red-team CRITICAL follow-up 2026-07-24): when the caller
  // resolves a mandate-scoped legal citation, the target's `source` clause is
  // swapped for it so the title never cites a province's law to an operator
  // whose mandate excludes that province — matching the tile fix.
  const target =
    descriptor.target && sourceOverride
      ? { ...descriptor.target, source: sourceOverride }
      : descriptor.target;
  const targetClause = target ? formatKpiTarget(target, descriptor.unit) : "";
  const formattedValue = formatValue(value, descriptor.unit);
  return {
    title: `${descriptor.label} ${formattedValue} — ${targetClause}`,
    display: { name: descriptor.label, value: formattedValue, metadata: targetClause },
  };
}

// ---------------------------------------------------------------------------
// Surveillance urgency alerts — claim #4 (cursor red-team 2026-07-23): the
// Panel/briefing showed a genuinely measured-zero "0 observaciones rábicas
// abiertas" while Vigilancia's OWN screen carried 14 bite reports (12m), 0 of
// them escalated, and 3 observations already past the 10-day legal deadline —
// real surveillance urgency the briefing never surfaced. bite_escalation_gap
// and rabies_observation_compliance_10d's `openBreaches` are NOT target-gap
// shaped (see their kpi-catalog.ts caveats: a deliberate transparency PAIR,
// never a ratio/verdict) — buildBriefingAlerts' target-gap machinery above
// does not apply to them. This is a SEPARATE, honest composition path with
// its OWN guards: an alert fires only on a REAL gap (never a genuine 0/0),
// copy never implies a legal verdict the underlying KPI's own semaphore
// forbids, and severity for the deadline-breach alert derives from the
// breach itself (a live legal-deadline miss), not a painted color.
// ---------------------------------------------------------------------------

export type SurveillanceUrgencyCandidate =
  | {
      kind: "escalation_gap";
      /** Reuses bites_per_10k's `reports` field — trailing 12 months. */
      bites12m: number;
      /** Reuses open_rabies_observations' `count` field — 'now' snapshot. */
      openObservations: number;
    }
  | {
      kind: "deadline_breach";
      /** rabies_observation_compliance_10d's A9 `openBreaches` — a live
       *  snapshot of observations already open past the legal window. */
      openBreaches: number;
    };

/** Builds one alert from a surveillance-urgency candidate, or undefined when
 *  the candidate doesn't actually show a gap (never fabricated on a genuine
 *  0/0 — e.g. 0 bites, or 0 open breaches, produces no alert). */
function buildUrgencyAlert(
  candidate: SurveillanceUrgencyCandidate,
): (BriefingAlert & { gap: number }) | undefined {
  if (candidate.kind === "escalation_gap") {
    // The gap this KPI exists to surface: bites WERE reported, but zero
    // observations are open right now — reports that never escalated. When
    // observations ARE open, or no bites were reported at all, there is no
    // gap to alert on (a genuine 0/0 or a healthy escalation rate).
    if (candidate.bites12m === 0 || candidate.openObservations > 0) return undefined;
    const descriptor = KPI_CATALOG.bite_escalation_gap;
    const action = resolveAlertAction("bite_escalation_gap");
    if (!action) return undefined;
    // The hero is the reported-bites count; the pairing's second term and the
    // no-verdict caveat move to the metadata line intact (A4 is a reordering).
    const bites = formatCount(candidate.bites12m);
    const observations = formatCount(candidate.openObservations);
    return {
      id: "bite_escalation_gap",
      title: `${descriptor.label}: ${bites} mordeduras (12m) vs ${observations} observaciones abiertas — la ausencia de escalamiento no implica ausencia de riesgo`,
      display: {
        name: descriptor.label,
        value: bites,
        metadata: `mordeduras (12m) · ${observations} ${pluralizeEs(candidate.openObservations, "observación", "observaciones")} ${pluralizeEs(candidate.openObservations, "abierta", "abiertas")} · la ausencia de escalamiento no implica ausencia de riesgo`,
      },
      evidence: {
        value: candidate.bites12m,
        target: 0,
        unit: "count",
        n: candidate.bites12m,
        source: "Vigilancia — brecha de escalamiento, no un mandato legal",
      },
      // Never a legal-verdict severity (the KPI's own semaphore: "none"
      // forbids painting a color from this pairing) — "media" reads as an
      // attention signal, not a breach.
      severity: "media",
      confidence: "media",
      actionHref: action.href,
      actionLabel: action.label,
      gap: candidate.bites12m,
    };
  }

  // deadline_breach
  if (candidate.openBreaches === 0) return undefined;
  const descriptor = KPI_CATALOG.rabies_observation_compliance_10d;
  const action = resolveAlertAction("rabies_observation_compliance_10d");
  if (!action) return undefined;
  const source = descriptor.target?.source ?? "";
  const breaches = formatCount(candidate.openBreaches);
  const subject =
    candidate.openBreaches === 1 ? "observación rábica supera" : "observaciones rábicas superan";
  return {
    id: "rabies_observation_compliance_10d",
    title: `${breaches} ${subject} el plazo legal de 10 días (${source})`,
    // The count IS the alert here, so it leads; the legal clause and its
    // citation become the metadata line, word for word.
    display: {
      name: descriptor.label,
      value: breaches,
      metadata: `${subject} el plazo legal de 10 días · ${source}`,
    },
    evidence: {
      value: candidate.openBreaches,
      target: 0,
      unit: "count",
      n: candidate.openBreaches,
      source,
    },
    // A live legal-deadline miss — the one urgency-signal case that DOES
    // warrant "alta": this is an active breach, not a painted tone guess.
    severity: "alta",
    confidence: "alta",
    actionHref: action.href,
    actionLabel: action.label,
    gap: candidate.openBreaches,
  };
}

// ---------------------------------------------------------------------------
// buildBriefingAlerts — the main export
// ---------------------------------------------------------------------------

/**
 * Scope-resolved legal citation for an alert's title/evidence (red-team-admin
 * follow-up). formatMetricLegalBasis returns null for a KPI with no registered
 * provincial basis (e.g. rabies coverage, whose Ley 22.953 IS national), so
 * those keep their static catalog source untouched. Module-level so the branch
 * stays off buildBriefingAlerts' cognitive-complexity budget.
 *
 * The national caller ("all") used to short-circuit to `undefined` here and
 * keep `descriptor.target.source` verbatim, which is how /gob told national
 * officials that a country-wide figure's obligation was a single province's
 * statute (demo review 2026-08-01). It now goes through the same resolver as
 * everyone else, which qualifies a provincial-only citation with
 * NATIONAL_VIEW_PROVINCIAL_ONLY_ES instead of presenting it as binding.
 *
 * MIND THE FALLBACK when removing a registry entry: `?? undefined` means a
 * KPI with no registered basis keeps `descriptor.target.source` VERBATIM.
 * That is right for rabies (its Ley 22.953 is national), and it is why
 * dropping microchip_penetration from METRIC_LEGAL_BASIS on 2026-08-17 was
 * not enough on its own — the alert would have fallen straight back to the
 * catalog's old "Ley Prov. 14.107 (PBA)" and re-asserted the refuted claim.
 * The catalog descriptor was corrected in the same commit. A registry
 * deletion here degrades to the CATALOG's claim, never to silence.
 */
function resolveScopedSource(kpiId: KpiId, mandateProvinces: MandateProvinces): string | undefined {
  return formatMetricLegalBasis(kpiId, mandateProvinces) ?? undefined;
}

/** Which of the guard branches a single candidate landed in. `alert` carries
 *  the built alert; every other outcome is just the reason, so the caller can
 *  say WHICH emptiness it is instead of inventing a verdict. */
type CandidateOutcome =
  | { kind: "alert"; alert: BriefingAlert & { gap: number } }
  | { kind: "met" | "unmeasured" | "suppressed" | "notEvaluated" };

/** The per-candidate guard chain, extracted verbatim from the loop that used
 *  to `continue` at each step — same order, same predicates, same math. */
function classifyCandidate(
  candidate: BriefingAlertCandidate,
  mandateProvinces: MandateProvinces,
): CandidateOutcome {
  const descriptor = KPI_CATALOG[candidate.kpiId];

  // No target, or a semaphore that refuses to paint a legal-verdict tone
  // (paintAgainst: "none") → no gap can honestly be computed. This also
  // covers descriptors that omit `semaphore` entirely (the C1 barrido
  // hasn't reached them yet) — absence of an explicit "target" opt-in is
  // treated the same as an explicit "none".
  if (!descriptor.target || descriptor.semaphore?.paintAgainst !== "target") {
    return { kind: "notEvaluated" };
  }

  // Unmeasurable-data guards — an alert from a 0/0 ratio or a handful of
  // cases is exactly the dishonesty C1 killed at the tile level.
  if (zeroDenominatorGate(descriptor, candidate.n)) return { kind: "unmeasured" };
  if (smallNGate(descriptor, candidate.n)) return { kind: "suppressed" };

  const tone = toneForTarget(candidate.value, descriptor.target.value);
  // Target met (or beaten) — evidence, not an alert.
  if (tone === "ok") return { kind: "met" };

  const action = resolveAlertAction(candidate.kpiId);
  // No owning screen registered (or the manifest no longer carries the
  // registered route) — drop rather than link to an unverified destination.
  if (!action) return { kind: "notEvaluated" };

  const gap = descriptor.target.value - candidate.value;
  const confidence = deriveAlertConfidence(descriptor, {
    n: candidate.n,
    auxPresent: candidate.auxPresent,
  });
  // Severity is capped by confidence (demo review 2026-08-01). It used to come
  // from `tone` ALONE, so /gob rendered "Prioridad alta: Disposición trazable
  // 33,3% · Confianza: baja · n = 9" — one line claiming maximum urgency and
  // then disavowing the evidence it rests on. A funcionario reads that as the
  // panel arguing with itself, and they are right to: the smallN guard did not
  // fire (9 clears the floor of 5), but at 2× the floor the descriptor's own
  // rule already says this sample cannot support a confident verdict, and
  // "alta" IS a confident verdict. A thin sample can still be worth surfacing —
  // that is why it stays an alert at all — it just cannot outrank a measured
  // one in the ranked list below. Never the reverse: high confidence never
  // PROMOTES a warn-tier gap to "alta".
  const severity: BriefingAlertSeverity =
    tone === "danger" && confidence !== "baja" ? "alta" : "media";

  // FORECAST-A-META: only when the descriptor declares a qualifying trend
  // source AND this candidate actually supplied one — guards flow through
  // the engine itself (an insufficient/flat/receding trend simply yields no
  // `.line`, never a fabricated one). SCOPE NOTE above: this engine's
  // gap/tone math is higher-is-better-only, so forecastToTarget is called
  // with its default (higherIsBetter: true) — consistent with every KPI
  // this module resolves an action for today.
  const forecastLine =
    descriptor.forecast && candidate.trend && candidate.trend.length > 0
      ? (forecastToTarget({
          current: candidate.value,
          target: descriptor.target.value,
          trend: candidate.trend,
        }).line ?? undefined)
      : undefined;

  // PO decision 2 item 2: "faltan ~N dosis" — only when the descriptor
  // names a resourceUnit (kpi-catalog.ts), reusing candidate.n as the
  // denominator — the SAME sample size the guards above already checked,
  // never a second/different population figure.
  const resourceLine = descriptor.resourceUnit
    ? (resourceGap(
        { current: candidate.value, target: descriptor.target.value, denominator: candidate.n },
        descriptor.resourceUnit,
      ).line ?? undefined)
    : undefined;

  const scopedSource = resolveScopedSource(candidate.kpiId, mandateProvinces);
  const copy = buildAlertCopy(descriptor, candidate.value, scopedSource);

  return {
    kind: "alert",
    alert: {
      id: candidate.kpiId,
      title: copy.title,
      display: copy.display,
      evidence: {
        value: candidate.value,
        target: descriptor.target.value,
        unit: descriptor.unit,
        n: candidate.n,
        source: scopedSource ?? descriptor.target.source,
        forecastLine,
        resourceLine,
      },
      severity,
      confidence,
      actionHref: action.href,
      actionLabel: action.label,
      gap,
    },
  };
}

/**
 * `buildBriefingAlerts` plus the coverage report — the ONE pass that both
 * ranks the alerts and records why each non-alerting candidate did not alert.
 * Call this (not `buildBriefingAlerts`) whenever the caller renders something
 * for the empty case: an empty `alerts` array alone cannot tell "everything is
 * on target" apart from "nothing was measured".
 */
export function buildBriefingBoard(
  candidates: readonly BriefingAlertCandidate[],
  urgencySignals: readonly SurveillanceUrgencyCandidate[] = [],
  mandateProvinces: MandateProvinces = "all",
): BriefingBoard {
  const alerts: Array<BriefingAlert & { gap: number }> = [];
  const coverage: BriefingCoverage = {
    met: [],
    unmeasured: [],
    suppressed: [],
    notEvaluated: [],
  };

  for (const candidate of candidates) {
    const outcome = classifyCandidate(candidate, mandateProvinces);
    if (outcome.kind === "alert") alerts.push(outcome.alert);
    else coverage[outcome.kind].push(candidate.kpiId);
  }

  for (const signal of urgencySignals) {
    const built = buildUrgencyAlert(signal);
    if (built) alerts.push(built);
  }

  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "alta" ? -1 : 1;
    return b.gap - a.gap;
  });

  return {
    alerts: alerts.slice(0, MAX_BRIEFING_ALERTS).map(({ gap, ...alert }) => alert),
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Empty-state copy (es-AR) — one place, so no screen re-invents the verdict.
// ---------------------------------------------------------------------------

/** The es-AR reading of an empty briefing: a headline that never claims more
 *  than the data supports, plus one clarifying line per non-evaluable bucket. */
export type BriefingEmptyState = {
  headline: string;
  details: string[];
};

function kpiLabels(ids: readonly KpiId[]): string {
  return ids.map((id) => KPI_CATALOG[id].label).join(", ");
}

/**
 * Describe an EMPTY briefing honestly. The three states a municipality must be
 * able to tell apart — and which read identically before this existed:
 *
 *   - `met`        → "está dentro de rango"  (a measured, met target)
 *   - `unmeasured` → "no hay medición para este período" (0/0, nothing loaded)
 *   - `suppressed` → "hay dato, pero la muestra es demasiado chica" (smallN)
 *
 * The headline only says "dentro de rango" about the metrics that were ACTUALLY
 * measured and met — never about the whole set, and never at all when nothing
 * was measured. No alarm, no apology: it states what happened.
 *
 * NOTE on `suppressed`: this is the descriptor's own `guards.smallN.min` floor
 * (5 for every KPI that declares one), NOT the k=5 k-anonymity suppression
 * that lib/metrics/anonymity.ts applies to per-jurisdiction rollups. The copy
 * says "muestra demasiado chica", never "suprimido por privacidad" — claiming
 * a privacy mechanism that did not run would be its own small lie.
 */
export function describeBriefingEmptyState(coverage: BriefingCoverage): BriefingEmptyState {
  const { met, unmeasured, suppressed } = coverage;
  const evaluable = met.length + unmeasured.length + suppressed.length;
  const details: string[] = [];

  if (unmeasured.length > 0) {
    details.push(`Sin medición en este período: ${kpiLabels(unmeasured)}.`);
  }
  if (suppressed.length > 0) {
    details.push(
      `Con datos, pero muestra demasiado chica para evaluar contra la meta: ${kpiLabels(suppressed)}.`,
    );
  }

  // Nothing on this screen carries a target at all — there is no "range" to be
  // inside of, so the old sentence would have been meaningless here too.
  if (evaluable === 0) {
    return {
      headline: "Sin alertas activas — ninguna métrica de esta vista tiene una meta que evaluar.",
      details,
    };
  }

  // Nothing measurable: the case the old copy painted green.
  if (met.length === 0) {
    return {
      headline:
        "Sin alertas activas — ninguna métrica con meta tiene una medición evaluable en este período.",
      details,
    };
  }

  // Everything measurable was measured, and met its target — the ONE case the
  // original sentence was actually true for.
  if (met.length === evaluable) {
    const noun = pluralizeEs(met.length, "métrica");
    const verb = met.length === 1 ? "está" : "están";
    return {
      headline: `Sin alertas activas — ${formatCount(met.length)} ${noun} con meta ${verb} dentro de rango.`,
      details,
    };
  }

  // Mixed: some met, some unevaluable. Say the fraction, never the whole.
  return {
    headline: `Sin alertas activas — ${formatCount(met.length)} de ${formatCount(evaluable)} métricas con meta dentro de rango.`,
    details,
  };
}

/**
 * Compose the ranked, capped-at-5 briefing alert list from candidate metric
 * values. Candidates that fail a guard (no target / semaphore:none /
 * zero-denominator / small-N / target already met) are silently dropped —
 * NOT ranked last, never rendered. Ranking: severity desc (alta before
 * media), then gap size desc (bigger miss first).
 *
 * `urgencySignals` (claim #4, cursor red-team 2026-07-23) — the OPTIONAL
 * second candidate class for the two non-target-gap surveillance signals
 * (escalation gap, deadline breach). Merged into the SAME ranked/capped list
 * via buildUrgencyAlert, so a genuine legal-deadline breach can outrank a
 * target-gap alert exactly as its severity implies.
 *
 * RENDERING THE EMPTY CASE? Use `buildBriefingBoard` instead. This function
 * returns the alerts ALONE, and an empty array cannot distinguish "every
 * target met" from "nothing was measured" — reading it as the former is the
 * exact bug BriefingCoverage exists to kill (A1, 2026-07-31).
 */
export function buildBriefingAlerts(
  candidates: readonly BriefingAlertCandidate[],
  urgencySignals: readonly SurveillanceUrgencyCandidate[] = [],
  // Mandate-scoped legal citation (red-team CRITICAL follow-up 2026-07-24). The
  // gob tile fix (formatMetricLegalBasis) scoped the KPI tile but NOT this
  // briefing alert — a jurisdictional operator still saw a foreign province's
  // law (e.g. "CABA: Ley 5470" to a Tierra del Fuego operator) in the
  // alert. Admin/national callers pass "all" (the default) and keep
  // the catalog's canonical source wording; a jurisdictional operator passes
  // their mandate provinces and gets the resolved citation — or neutral framing
  // when no mandate province regulates the metric, never a foreign law.
  mandateProvinces: MandateProvinces = "all",
): BriefingAlert[] {
  return buildBriefingBoard(candidates, urgencySignals, mandateProvinces).alerts;
}
