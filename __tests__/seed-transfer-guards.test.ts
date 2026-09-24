// DB-backed test for scripts/seed-transfer-guards.ts.
//
// Why this file exists (A15 / P2.2): __tests__/rls/matrix.test.ts inserts a
// PENDING `pet_transfers` row so the owner/admin/other_user SELECT cells probe
// a real policy instead of an empty table. It picked "the owner's first ACTIVE
// pet", which on a database carrying the demo seed was DIM-DEMO-0001 — a pet
// that already had a pending transfer (PTR-D2TZ-JGR4, 2026-07-26). The insert
// hit the partial unique index
//   duplicate key value violates unique constraint "pet_transfers_one_pending_per_pet"
// and the entire RLS matrix died in beforeAll. CI stayed green because it
// bootstraps clean and creates no transfers, so the only gate that broke was
// the one a human runs before pushing.
//
// The guard makes the collision impossible BY CONSTRUCTION: the same predicate
// the partial unique index uses, expressed as a NOT EXISTS, plus a
// deterministic ORDER BY. These tests pin both halves — including the negative
// case (a pet with a pending transfer is never returned), the closed-status
// case, and the migration-parity case (the guard's status list still matches
// db/migrations/0054_pet_transfers.sql).
//
// Mirrors __tests__/seed-case-guards.test.ts, which does the same for
// cases_open_per_pet_kind_idx.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pets, profiles } from "@/db";
import {
  BLOCKING_TRANSFER_STATUSES,
  findBlockingTransfers,
  selectPetsWithoutPendingTransfer,
  selectSeedPetsWithoutPendingTransfer,
} from "../scripts/seed-transfer-guards";
import { withMutationOverride } from "./_helpers/db-overrides";

const PREFIX = "DIM-TRFG-";
const TOKENS = [`${PREFIX}P3`, `${PREFIX}P1`, `${PREFIX}P2`] as const;
const TRANSFER_PREFIX = "TRF-TRFGUARD-";

const petIdByToken = new Map<string, string>();
let senderId: string | null = null;

async function cleanup(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM pet_transfers WHERE public_token LIKE ${`${TRANSFER_PREFIX}%`}`,
    );
    await tx.execute(sql`DELETE FROM pet_transfers WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token LIKE ${`${PREFIX}%`}
    )`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token LIKE ${`${PREFIX}%`}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token LIKE ${`${PREFIX}%`}`);
  });
}

async function openTransfer(token: string, publicToken: string, status = "pending"): Promise<void> {
  const petId = petIdByToken.get(token);
  await db.execute(sql`
    INSERT INTO pet_transfers (
      public_token, pet_id, from_owner_id, to_owner_email, status, expires_at
    ) VALUES (
      ${publicToken}, ${petId}, ${senderId}, 'guard-test@dim.test', ${status},
      now() + interval '7 days'
    )
  `);
}

beforeAll(async () => {
  await cleanup();

  // Any existing profile works as from_owner_id — the FK is all that matters
  // here; this suite probes the INDEX, not transfer semantics.
  const [profile] = await db.select({ id: profiles.id }).from(profiles).limit(1);
  senderId = profile?.id ?? null;

  // Inserted in a deliberately NON-alphabetical order so the ordering
  // assertion below can only pass if the query really sorts.
  for (const token of TOKENS) {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: "TransferGuardTest",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
      })
      .returning({ id: pets.id });
    petIdByToken.set(token, row.id);
  }
});

afterAll(async () => {
  await cleanup();
});

describe("selectSeedPetsWithoutPendingTransfer — the pick is reproducible", () => {
  it("returns pets sorted by public_token, not in heap order", async () => {
    const rows = await selectSeedPetsWithoutPendingTransfer({ tokenPrefix: PREFIX, limit: 10 });
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P1`, `${PREFIX}P2`, `${PREFIX}P3`]);
  });

  it("returns the same slice on repeated calls", async () => {
    const a = await selectSeedPetsWithoutPendingTransfer({ tokenPrefix: PREFIX, limit: 2 });
    const b = await selectSeedPetsWithoutPendingTransfer({ tokenPrefix: PREFIX, limit: 2 });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a).toHaveLength(2);
  });
});

describe("selectPetsWithoutPendingTransfer — one pending transfer per pet", () => {
  it("returns every candidate while none has a pending transfer", async () => {
    const ids = TOKENS.map((t) => petIdByToken.get(t) as string);
    const rows = await selectPetsWithoutPendingTransfer(ids);
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P1`, `${PREFIX}P2`, `${PREFIX}P3`]);
  });

  it("returns [] for an empty candidate list instead of building IN ()", async () => {
    expect(await selectPetsWithoutPendingTransfer([])).toEqual([]);
  });

  it("EXCLUDES a pet that already has a pending transfer", async () => {
    await openTransfer(`${PREFIX}P1`, `${TRANSFER_PREFIX}PEND-1`);

    const ids = TOKENS.map((t) => petIdByToken.get(t) as string);
    const rows = await selectPetsWithoutPendingTransfer(ids);
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P2`, `${PREFIX}P3`]);
  });

  it("ORDERING ALONE WOULD NOT HAVE SAVED IT (the A8 lesson)", async () => {
    // P1 is both the alphabetically-first candidate AND the one carrying the
    // pending transfer. A pick that only added ORDER BY would land on it every
    // single time — turning an intermittent collision into a guaranteed one.
    // This asserts the guard is doing the excluding, not the sorting.
    const ids = TOKENS.map((t) => petIdByToken.get(t) as string);
    const ordered = [...ids].sort();
    expect(await findBlockingTransfers(petIdByToken.get(`${PREFIX}P1`) as string)).toHaveLength(1);
    const guarded = await selectPetsWithoutPendingTransfer(ordered);
    expect(guarded[0]?.publicToken).toBe(`${PREFIX}P2`);
  });

  it("the pet it returns is a LEGAL insert target — the index accepts it", async () => {
    const ids = TOKENS.map((t) => petIdByToken.get(t) as string);
    const [first] = await selectPetsWithoutPendingTransfer(ids);
    expect(first.publicToken).toBe(`${PREFIX}P2`);
    expect(await findBlockingTransfers(first.id)).toEqual([]);

    // The real proof: the DB accepts the insert the fixture would make.
    await openTransfer(first.publicToken, `${TRANSFER_PREFIX}PEND-2`);
    expect(await findBlockingTransfers(first.id)).toHaveLength(1);

    // …and the guard immediately stops offering it.
    const after = await selectPetsWithoutPendingTransfer(ids);
    expect(after.map((r) => r.publicToken)).toEqual([`${PREFIX}P3`]);
  });

  it("a CLOSED transfer does not block the pet — the index predicate is status-scoped", async () => {
    await db.execute(sql`
      UPDATE pet_transfers SET status = 'cancelled', responded_at = now()
      WHERE public_token = ${`${TRANSFER_PREFIX}PEND-1`}
    `);

    const ids = TOKENS.map((t) => petIdByToken.get(t) as string);
    const rows = await selectPetsWithoutPendingTransfer(ids);
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P1`, `${PREFIX}P3`]);
  });

  it("the index really does reject a second pending transfer (the guard is not theatre)", async () => {
    // Without this, every assertion above could be describing a rule Postgres
    // does not actually enforce.
    //
    // Drizzle wraps the driver error in a DrizzleQueryError whose own message
    // is only "Failed query: …" — the constraint name lives on `.cause`. Walk
    // the chain rather than matching the top-level message, or this assertion
    // would pass on ANY insert failure (wrong column, FK, permission), which is
    // the same "green for the wrong reason" this whole module is about.
    let raised: unknown;
    try {
      await openTransfer(`${PREFIX}P2`, `${TRANSFER_PREFIX}PEND-DUP`);
    } catch (err) {
      raised = err;
    }
    expect(raised, "a second pending transfer must be rejected").toBeDefined();

    const chain: string[] = [];
    for (let e: unknown = raised, depth = 0; e && depth < 5; depth += 1) {
      const asErr = e as { message?: string; constraint_name?: string; cause?: unknown };
      chain.push(`${asErr.message ?? ""} ${asErr.constraint_name ?? ""}`);
      e = asErr.cause;
    }
    expect(
      chain.join(" | "),
      "the rejection must come from pet_transfers_one_pending_per_pet, not from some other insert error",
    ).toMatch(/pet_transfers_one_pending_per_pet/i);
  });
});

describe("guard constants match db/migrations/0054_pet_transfers.sql", () => {
  const migration = readFileSync(
    join(process.cwd(), "db", "migrations", "0054_pet_transfers.sql"),
    "utf8",
  );
  const indexDdl =
    migration
      .split(/CREATE UNIQUE INDEX IF NOT EXISTS pet_transfers_one_pending_per_pet/i)[1]
      ?.split(";")[0] ?? "";

  it("finds the partial unique index in the migration", () => {
    expect(indexDdl).not.toBe("");
    expect(indexDdl).toMatch(/ON pet_transfers\(pet_id\)/i);
  });

  it("mirrors the index's blocking statuses", () => {
    // The DDL predicate is `WHERE status = 'pending'` (single value, not an
    // IN-list). Parse whichever form it takes so a future widening to
    // `status IN ('pending','...')` shows up here as a failure, not as silent
    // under-guarding.
    const where = indexDdl.split(/\bWHERE\b/i)[1] ?? "";
    const parsed = [...where.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(parsed).toEqual([...BLOCKING_TRANSFER_STATUSES].sort());
  });

  it("the schema's Drizzle declaration agrees with the migration", () => {
    const schema = readFileSync(join(process.cwd(), "db", "schema.ts"), "utf8");
    const decl =
      schema.split(/uniqueIndex\("pet_transfers_one_pending_per_pet"\)/)[1]?.slice(0, 200) ?? "";
    expect(decl).not.toBe("");
    for (const status of BLOCKING_TRANSFER_STATUSES) {
      expect(decl).toContain(`'${status}'`);
    }
  });
});
