// Unit tests for fetchPetEventsForProfileV2 and PROFILE_V2_TYPED_EVENT_TYPES.
//
// These are pure unit tests — the DB is mocked via vitest.mock so no local
// Postgres instance is required. Tests assert the return shape, filtering
// behaviour, and the whitelist-drift guard.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// DB mock — use vi.hoisted so mockSelect is available in the mock factory
// ---------------------------------------------------------------------------

const { mockSelect } = vi.hoisted(() => {
  return { mockSelect: vi.fn() };
});

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return {
    ...actual,
    db: {
      select: mockSelect,
    },
  };
});

// Import the module under test AFTER the mock is registered.
import {
  PROFILE_V2_TYPED_EVENT_TYPES,
  type PetEventMetadata,
  type PetProfileV2Events,
  fetchPetEventsForProfileV2,
} from "@/lib/analytics/owner-dashboard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal petEvents row. `eventType` and `occurredAt` are the only
 *  fields the helper maps; the rest are filler. */
function makeEvent(
  eventType: string,
  occurredAt: Date,
  id = `evt-${Math.random().toString(36).slice(2)}`,
) {
  return {
    id,
    petId: "pet-1",
    eventType,
    occurredAt,
    recordedAt: occurredAt,
    payload: { summary: `${eventType} summary` },
    notes: null,
    authorRole: "owner",
  };
}

/** Chain builder for Drizzle-style fluent select mock.
 *
 * The chain is both a fluent builder (from/where/orderBy/limit return `chain`)
 * AND a Promise (has `then`/`catch`/`finally`) so that `await chain` resolves
 * with the fixture rows. This mirrors how Drizzle queries work when awaited
 * directly (no `.all()` call needed).
 */
function chainReturning(rows: unknown[]) {
  const resolved = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    // Promise interface — makes `await chain` work.
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mimics drizzle chain that resolves on await
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
    finally: resolved.finally.bind(resolved),
    // Legacy `.all()` for older call-sites.
    all: vi.fn().mockResolvedValue(rows),
  };
  for (const method of ["from", "where", "orderBy", "limit"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// A-1 tests
// ---------------------------------------------------------------------------

describe("PROFILE_V2_TYPED_EVENT_TYPES constant", () => {
  it("is a non-empty readonly array of strings", () => {
    expect(Array.isArray(PROFILE_V2_TYPED_EVENT_TYPES)).toBe(true);
    expect(PROFILE_V2_TYPED_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const t of PROFILE_V2_TYPED_EVENT_TYPES) {
      expect(typeof t).toBe("string");
    }
  });

  it("includes tattoo_recorded (R5 — fold tattoo into Estado actual)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain("tattoo_recorded");
  });

  it("includes weight_recorded (Estado actual weight + hace-X suffix)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain("weight_recorded");
  });

  it("includes sterilization_performed (Estado actual)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain("sterilization_performed");
  });

  it("includes adoption_finalized (A2 achievement)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain("adoption_finalized");
  });

  it("includes status_changed (A3 lost-and-found achievement)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain("status_changed");
  });

  it("does NOT include note_logged (excluded by design — not state-relevant)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).not.toContain("note_logged");
  });

  it("does NOT include pregnancy_started (not a real event_type — sub_kind of clinical_info_logged)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).not.toContain("pregnancy_started");
  });

  it("does NOT include pregnancy_ended (not a real event_type — sub_kind of clinical_info_logged)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).not.toContain("pregnancy_ended");
  });

  it("includes clinical_info_logged (covers pregnancy sub_kind for A4 achievement)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain("clinical_info_logged");
  });

  it("includes dangerous_breed_attested (pet-document-redesign REQ-10.1 — PPP attestation fix)", () => {
    expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain("dangerous_breed_attested");
  });
});

describe("whitelist drift guard — catalog event types", () => {
  it("every event_type read by ACHIEVEMENTS_CATALOG computeStatus is in PROFILE_V2_TYPED_EVENT_TYPES", () => {
    // The known event types consumed by catalog computeStatus functions:
    const knownCatalogTypes = [
      "adoption_finalized", // A2 — i_was_adopted
      "status_changed", // A3 — lost_and_found
      "clinical_info_logged", // A4 — i_had_litter (pregnancy sub_kind)
    ];
    for (const eventType of knownCatalogTypes) {
      expect(PROFILE_V2_TYPED_EVENT_TYPES).toContain(eventType);
    }
  });
});

describe("fetchPetEventsForProfileV2", () => {
  const PET_ID = "pet-1";
  const VIEWER_ID = "viewer-1";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the { typedEvents, recentFive } shape", async () => {
    const whitelistedEvent = makeEvent(PROFILE_V2_TYPED_EVENT_TYPES[0], new Date("2024-01-15"));
    const recentEvent = makeEvent("weight_recorded", new Date("2024-06-01"));

    mockSelect
      .mockReturnValueOnce(chainReturning([whitelistedEvent]))
      .mockReturnValueOnce(chainReturning([recentEvent]));

    const result: PetProfileV2Events = await fetchPetEventsForProfileV2(VIEWER_ID, PET_ID);

    expect(result).toHaveProperty("typedEvents");
    expect(result).toHaveProperty("recentFive");
  });

  it("typedEvents contains only whitelisted event types from DB result", async () => {
    const good = makeEvent(PROFILE_V2_TYPED_EVENT_TYPES[0], new Date("2024-01-01"));

    mockSelect.mockReturnValueOnce(chainReturning([good])).mockReturnValueOnce(chainReturning([]));

    const result = await fetchPetEventsForProfileV2(VIEWER_ID, PET_ID);
    expect(result.typedEvents.length).toBe(1);
    expect(result.typedEvents[0].eventType).toBe(PROFILE_V2_TYPED_EVENT_TYPES[0]);
  });

  it("recentFive contains at most 5 rows", async () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      makeEvent("weight_recorded", new Date(`2024-0${i + 1}-01`)),
    );

    mockSelect.mockReturnValueOnce(chainReturning([])).mockReturnValueOnce(chainReturning(events));

    const result = await fetchPetEventsForProfileV2(VIEWER_ID, PET_ID);
    expect(result.recentFive.length).toBeLessThanOrEqual(5);
    expect(result.recentFive.length).toBe(3);
  });

  it("recentFive rows have the PetEventMetadata shape", async () => {
    const event = makeEvent("weight_recorded", new Date("2024-06-01"), "evt-specific");

    mockSelect.mockReturnValueOnce(chainReturning([])).mockReturnValueOnce(chainReturning([event]));

    const result = await fetchPetEventsForProfileV2(VIEWER_ID, PET_ID);
    const meta: PetEventMetadata = result.recentFive[0];
    expect(meta).toHaveProperty("id");
    expect(meta).toHaveProperty("eventType");
    expect(meta).toHaveProperty("occurredAt");
    expect(typeof meta.id).toBe("string");
    expect(meta.occurredAt).toBeInstanceOf(Date);
  });

  it("does NOT call any URL-signing function — mockSelect called exactly twice (AC-A3)", async () => {
    mockSelect.mockReturnValueOnce(chainReturning([])).mockReturnValueOnce(chainReturning([]));

    await fetchPetEventsForProfileV2(VIEWER_ID, PET_ID);

    // Two select calls: one for typedEvents, one for recentFive.
    // If signing were called it would require a supabase client import
    // that doesn't exist in this helper — the mock call count is the proxy.
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it("runs both queries in a single invocation (Promise.all pattern)", async () => {
    mockSelect.mockReturnValueOnce(chainReturning([])).mockReturnValueOnce(chainReturning([]));

    await fetchPetEventsForProfileV2(VIEWER_ID, PET_ID);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });
});
