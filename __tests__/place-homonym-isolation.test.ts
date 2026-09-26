// Fence: two localities that share a name are two places, to every decision.
//
// R1 of the 2026-09-25 localities audit, and the change's first property (P1:
// never confuse places). Mechita exists twice inside Buenos Aires — partido
// Alberti (INDEC 06021030) and partido Bragado (06112080). Scope, RLS, alert
// routing, business rules and org coverage all compare the (province, locality
// NAME) pair, so Bragado's operator sees Alberti's animals, is paged for
// Alberti's bites and applies her ordinance to Alberti's dogs. C2b (0246) made
// the GRANT record the right row; nothing reads it yet.
//
// THIS FILE IS RED ON PURPOSE UNTIL STAGE D of localidades-por-id. Every case is
// a known failure (`it.fails`) and flips to `it` in the work unit that closes it:
//   coverage → D5 · routing → D3 · scope → D2 · RLS → D8 · rules → D4.
// A known failure that starts passing fails this file, so the unit that fixes
// one cannot forget to say so.
//
// STAGE D: each operator's grant is on the authority unit of their own partido
// (authority_unit_id set, as the partial-grant confirm flow writes it), and
// every case asks the ID path explicitly — the shared flags stay on 'name'. A
// LEGACY grant (unit NULL) answers the same on both paths by design, so the
// name confusion it carries is fenced as identical, not as fixed, in
// __tests__/authority-routing-by-unit.test.ts.

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  arLocalities,
  authorityUnitLocalities,
  db,
  govtAssignments,
  pets,
  profiles,
  welfareReports,
} from "@/db";
import { type CoverageArea, type PetZone, orgCoversZone } from "@/lib/domain/org-coverage";
import {
  type ApprovalJurisdiction,
  findAuthoritiesForJurisdiction,
} from "@/lib/infra/approval-routing";
import { canReadCase } from "@/lib/infra/case-access";
import type { CaseDetail } from "@/lib/infra/case-queries";
import { loadOperatorPetSubView } from "@/lib/infra/gob-pet-subview";
import { loadWelfareInspectorDetail } from "@/lib/infra/welfare-inspector-detail";
import { jurisdictionPairClause } from "@/lib/metrics/scope";
import { scopedGrants } from "@/lib/place/scope";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

const ALBERTI_OPERATOR = "homonym-iso-alberti@dim-test.local";
const BRAGADO_OPERATOR = "homonym-iso-bragado@dim-test.local";

const rowIdByIndec = new Map<string, string>();
// Units this file confirmed (they were drafts): put back to draft in afterAll.
// Only a CONFIRMED unit governs anything (stage D review W1).
const unitsConfirmedHere = new Set<string>();
const operatorIdByEmail = new Map<string, string>();

async function govtOperator(email: string, indecId: string): Promise<string> {
  await deleteTestUser(adminSdk, db, email);
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "HomonymIso_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  const id = r.data.user.id;
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, id));
  const localityId = rowIdByIndec.get(indecId);
  const [unit] = await db
    .select({ unitId: authorityUnitLocalities.unitId })
    .from(authorityUnitLocalities)
    .where(
      and(
        eq(authorityUnitLocalities.localityId, localityId as string),
        eq(authorityUnitLocalities.level, "municipal"),
        isNull(authorityUnitLocalities.validTo),
      ),
    );
  expect(
    unit,
    `Mechita ${indecId} must be in a municipal unit (seed:authority-units)`,
  ).toBeTruthy();
  const confirmedNow = (await db.execute(sql`
    update public.authority_units set status = 'confirmed', confirmed_at = now()
     where id = ${unit?.unitId}::uuid and status = 'draft'
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  for (const r of confirmedNow) unitsConfirmedHere.add(r.id);
  await db.insert(govtAssignments).values({
    userId: id,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Mechita",
    localityId,
    authorityUnitId: unit?.unitId,
  });
  return id;
}

beforeAll(async () => {
  const rows = await db
    .select({ id: arLocalities.id, indecId: arLocalities.indecId })
    .from(arLocalities)
    .where(inArray(arLocalities.indecId, [MECHITA_ALBERTI, MECHITA_BRAGADO]));
  for (const r of rows) if (r.indecId) rowIdByIndec.set(r.indecId, r.id);
  expect(rowIdByIndec.size, "both Mechita catalogue rows must exist").toBe(2);

  operatorIdByEmail.set(ALBERTI_OPERATOR, await govtOperator(ALBERTI_OPERATOR, MECHITA_ALBERTI));
  operatorIdByEmail.set(BRAGADO_OPERATOR, await govtOperator(BRAGADO_OPERATOR, MECHITA_BRAGADO));
});

afterAll(async () => {
  for (const [email, id] of operatorIdByEmail) {
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, id));
    await deleteTestUser(adminSdk, db, email);
  }
  for (const id of unitsConfirmedHere) {
    await db.execute(sql`
      update public.authority_units set status = 'draft', confirmed_at = null, confirmed_by = null
       where id = ${id}::uuid
    `);
  }
});

/** The bite, the lost dog or the denuncia happened in Alberti's Mechita. */
function albertiPlace(): ApprovalJurisdiction & { localityId: string | undefined } {
  return {
    province: "Buenos Aires",
    locality: "Mechita",
    localityId: rowIdByIndec.get(MECHITA_ALBERTI),
  };
}

describe("coverage (D5)", () => {
  // Closed by D5: the id path compares the zone's recorded catalogue row.
  it("an org covering Bragado's Mechita does not cover Alberti's", () => {
    const bragadoCoverage = {
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mechita",
      localityId: rowIdByIndec.get(MECHITA_BRAGADO),
    } as CoverageArea;
    const albertiZone = {
      province: "Buenos Aires",
      locality: "Mechita",
      localityId: rowIdByIndec.get(MECHITA_ALBERTI),
    } as PetZone;
    expect(orgCoversZone([bragadoCoverage], albertiZone, "id")).toBe(false);
  });
});

describe("authority routing (D3)", () => {
  it("both operators hold a live Mechita grant, each on their own row and unit", async () => {
    const rows = await db
      .select({
        userId: govtAssignments.userId,
        localityId: govtAssignments.localityId,
        unitId: govtAssignments.authorityUnitId,
      })
      .from(govtAssignments)
      .where(inArray(govtAssignments.userId, [...operatorIdByEmail.values()]));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.localityId)).size).toBe(2);
    expect(new Set(rows.map((r) => r.unitId)).size).toBe(2);
  });

  // Closed by D3: the id path routes by unit.
  it("a bite in Alberti's Mechita pages Alberti's operator and nobody in Bragado", async () => {
    const paged = await findAuthoritiesForJurisdiction(albertiPlace(), {
      route: "place_homonym_isolation_fence",
      mode: "id",
    });
    expect(paged).toContain(operatorIdByEmail.get(ALBERTI_OPERATOR));
    expect(paged).not.toContain(operatorIdByEmail.get(BRAGADO_OPERATOR));
  });
});

/** Is a pet row at `localityId` (named Mechita) inside `userId`'s id-path scope? */
async function scopeSees(userId: string, localityId: string | null): Promise<boolean> {
  const grants = await db
    .select({
      assignmentId: govtAssignments.id,
      province: govtAssignments.jurisdictionProvince,
      locality: govtAssignments.jurisdictionLocality,
      authorityUnitId: govtAssignments.authorityUnitId,
    })
    .from(govtAssignments)
    .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
  const clause = jurisdictionPairClause(
    await scopedGrants(userId, grants, { mode: "id" }),
    sql`${pets.jurisdictionProvince}`,
    sql`${pets.jurisdictionLocality}`,
    sql`${pets.localityId}`,
  );
  const rows = (await db.execute(sql`
    select coalesce(${clause ?? sql`false`}, false) as visible
      from (values ('Buenos Aires'::text, 'Mechita'::text, ${localityId}::uuid))
        as pets (jurisdiction_province, jurisdiction_locality, locality_id)
  `)) as unknown as Array<{ visible: boolean }>;
  return rows[0]?.visible === true;
}

describe("read scope, RLS and rules", () => {
  // Closed by D2: a unit grant's scope clause matches by catalogue id.
  it("scope (D2): Bragado's operator reads no Alberti pet, case or denuncia", async () => {
    const alberti = rowIdByIndec.get(MECHITA_ALBERTI) as string;
    const bragado = rowIdByIndec.get(MECHITA_BRAGADO) as string;
    const bragadoOp = operatorIdByEmail.get(BRAGADO_OPERATOR) as string;
    const albertiOp = operatorIdByEmail.get(ALBERTI_OPERATOR) as string;
    expect(await scopeSees(bragadoOp, alberti)).toBe(false);
    expect(await scopeSees(bragadoOp, bragado)).toBe(true);
    expect(await scopeSees(albertiOp, alberti)).toBe(true);
    // An unresolved Mechita reaches neither partido (only the province would).
    expect(await scopeSees(albertiOp, null)).toBe(false);
  });
  // RLS (D8): the five policies and can_read_case refuse Alberti's rows to
  // Bragado — closed in __tests__/rls/govt-unit-scope-rls.test.ts, which
  // evaluates the LIVE quals against Mechita fixtures.
  // Rules (D4): a Bragado ordinance never governs an Alberti dog — closed in
  // __tests__/business-rules-by-unit.test.ts.
});

// ---------------------------------------------------------------------------
// Per-row gates (stage D audit addendum (c)).
//
// A list clause is not the only door: a case, a denuncia or a pet opened BY
// URL is gated per row by jurisdictionScopeContains. On the id path a unit
// grant compares the row's catalogue id there too, so Bragado's operator
// cannot open Alberti's Mechita by typing its address, and Alberti's can.
// Real rows (the loaders read through the shared connection), removed in
// afterAll.
// ---------------------------------------------------------------------------

const ROW_PET_TOKEN = `HISO-ALB-${Date.now()}`;
let rowPetId = "";
let rowReportId = "";

/** The operator's grants as the id path hands them to a per-row gate. */
async function idPathJurisdictions(userId: string) {
  const grants = await db
    .select({
      assignmentId: govtAssignments.id,
      province: govtAssignments.jurisdictionProvince,
      locality: govtAssignments.jurisdictionLocality,
      authorityUnitId: govtAssignments.authorityUnitId,
    })
    .from(govtAssignments)
    .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
  return scopedGrants(userId, grants, { mode: "id" });
}

describe("per-row gates (addendum c)", () => {
  beforeAll(async () => {
    const alberti = rowIdByIndec.get(MECHITA_ALBERTI) as string;
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: ROW_PET_TOKEN,
        name: "Homonimo Alberti",
        species: "dog",
        sex: "male",
        status: "active",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Mechita",
        localityId: alberti,
      })
      .returning({ id: pets.id });
    rowPetId = pet?.id ?? "";
    const [report] = await db
      .insert(welfareReports)
      .values({
        referenceCode: `DEN-HISO-${String(Date.now()).slice(-4)}`,
        kind: "neglect",
        severity: "medium",
        description: "homonym isolation fixture",
        subjectKind: "unowned_animal",
        subjectDescription: "stray test",
        status: "in_progress",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "Mechita",
        localityId: alberti,
      })
      .returning({ id: welfareReports.id });
    rowReportId = report?.id ?? "";
  });

  afterAll(async () => {
    await withMutationOverride(async (tx) => {
      await tx.delete(welfareReports).where(eq(welfareReports.id, rowReportId));
      await tx.delete(pets).where(eq(pets.id, rowPetId));
    });
  });

  it("canReadCase: Bragado's operator cannot open Alberti's case; Alberti's can", async () => {
    const detail = {
      caseKind: "welfare_denuncia",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mechita",
      localityId: rowIdByIndec.get(MECHITA_ALBERTI),
    } as unknown as CaseDetail;
    const viewer = async (email: string) => {
      const userId = operatorIdByEmail.get(email) as string;
      return { userId, role: "govt" as const, jurisdictions: await idPathJurisdictions(userId) };
    };
    expect(await canReadCase(detail, await viewer(BRAGADO_OPERATOR))).toBe(false);
    expect(await canReadCase(detail, await viewer(ALBERTI_OPERATOR))).toBe(true);
  });

  it("the operator pet view: Alberti's Mechita pet is not found for Bragado", async () => {
    const view = async (email: string) =>
      loadOperatorPetSubView(ROW_PET_TOKEN, {
        role: "govt",
        jurisdictions: await idPathJurisdictions(operatorIdByEmail.get(email) as string),
      });
    expect(await view(BRAGADO_OPERATOR)).toBeNull();
    expect(await view(ALBERTI_OPERATOR)).not.toBeNull();
  });

  it("the denuncia inspector detail: Alberti's report is not found for Bragado", async () => {
    const open = async (email: string) => {
      const id = operatorIdByEmail.get(email) as string;
      return loadWelfareInspectorDetail(
        {
          profile: { id, role: "govt" },
          jurisdictions: await idPathJurisdictions(id),
          user: { id },
        },
        rowReportId,
      );
    };
    expect((await open(BRAGADO_OPERATOR)).ok).toBe(false);
    expect((await open(ALBERTI_OPERATOR)).ok).toBe(true);
  });
});
