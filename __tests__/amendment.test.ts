// Unit tests for Wave 2 Item 15 — Correction by amendment.
//
// Coverage:
//   1. Zod schema validation for event_amended payload.
//   2. Projection: applyAmendments applies latest amendment to payload.
//   3. Allowlist enforcement: isAmendableEventType / canAmendEvent.
//   4. Capability gating: canAmendEvent rejects when viewerCanWriteEvents=false.
//   5. Libreta classification: event_amended is in NON_LIBRETA_EVENT_TYPES.
//   6. EVENT_TYPES includes event_amended.
//   7. Authorship (PO decision 3B): amendAuthorshipRefusal / resolveAmendActorStanding.
//
// No DB, no Supabase, no network — pure unit tests.

import { describe, expect, it } from "vitest";

import { EVENT_TYPES } from "@/db/schema";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  ADMIN_AMENDMENT_NOTIFICATION_TYPE,
  AMENDABLE_EVENT_TYPES,
  type AmendActor,
  ORG_AMENDMENT_SCOPE_REFUSAL_COPY,
  amendAuthorshipRefusal,
  amendBannerCopy,
  applyAmendments,
  canAmendEvent,
  isAmendableEventType,
  latestAmendment,
  orgAmendmentScopeRefusal,
  resolveAmendActorStanding,
} from "@/lib/infra/amendment";
import {
  LIBRETA_SANITARIA_EVENT_TYPES,
  NON_LIBRETA_EVENT_TYPES,
  isLibretaSanitariaEvent,
} from "@/lib/infra/libreta-sanitaria";

// ---------------------------------------------------------------------------
// 1. Zod schema: event_amended payload
// ---------------------------------------------------------------------------

describe("event_amended Zod schema", () => {
  const validPayload = {
    target_event_id: "a0000000-0000-4000-8000-000000000001",
    reason: "Fecha de vacunación incorrecta",
    changes: [{ field: "vaccine_name", old: "Antirrábica", new: "Sextuple" }],
    actor_role: "owner",
    actor_user_id: "a0000000-0000-4000-8000-000000000002",
  };

  it("accepts a valid payload", () => {
    expect(() => validateEventPayload("event_amended", validPayload)).not.toThrow();
  });

  it("fills in payload_version=1 by default", () => {
    const result = validateEventPayload("event_amended", validPayload) as Record<string, unknown>;
    expect(result.payload_version).toBe(1);
  });

  it("rejects empty changes array", () => {
    expect(() => validateEventPayload("event_amended", { ...validPayload, changes: [] })).toThrow();
  });

  it("rejects reason shorter than 5 chars", () => {
    expect(() =>
      validateEventPayload("event_amended", { ...validPayload, reason: "abc" }),
    ).toThrow();
  });

  it("accepts reason=null (optional for owner/vet)", () => {
    expect(() =>
      validateEventPayload("event_amended", { ...validPayload, reason: null }),
    ).not.toThrow();
  });

  it("rejects invalid actor_role value", () => {
    expect(() =>
      validateEventPayload("event_amended", { ...validPayload, actor_role: "superadmin" }),
    ).toThrow();
  });

  it("accepts all valid actor_role values", () => {
    for (const role of ["owner", "vet", "admin", "govt"]) {
      expect(() =>
        validateEventPayload("event_amended", { ...validPayload, actor_role: role }),
      ).not.toThrow();
    }
  });

  it("defaults actor_role to 'owner' when omitted", () => {
    const { actor_role: _omit, ...rest } = validPayload;
    const result = validateEventPayload("event_amended", rest) as Record<string, unknown>;
    expect(result.actor_role).toBe("owner");
  });

  it("rejects invalid target_event_id (not a UUID)", () => {
    expect(() =>
      validateEventPayload("event_amended", {
        ...validPayload,
        target_event_id: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("actor_user_id is optional (nullable)", () => {
    const { actor_user_id: _omit, ...rest } = validPayload;
    expect(() => validateEventPayload("event_amended", rest)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Projection: applyAmendments
// ---------------------------------------------------------------------------

describe("applyAmendments — projection helper", () => {
  const originalPayload = {
    vaccine_name: "Antirrábica",
    brand: "Laboratorio X",
    next_due_at: "2027-06-01",
    payload_version: 1,
  };

  it("returns original payload when no amendments", () => {
    expect(applyAmendments(originalPayload, [])).toEqual(originalPayload);
  });

  it("applies changes from a single amendment", () => {
    const amendments = [
      {
        id: "am-1",
        targetEventId: "ev-1",
        occurredAt: new Date("2026-06-19"),
        reason: "Nombre incorrecto",
        changes: [{ field: "vaccine_name", old: "Antirrábica", new: "Sextuple" }],
        actorRole: "owner",
      },
    ];
    const result = applyAmendments(originalPayload, amendments);
    expect(result.vaccine_name).toBe("Sextuple");
    // Unchanged fields preserved.
    expect(result.brand).toBe("Laboratorio X");
  });

  it("the latest amendment wins when several change the SAME field", () => {
    const amendments = [
      {
        id: "am-1",
        targetEventId: "ev-1",
        occurredAt: new Date("2026-06-01"),
        reason: "Primera corrección",
        changes: [{ field: "vaccine_name", old: "Antirrábica", new: "Sextuple" }],
        actorRole: "owner",
      },
      {
        id: "am-2",
        targetEventId: "ev-1",
        occurredAt: new Date("2026-06-19"),
        reason: "Segunda corrección",
        changes: [{ field: "vaccine_name", old: "Sextuple", new: "Triple felina" }],
        actorRole: "owner",
      },
    ];
    const result = applyAmendments(originalPayload, amendments);
    expect(result.vaccine_name).toBe("Triple felina");
  });

  // Custody audit C1 (2026-09-26): corrections carry only the fields they
  // changed, so folding just the latest one erased the first correction.
  it("keeps EVERY correction when later amendments change OTHER fields", () => {
    const amendments = [
      {
        id: "am-1",
        targetEventId: "ev-1",
        occurredAt: new Date("2026-06-01"),
        reason: "Nombre",
        changes: [{ field: "vaccine_name", old: "Antirrábica", new: "Sextuple" }],
        actorRole: "owner",
      },
      {
        id: "am-2",
        targetEventId: "ev-1",
        occurredAt: new Date("2026-06-19"),
        reason: "Vencimiento",
        changes: [{ field: "next_due_at", old: "2027-06-01", new: "2027-09-01" }],
        actorRole: "owner",
      },
    ];
    const result = applyAmendments(originalPayload, amendments);
    expect(result.vaccine_name).toBe("Sextuple");
    expect(result.next_due_at).toBe("2027-09-01");
    expect(result.brand).toBe("Laboratorio X");
  });

  it("does not mutate the original payload object", () => {
    const original = { vaccine_name: "Antirrábica", payload_version: 1 };
    const amendments = [
      {
        id: "am-1",
        targetEventId: "ev-1",
        occurredAt: new Date(),
        reason: null,
        changes: [{ field: "vaccine_name", old: "Antirrábica", new: "Sextuple" }],
        actorRole: "owner",
      },
    ];
    applyAmendments(original, amendments);
    expect(original.vaccine_name).toBe("Antirrábica");
  });

  it("latestAmendment returns null for empty array", () => {
    expect(latestAmendment([])).toBeNull();
  });

  it("latestAmendment returns the last element", () => {
    const am1 = {
      id: "am-1",
      targetEventId: "ev-1",
      occurredAt: new Date(),
      reason: null,
      changes: [],
      actorRole: "owner",
    };
    const am2 = {
      id: "am-2",
      targetEventId: "ev-1",
      occurredAt: new Date(),
      reason: null,
      changes: [],
      actorRole: "owner",
    };
    expect(latestAmendment([am1, am2])?.id).toBe("am-2");
  });
});

// ---------------------------------------------------------------------------
// 3. Allowlist enforcement (D4)
// ---------------------------------------------------------------------------

describe("isAmendableEventType — D4 allowlist", () => {
  it("returns true for each AMENDABLE_EVENT_TYPES member", () => {
    for (const t of AMENDABLE_EVENT_TYPES) {
      expect(isAmendableEventType(t), `Expected ${t} to be amendable`).toBe(true);
    }
  });

  const NOT_AMENDABLE = [
    "death_recorded",
    "incident_reported",
    "rabies_observation_started",
    "rabies_observation_ended",
    "disease_reported",
    "adoption_finalized",
    "adoption_reversed",
    "custody_dispute_raised",
    "event_amended", // meta-event is not self-amendable via the allowlist
  ] as const;

  it.each(NOT_AMENDABLE)('returns false for "%s"', (t) => {
    expect(isAmendableEventType(t)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Capability gating (D3)
// ---------------------------------------------------------------------------

describe("canAmendEvent — D3 capability check", () => {
  it("allows when event is amendable and viewer can write", () => {
    expect(
      canAmendEvent({ eventType: "vaccination_administered", viewerCanWriteEvents: true }),
    ).toBe(true);
  });

  it("blocks when event is not amendable even if viewer can write", () => {
    expect(canAmendEvent({ eventType: "death_recorded", viewerCanWriteEvents: true })).toBe(false);
  });

  it("blocks when viewer cannot write even if event type is amendable", () => {
    expect(
      canAmendEvent({ eventType: "vaccination_administered", viewerCanWriteEvents: false }),
    ).toBe(false);
  });

  it("blocks when both conditions fail", () => {
    expect(canAmendEvent({ eventType: "death_recorded", viewerCanWriteEvents: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Libreta classification: event_amended must be NON_LIBRETA
// ---------------------------------------------------------------------------

describe("event_amended libreta classification", () => {
  it("event_amended is NOT in LIBRETA_SANITARIA_EVENT_TYPES", () => {
    expect(LIBRETA_SANITARIA_EVENT_TYPES).not.toContain("event_amended");
  });

  it("event_amended IS in NON_LIBRETA_EVENT_TYPES", () => {
    expect(NON_LIBRETA_EVENT_TYPES).toContain("event_amended");
  });

  it("isLibretaSanitariaEvent returns false for event_amended", () => {
    expect(isLibretaSanitariaEvent("event_amended")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. EVENT_TYPES catalog includes event_amended
// ---------------------------------------------------------------------------

describe("EVENT_TYPES catalog", () => {
  it("includes event_amended", () => {
    expect(EVENT_TYPES).toContain("event_amended");
  });
});

// ---------------------------------------------------------------------------
// 7. Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("ADMIN_AMENDMENT_NOTIFICATION_TYPE is the expected string", () => {
    expect(ADMIN_AMENDMENT_NOTIFICATION_TYPE).toBe("admin_event_amended");
  });
});

// ---------------------------------------------------------------------------
// 7. Authorship — PO decision 3B (2026-09-22), hardened by the fresh-context
//    security review of the same day.
// ---------------------------------------------------------------------------

const OWNER_SIG = { authorRole: "owner", authorVerified: false };
const VET_SIG = { authorRole: "vet", authorVerified: true };
const SHELTER_SIG = { authorRole: "shelter", authorVerified: false };

describe("resolveAmendActorStanding", () => {
  it("gives admin and govt profiles the override, whatever they sign", () => {
    expect(resolveAmendActorStanding("admin", OWNER_SIG)).toBe("override");
    expect(resolveAmendActorStanding("govt", SHELTER_SIG)).toBe("override");
  });

  it("gives professional standing ONLY to a verified org signature", () => {
    expect(resolveAmendActorStanding("owner", VET_SIG)).toBe("verified_professional");
    // The org path signs `shelter` + unverified for a member WITHOUT a validated
    // matrícula — that is not professional standing.
    expect(resolveAmendActorStanding("owner", SHELTER_SIG)).toBe("org_member");
  });

  it("keeps a vet PROFILE acting on the person path a person — they sign as owner", () => {
    expect(resolveAmendActorStanding("vet", OWNER_SIG)).toBe("person");
    expect(resolveAmendActorStanding(null, OWNER_SIG)).toBe("person");
  });
});

describe("amendAuthorshipRefusal", () => {
  const ME = "u-me";
  const TENURE_2020_2022 = { startedAt: "2020-01-01T00:00:00Z", endedAt: "2022-01-01T00:00:00Z" };
  const person: AmendActor = { userId: ME, standing: "person", titularTenures: [] };
  const orgMember: AmendActor = { userId: ME, standing: "org_member", titularTenures: [] };

  it("lets a person correct their own record", () => {
    expect(amendAuthorshipRefusal(person, [{ authorRole: "owner", recordedByUserId: ME }])).toBe(
      null,
    );
  });

  it("refuses a person on every professional author role", () => {
    for (const authorRole of ["vet", "shelter", "govt"]) {
      expect(amendAuthorshipRefusal(person, [{ authorRole, recordedByUserId: ME }])).toBe(
        "professional_authored",
      );
    }
  });

  it("refuses a person on a record someone else wrote", () => {
    expect(
      amendAuthorshipRefusal(person, [{ authorRole: "owner", recordedByUserId: "u-other" }]),
    ).toBe("not_author");
  });

  it("refuses a person once an admin or govt correction sits on their record", () => {
    for (const actorRole of ["admin", "govt"]) {
      expect(
        amendAuthorshipRefusal(person, [
          { authorRole: "owner", recordedByUserId: ME },
          { authorRole: "owner", recordedByUserId: "u-staff", actorRole },
        ]),
      ).toBe("professional_authored");
    }
  });

  it("lets a vet-profile owner re-correct their own person-path correction", () => {
    expect(
      amendAuthorshipRefusal(person, [
        { authorRole: "owner", recordedByUserId: ME },
        { authorRole: "owner", recordedByUserId: ME, actorRole: "vet" },
      ]),
    ).toBe(null);
  });

  it("gives a legacy owner row to a person only when a tenure covers its recorded_at", () => {
    const legacy = (recordedAt: string) => [
      { authorRole: "owner", recordedByUserId: null, recordedAt },
    ];
    const held = { ...person, titularTenures: [TENURE_2020_2022] };
    expect(amendAuthorshipRefusal(held, legacy("2021-06-01T00:00:00Z"))).toBe(null);
    // Written before the tenure started — the PREVIOUS owner's row.
    expect(amendAuthorshipRefusal(held, legacy("2019-06-01T00:00:00Z"))).toBe("not_author");
    // Written after it ended — the NEXT owner's row.
    expect(amendAuthorshipRefusal(held, legacy("2022-06-01T00:00:00Z"))).toBe("not_author");
    // No tenure read at all — nobody's.
    expect(amendAuthorshipRefusal(person, legacy("2021-06-01T00:00:00Z"))).toBe("not_author");
  });

  it("gives an open tenure every legacy row from its start on", () => {
    const open = {
      ...person,
      titularTenures: [{ startedAt: "2020-01-01T00:00:00Z", endedAt: null }],
    };
    expect(
      amendAuthorshipRefusal(open, [
        { authorRole: "owner", recordedByUserId: null, recordedAt: "2025-01-01T00:00:00Z" },
      ]),
    ).toBe(null);
  });

  it("gives a legacy row of any OTHER author role to nobody on the person path", () => {
    const held = { ...person, titularTenures: [TENURE_2020_2022] };
    expect(
      amendAuthorshipRefusal(held, [
        { authorRole: "system", recordedByUserId: null, recordedAt: "2021-01-01T00:00:00Z" },
      ]),
    ).toBe("not_author");
  });

  it("lets an unverified org member correct only what they wrote", () => {
    expect(
      amendAuthorshipRefusal(orgMember, [{ authorRole: "shelter", recordedByUserId: ME }]),
    ).toBe(null);
    expect(
      amendAuthorshipRefusal(orgMember, [{ authorRole: "shelter", recordedByUserId: "u-colega" }]),
    ).toBe("not_author");
    expect(
      amendAuthorshipRefusal(orgMember, [{ authorRole: "owner", recordedByUserId: "u-owner" }]),
    ).toBe("not_author");
  });

  it("refuses an unverified org member on a VERIFIED record, even their own", () => {
    expect(
      amendAuthorshipRefusal(orgMember, [
        { authorRole: "vet", authorVerified: true, recordedByUserId: "u-vet" },
      ]),
    ).toBe("professional_authored");
    expect(
      amendAuthorshipRefusal(orgMember, [
        { authorRole: "shelter", recordedByUserId: ME },
        { authorRole: "vet", authorVerified: true, recordedByUserId: "u-vet", actorRole: "vet" },
      ]),
    ).toBe("professional_authored");
  });

  it("lets verified professionals and overrides through, including onto an owner's entry", () => {
    const vetRecord = [{ authorRole: "vet", authorVerified: true, recordedByUserId: "u-vet" }];
    const ownerRecord = [{ authorRole: "owner", recordedByUserId: "u-owner" }];
    for (const standing of ["verified_professional", "override"] as const) {
      const actor: AmendActor = { userId: ME, standing, titularTenures: [] };
      expect(amendAuthorshipRefusal(actor, vetRecord)).toBe(null);
      expect(amendAuthorshipRefusal(actor, ownerRecord)).toBe(null);
    }
  });
});

// ---------------------------------------------------------------------------
// portal-vet-p0 — the org door's scope (PO decision 2026-09-30)
// ---------------------------------------------------------------------------

describe("orgAmendmentScopeRefusal — a clinic corrects its own records", () => {
  const VERIFIED = { userId: "vet-a", organizationId: "clinic-a", authorVerified: true };

  it("allows a verified member when root and every correction are this clinic's", () => {
    expect(
      orgAmendmentScopeRefusal(VERIFIED, [
        { authorOrganizationId: "clinic-a" },
        { authorOrganizationId: "clinic-a" },
      ]),
    ).toBeNull();
  });

  it("is not signer-only: a colleague (different user) of the same clinic passes", () => {
    // The subjects carry no signer id at all — the rule is the ORGANIZATION.
    expect(
      orgAmendmentScopeRefusal({ ...VERIFIED, userId: "vet-b" }, [
        { authorOrganizationId: "clinic-a" },
      ]),
    ).toBeNull();
  });

  it("refuses an unverified signer before anything else", () => {
    expect(
      orgAmendmentScopeRefusal({ ...VERIFIED, authorVerified: false }, [
        { authorOrganizationId: "clinic-a" },
      ]),
    ).toBe("unverified_signer");
  });

  it("refuses another clinic's record", () => {
    expect(orgAmendmentScopeRefusal(VERIFIED, [{ authorOrganizationId: "clinic-b" }])).toBe(
      "other_author",
    );
  });

  it("refuses an owner entry (no organization)", () => {
    expect(orgAmendmentScopeRefusal(VERIFIED, [{ authorOrganizationId: null }])).toBe(
      "other_author",
    );
    expect(orgAmendmentScopeRefusal(VERIFIED, [{}])).toBe("other_author");
  });

  it("refuses when ANY correction in the chain is not this clinic's (admin, owner, other clinic)", () => {
    for (const intruder of [null, "clinic-b"]) {
      expect(
        orgAmendmentScopeRefusal(VERIFIED, [
          { authorOrganizationId: "clinic-a" },
          { authorOrganizationId: intruder },
        ]),
      ).toBe("other_author");
    }
  });

  it("refuses an empty subject list rather than passing vacuously", () => {
    expect(orgAmendmentScopeRefusal(VERIFIED, [])).toBe("other_author");
  });

  it("has es-AR copy for every refusal", () => {
    expect(Object.keys(ORG_AMENDMENT_SCOPE_REFUSAL_COPY).sort()).toEqual([
      "other_author",
      "unverified_signer",
    ]);
  });
});

describe("amendBannerCopy — never promises a correction the viewer cannot make", () => {
  const BASE = "Este registro no se puede editar ni borrar — la libreta es un historial inmutable.";

  it("offers the correction only to an owner the rule admits", () => {
    expect(amendBannerCopy(null, "owner")).toBe(
      `${BASE} Si hay un dato incorrecto, podés registrar una corrección que queda acreditada en el historial.`,
    );
  });

  it("tells the owner only a professional can correct a professional record", () => {
    const copy = amendBannerCopy("professional_authored", "owner");
    expect(copy).toBe(
      `${BASE} Lo cargó o lo corrigió un profesional: solo un profesional puede corregirlo.`,
    );
    expect(copy).not.toContain("podés registrar");
  });

  it("says the record was corrected by a professional, without naming anyone", () => {
    expect(amendBannerCopy("professional_authored", "owner", true)).toBe(
      `${BASE} Fue corregido por un profesional; el registro original sigue en el historial. Solo un profesional puede corregirlo.`,
    );
  });

  it("names the author rule on someone else's entry", () => {
    expect(amendBannerCopy("not_author", "owner")).toBe(
      `${BASE} Solo quien lo cargó puede corregirlo.`,
    );
  });

  it("promises nothing to a non-owner path", () => {
    expect(amendBannerCopy(null, "org")).toBe(BASE);
    expect(amendBannerCopy(null, null)).toBe(BASE);
  });
});
