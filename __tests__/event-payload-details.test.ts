import { describe, expect, it } from "vitest";

import { eventPayloadDetails } from "@/lib/events/events";

describe("eventPayloadDetails — curated es-AR whitelist (H3)", () => {
  it("returns es-AR labels for a vaccination", () => {
    const rows = eventPayloadDetails("vaccination_administered", {
      vaccine_name: "Antirrábica",
      brand: "Nobivac",
      administered_by: "Dra. Pérez",
      next_due_at: "2027-01-01",
    });
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("Vacuna");
    expect(labels).toContain("Marca");
    expect(labels).toContain("Aplicada por");
    expect(labels).toContain("Próxima dosis");
    expect(rows.find((r) => r.label === "Vacuna")?.value).toBe("Antirrábica");
  });

  it("maps enum codes to es-AR labels (sterilization, dangerous breed)", () => {
    const ster = eventPayloadDetails("sterilization_performed", { procedure: "castration" });
    expect(ster.find((r) => r.label === "Procedimiento")?.value).toBe("castración");

    const ppp = eventPayloadDetails("dangerous_breed_attested", { registry: "caba_4078" });
    expect(ppp.find((r) => r.label === "Registro")?.value).toBe("CABA · Ley 4078");
  });

  it("never emits internal identifiers, hashes, or raw ids", () => {
    const rows = eventPayloadDetails("vaccination_administered", {
      vaccine_name: "Antirrábica",
      administered_by_organization_id: "org-SECRET-123",
      administered_by_user_id: "user-SECRET-456",
      firma_hash: "deadbeefHASH",
      matched_chip_number: "999",
    });
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain("SECRET");
    expect(blob).not.toContain("deadbeef");
    expect(blob).not.toContain("_id");
    expect(blob.toLowerCase()).not.toContain("hash");
    // The safe field still comes through.
    expect(rows.find((r) => r.label === "Vacuna")?.value).toBe("Antirrábica");
  });

  it("microchip surfaces the number but not internal implant ids", () => {
    const rows = eventPayloadDetails("microchip_implanted", {
      chip_number: "982000123456789",
      implanted_by: "Dr. Gómez",
      implanted_by_organization_id: "org-SECRET",
    });
    expect(rows.find((r) => r.label === "Número")?.value).toBe("982000123456789");
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  it("weight is rendered with its unit and an es-AR comma (never the stored dot)", () => {
    // The payload stores kg as a toFixed(2) STRING ("12.50") — an English
    // decimal point. This assertion used to expect that dot verbatim, so the
    // test defended the locale bug on a citizen-facing surface.
    expect(
      eventPayloadDetails("weight_recorded", { kg: "12.5" }).find((r) => r.label === "Peso")?.value,
    ).toBe("12,5 kg");
    // A trailing storage zero is not a measurement — "12.50" is 12,5.
    expect(
      eventPayloadDetails("weight_recorded", { kg: "12.50" }).find((r) => r.label === "Peso")
        ?.value,
    ).toBe("12,5 kg");
    // A genuine second decimal survives.
    expect(
      eventPayloadDetails("weight_recorded", { kg: "22.75" }).find((r) => r.label === "Peso")
        ?.value,
    ).toBe("22,75 kg");
  });

  it("unknown event type → []", () => {
    expect(eventPayloadDetails("pet_registered", { foo: "bar" })).toEqual([]);
    expect(eventPayloadDetails("credential_scanned", {})).toEqual([]);
  });
});
