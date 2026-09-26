// The unresolved-place queue (localidades-por-id D9, spec
// "unresolved-place-queue").
//
// A place that did not resolve to one catalogue row stays visible: it reaches
// its province (D2/D3/D8) and it waits here, at /admin/localidades/pendientes,
// for a platform admin. The admin sees the name that was entered and the
// catalogue rows it could mean — homonyms labelled with their department,
// never one pre-chosen — and resolves it to ONE row of the same province.
// The resolution is a place_resolutions row (append-only: who, why, which
// earlier one it supersedes) plus the row's declared cache columns
// (locality_id, place_method = 'admin_queue'); the event that recorded the
// place is never touched (P2).
//
// Everything runs in a transaction that is always rolled back.

import { randomUUID } from "node:crypto";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { cases, db } from "@/db";
import { listUnresolvedPlaces, resolvePlaceFromQueue } from "@/lib/place/unresolved-queue";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

async function first<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await tx.execute(query)) as unknown as T[];
  expect(rows.length).toBeGreaterThan(0);
  return rows[0] as T;
}

async function profileOf(tx: Tx, role: "admin" | "govt"): Promise<string> {
  return (
    await first<{ id: string }>(
      tx,
      sql`select id::text as id from public.profiles
           where role = ${role}::user_role and account_type = 'institutional'
             and deactivated_at is null and deleted_at is null
           order by created_at limit 1`,
    )
  ).id;
}

async function localityId(tx: Tx, indecId: string): Promise<string> {
  return (
    await first<{ id: string }>(
      tx,
      sql`select id::text as id from public.ar_localities where indec_id = ${indecId} and removed_at is null`,
    )
  ).id;
}

async function unresolvedCase(tx: Tx, province: string, locality: string): Promise<string> {
  const [row] = await tx
    .insert(cases)
    .values({
      publicCode: `CAS-${randomUUID().slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`,
      caseKind: "bite_incident",
      status: "open",
      primarySubjectKind: "general",
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      localityId: null,
      placeMethod: "unresolved",
      openedReason: "place-unresolved-queue fixture",
    })
    .returning({ id: cases.id });
  return row.id;
}

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";
const VILLA_MARIA_CBA = "14042170";

describe("the unresolved-place queue", () => {
  it("lists an unresolved case with every catalogue row its name could mean, none chosen", async () => {
    await inRolledBackTx(async (tx) => {
      const id = await unresolvedCase(tx, "Buenos Aires", "Mechita");
      const queue = await listUnresolvedPlaces(tx, { provinceCode: "AR-B" });
      const item = queue.find((q) => q.subjectTable === "cases" && q.subjectId === id);
      expect(item).toMatchObject({ province: "Buenos Aires", enteredLocality: "Mechita" });
      const candidates = item?.candidates ?? [];
      expect(candidates.map((c) => c.localityId).sort()).toEqual(
        [await localityId(tx, MECHITA_ALBERTI), await localityId(tx, MECHITA_BRAGADO)].sort(),
      );
      expect(candidates.map((c) => c.department).sort()).toEqual(["Alberti", "Bragado"]);
      // Another province's queue never shows it.
      const cordoba = await listUnresolvedPlaces(tx, { provinceCode: "AR-X" });
      expect(cordoba.some((q) => q.subjectId === id)).toBe(false);
    });
  });

  it("an admin resolves it to one row: a place_resolutions row plus the cache, and it leaves the queue", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileOf(tx, "admin");
      const id = await unresolvedCase(tx, "Buenos Aires", "Mechita");
      const bragado = await localityId(tx, MECHITA_BRAGADO);

      const done = await resolvePlaceFromQueue(tx, admin, {
        subjectTable: "cases",
        subjectId: id,
        localityId: bragado,
        reason: "La denuncia menciona la estación de Bragado",
      });
      expect(done).toEqual({ ok: true });

      const row = await first<{ locality_id: string; place_method: string; loc: string }>(
        tx,
        sql`select locality_id::text as locality_id, place_method, jurisdiction_locality as loc
              from public.cases where id = ${id}::uuid`,
      );
      // The entered text stays as entered; the id and the method are the resolution.
      expect(row).toEqual({ locality_id: bragado, place_method: "admin_queue", loc: "Mechita" });

      const resolution = await first<{ method: string; actor: string; reason: string }>(
        tx,
        sql`select method, actor_user_id::text as actor, reason from public.place_resolutions
             where subject_table = 'cases' and subject_id = ${id}::uuid`,
      );
      expect(resolution).toEqual({
        method: "admin_queue",
        actor: admin,
        reason: "La denuncia menciona la estación de Bragado",
      });
      const queue = await listUnresolvedPlaces(tx, { provinceCode: "AR-B" });
      expect(queue.some((q) => q.subjectId === id)).toBe(false);
    });
  });

  it("refuses a row of another province, a second resolution and a non-admin", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await profileOf(tx, "admin");
      const govt = await profileOf(tx, "govt");
      const id = await unresolvedCase(tx, "Buenos Aires", "Villa María");
      const input = {
        subjectTable: "cases" as const,
        subjectId: id,
        localityId: await localityId(tx, VILLA_MARIA_CBA),
        reason: "x",
      };
      expect(await resolvePlaceFromQueue(tx, govt, input)).toEqual({ error: "CAPABILITY_DENIED" });
      expect(await resolvePlaceFromQueue(tx, admin, input)).toEqual({ error: "PROVINCE_MISMATCH" });
      const bragado = await localityId(tx, MECHITA_BRAGADO);
      expect(
        await resolvePlaceFromQueue(tx, admin, { ...input, localityId: bragado, reason: "ok" }),
      ).toEqual({ ok: true });
      expect(
        await resolvePlaceFromQueue(tx, admin, { ...input, localityId: bragado, reason: "otra" }),
      ).toEqual({ error: "NOT_UNRESOLVED" });
    });
  });
});
