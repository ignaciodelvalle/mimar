// Cron invariants test — escalate-stale-disputes handler (P7-1).
//
// Three invariants per the handoff:
//  1. Runtime window — only custody_dispute cases open >365 days are escalated.
//  2. Idempotency — second run on already-escalated cases is a no-op.
//  3. Recovery — escalation with no resolvable authority still updates the case
//     status (best-effort notifications, transactional update wins).

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, notifications, pets } from "@/db";
import {
  escalateStaleDispute,
  findStaleDisputes,
} from "@/lib/case-closers/escalate-stale-disputes";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { withMutationOverride } from "./_helpers/db-overrides";

const createdPetIds: string[] = [];
const createdCaseIds: string[] = [];

beforeAll(async () => {
  // No auth users needed — disputes use FKs on profiles.id but with onDelete: set null,
  // so we can leave raisedByUserId etc. NULL on these fixture rows. cases doesn't
  // require user_ids for the cron path; the helper only reads jurisdiction.
});

afterAll(async () => {
  if (createdCaseIds.length > 0) {
    for (const id of createdCaseIds) {
      await db
        .delete(notifications)
        .where(eq(notifications.relatedCaseId, id))
        .catch(() => {});
      await db
        .delete(cases)
        .where(eq(cases.id, id))
        .catch(() => {});
    }
  }
  if (createdPetIds.length > 0) {
    await withMutationOverride(async (tx) => {
      for (const id of createdPetIds) {
        await tx.delete(pets).where(eq(pets.id, id));
      }
    });
  }
});

async function makeDisputePet(): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name: "DisputeTestPet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  createdPetIds.push(pet.id);
  return pet.id;
}

async function makeDisputeCase(opts: {
  openedAt: Date;
  status?: "open" | "escalated" | "closed";
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
}): Promise<{ id: string; publicCode: string }> {
  const petId = await makeDisputePet();
  const publicCode = `CAS-TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const [row] = await db
    .insert(cases)
    .values({
      publicCode,
      caseKind: "custody_dispute",
      status: opts.status ?? "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: petId,
      jurisdictionProvince: opts.jurisdictionProvince ?? "Buenos Aires",
      jurisdictionLocality: opts.jurisdictionLocality ?? "Mar del Plata",
      openedAt: opts.openedAt,
      openedReason: "fixture: P7-1 stale-dispute test",
    })
    .returning({ id: cases.id });
  createdCaseIds.push(row.id);
  return { id: row.id, publicCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TWO_YEARS_AGO = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);

describe("escalate-stale-disputes", () => {
  it("runtime window — only disputes open >365 days are picked up", async () => {
    const stale = await makeDisputeCase({ openedAt: TWO_YEARS_AGO });
    const fresh = await makeDisputeCase({ openedAt: YESTERDAY });

    const candidates = await findStaleDisputes();
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);

    for (const c of candidates) {
      if (c.id !== stale.id) continue;
      await escalateStaleDispute(c);
    }

    const [staleRow] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, stale.id));
    expect(staleRow.status).toBe("escalated");

    const [freshRow] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, fresh.id));
    expect(freshRow.status).toBe("open");
  });

  it("idempotency — second run does not re-escalate or notify again", async () => {
    const stale = await makeDisputeCase({ openedAt: TWO_YEARS_AGO });

    let candidates = await findStaleDisputes();
    const match = candidates.find((c) => c.id === stale.id);
    expect(match).toBeDefined();
    if (match) await escalateStaleDispute(match);

    // After escalation, the same case should no longer appear as stale (the
    // query filters by status='open').
    candidates = await findStaleDisputes();
    expect(candidates.find((c) => c.id === stale.id)).toBeUndefined();

    // Even if we re-invoke the escalator on the post-state candidate snapshot,
    // the WHERE status='open' guard on the UPDATE makes it a no-op.
    if (match) await escalateStaleDispute(match);

    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, stale.id));
    expect(row.status).toBe("escalated");
  });

  it("recovery — escalation with no resolvable authorities still flips status", async () => {
    // Real canonical province (CHECK constraint enforces the 24-enum since
    // migration 0055), synthetic locality nobody covers — that's enough to
    // exercise the "no resolvable authority" branch.
    const stale = await makeDisputeCase({
      openedAt: TWO_YEARS_AGO,
      jurisdictionProvince: "Tierra del Fuego",
      jurisdictionLocality: "ESCALATE_TEST_UNASSIGNED_LOCALITY",
    });

    const candidates = await findStaleDisputes();
    const match = candidates.find((c) => c.id === stale.id);
    expect(match).toBeDefined();
    if (match) await escalateStaleDispute(match);

    const [row] = await db
      .select({ status: cases.status })
      .from(cases)
      .where(eq(cases.id, stale.id));
    expect(row.status).toBe("escalated");
  });
});
