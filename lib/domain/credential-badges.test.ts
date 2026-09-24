// WAVE D1 (Invariant #3) — the PUBLIC credential must show CORRECTED clinical
// values. These pure tests prove that folding an `event_amended` row through the
// badge helpers changes what a QR scanner sees: the vaccine count, the active
// medications, and the rabies-at-risk banner all move with the correction.

import { describe, expect, it } from "vitest";

import { computeVaccinationSummary, hasAnyVaccineRecord } from "@/lib/domain/libreta-health-status";
import { overlayAmendments } from "@/lib/infra/amendment";
import {
  type CredentialEvent,
  deriveActiveMedications,
  deriveRabiesSemaphore,
  isRabiesAtRisk,
} from "./credential-badges";

const vaccination = (
  id: string,
  name: string,
  at: string,
  nextDueAt?: string,
  // Authorship defaults to an OWNER-declared dose — the common case and, until
  // 2026-08-17, the one the public credential rendered as a verified green
  // seal. Tests that want the professional signature must ask for it, so no
  // assertion can acquire it by accident.
  signer: "owner" | "vet" = "owner",
): CredentialEvent => ({
  id,
  eventType: "vaccination_administered",
  occurredAt: at,
  payload: { vaccine_name: name, ...(nextDueAt ? { next_due_at: nextDueAt } : {}) },
  authorRole: signer,
  authorVerified: signer === "vet",
  authorOrganizationId: signer === "vet" ? "org-1" : null,
});

const amend = (
  id: string,
  targetId: string,
  at: string,
  changes: Array<{ field: string; old: unknown; new: unknown }>,
): CredentialEvent => ({
  id,
  eventType: "event_amended",
  occurredAt: at,
  payload: { target_event_id: targetId, changes, reason: null },
});

// The Tier 2 vaccine summary derives from computeVaccinationSummary — the SAME
// function the owner libreta uses (bug 3, staging validation 2026-07-04). These
// tests pin the two contracts the share view relies on: corrections still
// supersede (Invariant #3), and a zero-record pet reads as "no records", never
// a fabricated count.
describe("tier2 vaccine summary — shared derivation on the public credential", () => {
  const NOW = new Date("2026-03-15T00:00:00Z");

  it("a correction to a vaccine name flows into the shared summary (Invariant #3)", () => {
    // A mistyped off-catalog name corrected to the catalog "Antirrábica"
    // becomes a classified core dose instead of an off-catalog extra.
    const events = [
      vaccination("v1", "Antirabica typo", "2026-02-01", "2027-02-01"),
      amend("a1", "v1", "2026-03-01", [
        { field: "vaccine_name", old: "Antirabica typo", new: "Antirrábica" },
      ]),
    ];
    const summary = computeVaccinationSummary(overlayAmendments(events), "dog", NOW);
    expect(summary.otherCount).toBe(0);
    const rabies = summary.perVaccine.find((v) => v.vaccineName === "Antirrábica");
    expect(rabies?.status).not.toBe("missing");
  });

  it("zero registered doses → hasAnyVaccineRecord false, and nothing counts as due/expired", () => {
    const summary = computeVaccinationSummary([], "dog", NOW);
    expect(hasAnyVaccineRecord(summary)).toBe(false);
    expect(summary.active).toBe(0);
    expect(summary.dueSoon).toBe(0);
    expect(summary.expired).toBe(0);
    // Catalog cores show as missing — visible, but NEVER folded into a count.
    expect(summary.missing).toBeGreaterThan(0);
  });

  it("owner and share agree by construction: same inputs → same summary object", () => {
    const events = [
      vaccination("v1", "Antirrábica", "2026-02-01"),
      vaccination("v2", "Quíntuple", "2026-01-01"),
    ];
    const owner = computeVaccinationSummary(overlayAmendments(events), "dog", NOW);
    const share = computeVaccinationSummary(overlayAmendments(events), "dog", NOW);
    expect(share).toEqual(owner);
  });
});

describe("deriveActiveMedications — corrected drug name is what the scanner sees", () => {
  it("surfaces the CORRECTED drug name, never the mistyped original", () => {
    const events: CredentialEvent[] = [
      {
        id: "m1",
        eventType: "medication_started",
        occurredAt: "2026-01-01",
        payload: { drug_name: "Meloxican typo" },
      },
      amend("a1", "m1", "2026-02-01", [
        { field: "drug_name", old: "Meloxican typo", new: "Meloxicam" },
      ]),
    ];
    expect(deriveActiveMedications(events)).toEqual(["Meloxicam"]);
  });

  it("a stopped medication is excluded", () => {
    const events: CredentialEvent[] = [
      {
        id: "m1",
        eventType: "medication_started",
        occurredAt: "2026-01-01",
        payload: { drug_name: "Meloxicam" },
      },
      {
        id: "m2",
        eventType: "medication_stopped",
        occurredAt: "2026-02-01",
        payload: { medication_started_event_id: "m1" },
      },
    ];
    expect(deriveActiveMedications(events)).toEqual([]);
  });
});

describe("isRabiesAtRisk — a corrected expiry flips the service-dog warning", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  // NOTE: the public heuristic matches vaccine names literally containing
  // "rabia" (lowercased). It is accent-sensitive and misses the canonical
  // "Antirrábica" — a PRE-EXISTING weakness of this banner (same class the KPI
  // path fixed with an accent-aware regex; see lib/metrics/rabies.ts). Out of
  // WAVE D1 scope; these tests exercise the correction-overlay, not the regex.
  it("expired rabies dose is at risk", () => {
    const events = [vaccination("v1", "Vacuna Rabia", "2025-01-01", "2026-01-01")];
    expect(isRabiesAtRisk(events, now)).toBe(true);
  });

  it("a correction extending next_due_at into the future clears the risk", () => {
    const events = [
      vaccination("v1", "Vacuna Rabia", "2025-01-01", "2026-01-01"),
      amend("a1", "v1", "2026-05-01", [
        { field: "next_due_at", old: "2026-01-01", new: "2027-01-01" },
      ]),
    ];
    // Without the overlay the credential would still warn "vencida"; with it,
    // the corrected future due date clears the banner.
    expect(isRabiesAtRisk(events, now)).toBe(false);
  });

  it("a correction naming the dose 'Rabia' brings it into the rabies check", () => {
    // Originally recorded as a non-rabies name (not flagged) then corrected to
    // an expired rabies dose → now at risk.
    const events = [
      vaccination("v1", "Sextuple typo", "2025-01-01", "2026-01-01"),
      amend("a1", "v1", "2026-05-01", [
        { field: "vaccine_name", old: "Sextuple typo", new: "Vacuna Rabia" },
      ]),
    ];
    expect(isRabiesAtRisk(events, now)).toBe(true);
  });

  it("no vaccinations → not at risk", () => {
    expect(isRabiesAtRisk([], now)).toBe(false);
  });
});

// pet-state-header R4 — the public rabies semaphore. UNLIKE isRabiesAtRisk
// (which keeps its conservative latest-ANY-vaccine service-dog semantics),
// the semaphore filters to RABIES doses FIRST (accent/case-insensitive match)
// and then takes the latest — a later non-rabies vaccine must never mask an
// expired rabies dose.
describe("deriveRabiesSemaphore — tri-state antirrábica vigencia (R4)", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("latest rabies dose with a future next_due_at → vigente", () => {
    const events = [vaccination("v1", "Antirrábica", "2026-01-01", "2027-01-01")];
    expect(deriveRabiesSemaphore(events, now).estado).toBe("vigente");
  });

  it("latest rabies dose with a past next_due_at → vencida", () => {
    const events = [vaccination("v1", "Antirrábica", "2025-01-01", "2026-01-01")];
    expect(deriveRabiesSemaphore(events, now).estado).toBe("vencida");
  });

  it("no rabies dose at all → none (even with other vaccines present)", () => {
    expect(deriveRabiesSemaphore([], now).estado).toBe("none");
    const events = [vaccination("v1", "Quíntuple", "2026-01-01", "2027-01-01")];
    expect(deriveRabiesSemaphore(events, now).estado).toBe("none");
  });

  it("rabies dose without next_due_at → sin-vencimiento (no vigencia claim)", () => {
    const events = [vaccination("v1", "Antirrábica", "2026-01-01")];
    expect(deriveRabiesSemaphore(events, now).estado).toBe("sin-vencimiento");
  });

  it("matches rabies names accent- and case-insensitively (Antirrábica / RABIA / antirrabica)", () => {
    for (const name of ["Antirrábica", "ANTIRRABICA", "Vacuna Rabia", "rabia"]) {
      const events = [vaccination("v1", name, "2026-01-01", "2027-01-01")];
      expect(deriveRabiesSemaphore(events, now).estado, name).toBe("vigente");
    }
  });

  it("a LATER non-rabies vaccine does NOT mask an expired rabies dose (the isRabiesAtRisk asymmetry)", () => {
    const events = [
      vaccination("v1", "Antirrábica", "2025-01-01", "2026-01-01"), // expired
      vaccination("v2", "Quíntuple", "2026-05-01", "2027-05-01"), // newer, not rabies
    ];
    // The service-dog heuristic goes dark here (latest vaccine isn't rabies)…
    expect(isRabiesAtRisk(events, now)).toBe(false);
    // …but the semaphore must still say VENCIDA.
    expect(deriveRabiesSemaphore(events, now).estado).toBe("vencida");
  });

  it("takes the LATEST rabies dose when several exist", () => {
    const events = [
      vaccination("v1", "Antirrábica", "2024-01-01", "2025-01-01"), // old, expired
      vaccination("v2", "Antirrábica", "2026-01-01", "2027-01-01"), // newer, vigente
    ];
    expect(deriveRabiesSemaphore(events, now).estado).toBe("vigente");
  });

  it("a date-only next_due_at due TODAY is still vigente in the early-AR-morning window", () => {
    // Legacy rows store a bare "YYYY-MM-DD". Parsed at midnight UTC that is
    // 21:00 of the PREVIOUS AR day, so the badge read "vencida" from three
    // hours before the due day even began in Argentina. The noon-UTC anchor
    // keeps it vigente through the 21:00-prev-day → 09:00 AR window.
    const midnightAr = new Date("2026-06-01T03:00:00Z"); // 00:00 AR on 2026-06-01
    const events = [vaccination("v1", "Antirrábica", "2025-06-01", "2026-06-01")];
    expect(deriveRabiesSemaphore(events, midnightAr).estado).toBe("vigente");
    expect(isRabiesAtRisk(events, midnightAr)).toBe(false);
  });

  it("an amended name/date flips the semaphore (Invariant #3)", () => {
    // Correcting a mistyped name into a rabies dose brings it into the check…
    const renamed = [
      vaccination("v1", "Sextuple typo", "2025-01-01", "2026-01-01"),
      amend("a1", "v1", "2026-05-01", [
        { field: "vaccine_name", old: "Sextuple typo", new: "Antirrábica" },
      ]),
    ];
    expect(deriveRabiesSemaphore(renamed, now).estado).toBe("vencida");

    // …and correcting the due date forward flips vencida → vigente.
    const extended = [
      vaccination("v1", "Antirrábica", "2025-01-01", "2026-01-01"),
      amend("a1", "v1", "2026-05-01", [
        { field: "next_due_at", old: "2026-01-01", new: "2027-01-01" },
      ]),
    ];
    expect(deriveRabiesSemaphore(extended, now).estado).toBe("vigente");
  });
});

// PROVENANCE (2026-08-17). The semaphore used to return the vigencia alone, and
// the page painted it as a green VIGENTE seal — so a dose the owner typed in
// and nobody confirmed was indistinguishable from one a matriculated vet
// signed. Rabies is the one legally mandated vaccine (Ley 22.953), which makes
// it the one where acting on a false reading has consequences: an inspector, a
// finder, an adopter.
//
// The old shape could not be tested for this at all — there was nothing in the
// return value to assert on. That is the point: a claim with no room for its
// own qualifier cannot be made honest by a test.
describe("deriveRabiesSemaphore — the vigencia carries its provenance", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("marks an owner-declared dose as declarada even when the date is current", () => {
    const events = [vaccination("v1", "Antirrábica", "2026-01-01", "2027-01-01", "owner")];
    const { estado, respaldo } = deriveRabiesSemaphore(events, now);
    // Both halves matter: the date IS current, and nobody verified it.
    expect(estado).toBe("vigente");
    expect(respaldo).toBe("declarada");
  });

  it("marks a dose signed by a matriculated vet as profesional", () => {
    // Positive control. Without it, a build that returned "declarada"
    // unconditionally would satisfy every other assertion here.
    const events = [vaccination("v1", "Antirrábica", "2026-01-01", "2027-01-01", "vet")];
    expect(deriveRabiesSemaphore(events, now).respaldo).toBe("profesional");
  });

  it("describes the SAME dose the state describes when both exist", () => {
    // The failure this prevents: a professional dose that expired, followed by
    // a fresh one the owner typed in. Deriving state and provenance from two
    // separate "latest" lookups could report VIGENTE (from the new dose) with
    // profesional (from the old one) — a combination that was never true of
    // any single record.
    const events = [
      vaccination("v1", "Antirrábica", "2024-01-01", "2025-01-01", "vet"),
      vaccination("v2", "Antirrábica", "2026-01-01", "2027-01-01", "owner"),
    ];
    const { estado, respaldo } = deriveRabiesSemaphore(events, now);
    expect(estado).toBe("vigente");
    expect(respaldo).toBe("declarada");
  });

  it("keeps the professional signature when a correction only changes the payload", () => {
    // An amendment rewrites the corrected FIELDS, never the authorship — a vet
    // who signed still signed. Pins that overlayAmendments carries the
    // authorship columns through, which is what makes the lookup above work.
    const events = [
      vaccination("v1", "Antirrábica", "2025-01-01", "2026-01-01", "vet"),
      amend("a1", "v1", "2026-05-01", [
        { field: "next_due_at", old: "2026-01-01", new: "2027-01-01" },
      ]),
    ];
    const { estado, respaldo } = deriveRabiesSemaphore(events, now);
    expect(estado).toBe("vigente");
    expect(respaldo).toBe("profesional");
  });

  it("reads a row with NO authorship columns as declarada, not as verified", () => {
    // Fail-closed. A caller that forgets to select the authorship columns must
    // understate the claim; the alternative is inventing a verification that
    // never happened.
    const bare: CredentialEvent = {
      id: "v1",
      eventType: "vaccination_administered",
      occurredAt: "2026-01-01",
      payload: { vaccine_name: "Antirrábica", next_due_at: "2027-01-01" },
    };
    expect(deriveRabiesSemaphore([bare], now).respaldo).toBe("declarada");
  });

  it("reports provenance on an EXPIRED dose too", () => {
    // "Vencida" is equally a claim about a record, and the reader deserves to
    // know whether the record that expired was ever verified.
    const events = [vaccination("v1", "Antirrábica", "2024-01-01", "2025-01-01", "vet")];
    const { estado, respaldo } = deriveRabiesSemaphore(events, now);
    expect(estado).toBe("vencida");
    expect(respaldo).toBe("profesional");
  });
});
