// task #55 — pure builder tests for the "Informe de situación" model.
//
// Every assertion here guards an HONESTY or PARITY property of a govt
// decision-justification artifact: the "situación al" corte label never fakes a
// date at the live edge; the ranking heading + value/gap formatting mirror the
// on-screen RankedUnitsPanel; the k-anon disclosure + suppressed count are always
// present; and a degraded KPI fan-out REPLACES the numbers with an honest failure
// instead of reading as an all-clear.

import { describe, expect, it } from "vitest";

import {
  type BuildInformeInput,
  type InformeKpiInput,
  buildInformeModel,
  informeAsOfLabel,
} from "@/components/panorama/panorama-informe";
import { makeViewScopeDescriptor } from "@/lib/ui/view-scope-descriptor";
import { partitionKpiIdsByRelevance } from "@/src/modules/panorama/domain/metric-relevance";
import type { PanoramaKpiId } from "@/src/modules/panorama/domain/types";
import { makeViewState } from "@/src/modules/panorama/domain/view-state";

/** The informe KPI inputs carry `id: string`; the relevance gate keys on the
 *  PanoramaKpiId union. In the console the ids ARE PanoramaKpiIds (they come from
 *  the KPI payload); the test narrows the fixture ids the same way. */
function asRelevanceInput(
  kpis: readonly InformeKpiInput[],
): Array<InformeKpiInput & { id: PanoramaKpiId }> {
  return kpis as Array<InformeKpiInput & { id: PanoramaKpiId }>;
}

function baseInput(overrides: Partial<BuildInformeInput> = {}): BuildInformeInput {
  return {
    scopeLabel: "Nacional",
    periodLabel: "últimos 90 días",
    asOf: null,
    generatedAt: null,
    isDemo: false,
    viewSummary: "Vista personalizada — Argentina (todas las provincias), últimos 90 días.",
    kpis: [
      {
        id: "cobertura",
        label: "Cobertura antirrábica",
        value: "64%",
        sub: "meta 80%",
        currentState: true,
        delta: { label: "+3 pts vs período anterior" },
        info: {
          definition:
            "Porcentaje de perros del padrón con vacunación antirrábica. Segundo detalle irrelevante.",
        },
      },
      {
        id: "mordeduras",
        label: "Mordeduras / 10k hab.",
        value: "1,2",
        delta: { label: "+12% vs período anterior" },
        info: { definition: "Tasa de incidentes de mordedura por cada 10.000 habitantes." },
      },
    ],
    kpisDegraded: false,
    ranking: {
      rows: [
        { key: "AR-D", label: "San Luis", value: 41, gap: 39 },
        { key: "AR-G", label: "Tucumán", value: 55, gap: 25 },
      ],
      kind: "rate",
      measureLabel: "cobertura antirrábica",
      smallScope: false,
      unitNoun: "jurisdicciones",
      suppressedCount: 2,
      unavailable: false,
    },
    caption:
      "Cada área es una provincia. Relleno = cobertura antirrábica, estado actual. Meta 80%.",
    activeLayerLabels: ["Cobertura antirrábica", "Señales de zoonosis"],
    suppressedTotal: 3,
    ...overrides,
  };
}

describe("informeAsOfLabel", () => {
  it("names the corte date when a scrub is active (T2.4: shared long UTC day shape)", () => {
    expect(informeAsOfLabel(new Date("2026-07-04T12:00:00Z"))).toBe(
      "Situación al 4 de julio de 2026",
    );
  });

  it("never fakes a date at the live edge", () => {
    expect(informeAsOfLabel(null)).toBe("Datos en vivo (sin corte temporal)");
  });

  // L-7 — same precedence as buildExportFooter: scrub > cube stamp > live.
  it("states the cube stamp instead of 'en vivo' when cube-served", () => {
    const label = informeAsOfLabel(null, new Date("2026-07-04T04:30:00.000Z"));
    expect(label).toContain("Datos precalculados al");
    expect(label).toContain("(sin corte temporal)");
  });

  it("an unparseable cube stamp falls back to the live wording (review F5)", () => {
    expect(informeAsOfLabel(null, "garbage-not-a-date")).toBe("Datos en vivo (sin corte temporal)");
  });

  it("an explicit corte wins over the cube stamp", () => {
    expect(
      informeAsOfLabel(new Date("2026-07-04T12:00:00Z"), new Date("2026-07-01T04:30:00.000Z")),
    ).toBe("Situación al 4 de julio de 2026");
  });
});

describe("buildInformeModel", () => {
  it("titles the informe with the scope and threads the header labels", () => {
    const m = buildInformeModel(baseInput({ scopeLabel: "Córdoba" }));
    expect(m.title).toBe("Informe de situación · Córdoba");
    expect(m.periodLabel).toBe("últimos 90 días");
    expect(m.asOfLabel).toBe("Datos en vivo (sin corte temporal)");
    expect(m.generatedAtLabel).toBeNull();
  });

  it("stamps the generation time only when provided", () => {
    const m = buildInformeModel(baseInput({ generatedAt: new Date("2026-07-12T14:30:00") }));
    expect(m.generatedAtLabel).toContain("2026");
  });

  // REGRESSION (2026-08-04). The assertion above is `toContain("2026")`, which
  // is exactly why this shipped: the stamp rendered in the SERVER's timezone
  // (UTC on Vercel — three hours off on a document an official files) and as the
  // hybrid "05:39 p. m." clock, and "2026" was in it either way. A weak
  // assertion is how a defect reaches a printed government artifact.
  //
  // The instant is pinned with an explicit Z so the expectation does not depend
  // on the test runner's own timezone — the bug being guarded is precisely that
  // the formatter inherited an ambient zone.
  it("stamps in Argentina time on a 24-hour clock, whatever the server's zone", () => {
    const m = buildInformeModel(
      // 14:30 UTC is 11:30 in Argentina (UTC-3, no DST).
      baseInput({ generatedAt: new Date("2026-07-12T14:30:00Z") }),
    );
    expect(m.generatedAtLabel).toBe("12/07/2026, 11:30");
    expect(m.generatedAtLabel).not.toMatch(/[ap]\.?\s?m\.?/i);
  });

  it("tags stock KPIs as 'estado actual' and passes deltas through", () => {
    const m = buildInformeModel(baseInput());
    const cobertura = m.kpis.find((k) => k.id === "cobertura");
    const mordeduras = m.kpis.find((k) => k.id === "mordeduras");
    expect(cobertura?.stateTag).toBe("estado actual");
    expect(cobertura?.deltaLabel).toBe("+3 pts vs período anterior");
    expect(mordeduras?.stateTag).toBeUndefined();
  });

  it("builds the 'Peores N · métrica' heading and formats rate value + gap", () => {
    const m = buildInformeModel(baseInput());
    expect(m.ranking?.heading).toBe("Peores 2 · cobertura antirrábica");
    expect(m.ranking?.columnLabel).toBe("cobertura antirrábica · pts vs objetivo");
    expect(m.ranking?.rows[0]).toMatchObject({
      rank: 1,
      label: "San Luis",
      value: "41%",
      gapText: "−39 pts vs objetivo",
    });
  });

  it("reframes the heading for a small scope", () => {
    const m = buildInformeModel(
      baseInput({
        ranking: {
          rows: [{ key: "AR-C-1", label: "Comuna 1", value: 12, gap: null }],
          kind: "density",
          measureLabel: "señales de zoonosis",
          smallScope: true,
          unitNoun: "comunas",
          suppressedCount: 0,
          unavailable: false,
        },
      }),
    );
    // T5.2: singular agreement at n=1 (the old shape read "Tus 1 comunas").
    expect(m.ranking?.heading).toBe("1 comuna · señales de zoonosis");
    expect(m.ranking?.rows[0].value).toBe("12");
    expect(m.ranking?.rows[0].gapText).toBeUndefined();
    expect(m.ranking?.suppressedNote).toBeUndefined();
  });

  it("always discloses the k-anon treatment and the scoped suppressed count", () => {
    const m = buildInformeModel(baseInput());
    expect(m.kAnonDisclosure).toContain("k-anonimato");
    expect(m.kAnonDisclosure).toContain("3 celdas ocultas");
    expect(m.ranking?.suppressedNote).toBe("2 unidades protegidas por privacidad (k-anonimato).");
  });

  it("keeps the k-anon base sentence even with zero suppression", () => {
    const m = buildInformeModel(baseInput({ suppressedTotal: 0 }));
    expect(m.kAnonDisclosure).toContain("k-anonimato");
    expect(m.kAnonDisclosure).not.toContain("celdas ocultas");
  });

  it("extracts the first-sentence method note per KPI (dashboard-parity wording)", () => {
    const m = buildInformeModel(baseInput());
    expect(m.methodNotes).toContain("Porcentaje de perros del padrón con vacunación antirrábica.");
    expect(m.methodNotes).toContain("Tasa de incidentes de mordedura por cada 10.000 habitantes.");
  });

  it("carries the demo banner copy so it is never dropped", () => {
    const m = buildInformeModel(baseInput({ isDemo: true }));
    expect(m.isDemo).toBe(true);
    expect(m.demoText).toContain("Datos de demostración");
    expect(m.demoText).toContain("sintético");
  });

  it("REPLACES the KPIs with an honest failure when the fan-out degraded", () => {
    const m = buildInformeModel(baseInput({ kpisDegraded: true }));
    expect(m.kpis).toHaveLength(0);
    expect(m.kpisDegradedText).toContain("No pudimos calcular");
  });

  it("shows an honest empty ranking instead of an all-clear when data is unavailable", () => {
    const m = buildInformeModel(
      baseInput({
        ranking: {
          rows: [],
          kind: "rate",
          measureLabel: "cobertura antirrábica",
          smallScope: false,
          unitNoun: "jurisdicciones",
          suppressedCount: 0,
          unavailable: true,
        },
      }),
    );
    expect(m.ranking?.emptyText).toBe("No pudimos calcular el ranking en este momento.");
  });
});

// "Citar esta vista" v1 — the frozen-citation provenance disclosure (2026-08-02
// determinism audit). Honest by DISCLOSURE, not by fake determinism: the
// paragraph exists ONLY under a pinned corte, names the two known survivors of
// an asOf pin (the «estado actual» stocks and the k<5 suppression), and never
// lets the view digest read as tamper evidence.
describe("citation provenance disclosure (Citar esta vista v1)", () => {
  const CORTE = new Date("2026-07-04T00:00:00.000Z");

  const DESCRIPTOR = makeViewScopeDescriptor({
    authority: {
      role: "govt",
      mandate: [{ province: "Córdoba", locality: "" }],
      effective: [{ province: "Córdoba", locality: "" }],
      adminDrill: null,
    },
    view: makeViewState({
      scope: { kind: "province", province: "Córdoba" },
      period: { kind: "preset", preset: "90d" },
      asOf: CORTE.toISOString(),
      basis: "valid",
      layers: ["denuncias"],
      verifiedOnly: false,
      preset: null,
      encoding: null,
    }),
    grain: "province",
    generatedAt: "2026-07-04T12:00:00.000Z",
  });

  it("is absent at the live edge — no corte, nothing claims to be frozen", () => {
    expect(buildInformeModel(baseInput({ asOf: null })).citationDisclosure).toBeNull();
  });

  it("states the replay corte and BOTH non-frozen survivors when a stock KPI is shown", () => {
    const d = buildInformeModel(baseInput({ asOf: CORTE })).citationDisclosure ?? "";
    expect(d).toContain("Esta cita reproduce el registro de eventos al 4 de julio de 2026.");
    // The stock clause names the tag printed next to the number (stateTag) and
    // the on-page "acumulado hoy" wording — the reader can find the figure.
    expect(d).toContain("«estado actual»");
    expect(d).toContain("«acumulado hoy»");
    expect(d).toContain("k<5");
    expect(d).toContain("evaluada en vivo; puede cambiar al reabrir");
  });

  it("names the stock survivor ONLY when a stock KPI is in the shown set", () => {
    const noStock = baseInput().kpis.map((k) => ({ ...k, currentState: false }));
    const d = buildInformeModel(baseInput({ asOf: CORTE, kpis: noStock })).citationDisclosure ?? "";
    expect(d).not.toContain("estado actual");
    expect(d).not.toContain("acumulado hoy");
    // The k<5 clause is unconditional — the suppression survives on every view.
    expect(d).toContain("k<5");
  });

  it("drops the stock clause when the KPI fan-out degraded (no numbers are shown)", () => {
    const d =
      buildInformeModel(baseInput({ asOf: CORTE, kpisDegraded: true })).citationDisclosure ?? "";
    expect(d).not.toContain("estado actual");
    expect(d).toContain("k<5");
  });

  it("adds the digest caveat ONLY when the descriptor block is printed, and keeps it honest", () => {
    const without = buildInformeModel(baseInput({ asOf: CORTE })).citationDisclosure ?? "";
    expect(without).not.toContain("id de vista");
    const withScope =
      buildInformeModel(baseInput({ asOf: CORTE, viewScope: DESCRIPTOR })).citationDisclosure ?? "";
    expect(withScope).toContain(
      "El id de vista identifica esta vista; no es evidencia de integridad.",
    );
  });
});

// Review finding 5 — the manual-mode relevance gate that the console applies to
// the Informe's KPI input (partitionKpiIdsByRelevance → relevant). This mirrors
// the exact composition PanoramaConsole.readingKpis performs before handing the
// list to buildInformeModel, so the printable report never headlines a metric
// whose subject layer is NOT on the map (the same "projection lie" C2a fixed for
// the KPI chips). Preset mode is immune (the curated metricIds are not re-filtered)
// and is exercised by not calling the partition.
describe("Informe manual-mode relevance gating (finding 5)", () => {
  it("drops a KPI whose subject layer is not active from the informe kpis + method notes", () => {
    // Manual mode with ONLY the mordeduras layer painted: the cobertura KPI does
    // not describe the map and must not reach the printable report.
    const { relevant } = partitionKpiIdsByRelevance(asRelevanceInput(baseInput().kpis), [
      "mordeduras",
    ]);
    const m = buildInformeModel(baseInput({ kpis: relevant }));

    const ids = m.kpis.map((k) => k.id);
    expect(ids).toContain("mordeduras");
    expect(ids).not.toContain("cobertura");
    // The method footnotes derive from the SAME shown KPIs — the cobertura note
    // must also be gone (no orphaned methodology for a hidden metric).
    expect(m.methodNotes.join(" ")).not.toContain("vacunación antirrábica");
    expect(m.methodNotes.join(" ")).toContain("mordedura");
  });

  it("keeps every KPI when both subject layers are active (nothing to gate)", () => {
    const { relevant } = partitionKpiIdsByRelevance(asRelevanceInput(baseInput().kpis), [
      "cobertura",
      "mordeduras",
    ]);
    const m = buildInformeModel(baseInput({ kpis: relevant }));
    expect(m.kpis.map((k) => k.id)).toEqual(["cobertura", "mordeduras"]);
  });
});
