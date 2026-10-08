import { describe, expect, it } from "vitest";

import { eventPayloadDetails, eventPayloadSummary, formatPayloadDay } from "@/lib/events/events";

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

  it("transport mode is capitalized for display, on the same payload field", () => {
    // Surface audit 2026-10-07 (QW14): "Medio: terrestre" was the one lowercase
    // value on the asiento.
    const medio = (mode: string) => {
      const payload = { sub_kind: "transport_recorded", mode };
      const row = eventPayloadDetails("movement_recorded", payload).find(
        (r) => r.label === "Medio",
      );
      return row;
    };
    expect(medio("land")).toEqual({ label: "Medio", value: "Terrestre", field: "mode" });
    expect(medio("air")?.value).toBe("Aéreo");
    expect(medio("sea")?.value).toBe("Marítimo");
  });

  it("unknown event type → []", () => {
    expect(eventPayloadDetails("pet_registered", { foo: "bar" })).toEqual([]);
    expect(eventPayloadDetails("credential_scanned", {})).toEqual([]);
  });
});

// QA v14 P2b/P2c (2026-10-07).
describe("a 'Lo tengo' papers tick says which paper it marked", () => {
  const tick = (oldDocs: string[], newDocs: string[]) => ({
    target_event_id: "trip-1",
    changes: [{ field: "documents_confirmed", old: oldDocs, new: newDocs }],
  });

  it("names the paper marked as ready", () => {
    expect(
      eventPayloadDetails("event_amended", tick(["Certificado"], ["Certificado", "CVI"])),
    ).toEqual([{ label: "Marcado como listo", value: "CVI", field: "documents_confirmed" }]);
  });

  it("names the paper taken back", () => {
    expect(eventPayloadDetails("event_amended", tick(["Certificado", "CVI"], ["CVI"]))).toEqual([
      { label: "Desmarcado", value: "Certificado", field: "documents_confirmed" },
    ]);
  });

  it("is titled like the libreta row, not 'Corrección registrada'", () => {
    expect(eventPayloadSummary("event_amended", tick([], ["CVI"])).primary).toBe(
      "Papeles del viaje actualizados",
    );
  });

  it("a real correction still yields no rows here and no title of its own", () => {
    const correction = { target_event_id: "x", changes: [{ field: "brand", old: "A", new: "B" }] };
    expect(eventPayloadDetails("event_amended", correction)).toEqual([]);
    expect(eventPayloadSummary("event_amended", correction).primary).toBeNull();
  });
});

describe("a trip's summary line prints the es-AR date, never the raw ISO day", () => {
  it("'Estados Unidos · 6/11/2026', the same date the detail row prints", () => {
    const payload = {
      sub_kind: "transport_recorded",
      corridor_id: "usa",
      travel_date: "2026-11-06",
      mode: "air",
    };
    const summary = eventPayloadSummary("movement_recorded", payload);
    expect(summary.secondary).toBe("Estados Unidos · 6/11/2026");
    expect(summary.secondary).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const row = eventPayloadDetails("movement_recorded", payload).find(
      (r) => r.field === "travel_date",
    );
    expect(summary.secondary).toContain(row?.value ?? "missing");
    expect(formatPayloadDay("2026-11-06")).toBe("6/11/2026");
  });
});
