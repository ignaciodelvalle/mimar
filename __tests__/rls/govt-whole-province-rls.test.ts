// RLS whole-province govt jurisdiction — behavioural harness for migration 0241
// (T3-J1b, PO decision 7C 2026-09-22).
//
// THE DEFECT. Five SELECT policies and the SECURITY DEFINER can_read_case
// matched govt_assignments to a row by (province, locality) NAME equality with
// no whole-province branch. A "toda la provincia" operator — locality '' or
// CABA's INDEC whole-city entry — matched nothing through RLS, while the TS
// gate (isWholeProvinceLocality, lib/domain/jurisdiction-canonical.ts) gives
// that same assignment the whole province.
//
// WHY THE PREDICATE IS EVALUATED DIRECTLY, NOT THROUGH PostgREST. Four of the
// six surfaces cannot show a positive through PostgREST whatever their own
// predicate says: pet_identifications and pet_service_dog subquery `pets`,
// which has no govt SELECT policy (matrix-govt-jurisdiction.test.ts, R1/R2),
// and both custody tables hit the organization_memberships recursion pinned in
// erased-admin-authority.test.ts. A PostgREST probe there would read "denied"
// before and after the fix alike. So this file reads each policy's LIVE qual
// from pg_policies and evaluates it, as the table owner, against a fixture row
// with request.jwt.claims set to the probed operator — the predicate itself,
// neighbours' RLS excluded — and calls can_read_case directly. The live text
// is used, never a copy, so the test answers for what is applied
// ("aplicada no es cerrada").
//
// NO RESIDUE. Every fixture (profiles, assignments, pets, the raising event,
// disputes, parties, requests, cases) is written inside ONE transaction per
// surface that is always rolled back — a crashed run leaves nothing behind,
// and no fitness scan over pets or assignments ever sees these rows.

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
import { GOVT_DECIDABLE_TYPES } from "@/lib/infra/approval-scope";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type Place = { province: string; locality: string | null };

// Real catalog names, so the fixture reads like data the product can hold.
const MZA_GODOY_CRUZ: Place = { province: "Mendoza", locality: "Godoy Cruz" };
const MZA_LAS_HERAS: Place = { province: "Mendoza", locality: "Las Heras" };
const MZA_NO_LOCALITY: Place = { province: "Mendoza", locality: null };
const SAN_JUAN_RIVADAVIA: Place = { province: "San Juan", locality: "Rivadavia" };
const CABA_PALERMO: Place = { province: "CABA", locality: "Palermo" };
const PBA_LA_PLATA: Place = { province: "Buenos Aires", locality: "La Plata" };

const CABA_WHOLE_CITY = "Ciudad Autónoma de Buenos Aires";

// Every probed operator, keyed by what its assignment IS.
type Operator =
  | "wholeMendoza"
  | "wholeCaba"
  | "lasHeras"
  | "capitalMendoza"
  | "revokedWhole"
  | "deactivatedWhole";

const ASSIGNMENTS: Record<
  Operator,
  { province: string; locality: string; revoked?: true; deactivated?: true }
> = {
  // The generic '' sentinel (D3): the whole province of Mendoza.
  wholeMendoza: { province: "Mendoza", locality: "" },
  // CABA's INDEC single whole-city entry — the other whole-province form.
  wholeCaba: { province: "CABA", locality: CABA_WHOLE_CITY },
  // Locality-scoped: must keep the exact pair.
  lasHeras: { province: "Mendoza", locality: "Las Heras" },
  // The province's OWN name is a real locality (the capital), never the
  // sentinel — promoting it would widen a city operator to the province.
  capitalMendoza: { province: "Mendoza", locality: "Mendoza" },
  // Whole-province but REVOKED: only an active assignment counts.
  revokedWhole: { province: "Mendoza", locality: "", revoked: true },
  // Whole-province and ACTIVE, but the operator is deactivated: the profile
  // markers (0216) still refuse it, whatever the assignment covers.
  deactivatedWhole: { province: "Mendoza", locality: "", deactivated: true },
};

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

/**
 * The expected answer for each (operator, place), written out rather than
 * computed so a mutation of the semantics cannot move the expectations with
 * it. `nullLocality` is only probed on the surfaces whose row may carry a
 * NULL locality (pets-backed ones and cases); the TS clause's whole-province
 * branch tests province alone, so it matches those rows too.
 */
const EXPECTED: Array<{ who: Operator; at: Place; sees: boolean; why: string }> = [
  { who: "wholeMendoza", at: MZA_GODOY_CRUZ, sees: true, why: "another locality, same province" },
  { who: "wholeMendoza", at: MZA_LAS_HERAS, sees: true, why: "a second locality, same province" },
  { who: "wholeMendoza", at: SAN_JUAN_RIVADAVIA, sees: false, why: "another province" },
  { who: "wholeMendoza", at: CABA_PALERMO, sees: false, why: "another province" },
  { who: "wholeCaba", at: CABA_PALERMO, sees: true, why: "a barrio of the whole city" },
  { who: "wholeCaba", at: PBA_LA_PLATA, sees: false, why: "Buenos Aires is not CABA" },
  { who: "lasHeras", at: MZA_LAS_HERAS, sees: true, why: "its own locality" },
  { who: "lasHeras", at: MZA_GODOY_CRUZ, sees: false, why: "a sibling locality" },
  { who: "capitalMendoza", at: MZA_GODOY_CRUZ, sees: false, why: "a capital is not the province" },
  { who: "revokedWhole", at: MZA_GODOY_CRUZ, sees: false, why: "the assignment is revoked" },
  {
    who: "deactivatedWhole",
    at: MZA_GODOY_CRUZ,
    sees: false,
    why: "the operator is deactivated",
  },
];

const EXPECTED_NULL_LOCALITY: Array<{ who: Operator; sees: boolean; why: string }> = [
  { who: "wholeMendoza", sees: true, why: "province-only branch matches a NULL locality" },
  { who: "lasHeras", sees: false, why: "an exact pair never matches NULL" },
];

function placeKey(p: Place): string {
  return `${p.province}/${p.locality ?? "<null>"}`;
}

const ROLLBACK = new Error("govt-whole-province-rls: rollback");

/** Run `body` inside a transaction that is ALWAYS rolled back. */
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

async function insertProfile(
  tx: Tx,
  role: "govt" | "owner",
  name: string,
  opts: { deactivated?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await tx.insert(profiles).values({
    id,
    displayName: name,
    role,
    accountType: role === "govt" ? "institutional" : "personal",
    deactivatedAt: opts.deactivated ? new Date() : null,
  });
  return id;
}

type Operators = Record<Operator, string>;

async function seedOperators(tx: Tx): Promise<Operators> {
  const out = {} as Operators;
  for (const [who, a] of Object.entries(ASSIGNMENTS) as Array<
    [Operator, (typeof ASSIGNMENTS)[Operator]]
  >) {
    const id = await insertProfile(tx, "govt", `J1b probe ${who}`, { deactivated: a.deactivated });
    await tx.insert(govtAssignments).values({
      userId: id,
      jurisdictionProvince: a.province,
      jurisdictionLocality: a.locality,
      revokedAt: a.revoked ? new Date() : null,
    });
    out[who] = id;
  }
  return out;
}

/** One row per surface at `place`, owned/raised by `citizen` (never a probe). */
async function seedRowsAt(
  tx: Tx,
  place: Place,
  citizen: string,
): Promise<Record<SurfaceTable, string | null>> {
  const [pet] = await tx
    .insert(pets)
    .values({
      publicToken: token("DIM-J1B"),
      name: `J1b probe pet ${placeKey(place)}`,
      species: "dog",
      jurisdictionProvince: place.province,
      jurisdictionLocality: place.locality,
    })
    .returning({ id: pets.id });
  const [ident] = await tx
    .insert(petIdentifications)
    .values({
      petId: pet.id,
      kind: "collar_tag",
      code: token("J1B-TAG"),
      status: "active",
      recordedAt: "2026-09-22",
    })
    .returning({ id: petIdentifications.id });
  const [dog] = await tx
    .insert(petServiceDog)
    .values({ petId: pet.id, serviceType: "guia", trainingCenter: "J1b probe" })
    .returning({ id: petServiceDog.id });
  const [kase] = await tx
    .insert(cases)
    .values({
      publicCode: token("CAS"),
      caseKind: "bite_incident",
      status: "open",
      primarySubjectKind: "registered_pet",
      primaryPetId: pet.id,
      jurisdictionProvince: place.province,
      jurisdictionLocality: place.locality,
      openedReason: "govt-whole-province-rls fixture",
    })
    .returning({ id: cases.id });

  // approval_requests and custody_disputes carry a NOT NULL locality: they
  // exist only for the named places.
  if (place.locality === null) {
    return {
      approval_requests: null,
      custody_disputes: null,
      custody_dispute_parties: null,
      pet_identifications: ident.id,
      pet_service_dog: dog.id,
      cases: kase.id,
    };
  }

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
      jurisdictionProvince: place.province,
      jurisdictionLocality: place.locality,
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
      jurisdictionProvince: place.province,
      jurisdictionLocality: place.locality,
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

/** Evaluate the live policy predicate for `userId` against one row. */
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

/**
 * Build every fixture, run `decide` for each expectation, and return the
 * mismatches — one assertion per surface that names every wrong answer.
 */
async function mismatchesFor(
  surface: SurfaceTable,
  decideFor: (tx: Tx) => Promise<Decide>,
): Promise<string[]> {
  const wrong: string[] = [];
  let probed = 0;
  await inRolledBackTx(async (tx) => {
    const citizen = await insertProfile(tx, "owner", "J1b probe citizen");
    const ops = await seedOperators(tx);
    const decide = await decideFor(tx);
    const places = [
      MZA_GODOY_CRUZ,
      MZA_LAS_HERAS,
      SAN_JUAN_RIVADAVIA,
      CABA_PALERMO,
      PBA_LA_PLATA,
      MZA_NO_LOCALITY,
    ];
    const rows = new Map<string, Record<SurfaceTable, string | null>>();
    for (const p of places) rows.set(placeKey(p), await seedRowsAt(tx, p, citizen));

    for (const e of EXPECTED) {
      const rowId = rows.get(placeKey(e.at))?.[surface];
      if (!rowId) throw new Error(`no ${surface} fixture at ${placeKey(e.at)}`);
      const got = await decide(tx, rowId, ops[e.who]);
      probed++;
      if (got !== e.sees) {
        wrong.push(`${e.who} @ ${placeKey(e.at)}: expected ${e.sees} (${e.why}), got ${got}`);
      }
    }
    const nullRow = rows.get(placeKey(MZA_NO_LOCALITY))?.[surface];
    if (nullRow) {
      for (const e of EXPECTED_NULL_LOCALITY) {
        const got = await decide(tx, nullRow, ops[e.who]);
        probed++;
        if (got !== e.sees) {
          wrong.push(`${e.who} @ Mendoza/<null>: expected ${e.sees} (${e.why}), got ${got}`);
        }
      }
    }
  });
  // Non-vacuity: a harness that probed nothing reports zero mismatches too.
  expect(probed).toBeGreaterThanOrEqual(EXPECTED.length);
  return wrong;
}

describe("RLS whole-province govt assignment (migration 0241)", () => {
  for (const { table, policy } of SURFACES) {
    it(`${table} — "${policy}" mirrors isWholeProvinceLocality`, async () => {
      const wrong = await mismatchesFor(table, async (tx) => {
        const qual = await liveQual(tx, table, policy);
        return (t, rowId, userId) => policyAdmits(t, table, qual, rowId, userId);
      });
      expect(wrong).toEqual([]);
    });
  }

  it("cases — can_read_case (SECURITY DEFINER) mirrors isWholeProvinceLocality", async () => {
    const wrong = await mismatchesFor("cases", async () => canReadCase);
    expect(wrong).toEqual([]);
  });
});

// The approval_requests govt branch carries a TYPE filter as well as the
// jurisdiction (fresh-context security review of 0241): without it, a
// whole-province operator reads every service_dog_credential_verification in
// the province through PostgREST — a disability-adjacent inference the
// application's own queue (visibleRequestsClause) never shows a govt.
const APPROVAL_POLICY = "approval requests visible to applicant or authority";

describe("approval_requests govt branch — only GOVT_DECIDABLE_TYPES (migration 0241)", () => {
  it("the SQL type list equals GOVT_DECIDABLE_TYPES exactly", async () => {
    let listed: string[] = [];
    await inRolledBackTx(async (tx) => {
      const qual = await liveQual(tx, "approval_requests", APPROVAL_POLICY);
      const govtTail = qual.slice(qual.indexOf("'govt'::user_role"));
      const m = /type = ANY \(ARRAY\[([^\]]*)\]\)/.exec(govtTail);
      if (!m) throw new Error(`no type filter in the govt branch of the live policy: ${qual}`);
      listed = [...m[1].matchAll(/'([a-z_]+)'::text/g)].map((x) => x[1]);
    });
    expect(listed.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...GOVT_DECIDABLE_TYPES].sort());
  });

  it("a whole-province govt never reads a service-dog credential request in its province", async () => {
    const got: Record<string, boolean> = {};
    await inRolledBackTx(async (tx) => {
      const citizen = await insertProfile(tx, "owner", "J1b probe citizen");
      const ops = await seedOperators(tx);
      const qual = await liveQual(tx, "approval_requests", APPROVAL_POLICY);
      const requestAt = async (
        type: "service_dog_credential_verification" | "role_upgrade_vet",
      ) => {
        const [row] = await tx
          .insert(approvalRequests)
          .values({
            publicToken: token("APR"),
            type,
            applicantUserId: citizen,
            targetUserId: citizen,
            jurisdictionProvince: MZA_LAS_HERAS.province,
            jurisdictionLocality: "Las Heras",
          })
          .returning({ id: approvalRequests.id });
        return row.id;
      };
      const serviceDog = await requestAt("service_dog_credential_verification");
      // Control on the same place and operators: a decidable type IS visible,
      // so a refusal above is the type filter, not a broken fixture.
      const vet = await requestAt("role_upgrade_vet");
      for (const who of ["wholeMendoza", "lasHeras"] as const) {
        got[`${who}/service_dog`] = await policyAdmits(
          tx,
          "approval_requests",
          qual,
          serviceDog,
          ops[who],
        );
        got[`${who}/vet`] = await policyAdmits(tx, "approval_requests", qual, vet, ops[who]);
      }
      // The applicant still reads their own request, whatever its type.
      got["applicant/service_dog"] = await policyAdmits(
        tx,
        "approval_requests",
        qual,
        serviceDog,
        citizen,
      );
    });
    expect(got).toEqual({
      "wholeMendoza/service_dog": false,
      "wholeMendoza/vet": true,
      "lasHeras/service_dog": false,
      "lasHeras/vet": true,
      "applicant/service_dog": true,
    });
  });
});
