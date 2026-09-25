// C2b — the government forms keep the INDEC locality id end to end.
//
// /admin/govts/new (CreateGovtForm) and the "Asignar nueva localidad" form
// (AssignLocalityForm) both pick a locality with LocalityPickerAcross, which
// resolves the INDEC id of the row the admin tapped. Until C2b both forms
// dropped it and the writers re-resolved the NAME through `localityByName`,
// which takes the alphabetically first department — so for any of the 68
// within-province homonyms the grant could land on a locality nobody chose.
//
// These tests drive the two writers the forms' server actions call, against
// the real catalogue, and read back govt_assignments.locality_id (migration
// 0246): the row that was picked is the row that is recorded.
//
//   - Villa María exists in Córdoba (General San Martín, 14042170) and in
//     Buenos Aires (Alberti, 06021060): the cross-province pair from C2.
//   - Mechita exists TWICE inside Buenos Aires (Alberti 06021030, Bragado
//     06112080): the within-province pair the name path cannot tell apart.

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The access-link mail goes out through Resend; replace the provider so the
// create flow never reaches the network.
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: async () => ({ data: { id: "mail-1" }, error: null }) };
  },
}));

import { arLocalities, auditLog, db, govtAssignments, notifications, profiles } from "@/db";
import { assignGovtLocalityForAuthority } from "@/src/modules/organizations/application/admin-institutional/assign-govt-locality";
import { createInstitutionalAccountForAuthority } from "@/src/modules/organizations/application/admin-institutional/create-institutional-account";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser, deleteTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const ACTOR_EMAIL = "c2b-indec-actor@dim-test.local";
const TARGET_EMAIL = "c2b-indec-target@dim-test.local";
const TARGET_B_EMAIL = "c2b-indec-target-b@dim-test.local";
const CREATED_EMAILS = [
  "c2b-indec-new-villa-maria@dim-test.local",
  "c2b-indec-new-mechita@dim-test.local",
  "c2b-indec-new-two-mechitas@dim-test.local",
];

const VILLA_MARIA_CORDOBA = "14042170";
const VILLA_MARIA_BUENOS_AIRES = "06021060";
const MECHITA_ALBERTI = "06021030";
const MECHITA_BRAGADO = "06112080";

let actorId: string;
let targetId: string;
let targetBId: string;
const rowIdByIndec = new Map<string, string>();

async function profileIdByEmail(email: string): Promise<string | null> {
  const { data } = await adminSdk.auth.admin.listUsers({ perPage: 1000 });
  return data?.users.find((u) => u.email === email)?.id ?? null;
}

async function purge(email: string) {
  const uid = await profileIdByEmail(email);
  if (uid) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
      await tx.delete(auditLog).where(eq(auditLog.targetUserId, uid));
    });
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, uid));
    await db
      .update(govtAssignments)
      .set({ grantedByUserId: null })
      .where(eq(govtAssignments.grantedByUserId, uid));
    await db.delete(notifications).where(eq(notifications.userId, uid));
  }
  await deleteTestUser(adminSdk, db, email);
}

async function institutionalUser(email: string, role: "admin" | "govt"): Promise<string> {
  await purge(email);
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "C2bIndec_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  await db
    .update(profiles)
    .set({ role, accountType: "institutional" })
    .where(eq(profiles.id, r.data.user.id));
  return r.data.user.id;
}

async function activeRows(userId: string) {
  return db
    .select({
      province: govtAssignments.jurisdictionProvince,
      locality: govtAssignments.jurisdictionLocality,
      localityId: govtAssignments.localityId,
    })
    .from(govtAssignments)
    .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
}

beforeAll(async () => {
  const rows = await db
    .select({ id: arLocalities.id, indecId: arLocalities.indecId })
    .from(arLocalities)
    .where(
      inArray(arLocalities.indecId, [
        VILLA_MARIA_CORDOBA,
        VILLA_MARIA_BUENOS_AIRES,
        MECHITA_ALBERTI,
        MECHITA_BRAGADO,
      ]),
    );
  for (const r of rows) if (r.indecId) rowIdByIndec.set(r.indecId, r.id);
  // The fixtures ARE the catalogue: if a re-import renumbered them, say so
  // instead of letting every assertion below fail for an unrelated reason.
  expect(rowIdByIndec.size, "the four INDEC fixture rows must exist").toBe(4);

  actorId = await institutionalUser(ACTOR_EMAIL, "admin");
  targetId = await institutionalUser(TARGET_EMAIL, "govt");
  targetBId = await institutionalUser(TARGET_B_EMAIL, "govt");
  for (const email of CREATED_EMAILS) await purge(email);
});

afterAll(async () => {
  for (const email of [...CREATED_EMAILS, TARGET_EMAIL, TARGET_B_EMAIL, ACTOR_EMAIL]) {
    await purge(email);
  }
});

describe("AssignLocalityForm → assignGovtLocalityForAuthority keeps the picked row", () => {
  it("Villa María (Córdoba) and Villa María (Buenos Aires) land on their own rows", async () => {
    const cba = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetId,
      province: "Córdoba",
      locality: "Villa María",
      localityIndecId: VILLA_MARIA_CORDOBA,
    });
    const ba = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetId,
      province: "Buenos Aires",
      locality: "Villa María",
      localityIndecId: VILLA_MARIA_BUENOS_AIRES,
    });
    expect(cba).not.toHaveProperty("error");
    expect(ba).not.toHaveProperty("error");

    const rows = await activeRows(targetId);
    expect(rows).toContainEqual({
      province: "Córdoba",
      locality: "Villa María",
      localityId: rowIdByIndec.get(VILLA_MARIA_CORDOBA),
    });
    expect(rows).toContainEqual({
      province: "Buenos Aires",
      locality: "Villa María",
      localityId: rowIdByIndec.get(VILLA_MARIA_BUENOS_AIRES),
    });
  });

  it("records Mechita (Bragado) when that is the row picked, not the alphabetically first", async () => {
    const result = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetId,
      province: "Buenos Aires",
      locality: "Mechita",
      localityIndecId: MECHITA_BRAGADO,
    });
    expect(result).not.toHaveProperty("error");

    const rows = (await activeRows(targetId)).filter((r) => r.locality === "Mechita");
    expect(rows).toEqual([
      {
        province: "Buenos Aires",
        locality: "Mechita",
        localityId: rowIdByIndec.get(MECHITA_BRAGADO),
      },
    ]);

    const [log] = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetGovtAssignmentId, "assignmentId" in result ? result.assignmentId : ""),
          eq(auditLog.action, "govt_locality_assigned"),
        ),
      );
    expect((log.payload as Record<string, unknown>).locality_id).toBe(
      rowIdByIndec.get(MECHITA_BRAGADO),
    );
  });

  it("refuses the other Mechita for the same operator instead of answering a silent no-op", async () => {
    const result = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetId,
      province: "Buenos Aires",
      locality: "Mechita",
      localityIndecId: MECHITA_ALBERTI,
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("otra localidad llamada Mechita");

    const rows = (await activeRows(targetId)).filter((r) => r.locality === "Mechita");
    expect(rows.map((r) => r.localityId)).toEqual([rowIdByIndec.get(MECHITA_BRAGADO)]);
  });

  it("the same row again is still an idempotent no-op", async () => {
    const result = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetId,
      province: "Buenos Aires",
      locality: "Mechita",
      localityIndecId: MECHITA_BRAGADO,
    });
    expect(result).toMatchObject({ ok: true, noOp: true });
  });

  it("refuses an ambiguous NAME with no INDEC id rather than guessing a department", async () => {
    const result = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetBId,
      province: "Buenos Aires",
      locality: "Mechita",
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("más de una localidad llamada Mechita");
    expect(await activeRows(targetBId)).toEqual([]);
  });

  it("an unambiguous name without an id still resolves, and records its row", async () => {
    const result = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetBId,
      province: "Córdoba",
      locality: "Villa María",
    });
    expect(result).not.toHaveProperty("error");
    expect(await activeRows(targetBId)).toEqual([
      {
        province: "Córdoba",
        locality: "Villa María",
        localityId: rowIdByIndec.get(VILLA_MARIA_CORDOBA),
      },
    ]);
  });

  it("refuses an INDEC id whose province contradicts the claimed one", async () => {
    const result = await assignGovtLocalityForAuthority(actorId, {
      targetUserId: targetBId,
      province: "Buenos Aires",
      locality: "Villa María",
      localityIndecId: VILLA_MARIA_CORDOBA,
    });
    expect(result).toHaveProperty("error");
    expect((await activeRows(targetBId)).map((r) => r.province)).toEqual(["Córdoba"]);
  });
});

describe("CreateGovtForm → createInstitutionalAccountForAuthority keeps the picked rows", () => {
  it("creates Villa María (Córdoba) AND Villa María (Buenos Aires) as two exact rows", async () => {
    const result = await createInstitutionalAccountForAuthority(actorId, {
      role: "govt",
      email: CREATED_EMAILS[0],
      displayName: "C2b Villa Maria",
      initialLocalities: [
        { province: "Córdoba", locality: "Villa María", localityIndecId: VILLA_MARIA_CORDOBA },
        {
          province: "Buenos Aires",
          locality: "Villa María",
          localityIndecId: VILLA_MARIA_BUENOS_AIRES,
        },
      ],
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;

    const rows = await activeRows(result.profileId);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      province: "Córdoba",
      locality: "Villa María",
      localityId: rowIdByIndec.get(VILLA_MARIA_CORDOBA),
    });
    expect(rows).toContainEqual({
      province: "Buenos Aires",
      locality: "Villa María",
      localityId: rowIdByIndec.get(VILLA_MARIA_BUENOS_AIRES),
    });
  });

  it("creates with Mechita (Bragado) recorded as Bragado", async () => {
    const result = await createInstitutionalAccountForAuthority(actorId, {
      role: "govt",
      email: CREATED_EMAILS[1],
      displayName: "C2b Mechita",
      initialLocalities: [
        { province: "Buenos Aires", locality: "Mechita", localityIndecId: MECHITA_BRAGADO },
      ],
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(await activeRows(result.profileId)).toEqual([
      {
        province: "Buenos Aires",
        locality: "Mechita",
        localityId: rowIdByIndec.get(MECHITA_BRAGADO),
      },
    ]);
  });

  it("refuses both Mechitas in one request before any account exists", async () => {
    const result = await createInstitutionalAccountForAuthority(actorId, {
      role: "govt",
      email: CREATED_EMAILS[2],
      displayName: "C2b Dos Mechitas",
      initialLocalities: [
        { province: "Buenos Aires", locality: "Mechita", localityIndecId: MECHITA_ALBERTI },
        { province: "Buenos Aires", locality: "Mechita", localityIndecId: MECHITA_BRAGADO },
      ],
    });
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("dos localidades llamadas Mechita");
    expect(await profileIdByEmail(CREATED_EMAILS[2])).toBeNull();
  });

  it("refuses an ambiguous name with no INDEC id before any account exists", async () => {
    const result = await createInstitutionalAccountForAuthority(actorId, {
      role: "govt",
      email: CREATED_EMAILS[2],
      displayName: "C2b Mechita sin id",
      initialLocalities: [{ province: "Buenos Aires", locality: "Mechita" }],
    });
    expect(result).toHaveProperty("error");
    expect(await profileIdByEmail(CREATED_EMAILS[2])).toBeNull();
  });
});
