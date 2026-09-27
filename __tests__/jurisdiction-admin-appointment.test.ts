// jurisdiction-admin, Phase 3 — appointing and revoking a jurisdiction
// administrator (platform admin only), the authority loader wired to the
// database twin, and the Phase-2 security-review fixes on the writers that end
// an appointee's authority (L4 DB clock, L5 appointment first + no raw trigger
// text, L6 authority read inside the transaction, L1 rule-delete snapshot).
//
// NO RESIDUE. The appointment table and audit_log are append-only, so every
// case runs inside ONE transaction that is always rolled back; the writers are
// executor-first (or take an optional executor) precisely so they can join it.
// Time comparisons read the DATABASE clock (select now()), never the host's.

import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { designationErrorMessage } from "@/app/admin/designaciones/_components/designation-errors";
import {
  attachments,
  auditLog,
  db,
  govtAssignments,
  jurisdictionAdminAppointments,
  profiles,
} from "@/db";
import { jurisdictionAdminRefusal } from "@/lib/infra/jurisdiction-admin-refusals";
import { JURISDICTION_ADMIN_REFUSAL_COPY } from "@/lib/ui/jurisdiction-admin-copy";
import { appointJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/appoint";
import {
  loadAdminAuthority,
  requireJurisdictionAdminFor,
  requirePlatformAdmin,
} from "@/src/modules/organizations/application/admin-authority/authority";
import {
  listActiveAppointments,
  listAppointmentCandidates,
} from "@/src/modules/organizations/application/admin-authority/read-appointments";
import { revokeJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/revoke";
import { deactivateGovtForAuthority } from "@/src/modules/organizations/application/admin-institutional/deactivate-govt";
import { govtSelfDeactivateForUser } from "@/src/modules/pets/application/profile/govt-self-deactivate";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ROLLBACK = new Error("jurisdiction-admin-appointment: rollback");

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

type Role = "admin" | "govt" | "owner";

async function insertProfile(tx: Tx, role: Role, name: string): Promise<string> {
  const id = randomUUID();
  await tx.insert(profiles).values({
    id,
    displayName: name,
    role,
    accountType: role === "owner" ? "personal" : "institutional",
  });
  return id;
}

async function insertGrant(
  tx: Tx,
  userId: string,
  province: string,
  locality: string,
  grantedBy: string,
): Promise<string> {
  const [row] = await tx
    .insert(govtAssignments)
    .values({
      userId,
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      grantedByUserId: grantedBy,
    })
    .returning({ id: govtAssignments.id });
  return row.id;
}

type World = {
  admin: string;
  /** Mendoza govt holding the whole province (reused on appointment). */
  mzaWhole: string;
  mzaWholeGrant: string;
  /** Mendoza govt holding one locality only (appointment creates the grant). */
  mzaLocal: string;
  /** San Juan govt, plain. */
  sj: string;
};

async function world(tx: Tx): Promise<World> {
  const admin = await insertProfile(tx, "admin", "JA3 probe platform admin");
  const mzaWhole = await insertProfile(tx, "govt", "JA3 probe Mendoza whole");
  const mzaLocal = await insertProfile(tx, "govt", "JA3 probe Mendoza local");
  const sj = await insertProfile(tx, "govt", "JA3 probe San Juan");
  const mzaWholeGrant = await insertGrant(tx, mzaWhole, "Mendoza", "", admin);
  await insertGrant(tx, mzaLocal, "Mendoza", "Godoy Cruz", admin);
  await insertGrant(tx, sj, "San Juan", "", admin);
  return { admin, mzaWhole, mzaWholeGrant, mzaLocal, sj };
}

const REASON = "Designación de prueba por resolución";

async function dbNow(tx: Tx): Promise<string> {
  const [row] = (await tx.execute(sql`select now()::text as now`)) as unknown as Array<{
    now: string;
  }>;
  return row.now;
}

// ---------------------------------------------------------------------------
// Appointing
// ---------------------------------------------------------------------------

describe("appointJurisdictionAdmin — platform admin only, one per province", () => {
  it("appoints a funcionario, REUSING their whole-province grant, and the twin makes them the admin of that province only", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const r = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      expect(r).toEqual({ ok: true, appointmentId: expect.any(String), grantCreated: false });

      const [row] = await tx
        .select()
        .from(jurisdictionAdminAppointments)
        .where(eq(jurisdictionAdminAppointments.userId, w.mzaWhole));
      expect(row.provinceCode).toBe("AR-M");
      expect(row.govtAssignmentId).toBe(w.mzaWholeGrant);
      expect(row.revokedAt).toBeNull();

      expect(await loadAdminAuthority(tx, w.mzaWhole)).toEqual({
        kind: "jurisdiction",
        provinceCode: "AR-M",
      });
      expect(await requireJurisdictionAdminFor(tx, w.mzaWhole, "AR-M")).toBe(true);
      expect(await requireJurisdictionAdminFor(tx, w.mzaWhole, "AR-J")).toBe(false);
      // Country-wide / platform-only targets: never a jurisdiction admin.
      expect(await requireJurisdictionAdminFor(tx, w.mzaWhole, null)).toBe(false);
      expect(await requirePlatformAdmin(tx, w.mzaWhole)).toBe(false);

      // The act is audited, stamped with the province, platform admin as actor.
      const [audit] = await tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "jurisdiction_admin_appointed"),
            eq(auditLog.targetUserId, w.mzaWhole),
          ),
        );
      expect(audit.actorUserId).toBe(w.admin);
      expect(audit.provinceCode).toBe("AR-M");

      const active = await listActiveAppointments(tx);
      const mine = active.find((a) => a.userId === w.mzaWhole);
      expect(mine?.authorityLive).toBe(true);
    });
  });

  it("CREATES the whole-province grant when the funcionario held only localities of the province", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const candidates = await listAppointmentCandidates(tx, "AR-M");
      expect(candidates.find((c) => c.userId === w.mzaLocal)?.hasWholeProvinceGrant).toBe(false);
      expect(candidates.find((c) => c.userId === w.mzaWhole)?.hasWholeProvinceGrant).toBe(true);
      expect(candidates.some((c) => c.userId === w.sj)).toBe(false);

      const r = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaLocal,
        provinceCode: "AR-M",
        reason: REASON,
      });
      expect(r).toMatchObject({ ok: true, grantCreated: true });
      const grants = await tx
        .select()
        .from(govtAssignments)
        .where(eq(govtAssignments.userId, w.mzaLocal));
      expect(grants.some((g) => g.jurisdictionLocality === "" && g.revokedAt === null)).toBe(true);
      expect(await loadAdminAuthority(tx, w.mzaLocal)).toEqual({
        kind: "jurisdiction",
        provinceCode: "AR-M",
      });
    });
  });

  it("a second ACTIVE appointment to the same province is refused, with the province named", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      const r = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaLocal,
        provinceCode: "AR-M",
        reason: REASON,
      });
      expect(r).toEqual({ error: "PROVINCE_TAKEN" });
      expect(designationErrorMessage("PROVINCE_TAKEN", "Córdoba")).toBe(
        "Córdoba ya tiene un administrador de jurisdicción activo.",
      );
    });
  });

  it("the unique index's refusal (a race past the pre-check) maps to the same code", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      const other = await insertProfile(tx, "govt", "JA3 probe racer");
      const otherGrant = await insertGrant(tx, other, "Mendoza", "", w.admin);
      const err = await tx
        .transaction((sp) =>
          sp.execute(sql`
            insert into public.jurisdiction_admin_appointments
              (user_id, province_code, govt_assignment_id, grant_created,
               appointed_by_user_id, appointment_reason)
            values (${other}::uuid, 'AR-M', ${otherGrant}::uuid, false, ${w.admin}::uuid, 'x')`),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(jurisdictionAdminRefusal(err)).toBe("PROVINCE_TAKEN");
    });
  });

  it("neither a jurisdiction admin nor a plain govt can appoint — in any province (escalation)", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      for (const actor of [w.mzaWhole, w.mzaLocal]) {
        for (const provinceCode of ["AR-M", "AR-J"]) {
          const r = await appointJurisdictionAdmin(tx, actor, {
            userId: provinceCode === "AR-J" ? w.sj : w.mzaLocal,
            provinceCode,
            reason: REASON,
          });
          expect(r, `${actor} appointing in ${provinceCode}`).toEqual({ error: "PLATFORM_ONLY" });
        }
      }
      expect(designationErrorMessage("PLATFORM_ONLY", "Mendoza")).toContain(
        "Solo el administrador de la plataforma puede designar o revocar administradores de jurisdicción",
      );
    });
  });

  it("refuses a non-govt appointee, a foreign grant, a person already appointed, and a missing reason", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const citizen = await insertProfile(tx, "owner", "JA3 probe citizen");
      expect(
        await appointJurisdictionAdmin(tx, w.admin, {
          userId: citizen,
          provinceCode: "AR-M",
          reason: REASON,
        }),
      ).toEqual({ error: "APPOINTEE_INVALID" });
      // San Juan grant held, appointing for Mendoza.
      expect(
        await appointJurisdictionAdmin(tx, w.admin, {
          userId: w.sj,
          provinceCode: "AR-M",
          reason: REASON,
        }),
      ).toEqual({ error: "FOREIGN_GRANT" });
      await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.sj,
        provinceCode: "AR-J",
        reason: REASON,
      });
      expect(
        await appointJurisdictionAdmin(tx, w.admin, {
          userId: w.sj,
          provinceCode: "AR-M",
          reason: REASON,
        }),
      ).toEqual({ error: "USER_ALREADY_APPOINTED" });
      const blank = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: "   ",
      });
      expect("error" in blank && blank.error.startsWith("VALIDATION_ERROR: ")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Revoking, and failing closed
// ---------------------------------------------------------------------------

describe("revokeJurisdictionAdmin — platform admin only; authority fails closed", () => {
  it("revokes the appointment AND the grant it created; the appointee is plain govt again", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const a = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaLocal,
        provinceCode: "AR-M",
        reason: REASON,
      });
      if (!("ok" in a)) throw new Error(`appoint failed: ${a.error}`);

      const r = await revokeJurisdictionAdmin(tx, w.admin, {
        appointmentId: a.appointmentId,
        reason: "Fin de la gestión",
      });
      expect(r).toEqual({ ok: true, grantRevoked: true, provinceCode: "AR-M" });
      expect(await loadAdminAuthority(tx, w.mzaLocal)).toEqual({ kind: "none" });
      expect(await requireJurisdictionAdminFor(tx, w.mzaLocal, "AR-M")).toBe(false);
      // The locality grant they held before stays; only the created one goes.
      const active = await tx
        .select()
        .from(govtAssignments)
        .where(eq(govtAssignments.userId, w.mzaLocal));
      expect(active.filter((g) => g.revokedAt === null).map((g) => g.jurisdictionLocality)).toEqual(
        ["Godoy Cruz"],
      );
      const [audit] = await tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "jurisdiction_admin_revoked"),
            eq(auditLog.targetUserId, w.mzaLocal),
          ),
        );
      expect(audit.provinceCode).toBe("AR-M");

      expect(
        await revokeJurisdictionAdmin(tx, w.admin, {
          appointmentId: a.appointmentId,
          reason: "Otra vez",
        }),
      ).toEqual({ error: "ALREADY_REVOKED" });
    });
  });

  it("a REUSED grant survives the revocation — it was the person's before", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const a = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      if (!("ok" in a)) throw new Error(`appoint failed: ${a.error}`);
      const r = await revokeJurisdictionAdmin(tx, w.admin, {
        appointmentId: a.appointmentId,
        reason: "Fin de la gestión",
      });
      expect(r).toMatchObject({ ok: true, grantRevoked: false });
      const [grant] = await tx
        .select()
        .from(govtAssignments)
        .where(eq(govtAssignments.id, w.mzaWholeGrant));
      expect(grant.revokedAt).toBeNull();
    });
  });

  it("the appointee cannot revoke — not their own appointment, not another's (escalation)", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const mine = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      const theirs = await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.sj,
        provinceCode: "AR-J",
        reason: REASON,
      });
      if (!("ok" in mine) || !("ok" in theirs)) throw new Error("appoint failed");
      for (const appointmentId of [mine.appointmentId, theirs.appointmentId]) {
        expect(
          await revokeJurisdictionAdmin(tx, w.mzaWhole, { appointmentId, reason: "Intento" }),
        ).toEqual({ error: "PLATFORM_ONLY" });
      }
      expect(await loadAdminAuthority(tx, w.sj)).toEqual({
        kind: "jurisdiction",
        provinceCode: "AR-J",
      });
    });
  });

  it("fails closed: no row, a deactivated appointee, or a revoked grant all read as no authority", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      // A plain whole-province govt holds zero admin powers.
      expect(await loadAdminAuthority(tx, w.mzaWhole)).toEqual({ kind: "none" });
      expect(await requireJurisdictionAdminFor(tx, w.mzaWhole, "AR-M")).toBe(false);

      await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      await tx
        .update(profiles)
        .set({ deactivatedAt: sql`now()` })
        .where(eq(profiles.id, w.mzaWhole));
      expect(await loadAdminAuthority(tx, w.mzaWhole)).toEqual({ kind: "none" });
      const [listed] = (await listActiveAppointments(tx)).filter((a) => a.userId === w.mzaWhole);
      expect(listed.authorityLive).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// The writers that end an appointee's authority (security review L4/L5/L6)
// ---------------------------------------------------------------------------

describe("ending an appointee's account revokes the appointment first", () => {
  it("deactivate-govt by the platform admin revokes the appointment, then every grant, audited", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      const [att] = await tx
        .insert(attachments)
        .values({
          storagePath: `test/ja3-${randomUUID()}.pdf`,
          mimeType: "application/pdf",
          uploadedByUserId: w.admin,
          fileSize: 1000,
        })
        .returning({ id: attachments.id });

      const r = await deactivateGovtForAuthority(
        w.admin,
        {
          targetGovtUserId: w.mzaWhole,
          motivo: "Baja por fin de la gestión provincial, con resolución adjunta.",
          attachmentIds: [att.id],
        },
        tx,
      );
      expect(r).toEqual({ ok: true });

      const [appointment] = await tx
        .select()
        .from(jurisdictionAdminAppointments)
        .where(eq(jurisdictionAdminAppointments.userId, w.mzaWhole));
      expect(appointment.revokedByUserId).toBe(w.admin);
      // L4: the database clock, the same instant as the transaction.
      const now = await dbNow(tx);
      const [stamps] = (await tx.execute(sql`
        select (a.revoked_at = ${now}::timestamptz) as appointment_now,
               (g.revoked_at = ${now}::timestamptz) as grant_now,
               (p.deactivated_at = ${now}::timestamptz) as profile_now
          from public.jurisdiction_admin_appointments a
          join public.govt_assignments g on g.id = a.govt_assignment_id
          join public.profiles p on p.id = a.user_id
         where a.user_id = ${w.mzaWhole}::uuid`)) as unknown as Array<Record<string, boolean>>;
      expect(stamps).toEqual({ appointment_now: true, grant_now: true, profile_now: true });

      const audits = await tx
        .select({ action: auditLog.action, payload: auditLog.payload })
        .from(auditLog)
        .where(eq(auditLog.targetUserId, w.mzaWhole));
      expect(audits.map((a) => a.action).sort()).toEqual([
        "govt_deactivated_by_admin",
        "jurisdiction_admin_appointed",
        "jurisdiction_admin_revoked",
      ]);
      const deactivation = audits.find((a) => a.action === "govt_deactivated_by_admin");
      expect(deactivation?.payload).toMatchObject({
        appointment_revoked: { province_code: "AR-M" },
      });
    });
  });

  it("a deactivated platform admin cannot deactivate anyone (authority read inside the transaction)", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.update(profiles).set({ deactivatedAt: sql`now()` }).where(eq(profiles.id, w.admin));
      const r = await deactivateGovtForAuthority(
        w.admin,
        {
          targetGovtUserId: w.mzaLocal,
          motivo: "Intento de baja con un administrador ya desactivado.",
          attachmentIds: [randomUUID()],
        },
        tx,
      );
      expect(r).toEqual({ error: "CAPABILITY_DENIED" });
    });
  });

  it("the appointee resigning revokes their own appointment first, on the database clock", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await appointJurisdictionAdmin(tx, w.admin, {
        userId: w.mzaWhole,
        provinceCode: "AR-M",
        reason: REASON,
      });
      // Someone else must still cover the whole province (the coverage rule).
      const cover = await insertProfile(tx, "govt", "JA3 probe cover");
      await insertGrant(tx, cover, "Mendoza", "", w.admin);

      const r = await govtSelfDeactivateForUser(w.mzaWhole, { reason: "Me jubilo" }, tx);
      expect(r).toEqual({ ok: true });

      const [appointment] = await tx
        .select()
        .from(jurisdictionAdminAppointments)
        .where(eq(jurisdictionAdminAppointments.userId, w.mzaWhole));
      expect(appointment.revokedByUserId).toBe(w.mzaWhole);
      expect(await loadAdminAuthority(tx, w.mzaWhole)).toEqual({ kind: "none" });

      const now = await dbNow(tx);
      const [stamps] = (await tx.execute(sql`
        select bool_and(g.revoked_at = ${now}::timestamptz) as grants_now,
               bool_and(p.deactivated_at = ${now}::timestamptz) as profile_now
          from public.govt_assignments g
          join public.profiles p on p.id = g.user_id
         where g.user_id = ${w.mzaWhole}::uuid`)) as unknown as Array<Record<string, boolean>>;
      expect(stamps).toEqual({ grants_now: true, profile_now: true });

      const [audit] = await tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, "govt_self_deactivated"), eq(auditLog.actorUserId, w.mzaWhole)),
        );
      expect(audit.payload).toMatchObject({ appointment_revoked: { province_code: "AR-M" } });
    });
  });
});

// ---------------------------------------------------------------------------
// Translating database refusals (never raw trigger text in the UI)
// ---------------------------------------------------------------------------

describe("jurisdictionAdminRefusal — a database refusal becomes a code, never raw text", () => {
  const pg = (code: string, message: string, constraint?: string) => ({
    message: "Failed query: insert ...",
    cause: { code, message, constraint_name: constraint },
  });

  it("maps every trigger token and both unique indexes; anything else stays unknown", () => {
    expect(
      jurisdictionAdminRefusal(pg("42501", "jurisdiction_admin_no_authority: x by y — …")),
    ).toBe("NO_AUTHORITY");
    expect(
      jurisdictionAdminRefusal(pg("42501", "jurisdiction_admin_out_of_province: … outside AR-M")),
    ).toBe("OUT_OF_PROVINCE");
    expect(
      jurisdictionAdminRefusal(
        pg("23514", "jurisdiction_admin_implied_grant_active: revoke the appointment first"),
      ),
    ).toBe("IMPLIED_GRANT_ACTIVE");
    expect(
      jurisdictionAdminRefusal(
        pg("23505", "duplicate key", "jurisdiction_admin_appointments_one_active_per_user"),
      ),
    ).toBe("USER_ALREADY_APPOINTED");
    expect(jurisdictionAdminRefusal(pg("23505", "duplicate key", "some_other_index"))).toBeNull();
    expect(jurisdictionAdminRefusal(new Error("ATTACHMENT_CLAIM_FAILED"))).toBeNull();
  });

  it("every refusal has es-AR copy that names no database object", () => {
    for (const [code, copy] of Object.entries(JURISDICTION_ADMIN_REFUSAL_COPY)) {
      expect(copy, code).not.toMatch(/jurisdiction_admin|audit_|_/);
      expect(copy.length, code).toBeGreaterThan(10);
    }
  });
});
