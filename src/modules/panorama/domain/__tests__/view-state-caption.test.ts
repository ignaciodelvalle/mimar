// "Explain this view" — proof the ViewState value is complete (task #50 P5).

import { describe, expect, it } from "vitest";

import { DEFAULT_VIEW_STATE, makeViewState } from "@/src/modules/panorama/domain/view-state";
import { explainViewState } from "@/src/modules/panorama/domain/view-state-caption";

describe("explainViewState", () => {
  it("describes a bare national default view", () => {
    expect(explainViewState(DEFAULT_VIEW_STATE)).toBe(
      "Vista personalizada — Argentina (todas las provincias), últimos 3 años.",
    );
  });

  it("names the preset and lists the active layers", () => {
    const v = makeViewState({
      preset: "brotes-activos",
      layers: ["cobertura", "zoonosis"],
      period: { kind: "preset", preset: "90d" },
    });
    expect(explainViewState(v)).toBe(
      "Señales de brote — Argentina (todas las provincias), últimos 90 días. Capas: Cobertura antirrábica (perros, 12m), Zoonosis / señales.",
    );
  });

  // QA ronda 5 (Cowork, 2026-07-16), filed CRÍTICO. The footer read "CABA ·
  // últimos 3 años (1095 días)" over "Cobertura antirrábica (perros, 12m) ·
  // ESTADO ACTUAL". The picker said 3 años, the number was a snapshot, and the
  // caption sided with the picker — by documented choice (embed-view.ts). It now
  // sides with the data: a view whose layers ALL ignore the period must not
  // declare one.
  it("says estado actual when every active layer is a current-state snapshot", () => {
    const v = makeViewState({
      layers: ["cobertura"],
      period: { kind: "preset", preset: "3y" },
    });
    expect(explainViewState(v)).toBe(
      "Vista personalizada — Argentina (todas las provincias), estado actual. Capas: Cobertura antirrábica (perros, 12m).",
    );
  });

  it("still says estado actual for several current-state layers", () => {
    const v = makeViewState({
      layers: ["cobertura", "esterilizacion"],
      period: { kind: "preset", preset: "90d" },
    });
    expect(explainViewState(v)).toContain("estado actual");
    expect(explainViewState(v)).not.toContain("últimos 90 días");
  });

  // A mixed view keeps the period: it is true of the event-windowed layer, and
  // hiding it would misdescribe a filter that IS doing something.
  it("keeps the period when the view mixes current-state and event-windowed layers", () => {
    const v = makeViewState({
      layers: ["cobertura", "zoonosis"],
      period: { kind: "preset", preset: "90d" },
    });
    expect(explainViewState(v)).toContain("últimos 90 días");
    expect(explainViewState(v)).not.toContain("estado actual");
  });

  // Nothing on screen for a period to misdescribe — leave the phrase alone.
  it("keeps the period for a view with no active layers", () => {
    expect(explainViewState(DEFAULT_VIEW_STATE)).toContain("últimos 3 años");
  });

  it("uses the display-name resolvers for a locality scope", () => {
    const v = makeViewState({
      scope: { kind: "locality", province: "AR-C", locality: "palermo" },
      preset: "bienestar",
      layers: ["denuncias"],
    });
    const names = {
      provinceLabel: (code: string) => (code === "AR-C" ? "CABA" : undefined),
      localityLabel: (_p: string, l: string) => (l === "palermo" ? "Palermo" : undefined),
    };
    expect(explainViewState(v, names)).toBe(
      "Bienestar y fiscalización — Palermo, CABA, últimos 3 años. Capas: Denuncias de bienestar.",
    );
  });

  it("describes a scrub cut with its bitemporal basis", () => {
    const v = makeViewState({
      preset: "sintomas",
      layers: ["sintomas", "zoonosis"],
      asOf: "2026-05-01T00:00:00.000Z",
      basis: "transaction",
    });
    expect(explainViewState(v)).toContain("al 1 de mayo de 2026 (tiempo de transacción)");
  });

  it("defaults the scrub basis phrase to 'validez'", () => {
    const v = makeViewState({ asOf: "2026-05-01T00:00:00.000Z", basis: "valid" });
    expect(explainViewState(v)).toContain("(tiempo de validez)");
  });

  // FLIPPED (review 2026-08-22, M7). This used to pass `verifiedOnly: true` with
  // NO layers at all and assert the phrase appears — pinning the defect: the
  // declaration was unconditional. It now carries the one layer that actually
  // honours the toggle.
  it("surfaces the verified-only filter when a layer honours it", () => {
    const v = makeViewState({ verifiedOnly: true, layers: ["cobertura"] });
    expect(explainViewState(v)).toContain("solo con firma veterinaria");
  });

  // -------------------------------------------------------------------------
  // The toggle is sticky; the declaration must not be (M7)
  // -------------------------------------------------------------------------
  //
  // "Solo firmado por matrícula" narrows ONLY the cobertura numerator — a scope
  // documented on purpose in four places, and the console does not even send the
  // parameter for other layers. What was NOT deliberate: the toggle survives a
  // base-layer change (it stays in the URL and nothing clears it) while this
  // caption declares it unconditionally. That caption is the shared link's
  // summary, the embed label and the printed "Informe de situación" — so a
  // ministerial artefact declared a filter that no number in it respected, and
  // the reader downstream had no way to know.
  //
  // The fix is NOT to wire the toggle into the territorial index: a composite
  // whose rabies arm counts vet-signed doses while its other arms count all of
  // them is a number with no definition. The fix is to stop declaring a filter
  // nothing on screen applied.

  it("does NOT declare the verified filter when no active layer honours it", () => {
    const v = makeViewState({ verifiedOnly: true, layers: ["indice-territorial"] });
    expect(explainViewState(v)).not.toContain("solo con firma veterinaria");
  });

  it("does NOT declare the verified filter when there are no active layers", () => {
    const v = makeViewState({ verifiedOnly: true, layers: [] });
    expect(explainViewState(v)).not.toContain("solo con firma veterinaria");
  });

  it("declares it when cobertura is active alongside layers that ignore it", () => {
    const v = makeViewState({ verifiedOnly: true, layers: ["cobertura", "zoonosis"] });
    expect(explainViewState(v)).toContain("solo con firma veterinaria");
  });

  it("describes a custom period range in es-AR", () => {
    const v = makeViewState({
      period: { kind: "custom", from: "2026-01-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" },
    });
    expect(explainViewState(v)).toContain("del 1 de enero de 2026 al 31 de marzo de 2026");
  });

  it("names the bounded operator's jurisdiction instead of the nation (Finding #1)", () => {
    // A govt operator carries a `national` ViewState scope (no explicit drill) but
    // their data is scoped — the footer must NOT say "todas las provincias".
    const v = makeViewState({ layers: ["perdidas"] });
    expect(
      explainViewState(v, { boundedScopeLabel: "Tierra del Fuego, Santa Cruz, CABA" }),
    ).toContain("Tierra del Fuego, Santa Cruz, CABA");
    expect(
      explainViewState(v, { boundedScopeLabel: "Tierra del Fuego, Santa Cruz, CABA" }),
    ).not.toContain("todas las provincias");
  });

  it("qualifies the national phrase with the department grain the map shows (Finding #1)", () => {
    // Admin at national scope but the map auto-disaggregated to department grain —
    // the footer must reflect the grain, not imply province-level coverage.
    const v = makeViewState({ layers: ["perdidas"] });
    expect(explainViewState(v, { renderLevel: "locality" })).toContain(
      "Argentina · nivel departamento",
    );
    // Province grain keeps the full-coverage phrase (honest there).
    expect(explainViewState(v, { renderLevel: "province" })).toContain(
      "Argentina (todas las provincias)",
    );
  });

  it("boundedScopeLabel wins over the renderLevel qualifier", () => {
    const v = makeViewState({ layers: ["perdidas"] });
    expect(explainViewState(v, { boundedScopeLabel: "Salta", renderLevel: "locality" })).toContain(
      "Salta",
    );
  });

  it("skips unknown layer ids without throwing", () => {
    const v = makeViewState({ layers: ["cobertura"] });
    // A well-formed value only ever holds valid ids (the URL boundary filters),
    // but the caption must be defensive regardless.
    expect(explainViewState(v)).toContain("Capas: Cobertura antirrábica (perros, 12m).");
  });
});
