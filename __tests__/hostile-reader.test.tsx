// @vitest-environment jsdom
//
// Hostile-reader suite — the C1 acceptance test (dim-interno:docs/reviews/results/
// 2026-07-22-plan-maestro-integridad.md, §2 "C1 · Contrato de Métrica", test
// de aceptación). The red-team review's "narrativas opuestas" table becomes
// assertions here: for each metric this task touched, the tile the operator
// actually sees must carry whatever information disarms the WRONG reading —
// never just the bare number + color.
//
// RENDER-LEVEL: this tests the guard engine (lib/metrics/presentation-
// guards.ts) directly for the pure invariants, and the OpKpi `descriptorId`
// path (components/ui/dashboard/OpKpi.tsx) via @testing-library/react for
// what the operator's screen actually shows — same posture as OpKpi.test.tsx.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { biteEscalationSub } from "@/app/gob/vigilancia/_components/rabies-counter-labels";
import { OpKpi } from "@/components/ui/dashboard/OpKpi";
import { type BriefingAlertCandidate, buildBriefingAlerts } from "@/lib/metrics/briefing-alerts";
import { forecastToTarget } from "@/lib/metrics/forecast-to-target";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import {
  UNSTABLE_DELTA_BASE_NOTE,
  guardRatioTone,
  resolveSemaphoreTone,
  shouldSuppressDelta,
  smallNGate,
  zeroDenominatorGate,
} from "@/lib/metrics/presentation-guards";
import { TARGETS } from "@/lib/metrics/targets";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// 1. Reunificación 100% con N=2 — "100% reunificación junto a 68 perdidas"
// ---------------------------------------------------------------------------

describe("hostile reader — reunificación con N chico (red-team: '100% con N=2')", () => {
  it("renders neutral tone (never 'ok' green) and carries the '2 de' episode count", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.reunification_rate.label}
        value="100,0%"
        tone="ok"
        sub="meta 39% · 2 de 2 episodios (30d) · 68 perdidas activas ahora"
        descriptorId="reunification_rate"
        guardInput={{ n: 2 }}
      />,
    );

    // The real value survives — this is an honest fact, not hidden.
    expect(screen.getByText("100,0%")).toBeInTheDocument();
    // The episode count that disarms "100% = total success" is visible.
    expect(screen.getByText(/2 de 2 episodios/)).toBeInTheDocument();
    // The small-sample note the guard engine appends is visible.
    expect(screen.getByText(/Muestra chica/)).toBeInTheDocument();
    // Tone was forced neutral: the card must NOT carry the "ok" (green)
    // surface token — a 100% figure over N=2 must not read as a green win.
    const card = screen.getByText("100,0%").closest("div.flex.flex-col");
    expect(card?.className).not.toContain("st-ok-bg");
    expect(card?.className).toContain("bg-ln-op-card");
  });

  it("guard engine: zero episodes hits the zero-denominator gate, not the small-N gate", () => {
    expect(zeroDenominatorGate(KPI_CATALOG.reunification_rate, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Mortalidad 0/0 → "—" — "0 observaciones leído como 'controlado'" class
// ---------------------------------------------------------------------------

describe("hostile reader — mortalidad 0/0 (latent '0/0 → 0%')", () => {
  it("the descriptor declares the zero-denominator dash guard", () => {
    expect(KPI_CATALOG.mortality_deaths_12m.guards?.zeroDenominator).toBe("dash");
  });

  it("zero deaths gates traceableRate to a dash, not a fabricated 0%", () => {
    expect(zeroDenominatorGate(KPI_CATALOG.mortality_deaths_12m, 0)).toBe(true);
    expect(zeroDenominatorGate(KPI_CATALOG.mortality_deaths_12m, 12)).toBe(false);
  });

  it("OpKpi renders the dash (never '0%') when n=0 under this descriptor", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.mortality_disposal_traceability.label}
        value="0,0%"
        tone="danger"
        descriptorId="mortality_disposal_traceability"
        guardInput={{ n: 0 }}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0,0%")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. Antirrábica histórica — "doble antirrábica" (S1's headline example)
// ---------------------------------------------------------------------------

describe("hostile reader — antirrábica histórica nunca se confunde con cumplimiento", () => {
  it("the historic all-species KPI's label is unmistakably NOT a compliance figure", () => {
    const label = KPI_CATALOG.rabies_vaccination_rate_all_species.label.toLowerCase();
    expect(label).toContain("histórica");
    // And it must NOT share the compliance KPI's "cobertura antirrábica" stem
    // that caused the original 42%/54% same-label collision.
    expect(label).not.toContain("cobertura antirrábica");
  });

  it("never paints a tone derived from the 80% compliance target, at any rate value", () => {
    const descriptor = KPI_CATALOG.rabies_vaccination_rate_all_species;
    expect(descriptor.semaphore?.paintAgainst).toBe("none");
    // Whatever tone a render site might (wrongly) compute against the 80%
    // target, the guard degrades it to the informational "blue" — for a
    // rate far below AND far above the target alike.
    for (const computed of ["danger", "warn", "ok"] as const) {
      expect(resolveSemaphoreTone(descriptor, computed)).toBe("blue");
    }
  });

  it("the two rabies KPIs remain distinctly labeled (regression: the original bug)", () => {
    expect(KPI_CATALOG.rabies_coverage_dogs_12m.label).not.toBe(
      KPI_CATALOG.rabies_vaccination_rate_all_species.label,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. PPP — red-team #7, self-serve uptake painted "Peligro"
// ---------------------------------------------------------------------------

describe("hostile reader — PPP nunca pinta 'Peligro' desde una tasa de adopción", () => {
  it("the descriptor is contractually semaphore: none", () => {
    expect(KPI_CATALOG.ppp_registry_compliance.semaphore?.paintAgainst).toBe("none");
  });

  it("resolveSemaphoreTone never returns 'danger', even for a computed 0% rate", () => {
    const descriptor = KPI_CATALOG.ppp_registry_compliance;
    expect(resolveSemaphoreTone(descriptor, "danger")).not.toBe("danger");
  });

  it("OpKpi never renders the danger (red 'Peligro') surface for this descriptor", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.ppp_registry_compliance.label}
        value="0,0%"
        tone={resolveSemaphoreTone(KPI_CATALOG.ppp_registry_compliance, "danger")}
        sub="0 de 3 atestadas en MiMAR · no mide cumplimiento registral externo · Ley 4078"
        descriptorId="ppp_registry_compliance"
      />,
    );
    // "Peligro" is the sr-only tone label OpKpi emits for the danger tone —
    // it must never appear for this KPI.
    expect(screen.queryByText("Peligro:")).not.toBeInTheDocument();
    const card = screen.getByText("0,0%").closest("div.flex.flex-col");
    expect(card?.className).not.toContain("st-err-bg");
  });

  it("label/sub distinguish MiMAR self-attestation from external registry compliance", () => {
    const label = KPI_CATALOG.ppp_registry_compliance.label;
    expect(label.toLowerCase()).toContain("mimar");
    expect(KPI_CATALOG.ppp_registry_compliance.exclusions ?? "").toMatch(/registral externo/);
  });
});

// ---------------------------------------------------------------------------
// 5. Esterilizaciones −95% MoM sobre base inestable
// ---------------------------------------------------------------------------

describe("hostile reader — esterilizaciones: delta ausente sobre base inestable", () => {
  it("the guard suppresses the delta below the descriptor's prior-base floor", () => {
    expect(shouldSuppressDelta(KPI_CATALOG.sterilizations_per_month, 1)).toBe(true);
    expect(shouldSuppressDelta(KPI_CATALOG.sterilizations_per_month, 20)).toBe(false);
  });

  it("OpKpi omits the deltaV2 chip and shows the honest note when the prior base is unstable", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.sterilizations_per_month.label}
        value="1"
        deltaV2={{ value: -95, period: "vs mes ant." }}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 1 }}
      />,
    );
    expect(screen.queryByText(/-95/)).not.toBeInTheDocument();
    expect(screen.getByText(UNSTABLE_DELTA_BASE_NOTE)).toBeInTheDocument();
  });

  it("a healthy prior base still renders the delta chip", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.sterilizations_per_month.label}
        value="40"
        deltaV2={{ value: 12, period: "vs mes ant." }}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 30 }}
      />,
    );
    expect(screen.getByText(/vs mes ant\./)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. Bite escalation gap — red-team #6, empty queue ≠ "controlado"
// ---------------------------------------------------------------------------

describe("hostile reader — brecha de escalamiento nunca colapsa en una sola cifra", () => {
  it("the descriptor is a pair, not a ratio — no target, no semaphore judgment", () => {
    const descriptor = KPI_CATALOG.bite_escalation_gap;
    expect(descriptor.target).toBeUndefined();
    expect(descriptor.semaphore?.paintAgainst).toBe("none");
  });

  it("OpKpi renders BOTH counts, never a single blended ratio", () => {
    // The sub comes from the SCREEN's own builder, not a copy pasted here: the
    // hand-written fixture that used to sit in this argument kept asserting
    // "vs 0 observaciones rábicas abiertas" long after that wording was found
    // to collide with the neighbouring case counter (demo review 2026-08-01 #5).
    // A prop fixture is invisible to a grep for bad assertions — wiring it to
    // the real builder is what keeps this test honest.
    render(
      <OpKpi
        label={KPI_CATALOG.bite_escalation_gap.label}
        value="690"
        sub={biteEscalationSub(0)}
        descriptorId="bite_escalation_gap"
      />,
    );
    expect(screen.getByText("690")).toBeInTheDocument();
    expect(screen.getByText(/0 mascotas en observación rábica hoy/)).toBeInTheDocument();
    expect(screen.getByText(/no implica ausencia de riesgo/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. Microchip — red-team #15, denominator wording ("activas" vs active+lost)
// ---------------------------------------------------------------------------

describe("hostile reader — microchip: el denominador declarado coincide con el real", () => {
  it("the catalog denominator prose names BOTH active and lost pets, not 'activas' alone", () => {
    const denom = KPI_CATALOG.microchip_penetration.denominator.toLowerCase();
    expect(denom).toContain("active/lost");
  });

  it("the /gob home sub text names both populations (regression: 'de N activas' undercounted the denominator)", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.microchip_penetration.label}
        value="64,3%"
        // No legal clause: the chip mandate this used to cite does not exist
        // (2026-08-17 — see lib/metrics/metric-legal-basis.ts).
        sub="meta 80% · 320 de 500 activas/perdidas"
        descriptorId="microchip_penetration"
      />,
    );
    expect(screen.getByText(/activas\/perdidas/)).toBeInTheDocument();
  });

  it("a 0-pet padrón renders '—', never a fabricated '0%' (red-team 2026-07 #3)", () => {
    // Out-of-mandate locality filter ⇒ active=0. The descriptor's
    // zeroDenominator guard must dash the value through guardInput.n.
    render(
      <OpKpi
        label={KPI_CATALOG.microchip_penetration.label}
        value="0%"
        descriptorId="microchip_penetration"
        guardInput={{ n: 0 }}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 8. Antirrábica — denominador dual donde el censo aplica (red-team #2, parcial)
// ---------------------------------------------------------------------------

describe("hostile reader — cobertura antirrábica: censo co-equal, no subtexto", () => {
  it("the confidence contract names the census estimate as an input, not an afterthought", () => {
    const inputs = KPI_CATALOG.rabies_coverage_dogs_12m.confidence?.inputs ?? [];
    expect(inputs.some((i) => i.toLowerCase().includes("censal"))).toBe(true);
  });

  it("the home tile's sub renders the census figure as its OWN bolded first line, not a trailing clause", () => {
    render(
      <OpKpi
        label="Cobertura antirrábica (perros, 12m)"
        value="41,3%"
        sub={
          <span className="block space-y-0.5">
            <span className="block font-semibold text-ln-op-ink">
              68,2% del padrón sobre la población canina estimada
            </span>
            <span className="block text-ln-op-mute">12.480 perros en el padrón · meta 80%</span>
          </span>
        }
        descriptorId="rabies_coverage_dogs_12m"
      />,
    );
    // Both denominators are independently visible — neither is buried inside
    // a single run-on sentence with the other.
    expect(
      screen.getByText(/68,2% del padrón sobre la población canina estimada/),
    ).toBeInTheDocument();
    expect(screen.getByText(/12\.480 perros en el padrón/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 9. C1 SWEEP (2026-07-22, full 80-tile barrido) — narrative assertions from
// the newly-migrated surfaces (campañas, censo, programa, mortalidad,
// vigilancia). Each disarms a specific wrong reading the plan-maestro's
// honesty rules exist to prevent.
// ---------------------------------------------------------------------------

describe("hostile reader — campañas: la completitud nunca pinta desde un delta de volumen", () => {
  it("campaign_completion_rate is a RATE with a real target — never rendered with a delta chip", () => {
    const descriptor = KPI_CATALOG.campaign_completion_rate;
    expect(descriptor.target?.value).toBe(TARGETS.CAMPAIGN_COMPLETION_PCT);
    expect(descriptor.semaphore?.paintAgainst).toBe("target");
    // No unstableDeltaBase guard: this KPI never renders a deltaV2 chip at
    // all (the render site explicitly omits one — a volume delta next to a
    // stable rate would imply the RATE moved when only headcount did).
    expect(descriptor.guards?.unstableDeltaBase).toBeUndefined();
  });

  it("campaign_enrollment (the VOLUME sibling) carries the delta instead, gated by its own unstable-base guard", () => {
    const descriptor = KPI_CATALOG.campaign_enrollment;
    expect(descriptor.guards?.unstableDeltaBase?.minPriorBase).toBeGreaterThan(0);
    expect(shouldSuppressDelta(descriptor, 1)).toBe(true);
    expect(shouldSuppressDelta(descriptor, 20)).toBe(false);
  });

  it("OpKpi: a small-sample completion rate forces neutral tone instead of a confident 100%", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.campaign_completion_rate.label}
        value="100%"
        tone="ok"
        descriptorId="campaign_completion_rate"
        guardInput={{ n: 1 }}
      />,
    );
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText(/Muestra chica/)).toBeInTheDocument();
    const card = screen.getByText("100%").closest("div.flex.flex-col");
    expect(card?.className).not.toContain("st-ok-bg");
  });
});

describe("hostile reader — censo: los stocks (activas/inactivas/incompletos) nunca llevan delta de período", () => {
  it("registry_active_pets and registry_total_pets are pure stocks with no delta-suppression guard at all", () => {
    expect(KPI_CATALOG.registry_active_pets.basis).toBe("stock");
    expect(KPI_CATALOG.registry_active_pets.guards?.unstableDeltaBase).toBeUndefined();
    expect(KPI_CATALOG.registry_total_pets.basis).toBe("stock");
    expect(KPI_CATALOG.registry_total_pets.guards?.unstableDeltaBase).toBeUndefined();
  });

  it("registry_dormant_pets and registry_incomplete_profiles never paint a legal-verdict tone from their internal heuristic thresholds", () => {
    // Both descriptors document their color bands (20/40%, 15/30%) as
    // OPERATIONAL heuristics, not a sourced legal/programmatic target — the
    // contract's own semaphore field says so.
    expect(KPI_CATALOG.registry_dormant_pets.semaphore?.paintAgainst).toBe("none");
    expect(KPI_CATALOG.registry_dormant_pets.target).toBeUndefined();
    expect(KPI_CATALOG.registry_incomplete_profiles.semaphore?.paintAgainst).toBe("none");
    expect(KPI_CATALOG.registry_incomplete_profiles.target).toBeUndefined();
  });
});

describe("hostile reader — programa: el SLA ENO pinta solo contra su propia meta, nunca contra una meta de salud animal", () => {
  it("eno_sla_compliance's target is the ENO benchmark, not rabies/microchip/sterilization coverage", () => {
    const descriptor = KPI_CATALOG.eno_sla_compliance;
    expect(descriptor.target?.value).toBe(TARGETS.ENO_SLA_PCT);
    expect(descriptor.target?.value).not.toBe(TARGETS.RABIES_COVERAGE_PCT);
    expect(descriptor.target?.value).not.toBe(TARGETS.MICROCHIP_PENETRATION_PCT);
    expect(descriptor.target?.value).not.toBe(TARGETS.STERILIZATION_COVERAGE_PCT);
  });

  it("queue_oldest_pending_days (rendered alongside it on /gob/programa and /gob/sistema) never paints a target-derived tone — it has no target at all", () => {
    const descriptor = KPI_CATALOG.queue_oldest_pending_days;
    expect(descriptor.target).toBeUndefined();
    expect(descriptor.semaphore?.paintAgainst).toBe("none");
  });
});

describe("hostile reader — mortalidad: una muerte notificable nunca se enmascara como 'muestra chica'", () => {
  it("mortality_reportable_share deliberately carries NO smallN guard — a compliance-actionable fact must survive tiny N", () => {
    expect(KPI_CATALOG.mortality_reportable_share.guards?.smallN).toBeUndefined();
    expect(KPI_CATALOG.mortality_reportable_share.guards?.zeroDenominator).toBe("dash");
  });

  it("OpKpi: a warn tone on a 1-of-1 reportable death is NOT downgraded to neutral by the guard engine", () => {
    // Contrast with mortality_unknown_disposal_rate, which DOES gate smallN —
    // reportable_share's absence of that guard is the deliberate difference.
    const guarded = guardRatioTone(KPI_CATALOG.mortality_reportable_share, {
      n: 1,
      computedTone: "warn",
      formattedValue: "100,0%",
    });
    expect(guarded.tone).toBe("warn");
    expect(guarded.note).toBeUndefined();
    expect(smallNGate(KPI_CATALOG.mortality_unknown_disposal_rate, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. C6b — THE BRIEFING never alerts from unmeasurable data (dim-interno:docs/reviews/
// results/2026-07-22-plan-maestro-integridad.md §C6). A confident-sounding
// "priority" surfaced from a 0/0 ratio or a handful of cases would be the
// SAME dishonesty class C1 killed at the tile level, one layer up — the
// briefing's own hero block must inherit the exact same guards.
// ---------------------------------------------------------------------------

describe("hostile reader — la briefing nunca alerta desde datos no medibles (smallN / zero-denominator)", () => {
  it("a zero-denominator reading never produces an alert, even though the gap would look total", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 0, n: 0 },
    ];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });

  it("a small-N reading never produces an alert, even though the gap looks large", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 10, n: 2 },
    ];
    expect(buildBriefingAlerts(candidates)).toEqual([]);
  });

  it("a real, adequately-sampled gap DOES alert — the guard excludes unmeasurable data, not real misses", () => {
    const candidates: BriefingAlertCandidate[] = [
      { kpiId: "mortality_disposal_traceability", value: 33, n: 12 },
    ];
    const alerts = buildBriefingAlerts(candidates);
    expect(alerts).toHaveLength(1);
    // Rounding-drift fix (qa-triage-2026-07-23 finding #6): routes through the
    // same 1-decimal formatPercent every KPI tile uses.
    expect(alerts[0].title).toContain("33,0%");
  });
});

describe("hostile reader — vigilancia: casos de observación (cases) nunca se confunden con observaciones (pets)", () => {
  it("rabies_observation_cases_open and open_rabies_observations read distinct tables and are never additive", () => {
    const cases = KPI_CATALOG.rabies_observation_cases_open;
    const pets = KPI_CATALOG.open_rabies_observations;
    expect(cases.label).not.toBe(pets.label);
    expect(cases.fetcherName).not.toBe(pets.fetcherName);
    // The invariant is that the case-side exclusions SHOUT BOTH units and
    // contrast them — that is what stops a hostile reader adding the two rabies
    // figures together. This used to match the literal word "CASOS"; the
    // catalog now says "EXPEDIENTES" (the same word the tile's caveat uses,
    // and the one that names a file rather than a row). Assert the two units
    // are both present rather than one spelling of one of them.
    expect(cases.exclusions ?? "").toMatch(/EXPEDIENTES/);
    expect(cases.exclusions ?? "").toMatch(/MASCOTAS/);
    expect(cases.exclusions ?? "").toMatch(/tablas distintas/);
  });
});

// ---------------------------------------------------------------------------
// 11. FORECAST-A-META (2026-07-22) — a forecast line is a PROPERTY of a
// metric's own tile (no new screen), but it must never manufacture false
// confidence: no line from thin data, no line on a met goal, a receding
// trend must never read as progress, and every ETA is explicitly approximate.
// ---------------------------------------------------------------------------

describe("hostile reader — el forecast nunca renderiza desde <3 puntos", () => {
  it("the engine itself abstains (insufficient, null line) below MIN_TREND_POINTS", () => {
    const result = forecastToTarget({
      current: 30,
      target: 80,
      trend: [
        { period: "ene 2026", value: 20 },
        { period: "feb 2026", value: 30 },
      ],
    });
    expect(result.kind).toBe("insufficient");
    expect(result.line).toBeNull();
  });

  it("OpKpi renders no forecast line at all when the engine abstains", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.acquisition_adoption_rate.label}
        value="30%"
        descriptorId="acquisition_adoption_rate"
        forecast={
          forecastToTarget({
            current: 30,
            target: 80,
            trend: [{ period: "ene 2026", value: 30 }],
          }).line
        }
      />,
    );
    expect(screen.queryByText(/a este ritmo/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no se alcanza/)).not.toBeInTheDocument();
  });
});

describe("hostile reader — el forecast nunca renderiza sobre una meta ya cumplida", () => {
  it("a met target reports 'met' with a null line, never an ETA", () => {
    const result = forecastToTarget({
      current: 85,
      target: TARGETS.ADOPTION_RATE_PCT,
      trend: [
        { period: "ene 2026", value: 60 },
        { period: "feb 2026", value: 72 },
        { period: "mar 2026", value: 85 },
      ],
    });
    expect(result.kind).toBe("met");
    expect(result.line).toBeNull();
  });

  it("OpKpi shows no forecast line for a tile already at/above its target", () => {
    render(
      <OpKpi
        label={KPI_CATALOG.acquisition_adoption_rate.label}
        value="85%"
        descriptorId="acquisition_adoption_rate"
        forecast={
          forecastToTarget({
            current: 85,
            target: TARGETS.ADOPTION_RATE_PCT,
            trend: [
              { period: "ene 2026", value: 60 },
              { period: "feb 2026", value: 72 },
              { period: "mar 2026", value: 85 },
            ],
          }).line
        }
      />,
    );
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.queryByText(/a este ritmo/)).not.toBeInTheDocument();
  });
});

describe("hostile reader — 'retroceso' nunca se lee como progreso", () => {
  it("a trend moving away from the target reports 'receding', never a 'months' ETA", () => {
    const result = forecastToTarget({
      current: 10,
      target: 80,
      trend: [
        { period: "ene 2026", value: 18 },
        { period: "feb 2026", value: 14 },
        { period: "mar 2026", value: 10 },
      ],
    });
    expect(result.kind).toBe("receding");
    // The line names the direction honestly — no "meta en ~N meses" framing,
    // no digit that could be misread as an ETA.
    expect(result.line).toBe("→ tendencia en retroceso");
    expect(result.line).not.toMatch(/\d/);
  });

  it("OpKpi renders the receding line as plain muted text, never inside an 'ok'/progress-tone tile", () => {
    const result = forecastToTarget({
      current: 10,
      target: 80,
      trend: [
        { period: "ene 2026", value: 18 },
        { period: "feb 2026", value: 14 },
        { period: "mar 2026", value: 10 },
      ],
    });
    render(
      <OpKpi
        label={KPI_CATALOG.acquisition_adoption_rate.label}
        value="10%"
        tone="danger"
        descriptorId="acquisition_adoption_rate"
        forecast={result.line}
      />,
    );
    expect(screen.getByText("→ tendencia en retroceso")).toBeInTheDocument();
    const card = screen.getByText("10%").closest("div.flex.flex-col");
    expect(card?.className).not.toContain("st-ok-bg");
  });
});

describe("hostile reader — los meses de un forecast siempre son aproximados (~), nunca precisión falsa", () => {
  it("a 'months' result is always a rounded integer, and its line is always prefixed '~'", () => {
    const result = forecastToTarget({
      current: 13,
      target: 80,
      trend: [
        { period: "ene 2026", value: 9 },
        { period: "feb 2026", value: 11 },
        { period: "mar 2026", value: 13 },
      ],
    });
    expect(result.kind).toBe("months");
    if (result.kind === "months") {
      expect(Number.isInteger(result.months)).toBe(true);
      expect(result.line).toContain("~");
      // Never false precision like "~33.5 meses".
      expect(result.line).not.toMatch(/~\d+\.\d/);
    }
  });

  it("OpKpi renders the '~N meses' line verbatim, never a bare number reading like a promise", () => {
    const result = forecastToTarget({
      current: 13,
      target: 80,
      trend: [
        { period: "ene 2026", value: 9 },
        { period: "feb 2026", value: 11 },
        { period: "mar 2026", value: 13 },
      ],
    });
    render(
      <OpKpi
        label={KPI_CATALOG.acquisition_adoption_rate.label}
        value="13%"
        descriptorId="acquisition_adoption_rate"
        forecast={result.line}
      />,
    );
    expect(screen.getByText(/→ a este ritmo: meta en ~\d+ meses/)).toBeInTheDocument();
  });
});
