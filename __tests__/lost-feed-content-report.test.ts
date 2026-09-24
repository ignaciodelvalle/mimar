// REPORTAR UN MENSAJE DEL FEED — the compliance affordance, against a real DB.
//
// WHAT THIS FILE HAS TO PROVE, and why each one is here rather than assumed:
//
//   1. THE ITEM DISAPPEARS from the owner's feed. This is the whole product
//      promise; without it the Google Play declaration that content "can be
//      reported" is a sentence with nothing behind it.
//   2. THE ROW IS STILL IN THE SPINE, byte for byte. "Ocultar" is a derivation
//      on read, never a mutation — invariant #2. A test that only checked the
//      feed would pass just as happily against an implementation that DELETED
//      the event, which is the one implementation this design refuses.
//   3. THE COUNTER AGREES WITH THE LIST. `sightingsCount` and the feed are two
//      queries; a clause applied to one of them shows an owner "3 avistajes"
//      above a list of two.
//   4. A SCAN CANNOT BE REPORTED. There is no author and no text on a QR read,
//      so the server refuses the target rather than trusting a client not to
//      offer the control.
//   5. THE TARGET GUARD IS PART OF AUTHORIZATION. The door guard says the caller
//      may touch pet A; it says nothing about an event id in the body. A holder
//      of A naming an event of B must be refused, or "hide" reaches across pets.
//   6. REPORTING TWICE APPENDS ONCE. The command carries no `Idempotency-Key`
//      because its writer is idempotent on the state, and that claim is only
//      worth making if something checks it.
//
// A NOTE ON HOW THESE FAIL — measured, not asserted. Removing
// `notReportedClause` from the FEED query fails three tests and leaves the
// counter one passing; removing it from the COUNT query fails exactly one and
// leaves the feed ones passing. That asymmetry is the proof the two queries are
// really two, which is the whole reason (3) is written down separately.
//
// THE DESTRUCTIVE ALTERNATIVE IS NOT MERELY UNTESTED, IT IS IMPOSSIBLE, and the
// last test in the first block proves it rather than trusting this comment: the
// `enforce_pet_events_append_only` trigger refuses any UPDATE or DELETE on
// `pet_events` without two session-local GUCs that no application code sets. An
// implementation that "hid" an item by deleting it could not have been written.

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { openCase } from "@/lib/infra/case-helpers";
import { getCaseDetailByPublicCode } from "@/lib/infra/case-queries";
import { fetchLostEpisodeForPet, fetchLostScanEvents } from "@/lib/infra/lost-mode";
import { reportLostFeedItem } from "@/src/modules/events/application/lifecycle/report-lost-feed-item-use-case";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";

import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";

const PET_TOKEN = "DIM-QA-REPORT-1";
/** A SECOND animal, so "the target belongs to somebody else" is a real fixture. */
const OTHER_TOKEN = "DIM-QA-REPORT-2";
const ALL_TOKENS = [PET_TOKEN, OTHER_TOKEN];

const AUTHORSHIP = { authorRole: "owner", authorOrganizationId: null, authorVerified: false };

const deps = {
  repo: new EventsRepository(),
  transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
    db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
};

let petId = "";
let caseId = "";
let otherPetId = "";
let otherSightingId = "";
let sightingId = "";
let finderId = "";
let scanId = "";
const cleanupPetIds: string[] = [];
const cleanupCaseIds: string[] = [];

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function createLostPet(token: string): Promise<{ petId: string; caseId: string }> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `ReportTestDog-${token.slice(-1)}`,
      species: "dog",
      sex: "unknown",
      status: "lost",
      potentiallyDangerousBreed: false,
    })
    .returning();

  let createdCaseId = "";
  await db.transaction(async (tx) => {
    const caseRow = await openCase(
      {
        kind: "lost_pet_episode",
        primarySubjectKind: "registered_pet",
        primaryPetId: pet.id,
        openedReason: {
          code: "pet_marked_lost",
          petPublicToken: null,
          ownerNote: "fixture de moderación",
        },
      },
      tx,
    );
    createdCaseId = caseRow.id;

    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "status_changed",
      occurredAt: new Date(),
      recordedAt: new Date(),
      authorRole: "owner",
      payload: validateEventPayload("status_changed", {
        from_status: "active",
        to_status: "lost",
        location_description: "Plaza San Martín",
        reason: null,
        disclosure_prefs_snapshot: {
          first_name: false,
          phone: false,
          email: false,
          last_location: true,
          finder_form: true,
        },
      }),
      caseId: caseRow.id,
    });
  });

  cleanupPetIds.push(pet.id);
  cleanupCaseIds.push(createdCaseId);
  return { petId: pet.id, caseId: createdCaseId };
}

/** The human-readable CAS code — the thing `/casos/{code}` is keyed on. */
async function casePublicCode(id: string): Promise<string> {
  const [row] = await db
    .select({ publicCode: cases.publicCode })
    .from(cases)
    .where(eq(cases.id, id))
    .limit(1);
  return row.publicCode;
}

/** An ANONYMOUS stranger's note — `authorRole: "scanner"`, no user id. */
async function addStrangerNote(
  targetPetId: string,
  targetCaseId: string,
  kind: "sighting" | "finder_in_possession",
  text: string,
  occurredAt: Date,
): Promise<string> {
  const payload =
    kind === "sighting"
      ? { category: "otro", text, kind }
      : { category: "otro", text, kind, finderName: "Vecina", finderContact: "11-5555-5555" };

  const [row] = await db
    .insert(petEvents)
    .values({
      petId: targetPetId,
      caseId: targetCaseId,
      eventType: "note_added",
      occurredAt,
      recordedAt: new Date(),
      authorRole: "scanner",
      authorVerified: false,
      recordedByUserId: null,
      payload: validateEventPayload("note_added", payload),
    })
    .returning({ id: petEvents.id });
  return row.id;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const token of ALL_TOKENS) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
  });

  const base = Date.now();
  const main = await createLostPet(PET_TOKEN);
  petId = main.petId;
  caseId = main.caseId;

  sightingId = await addStrangerNote(
    petId,
    caseId,
    "sighting",
    "Andá a buscarla vos, no pienso ayudarte.",
    new Date(base + 60_000),
  );
  finderId = await addStrangerNote(
    petId,
    caseId,
    "finder_in_possession",
    "La tengo en casa.",
    new Date(base + 120_000),
  );

  const [scanRow] = await db
    .insert(petEvents)
    .values({
      petId,
      caseId,
      eventType: "credential_scanned",
      occurredAt: new Date(base + 30_000),
      recordedAt: new Date(),
      authorRole: "scanner",
      authorVerified: false,
      recordedByUserId: null,
      payload: validateEventPayload("credential_scanned", {
        is_self_scan: false,
        viewer_authenticated: false,
      }),
    })
    .returning({ id: petEvents.id });
  scanId = scanRow.id;

  const other = await createLostPet(OTHER_TOKEN);
  otherPetId = other.petId;
  otherSightingId = await addStrangerNote(
    otherPetId,
    other.caseId,
    "sighting",
    "La vi cruzando la avenida.",
    new Date(base + 60_000),
  );
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of cleanupPetIds) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${id}`);
    }
    for (const id of cleanupCaseIds) {
      await tx.execute(sql`DELETE FROM cases WHERE id = ${id}`);
    }
    for (const id of cleanupPetIds) {
      await tx.execute(sql`DELETE FROM pets WHERE id = ${id}`);
    }
  });
});

async function feedIds(): Promise<string[]> {
  const items = await fetchLostScanEvents(petId, undefined, caseId);
  return items.map((item) => item.id);
}

async function countReports(): Promise<number> {
  const rows = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "content_reported")));
  return rows.length;
}

// ---------------------------------------------------------------------------
// The refusals — asserted BEFORE anything is reported, so a refusal that
// silently wrote something would show up as a missing feed row below.
// ---------------------------------------------------------------------------

describe("reportLostFeedItem — what it refuses", () => {
  it("refuses a credential_scanned target: a QR read has no author to have written it", async () => {
    const before = await countReports();
    const result = await reportLostFeedItem(
      {
        petId,
        targetEventId: scanId,
        category: "harassment",
        reason: null,
        recordedByUserId: null as unknown as string,
        eventAuthorship: AUTHORSHIP,
      },
      deps,
    );
    expect(result.error).toBe("TARGET_INVALID");
    expect(await countReports()).toBe(before);
  });

  it("refuses an event belonging to ANOTHER animal — the door guard does not cover the body", async () => {
    const before = await countReports();
    const result = await reportLostFeedItem(
      {
        petId,
        targetEventId: otherSightingId,
        category: "spam",
        reason: null,
        recordedByUserId: null as unknown as string,
        eventAuthorship: AUTHORSHIP,
      },
      deps,
    );
    expect(result.error).toBe("TARGET_INVALID");
    expect(await countReports()).toBe(before);

    // And the other animal's own feed is untouched by the attempt.
    const otherFeed = await fetchLostScanEvents(otherPetId);
    expect(otherFeed.map((i) => i.id)).toContain(otherSightingId);
  });

  it("refuses an id that names no event at all", async () => {
    const result = await reportLostFeedItem(
      {
        petId,
        targetEventId: "00000000-0000-0000-0000-0000000000ff",
        category: "other",
        reason: null,
        recordedByUserId: null as unknown as string,
        eventAuthorship: AUTHORSHIP,
      },
      deps,
    );
    expect(result.error).toBe("TARGET_INVALID");
  });

  it("THE DATABASE ITSELF refuses to delete a feed item — so 'hide' could only ever be a read", async () => {
    // The alternative design, attempted. `enforce_pet_events_append_only` wants
    // two session-local GUCs that only `withMutationOverride` (test-only) sets,
    // so no application path can reach this. The derivation is not the polite
    // choice among two workable ones; it is the only one that exists.
    await expectDbError(db.delete(petEvents).where(eq(petEvents.id, sightingId)), {
      constraint: /append.only|allow_event_mutation/i,
    });

    // And it is still there afterwards, which is what makes the assertion above
    // about the trigger rather than about a query that quietly matched nothing.
    const rows = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(eq(petEvents.id, sightingId));
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The effect
// ---------------------------------------------------------------------------

describe("reportLostFeedItem — hiding is a derivation, not a mutation", () => {
  it("the abusive sighting is in the feed before anybody reports it", async () => {
    // The control. Without it, every assertion below would also pass against a
    // feed that never contained the row.
    expect(await feedIds()).toContain(sightingId);
    const episode = await fetchLostEpisodeForPet(petId);
    expect(episode?.sightingsCount).toBe(1);
  });

  it("takes the reported sighting out of the owner's feed", async () => {
    const result = await reportLostFeedItem(
      {
        petId,
        targetEventId: sightingId,
        category: "harassment",
        reason: "Me insultó cuando le pregunté por mi perra.",
        recordedByUserId: null as unknown as string,
        eventAuthorship: AUTHORSHIP,
      },
      deps,
    );

    expect(result).toEqual({ error: null, alreadyReported: false });
    expect(await feedIds()).not.toContain(sightingId);
  });

  it("LEAVES THE EVENT IN THE SPINE, unmodified — invariant #2", async () => {
    const [row] = await db
      .select({ payload: petEvents.payload, eventType: petEvents.eventType })
      .from(petEvents)
      .where(eq(petEvents.id, sightingId));

    expect(row).toBeDefined();
    expect(row.eventType).toBe("note_added");
    // The words are still there. Nothing was blanked, flagged or soft-deleted:
    // the ONLY thing that changed is that a second event now names this one.
    expect((row.payload as Record<string, unknown>).text).toBe(
      "Andá a buscarla vos, no pienso ayudarte.",
    );
    expect((row.payload as Record<string, unknown>).kind).toBe("sighting");
  });

  it("writes the report as its own append-only event naming the target", async () => {
    const [report] = await db
      .select({ payload: petEvents.payload, caseId: petEvents.caseId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "content_reported")));

    const payload = report.payload as Record<string, unknown>;
    expect(payload.target_event_id).toBe(sightingId);
    expect(payload.target_kind).toBe("sighting");
    expect(payload.surface).toBe("lost_feed");
    expect(payload.category).toBe("harassment");
    // The free text lives under `reason` on purpose: `erase_subject_data`
    // sentinel-redacts that key across every event type, so the reporter's own
    // words are erasable with their account.
    expect(payload.reason).toBe("Me insultó cuando le pregunté por mi perra.");
    // Filed with the episode whose feed carried the item.
    expect(report.caseId).toBe(caseId);
  });

  it("stops counting the reported sighting, so the counter matches the list", async () => {
    const episode = await fetchLostEpisodeForPet(petId);
    expect(episode?.sightingsCount).toBe(0);
  });

  it("leaves every OTHER row in the feed alone", async () => {
    const ids = await feedIds();
    expect(ids).toContain(finderId);
    expect(ids).toContain(scanId);
  });

  it("reporting the same item again appends nothing and says so", async () => {
    const before = await countReports();
    const result = await reportLostFeedItem(
      {
        petId,
        targetEventId: sightingId,
        category: "spam",
        reason: "Otra vez.",
        recordedByUserId: null as unknown as string,
        eventAuthorship: AUTHORSHIP,
      },
      deps,
    );

    expect(result).toEqual({ error: null, alreadyReported: true });
    expect(await countReports()).toBe(before);
    expect(await feedIds()).not.toContain(sightingId);
  });

  it("a finder-in-possession message can be reported too", async () => {
    const result = await reportLostFeedItem(
      {
        petId,
        targetEventId: finderId,
        category: "false_information",
        reason: null,
        recordedByUserId: null as unknown as string,
        eventAuthorship: AUTHORSHIP,
      },
      deps,
    );

    expect(result.error).toBeNull();
    const ids = await feedIds();
    expect(ids).not.toContain(finderId);
    // The scan survives BOTH reports — it was never reportable in the first
    // place, and nothing here hides rows by association.
    expect(ids).toContain(scanId);
  });
});

// ---------------------------------------------------------------------------
// The surfaces a fresh-context review found still leaking
// ---------------------------------------------------------------------------
//
// The first delivery subtracted on four reads and claimed "every read". These
// two are the ones that mattered most, and neither is reachable from the
// cockpit: one is ANONYMOUS, the other is the product's own canonical scenario.

describe("a reported item leaves the surfaces beyond the cockpit", () => {
  it("is gone from the ANONYMOUS case timeline — /casos/{code}", async () => {
    // `lost_pet_episode` is in PUBLIC_ANONYMOUS_KINDS, so this timeline is
    // readable by anybody holding the CAS code — and CAS codes get shared in
    // order to publicise a search. Before the fix the abusive sighting left the
    // feed and both overlays and stayed here, verbatim, on a public URL.
    const code = await casePublicCode(caseId);
    const detail = await getCaseDetailByPublicCode(code);

    expect(detail).not.toBeNull();
    const ids = (detail?.events ?? []).map((entry) => entry.id);
    // NON-VACUITY: the timeline is really populated — the scan is still on it,
    // so an empty timeline cannot be what makes this pass.
    expect(ids).toContain(scanId);
    expect(ids).not.toContain(sightingId);
    expect(ids).not.toContain(finderId);
  });

  it("keeps the ORIGIN status_changed on that timeline — only the reported rows go", async () => {
    // The clause subtracts reported ITEMS, not the case's history.
    const code = await casePublicCode(caseId);
    const detail = await getCaseDetailByPublicCode(code);
    const types = (detail?.events ?? []).map((e) => e.eventType);
    expect(types).toContain("status_changed");
  });
});
