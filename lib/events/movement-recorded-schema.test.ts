// Tests for the movement_recorded event (movilidad-jurisdiccional Fase 1).
// Covers spec R1.1-R1.2 and acceptance scenarios S1 (sub_kind discrimination),
// S2 (no-op jurisdiction change rejected), S3 (corridor id enforcement),
// plus R1.5 (amendable allowlist) and the timeline rendering cases.

import { describe, expect, it } from "vitest";

import { EVENT_TYPES } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { eventPayloadDetails, eventPayloadSummary } from "@/lib/events/events";
import { AMENDABLE_EVENT_TYPES } from "@/lib/infra/amendment";
import { eventTypeLabel } from "@/lib/utils/format";

// ---------------------------------------------------------------------------
// Fixtures — one canonical valid payload per sub_kind
// ---------------------------------------------------------------------------

const JURISDICTION_CHANGED = {
  sub_kind: "jurisdiction_changed",
  from_country: "AR",
  from_province: "Ciudad Autónoma de Buenos Aires",
  from_locality: null,
  to_country: "AR",
  to_province: "Buenos Aires",
  to_locality: "La Plata",
  effective_date: "2026-07-01",
  reason: null,
};

const CVI_ISSUED = {
  sub_kind: "cvi_issued",
  origin_country: "UY",
  cvi_number: "CVI-2026-000123",
  issuing_authority: "MGAP Uruguay",
  issued_date: "2026-06-20",
  chip_iso_country_code: null,
};

const TRANSPORT_RECORDED = {
  sub_kind: "transport_recorded",
  corridor_id: "chile",
  direction: "outbound_from_ar",
  travel_date: "2026-08-15",
  mode: "land",
  purpose: null,
};

describe("movement_recorded — registration (R1.1, R1.6)", () => {
  it("movement_recorded is a registered EVENT_TYPE (TEXT column, no migration)", () => {
    expect(EVENT_TYPES).toContain("movement_recorded");
  });

  it("movement_recorded is amendable via event_amended (R1.5)", () => {
    expect(AMENDABLE_EVENT_TYPES).toContain("movement_recorded");
  });

  it("has an es-AR timeline label", () => {
    expect(
      eventTypeLabel("movement_recorded" as (typeof EVENT_TYPES)[number]).length,
    ).toBeGreaterThan(0);
  });
});

describe("movement_recorded — jurisdiction_changed sub_kind", () => {
  it("accepts a complete jurisdiction change", () => {
    expect(() => validateEventPayload("movement_recorded", JURISDICTION_CHANGED)).not.toThrow();
  });

  it("fills payload_version=1 on parse", () => {
    const parsed = validateEventPayload("movement_recorded", JURISDICTION_CHANGED) as Record<
      string,
      unknown
    >;
    expect(parsed.payload_version).toBe(1);
  });

  it("S1: rejects a jurisdiction_changed payload missing the to_* fields", () => {
    const { to_country, to_province, to_locality, ...rest } = JURISDICTION_CHANGED;
    expect(() => validateEventPayload("movement_recorded", rest)).toThrow();
  });

  it("S2: rejects a no-op move (from_* fully identical to to_*)", () => {
    expect(() =>
      validateEventPayload("movement_recorded", {
        ...JURISDICTION_CHANGED,
        to_country: JURISDICTION_CHANGED.from_country,
        to_province: JURISDICTION_CHANGED.from_province,
        to_locality: JURISDICTION_CHANGED.from_locality,
      }),
    ).toThrow();
  });

  it("accepts a same-province move when the locality differs (not a no-op)", () => {
    expect(() =>
      validateEventPayload("movement_recorded", {
        ...JURISDICTION_CHANGED,
        from_province: "Buenos Aires",
        from_locality: "Quilmes",
        to_province: "Buenos Aires",
        to_locality: "La Plata",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // L2-3 / L2-5 — the catalogue ROW, and the correction the names refused
  // -------------------------------------------------------------------------

  it("records WHICH catalogue row each side names", () => {
    const parsed = validateEventPayload("movement_recorded", {
      ...JURISDICTION_CHANGED,
      from_locality_id: "11111111-1111-4111-8111-111111111111",
      to_locality_id: "22222222-2222-4222-8222-222222222222",
    }) as Record<string, unknown>;
    expect(parsed.from_locality_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.to_locality_id).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("accepts a move between two SAME-NAMED localities of one province", () => {
    // THE CORRECTION THE OLD RULE REFUSED. The INDEC catalogue carries 68
    // (province, name) collisions — four "San Pedro"s in Santiago del Estero —
    // so an animal filed against the wrong one has a destination whose province
    // AND locality text match its origin exactly. Comparing only the three text
    // fields made that payload a "no-op" and the correcting move impossible.
    expect(() =>
      validateEventPayload("movement_recorded", {
        ...JURISDICTION_CHANGED,
        from_province: "Santiago del Estero",
        from_locality: "San Pedro",
        from_locality_id: "11111111-1111-4111-8111-111111111111",
        to_province: "Santiago del Estero",
        to_locality: "San Pedro",
        to_locality_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).not.toThrow();
  });

  it("still rejects a no-op when both sides name the SAME row", () => {
    // NON-VACUITY for the case above: the ids are what make it a move, not the
    // mere presence of the two new fields.
    expect(() =>
      validateEventPayload("movement_recorded", {
        ...JURISDICTION_CHANGED,
        from_province: "Santiago del Estero",
        from_locality: "San Pedro",
        from_locality_id: "11111111-1111-4111-8111-111111111111",
        to_province: "Santiago del Estero",
        to_locality: "San Pedro",
        to_locality_id: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow();
  });

  it("still rejects a no-op when only ONE side names a row", () => {
    // A legacy pet whose locality_id was never resolved, or a destination the
    // catalogue does not know: there is nothing to compare but the text, and the
    // text rule stands. Half an id must not become a licence to append a
    // non-event.
    for (const half of [
      { from_locality_id: "11111111-1111-4111-8111-111111111111" },
      { to_locality_id: "11111111-1111-4111-8111-111111111111" },
      { from_locality_id: null, to_locality_id: "11111111-1111-4111-8111-111111111111" },
    ]) {
      expect(() =>
        validateEventPayload("movement_recorded", {
          ...JURISDICTION_CHANGED,
          to_country: JURISDICTION_CHANGED.from_country,
          to_province: JURISDICTION_CHANGED.from_province,
          to_locality: JURISDICTION_CHANGED.from_locality,
          ...half,
        }),
      ).toThrow();
    }
  });

  it("rejects a locality id that is not a uuid", () => {
    // The column it mirrors is a uuid FK; a free-text id here would be a value
    // no rederivation could resolve.
    expect(() =>
      validateEventPayload("movement_recorded", {
        ...JURISDICTION_CHANGED,
        to_locality_id: "620105",
      }),
    ).toThrow();
  });

  it("rejects extra keys (strict mode)", () => {
    expect(() =>
      validateEventPayload("movement_recorded", {
        ...JURISDICTION_CHANGED,
        unknown_field: "nope",
      }),
    ).toThrow();
  });
});

describe("movement_recorded — cvi_issued sub_kind", () => {
  it("accepts a complete CVI record", () => {
    expect(() => validateEventPayload("movement_recorded", CVI_ISSUED)).not.toThrow();
  });

  it("rejects a CVI without cvi_number (both-or-nothing, R1.2)", () => {
    expect(() =>
      validateEventPayload("movement_recorded", { ...CVI_ISSUED, cvi_number: "" }),
    ).toThrow();
  });

  it("rejects a CVI without issuing_authority (both-or-nothing, R1.2)", () => {
    expect(() =>
      validateEventPayload("movement_recorded", { ...CVI_ISSUED, issuing_authority: "" }),
    ).toThrow();
  });

  it("S1: rejects a cvi_issued payload carrying jurisdiction_changed fields", () => {
    expect(() =>
      validateEventPayload("movement_recorded", { ...CVI_ISSUED, to_country: "AR" }),
    ).toThrow();
  });
});

describe("movement_recorded — transport_recorded sub_kind", () => {
  it("accepts a trip on a registered corridor", () => {
    expect(() => validateEventPayload("movement_recorded", TRANSPORT_RECORDED)).not.toThrow();
  });

  it("S3: rejects a 6th corridor at the schema level", () => {
    expect(() =>
      validateEventPayload("movement_recorded", { ...TRANSPORT_RECORDED, corridor_id: "mexico" }),
    ).toThrow();
  });

  it("rejects an inbound direction (Fase 1 is outbound_from_ar only)", () => {
    expect(() =>
      validateEventPayload("movement_recorded", {
        ...TRANSPORT_RECORDED,
        direction: "inbound_to_ar",
      }),
    ).toThrow();
  });

  it("rejects an unknown sub_kind entirely", () => {
    expect(() =>
      validateEventPayload("movement_recorded", { ...TRANSPORT_RECORDED, sub_kind: "teleport" }),
    ).toThrow();
  });
});

describe("movement_recorded — timeline rendering (es-AR)", () => {
  it("summarizes a jurisdiction change with origin → destination", () => {
    const s = eventPayloadSummary("movement_recorded", JURISDICTION_CHANGED);
    expect(s.primary).toContain("jurisdicción");
    expect(s.secondary).toContain("La Plata");
  });

  it("summarizes a CVI with its number", () => {
    const s = eventPayloadSummary("movement_recorded", CVI_ISSUED);
    expect(s.primary).toContain("CVI");
    expect(s.secondary).toContain("CVI-2026-000123");
  });

  it("summarizes a transport with the corridor label", () => {
    const s = eventPayloadSummary("movement_recorded", TRANSPORT_RECORDED);
    expect(s.primary).toContain("Viaje");
    expect(s.secondary).toContain("Chile");
  });

  it("renders whitelisted detail rows for a jurisdiction change", () => {
    const rows = eventPayloadDetails("movement_recorded", JURISDICTION_CHANGED);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.value)).toContain("La Plata");
  });

  it("renders detail rows for a CVI without leaking unknown keys", () => {
    const rows = eventPayloadDetails("movement_recorded", CVI_ISSUED);
    expect(rows.map((r) => r.value)).toContain("MGAP Uruguay");
  });
});
