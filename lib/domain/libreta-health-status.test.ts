import { deriveComplianceState } from "@/lib/projections/pet-compliance";
import { describe, expect, it } from "vitest";
import { computeVaccinationSummary, suggestNextDueDate } from "./libreta-health-status";

// The regression this file exists for: blind QA 2026-08-19 (O5). The vaccine
// sheet counted the catalog interval from `new Date()` instead of from the
// application date the owner had just changed, so a dose backdated to
// yesterday suggested a booster one day late. The interval must ride the
// APPLICATION date, through the same calendar helper the server derivation
// uses — otherwise the form promises one booster date and the libreta shows
// another.

describe("suggestNextDueDate", () => {
  it("counts the interval from the application date, not from today", () => {
    expect(suggestNextDueDate("2026-08-18", 12)).toBe("2027-08-18");
    expect(suggestNextDueDate("2026-08-19", 12)).toBe("2027-08-19");
  });

  it("a dose loaded a year late is due a year later, not next year", () => {
    // The scaled version of the same defect: `new Date()` would have said
    // 2027-08-19 for a dose actually applied in 2025.
    expect(suggestNextDueDate("2025-03-04", 12)).toBe("2026-03-04");
  });

  it("honours real month lengths and year rollover", () => {
    // Clamped to the month's last day — the calendar the compliance card uses.
    // (It used to overflow like setMonth: 03/03 and 01/03.)
    expect(suggestNextDueDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(suggestNextDueDate("2026-11-15", 3)).toBe("2027-02-15");
    expect(suggestNextDueDate("2024-02-29", 12)).toBe("2025-02-28"); // leap → non-leap
  });

  it("does not slip a day under a negative UTC offset (es-AR is UTC-3)", () => {
    // A UTC round-trip on a bare date string is the classic way this breaks.
    expect(suggestNextDueDate("2026-01-01", 6)).toBe("2026-07-01");
    expect(suggestNextDueDate("2026-12-31", 12)).toBe("2027-12-31");
  });

  it("suggests nothing for a vaccine with no interval", () => {
    expect(suggestNextDueDate("2026-08-18", null)).toBe("");
  });

  it("suggests nothing for a date the user is still typing", () => {
    expect(suggestNextDueDate("", 12)).toBe("");
    expect(suggestNextDueDate("2026-08", 12)).toBe("");
    expect(suggestNextDueDate("18/08/2026", 12)).toBe("");
  });
});

// The libreta badge and the owner's compliance card derive the same booster
// date. They used to disagree for up to a day: the libreta added the interval
// with setMonth to the UTC instant (no month-end clamp), the card on the AR
// calendar day (clamped). Each case pins BOTH surfaces at the same instant.
describe("computeVaccinationSummary — the derived due date agrees with the compliance card", () => {
  const VET = { authorRole: "vet", authorVerified: true, authorOrganizationId: null };
  const dose = (occurredAt: string, nextDueAt: string | null = null) => ({
    eventType: "vaccination_administered",
    occurredAt,
    payload: { vaccine_name: "Antirrábica", next_due_at: nextDueAt },
    ...VET,
  });
  const libretaRow = (events: ReturnType<typeof dose>[], now: Date) =>
    computeVaccinationSummary(events, "dog", now).perVaccine.find(
      (v) => v.vaccineName === "Antirrábica",
    );
  const cardState = (events: ReturnType<typeof dose>[], now: Date) =>
    deriveComplianceState({
      now,
      events,
      rabiesReminder: null,
      reservedRabiesTurno: null,
      microchipCode: null,
      pppApplies: false,
      ruleParams: {
        rabies: { frequencyMonths: 12, minAgeMonths: null },
        sterilization: { minAgeMonths: null, mandatoryFromMonths: null },
      },
    }).cards.find((c) => c.key === "rabies")?.state;

  it("a dose given at 22:00 AR is due on its AR calendar day, a year on", () => {
    // 16/09/2025 01:00Z is 15/09/2025 22:00 in Argentina.
    const events = [dose("2025-09-16T01:00:00Z")];
    // 15/09/2026 20:30 AR — past the AR due day's noon anchor.
    const now = new Date("2026-09-15T23:30:00Z");
    const row = libretaRow(events, now);
    expect(row?.nextDueAt?.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    expect(row?.status).toBe("expired");
    expect(cardState(events, now)).toBe("Refuerzo sugerido vencido");
  });

  it("a dose given on 29/02 is due on 28/02 the next year, not 01/03", () => {
    const events = [dose("2024-02-29T15:00:00Z")];
    // 28/02/2025 17:00 AR.
    const now = new Date("2025-02-28T20:00:00Z");
    const row = libretaRow(events, now);
    expect(row?.nextDueAt?.toISOString()).toBe("2025-02-28T12:00:00.000Z");
    expect(row?.status).toBe("expired");
    expect(cardState(events, now)).toBe("Refuerzo sugerido vencido");
  });

  it("a date-only next_due_at is read on its AR day, not from 21:00 the day before", () => {
    const events = [dose("2025-09-15T15:00:00Z", "2026-09-15")];
    // 14/09/2026 22:00 AR — the dose is due tomorrow in Argentina.
    const now = new Date("2026-09-15T01:00:00Z");
    const row = libretaRow(events, now);
    expect(row?.nextDueAt?.toISOString()).toBe("2026-09-15T12:00:00.000Z");
    expect(row?.status).toBe("due_soon");
    expect(cardState(events, now)).toBe("Vigente");
  });
});

// The bug this closes: the libreta badge said red "Vencida" for a
// catalog-interval ESTIMATE (no vet-signed next_due_at on the asiento) while
// the compliance card on the same profile said "Refuerzo sugerido vencido"
// (warning tone) for the identical dose. `dueSource` lets the badge tell the
// two apart the same way pet-compliance already does ("dose" vs "rule").
describe("computeVaccinationSummary — dueSource", () => {
  const NOW = new Date("2026-09-15T12:00:00Z");

  it("a vet-signed next_due_at is dueSource 'payload'", () => {
    const summary = computeVaccinationSummary(
      [
        {
          eventType: "vaccination_administered",
          occurredAt: "2026-01-01",
          payload: { vaccine_name: "Antirrábica", next_due_at: "2026-06-01" },
        },
      ],
      "dog",
      NOW,
    );
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(row?.status).toBe("expired");
    expect(row?.dueSource).toBe("payload");
  });

  it("a catalog-interval estimate (no next_due_at on the asiento) is dueSource 'derived'", () => {
    const summary = computeVaccinationSummary(
      [
        {
          eventType: "vaccination_administered",
          occurredAt: "2025-01-01",
          payload: { vaccine_name: "Antirrábica" },
        },
      ],
      "dog",
      NOW,
    );
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(row?.status).toBe("expired");
    expect(row?.dueSource).toBe("derived");
  });
});
