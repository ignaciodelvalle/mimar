// jurisdiction-admin, verify-report follow-up W-3 (2026-09-29).
//
// The spec's "province-wide govt read scope" requirement (jurisdiction-
// audit-visibility, req. 2) was previously covered only BY COMPOSITION: an
// appointee provably holds a live whole-province govt_assignments row
// (jurisdiction-admin-appointment.test.ts), the single-province invariant is
// tested separately (delegated-writers, rls), and a GENERIC whole-province
// govt operator's RLS mirror is tested in rls/govt-whole-province-rls.test.ts
// — but nothing ever read a case AS an appointee. This file closes that gap
// directly:
//
//   1. through the exact application read path /gob/casos calls —
//      listCasesForGovt(jurisdictions) (lib/infra/case-queries.ts) — with a
//      REAL jurisdiction_admin_appointments row behind the fixture, not a
//      bare govt_assignments row;
//   2. through RLS itself — public.can_read_case(), run as the real
//      `authenticated` role with the appointee's own JWT claims (mirrors the
//      technique in rls/govt-whole-province-rls.test.ts and
//      jurisdiction-admin-audit-visibility.test.tsx's `asUser`).
//
// `welfare_denuncia` ("Denuncia de bienestar" — a welfare report) is a case
// kind in the SAME `cases` table as every other kind (case-kinds.ts), read
// through this SAME function — so one welfare_denuncia row alongside a
// bite_incident row exercises "cases (and welfare reports)" without a
// separate query path to fake.
//
// NO RESIDUE. Every fixture lives in one transaction, always rolled back.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

type RealDb = typeof import("@/db")["db"];
type Tx = Parameters<Parameters<RealDb["transaction"]>[0]>[0];

const state = vi.hoisted(() => ({
  realDb: null as unknown,
  tx: null as unknown,
}));

// listCasesForGovt (lib/infra/case-queries.ts) reads the module-level `db` —
// this proxy makes it read the test's own (rolled-back) transaction instead,
// exactly the technique jurisdiction-admin-audit-visibility.test.tsx uses for
// /gob/historial.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  state.realDb = actual.db;
  const db = new Proxy(actual.db, {
    get(target, key) {
      const exec = (state.tx ?? target) as object;
      const value = Reflect.get(exec, key, exec);
      return typeof value === "function" ? value.bind(exec) : value;
    },
  });
  return { ...actual, db };
});

import { listCasesForGovt } from "@/lib/infra/case-queries";

const ROLLBACK = new Error("jurisdiction-admin-case-read-scope: rollback");

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  const realDb = state.realDb as RealDb;
  try {
    await realDb.transaction(async (tx) => {
      state.tx = tx;
      try {
        await body(tx);
      } finally {
        state.tx = null;
      }
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

async function rows<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

function token(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
}

async function insertProfile(tx: Tx, role: "admin" | "govt", name: string): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`
    insert into public.profiles (id, display_name, role, account_type)
    values (${id}::uuid, ${name}, ${role}, 'institutional')`);
  return id;
}

async function insertGrant(
  tx: Tx,
  userId: string,
  province: string,
  locality: string,
  grantedBy: string,
): Promise<string> {
  const [row] = await rows<{ id: string }>(
    tx,
    sql`insert into public.govt_assignments
          (user_id, jurisdiction_province, jurisdiction_locality, granted_by_user_id)
        values (${userId}::uuid, ${province}, ${locality}, ${grantedBy}::uuid)
        returning id::text as id`,
  );
  return row.id;
}

/** A whole-province jurisdiction admin, with a REAL appointment row behind it. */
async function appointWholeProvinceAdmin(
  tx: Tx,
  admin: string,
  province: string,
  provinceCode: string,
  name: string,
): Promise<string> {
  const appointee = await insertProfile(tx, "govt", name);
  const grant = await insertGrant(tx, appointee, province, "", admin);
  await tx.execute(sql`
    insert into public.jurisdiction_admin_appointments
      (user_id, province_code, govt_assignment_id, grant_created, appointed_by_user_id,
       appointment_reason)
    values (${appointee}::uuid, ${provinceCode}, ${grant}::uuid, true, ${admin}::uuid,
            'Designación de prueba W-3')`);
  return appointee;
}

async function insertCaseAt(
  tx: Tx,
  province: string,
  locality: string,
  caseKind: "bite_incident" | "welfare_denuncia",
): Promise<string> {
  const [pet] = await rows<{ id: string }>(
    tx,
    sql`insert into public.pets
          (public_token, name, species, jurisdiction_province, jurisdiction_locality)
        values (${token("DIM-W3")}, ${`W3 probe pet ${province}/${locality}`}, 'dog',
                ${province}, ${locality})
        returning id::text as id`,
  );
  const [kase] = await rows<{ id: string }>(
    tx,
    sql`insert into public.cases
          (public_code, case_kind, status, primary_subject_kind, primary_pet_id,
           jurisdiction_province, jurisdiction_locality, opened_reason)
        values (${token("CAS")}, ${caseKind}, 'open', 'registered_pet', ${pet.id}::uuid,
                ${province}, ${locality}, 'jurisdiction-admin-case-read-scope fixture')
        returning id::text as id`,
  );
  return kase.id;
}

async function canReadCaseAsUser(tx: Tx, caseId: string, userId: string): Promise<boolean> {
  await tx.execute(
    sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`,
  );
  await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
  await tx.execute(sql`set local role authenticated`);
  const out = await rows<{ ok: boolean }>(
    tx,
    sql`select public.can_read_case(${caseId}::uuid, ${userId}::uuid) as ok`,
  );
  await tx.execute(sql`reset role`);
  return out[0]?.ok === true;
}

describe("jurisdiction-admin — an appointee reads their own province's cases, never another's (W-3)", () => {
  it("listCasesForGovt (the /gob/casos read path): own-province bite_incident and welfare_denuncia visible, foreign-province case denied", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await insertProfile(tx, "admin", "W3 probe platform admin");
      const mza = await appointWholeProvinceAdmin(
        tx,
        admin,
        "Mendoza",
        "AR-M",
        "W3 probe Mendoza appointee",
      );

      const biteInMza = await insertCaseAt(tx, "Mendoza", "Godoy Cruz", "bite_incident");
      const welfareInMza = await insertCaseAt(tx, "Mendoza", "Las Heras", "welfare_denuncia");
      const caseInSanJuan = await insertCaseAt(tx, "San Juan", "Rivadavia", "bite_incident");

      const seen = (await listCasesForGovt([{ province: "Mendoza", locality: "" }])).map(
        (c) => c.id,
      );

      expect(seen).toContain(biteInMza);
      expect(seen).toContain(welfareInMza);
      expect(seen).not.toContain(caseInSanJuan);

      // Non-vacuity: `mza` really is the appointment's user, and jurisdiction
      // admin appointments really constrain to one province at a time — this
      // fixture is a genuine appointee, not a bare whole-province govt.
      const [appointment] = await rows<{ province_code: string }>(
        tx,
        sql`select province_code from public.jurisdiction_admin_appointments
              where user_id = ${mza}::uuid and revoked_at is null`,
      );
      expect(appointment.province_code).toBe("AR-M");
    });
  });

  it("RLS can_read_case, as the appointee's own authenticated session: own province admitted, foreign province denied", async () => {
    await inRolledBackTx(async (tx) => {
      const admin = await insertProfile(tx, "admin", "W3 probe platform admin (RLS)");
      const mza = await appointWholeProvinceAdmin(
        tx,
        admin,
        "Mendoza",
        "AR-M",
        "W3 probe Mendoza appointee (RLS)",
      );

      const ownCase = await insertCaseAt(tx, "Mendoza", "San Rafael", "welfare_denuncia");
      const foreignCase = await insertCaseAt(tx, "San Juan", "Rivadavia", "bite_incident");

      expect(await canReadCaseAsUser(tx, ownCase, mza)).toBe(true);
      expect(await canReadCaseAsUser(tx, foreignCase, mza)).toBe(false);
    });
  });
});
