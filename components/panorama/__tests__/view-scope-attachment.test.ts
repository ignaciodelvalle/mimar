// V2 — the ATTACHMENT proof: the serializable scope actually survives each of
// the three artifacts this product exports today.
//
// lib/ui/view-scope-descriptor.test.ts proves the descriptor is reproducible in
// the abstract. This file proves it TRAVELS: a CSV, a briefing and a PNG footer
// cut from one board each carry the scope in the form that artifact can hold,
// and the two that claim reproducibility can actually be read back.
//
// The three carriers are deliberately UNEQUAL, and the asymmetry is asserted
// here so nobody "fixes" it by accident:
//   CSV     → the full descriptor, in a `#` header block (a file is regenerated).
//   informe → the full descriptor, printed (a page must stand alone on paper).
//   PNG     → the DIGEST only (a 34px footer strip holds a handle, not a payload).

import { describe, expect, it } from "vitest";

import { buildMapTableCsv } from "@/components/panorama/map-table-csv";
import { buildExportFooter } from "@/components/panorama/panorama-export";
import { buildInformeModel } from "@/components/panorama/panorama-informe";
import {
  makeViewScopeDescriptor,
  parseViewScopeFromCsv,
  serializeViewScope,
  toPanoramaViewState,
  viewScopeDigest,
} from "@/lib/ui/view-scope-descriptor";
import { makeViewState } from "@/src/modules/panorama/domain/view-state";
import { explainViewState } from "@/src/modules/panorama/domain/view-state-caption";

// The C3 case: a whole-province CABA mandate drilled to ONE barrio. Same
// jurisdiction count as the mandate, strictly finer grain.
const CABA = "Ciudad Autónoma de Buenos Aires";

const SOURCE_VIEW = makeViewState({
  scope: { kind: "locality", province: CABA, locality: "Palermo" },
  period: { kind: "preset", preset: "90d" },
  asOf: "2026-05-01T00:00:00.000Z",
  basis: "valid",
  layers: ["denuncias"],
  verifiedOnly: true,
  preset: "bienestar",
  encoding: null,
});

const DESCRIPTOR = makeViewScopeDescriptor({
  authority: {
    role: "govt",
    mandate: [{ province: CABA, locality: "" }],
    effective: [{ province: CABA, locality: "Palermo" }],
    adminDrill: null,
  },
  view: SOURCE_VIEW,
  grain: "locality",
  generatedAt: "2026-07-26T12:00:00.000Z",
});

describe("V2 attachment · CSV", () => {
  const csv = buildMapTableCsv(
    [{ layer: "Denuncias", unit: "Palermo", value: "12" }],
    [],
    DESCRIPTOR,
  );

  it("regenerates the exact source view from the exported file alone", () => {
    const recovered = parseViewScopeFromCsv(csv);
    expect(recovered).not.toBeNull();
    // The whole point: bytes off disk → the same view that produced them.
    expect(explainViewState(toPanoramaViewState(recovered!))).toBe(explainViewState(SOURCE_VIEW));
    expect(serializeViewScope(recovered!)).toBe(serializeViewScope(DESCRIPTOR));
  });

  it("keeps the data rows unchanged and the scope block above the header", () => {
    const lines = csv.split("\r\n");
    const headerAt = lines.indexOf("Capa,Unidad,Valor,Brecha vs meta");
    expect(headerAt).toBeGreaterThan(0);
    // Every line before the column header is a comment — a spreadsheet reads
    // them as text, and a truncated read still carries the provenance.
    expect(lines.slice(0, headerAt).every((l) => l.startsWith("#"))).toBe(true);
    expect(lines[headerAt + 1]).toBe("Denuncias,Palermo,12,");
  });

  it("leaves a pre-V2 export byte-identical when no scope is supplied", () => {
    const rows = [{ layer: "Denuncias", unit: "Palermo", value: "12" }];
    expect(buildMapTableCsv(rows)).toBe(buildMapTableCsv(rows, [], null));
    expect(buildMapTableCsv(rows).startsWith("Capa,")).toBe(true);
  });
});

describe("V2 attachment · informe", () => {
  const base = {
    scopeLabel: "Palermo · CABA",
    periodLabel: "últimos 90 días",
    asOf: new Date("2026-05-01T00:00:00.000Z"),
    generatedAt: new Date("2026-07-26T12:00:00.000Z"),
    isDemo: false,
    viewSummary: explainViewState(SOURCE_VIEW),
    kpis: [],
    kpisDegraded: false,
    ranking: null,
    caption: null,
    activeLayerLabels: ["Denuncias"],
    suppressedTotal: 0,
  };

  it("prints the full descriptor plus the C3 wording of who is asking", () => {
    const model = buildInformeModel({ ...base, viewScope: DESCRIPTOR });
    expect(model.scopeDescriptor).not.toBeNull();
    // The mandate is CABA (a whole-province assignment reads as the bare
    // province) and the narrowing to one barrio is disclosed separately — a
    // length check would have called this "not narrowed".
    expect(model.scopeDescriptor?.mandate).toBe(CABA);
    expect(model.scopeDescriptor?.narrowed).toBe(`Palermo, ${CABA}`);
    expect(model.scopeDescriptor?.viewId).toBe(viewScopeDigest(DESCRIPTOR));
    // The printed payload is the whole thing, not a summary of it.
    expect(model.scopeDescriptor?.json).toBe(serializeViewScope(DESCRIPTOR));
  });

  it("stays a pre-V2 briefing when no scope is supplied", () => {
    expect(buildInformeModel(base).scopeDescriptor).toBeNull();
  });
});

describe("V2 attachment · PNG footer", () => {
  const meta = {
    asOf: new Date("2026-05-01T00:00:00.000Z"),
    scopeLabel: "Palermo · CABA",
    periodLabel: "últimos 90 días",
    suppressedCount: 3,
  };

  it("carries the view digest so the image can be tied to the descriptor", () => {
    const footer = buildExportFooter({ ...meta, viewScope: DESCRIPTOR });
    expect(footer.endsWith(`vista ${viewScopeDigest(DESCRIPTOR)}`)).toBe(true);
    // The human provenance keeps the FRONT of the strip — the digest is a
    // machine handle and must never displace a word an operator reads. Asserted
    // by position, not by exact date: `formatAsOfDate` renders in the runner's
    // local timezone, and pinning "1 may 2026" here would make this test a
    // report about where CI runs rather than about the footer's ordering.
    expect(footer.startsWith("Datos al ")).toBe(true);
    const digestAt = footer.indexOf("vista ");
    for (const human of ["miMAR", "Palermo · CABA", "últimos 90 días", "3 celdas protegidas"]) {
      expect(footer.indexOf(human), `${human} must precede the digest`).toBeLessThan(digestAt);
    }
  });

  it("ties three artifacts of ONE board together by that digest", () => {
    const png = buildExportFooter({ ...meta, viewScope: DESCRIPTOR });
    const csv = buildMapTableCsv([], [], DESCRIPTOR);
    const informe = buildInformeModel({
      scopeLabel: "Palermo · CABA",
      periodLabel: "últimos 90 días",
      asOf: meta.asOf,
      generatedAt: new Date("2026-07-26T18:00:00.000Z"), // hours later
      isDemo: false,
      viewSummary: "",
      kpis: [],
      kpisDegraded: false,
      ranking: null,
      caption: null,
      activeLayerLabels: [],
      suppressedTotal: 0,
      viewScope: DESCRIPTOR,
    });

    const id = informe.scopeDescriptor?.viewId ?? "";
    expect(id).not.toBe("");
    expect(png).toContain(id);
    expect(csv).toContain(id);
    // …and the digest is the VIEW's, not the artifact's: the informe was cut six
    // hours after the PNG and still matches.
    expect(parseViewScopeFromCsv(csv)?.generatedAt).toBe("2026-07-26T12:00:00.000Z");
  });

  it("leaves the footer unchanged when no scope is supplied", () => {
    expect(buildExportFooter(meta)).not.toContain("vista ");
  });
});
