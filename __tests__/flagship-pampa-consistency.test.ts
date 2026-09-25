// Pampa's facts — one pure module, read by the seed and by the landing.
//
// scripts/flagship-pampa-data.ts was extracted from scripts/seed-flagship-pampa.ts
// so the public landing tells the story of the SAME pet its hero QR resolves
// to. The extraction must not change what the seed writes: FROZEN_EVENTS below
// is the seed's event list verbatim as it stood before the refactor (wu5,
// 6722d4a72), and the module has to rebuild it deep-equal.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PAMPA_EVENTS, buildPampaLibreta } from "@/scripts/flagship-pampa-data";

const FROZEN_EVENTS = [
  {
    date: "2022-03-14",
    eventType: "pet_registered",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      name: "Pampa",
      species: "dog",
      sex: "female",
      breed: "Caniche",
      date_of_birth: "2021-11-20",
      birth_date_is_estimated: true,
      color: "blanco",
      acquisition_method: "adopted",
      has_photo: true,
      has_microchip: false,
    },
  },
  {
    date: "2022-04-05",
    eventType: "microchip_implanted",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      chip_number: "941000100000001",
      country_code: "941",
      implanted_by: "Veterinaria Belgrano",
      location_on_body: "interescapular",
      implant_date_known: true,
    },
  },
  {
    date: "2022-04-12",
    eventType: "vaccination_administered",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      vaccine_name: "Antirrábica",
      brand: "Rabisin",
      batch: "AR-2214",
      administered_by: "Veterinaria Belgrano",
      next_due_at: "2023-04-12",
    },
  },
  {
    date: "2023-02-18",
    eventType: "sterilization_performed",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      procedure: "spay",
      performed_by: "Veterinaria Belgrano",
      clinic: "Veterinaria Belgrano",
    },
  },
  {
    date: "2024-03-09",
    eventType: "status_changed",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      from_status: "active",
      to_status: "lost",
      location_description: "Barrancas de Belgrano, CABA",
      reason: null,
      disclosure_prefs_snapshot: {
        first_name: true,
        phone: true,
        email: false,
        last_location: true,
        finder_form: true,
      },
      lost_description: {
        accessories_when_lost: "Collar celeste con chapita",
        behavior_notes: null,
        last_seen_context: "Se soltó en la plaza durante un paseo",
      },
    },
  },
  {
    date: "2024-03-10",
    eventType: "credential_scanned",
    authorRole: "scanner",
    authorVerified: false,
    payload: { is_self_scan: false, viewer_authenticated: false },
  },
  {
    date: "2024-03-11",
    eventType: "shelter_intake_recorded",
    authorRole: "shelter",
    authorVerified: false,
    payload: {
      intake_reason: "stray_found",
      intake_condition: "Sana, con chip verificado",
      rescue_jurisdiction: "CABA",
    },
  },
  {
    date: "2024-03-13",
    eventType: "status_changed",
    authorRole: "owner",
    authorVerified: false,
    payload: {
      from_status: "lost",
      to_status: "active",
      reason: "returned_to_owner",
    },
  },
  {
    date: "2024-08-20",
    eventType: "clinical_info_logged",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      sub_kind: "other",
      title: "Dermatitis atópica",
      details: "Plan de tratamiento y control estacional",
      performed_by: "Veterinaria Belgrano",
    },
  },
  {
    date: "2026-06-15",
    eventType: "vaccination_administered",
    authorRole: "vet",
    authorVerified: true,
    payload: {
      vaccine_name: "Antirrábica",
      brand: "Nobivac Rabies",
      batch: "CAMP-C13-2026",
      administered_by: "Campaña antirrábica · Comuna 13",
      next_due_at: "2027-06-15",
    },
  },
];

describe("flagship Pampa — the seed's output survives the extraction", () => {
  it("buildPampaLibreta rebuilds the pre-refactor events deep-equal", () => {
    const { events, recordedBy } = buildPampaLibreta("owner-id", "vet-id");
    expect(events).toEqual(FROZEN_EVENTS);
    expect(recordedBy).toEqual({
      owner: "owner-id",
      vet: "vet-id",
      shelter: "owner-id",
      scanner: null,
    });
  });

  it("the seed builds its libreta from the module, not from a local copy", () => {
    const seed = readFileSync("scripts/seed-flagship-pampa.ts", "utf8");
    expect(seed).toContain('from "./flagship-pampa-data"');
    expect(seed).toContain("buildPampaLibreta(ownerId, vetId)");
    for (const fact of ["AR-2214", "CAMP-C13-2026", "Rabisin", "V-99001-CABA", "2022-04-05"]) {
      expect(seed, `seed hardcodes "${fact}" instead of reading the module`).not.toContain(fact);
    }
  });

  it("the module is pure: it imports nothing", () => {
    const source = readFileSync("scripts/flagship-pampa-data.ts", "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/require\(|await import\(/);
  });

  it("events are chronological", () => {
    const dates = PAMPA_EVENTS.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });
});
