// Unit tests for lib/metrics/briefing-alerts.ts — PURE, DB-free (C6b).
//
// Pins the briefing engine's guards to the same red-team classes C1 already
// fences at the tile level (dim-interno:docs/reviews/results/2026-07-22-plan-maestro-
// integridad.md, §C6): an alert must never fire from unmeasurable data, a
// semaphore that refuses a legal-verdict tone, or a met target — and the
// ranked list is always capped at 5.

import { describe, expect, it } from "vitest";

import {
  type BriefingAlertCandidate,
  MAX_BRIEFING_ALERTS,
  type SurveillanceUrgencyCandidate,
  buildBriefingAlerts,
  buildBriefingBoard,
  deriveAlertConfidence,
  describeBriefingEmptyState,
} from "./briefing-alerts";
import { KPI_CATALOG } from "./kpi-catalog";

describe("buildBriefingAlerts — guard exclusions", () => {
  it("never alerts a KPI with no target (no gap to compute)", () => {
    // bites_per_10k has no `target`/`semaphore` at all.
    const candidates: BriefingAlertCandidate[] = [{ kpiId: "bites_per_10k", value: 40, n: 100 }];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });

  it("never alerts a KPI whose semaphore explicitly refuses a legal-verdict tone", () => {
    // ppp_registry_compliance HAS a target (100) but semaphore: {paintAgainst: "none"}.
    expect(KPI_CATALOG.ppp_registry_compliance.target).toBeDefined();
    expect(KPI_CATALOG.ppp_registry_compliance.semaphore?.paintAgainst).toBe("none");
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "ppp_registry_compliance", value: 0, n: 20 },
    ];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });

  it("never alerts on a zero-denominator (unmeasurable) reading", () => {
    // mortality_disposal_traceability declares guards.zeroDenominator: 'dash'.
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 0, n: 0 },
    ];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });

  it("never alerts on a small-N sample even when the gap looks large", () => {
    // mortality_disposal_traceability declares guards.smallN.min = 5.
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 0, n: 2 },
    ];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });

  it("never alerts when the value already meets or beats the target", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "rabies_coverage_dogs_12m", value: 85, n: 500 },
    ];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });

  it("drops a candidate whose KPI has no registered owning screen", () => {
    // custody_return_rate DOES have a target + semaphore:target, so it clears
    // every guard above — but it's a lower-is-better ratio the engine
    // deliberately does not register an action for (see the module header:
    // this engine's gap/tone math assumes higher-is-better). Confirms the
    // "no owning screen" branch drops it instead of fabricating a link.
    expect(KPI_CATALOG.custody_return_rate.target).toBeDefined();
    expect(KPI_CATALOG.custody_return_rate.semaphore?.paintAgainst).toBe("target");
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "custody_return_rate", value: 5, n: 50 },
    ];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });
});

describe("buildBriefingAlerts — a real gap produces an alert", () => {
  it("produces an alert carrying title/evidence/severity/confidence/action for a real gap", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 33, n: 12 },
    ];
    const alerts = buildBriefingAlerts(candidates);
    expect(alerts).toHaveLength(1);
    const [alert] = alerts;
    expect(alert.id).toBe("mortality_disposal_traceability");
    // Rounding-drift fix (qa-triage-2026-07-23 finding #6): the alert's value
    // routes through the SAME 1-decimal formatPercent every KPI tile uses —
    // an exact 33 renders "33,0%", never a bare 0-decimal "33%" that could
    // silently disagree with a tile showing e.g. "33,7%" for the same metric.
    expect(alert.title).toContain("33,0%");
    // C1 fix (claim #6, cursor red-team 2026-07-23): a law-sourced but
    // non-statutory target renders as "Obligación: <ley> · Meta programática:
    // X%" — NOT "meta X% (<ley>)", which reads as if the law set the number.
    expect(alert.title).toContain("Meta programática: 75%");
    // Default scope here is national ("all") and Ley 5470 is CABA's, so the
    // citation carries its reach (demo review 2026-08-01) — the statute itself
    // is unchanged and still named.
    expect(alert.title).toContain("Obligación: normativa provincial (no nacional)");
    expect(alert.title).toContain("CABA: Ley 5470");
    expect(alert.evidence).toEqual({
      value: 33,
      target: 75,
      unit: "percent",
      n: 12,
      source: "normativa provincial (no nacional) · CABA: Ley 5470",
    });
    expect(alert.actionHref).toBe("/gob/mortalidad");
    expect(alert.actionLabel).toBe("Ver en Mortalidad y disposición");
    // 33 vs target 75 with the default 50% warn band → 75*0.5=37.5, 33 < 37.5 → danger.
    expect(alert.severity).toBe("alta");
  });

  // A4 (UI review 2026-08-06) — number-first anatomy. The card renders name /
  // hero number / metadata as three lines, so the engine hands them over split
  // instead of leaving the view to regex the sentence apart.
  it("splits the SAME sentence into name + hero value + metadata, losing no clause", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 33, n: 12 },
    ];
    const [alert] = buildBriefingAlerts(candidates);
    expect(alert.display.name).toBe(KPI_CATALOG.mortality_disposal_traceability.label);
    // The hero is the SAME formatted figure the title carries — one rounding
    // rule, never a second opinion of the same metric.
    expect(alert.display.value).toBe("33,0%");
    expect(alert.title).toContain(alert.display.value as string);
    // Every clause of the title survives in one of the three fields.
    expect(alert.display.metadata).toContain("Obligación: normativa provincial (no nacional)");
    expect(alert.display.metadata).toContain("CABA: Ley 5470");
    expect(alert.display.metadata).toContain("Meta programática: 75%");
    expect(alert.title).toBe(
      `${alert.display.name} ${alert.display.value} — ${alert.display.metadata}`,
    );
  });
});

// Cursor red-team 2026-07-23 (claim #4): "Panel calm (0 obs, 0 open bites) vs
// Vigilancia gap (14 reports vs 0 obs, 3 past 10-day deadline)" — the
// briefing never surfaced real surveillance urgency. These two candidates are
// NOT target-gap shaped (bite_escalation_gap and the deadline-breach count
// are deliberately non-ratio, semaphore:none) — a separate honest path.
describe("buildBriefingAlerts — surveillance urgency signals (claim #4)", () => {
  it("never fabricates an escalation-gap alert on a genuine 0/0 (no bites at all)", () => {
    const signals: SurveillanceUrgencyCandidate[] = [
      { kind: "escalation_gap", bites12m: 0, openObservations: 0 },
    ];
    expect(buildBriefingAlerts([], signals)).toEqual([]);
  });

  it("does not alert the escalation gap when observations ARE open (no gap)", () => {
    const signals: SurveillanceUrgencyCandidate[] = [
      { kind: "escalation_gap", bites12m: 14, openObservations: 2 },
    ];
    expect(buildBriefingAlerts([], signals)).toEqual([]);
  });

  it("fires the escalation-gap alert on a real gap (bites reported, zero observations open)", () => {
    const signals: SurveillanceUrgencyCandidate[] = [
      { kind: "escalation_gap", bites12m: 14, openObservations: 0 },
    ];
    const [alert] = buildBriefingAlerts([], signals);
    expect(alert.id).toBe("bite_escalation_gap");
    expect(alert.title).toContain("14 mordeduras");
    expect(alert.title).toContain("0 observaciones abiertas");
    expect(alert.severity).toBe("media");
    expect(alert.actionHref).toBe("/gob/vigilancia");
    // A4: the reported-bites count leads; the pairing's second term and the
    // no-verdict caveat move to the metadata line intact.
    expect(alert.display.name).toBe(KPI_CATALOG.bite_escalation_gap.label);
    expect(alert.display.value).toBe("14");
    expect(alert.display.metadata).toContain("mordeduras (12m)");
    expect(alert.display.metadata).toContain("0 observaciones abiertas");
    expect(alert.display.metadata).toContain(
      "la ausencia de escalamiento no implica ausencia de riesgo",
    );
  });

  // Live on /gob 2026-07-25: the panel read "1507 mordeduras (12m)" beside a
  // tile reading "3.541". Every fixture above is two digits, so no test ever
  // crossed a thousand and the raw interpolation survived. A government panel
  // that prints es-AR numbers unformatted looks like a different system talking.
  it("formats counts over a thousand with the es-AR separator", () => {
    const signals: SurveillanceUrgencyCandidate[] = [
      { kind: "escalation_gap", bites12m: 1507, openObservations: 0 },
    ];
    const [alert] = buildBriefingAlerts([], signals);
    expect(alert.title).toContain("1.507 mordeduras");
    expect(alert.title).not.toContain("1507");
  });

  it("formats the deadline-breach count too", () => {
    const signals: SurveillanceUrgencyCandidate[] = [
      { kind: "deadline_breach", openBreaches: 1204 },
    ];
    const [alert] = buildBriefingAlerts([], signals);
    expect(alert.title).toContain("1.204 observaciones");
  });

  it("never fabricates a deadline-breach alert when openBreaches is 0", () => {
    const signals: SurveillanceUrgencyCandidate[] = [{ kind: "deadline_breach", openBreaches: 0 }];
    expect(buildBriefingAlerts([], signals)).toEqual([]);
  });

  it("fires the deadline-breach alert with 'alta' severity — a live legal-deadline miss", () => {
    const signals: SurveillanceUrgencyCandidate[] = [{ kind: "deadline_breach", openBreaches: 3 }];
    const [alert] = buildBriefingAlerts([], signals);
    expect(alert.id).toBe("rabies_observation_compliance_10d");
    expect(alert.title).toContain("3 observaciones rábicas superan");
    expect(alert.title).toContain("plazo legal de 10 días");
    expect(alert.severity).toBe("alta");
    // A4: the breach COUNT is the alert — it leads, the legal clause and its
    // citation follow as metadata.
    expect(alert.display.name).toBe(KPI_CATALOG.rabies_observation_compliance_10d.label);
    expect(alert.display.value).toBe("3");
    expect(alert.display.metadata).toContain("observaciones rábicas superan el plazo legal");
    // G8 (obligations-worklist): an act-now breach count lands on the
    // deadline worklist — where those observations rank first and carry
    // their "Cerrar →" resolution — not on the Vigilancia dashboard.
    expect(alert.actionHref).toBe("/gob/acciones");
    expect(alert.actionLabel).toBe("Ver en Acciones que vencen");
  });

  it("merges urgency signals into the SAME ranked/capped list as target-gap alerts, alta before media", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 33, n: 12 }, // alta
    ];
    const signals: SurveillanceUrgencyCandidate[] = [
      { kind: "escalation_gap", bites12m: 14, openObservations: 0 }, // media
      { kind: "deadline_breach", openBreaches: 3 }, // alta
    ];
    const alerts = buildBriefingAlerts(candidates, signals);
    expect(alerts).toHaveLength(3);
    expect(alerts.filter((a) => a.severity === "alta")).toHaveLength(2);
    expect(alerts[alerts.length - 1].severity).toBe("media");
  });
});

describe("buildBriefingAlerts — ranking", () => {
  it("ranks severity (alta) before severity (media), then by gap size within a tier", () => {
    const candidates: BriefingAlertCandidate[] = [
      // warn tier: 75*0.5=37.5 <= value < 75 → media. gap = 75-60 = 15.
      { kpiId: "mortality_disposal_traceability", value: 60, n: 12 },
      // danger tier: value < 40 (80*0.5) → alta. gap = 80-20 = 60 (larger gap).
      { kpiId: "rabies_coverage_dogs_12m", value: 20, n: 500 },
      // danger tier: value < 40 (80*0.5) → alta. gap = 80-30 = 50.
      { kpiId: "microchip_penetration", value: 30, n: 500 },
    ];
    const alerts = buildBriefingAlerts(candidates);
    expect(alerts.map((a) => a.id)).toEqual([
      "rabies_coverage_dogs_12m", // alta, gap 60
      "microchip_penetration", // alta, gap 50
      "mortality_disposal_traceability", // media, gap 15
    ]);
    expect(alerts.map((a) => a.severity)).toEqual(["alta", "alta", "media"]);
  });

  it("caps the ranked list at MAX_BRIEFING_ALERTS (5)", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "rabies_coverage_dogs_12m", value: 10, n: 500 },
      { kpiId: "microchip_penetration", value: 10, n: 500 },
      { kpiId: "mortality_disposal_traceability", value: 10, n: 20 },
      { kpiId: "reunification_rate", value: 5, n: 20 },
      { kpiId: "rabies_observation_compliance_10d", value: 10, n: 20 },
      { kpiId: "campaign_completion_rate", value: 10, n: 20 },
      { kpiId: "eno_sla_compliance", value: 10, n: 20 },
    ];
    expect(candidates.length).toBeGreaterThan(MAX_BRIEFING_ALERTS);
    const alerts = buildBriefingAlerts(candidates);
    expect(alerts).toHaveLength(MAX_BRIEFING_ALERTS);
  });
});

describe("buildBriefingAlerts — resourceLine (PO decision 2, item 2)", () => {
  it("appends 'faltan ~N {unit}' when the descriptor names a resourceUnit", () => {
    expect(KPI_CATALOG.microchip_penetration.resourceUnit).toBe("chips");
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "microchip_penetration", value: 20, n: 500 },
    ];
    const [alert] = buildBriefingAlerts(candidates);
    // (80-20)/100 * 500 = 300
    expect(alert.evidence.resourceLine).toBe("faltan ~300 chips sobre el padrón registrado");
  });

  it("never fabricates a resourceLine for a descriptor without a resourceUnit", () => {
    expect(KPI_CATALOG.mortality_disposal_traceability.resourceUnit).toBeUndefined();
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 33, n: 12 },
    ];
    const [alert] = buildBriefingAlerts(candidates);
    expect(alert.evidence.resourceLine).toBeUndefined();
  });

  it("never alerts at all when n is 0 (zeroDenominator guard, red-team 2026-07 #3)", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "microchip_penetration", value: 20, n: 0 },
    ];
    // microchip_penetration now declares guards.zeroDenominator ("dash") —
    // a 0/0 padrón (e.g. an out-of-mandate locality filter) must never
    // surface a "Confianza: alta · n = 0" briefing alert.
    expect(KPI_CATALOG.microchip_penetration.guards?.zeroDenominator).toBe("dash");
    expect(buildBriefingAlerts(candidates)).toHaveLength(0);
  });
});

describe("buildBriefingAlerts — mandate-scoped legal citation (red-team CRITICAL follow-up)", () => {
  // The gob tile fix (formatMetricLegalBasis) scoped the KPI tile but left this
  // briefing alert citing a foreign province's law to a jurisdictional
  // operator. The alert's title AND evidence.source must resolve the citation
  // against the operator's mandate — same contract as the tile.
  //
  // The vehicle used to be microchip_penetration. It stopped being a legal
  // citation at all on 2026-08-17 (the PBA/CABA chip mandate turned out not to
  // exist — see metric-legal-basis.ts), so these moved to
  // mortality_disposal_traceability, whose Ley CABA 5470 is a real CABA
  // obligation and therefore still exercises the scoping contract.
  const candidates: BriefingAlertCandidate[] = [
    { kpiId: "mortality_disposal_traceability", value: 30, n: 500 },
  ];

  // Demo review 2026-08-01. This test pinned the defect: at national scope the
  // alert kept `descriptor.target.source` verbatim, so the briefing read
  // "Disposición trazable 30% — Obligación: Ley CABA 5470" to a national
  // official. The law is right and stays cited; what it lacked was its reach.
  // See NATIONAL_VIEW_PROVINCIAL_ONLY_ES for why the answer is disclosure
  // rather than swapping — or hiding — the statute.
  it("default (national/'all') qualifies a provincial-only citation instead of presenting it as binding", () => {
    const [alert] = buildBriefingAlerts(candidates);
    expect(alert.evidence.source).toBe("normativa provincial (no nacional) · CABA: Ley 5470");
    expect(alert.title).toContain("Obligación: normativa provincial (no nacional)");
    // Still names the actual statute and the province it comes from — a
    // funcionario has to be able to go look it up.
    expect(alert.title).toContain("CABA: Ley 5470");
  });

  it("cites the province's law to an operator whose mandate INCLUDES it", () => {
    const [alert] = buildBriefingAlerts(candidates, [], ["CABA"]);
    expect(alert.evidence.source).toBe("CABA: Ley 5470");
    expect(alert.title).toContain("CABA: Ley 5470");
  });

  it("NEVER cites a foreign province's law to an operator whose mandate EXCLUDES it", () => {
    const [alert] = buildBriefingAlerts(candidates, [], ["Buenos Aires", "Tierra del Fuego"]);
    // Neutral framing — never "Ley CABA 5470", never a blank.
    expect(alert.evidence.source).toBe("Según la normativa provincial de tu jurisdicción");
    expect(alert.title).not.toContain("5470");
    expect(alert.title).not.toContain("CABA");
  });

  // 2026-08-17. resolveScopedSource does `?? undefined`, so a KPI absent from
  // METRIC_LEGAL_BASIS keeps `descriptor.target.source` VERBATIM. Deleting the
  // microchip registry entry alone would therefore have re-asserted the
  // refuted claim straight out of the catalog. Both halves are pinned here at
  // the surface a funcionario actually reads.
  it("the microchip alert asserts no legal obligation at any scope", () => {
    for (const mandate of [undefined, ["Buenos Aires"], ["CABA", "Tierra del Fuego"]] as const) {
      const [alert] = buildBriefingAlerts(
        [{ kpiId: "microchip_penetration", value: 30, n: 500 }],
        [],
        mandate ?? "all",
      );
      expect(alert.title).not.toContain("14.107");
      expect(alert.title).not.toContain("4078");
      expect(alert.title).not.toContain("Obligación");
      expect(alert.evidence.source ?? "").not.toMatch(/Ley/i);
    }
  });
});

// ---------------------------------------------------------------------------
// A1 (2026-07-31) — THE AUTOMATIC GREEN.
//
// /gob rendered "Sin alertas activas — las métricas con meta están dentro de
// rango." off `alerts.length === 0`. Every describe block ABOVE this one
// asserts that a guard produces `[]` — and each of them is correct. Together
// they proved something nobody noticed: the engine returns the SAME empty
// array for "nothing was measured", "the sample is too small to judge" and
// "every target was met". The screen then read that array as a verdict, so a
// municipality with no data loaded was told its metrics were in range.
//
// These tests pin the distinction the engine now keeps.
// ---------------------------------------------------------------------------

describe("buildBriefingBoard — coverage says WHICH emptiness this is", () => {
  it("reports a zero-denominator candidate as unmeasured, never as met", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 0, n: 0 },
    ];
    const { alerts, coverage } = buildBriefingBoard(candidates);
    expect(alerts).toEqual([]);
    expect(coverage.unmeasured).toEqual(["mortality_disposal_traceability"]);
    expect(coverage.met).toEqual([]);
    expect(coverage.suppressed).toEqual([]);
  });

  it("reports a small-N candidate as suppressed — data exists, the verdict does not", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 0, n: 2 },
    ];
    const { coverage } = buildBriefingBoard(candidates);
    expect(coverage.suppressed).toEqual(["mortality_disposal_traceability"]);
    expect(coverage.unmeasured).toEqual([]);
    expect(coverage.met).toEqual([]);
  });

  it("reports a measured, met target as met", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "rabies_coverage_dogs_12m", value: 85, n: 500 },
    ];
    const { coverage } = buildBriefingBoard(candidates);
    expect(coverage.met).toEqual(["rabies_coverage_dogs_12m"]);
    expect(coverage.unmeasured).toEqual([]);
    expect(coverage.suppressed).toEqual([]);
  });

  it("keeps a target-less KPI out of the 'métricas con meta' count entirely", () => {
    // bites_per_10k has no target — it was never part of the claim, so it must
    // land in neither `met` (overclaiming) nor `unmeasured` (underclaiming).
    const { coverage } = buildBriefingBoard([{ kpiId: "bites_per_10k", value: 40, n: 100 }]);
    expect(coverage.notEvaluated).toEqual(["bites_per_10k"]);
    expect(coverage.met).toEqual([]);
    expect(coverage.unmeasured).toEqual([]);
    expect(coverage.suppressed).toEqual([]);
  });

  it("an alerting candidate lands in no coverage bucket at all — it is on screen", () => {
    const { alerts, coverage } = buildBriefingBoard([
      { kpiId: "mortality_disposal_traceability", value: 33, n: 12 },
    ]);
    expect(alerts).toHaveLength(1);
    expect(coverage).toEqual({ met: [], unmeasured: [], suppressed: [], notEvaluated: [] });
  });

  it("returns the SAME ranked alerts as buildBriefingAlerts — coverage is additive, not a rewrite", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 60, n: 12 },
      { kpiId: "rabies_coverage_dogs_12m", value: 20, n: 500 },
      { kpiId: "microchip_penetration", value: 30, n: 500 },
    ];
    const signals: SurveillanceUrgencyCandidate[] = [{ kind: "deadline_breach", openBreaches: 3 }];
    expect(buildBriefingBoard(candidates, signals, ["Buenos Aires"]).alerts).toEqual(
      buildBriefingAlerts(candidates, signals, ["Buenos Aires"]),
    );
  });
});

describe("describeBriefingEmptyState — the copy never outruns the data", () => {
  it("claims 'dentro de rango' ONLY when every evaluable metric was measured and met", () => {
    const { coverage } = buildBriefingBoard([
      { kpiId: "rabies_coverage_dogs_12m", value: 85, n: 500 },
      { kpiId: "microchip_penetration", value: 90, n: 500 },
    ]);
    const { headline, details } = describeBriefingEmptyState(coverage);
    expect(headline).toBe("Sin alertas activas — 2 métricas con meta están dentro de rango.");
    expect(details).toEqual([]);
  });

  it("agrees in the singular for exactly one met metric", () => {
    const { coverage } = buildBriefingBoard([
      { kpiId: "rabies_coverage_dogs_12m", value: 85, n: 500 },
    ]);
    expect(describeBriefingEmptyState(coverage).headline).toBe(
      "Sin alertas activas — 1 métrica con meta está dentro de rango.",
    );
  });

  it("NEVER says 'dentro de rango' when nothing was measured — the A1 defect", () => {
    // The exact /gob shape on an empty jurisdiction: no dogs in the padrón, no
    // pets active, no deaths recorded. Three zero-denominators, zero alerts.
    const { alerts, coverage } = buildBriefingBoard([
      { kpiId: "rabies_coverage_dogs_12m", value: 0, n: 0 },
      { kpiId: "microchip_penetration", value: 0, n: 0 },
      { kpiId: "mortality_disposal_traceability", value: 0, n: 0 },
    ]);
    expect(alerts).toEqual([]);
    const { headline, details } = describeBriefingEmptyState(coverage);
    expect(headline).toBe(
      "Sin alertas activas — ninguna métrica con meta tiene una medición evaluable en este período.",
    );
    expect(headline).not.toContain("dentro de rango");
    expect(details).toEqual([
      `Sin medición en este período: ${KPI_CATALOG.rabies_coverage_dogs_12m.label}, ${KPI_CATALOG.microchip_penetration.label}, ${KPI_CATALOG.mortality_disposal_traceability.label}.`,
    ]);
  });

  it("says the FRACTION when some metrics were measured and others were not", () => {
    const { coverage } = buildBriefingBoard([
      { kpiId: "rabies_coverage_dogs_12m", value: 85, n: 500 }, // met
      { kpiId: "microchip_penetration", value: 0, n: 0 }, // unmeasured
      { kpiId: "mortality_disposal_traceability", value: 0, n: 2 }, // suppressed
    ]);
    const { headline, details } = describeBriefingEmptyState(coverage);
    expect(headline).toBe("Sin alertas activas — 1 de 3 métricas con meta dentro de rango.");
    expect(details).toEqual([
      `Sin medición en este período: ${KPI_CATALOG.microchip_penetration.label}.`,
      `Con datos, pero muestra demasiado chica para evaluar contra la meta: ${KPI_CATALOG.mortality_disposal_traceability.label}.`,
    ]);
  });

  it("distinguishes suppressed from unmeasured — a small sample is not an absent one", () => {
    const suppressed = describeBriefingEmptyState(
      buildBriefingBoard([{ kpiId: "mortality_disposal_traceability", value: 0, n: 2 }]).coverage,
    );
    const unmeasured = describeBriefingEmptyState(
      buildBriefingBoard([{ kpiId: "mortality_disposal_traceability", value: 0, n: 0 }]).coverage,
    );
    expect(suppressed.details).toEqual([
      `Con datos, pero muestra demasiado chica para evaluar contra la meta: ${KPI_CATALOG.mortality_disposal_traceability.label}.`,
    ]);
    expect(unmeasured.details).toEqual([
      `Sin medición en este período: ${KPI_CATALOG.mortality_disposal_traceability.label}.`,
    ]);
    expect(suppressed.details).not.toEqual(unmeasured.details);
  });

  it("says so plainly when no metric on the view carries a target at all", () => {
    const { coverage } = buildBriefingBoard([{ kpiId: "bites_per_10k", value: 40, n: 100 }]);
    const { headline, details } = describeBriefingEmptyState(coverage);
    expect(headline).toBe(
      "Sin alertas activas — ninguna métrica de esta vista tiene una meta que evaluar.",
    );
    expect(headline).not.toContain("dentro de rango");
    expect(details).toEqual([]);
  });

  it("never claims a privacy mechanism that did not run — smallN is not k-anonymity", () => {
    const { coverage } = buildBriefingBoard([
      { kpiId: "mortality_disposal_traceability", value: 0, n: 2 },
    ]);
    const { details } = describeBriefingEmptyState(coverage);
    expect(details.join(" ")).not.toMatch(/privacidad|anonimato/i);
  });
});

// ---------------------------------------------------------------------------
// Severity never outruns confidence (demo review 2026-08-01).
//
// Live on /gob with a 5-locality mandate: "Prioridad alta: Disposición
// trazable 33,3% · Confianza: baja · n = 9". One line claiming maximum urgency
// and, in the same breath, disavowing the evidence under it. Severity came
// from `tone` alone; the confidence label was computed beside it and never
// consulted. A briefing that ranks a 9-case sample above a measured one is
// ranking by noise.
// ---------------------------------------------------------------------------

describe("buildBriefingAlerts — severity is capped by confidence", () => {
  it("caps a danger-tier gap at 'media' when the sample only earns 'baja' confidence", () => {
    // n = 9: above mortality_disposal_traceability's smallN floor (5, so the
    // guard does not drop it) but under 2x that floor, which is exactly what
    // deriveAlertConfidence calls "baja". 33 vs target 75 is danger-tier.
    const [alert] = buildBriefingAlerts([
      { kpiId: "mortality_disposal_traceability", value: 33, n: 9 },
    ]);
    expect(alert.confidence).toBe("baja");
    expect(alert.severity).toBe("media");
  });

  it("keeps 'alta' for the SAME gap once the sample supports it", () => {
    const [alert] = buildBriefingAlerts([
      { kpiId: "mortality_disposal_traceability", value: 33, n: 12 },
    ]);
    expect(alert.confidence).not.toBe("baja");
    expect(alert.severity).toBe("alta");
  });

  it("never PROMOTES a warn-tier gap to 'alta' on high confidence", () => {
    // 60 vs target 75 sits in the warn band — a comfortable sample must not
    // turn an amber gap red.
    const [alert] = buildBriefingAlerts([
      { kpiId: "mortality_disposal_traceability", value: 60, n: 500 },
    ]);
    expect(alert.severity).toBe("media");
  });

  it("ranks a thin danger-tier gap BELOW a measured one, however big its gap", () => {
    const alerts = buildBriefingAlerts([
      // Thin sample, enormous gap (75 - 2 = 73) — used to sort first on both
      // severity and gap size, putting the least trustworthy number at the top
      // of the briefing.
      { kpiId: "mortality_disposal_traceability", value: 2, n: 9 },
      // Measured sample, smaller gap (80 - 30 = 50).
      { kpiId: "microchip_penetration", value: 30, n: 500 },
    ]);
    expect(alerts.map((a) => a.id)).toEqual([
      "microchip_penetration",
      "mortality_disposal_traceability",
    ]);
  });
});

describe("deriveAlertConfidence", () => {
  const withSmallN = { guards: { smallN: { min: 5 } } };

  it("returns 'baja' when n sits under 2x the smallN floor (guard didn't fire, but still thin)", () => {
    expect(deriveAlertConfidence(withSmallN, { n: 6 })).toBe("baja");
    expect(deriveAlertConfidence(withSmallN, { n: 9 })).toBe("baja");
  });

  it("returns 'alta' once n comfortably clears 2x the smallN floor, with a confidence input declared", () => {
    expect(deriveAlertConfidence({ ...withSmallN, confidence: { inputs: ["x"] } }, { n: 10 })).toBe(
      "alta",
    );
  });

  it("returns 'media' when a declared secondary input is explicitly absent", () => {
    expect(
      deriveAlertConfidence(
        { confidence: { inputs: ["census row"] } },
        { n: 500, auxPresent: false },
      ),
    ).toBe("media");
  });

  it("returns 'media' when the descriptor's caveat flags seed-thin data", () => {
    expect(
      deriveAlertConfidence(
        { confidence: { inputs: ["x"] }, caveat: "SEED-DENSITY CAVEAT: low density." },
        { n: 500 },
      ),
    ).toBe("media");
  });

  it("returns 'media' when the descriptor has no confidence prose at all — never overclaims 'alta'", () => {
    expect(deriveAlertConfidence({}, { n: 500 })).toBe("media");
  });

  it("returns 'alta' for a comfortable sample with documented confidence and no caveats", () => {
    expect(deriveAlertConfidence({ confidence: { inputs: ["x"] } }, { n: 500 })).toBe("alta");
  });
});
