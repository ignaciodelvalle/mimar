// Pure-function tests for the libreta health-status helpers.
//
// Covers:
//   • computeVaccinationSummary — core/missing/active/due_soon/expired
//     classification and the next-due derivation from intervalMonths
//   • computeMedicationsActive — open treatments by start/stop id matching
//   • computeLibretaHealthStatus — passes pet metadata through unchanged

import { describe, expect, it } from "vitest";

import {
  computeLibretaHealthStatus,
  computeMedicationsActive,
  computeVaccinationSummary,
} from "@/lib/domain/libreta-health-status";

// Helper: shape a vaccination event the way the libreta page returns it.
function vaxEvent(opts: {
  vaccineName: string;
  occurredAt: string;
  nextDueAt?: string | null;
}) {
  return {
    id: `vax-${Math.random().toString(36).slice(2, 9)}`,
    eventType: "vaccination_administered" as const,
    occurredAt: new Date(opts.occurredAt),
    payload: {
      vaccine_name: opts.vaccineName,
      ...(opts.nextDueAt !== undefined ? { next_due_at: opts.nextDueAt } : {}),
    },
  };
}

function medStartEvent(opts: { id: string; drug: string; occurredAt: string }) {
  return {
    id: opts.id,
    eventType: "medication_started" as const,
    occurredAt: new Date(opts.occurredAt),
    payload: { drug_name: opts.drug },
  };
}

function medStopEvent(opts: { startId: string; occurredAt: string }) {
  return {
    id: `stop-${Math.random().toString(36).slice(2, 9)}`,
    eventType: "medication_stopped" as const,
    occurredAt: new Date(opts.occurredAt),
    payload: { medication_started_event_id: opts.startId },
  };
}

describe("computeVaccinationSummary", () => {
  const now = new Date("2026-05-26T12:00:00.000Z");

  it("returns all core vaccines as missing for a fresh dog with no events", () => {
    const summary = computeVaccinationSummary([], "dog", now);
    expect(summary.active).toBe(0);
    expect(summary.expired).toBe(0);
    expect(summary.dueSoon).toBe(0);
    // Catalog has dog cores: Antirrábica, Séxtuple, Quíntuple → 3 missing.
    expect(summary.missing).toBeGreaterThanOrEqual(3);
    expect(summary.perVaccine.find((v) => v.vaccineName === "Antirrábica")?.status).toBe("missing");
  });

  it("classifies a recent rabies dose as active", () => {
    const events = [vaxEvent({ vaccineName: "Antirrábica", occurredAt: "2026-05-01T00:00:00Z" })];
    const summary = computeVaccinationSummary(events, "dog", now);
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(row?.status).toBe("active");
    expect(row?.lastDoseAt?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(row?.nextDueAt).toBeInstanceOf(Date); // derived from intervalMonths=12
  });

  it("classifies a dose due within 30 days as due_soon", () => {
    // Catalog interval is 12 months. A dose ~11 months back puts next-due in ~30 days.
    const events = [vaxEvent({ vaccineName: "Antirrábica", occurredAt: "2025-06-15T00:00:00Z" })];
    const summary = computeVaccinationSummary(events, "dog", now);
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(row?.status).toBe("due_soon");
  });

  it("classifies an over-interval dose as expired", () => {
    const events = [vaxEvent({ vaccineName: "Antirrábica", occurredAt: "2024-01-01T00:00:00Z" })];
    const summary = computeVaccinationSummary(events, "dog", now);
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(row?.status).toBe("expired");
    expect(summary.expired).toBeGreaterThan(0);
  });

  it("derives next-due a full CALENDAR year later for a 12-month vaccine, not 360 days (PJ-M2)", () => {
    // A 12-month dose with no explicit next_due_at must expire ~1 calendar year
    // later. The old `intervalMonths * 30 * DAY_MS` math treated a year as 360
    // days, expiring the dose ~5 days early.
    const occurredAt = "2025-03-15T12:00:00.000Z";
    const events = [vaxEvent({ vaccineName: "Antirrábica", occurredAt })];
    const summary = computeVaccinationSummary(events, "dog", now);
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");

    const DAY_MS = 24 * 60 * 60 * 1000;
    const days360 = new Date(new Date(occurredAt).getTime() + 360 * DAY_MS);
    // A real calendar year (365 days here) is strictly LATER than 360 days.
    expect(row?.nextDueAt?.getTime()).toBeGreaterThan(days360.getTime());
    // And it lands on the same calendar day one year on.
    expect(row?.nextDueAt?.toISOString()).toBe("2026-03-15T12:00:00.000Z");
  });

  it("honors an explicit next_due_at over the catalog interval", () => {
    const events = [
      vaxEvent({
        vaccineName: "Antirrábica",
        occurredAt: "2026-04-01T00:00:00Z",
        nextDueAt: "2026-06-10T00:00:00Z", // ~14 days from now → due_soon
      }),
    ];
    const summary = computeVaccinationSummary(events, "dog", now);
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(row?.status).toBe("due_soon");
    expect(row?.nextDueAt?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("uses the latest dose when multiple events for the same vaccine exist", () => {
    const events = [
      vaxEvent({ vaccineName: "Antirrábica", occurredAt: "2023-01-01T00:00:00Z" }),
      vaxEvent({ vaccineName: "Antirrábica", occurredAt: "2026-05-20T00:00:00Z" }),
    ];
    const summary = computeVaccinationSummary(events, "dog", now);
    const row = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(row?.status).toBe("active");
    expect(row?.lastDoseAt?.toISOString()).toBe("2026-05-20T00:00:00.000Z");
  });

  it("keeps free-text vaccine names out of perVaccine but counts them in otherCount", () => {
    const events = [
      vaxEvent({ vaccineName: "Made-Up Vaccine", occurredAt: "2026-05-01T00:00:00Z" }),
    ];
    const summary = computeVaccinationSummary(events, "dog", now);
    // Doesn't appear in perVaccine (no fuzzy catalog match), so cores remain missing.
    expect(summary.perVaccine.find((v) => v.vaccineName === "Made-Up Vaccine")).toBeUndefined();
    // But it is counted as visible-but-off-catalog so the dose is not dropped.
    expect(summary.otherCount).toBe(1);
  });

  it("does not let non-catalog vaccines inflate the POSITIVE headline counts", () => {
    const events = [
      vaxEvent({ vaccineName: "Vacuna Exótica X", occurredAt: "2026-05-01T00:00:00Z" }),
    ];
    const summary = computeVaccinationSummary(events, "dog", now);
    // An unidentified dose may never be counted as protection. This half of the
    // original assertion is the security-relevant one and is unchanged.
    expect(summary.active).toBe(0);
    expect(summary.dueSoon).toBe(0);
    expect(summary.expired).toBe(0);
    expect(summary.otherCount).toBe(1);

    // The other half USED to read `missing >= 3` — "an off-catalog dose must not
    // reduce missing". PO decision 2026-07-28 reversed exactly that: an
    // unidentified dose blocks the never-given CLAIM, because the libreta was
    // reporting a matrícula-signed "Séxtuple" as absent (the catalog spells it
    // "Séxtuple (DHPPi-L)").
    //
    // KNOWN COST, accepted deliberately: the rule cannot be narrower without
    // the fuzzy matching we rejected. Nothing machine-checkable separates
    // "Séxtuple" (a core vaccine, differently written) from "Vacuna Exótica X"
    // (genuinely unrelated) — so even this clearly-unrelated dose suppresses
    // the claim. The shrinking path is write-side normalisation, not a cleverer
    // read: once the vet form stores catalog names, unmatched doses become rare.
    expect(summary.missing).toBe(0);
    expect(summary.unconfirmed).toBeGreaterThanOrEqual(3);
  });

  it("dedupes multiple doses of the same off-catalog vaccine name", () => {
    const events = [
      vaxEvent({ vaccineName: "Giardia Vax", occurredAt: "2025-01-01T00:00:00Z" }),
      vaxEvent({ vaccineName: "giardia vax", occurredAt: "2026-01-01T00:00:00Z" }),
      vaxEvent({ vaccineName: "Otra Rara", occurredAt: "2026-02-01T00:00:00Z" }),
    ];
    const summary = computeVaccinationSummary(events, "dog", now);
    // "Giardia Vax"/"giardia vax" collapse to one; "Otra Rara" is a second → 2.
    expect(summary.otherCount).toBe(2);
  });

  it("reports otherCount=0 when every administered vaccine is in the catalog", () => {
    const events = [vaxEvent({ vaccineName: "Antirrábica", occurredAt: "2026-05-01T00:00:00Z" })];
    const summary = computeVaccinationSummary(events, "dog", now);
    expect(summary.otherCount).toBe(0);
  });

  it("surfaces non-core vaccines once the owner has logged a dose", () => {
    const events = [
      vaxEvent({
        vaccineName: "Tos de las perreras (Bordetella)",
        occurredAt: "2026-05-01T00:00:00Z",
      }),
    ];
    const summary = computeVaccinationSummary(events, "dog", now);
    const row = summary.perVaccine.find((v) => v.vaccineName.startsWith("Tos de las perreras"));
    expect(row).toBeDefined();
    expect(row?.status).toBe("active");
  });
});

describe("computeMedicationsActive", () => {
  it("returns nothing when no medication events exist", () => {
    expect(computeMedicationsActive([])).toEqual([]);
  });

  it("returns started events that have no matching stop", () => {
    const events = [
      medStartEvent({ id: "start-1", drug: "Apoquel 16mg", occurredAt: "2026-01-10T00:00:00Z" }),
      medStartEvent({
        id: "start-2",
        drug: "Cefalexina 500mg",
        occurredAt: "2026-04-15T00:00:00Z",
      }),
    ];
    const active = computeMedicationsActive(events);
    expect(active.map((a) => a.drug)).toEqual(["Apoquel 16mg", "Cefalexina 500mg"]);
  });

  it("excludes a started event once a stop references it by id", () => {
    const events = [
      medStartEvent({ id: "start-1", drug: "Apoquel 16mg", occurredAt: "2026-01-10T00:00:00Z" }),
      medStartEvent({
        id: "start-2",
        drug: "Cefalexina 500mg",
        occurredAt: "2026-04-15T00:00:00Z",
      }),
      medStopEvent({ startId: "start-2", occurredAt: "2026-05-01T00:00:00Z" }),
    ];
    const active = computeMedicationsActive(events);
    expect(active.map((a) => a.drug)).toEqual(["Apoquel 16mg"]);
  });

  it("does not match by drug name — different starts of the same drug stay open until each is stopped", () => {
    const events = [
      medStartEvent({ id: "start-1", drug: "Apoquel", occurredAt: "2025-01-01T00:00:00Z" }),
      medStartEvent({ id: "start-2", drug: "Apoquel", occurredAt: "2026-01-01T00:00:00Z" }),
      medStopEvent({ startId: "start-1", occurredAt: "2025-06-01T00:00:00Z" }),
    ];
    const active = computeMedicationsActive(events);
    expect(active.map((a) => a.startEventId)).toEqual(["start-2"]);
  });

  it("returns active items oldest first", () => {
    const events = [
      medStartEvent({ id: "start-newer", drug: "B", occurredAt: "2026-04-01T00:00:00Z" }),
      medStartEvent({ id: "start-older", drug: "A", occurredAt: "2026-01-01T00:00:00Z" }),
    ];
    const active = computeMedicationsActive(events);
    expect(active.map((a) => a.startEventId)).toEqual(["start-older", "start-newer"]);
  });
});

describe("computeLibretaHealthStatus", () => {
  it("passes pet condition fields through unchanged", () => {
    const status = computeLibretaHealthStatus(
      {
        species: "dog",
        permanentConditions: ["dermatitis_atopica", "otra"],
        permanentConditionsOther: "Sensible a pollo",
      },
      [],
      new Date("2026-05-26T00:00:00Z"),
    );
    expect(status.permanentConditions).toEqual(["dermatitis_atopica", "otra"]);
    expect(status.permanentConditionsOther).toBe("Sensible a pollo");
  });

  it("defaults permanentConditions to an empty list when the pet has none", () => {
    const status = computeLibretaHealthStatus(
      { species: "cat", permanentConditions: null, permanentConditionsOther: null },
      [],
    );
    expect(status.permanentConditions).toEqual([]);
    expect(status.permanentConditionsOther).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// "Sin confirmar" — the libreta stops asserting an absence it cannot prove.
//
// Live review 2026-07-28: a vet signed a dose named "Séxtuple" (matrícula, lot
// VG-2026-25). The catalog entry is "Séxtuple (DHPPi-L)". findVaccineByName is
// exact equality, so the signed dose landed in the off-catalog bucket AND the
// core entry reported `missing` — the dashboard told the owner "2 vacunas del
// calendario recomendado sin aplicar" a few centimetres above the signed record.
//
// PO decision 2026-07-28: keep exact matching (fuzzy-matching a medical record
// risks asserting a vaccine nobody gave), but never claim the ABSENCE while an
// unidentified dose is on file.
// ---------------------------------------------------------------------------

describe("computeVaccinationSummary — an unidentified dose blocks the 'never given' claim", () => {
  it("reports a core vaccine as UNCONFIRMED, not missing, when an unmatched dose exists", () => {
    const summary = computeVaccinationSummary(
      [vaxEvent({ vaccineName: "Séxtuple", occurredAt: "2026-06-26T00:00:00.000Z" })],
      "dog",
      new Date("2026-07-28T00:00:00.000Z"),
    );

    // The dose is still counted as off-catalog — it is not silently dropped.
    expect(summary.otherCount).toBe(1);
    // …and NOTHING is asserted to be absent.
    expect(summary.missing).toBe(0);
    expect(summary.unconfirmed).toBeGreaterThan(0);
    for (const v of summary.perVaccine) {
      expect(v.status).not.toBe("missing");
    }
  });

  it("still reports MISSING when the animal carries no unidentifiable dose", () => {
    // The control. With nothing on file that could plausibly BE the core
    // vaccine, "nunca aplicada" is a defensible statement and must survive —
    // this fix must not turn every gap into a shrug.
    const summary = computeVaccinationSummary([], "dog", new Date("2026-07-28T00:00:00.000Z"));
    expect(summary.unconfirmed).toBe(0);
    expect(summary.missing).toBeGreaterThan(0);
  });

  it("a dose that DOES match the catalog leaves the other core vaccines missing", () => {
    // A matched dose is identified, so it cannot stand in for anything else:
    // the remaining core vaccines are genuinely unaccounted for.
    const summary = computeVaccinationSummary(
      [vaxEvent({ vaccineName: "Antirrábica", occurredAt: "2026-06-26T00:00:00.000Z" })],
      "dog",
      new Date("2026-07-28T00:00:00.000Z"),
    );
    expect(summary.otherCount).toBe(0);
    expect(summary.unconfirmed).toBe(0);
    expect(summary.missing).toBeGreaterThan(0);
  });
});
