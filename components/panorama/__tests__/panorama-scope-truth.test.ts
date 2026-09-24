// One scope label, four artifacts.
//
// QA 2026-08-01 (government sanitary-authority walkthrough): an operator whose
// real reach was "CABA · 5 localidades" saw the Registros table title itself
// "Datos del mapa por unidad — Nacional, últimos 90 días.". The caption read
// `buildViewMeta`'s scope label, which answers "is the VIEW filtered?" and not
// "what may this OPERATOR see?" — with no drill it says "Nacional" for everyone.
//
// The masthead pill beside it was already honest, because it resolved through
// `liveScopeLabel || viewMeta.scopeLabel`. That cascade was the fix AND the
// hazard: it was hand-copied at each consumer, so a consumer that forgot it lied
// in silence. The console now resolves ONCE, into `viewMeta.scopeLabel`, and
// every artifact cites that.
//
// This file pins both halves: the derivation itself, and the fact that no
// consumer re-derives it.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildExportFooter } from "@/components/panorama/panorama-export";
import { buildInformeModel } from "@/components/panorama/panorama-informe";
import {
  buildMapTableCaption,
  deriveLiveScopeLabel,
  resolveScopeLabel,
} from "@/components/panorama/scope-truth";
import { panoramaScopeLabel } from "@/lib/panorama/scope-label";
import { stripComments } from "@/scripts/check-scope-discipline";

const CABA_LOCALITIES = [
  { slug: "palermo", name: "Palermo" },
  { slug: "recoleta", name: "Recoleta" },
  { slug: "caballito", name: "Caballito" },
  { slug: "flores", name: "Flores" },
  { slug: "boedo", name: "Boedo" },
];

/** The QA account: five CABA barrios, nothing else. */
const BOUNDED_LABEL = panoramaScopeLabel(
  "govt",
  CABA_LOCALITIES.map((l) => ({ province: "CABA", locality: l.name })),
);
/** The admin account: universal scope. "Nacional" here is the TRUE answer. */
const ADMIN_LABEL = panoramaScopeLabel("admin", []);

function live(over: Partial<Parameters<typeof deriveLiveScopeLabel>[0]> = {}): string {
  return deriveLiveScopeLabel({
    province: null,
    locality: null,
    serverScopeLabel: BOUNDED_LABEL,
    allowedProvinces: [{ code: "AR-C", name: "CABA" }],
    localities: CABA_LOCALITIES,
    ...over,
  });
}

describe("deriveLiveScopeLabel — the operator's reach, then the drill", () => {
  it("falls back to the server label when nothing is drilled", () => {
    expect(live()).toBe("CABA · 5 localidades");
    expect(BOUNDED_LABEL).not.toContain("Nacional");
  });

  it("names the drilled province", () => {
    expect(live({ province: "AR-C" })).toBe("CABA");
  });

  it("names province · locality on a locality drill", () => {
    expect(live({ province: "AR-C", locality: "palermo" })).toBe("CABA · Palermo");
  });

  it("resolves an out-of-scope province through the full reference table, never as a raw code", () => {
    // A govt-local operator forcing ?province=AR-V is outside allowedProvinces;
    // provinceByCode still yields a real name (display-only — the data fence is
    // elsewhere and unaffected).
    expect(live({ province: "AR-V" })).toBe("Tierra del Fuego");
  });

  // Mutation-testing find (2026-08-01): weakening the guard to `if (!province)`
  // survived the whole suite, and the branch is NOT dead. A bounded govt
  // operator's province is IMPLICIT — the page passes `initialDivisionProvince`,
  // and PanoramaConsole keeps `effectiveScopeLocality` alive on that alone — so
  // "locality set, province null" is exactly the state the CABA operator in this
  // bug report reaches by drilling. Without the guard the label would silently
  // fall back to the whole jurisdiction while the map shows one barrio.
  it("names a locality whose province is implicit, instead of falling back to the jurisdiction", () => {
    expect(live({ province: null, locality: "palermo" })).toBe("Palermo");
  });

  it("returns the empty signal when there is no drill AND no server label", () => {
    // Embedded consoles render no masthead, so they pass no scope label. "" is
    // what tells resolveScopeLabel to fall through to the view-derived label.
    expect(live({ serverScopeLabel: undefined })).toBe("");
  });
});

describe("resolveScopeLabel — the cascade, in one place", () => {
  it("prefers the operator-aware label over the view-derived one", () => {
    expect(resolveScopeLabel(BOUNDED_LABEL, "Nacional")).toBe("CABA · 5 localidades");
  });

  it("keeps the view label only when there is no live label at all", () => {
    expect(resolveScopeLabel("", "Nacional")).toBe("Nacional");
  });

  it("does not treat an admin's honest 'Nacional' as a fallback to override", () => {
    expect(resolveScopeLabel(ADMIN_LABEL, "Provincia seleccionada")).toBe(
      "Nacional · todas las provincias",
    );
  });
});

// The three artifacts that LEAVE the screen. A caption a decisor disbelieves
// costs the board; a PNG in a slide deck or a printed informe carries the wrong
// scope into a room where nobody can correct it.
describe("every artifact states the resolved scope, not the view-derived one", () => {
  const scope = resolveScopeLabel(live(), "Nacional");

  it("caption", () => {
    expect(buildMapTableCaption(scope, "últimos 90 días")).toBe(
      "Datos del mapa por unidad — CABA · 5 localidades, últimos 90 días.",
    );
  });

  it("PNG footer", () => {
    const footer = buildExportFooter({
      asOf: new Date("2026-07-04T00:00:00Z"),
      scopeLabel: scope,
      periodLabel: "últimos 90 días",
      suppressedCount: 0,
    });
    expect(footer).toContain("CABA · 5 localidades");
    expect(footer).not.toContain("Nacional");
  });

  it("printed informe", () => {
    const model = buildInformeModel({
      scopeLabel: scope,
      periodLabel: "últimos 90 días",
      asOf: null,
      generatedAt: null,
      isDemo: false,
      viewSummary: "Vista personalizada.",
      kpis: [],
      kpisDegraded: false,
      ranking: null,
      caption: null,
      activeLayerLabels: [],
      suppressedTotal: 0,
    });
    expect(model.scopeLabel).toBe("CABA · 5 localidades");
    expect(model.title).toBe("Informe de situación · CABA · 5 localidades");
  });
});

// The structural half. The unit tests above prove the helper is right; this
// proves the console USES it — the original bug was a correct helper sitting
// next to a consumer that never called it.
describe("PanoramaConsole resolves the scope label exactly once", () => {
  const src = stripComments(readFileSync("components/panorama/PanoramaConsole.tsx", "utf8"));

  it("folds the cascade into viewMeta, so viewMeta.scopeLabel is already resolved", () => {
    expect(src).toContain("scopeLabel: resolveScopeLabel(liveScopeLabel, view.scopeLabel)");
  });

  it("leaves no hand-written cascade for a consumer to copy or forget", () => {
    expect(src).not.toContain("liveScopeLabel || viewMeta.scopeLabel");
  });

  it("composes the Registros caption through the helper, not a local template", () => {
    expect(src).toContain("buildMapTableCaption(viewMeta.scopeLabel, viewMeta.periodLabel)");
    expect(src).not.toContain("`Datos del mapa por unidad —");
  });

  it("hands the map the resolved viewMeta, so the exported PNG footer inherits it", () => {
    expect(src).toContain("viewMeta={viewMeta}");
  });
});
