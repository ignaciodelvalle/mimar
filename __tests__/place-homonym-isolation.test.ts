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

import { createClient } from "@supabase/supabase-js";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { arLocalities, db, govtAssignments, profiles } from "@/db";
import { type CoverageArea, type PetZone, orgCoversZone } from "@/lib/domain/org-coverage";
import {
  type ApprovalJurisdiction,
  findAuthoritiesForJurisdiction,
} from "@/lib/infra/approval-routing";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

const ALBERTI_OPERATOR = "homonym-iso-alberti@dim-test.local";
const BRAGADO_OPERATOR = "homonym-iso-bragado@dim-test.local";

const rowIdByIndec = new Map<string, string>();
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
  await db.insert(govtAssignments).values({
    userId: id,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "Mechita",
    localityId: rowIdByIndec.get(indecId),
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
  // Known failure until work unit D5 (localidades-por-id): flip to `it` there.
  it.fails("an org covering Bragado's Mechita does not cover Alberti's", () => {
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
    expect(orgCoversZone([bragadoCoverage], albertiZone)).toBe(false);
  });
});

describe("authority routing (D3)", () => {
  it("both operators hold a live Mechita grant, each on their own row", async () => {
    const rows = await db
      .select({ userId: govtAssignments.userId, localityId: govtAssignments.localityId })
      .from(govtAssignments)
      .where(inArray(govtAssignments.userId, [...operatorIdByEmail.values()]));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.localityId)).size).toBe(2);
  });

  // Known failure until work unit D3 (localidades-por-id): flip to `it` there.
  it.fails(
    "a bite in Alberti's Mechita pages Alberti's operator and nobody in Bragado",
    async () => {
      const paged = await findAuthoritiesForJurisdiction(albertiPlace(), {
        route: "place_homonym_isolation_fence",
      });
      expect(paged).toContain(operatorIdByEmail.get(ALBERTI_OPERATOR));
      expect(paged).not.toContain(operatorIdByEmail.get(BRAGADO_OPERATOR));
    },
  );
});

describe("read scope, RLS and rules", () => {
  it.todo("scope (D2): Bragado's operator reads no Alberti pet, case or denuncia");
  it.todo("RLS (D8): the five policies and can_read_case refuse Alberti's rows to Bragado");
  it.todo("rules (D4): a Bragado ordinance never governs an Alberti dog");
});
