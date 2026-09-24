/**
 * P2-2 — a FILTERED empty is the one empty that must never be hidden, so it
 * gets the MINIMUM instead: the way out.
 *
 * PO principle P2 says don't render the structure of something empty — hide it,
 * or show the minimum. Applying "hide" to a filter-caused empty would invent the
 * exact misreading P2 exists to prevent: the operator applied a filter, the list
 * went silent, and a hidden list reads as "there is nothing in the system"
 * rather than "your filter matched nothing". So these three surfaces keep their
 * structure and gain a link that undoes the filter — the same shape commit
 * 8e963328 wired into seven high-traffic screens and 6fb4b4eb's tri-state
 * encodes for the ranking.
 *
 * Each of the three was an INCONSISTENCY, not an oversight in isolation — in
 * every case a sibling branch on the same screen (or its exact twin screen)
 * already shipped the affordance:
 *   - /admin/casos      — twin of /gob/casos, which passes `emptyAction`
 *   - /gob/reglas       — its own true-empty branch carries "+ Crear regla"
 *   - /admin/govts      — its own `hiddenTestCount` branch carries a toggle
 *
 * Source-level assertions on purpose: all three are async server components
 * behind auth guards (`requireAdminOrGovtOrRedirect` and friends), so rendering
 * them here would test the mock, not the screen. This file pins the one thing
 * that actually regressed — the affordance going missing — the same way
 * __tests__/citizen-cta-radius.test.ts pins a radius it cannot render.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

/** Collapse whitespace so a formatter reflow cannot break an assertion. */
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("/admin/casos — the filtered queue offers the way back", () => {
  const SRC = flat(read("app", "admin", "casos", "page.tsx"));

  it("passes emptyAction, like its /gob/casos twin", () => {
    expect(SRC).toContain("emptyAction=");
  });

  it("gates the affordance on the filters actually being active", () => {
    // An unfiltered empty queue is good news, not a dead end — "no hay casos
    // abiertos" must not sprout a "Limpiar filtros" link that clears nothing.
    expect(SRC).toMatch(/emptyAction=\{ hasActiveFilters \?/);
    expect(SRC).toMatch(/Limpiar filtros/);
  });

  it("the link lands on the unfiltered queue", () => {
    expect(SRC).toContain('href="/admin/casos"');
  });
});

describe("/gob/reglas — the kind-filtered empty offers the way back", () => {
  const SRC = flat(read("app", "gob", "reglas", "AdminReglasLens.tsx"));

  it("the filtered branch carries an action", () => {
    const filtered = SRC.slice(SRC.indexOf("Sin resultados para este filtro"));
    expect(filtered).toContain("action=");
    expect(filtered).toContain("Ver todos los tipos");
  });

  it("keeps the true-empty branch's own action — the two empties differ", () => {
    // "Ninguna jurisdicción tiene reglas personalizadas" is a real absence with
    // a real next step (create one); it must not be collapsed into the filtered
    // copy now that both branches have an action.
    expect(SRC).toContain("Ninguna jurisdicción tiene reglas personalizadas");
    expect(SRC).toContain("+ Crear regla");
  });
});

describe("/admin/govts — the searched empty offers the way back", () => {
  const SRC = flat(read("app", "admin", "govts", "GovtsScreen.tsx"));

  it("the query/status branch is no longer the only one without an affordance", () => {
    expect(SRC).toMatch(/\) : query \|\| status !== "all" \? \(/);
    expect(SRC).toContain("Limpiar filtros");
  });

  it("the link targets the hub, not the redirect that fronts it", () => {
    // /admin/govts is only a redirect into the Cuentas hub since the
    // privileged-accounts fusion, so the obvious href would have cost the
    // operator a hop. link-integrity.test.ts caught it; this keeps it caught
    // locally, next to the reason.
    expect(SRC).toContain('href="/admin/cuentas?registro=govts"');
    expect(SRC).not.toContain('href="/admin/govts"');
  });

  it("the sibling branches keep theirs", () => {
    expect(SRC).toContain("cuentas de prueba");
    expect(SRC).toContain("Crear el primer gobierno");
  });
});
