// jurisdiction-admin, Phase 4 — the delegated writers.
//
// A jurisdiction admin (an institutional govt with a LIVE appointment for
// province P) may do the platform admin's work on funcionarios, authority
// units and business rules INSIDE P, and nowhere else. Every writer derives
// the province from the TARGET (the unit, the rule's stored place, the
// funcionario's grants, the resolved catalogue place) and asks
// requireJurisdictionAdminFor inside its own transaction.
//
// One `it` per negative vector of the design's Testing Strategy (1–4, 6–10,
// 12, 14; 5 is Phase 5, 11 is Phase 3, 13 lives in
// jurisdiction-admin-revoke-race.test.ts because it needs two connections),
// plus the positive path of every delegated act and every platform reversal.
//
// NO RESIDUE. Appointments and audit_log are append-only, so every case runs
// inside ONE transaction that is always rolled back; the writers take the
// executor (first, or as an optional last argument) to join it. The one case
// that creates an auth user deletes it afterwards.

import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import { unitEditErrorMessage } from "@/components/institutional/unit-edit-errors";
import {
  attachments,
  auditLog,
  authorityUnits,
  db,
  govtAssignments,
  govtBusinessRules,
  profiles,
} from "@/db";
import {
  canCreateInstitutional,
  canDeactivateAdmin,
  canResetCredentials,
} from "@/lib/domain/institutional-scope";
import { revokeActiveAppointmentInTx } from "@/lib/infra/jurisdiction-admin-appointments";
import { resolvePlaceFromQueue } from "@/lib/place/unresolved-queue";
import {
  JURISDICTION_ADMIN_REFUSAL_COPY,
  JURISDICTION_ADMIN_WRITER_COPY,
} from "@/lib/ui/jurisdiction-admin-copy";
import { appointJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/appoint";
import {
  hasAdminAuthority,
  requireJurisdictionAdminFor,
} from "@/src/modules/organizations/application/admin-authority/authority";
import { revokeJurisdictionAdmin } from "@/src/modules/organizations/application/admin-authority/revoke";
import { govtTargetProvince } from "@/src/modules/organizations/application/admin-authority/target-province";
import { assignGovtLocalityForAuthority } from "@/src/modules/organizations/application/admin-institutional/assign-govt-locality";
import {
  CREATE_INSTITUTIONAL_FAILED,
  CREATE_INSTITUTIONAL_RATE_LIMITED,
  DELEGATED_CREATE_LIMIT,
  DELEGATED_CREATE_RATE_KEY,
  createInstitutionalAccountForAuthority,
} from "@/src/modules/organizations/application/admin-institutional/create-institutional-account";
import { deactivateGovtForAuthority } from "@/src/modules/organizations/application/admin-institutional/deactivate-govt";
import {
  confirmGrantUnit,
  unconfirmGrantUnit,
} from "@/src/modules/organizations/application/authority-units/grant-unit";
import {
  confirmAuthorityUnit,
  createAuthorityUnit,
  moveLocalityToUnit,
  removeLocalityFromUnit,
  renameAuthorityUnit,
  unconfirmAuthorityUnit,
} from "@/src/modules/organizations/application/authority-units/manage-units";
import { closeRemovedLocalityMembership } from "@/src/modules/organizations/application/authority-units/removed-locality-memberships";
import { createBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/create-business-rule";
import { deleteBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/delete-business-rule";
import {
  RULE_NOT_FOUND,
  RULE_WRITE_FAILED,
  RuleWriteRefused,
  RuleWriterError,
  ruleWriterErrorMessage,
} from "@/src/modules/organizations/application/business-rules/rule-authority";
import { updateBusinessRuleWriter } from "@/src/modules/organizations/application/business-rules/update-business-rule";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ROLLBACK = new Error("jurisdiction-admin-delegated-writers: rollback");

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

const COPY = JURISDICTION_ADMIN_WRITER_COPY;
const REASON = "Designación de prueba por resolución ministerial";
const MOTIVO = "Baja dispuesta por resolución de prueba del ministerio";
const WHY = "Cambio de prueba del administrador de la jurisdicción";

async function insertProfile(tx: Tx, role: "admin" | "govt", name: string): Promise<string> {
  const id = randomUUID();
  await tx.insert(profiles).values({ id, displayName: name, role, accountType: "institutional" });
  return id;
}

async function insertGrant(
  tx: Tx,
  userId: string,
  province: string,
  locality: string,
  grantedBy: string,
  localityId: string | null = null,
): Promise<string> {
  const [row] = await tx
    .insert(govtAssignments)
    .values({
      userId,
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      localityId,
      grantedByUserId: grantedBy,
    })
    .returning({ id: govtAssignments.id });
  return row.id;
}

async function localityOf(tx: Tx, code: string, offset: number) {
  const rows = (await tx.execute(sql`
    select id::text as id, locality_name as name from public.ar_localities
     where province_code = ${code} and removed_at is null
     order by id offset ${offset} limit 1`)) as unknown as Array<{ id: string; name: string }>;
  return rows[0];
}

async function provincialUnit(tx: Tx, code: string): Promise<string> {
  const rows = (await tx.execute(sql`
    select id::text as id from public.authority_units
     where province_code = ${code} and kind = 'provincia'`)) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

function ok<T>(r: T): Extract<T, { ok: true }> {
  expect(r).toMatchObject({ ok: true });
  return r as Extract<T, { ok: true }>;
}

type World = {
  admin: string;
  /** Jurisdiction admin of Córdoba (AR-X). */
  cba: string;
  /** Jurisdiction admin of Santa Fe (AR-S). */
  sfe: string;
  /** Plain Córdoba funcionario (one locality, catalogue row recorded). */
  cbaGovt: string;
  /** Plain Córdoba funcionario holding the WHOLE province — no appointment. */
  cbaWhole: string;
  /** Funcionario with grants in Córdoba AND Santa Fe. */
  mixed: string;
  /** Plain Santa Fe funcionario. */
  sfeGovt: string;
  cbaUnit: string;
  sfeUnit: string;
  sfeUnit2: string;
  cbaLoc: { id: string; name: string };
  sfeLoc: { id: string; name: string };
};

async function world(tx: Tx): Promise<World> {
  const admin = await insertProfile(tx, "admin", "JA4 probe platform admin");
  const cba = await insertProfile(tx, "govt", "JA4 probe Córdoba admin");
  const sfe = await insertProfile(tx, "govt", "JA4 probe Santa Fe admin");
  const cbaGovt = await insertProfile(tx, "govt", "JA4 probe Córdoba govt");
  const cbaWhole = await insertProfile(tx, "govt", "JA4 probe Córdoba whole govt");
  const mixed = await insertProfile(tx, "govt", "JA4 probe mixed govt");
  const sfeGovt = await insertProfile(tx, "govt", "JA4 probe Santa Fe govt");
  const cbaLoc = await localityOf(tx, "AR-X", 0);
  const sfeLoc = await localityOf(tx, "AR-S", 0);
  const cbaLoc2 = await localityOf(tx, "AR-X", 1);
  const sfeLoc2 = await localityOf(tx, "AR-S", 1);

  await insertGrant(tx, cba, "Córdoba", "", admin);
  await insertGrant(tx, sfe, "Santa Fe", "", admin);
  await insertGrant(tx, cbaGovt, "Córdoba", cbaLoc.name, admin, cbaLoc.id);
  await insertGrant(tx, cbaWhole, "Córdoba", "", admin);
  await insertGrant(tx, mixed, "Córdoba", cbaLoc2.name, admin, cbaLoc2.id);
  await insertGrant(tx, mixed, "Santa Fe", sfeLoc2.name, admin, sfeLoc2.id);
  await insertGrant(tx, sfeGovt, "Santa Fe", sfeLoc.name, admin, sfeLoc.id);

  for (const [userId, provinceCode] of [
    [cba, "AR-X"],
    [sfe, "AR-S"],
  ] as const) {
    ok(await appointJurisdictionAdmin(tx, admin, { userId, provinceCode, reason: REASON }));
  }

  const unit = async (code: string, name: string) => {
    const r = ok(
      await createAuthorityUnit(tx, admin, { kind: "municipio", provinceCode: code, name }),
    );
    ok(await confirmAuthorityUnit(tx, admin, { unitId: r.unitId }));
    return r.unitId;
  };
  const cbaUnit = await unit("AR-X", "JA4 probe unidad Córdoba");
  const sfeUnit = await unit("AR-S", "JA4 probe unidad Santa Fe");
  const sfeUnit2 = await unit("AR-S", "JA4 probe unidad Santa Fe 2");
  return {
    admin,
    cba,
    sfe,
    cbaGovt,
    cbaWhole,
    mixed,
    sfeGovt,
    cbaUnit,
    sfeUnit,
    sfeUnit2,
    cbaLoc,
    sfeLoc,
  };
}

/** A resolution PDF uploaded by `uploader` — the evidence a deactivation claims. */
async function evidence(tx: Tx, uploader: string): Promise<string> {
  const [att] = await tx
    .insert(attachments)
    .values({
      storagePath: `test/ja4-${randomUUID()}.pdf`,
      mimeType: "application/pdf",
      uploadedByUserId: uploader,
      fileSize: 1000,
    })
    .returning({ id: attachments.id });
  return att.id;
}

function ruleOn(actorUserId: string, province: string | null, unitId: string | null, days = 21) {
  return {
    actorUserId,
    ruleType: "due_soon_window" as const,
    jurisdictionCountry: "AR",
    jurisdictionProvince: province,
    jurisdictionLocality: null,
    rulePayload: { days },
    notes: null,
    legalAnchorIds: [],
    place: unitId ? { localityId: null, authorityUnitId: unitId, placeMethod: null } : undefined,
  };
}

type AuditAction = (typeof auditLog.$inferSelect)["action"];

async function auditOf(tx: Tx, action: AuditAction, actor: string) {
  return tx
    .select({ provinceCode: auditLog.provinceCode, payload: auditLog.payload })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.actorUserId, actor)));
}

// ---------------------------------------------------------------------------
// Positive: every delegated act inside the actor's own province
// ---------------------------------------------------------------------------

describe("a jurisdiction admin acts inside their own province", () => {
  it("creates, renames and confirms a unit of their province, and moves a locality of it — each audited in the province", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const created = ok(
        await createAuthorityUnit(tx, w.cba, {
          kind: "municipio",
          provinceCode: "AR-X",
          name: "JA4 unidad propia",
        }),
      );
      ok(await renameAuthorityUnit(tx, w.cba, { unitId: created.unitId, name: "JA4 renombrada" }));
      ok(await confirmAuthorityUnit(tx, w.cba, { unitId: created.unitId }));
      ok(
        await moveLocalityToUnit(tx, w.cba, {
          localityId: w.cbaLoc.id,
          toUnitId: created.unitId,
          reason: WHY,
        }),
      );
      for (const action of [
        "authority_unit_created",
        "authority_unit_renamed",
        "authority_unit_confirmed",
        "authority_unit_membership_moved",
      ] as const) {
        const rows = await auditOf(tx, action, w.cba);
        expect(rows, action).toHaveLength(1);
        expect(rows[0].provinceCode, action).toBe("AR-X");
      }
    });
  });

  it("confirms a Córdoba funcionario's whole-province grant onto the Córdoba provincial unit", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const provincia = await provincialUnit(tx, "AR-X");
      await tx
        .update(authorityUnits)
        .set({ status: "confirmed", confirmedBy: w.admin, confirmedAt: sql`now()` })
        .where(and(eq(authorityUnits.id, provincia), eq(authorityUnits.status, "draft")));
      const r = await confirmGrantUnit(tx, w.cba, {
        userId: w.cbaWhole,
        unitId: provincia,
        reason: WHY,
        acceptAdded: [],
      });
      expect(r).toMatchObject({ ok: true });
      const [audit] = await auditOf(tx, "govt_assignment_unit_confirmed", w.cba);
      expect(audit.provinceCode).toBe("AR-X");
    });
  });

  it("assigns a Córdoba place to a Córdoba funcionario and deactivates one", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      ok(
        await assignGovtLocalityForAuthority(
          w.cba,
          { targetUserId: w.cbaGovt, province: "Córdoba", locality: "" },
          tx,
        ),
      );
      ok(
        await deactivateGovtForAuthority(
          w.cba,
          {
            targetGovtUserId: w.cbaGovt,
            motivo: MOTIVO,
            attachmentIds: [await evidence(tx, w.cba)],
          },
          tx,
        ),
      );
      const active = await tx
        .select()
        .from(govtAssignments)
        .where(and(eq(govtAssignments.userId, w.cbaGovt), isNull(govtAssignments.revokedAt)));
      expect(active).toHaveLength(0);
      const [audit] = await auditOf(tx, "govt_deactivated_by_admin", w.cba);
      expect(audit.provinceCode).toBe("AR-X");
    });
  });

  it("creates, updates and deletes a rule keyed to a Córdoba unit", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const created = await createBusinessRuleWriter(ruleOn(w.cba, "Córdoba", w.cbaUnit), tx);
      expect(created).toMatchObject({ ok: true, ruleId: expect.any(String) });
      const ruleId = (created as { ruleId: string }).ruleId;
      expect(
        await updateBusinessRuleWriter(
          {
            actorUserId: w.cba,
            ruleId,
            rulePayload: { days: 22 },
            notes: null,
            legalAnchorIds: [],
          },
          tx,
        ),
      ).toEqual({ ok: true });
      expect(
        await deleteBusinessRuleWriter({ actorUserId: w.cba, ruleId, reason: WHY }, tx),
      ).toEqual({ ok: true });
      for (const action of [
        "govt_business_rule_created",
        "govt_business_rule_updated",
        "govt_business_rule_deleted",
      ] as const) {
        const [row] = await auditOf(tx, action, w.cba);
        expect(row?.provinceCode, action).toBe("AR-X");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Negative vectors (design, Testing Strategy)
// ---------------------------------------------------------------------------

describe("a jurisdiction admin never acts outside their province", () => {
  it("vector 1 — a unit created with a foreign provinceCode is refused", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(
        await createAuthorityUnit(tx, w.cba, {
          kind: "municipio",
          provinceCode: "AR-S",
          name: "JA4 ajena",
        }),
      ).toEqual({ error: "OUT_OF_PROVINCE" });
      expect(unitEditErrorMessage("OUT_OF_PROVINCE")).toBe(
        "Esta unidad está fuera de tu jurisdicción.",
      );
    });
  });

  it("vector 2 — creating an admin or a national, or a govt outside the province (or with no place), is refused before any auth user exists", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const base = { email: REFUSED_EMAIL, displayName: REFUSED_NAME };
      for (const role of ["admin", "national"] as const) {
        expect(
          await createInstitutionalAccountForAuthority(
            w.cba,
            { ...base, role, initialLocalities: [] },
            tx,
          ),
        ).toEqual({ error: COPY.CREATE_PLATFORM_ROLE });
      }
      const govt = (initialLocalities: { province: string; locality: string }[]) =>
        createInstitutionalAccountForAuthority(
          w.cba,
          { ...base, role: "govt", initialLocalities },
          tx,
        );
      const sfe = { province: "Santa Fe", locality: w.sfeLoc.name };
      const cba = { province: "Córdoba", locality: w.cbaLoc.name };
      expect(await govt([sfe])).toEqual({ error: COPY.CREATE_OUTSIDE_PROVINCE });
      expect(await govt([cba, sfe])).toEqual({ error: COPY.CREATE_OUTSIDE_PROVINCE });
      expect(await govt([])).toEqual({ error: COPY.CREATE_OUTSIDE_PROVINCE });
      expect(COPY.CREATE_OUTSIDE_PROVINCE).toBe(
        "No podés crear funcionarios fuera de tu jurisdicción.",
      );
    });
    // Refused by the PRE-FLIGHT: GoTrue never created the user. (A refusal
    // only inside the transaction would compensate the auth user but leave
    // its handle_new_user profile behind, committed on GoTrue's connection.)
    expect(await authUserIdByEmail(REFUSED_EMAIL)).toBeNull();
    const leftovers = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.displayName, REFUSED_NAME));
    expect(leftovers).toEqual([]);
  });

  it("vector 3 — country-wide, foreign-country and foreign-province rules are refused on create, update and delete", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(await createBusinessRuleWriter(ruleOn(w.cba, null, null), tx)).toEqual({
        ok: false,
        error: COPY.COUNTRY_WIDE,
      });
      expect(
        await createBusinessRuleWriter(
          { ...ruleOn(w.cba, null, null), jurisdictionCountry: "UY" },
          tx,
        ),
      ).toEqual({ ok: false, error: COPY.COUNTRY_WIDE });
      expect(await createBusinessRuleWriter(ruleOn(w.cba, "Santa Fe", w.sfeUnit), tx)).toEqual({
        ok: false,
        error: COPY.OUT_OF_PROVINCE,
      });
      expect(await createBusinessRuleWriter(ruleOn(w.cba, "Santa Fe", null), tx)).toEqual({
        ok: false,
        error: COPY.OUT_OF_PROVINCE,
      });

      // Rules the platform admin wrote: one in Santa Fe, one country-wide.
      const foreign = await createBusinessRuleWriter(ruleOn(w.admin, "Santa Fe", w.sfeUnit), tx);
      const foreignId = (foreign as { ruleId: string }).ruleId;
      let [national] = await tx
        .select({ id: govtBusinessRules.id })
        .from(govtBusinessRules)
        .where(isNull(govtBusinessRules.jurisdictionProvince))
        .limit(1);
      if (!national) {
        const made = await createBusinessRuleWriter(ruleOn(w.admin, null, null), tx);
        national = { id: (made as { ruleId: string }).ruleId };
      }
      expect(national.id).toEqual(expect.any(String));

      for (const [ruleId, error] of [
        [foreignId, COPY.OUT_OF_PROVINCE],
        [national.id, COPY.COUNTRY_WIDE],
      ] as const) {
        const [before] = await tx
          .select()
          .from(govtBusinessRules)
          .where(eq(govtBusinessRules.id, ruleId));
        expect(
          await updateBusinessRuleWriter(
            {
              actorUserId: w.cba,
              ruleId,
              rulePayload: before.rulePayload,
              notes: "JA4 intento",
              legalAnchorIds: [],
            },
            tx,
          ),
        ).toEqual({ ok: false, error });
        expect(
          await deleteBusinessRuleWriter({ actorUserId: w.cba, ruleId, reason: WHY }, tx),
        ).toEqual({ ok: false, error });
        const [after] = await tx
          .select()
          .from(govtBusinessRules)
          .where(eq(govtBusinessRules.id, ruleId));
        expect(after.notes).toBe(before.notes);
      }
    });
  });

  it("vector 4 — moving a Santa Fe locality between two Santa Fe units is refused, though the move is consistent", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      ok(
        await moveLocalityToUnit(tx, w.admin, {
          localityId: w.sfeLoc.id,
          toUnitId: w.sfeUnit,
          reason: WHY,
        }),
      );
      expect(
        await moveLocalityToUnit(tx, w.cba, {
          localityId: w.sfeLoc.id,
          toUnitId: w.sfeUnit2,
          reason: WHY,
        }),
      ).toEqual({ error: "OUT_OF_PROVINCE" });
      // Nor into a Córdoba unit (the locality and the unit it leaves are foreign).
      expect(
        await moveLocalityToUnit(tx, w.cba, {
          localityId: w.sfeLoc.id,
          toUnitId: w.cbaUnit,
          reason: WHY,
        }),
      ).toEqual({ error: "OUT_OF_PROVINCE" });
    });
  });

  it("vector 6 — confirming, renaming, removing from or granting onto a Santa Fe unit is refused", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const draft = ok(
        await createAuthorityUnit(tx, w.admin, {
          kind: "region",
          provinceCode: "AR-S",
          name: "JA4 región Santa Fe",
        }),
      );
      expect(await confirmAuthorityUnit(tx, w.cba, { unitId: draft.unitId })).toEqual({
        error: "OUT_OF_PROVINCE",
      });
      expect(await renameAuthorityUnit(tx, w.cba, { unitId: w.sfeUnit, name: "X" })).toEqual({
        error: "OUT_OF_PROVINCE",
      });
      expect(
        await removeLocalityFromUnit(tx, w.cba, {
          localityId: w.sfeLoc.id,
          unitId: draft.unitId,
          reason: WHY,
        }),
      ).toEqual({ error: "OUT_OF_PROVINCE" });
      expect(
        await confirmGrantUnit(tx, w.cba, {
          userId: w.sfeGovt,
          unitId: await provincialUnit(tx, "AR-S"),
          reason: WHY,
          acceptAdded: [],
        }),
      ).toEqual({ error: "OUT_OF_PROVINCE" });
    });
  });

  it("vector 7 — never on themself, never on another appointee", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const deactivate = (target: string) =>
        deactivateGovtForAuthority(
          w.cba,
          { targetGovtUserId: target, motivo: MOTIVO, attachmentIds: [randomUUID()] },
          tx,
        );
      expect(await deactivate(w.cba)).toEqual({ error: COPY.SELF_DEACTIVATE });
      expect(COPY.SELF_DEACTIVATE).toBe("No podés desactivar tu propia cuenta.");
      expect(await deactivate(w.sfe)).toEqual({ error: COPY.OUT_OF_PROVINCE });

      const assign = (target: string, province: string) =>
        assignGovtLocalityForAuthority(w.cba, { targetUserId: target, province, locality: "" }, tx);
      expect(await assign(w.cba, "Córdoba")).toEqual({ error: COPY.OUT_OF_PROVINCE });
      expect(await assign(w.sfe, "Santa Fe")).toEqual({ error: COPY.OUT_OF_PROVINCE });

      expect(
        await confirmGrantUnit(tx, w.cba, {
          userId: w.cba,
          unitId: await provincialUnit(tx, "AR-X"),
          reason: WHY,
          acceptAdded: [],
        }),
      ).toEqual({ error: "SELF_ACTION" });

      // Neither the other appointee's appointment.
      const [sfeAppointment] = (await tx.execute(sql`
        select id::text as id from public.jurisdiction_admin_appointments
         where user_id = ${w.sfe}::uuid and revoked_at is null`)) as unknown as Array<{
        id: string;
      }>;
      expect(
        await revokeJurisdictionAdmin(tx, w.cba, { appointmentId: sfeAppointment.id, reason: WHY }),
      ).toMatchObject({ error: "PLATFORM_ONLY" });
      expect(await deactivate(w.sfeGovt)).toEqual({ error: COPY.OUT_OF_PROVINCE });
    });
  });

  it("vector 8 — a funcionario with grants in two provinces is nobody's to administer but the platform's", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(await govtTargetProvince(tx, w.mixed)).toEqual({ kind: "mixed", isAppointee: false });
      expect(
        await deactivateGovtForAuthority(
          w.cba,
          { targetGovtUserId: w.mixed, motivo: MOTIVO, attachmentIds: [randomUUID()] },
          tx,
        ),
      ).toEqual({ error: COPY.OUT_OF_PROVINCE });
      expect(
        await assignGovtLocalityForAuthority(
          w.cba,
          { targetUserId: w.mixed, province: "Córdoba", locality: "" },
          tx,
        ),
      ).toEqual({ error: COPY.OUT_OF_PROVINCE });
      expect(
        await confirmGrantUnit(tx, w.cba, {
          userId: w.mixed,
          unitId: await provincialUnit(tx, "AR-X"),
          reason: WHY,
          acceptAdded: [],
        }),
      ).toEqual({ error: "TARGET_OUT_OF_PROVINCE" });
    });
  });

  it("vector 9 — a revoked, deactivated or role-changed appointee holds no authority at all", async () => {
    const attempt = (tx: Tx, w: World) =>
      renameAuthorityUnit(tx, w.cba, { unitId: w.cbaUnit, name: "JA4 sin autoridad" });

    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await revokeActiveAppointmentInTx(tx, { userId: w.cba, revokedBy: w.admin, reason: WHY });
      expect(await hasAdminAuthority(tx, w.cba)).toBe(false);
      expect(await attempt(tx, w)).toEqual({ error: "CAPABILITY_DENIED" });
    });
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.update(profiles).set({ deactivatedAt: sql`now()` }).where(eq(profiles.id, w.cba));
      expect(await attempt(tx, w)).toEqual({ error: "CAPABILITY_DENIED" });
    });
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.update(profiles).set({ role: "owner" }).where(eq(profiles.id, w.cba));
      expect(await attempt(tx, w)).toEqual({ error: "CAPABILITY_DENIED" });
    });
  });

  it("the place granted to a Córdoba funcionario must itself be in Córdoba", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(
        await assignGovtLocalityForAuthority(
          w.cba,
          { targetUserId: w.cbaGovt, province: "Santa Fe", locality: "" },
          tx,
        ),
      ).toEqual({ error: COPY.OUT_OF_PROVINCE });
      const foreign = await tx
        .select()
        .from(govtAssignments)
        .where(
          and(
            eq(govtAssignments.userId, w.cbaGovt),
            eq(govtAssignments.jurisdictionProvince, "Santa Fe"),
          ),
        );
      expect(foreign).toEqual([]);
    });
  });

  it("vector 10 — a foreign grant for an appointee is refused, in es-AR, even from the platform admin", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(
        await assignGovtLocalityForAuthority(
          w.admin,
          { targetUserId: w.cba, province: "Santa Fe", locality: "" },
          tx,
        ),
      ).toEqual({ error: JURISDICTION_ADMIN_REFUSAL_COPY.FOREIGN_GRANT });
    });
  });

  it("vector 12 — every platform-only act stays platform-only", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(await unconfirmAuthorityUnit(tx, w.cba, { unitId: w.cbaUnit, reason: WHY })).toEqual({
        error: "CAPABILITY_DENIED",
      });
      expect(
        await unconfirmGrantUnit(tx, w.cba, { userId: w.cbaGovt, unitId: w.cbaUnit, reason: WHY }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(
        await closeRemovedLocalityMembership(tx, w.cba, {
          localityId: w.cbaLoc.id,
          unitId: w.cbaUnit,
          reason: WHY,
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(
        await resolvePlaceFromQueue(tx, w.cba, {
          subjectTable: "cases",
          subjectId: randomUUID(),
          localityId: w.cbaLoc.id,
          reason: WHY,
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(
        await appointJurisdictionAdmin(tx, w.cba, {
          userId: w.cbaWhole,
          provinceCode: "AR-X",
          reason: REASON,
        }),
      ).toMatchObject({ error: "PLATFORM_ONLY" });
      // A deactivated national observer: platform only (no province).
      const national = randomUUID();
      await tx.insert(profiles).values({
        id: national,
        displayName: "JA4 national",
        role: "national",
        accountType: "institutional",
      });
      expect(
        await deactivateGovtForAuthority(
          w.cba,
          { targetGovtUserId: national, motivo: MOTIVO, attachmentIds: [randomUUID()] },
          tx,
        ),
      ).toEqual({ error: COPY.OUT_OF_PROVINCE });
      // Credential / MFA reset and admin deactivation gate on the ROLE: an
      // appointee is a govt, so the predicate those writers call refuses it
      // whatever its appointment says.
      const appointee = {
        id: w.cba,
        role: "govt" as const,
        accountType: "institutional" as const,
        deactivatedAt: null,
        deletedAt: null,
      };
      expect(canResetCredentials(appointee)).toBe(false);
      expect(canCreateInstitutional(appointee)).toBe(false);
      expect(canDeactivateAdmin(appointee, w.admin, 5)).toBe(false);
    });
  });

  it("vector 14 — a plain whole-province govt holds no administrative power", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const actor = w.cbaWhole;
      expect(await hasAdminAuthority(tx, actor)).toBe(false);
      expect(await requireJurisdictionAdminFor(tx, actor, "AR-X")).toBe(false);
      expect(
        await createAuthorityUnit(tx, actor, {
          kind: "municipio",
          provinceCode: "AR-X",
          name: "JA4 x",
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(await renameAuthorityUnit(tx, actor, { unitId: w.cbaUnit, name: "X" })).toEqual({
        error: "CAPABILITY_DENIED",
      });
      const draft = ok(
        await createAuthorityUnit(tx, w.admin, {
          kind: "region",
          provinceCode: "AR-X",
          name: "JA4 región Córdoba",
        }),
      );
      expect(await confirmAuthorityUnit(tx, actor, { unitId: draft.unitId })).toEqual({
        error: "CAPABILITY_DENIED",
      });
      expect(
        await removeLocalityFromUnit(tx, actor, {
          localityId: w.cbaLoc.id,
          unitId: draft.unitId,
          reason: WHY,
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(
        await moveLocalityToUnit(tx, actor, {
          localityId: w.cbaLoc.id,
          toUnitId: w.cbaUnit,
          reason: WHY,
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(
        await confirmGrantUnit(tx, actor, {
          userId: w.cbaGovt,
          unitId: w.cbaUnit,
          reason: WHY,
          acceptAdded: [],
        }),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(
        await deactivateGovtForAuthority(
          actor,
          { targetGovtUserId: w.cbaGovt, motivo: MOTIVO, attachmentIds: [randomUUID()] },
          tx,
        ),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(
        await assignGovtLocalityForAuthority(
          actor,
          { targetUserId: w.cbaGovt, province: "Córdoba", locality: "" },
          tx,
        ),
      ).toEqual({ error: "CAPABILITY_DENIED" });
      expect(await createBusinessRuleWriter(ruleOn(actor, "Córdoba", w.cbaUnit), tx)).toEqual({
        ok: false,
        error: COPY.NO_AUTHORITY,
      });
      expect(
        await createInstitutionalAccountForAuthority(
          actor,
          {
            role: "govt",
            email: REFUSED_EMAIL,
            displayName: REFUSED_NAME,
            initialLocalities: [{ province: "Córdoba", locality: w.cbaLoc.name }],
          },
          tx,
        ),
      ).toEqual({ error: "CAPABILITY_DENIED" });
    });
  });
});

// ---------------------------------------------------------------------------
// The platform admin reverses delegated acts
// ---------------------------------------------------------------------------

describe("the platform admin reverses what a jurisdiction admin did", () => {
  it("takes a unit the appointee confirmed back to draft, and grants the appointee confirmed back off it — both audited", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const provincia = await provincialUnit(tx, "AR-X");
      const [before] = await tx
        .select({ status: authorityUnits.status })
        .from(authorityUnits)
        .where(eq(authorityUnits.id, provincia));
      if (before.status === "draft")
        ok(await confirmAuthorityUnit(tx, w.cba, { unitId: provincia }));
      const moved = ok(
        await confirmGrantUnit(tx, w.cba, {
          userId: w.cbaWhole,
          unitId: provincia,
          reason: WHY,
          acceptAdded: [],
        }),
      );

      expect(
        await unconfirmGrantUnit(tx, w.admin, {
          userId: w.cbaWhole,
          unitId: provincia,
          reason: WHY,
        }),
      ).toEqual({ ok: true, assignmentIds: moved.assignmentIds });
      expect(
        await unconfirmGrantUnit(tx, w.admin, {
          userId: w.cbaWhole,
          unitId: provincia,
          reason: WHY,
        }),
      ).toEqual({ error: "NOT_ON_UNIT" });

      ok(await unconfirmAuthorityUnit(tx, w.admin, { unitId: provincia, reason: WHY }));
      const [after] = await tx
        .select({ status: authorityUnits.status, confirmedAt: authorityUnits.confirmedAt })
        .from(authorityUnits)
        .where(eq(authorityUnits.id, provincia));
      expect(after).toEqual({ status: "draft", confirmedAt: null });
      expect(await unconfirmAuthorityUnit(tx, w.admin, { unitId: provincia, reason: WHY })).toEqual(
        {
          error: "NOT_CONFIRMED",
        },
      );

      for (const action of [
        "govt_assignment_unit_unconfirmed",
        "authority_unit_unconfirmed",
      ] as const) {
        const rows = await auditOf(tx, action, w.admin);
        expect(rows, action).toHaveLength(1);
        expect(rows[0].provinceCode, action).toBe("AR-X");
      }
    });
  });

  it("the platform admin still writes anywhere, country-wide included", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(
        await createBusinessRuleWriter(ruleOn(w.admin, "Santa Fe", w.sfeUnit), tx),
      ).toMatchObject({
        ok: true,
      });
      ok(await renameAuthorityUnit(tx, w.admin, { unitId: w.sfeUnit, name: "JA4 plataforma" }));
      expect(
        await moveLocalityToUnit(tx, w.admin, {
          localityId: w.cbaLoc.id,
          toUnitId: w.sfeUnit,
          reason: WHY,
        }),
      ).toEqual({ error: "PROVINCE_MISMATCH" });
    });
  });
});

// ---------------------------------------------------------------------------
// create-institutional-account: the authority is checked twice
// ---------------------------------------------------------------------------

const authAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } },
);
const createdEmails: string[] = [];

async function authUserIdByEmail(email: string): Promise<string | null> {
  const rows = (await db.execute(
    sql`select id::text as id from auth.users where email = ${email}`,
  )) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

// The auth user's own profile row (handle_new_user) is committed on GoTrue's
// connection, outside the rolled-back transaction, and deleting the auth user
// does not remove it — so both go, by the per-run display names below.
const RUN = randomUUID().slice(0, 8);
const CREATED_NAME = `JA4 funcionario nuevo ${RUN}`;
const RACED_NAME = `JA4 carrera ${RUN}`;
/** Vector 2: an account the pre-flight must refuse before GoTrue sees it. */
const REFUSED_NAME = `JA4 nadie ${RUN}`;
const REFUSED_EMAIL = `ja4-refused-${RUN}@dim-test.local`;
createdEmails.push(REFUSED_EMAIL);

afterAll(async () => {
  for (const email of createdEmails) {
    const id = await authUserIdByEmail(email);
    if (id) await authAdmin.auth.admin.deleteUser(id);
  }
  await db.execute(
    sql`delete from public.profiles where display_name in (${CREATED_NAME}, ${RACED_NAME}, ${REFUSED_NAME}) and role = 'owner'`,
  );
  // Every delegated creation attempt spends the actor's rate-limit budget
  // (review LOW-3); the actors are this file's random, rolled-back ids.
  await db.execute(
    sql`delete from public.rate_limit_buckets where bucket_key like ${`${DELEGATED_CREATE_RATE_KEY}:%`}`,
  );
});

describe("createInstitutionalAccountForAuthority — jurisdiction-aware, before AND inside the transaction", () => {
  it("the Córdoba admin creates a Córdoba funcionario", async () => {
    const email = `ja4-create-${randomUUID()}@dim-test.local`;
    createdEmails.push(email);
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const r = await createInstitutionalAccountForAuthority(
        w.cba,
        {
          role: "govt",
          email,
          displayName: CREATED_NAME,
          initialLocalities: [{ province: "Córdoba", locality: w.cbaLoc.name }],
        },
        tx,
      );
      const created = ok(r);
      const grants = await tx
        .select()
        .from(govtAssignments)
        .where(eq(govtAssignments.userId, created.profileId));
      expect(grants.map((g) => [g.jurisdictionProvince, g.grantedByUserId])).toEqual([
        ["Córdoba", w.cba],
      ]);
      const [audit] = await auditOf(tx, "institutional_govt_created", w.cba);
      expect(audit.provinceCode).toBe("AR-X");
    });
  });

  it("an appointment revoked between the pre-flight and the transaction is seen inside it: refused, and the auth user compensated", async () => {
    const email = `ja4-race-${randomUUID()}@dim-test.local`;
    createdEmails.push(email);
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      // The pre-flight reads through `exec`; the transaction opens on it
      // afterwards. Revoke in between.
      const racing = new Proxy(tx, {
        get(target, key) {
          if (key === "transaction") {
            return async (cb: (t: Tx) => Promise<unknown>) => {
              await revokeActiveAppointmentInTx(target, {
                userId: w.cba,
                revokedBy: w.admin,
                reason: WHY,
              });
              return target.transaction(cb);
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const r = await createInstitutionalAccountForAuthority(
        w.cba,
        {
          role: "govt",
          email,
          displayName: RACED_NAME,
          initialLocalities: [{ province: "Córdoba", locality: w.cbaLoc.name }],
        },
        racing,
      );
      expect(r).toEqual({ error: "CAPABILITY_DENIED" });
    });
    expect(await authUserIdByEmail(email)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase-4 security review LOWs (fixed before any action guard is widened)
// ---------------------------------------------------------------------------

describe("review LOW-1 — no enumeration oracle: for a jurisdiction admin, anything outside reads as outside", () => {
  it("deactivate and assign: an unknown id, a foreign funcionario, a deactivated one and a citizen all read OUT_OF_PROVINCE; only the platform admin learns which", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const gone = await insertProfile(tx, "govt", "JA4 probe deactivated Córdoba govt");
      await insertGrant(tx, gone, "Córdoba", w.cbaLoc.name, w.admin, w.cbaLoc.id);
      await tx.update(profiles).set({ deactivatedAt: sql`now()` }).where(eq(profiles.id, gone));
      const citizen = randomUUID();
      await tx.insert(profiles).values({
        id: citizen,
        displayName: "JA4 probe citizen",
        role: "owner",
        accountType: "personal",
      });
      // A former funcionario whose role changed while a Córdoba grant stayed
      // active: inside the province by its grants, and still not a target.
      const demoted = randomUUID();
      await tx.insert(profiles).values({
        id: demoted,
        displayName: "JA4 probe demoted funcionario",
        role: "owner",
        accountType: "personal",
      });
      await insertGrant(tx, demoted, "Córdoba", w.cbaLoc.name, w.admin, w.cbaLoc.id);
      const unknown = randomUUID();
      const outside = { error: COPY.OUT_OF_PROVINCE };

      for (const target of [unknown, w.sfeGovt, gone, citizen, demoted]) {
        expect(
          await deactivateGovtForAuthority(
            w.cba,
            {
              targetGovtUserId: target,
              motivo: MOTIVO,
              attachmentIds: [await evidence(tx, w.cba)],
            },
            tx,
          ),
          `deactivate ${target}`,
        ).toEqual(outside);
        expect(
          await assignGovtLocalityForAuthority(
            w.cba,
            { targetUserId: target, province: "Córdoba", locality: "" },
            tx,
          ),
          `assign ${target}`,
        ).toEqual(outside);
      }
      // The platform admin still reads what it was.
      expect(
        await deactivateGovtForAuthority(
          w.admin,
          {
            targetGovtUserId: unknown,
            motivo: MOTIVO,
            attachmentIds: [await evidence(tx, w.admin)],
          },
          tx,
        ),
      ).toEqual({ error: "NOT_INSTITUTIONAL_GOVT" });
      expect(
        await assignGovtLocalityForAuthority(
          w.admin,
          { targetUserId: unknown, province: "Córdoba", locality: "" },
          tx,
        ),
      ).toEqual({ error: "NOT_FOUND" });
    });
  });

  it("rules and unit grants: an unknown rule or unit reads like another province's", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const ruleId = randomUUID();
      const update = (actorUserId: string) =>
        updateBusinessRuleWriter(
          { actorUserId, ruleId, rulePayload: { days: 22 }, notes: null, legalAnchorIds: [] },
          tx,
        );
      const remove = (actorUserId: string) =>
        deleteBusinessRuleWriter({ actorUserId, ruleId, reason: WHY }, tx);
      for (const write of [update, remove]) {
        expect(await write(w.cba)).toEqual({ ok: false, error: COPY.OUT_OF_PROVINCE });
        expect(await write(w.cbaWhole)).toEqual({ ok: false, error: COPY.NO_AUTHORITY });
        expect(await write(w.admin)).toEqual({ ok: false, error: RULE_NOT_FOUND });
      }

      for (const unitId of [randomUUID(), "not-a-uuid"]) {
        expect(
          await confirmGrantUnit(tx, w.cba, {
            userId: w.cbaGovt,
            unitId,
            reason: WHY,
            acceptAdded: [],
          }),
          unitId,
        ).toEqual({ error: "OUT_OF_PROVINCE" });
      }
      expect(
        await confirmGrantUnit(tx, w.admin, {
          userId: w.cbaGovt,
          unitId: randomUUID(),
          reason: WHY,
          acceptAdded: [],
        }),
      ).toEqual({ error: "NOT_FOUND" });
    });
  });
});

describe("review LOW-2 — no raw database or provider text reaches the UI", () => {
  it("a rule writer shows its own sentences, and one generic sentence for anything else", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(ruleWriterErrorMessage(new RuleWriterError("Payload inválido: x"))).toBe(
        "Payload inválido: x",
      );
      expect(ruleWriterErrorMessage(new RuleWriteRefused(COPY.COUNTRY_WIDE))).toBe(
        COPY.COUNTRY_WIDE,
      );
      const raw = Object.assign(
        new Error('Failed query: insert into "govt_business_rules" values ($1) secret-value'),
        { cause: { code: "23505", message: "duplicate key secret-value" } },
      );
      expect(ruleWriterErrorMessage(raw)).toBe(RULE_WRITE_FAILED);
      expect(ruleWriterErrorMessage(new Error("any bug text"))).toBe(RULE_WRITE_FAILED);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

describe("review LOW-3 — a delegated administrator cannot learn who is on the platform", () => {
  it("an address already registered reads the generic sentence and is audited without the address; the platform admin still reads DUPLICATE_EMAIL", async () => {
    const { data } = await authAdmin.auth.admin.listUsers({ perPage: 1 });
    const taken = data.users[0]?.email;
    expect(taken, "the local auth schema has no user at all — run db:bootstrap").toBeTruthy();
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const input = {
        role: "govt" as const,
        email: taken as string,
        displayName: REFUSED_NAME,
        initialLocalities: [{ province: "Córdoba", locality: w.cbaLoc.name }],
      };
      expect(await createInstitutionalAccountForAuthority(w.cba, input, tx)).toEqual({
        error: CREATE_INSTITUTIONAL_FAILED,
      });
      const audited = await auditOf(tx, "institutional_create_refused", w.cba);
      expect(audited).toHaveLength(1);
      expect(audited[0].payload).toEqual({ role: "govt", reason: "duplicate_email" });
      expect(JSON.stringify(audited[0].payload)).not.toContain(taken as string);
      expect(audited[0].provinceCode).toBe("AR-X");

      expect(await createInstitutionalAccountForAuthority(w.admin, input, tx)).toEqual({
        error: "DUPLICATE_EMAIL",
      });
    });
  });

  it("delegated attempts are rate-limited per actor; the platform admin is not", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      // Spend the actor's hourly budget, on the same key the writer builds.
      const windowStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
      await db.execute(sql`
        insert into public.rate_limit_buckets (bucket_key, count, expires_at)
        values (${`${DELEGATED_CREATE_RATE_KEY}:${w.cba}:hour:${windowStart}`},
                ${DELEGATED_CREATE_LIMIT.maxPerHour},
                ${new Date(windowStart + 3_600_000).toISOString()}::timestamptz)
        on conflict (bucket_key) do update set count = excluded.count`);
      const input = {
        role: "govt" as const,
        email: `ja4-limited-${randomUUID()}@dim-test.local`,
        displayName: REFUSED_NAME,
        initialLocalities: [{ province: "Córdoba", locality: w.cbaLoc.name }],
      };
      expect(await createInstitutionalAccountForAuthority(w.cba, input, tx)).toEqual({
        error: CREATE_INSTITUTIONAL_RATE_LIMITED,
      });
      // Nothing reached the identity provider.
      expect(await authUserIdByEmail(input.email)).toBeNull();
    });
  });
});
