/**
 * No raw enum reaches the owner's case list.
 *
 * The owner's case history printed the database value straight onto the page:
 * the resolved-foster row read "Estado: accepted" and the decided-approval row
 * read "Resuelta: approved", inside an otherwise fully translated es-AR screen.
 * That is the raw-enum end of the `CaseStatus.open`-said-five-ways family the
 * 2026-08-01 review counted (it found the same leak on /gob and /org).
 *
 * Scope is deliberate. The review counted ~22 hand-rolled status dictionaries;
 * unifying all of them is its own refactor. This pins the vocabulary on the
 * owner's surfaces only — the ones on the demo walk — and gives the rest a
 * shared home (`requestOutcomeLabel`) to migrate to when someone does that
 * refactor.
 *
 * Source-scan for the call sites, because owner-dashboard.ts is DB-bound.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { requestOutcomeLabel } from "@/lib/utils/format";

const OWNER_DASHBOARD = readFileSync(
  join(process.cwd(), "lib", "analytics", "owner-dashboard.ts"),
  "utf8",
);

describe("requestOutcomeLabel", () => {
  it("names every status the owner's rows can actually carry", () => {
    // fosterProposals resolved set (owner-dashboard.ts fetchResolvedFosterProposals)
    expect(requestOutcomeLabel("accepted")).toBe("Aceptada");
    expect(requestOutcomeLabel("rejected")).toBe("Rechazada");
    expect(requestOutcomeLabel("cancelled")).toBe("Cancelada");
    expect(requestOutcomeLabel("expired")).toBe("Expirada");
    // approvalRequests check constraint: pending | approved | rejected | withdrawn
    expect(requestOutcomeLabel("approved")).toBe("Aceptada");
    expect(requestOutcomeLabel("withdrawn")).toBe("Cancelada");
    expect(requestOutcomeLabel("pending")).toBe("Pendiente");
  });

  it("uses the words the rest of the app already uses", () => {
    // Not new copy — these are the exact labels four other surfaces hand-roll
    // for the same enum. Inventing a fifth wording here would have ADDED to the
    // problem being fixed.
    const labels = ["accepted", "rejected", "cancelled", "expired"].map(requestOutcomeLabel);
    expect(labels).toEqual(["Aceptada", "Rechazada", "Cancelada", "Expirada"]);
  });

  it("returns null — never the raw value — for anything unmapped", () => {
    // This is the whole point. A `?? status` fallback would reintroduce the
    // exact leak on the first status nobody remembered to map.
    expect(requestOutcomeLabel("some_new_state")).toBeNull();
    expect(requestOutcomeLabel("")).toBeNull();
    expect(requestOutcomeLabel(null)).toBeNull();
    expect(requestOutcomeLabel(undefined)).toBeNull();
  });
});

describe("the owner's case rows no longer interpolate a status enum", () => {
  it("does not build a subtitle out of the raw status", () => {
    // Catches the literal regression AND any re-wording of it, e.g.
    // `Estado: ${r.status}` -> `Resultado: ${r.status}`.
    const leaks = [
      ...OWNER_DASHBOARD.matchAll(/subtitle:\s*`[^`]*\$\{[^}]*\bstatus\b[^}]*\}/g),
    ].map((m) => m[0]);
    expect(
      leaks,
      "a subtitle that interpolates a status field prints the database enum onto " +
        "the owner's screen — use requestOutcomeLabel()",
    ).toEqual([]);
  });

  it("routes both resolved-request rows through the shared label", () => {
    const uses = OWNER_DASHBOARD.match(/requestOutcomeLabel\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves the adoption row's own wording alone", () => {
    // That one was already translated, with copy specific to its domain
    // ("No avanzó" is not "Rechazada"). Flattening it into the shared label
    // would be a regression dressed as consistency.
    expect(OWNER_DASHBOARD).toContain('"No avanzó"');
  });
});
