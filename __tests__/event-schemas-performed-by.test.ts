// Schema tests for the performed_by FK pair additions
// (spec 2026-05-19-performed-by-autocomplete-design §4.1).
//
// Verifies the optional FK fields accept null/undefined for back-compat,
// accept valid UUIDs when populated, and the superRefine rule requires
// the text snapshot when a FK is set.

import { describe, expect, it } from "vitest";

import { validateEventPayload } from "@/lib/events/event-schemas";

const REAL_UUID = "11111111-2222-4333-8444-555555555555";

describe("vaccination_administered — performed_by FK pair", () => {
  it("accepts the legacy shape (no FK fields)", () => {
    expect(() =>
      validateEventPayload("vaccination_administered", {
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dr. Free Text",
        next_due_at: null,
      }),
    ).not.toThrow();
  });

  it("accepts an organization FK with a text snapshot", () => {
    expect(() =>
      validateEventPayload("vaccination_administered", {
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: "Clínica San Pablo",
        administered_by_organization_id: REAL_UUID,
        next_due_at: null,
      }),
    ).not.toThrow();
  });

  it("accepts a profile FK with a text snapshot", () => {
    expect(() =>
      validateEventPayload("vaccination_administered", {
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dr. Juan Perez",
        administered_by_user_id: REAL_UUID,
        next_due_at: null,
      }),
    ).not.toThrow();
  });

  it("rejects FK populated without text snapshot", () => {
    expect(() =>
      validateEventPayload("vaccination_administered", {
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        administered_by_organization_id: REAL_UUID,
        next_due_at: null,
      }),
    ).toThrow();
  });
});

describe("sterilization_performed — performed_by FK pair (vet OR clinic)", () => {
  it("legacy shape still validates", () => {
    expect(() =>
      validateEventPayload("sterilization_performed", {
        procedure: "spay",
        performed_by: "Dra. María",
        clinic: null,
      }),
    ).not.toThrow();
  });

  it("FK valid when at least performed_by snapshot is set", () => {
    expect(() =>
      validateEventPayload("sterilization_performed", {
        procedure: "spay",
        performed_by: "Dra. María",
        clinic: null,
        performed_by_user_id: REAL_UUID,
      }),
    ).not.toThrow();
  });

  it("FK valid when only clinic snapshot is set", () => {
    expect(() =>
      validateEventPayload("sterilization_performed", {
        procedure: "spay",
        performed_by: null,
        clinic: "Veterinaria del Sol",
        performed_by_organization_id: REAL_UUID,
      }),
    ).not.toThrow();
  });

  it("FK populated but both snapshots null → rejected", () => {
    expect(() =>
      validateEventPayload("sterilization_performed", {
        procedure: "spay",
        performed_by: null,
        clinic: null,
        performed_by_organization_id: REAL_UUID,
      }),
    ).toThrow();
  });
});

describe("microchip_implanted — implanted_by FK pair", () => {
  it("legacy shape validates", () => {
    expect(() =>
      validateEventPayload("microchip_implanted", {
        chip_number: "941000123456789",
        country_code: null,
        implanted_by: "Vet Random",
        location_on_body: null,
      }),
    ).not.toThrow();
  });

  it("rejects implanted_by FK without snapshot", () => {
    expect(() =>
      validateEventPayload("microchip_implanted", {
        chip_number: "941000123456789",
        country_code: null,
        implanted_by: null,
        implanted_by_organization_id: REAL_UUID,
        location_on_body: null,
      }),
    ).toThrow();
  });
});
