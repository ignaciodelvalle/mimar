// Regression test for the gob/decomisos custody_episode list ordering fix
// (2026-07-21 operator-screen consistency pass, item B; refined the same day
// to tiebreak on a real timestamp instead of a random UUID).
//
// Bug: the list query ordered by `desc(cases.openedAt)` alone. Most seed
// custody_episode rows share an identical batch-import timestamp (verified
// against the local DB), so ties fell back to whatever order Postgres's scan
// happened to hand back — for a bulk-inserted batch that reads out in
// roughly insertion order, meaning the oldest case in a tied block rendered
// FIRST and the newest LAST: "the list starts at the end" symptom reported.
//
// Fix: tiebreak on `desc(cases.createdAt)` (app/gob/decomisos/page.tsx) —
// unlike `openedAt` (a business-semantic date seed scripts deliberately
// backdate to a shared value per batch), `createdAt` is never set explicitly
// by any writer, so it carries the REAL, monotonic DB-insertion timestamp —
// a true recency signal, not a random tiebreak. `desc(cases.id)` stays as
// the final determinism guard for the residual case where even `createdAt`
// ties (e.g. a hypothetical multi-row batch INSERT in one statement).
//
// SQL guarantees a multi-column ORDER BY breaks ties on the next key
// regardless of physical row layout, so these assertions are fully
// deterministic (not flaky) once the tiebreak is in place.

import { and, desc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { cases, db } from "@/db";

const insertedIds: string[] = [];

async function insertCustodyEpisode(openedAt: Date, createdAt?: Date): Promise<string> {
  const [row] = await db
    .insert(cases)
    .values({
      publicCode: `DEC-ORDER-TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      caseKind: "custody_episode",
      primarySubjectKind: "general",
      status: "open",
      openedAt,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: cases.id });
  insertedIds.push(row.id);
  return row.id;
}

describe("gob/decomisos custody_episode list ordering (B)", () => {
  afterAll(async () => {
    if (insertedIds.length > 0) {
      await db.delete(cases).where(inArray(cases.id, insertedIds));
    }
  });

  it("breaks ties on an identical openedAt by TRUE insertion recency (createdAt), not id order", async () => {
    const tiedAt = new Date("2026-06-20T00:00:00.000Z");
    // Sequential, non-transactional inserts (mirrors the seed scripts) — each
    // gets its own DB-side `createdAt` `now()`, strictly increasing.
    const idA = await insertCustodyEpisode(tiedAt);
    const idB = await insertCustodyEpisode(tiedAt);
    const idC = await insertCustodyEpisode(tiedAt);

    // The page's exact fixed ORDER BY: opened_at DESC, created_at DESC, id
    // DESC. With all three rows sharing the same openedAt, this must read
    // out in REVERSE insertion order (C, B, A) — real recency, not
    // scan/id order.
    const tieRows = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.caseKind, "custody_episode"), inArray(cases.id, [idA, idB, idC])))
      .orderBy(desc(cases.openedAt), desc(cases.createdAt), desc(cases.id));

    expect(tieRows.map((r) => r.id)).toEqual([idC, idB, idA]);
  });

  it("falls back to id DESC when both openedAt and createdAt are tied", async () => {
    const tiedAt = new Date("2026-06-20T00:00:00.000Z");
    // Force an identical createdAt too (explicit override) — the one
    // residual case id DESC still guards.
    const idA = await insertCustodyEpisode(tiedAt, tiedAt);
    const idB = await insertCustodyEpisode(tiedAt, tiedAt);

    const idOrderRows = await db
      .select({ id: cases.id })
      .from(cases)
      .where(inArray(cases.id, [idA, idB]))
      .orderBy(desc(cases.id));
    const expectedOrder = idOrderRows.map((r) => r.id);

    const tieRows = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.caseKind, "custody_episode"), inArray(cases.id, [idA, idB])))
      .orderBy(desc(cases.openedAt), desc(cases.createdAt), desc(cases.id));

    expect(tieRows.map((r) => r.id)).toEqual(expectedOrder);
  });

  it("still puts a genuinely more recent case first, ahead of an older tied batch", async () => {
    const older = new Date("2026-06-20T00:00:00.000Z");
    const newer = new Date();
    const idOld = await insertCustodyEpisode(older);
    const idNew = await insertCustodyEpisode(newer);

    const rows = await db
      .select({ id: cases.id })
      .from(cases)
      .where(and(eq(cases.caseKind, "custody_episode"), inArray(cases.id, [idOld, idNew])))
      .orderBy(desc(cases.openedAt), desc(cases.createdAt), desc(cases.id));

    expect(rows[0]?.id).toBe(idNew);
    expect(rows[1]?.id).toBe(idOld);
  });
});
