// Badge-count derivation tests (staging validation 2026-07-04, bug 3).
//
// The conflation that shipped uncaught: "Por vencer" counted `dueSoon +
// missing`, so a freshly created pet with ZERO vaccine records showed
// "3 POR VENCER" (the 3 core catalog vaccines for a dog, never administered).
// These tests pin the honest rule: "por vencer" counts ONLY registered doses
// approaching next_due; zero records renders the empty state.

import { readFileSync } from "node:fs";
import type { VaccineSnapshot } from "@/lib/domain/libreta-health-status";
import { computeVaccinationSummary, hasAnyVaccineRecord } from "@/lib/domain/libreta-health-status";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  VacunasStatusBadges,
  deriveVacunasBadgeCounts,
  isSuggestedLapse,
  metaFor,
} from "./VacunasStatusBadges";

const NOW = new Date("2026-03-15T00:00:00Z");

function vaccineEvent(name: string, at: string, nextDue?: string) {
  return {
    eventType: "vaccination_administered",
    occurredAt: at,
    payload: { vaccine_name: name, ...(nextDue ? { next_due_at: nextDue } : {}) },
  };
}

describe("deriveVacunasBadgeCounts — zero-records case", () => {
  it("a fresh dog with no events shows NO fabricated 'por vencer' count", () => {
    const summary = computeVaccinationSummary([], "dog", NOW);
    const counts = deriveVacunasBadgeCounts(summary);
    expect(counts.hasRecords).toBe(false);
    expect(counts.porVencer).toBe(0);
    expect(counts.vigente).toBe(0);
    expect(counts.vencida).toBe(0);
    // The 2 dog calendar requirements (rabies + one polyvalent) surface as
    // "sin aplicar", never as "por vencer".
    expect(counts.sinAplicar).toBe(2);
  });
});

describe("deriveVacunasBadgeCounts — missing is never folded into 'por vencer'", () => {
  it("one active dose + missing cores → 1 vigente, 0 por vencer", () => {
    // One rabies dose due far in the future; other cores never administered.
    const summary = computeVaccinationSummary(
      [vaccineEvent("Antirrábica", "2026-03-01", "2027-03-01")],
      "dog",
      NOW,
    );
    const counts = deriveVacunasBadgeCounts(summary);
    expect(counts.hasRecords).toBe(true);
    expect(counts.vigente).toBe(1);
    expect(counts.porVencer).toBe(0);
    expect(counts.sinAplicar).toBe(summary.missing);
  });

  it("a registered dose approaching next_due IS 'por vencer'", () => {
    const summary = computeVaccinationSummary(
      [vaccineEvent("Antirrábica", "2025-04-01", "2026-04-01")],
      "dog",
      NOW, // 2026-03-15 → due in 17 days, inside the default 30-day window
    );
    const counts = deriveVacunasBadgeCounts(summary);
    expect(counts.porVencer).toBe(1);
    expect(counts.vigente).toBe(0);
  });
});

// The bug this closes: a catalog-interval ESTIMATE (dueSource "derived")
// rendered as the strong "Vencida" state ("Venció dd/mm", red badge) —
// contradicting the compliance card on the same profile, which calls the
// identical estimate "Refuerzo sugerido vencido" in warning tone. A
// vet-signed date (dueSource "payload") keeps the strong copy.
describe("metaFor / isSuggestedLapse — estimate vs vet-signed vencida", () => {
  const expired = (
    dueSource: VaccineSnapshot["dueSource"],
    nextDueAt: Date | null = new Date("2026-03-01T12:00:00Z"),
  ): VaccineSnapshot => ({
    vaccineName: "Antirrábica",
    lastDoseAt: new Date("2025-03-01T12:00:00Z"),
    nextDueAt,
    status: "expired",
    dueSource,
  });

  it("a catalog-interval estimate reads as a suggestion, not 'Vencida'", () => {
    const v = expired("derived");
    expect(isSuggestedLapse(v)).toBe(true);
    expect(metaFor(v)).toBe("Refuerzo sugerido vencido el 1 de mar de 2026");
  });

  it("a vet-signed date keeps the strong 'Venció' state", () => {
    const v = expired("payload");
    expect(isSuggestedLapse(v)).toBe(false);
    expect(metaFor(v)).toBe("Venció 1 de mar de 2026");
  });

  it("an expired vaccine with no date at all (defensive) is not a suggested lapse", () => {
    const v = expired("derived", null);
    expect(isSuggestedLapse(v)).toBe(false);
    expect(metaFor(v)).toBe("Vencida");
  });
});

describe("VacunasStatusBadges — a zero stays quiet", () => {
  const dose: VaccineSnapshot = {
    vaccineName: "Antirrábica",
    lastDoseAt: new Date("2026-03-01T12:00:00Z"),
    nextDueAt: new Date("2027-03-01T12:00:00Z"),
    status: "active",
    dueSource: "payload",
  };

  it("paints the live count and leaves the three zeros on the paper", () => {
    const html = renderToStaticMarkup(
      createElement(VacunasStatusBadges, {
        summary: {
          active: 1,
          dueSoon: 0,
          expired: 0,
          missing: 2,
          unconfirmed: 0,
          otherCount: 0,
          perVaccine: [dose],
          hasReferenceCalendar: true,
          calendarNote: null,
        },
      }),
    );
    expect(html).toContain("ln-vac-badges");
    expect(html.match(/data-quiet="true"/g)?.length).toBe(3);
    expect(html).toContain("var(--color-ln-ok)");
    expect(html).not.toContain("var(--color-ln-err");
    expect(html).toContain("2 vacunas del calendario recomendado sin aplicar");
  });

  it("keeps a real vencida in the alarm color", () => {
    const html = renderToStaticMarkup(
      createElement(VacunasStatusBadges, {
        summary: {
          active: 0,
          dueSoon: 0,
          expired: 1,
          missing: 0,
          unconfirmed: 0,
          otherCount: 0,
          perVaccine: [{ ...dose, status: "expired", nextDueAt: new Date("2026-01-01T12:00:00Z") }],
          hasReferenceCalendar: true,
          calendarNote: null,
        },
      }),
    );
    expect(html).toContain("var(--color-ln-err-050)");
    expect(html.match(/data-quiet="true"/g)?.length).toBe(3);
  });

  it("lays four cells in one row, and two by two under 640px", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const base = /\.ln-vac-badges\s*\{([^}]+)\}/.exec(css)?.[1] ?? "";
    expect(base).toContain("repeat(2, minmax(0, 1fr))");
    const wide =
      /@media \(min-width: 640px\)\s*\{\s*\.ln-vac-badges\s*\{([^}]+)\}/.exec(css)?.[1] ?? "";
    expect(wide).toContain("repeat(4, minmax(0, 1fr))");
  });
});

describe("owner/share parity — same shared predicate", () => {
  it("hasAnyVaccineRecord drives both surfaces' empty state", () => {
    const empty = computeVaccinationSummary([], "cat", NOW);
    expect(deriveVacunasBadgeCounts(empty).hasRecords).toBe(hasAnyVaccineRecord(empty));

    const withDose = computeVaccinationSummary(
      [vaccineEvent("Triple felina", "2026-03-01")],
      "cat",
      NOW,
    );
    expect(deriveVacunasBadgeCounts(withDose).hasRecords).toBe(hasAnyVaccineRecord(withDose));
  });
});

describe("VacunasStatusBadges — a species with no reference calendar (QA v14 P1)", () => {
  it("a ferret with one rabies dose shows the dose and the honest note, never 'sin aplicar'", () => {
    const summary = computeVaccinationSummary(
      [
        {
          eventType: "vaccination_administered",
          occurredAt: new Date("2026-03-01T12:00:00Z"),
          payload: { vaccine_name: "Antirrábica" },
        },
      ],
      "ferret",
      NOW,
    );
    const html = renderToStaticMarkup(createElement(VacunasStatusBadges, { summary }));
    expect(html).toContain("No tenemos un calendario de vacunas de referencia para hurones.");
    expect(html).not.toContain("sin aplicar");
    expect(deriveVacunasBadgeCounts(summary).sinAplicar).toBe(0);
  });

  it("a ferret with nothing recorded says so in the empty state", () => {
    const html = renderToStaticMarkup(
      createElement(VacunasStatusBadges, {
        summary: computeVaccinationSummary([], "ferret", NOW),
      }),
    );
    expect(html).toContain("Sin vacunas registradas");
    expect(html).toContain("No tenemos un calendario de vacunas de referencia para hurones.");
  });
});
