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
  amendAuthorshipRefusal,
  applyAmendments,
  canAmendEvent,
  isAmendableEventType,
  latestAmendment,
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

  it("applies only the LATEST amendment when multiple exist", () => {
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
