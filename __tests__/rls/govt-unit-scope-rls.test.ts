// RLS by authority unit — behavioural harness for migration 0259
// (localidades-por-id D8, spec "govt-scope-and-rls").
//
// The five govt SELECT policies and can_read_case read public.govt_scope. A
// grant on a unit admits a row whose catalogue locality_id is an active member
// of the unit — Mechita (partido Alberti) and Mechita (partido Bragado) share
// a name and a province and are still two places. A provincial unit admits its
// whole province, unresolved rows included; a municipal unit never admits an
// unresolved row (P1/P3). A LEGACY grant (no unit) keeps 0241's name match,
// homonym confusion included: that is fenced as UNCHANGED, not fixed — the
// fix for a legacy grant is confirming it to a unit, a person's decision.
//
// Same technique as govt-whole-province-rls.test.ts: each policy's LIVE qual
// is read from pg_policies and evaluated as the table owner against a fixture
// row, with request.jwt.claims set to the probed operator; can_read_case is
// called directly. Every fixture lives in one transaction, always rolled back.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  approvalRequests,
  cases,
  custodyDisputeParties,
  custodyDisputes,
  db,
  govtAssignments,
  petEvents,
  petIdentifications,
  petServiceDog,
  pets,
  profiles,
} from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

type Place = "alberti" | "bragado" | "unresolved";
type Operator = "albertiUnit" | "bragadoUnit" | "provinciaBa" | "legacyMechita";

const EXPECTED: Array<{ who: Operator; at: Place; sees: boolean; why: string }> = [
  { who: "albertiUnit", at: "alberti", sees: true, why: "its own member locality" },
  { who: "albertiUnit", at: "bragado", sees: false, why: "the homonym in another partido" },
  {
    who: "albertiUnit",
    at: "unresolved",
    sees: false,
    why: "an unresolved row reaches only the province",
  },
  { who: "bragadoUnit", at: "alberti", sees: false, why: "the homonym in another partido" },
  { who: "bragadoUnit", at: "bragado", sees: true, why: "its own member locality" },
  { who: "provinciaBa", at: "alberti", sees: true, why: "the whole province" },
  { who: "provinciaBa", at: "unresolved", sees: true, why: "the province sees unresolved rows" },
  { who: "legacyMechita", at: "alberti", sees: true, why: "legacy name match, unchanged" },
  { who: "legacyMechita", at: "bragado", sees: true, why: "legacy name match, unchanged (0241)" },
  {
    who: "legacyMechita",
    at: "unresolved",
    sees: true,
    why: "legacy name match, unchanged (0241)",
  },
];

const SURFACES = [
  { table: "approval_requests", policy: "approval requests visible to applicant or authority" },
  { table: "custody_disputes", policy: "custody_disputes select by parties and authorities" },
  {
    table: "custody_dispute_parties",
    policy: "custody_dispute_parties select by parties and authorities",
  },
  { table: "pet_identifications", policy: "pet_identifications read by govt in jurisdiction" },
  { table: "pet_service_dog", policy: "service_dog select by owner or authority" },
] as const;

type SurfaceTable = (typeof SURFACES)[number]["table"] | "cases";

const ROLLBACK = new Error("govt-unit-scope-rls: rollback");

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

function token(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
}

async function one<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await tx.execute(query)) as unknown as T[];
  if (rows.length < 1) throw new Error("fixture lookup returned nothing");
  return rows[0] as T;
}

async function localityId(tx: Tx, indecId: string): Promise<string> {
  return (
    await one<{ id: string }>(
      tx,
      sql`select id::text as id from public.ar_localities where indec_id = ${indecId} and removed_at is null`,
    )
  ).id;
}

async function municipalUnitOf(tx: Tx, locality: string): Promise<string> {
  return (
    await one<{ unit_id: string }>(
      tx,
      sql`select unit_id::text as unit_id from public.authority_unit_localities
           where locality_id = ${locality}::uuid and level = 'municipal' and valid_to is null`,
    )
  ).unit_id;
}

async function provincialUnit(tx: Tx, code: string): Promise<string> {
  return (
    await one<{ id: string }>(
      tx,
      sql`select id::text as id from public.authority_units where province_code = ${code} and kind = 'provincia'`,
    )
  ).id;
}

async function insertProfile(tx: Tx, role: "govt" | "owner", name: string): Promise<string> {
  const id = randomUUID();
  await tx.insert(profiles).values({
    id,
    displayName: name,
    role,
    accountType: role === "govt" ? "institutional" : "personal",
  });
  return id;
}

async function seedOperators(
  tx: Tx,
  ids: { alberti: string; bragado: string },
): Promise<Record<Operator, string>> {
  const grants: Record<Operator, { locality: string; unitId: string | null }> = {
    albertiUnit: { locality: "Alberti", unitId: await municipalUnitOf(tx, ids.alberti) },
    bragadoUnit: { locality: "Bragado", unitId: await municipalUnitOf(tx, ids.bragado) },
    provinciaBa: { locality: "", unitId: await provincialUnit(tx, "AR-B") },
    legacyMechita: { locality: "Mechita", unitId: null },
  };
  const out = {} as Record<Operator, string>;
  for (const [who, g] of Object.entries(grants) as Array<[Operator, (typeof grants)[Operator]]>) {
    const id = await insertProfile(tx, "govt", `D8 probe ${who}`);
    await tx.insert(govtAssignments).values({
      userId: id,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: g.locality,
      authorityUnitId: g.unitId,
    });
    out[who] = id;
  }
  return out;
}

/** One row per surface named "Buenos Aires / Mechita", at `localityId` (null = unresolved). */
async function seedRowsAt(
  tx: Tx,
  localityIdOrNull: string | null,
  citizen: string,
): Promise<Record<SurfaceTable, string>> {
  const place = {
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Mechita",
    localityId: localityIdOrNull,
  };
  const [pet] = await tx
    .insert(pets)
    .values({ publicToken: token("DIM-D8"), name: "D8 probe pet", species: "dog", ...place })
    .returning({ id: pets.id });
  const [ident] = await tx
    .insert(petIdentifications)
    .values({
      petId: pet.id,
      kind: "collar_tag",
      code: token("D8-TAG"),
      status: "active",
      recordedAt: "2026-09-25",
    })
    .returning({ id: petIdentifications.id });
  const [dog] = await tx
    .insert(petServiceDog)
    .values({ petId: pet.id, serviceType: "guia", trainingCenter: "D8 probe" })
    .returning({ id: petServiceDog.id });
  const [kase] = await tx
    .insert(cases)
    .values({
      publicCode: token("CAS"),
      caseKind: "bite_incident",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: pet.id,
      openedReason: "govt-unit-scope-rls fixture",
      ...place,
    })
    .returning({ id: cases.id });
  const [raising] = await tx
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "custody_dispute_raised",
      occurredAt: new Date(),
      recordedByUserId: citizen,
      authorRole: "owner",
    })
    .returning({ id: petEvents.id });
  const [dispute] = await tx
    .insert(custodyDisputes)
    .values({
      publicToken: token("DIS"),
      petId: pet.id,
      raisedByUserId: citizen,
      raisedByRole: "owner",
      raisingEventId: raising.id,
      ...place,
    })
    .returning({ id: custodyDisputes.id });
  const [party] = await tx
    .insert(custodyDisputeParties)
    .values({ disputeId: dispute.id, partyUserId: citizen, partyRole: "current_owner" })
    .returning({ id: custodyDisputeParties.id });
  const [approval] = await tx
    .insert(approvalRequests)
    .values({
      publicToken: token("APR"),
      type: "role_upgrade_vet",
      applicantUserId: citizen,
      targetUserId: citizen,
      ...place,
    })
    .returning({ id: approvalRequests.id });
  return {
    approval_requests: approval.id,
    custody_disputes: dispute.id,
    custody_dispute_parties: party.id,
    pet_identifications: ident.id,
    pet_service_dog: dog.id,
    cases: kase.id,
  };
}

async function liveQual(tx: Tx, table: string, policy: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select qual from pg_policies
    where schemaname = 'public' and tablename = ${table} and policyname = ${policy}
      and cmd = 'SELECT'
  `)) as unknown as Array<{ qual: string | null }>;
  if (rows.length !== 1 || !rows[0].qual) {
    throw new Error(`policy ${table} "${policy}" not found in the live catalog`);
  }
  return rows[0].qual;
}

async function policyAdmits(
  tx: Tx,
  table: string,
  qual: string,
  rowId: string,
  userId: string,
): Promise<boolean> {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" });
  await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
  await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
  const rows = (await tx.execute(sql`
    select (${sql.raw(qual)}) as visible
    from ${sql.raw(`public.${table}`)}
    where id = ${rowId}
  `)) as unknown as Array<{ visible: boolean | null }>;
  if (rows.length !== 1) throw new Error(`fixture row ${table}/${rowId} not found`);
  return rows[0].visible === true;
}

async function canReadCase(tx: Tx, caseId: string, userId: string): Promise<boolean> {
  const rows = (await tx.execute(
    sql`select public.can_read_case(${caseId}::uuid, ${userId}::uuid) as ok`,
  )) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}

type Decide = (tx: Tx, rowId: string, userId: string) => Promise<boolean>;

async function mismatchesFor(
  surface: SurfaceTable,
  decideFor: (tx: Tx) => Promise<Decide>,
): Promise<string[]> {
  const wrong: string[] = [];
  let probed = 0;
  await inRolledBackTx(async (tx) => {
    const alberti = await localityId(tx, MECHITA_ALBERTI);
    const bragado = await localityId(tx, MECHITA_BRAGADO);
    const citizen = await insertProfile(tx, "owner", "D8 probe citizen");
    const ops = await seedOperators(tx, { alberti, bragado });
    const decide = await decideFor(tx);
    const rows: Record<Place, Record<SurfaceTable, string>> = {
      alberti: await seedRowsAt(tx, alberti, citizen),
      bragado: await seedRowsAt(tx, bragado, citizen),
      unresolved: await seedRowsAt(tx, null, citizen),
    };
    for (const e of EXPECTED) {
      const got = await decide(tx, rows[e.at][surface], ops[e.who]);
      probed++;
      if (got !== e.sees)
        wrong.push(`${e.who} @ ${e.at}: expected ${e.sees} (${e.why}), got ${got}`);
    }
  });
  expect(probed).toBe(EXPECTED.length);
  return wrong;
}

describe("RLS by authority unit (migration 0259)", () => {
  for (const { table, policy } of SURFACES) {
    it(`${table} — "${policy}" reads govt_scope`, async () => {
      const wrong = await mismatchesFor(table, async (tx) => {
        const qual = await liveQual(tx, table, policy);
        return (t, rowId, userId) => policyAdmits(t, table, qual, rowId, userId);
      });
      expect(wrong).toEqual([]);
    });
  }

  it("cases — can_read_case (SECURITY DEFINER) reads govt_scope", async () => {
    const wrong = await mismatchesFor("cases", async () => canReadCase);
    expect(wrong).toEqual([]);
  });
});
