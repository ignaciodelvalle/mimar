// The R7 repair and its safeguards (localidades-por-id B5, security review of
// stage B).
//
// The repair audits ids the deleted name-based backfill may have written for a
// homonym. A record being SILENT is not evidence the id is wrong: the sources
// it reads (`place`, `place_entered`) did not exist before stage A/B1, so every
// older row is silent by construction. The safeguards pinned here:
//   (a) a row whose place_method is set was written after 0248 by a writer
//       that knew how it resolved — never audited;
//   (b) a silent row is CLEARED only when its id is the old script's own
//       fingerprint (the alphabetically first department of the homonyms);
//       any other id — a pin that picked Bragado's Mechita — is KEPT, unproven;
//   (c) a denuncia with no place_entered falls back to its linked event's
//       `place` before it counts as silent;
//   (d) every change writes a pre-image (old id, new id, verdict, reason)
//       before the row moves;
//   (e) --apply against a non-local database needs the reviewed dry-run count.
//
// Database cases run inside a transaction that is always rolled back.

import { TransactionRollbackError, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/db";

import {
  type RepairDecision,
  applyRepair,
  assertApplyAllowed,
  decideRepair,
  planRepair,
} from "../scripts/place-repair-homonym-ids";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

let alberti = "";
let bragado = "";

beforeAll(async () => {
  const rows = (await db.execute(sql`
    select id::text as id, indec_id from public.ar_localities
     where province_code = 'AR-B' and locality_name = 'Mechita' and removed_at is null
  `)) as unknown as Array<{ id: string; indec_id: string }>;
  expect(rows).toHaveLength(2);
  bragado = rows.find((r) => r.indec_id === "06112080")?.id ?? "";
  alberti = rows.find((r) => r.indec_id === "06021030")?.id ?? "";
  expect(bragado).not.toBe("");
  expect(alberti).not.toBe("");
});

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof TransactionRollbackError)) throw e;
    });
}

async function mechitaPet(tx: Tx, localityId: string, placeMethod: string | null) {
  const [row] = (await tx.execute(sql`
    insert into public.pets (public_token, name, species, sex, status,
                             jurisdiction_province, jurisdiction_locality, locality_id, place_method)
    values (${`REPAIR-${crypto.randomUUID()}`}, 'RepairFixture', 'dog', 'female', 'active',
            'Buenos Aires', 'Mechita', ${localityId}::uuid, ${placeMethod})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  return (row as { id: string }).id;
}

describe("decideRepair (pure)", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("the record decides when it speaks: agree keeps, differ rewrites", () => {
    expect(decideRepair(B, B, A)).toMatchObject({ verdict: "keep", localityId: B });
    expect(decideRepair(A, B, A)).toMatchObject({ verdict: "rewrite", localityId: B });
    expect(decideRepair(A, null, A)).toMatchObject({ verdict: "rewrite", localityId: null });
  });

  it("(b) a silent row is cleared only when its id is the old script's fingerprint", () => {
    expect(decideRepair(A, undefined, A)).toMatchObject({ verdict: "clear", localityId: null });
  });

  it("(b) any other id on a silent row is kept, unproven — never cleared", () => {
    expect(decideRepair(B, undefined, A)).toMatchObject({
      verdict: "keep_unproven",
      localityId: B,
    });
  });
});

describe("planRepair against the database", () => {
  it("(b) the Mechita a pin disambiguated to Bragado is KEPT; Alberti's guess is cleared", async () => {
    await inRolledBackTx(async (tx) => {
      const byPin = await mechitaPet(tx, bragado, null);
      const byName = await mechitaPet(tx, alberti, null);
      const plan = await planRepair(tx, "pets");
      const verdictOf = (id: string) => plan.find((d) => d.id === id)?.verdict;
      expect(verdictOf(byPin)).toBe("keep_unproven");
      expect(verdictOf(byName)).toBe("clear");
    });
  });

  it("(a) a row whose method was recorded after 0248 is never audited", async () => {
    await inRolledBackTx(async (tx) => {
      const recorded = await mechitaPet(tx, alberti, "indec_id");
      const plan = await planRepair(tx, "pets");
      expect(plan.some((d) => d.id === recorded)).toBe(false);
    });
  });

  it("(c) a denuncia with no place_entered reads its linked event's place first", async () => {
    await inRolledBackTx(async (tx) => {
      const [report] = (await tx.execute(sql`
        insert into public.welfare_reports (reference_code, kind, severity, description, subject_kind,
                                            jurisdiction_province, jurisdiction_locality, locality_id)
        values (${`REP-${Date.now()}`}, 'abandonment', 'medium', 'fixture', 'unowned_animal',
                'Buenos Aires', 'Mechita', ${alberti}::uuid)
        returning id::text as id
      `)) as unknown as Array<{ id: string }>;
      const reportId = (report as { id: string }).id;
      const petId = await mechitaPet(tx, bragado, "indec_id");
      await tx.execute(sql`
        insert into public.pet_events (pet_id, event_type, occurred_at, author_role, payload)
        values (${petId}::uuid, 'note_added', now(), 'system',
                jsonb_build_object(
                  'welfare_report_id', ${reportId}::text,
                  'place', jsonb_build_object(
                    'entered', jsonb_build_object('province', 'Buenos Aires', 'locality', 'Mechita', 'indec_id', null),
                    'resolved', jsonb_build_object('locality_id', ${bragado}::text,
                                                   'province_code', 'AR-B', 'method', 'geocode_unique'))))
      `);
      const plan = await planRepair(tx, "welfare_reports");
      expect(plan.find((d) => d.id === reportId)).toMatchObject({
        verdict: "rewrite",
        localityId: bragado,
      });
    });
  });
});

describe("(d) applyRepair writes the pre-image before the row moves", () => {
  it("records table, row, old id, new id and verdict, then clears the row", async () => {
    await inRolledBackTx(async (tx) => {
      const petId = await mechitaPet(tx, alberti, null);
      const decision: RepairDecision = {
        table: "pets",
        id: petId,
        storedId: alberti,
        verdict: "clear",
        localityId: null,
        reason: "fixture",
      };
      const runId = crypto.randomUUID();
      await applyRepair(tx, runId, decision);

      const pre = (await tx.execute(sql`
        select subject_table, subject_id::text as subject_id,
               old_locality_id::text as old_id, new_locality_id::text as new_id, verdict
          from public.place_repair_preimages where run_id = ${runId}::uuid
      `)) as unknown as Array<Record<string, string | null>>;
      expect(pre).toEqual([
        {
          subject_table: "pets",
          subject_id: petId,
          old_id: alberti,
          new_id: null,
          verdict: "clear",
        },
      ]);
      const [pet] = (await tx.execute(sql`
        select locality_id, place_method from public.pets where id = ${petId}::uuid
      `)) as unknown as Array<{ locality_id: string | null; place_method: string | null }>;
      expect(pet).toEqual({ locality_id: null, place_method: "unresolved" });
    });
  });
});

describe("(e) --apply against a database that is not local", () => {
  it("is refused without the reviewed dry-run count", () => {
    expect(() =>
      assertApplyAllowed({ host: "db.staging.example", reviewedCount: null, plannedCount: 12 }),
    ).toThrow(/--i-reviewed-dry-run=12/);
  });

  it("is refused when the reviewed count does not match this run's plan", () => {
    expect(() =>
      assertApplyAllowed({ host: "db.staging.example", reviewedCount: 11, plannedCount: 12 }),
    ).toThrow(/reviewed 11/);
  });

  it("goes ahead with the matching count, and always on the local stack", () => {
    expect(() =>
      assertApplyAllowed({ host: "db.staging.example", reviewedCount: 12, plannedCount: 12 }),
    ).not.toThrow();
    expect(() =>
      assertApplyAllowed({ host: "127.0.0.1", reviewedCount: null, plannedCount: 12 }),
    ).not.toThrow();
  });
});
