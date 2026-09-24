// Integration tests for the attachments.at_most_one_parent CHECK constraint
// (ARCH-D P1).
//
// Invariant enforced by migration 0078:
//   num_nonnulls(approval_request_id, audit_log_id) <= 1
//   AND (
//     (approval_request_id IS NULL AND audit_log_id IS NULL)
//     OR  (pet_id IS NULL AND event_id IS NULL)
//   )
//
// In plain English:
//   - approval_request_id and audit_log_id are mutually exclusive.
//   - Any approval-flow parent (approval_request_id or audit_log_id) is
//     mutually exclusive with any content parent (pet_id or event_id).
//   - Zero parents is allowed (staging window for revocation evidence).
//   - Content parents (pet_id + event_id) may coexist (event attachments
//     carry both by design — pet_id is de-normalised alongside event_id).
//
// These tests use raw Drizzle inserts against the real local DB to exercise
// the constraint at the Postgres layer. They do NOT go through action wrappers.

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { attachments, db, petEvents, pets } from "@/db";
import { expectDbError } from "./_helpers/expect-db-error";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_PATH_PREFIX = "test/arch-d-xor";

/** Seed IDs collected per test — deleted in afterEach. */
const seedIds: string[] = [];

async function cleanUp() {
  if (seedIds.length === 0) return;
  await db
    .delete(attachments)
    .where(sql`id = ANY(ARRAY[${sql.raw(seedIds.map((id) => `'${id}'`).join(","))}]::uuid[])`);
  seedIds.length = 0;
}

/**
 * Insert an attachments row with the given parent FKs.
 * Throws with the Postgres constraint name in the message if the CHECK fires.
 */
async function tryInsert(
  values: Partial<typeof attachments.$inferInsert> & {
    storagePath?: string;
    mimeType?: string;
  },
): Promise<string> {
  const idx = seedIds.length;
  const [row] = await db
    .insert(attachments)
    .values({
      storagePath: `${STORAGE_PATH_PREFIX}/${idx}-${Date.now()}.jpg`,
      mimeType: "image/jpeg",
      ...values,
    })
    .returning({ id: attachments.id });
  seedIds.push(row.id);
  return row.id;
}

// ---------------------------------------------------------------------------
// Resolve stable parent IDs (real rows needed for FK validity)
// ---------------------------------------------------------------------------

/**
 * Resolve an existing pet id for FK use.
 *
 * THROWS on an empty table. It used to return null, and the two callers below
 * turned that into `console.warn("SKIP: ...")` + `return` — a pass. The ALLOWED
 * half of this file is what proves the CHECK constraint is not simply refusing
 * everything, so an empty `pets` table silently deleted the positive controls
 * and left only the negative ones, which a constraint that rejects all inserts
 * also satisfies. `pnpm db:bootstrap` seeds pets; if there are none, the
 * fixture is broken and the run must say so.
 */
async function resolvePetId(): Promise<string> {
  const rows = await db.select({ id: pets.id }).from(pets).limit(1);
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      "No pets in the database — the ALLOWED-parent cases cannot run, and skipping them would leave only the negative cases (which an always-rejecting constraint also passes). Run pnpm db:bootstrap.",
    );
  }
  return id;
}

/** Resolve an existing pet_event id for FK use. Throws for the same reason. */
async function resolvePetEventId(): Promise<string> {
  const rows = await db.select({ id: petEvents.id }).from(petEvents).limit(1);
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      "No pet_events in the database — the pet_id + event_id ALLOWED case cannot run. Run pnpm db:bootstrap.",
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------
// Zero parents — allowed (staging window)
// ---------------------------------------------------------------------------

describe("attachments XOR constraint — zero parents (staging)", () => {
  it("allows insert with all domain FKs null", async () => {
    // This is the uploadRevocationEvidence pattern: all FKs null at upload time.
    const id = await tryInsert({});
    expect(id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Single parent — allowed
// ---------------------------------------------------------------------------

describe("attachments XOR constraint — single parent (allowed)", () => {
  it("allows pet_id only", async () => {
    const petId = await resolvePetId();
    const id = await tryInsert({ petId });
    expect(id).toBeTruthy();
  });

  it("allows pet_id + event_id together (event attachment with de-normalised pet_id)", async () => {
    const eventId = await resolvePetEventId();
    // The event FK references a specific pet — use the event's own pet_id.
    const [eventRow] = await db
      .select({ petId: petEvents.petId })
      .from(petEvents)
      .where(sql`id = ${eventId}::uuid`)
      .limit(1);
    if (!eventRow) {
      // Unreachable: resolvePetEventId just read this row. A `return` here would
      // be the same silent pass this file is being cleaned of.
      throw new Error(`pet_event ${eventId} vanished between two reads`);
    }
    const id = await tryInsert({ petId: eventRow.petId, eventId });
    expect(id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Forbidden combinations
//
// The CHECK constraint is evaluated when the tuple is formed — BEFORE foreign
// key validation (RI triggers run at end of statement). Random UUIDs therefore
// deterministically exercise the constraint without needing real parent rows,
// keeping these tests non-vacuous on a freshly-seeded DB.
// ---------------------------------------------------------------------------

describe("attachments XOR constraint — two approval-flow parents (rejected)", () => {
  it("rejects approval_request_id + audit_log_id set simultaneously", async () => {
    await expectDbError(
      tryInsert({ approvalRequestId: crypto.randomUUID(), auditLogId: crypto.randomUUID() }),
      { constraint: /attachments_at_most_one_parent/ },
    );
  });
});

describe("attachments XOR constraint — approval-flow + content parents (rejected)", () => {
  it("rejects audit_log_id + pet_id set simultaneously", async () => {
    await expectDbError(
      tryInsert({ auditLogId: crypto.randomUUID(), petId: crypto.randomUUID() }),
      { constraint: /attachments_at_most_one_parent/ },
    );
  });

  it("rejects audit_log_id + event_id set simultaneously", async () => {
    await expectDbError(
      tryInsert({ auditLogId: crypto.randomUUID(), eventId: crypto.randomUUID() }),
      { constraint: /attachments_at_most_one_parent/ },
    );
  });

  it("rejects approval_request_id + pet_id set simultaneously", async () => {
    await expectDbError(
      tryInsert({ approvalRequestId: crypto.randomUUID(), petId: crypto.randomUUID() }),
      { constraint: /attachments_at_most_one_parent/ },
    );
  });

  it("rejects approval_request_id + event_id set simultaneously", async () => {
    await expectDbError(
      tryInsert({ approvalRequestId: crypto.randomUUID(), eventId: crypto.randomUUID() }),
      { constraint: /attachments_at_most_one_parent/ },
    );
  });
});
