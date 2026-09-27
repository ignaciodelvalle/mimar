// jurisdiction-admin — the database half (migrations 0268 + 0269).
//
// The app authority module is one half of every guard; this file proves the
// OTHER half holds on its own, with no app code in the way: the appointment
// table's shape and append-only rules, the twin jurisdiction_admin_province(),
// the govt_assignments guard, the audit_log stamp + enforcement trigger, the
// govt_business_rules guard, and the audit_log RLS branch read through a real
// `authenticated` role. Each rule has a positive AND a negative case, so a
// trigger that refuses everything fails here as loudly as one that refuses
// nothing.
//
// NO RESIDUE. Every fixture (profiles, grants, appointments, audit rows,
// rules) is written inside ONE transaction per test that is always rolled
// back; expected failures run inside a savepoint (a nested transaction) so
// the outer transaction survives them. audit_log and the appointments table
// are append-only — a rollback is the only way to leave nothing behind.
//
// Place fixtures are read from the seeded catalogue at run time (a Mendoza
// and a San Juan locality and authority unit): the triggers resolve those ids
// against the live tables, so they must be real rows.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, govtAssignments, profiles } from "@/db";

import { expectDbError } from "../_helpers/expect-db-error";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ROLLBACK = new Error("jurisdiction-admin-db: rollback");

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

/** Run `body` in a savepoint and hand back its promise (for expectDbError). */
function inSavepoint<T>(tx: Tx, body: (sp: Tx) => Promise<T>): Promise<T> {
  return tx.transaction(body);
}

async function one<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const rows = (await tx.execute(query)) as unknown as T[];
  return rows[0];
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
  grantedBy: string | null,
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

function appoint(
  tx: Tx,
  a: { userId: string; province: string; grantId: string; by: string },
): Promise<unknown> {
  return tx.execute(sql`
    insert into public.jurisdiction_admin_appointments
      (user_id, province_code, govt_assignment_id, grant_created, appointed_by_user_id,
       appointment_reason)
    values (${a.userId}::uuid, ${a.province}, ${a.grantId}::uuid, true, ${a.by}::uuid,
            'Designación de prueba')
  `);
}

async function adminProvince(tx: Tx, userId: string): Promise<string | null> {
  const row = await one<{ p: string | null }>(
    tx,
    sql`select public.jurisdiction_admin_province(${userId}::uuid) as p`,
  );
  return row.p;
}

type Places = {
  mzaUnit: string;
  mzaLocality: string;
  sjUnit: string;
  sjLocality: string;
};

async function places(tx: Tx): Promise<Places> {
  const unit = async (code: string) =>
    (
      await one<{ id: string }>(
        tx,
        sql`select id::text as id from public.authority_units where province_code = ${code}
            order by id limit 1`,
      )
    )?.id;
  const locality = async (code: string) =>
    (
      await one<{ id: string }>(
        tx,
        sql`select id::text as id from public.ar_localities
             where province_code = ${code} and removed_at is null order by id limit 1`,
      )
    )?.id;
  const out = {
    mzaUnit: await unit("AR-M"),
    mzaLocality: await locality("AR-M"),
    sjUnit: await unit("AR-J"),
    sjLocality: await locality("AR-J"),
  };
  for (const [k, v] of Object.entries(out)) {
    expect(v, `seeded catalogue has no ${k} — run the local seeds (db:bootstrap)`).toBeTruthy();
  }
  return out as Places;
}

type World = {
  admin: string;
  /** Mendoza whole-province govt, appointed to AR-M. */
  mza: string;
  mzaGrant: string;
  /** San Juan whole-province govt, plain. */
  sj: string;
  /** Mendoza locality-scoped plain govt. */
  mzaPlain: string;
  places: Places;
};

async function world(tx: Tx): Promise<World> {
  const admin = await insertProfile(tx, "admin", "JA probe platform admin");
  const mza = await insertProfile(tx, "govt", "JA probe Mendoza appointee");
  const sj = await insertProfile(tx, "govt", "JA probe San Juan govt");
  const mzaPlain = await insertProfile(tx, "govt", "JA probe Mendoza plain govt");
  const mzaGrant = await insertGrant(tx, mza, "Mendoza", "", admin);
  await insertGrant(tx, sj, "San Juan", "", admin);
  await insertGrant(tx, mzaPlain, "Mendoza", "Godoy Cruz", admin);
  await appoint(tx, { userId: mza, province: "AR-M", grantId: mzaGrant, by: admin });
  return { admin, mza, mzaGrant, sj, mzaPlain, places: await places(tx) };
}

function writeAudit(
  tx: Tx,
  a: {
    actor: string | null;
    action: string;
    payload?: Record<string, unknown>;
    targetUser?: string | null;
    provinceCode?: string | null;
  },
): Promise<{ id: string; province_code: string | null }> {
  return one(
    tx,
    sql`insert into public.audit_log (actor_user_id, action, target_user_id, payload, province_code)
        values (${a.actor}::uuid, ${a.action}, ${a.targetUser ?? null}::uuid,
                ${JSON.stringify(a.payload ?? {})}::jsonb, ${a.provinceCode ?? null})
        returning id::text as id, province_code`,
  );
}

// ---------------------------------------------------------------------------
// 0268 — the appointment and its twin
// ---------------------------------------------------------------------------

describe("jurisdiction_admin_appointments + jurisdiction_admin_province (0268)", () => {
  it("an appointment by the platform admin makes the appointee the admin of THAT province", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      expect(await adminProvince(tx, w.mza)).toBe("AR-M");
      // A plain govt of the same province, and the platform admin, are not.
      expect(await adminProvince(tx, w.mzaPlain)).toBeNull();
      expect(await adminProvince(tx, w.admin)).toBeNull();
    });
  });

  it("a second ACTIVE appointment to the same province is refused; after a revocation it is allowed", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const other = await insertProfile(tx, "govt", "JA probe second Mendoza");
      const otherGrant = await insertGrant(tx, other, "Mendoza", "", w.admin);
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: other, province: "AR-M", grantId: otherGrant, by: w.admin }),
        ),
        { code: "23505", constraint: "jurisdiction_admin_appointments_one_active_per_province" },
      );
      await tx.execute(sql`
        update public.jurisdiction_admin_appointments
           set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
               revocation_reason = 'Relevo'
         where user_id = ${w.mza}::uuid`);
      await appoint(tx, { userId: other, province: "AR-M", grantId: otherGrant, by: w.admin });
      expect(await adminProvince(tx, other)).toBe("AR-M");
      expect(await adminProvince(tx, w.mza)).toBeNull();
    });
  });

  it("one active appointment per USER holds even with the insert validator bypassed", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      // The validator would refuse this first (foreign grant); switch triggers
      // off inside this rolled-back transaction to prove the index is its own
      // wall (an index is not a trigger: replica mode leaves it enforced).
      await tx.execute(sql`set local session_replication_role = replica`);
      const sjGrant = await insertGrant(tx, w.sj, "San Juan", "Rivadavia", w.admin);
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: w.mza, province: "AR-J", grantId: sjGrant, by: w.admin }),
        ),
        { code: "23505", constraint: "jurisdiction_admin_appointments_one_active_per_user" },
      );
    });
  });

  it("the insert validator refuses every malformed appointment", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const cand = await insertProfile(tx, "govt", "JA probe candidate");
      const whole = await insertGrant(tx, cand, "San Juan", "", w.admin);
      const partial = await insertGrant(tx, cand, "San Juan", "Rivadavia", w.admin);
      const owner = await insertProfile(tx, "owner", "JA probe citizen");

      // Appointed by a govt — even an appointee — is not the platform admin.
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: cand, province: "AR-J", grantId: whole, by: w.mza }),
        ),
        { code: "42501", constraint: /jurisdiction_admin_platform_only/ },
      );
      // The appointee must be an institutional govt.
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: owner, province: "AR-J", grantId: whole, by: w.admin }),
        ),
        { code: "23514", constraint: /jurisdiction_admin_appointee_invalid/ },
      );
      // The implied grant must be whole-province…
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: cand, province: "AR-J", grantId: partial, by: w.admin }),
        ),
        { code: "23514", constraint: /jurisdiction_admin_grant_invalid/ },
      );
      // …of THIS province…
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: cand, province: "AR-M", grantId: whole, by: w.admin }),
        ),
        { code: "23514", constraint: /jurisdiction_admin_grant_invalid/ },
      );
      // …and the appointee's own.
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: w.sj, province: "AR-J", grantId: whole, by: w.admin }),
        ),
        { code: "23514", constraint: /jurisdiction_admin_grant_invalid/ },
      );
      // A user holding a grant elsewhere cannot be appointed (single province).
      await insertGrant(tx, cand, "Mendoza", "Godoy Cruz", w.admin);
      await expectDbError(
        inSavepoint(tx, (sp) =>
          appoint(sp, { userId: cand, province: "AR-J", grantId: whole, by: w.admin }),
        ),
        { code: "23514", constraint: /jurisdiction_admin_foreign_grant/ },
      );
    });
  });

  it("is append-only: no delete, no rewrite, one revocation, by the platform admin only", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const where = sql`where user_id = ${w.mza}::uuid`;
      await expectDbError(
        inSavepoint(tx, (sp) =>
          sp.execute(sql`delete from public.jurisdiction_admin_appointments ${where}`),
        ),
        { code: "23001", constraint: /jurisdiction_admin_append_only/ },
      );
      await expectDbError(
        inSavepoint(tx, (sp) =>
          sp.execute(
            sql`update public.jurisdiction_admin_appointments set province_code = 'AR-J' ${where}`,
          ),
        ),
        { code: "23001", constraint: /jurisdiction_admin_append_only/ },
      );
      // A revocation that also rewrites the reason is still a rewrite.
      await expectDbError(
        inSavepoint(tx, (sp) =>
          sp.execute(sql`update public.jurisdiction_admin_appointments
                            set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                                revocation_reason = 'x', appointment_reason = 'otra' ${where}`),
        ),
        { code: "23001", constraint: /jurisdiction_admin_append_only/ },
      );
      // The appointee cannot revoke themself (nor can any govt).
      await expectDbError(
        inSavepoint(tx, (sp) =>
          sp.execute(sql`update public.jurisdiction_admin_appointments
                            set revoked_at = now(), revoked_by_user_id = ${w.mza}::uuid,
                                revocation_reason = 'Renuncio' ${where}`),
        ),
        { code: "42501", constraint: /jurisdiction_admin_platform_only/ },
      );
      await tx.execute(sql`update public.jurisdiction_admin_appointments
                              set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                                  revocation_reason = 'Fin de la designación' ${where}`);
      expect(await adminProvince(tx, w.mza)).toBeNull();
      await expectDbError(
        inSavepoint(tx, (sp) =>
          sp.execute(sql`update public.jurisdiction_admin_appointments
                            set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                                revocation_reason = 'Otra vez' ${where}`),
        ),
        { code: "23001", constraint: /jurisdiction_admin_append_only/ },
      );
    });
  });

  it("fails closed when the appointee is deactivated, erased or no longer a govt", async () => {
    for (const change of [
      sql`deactivated_at = now()`,
      sql`deleted_at = now()`,
      sql`role = 'owner', account_type = 'personal'`,
    ]) {
      await inRolledBackTx(async (tx) => {
        const w = await world(tx);
        expect(await adminProvince(tx, w.mza)).toBe("AR-M");
        await tx.execute(sql`update public.profiles set ${change} where id = ${w.mza}::uuid`);
        expect(await adminProvince(tx, w.mza)).toBeNull();
      });
    }
  });

  // The guards below make these states unreachable through normal writes, so
  // each is forced with triggers off (session_replication_role = replica, local
  // to this rolled-back transaction — no DDL, no lock on shared tables). The
  // point is the twin's OWN clauses: if a guard is ever bypassed or dropped,
  // the twin still answers NULL.
  it("fails closed when the implied grant is revoked, unit-bound off the provincia unit, or joined by a foreign grant", async () => {
    const drifts: Array<{ why: string; drift: (tx: Tx, w: World) => Promise<unknown> }> = [
      {
        why: "the implied grant revoked behind an active appointment",
        drift: (tx, w) =>
          tx.execute(sql`update public.govt_assignments
                            set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                                revocation_reason = 'forzado'
                          where id = ${w.mzaGrant}::uuid`),
      },
      {
        // CONFIRMED on purpose: a draft unit would already fail the status
        // clause and hide a missing kind clause (a mutant that survived).
        why: "the implied grant bound to a CONFIRMED unit that is not the provincia unit",
        drift: async (tx, w) => {
          const unit = await one<{ id: string }>(
            tx,
            sql`select id::text as id from public.authority_units
                 where province_code = 'AR-M' and kind <> 'provincia' order by id limit 1`,
          );
          await tx.execute(sql`update public.authority_units
                                  set status = 'confirmed', confirmed_by = ${w.admin}::uuid,
                                      confirmed_at = now()
                                where id = ${unit.id}::uuid`);
          return tx.execute(sql`update public.govt_assignments set authority_unit_id = ${unit.id}::uuid
                                 where id = ${w.mzaGrant}::uuid`);
        },
      },
      {
        why: "the implied grant bound to the provincia unit while it is a DRAFT",
        drift: async (tx, w) => {
          const unit = await one<{ id: string }>(
            tx,
            sql`select id::text as id from public.authority_units
                 where province_code = 'AR-M' and kind = 'provincia' limit 1`,
          );
          await tx.execute(sql`update public.authority_units
                                  set status = 'draft', confirmed_by = null, confirmed_at = null
                                where id = ${unit.id}::uuid`);
          return tx.execute(sql`update public.govt_assignments set authority_unit_id = ${unit.id}::uuid
                                 where id = ${w.mzaGrant}::uuid`);
        },
      },
      {
        why: "an active grant outside the province",
        drift: (tx, w) => insertGrant(tx, w.mza, "San Juan", "Rivadavia", w.admin),
      },
    ];
    for (const { why, drift } of drifts) {
      await inRolledBackTx(async (tx) => {
        const w = await world(tx);
        expect(await adminProvince(tx, w.mza), why).toBe("AR-M");
        await tx.execute(sql`set local session_replication_role = replica`);
        await drift(tx, w);
        await tx.execute(sql`set local session_replication_role = origin`);
        expect(await adminProvince(tx, w.mza), why).toBeNull();
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 0268 — the govt_assignments guard
// ---------------------------------------------------------------------------

describe("govt_assignments guard (0268)", () => {
  it("refuses a grant outside the appointee's province; one inside it is accepted", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await expectDbError(
        inSavepoint(tx, (sp) => insertGrant(sp, w.mza, "San Juan", "Rivadavia", w.admin)),
        { code: "23514", constraint: /jurisdiction_admin_foreign_grant/ },
      );
      await insertGrant(tx, w.mza, "Mendoza", "Godoy Cruz", w.admin);
      expect(await adminProvince(tx, w.mza)).toBe("AR-M");
    });
  });

  it("the implied grant cannot be revoked while its appointment is active", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const revokeGrant = (sp: Tx) =>
        sp.execute(sql`update public.govt_assignments
                          set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                              revocation_reason = 'Baja'
                        where id = ${w.mzaGrant}::uuid`);
      await expectDbError(inSavepoint(tx, revokeGrant), {
        code: "23514",
        constraint: /jurisdiction_admin_implied_grant_active/,
      });
      await tx.execute(sql`update public.jurisdiction_admin_appointments
                              set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                                  revocation_reason = 'Fin'
                            where user_id = ${w.mza}::uuid`);
      await revokeGrant(tx);
    });
  });

  it("an appointee grants inside their province only", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const recruit = await insertProfile(tx, "govt", "JA probe recruit");
      await expectDbError(
        inSavepoint(tx, (sp) => insertGrant(sp, recruit, "San Juan", "Rivadavia", w.mza)),
        { code: "42501", constraint: /jurisdiction_admin_out_of_province/ },
      );
      await insertGrant(tx, recruit, "Mendoza", "Las Heras", w.mza);
    });
  });
});

// ---------------------------------------------------------------------------
// 0269 — the audit_log stamp and enforcement trigger
// ---------------------------------------------------------------------------

describe("audit_log_province_guard (0269)", () => {
  it("stamps the province the row names, else the target's, else the actor's single province", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const p = w.places;
      const byUnit = await writeAudit(tx, {
        actor: w.admin,
        action: "authority_unit_renamed",
        payload: { unit_id: p.mzaUnit },
      });
      expect(byUnit.province_code).toBe("AR-M");
      const byLocality = await writeAudit(tx, {
        actor: w.admin,
        action: "authority_unit_membership_removed",
        payload: { locality_id: p.sjLocality, unit_id: p.sjUnit },
      });
      expect(byLocality.province_code).toBe("AR-J");
      const byTarget = await writeAudit(tx, {
        actor: w.admin,
        action: "govt_deactivated_by_admin",
        targetUser: w.sj,
      });
      expect(byTarget.province_code).toBe("AR-J");
      const byActor = await writeAudit(tx, { actor: w.mzaPlain, action: "evidence_viewed" });
      expect(byActor.province_code).toBe("AR-M");
      // Two provinces named, or nothing to go on: unplaced (platform admin only).
      const mixed = await writeAudit(tx, {
        actor: w.admin,
        action: "authority_unit_membership_moved",
        payload: { unit_id: p.mzaUnit, locality_id: p.sjLocality },
      });
      expect(mixed.province_code).toBeNull();
      const nothing = await writeAudit(tx, { actor: w.admin, action: "pii_queried" });
      expect(nothing.province_code).toBeNull();
    });
  });

  it("a supplied stamp must match the derived place", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await expectDbError(
        inSavepoint(tx, (sp) =>
          writeAudit(sp, {
            actor: w.admin,
            action: "authority_unit_renamed",
            payload: { unit_id: w.places.mzaUnit },
            provinceCode: "AR-J",
          }),
        ),
        { code: "23514", constraint: /audit_province_mismatch/ },
      );
      const same = await writeAudit(tx, {
        actor: w.admin,
        action: "authority_unit_renamed",
        payload: { unit_id: w.places.mzaUnit },
        provinceCode: "AR-M",
      });
      expect(same.province_code).toBe("AR-M");
      // Nothing to derive from: the platform admin may stamp, a govt may not.
      const adminStamp = await writeAudit(tx, {
        actor: w.admin,
        action: "pii_queried",
        provinceCode: "AR-J",
      });
      expect(adminStamp.province_code).toBe("AR-J");
      const sjOwnless = await insertProfile(tx, "govt", "JA probe govt without grants");
      await expectDbError(
        inSavepoint(tx, (sp) =>
          writeAudit(sp, { actor: sjOwnless, action: "evidence_viewed", provinceCode: "AR-J" }),
        ),
        { code: "23514", constraint: /audit_province_mismatch/ },
      );
    });
  });

  it("platform-only acts are refused from anyone but the platform admin", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      for (const actor of [w.mza, w.mzaPlain, null]) {
        await expectDbError(
          inSavepoint(tx, (sp) =>
            writeAudit(sp, {
              actor,
              action: "jurisdiction_admin_appointed",
              targetUser: w.sj,
              payload: { province_code: "AR-J" },
            }),
          ),
          { code: "42501", constraint: /jurisdiction_admin_platform_only/ },
        );
      }
      await expectDbError(
        inSavepoint(tx, (sp) =>
          writeAudit(sp, { actor: w.mza, action: "operator_credentials_reset", targetUser: w.sj }),
        ),
        { code: "42501", constraint: /jurisdiction_admin_platform_only/ },
      );
      const ok = await writeAudit(tx, {
        actor: w.admin,
        action: "jurisdiction_admin_appointed",
        targetUser: w.sj,
        payload: { province_code: "AR-J" },
      });
      expect(ok.province_code).toBe("AR-J");
    });
  });

  it("a delegated act by an appointee inside their province passes and is stamped", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const row = await writeAudit(tx, {
        actor: w.mza,
        action: "authority_unit_renamed",
        payload: { unit_id: w.places.mzaUnit },
      });
      expect(row.province_code).toBe("AR-M");
      const onPlainGovt = await writeAudit(tx, {
        actor: w.mza,
        action: "govt_locality_assigned",
        targetUser: w.mzaPlain,
        payload: { province: "Mendoza", locality: "Las Heras" },
      });
      expect(onPlainGovt.province_code).toBe("AR-M");
    });
  });

  it("refuses every delegated act by an appointee that reaches outside their province", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const p = w.places;
      const sjGrant = (
        await one<{ id: string }>(
          tx,
          sql`select id::text as id from public.govt_assignments where user_id = ${w.sj}::uuid`,
        )
      ).id;
      await appoint(tx, { userId: w.sj, province: "AR-J", grantId: sjGrant, by: w.admin });
      const sjPlain = await insertProfile(tx, "govt", "JA probe San Juan plain govt");
      await insertGrant(tx, sjPlain, "San Juan", "Rivadavia", w.admin);

      const refused: Array<{ why: string; row: Parameters<typeof writeAudit>[1] }> = [
        {
          // The payload names only the actor's province, so the stamp is
          // AR-M and every stamp-based clause passes: only the "every place
          // is mine" rule sees the foreign TARGET (a mutant that survived).
          why: "a foreign plain govt handed an in-province payload",
          row: {
            actor: w.mza,
            action: "govt_locality_assigned",
            targetUser: sjPlain,
            payload: { province: "Mendoza", locality: "Las Heras" },
          },
        },
        {
          why: "a foreign unit",
          row: { actor: w.mza, action: "authority_unit_confirmed", payload: { unit_id: p.sjUnit } },
        },
        {
          why: "a locality moved between two mutually consistent FOREIGN units",
          row: {
            actor: w.mza,
            action: "authority_unit_membership_moved",
            payload: {
              locality_id: p.sjLocality,
              from_unit_id: p.sjUnit,
              to_unit_id: p.sjUnit,
              unit_id: p.sjUnit,
            },
          },
        },
        {
          why: "one foreign place among own ones",
          row: {
            actor: w.mza,
            action: "authority_unit_membership_moved",
            payload: { locality_id: p.sjLocality, unit_id: p.mzaUnit },
          },
        },
        {
          why: "a country-wide rule (no place at all)",
          row: {
            actor: w.mza,
            action: "govt_business_rule_deleted",
            payload: { jurisdiction: { country: "AR", province: null, locality: null } },
          },
        },
        {
          why: "a foreign rule",
          row: {
            actor: w.mza,
            action: "govt_business_rule_created",
            payload: { jurisdiction: { country: "AR", province: "San Juan", locality: null } },
          },
        },
        {
          why: "a foreign govt",
          row: { actor: w.mza, action: "govt_deactivated_by_admin", targetUser: w.sj },
        },
        {
          why: "themself",
          row: {
            actor: w.mza,
            action: "govt_locality_assigned",
            targetUser: w.mza,
            payload: { province: "Mendoza", locality: "Las Heras" },
          },
        },
        {
          why: "another appointee, even with an in-province payload",
          row: {
            actor: w.mza,
            action: "govt_locality_assigned",
            targetUser: w.sj,
            payload: { province: "Mendoza", locality: "Las Heras" },
          },
        },
        {
          why: "an unplaced delegated act",
          row: { actor: w.mza, action: "authority_unit_created" },
        },
      ];
      for (const { why, row } of refused) {
        await expectDbError(
          inSavepoint(tx, (sp) => writeAudit(sp, row)),
          { code: "42501", constraint: /jurisdiction_admin_out_of_province/ },
        ).catch((e: unknown) => {
          throw new Error(`expected a refusal for ${why}: ${String(e)}`);
        });
      }
    });
  });

  it("an appointee whose authority broke (erased) cannot pass a delegated act either", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await tx.execute(
        sql`update public.profiles set deleted_at = now() where id = ${w.mza}::uuid`,
      );
      await expectDbError(
        inSavepoint(tx, (sp) =>
          writeAudit(sp, {
            actor: w.mza,
            action: "authority_unit_renamed",
            payload: { unit_id: w.places.mzaUnit },
          }),
        ),
        { code: "42501", constraint: /jurisdiction_admin_out_of_province/ },
      );
    });
  });

  it("audit_row_province reads an UNSTAMPED historic row from the place it names, and hides an unplaced one", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const read = (payload: Record<string, unknown>) =>
        one<{ p: string | null }>(
          tx,
          sql`select public.audit_row_province(jsonb_populate_record(null::public.audit_log,
                jsonb_build_object('action', 'authority_unit_renamed',
                                   'payload', ${JSON.stringify(payload)}::jsonb))) as p`,
        );
      expect((await read({ unit_id: w.places.mzaUnit })).p).toBe("AR-M");
      expect(
        (await read({ unit_id: w.places.mzaUnit, locality_id: w.places.sjLocality })).p,
      ).toBeNull();
      expect((await read({})).p).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 0269 — the govt_business_rules guard
// ---------------------------------------------------------------------------

describe("govt_business_rules guard (0269)", () => {
  function insertRule(tx: Tx, actor: string, province: string | null): Promise<unknown> {
    return tx.execute(sql`
      insert into public.govt_business_rules
        (jurisdiction_province, jurisdiction_locality, rule_type, rule_payload,
         created_by_user_id, updated_by_user_id)
      values (${province}, ${province === null ? null : `JA probe ${randomUUID()}`},
              'ppp_breed_list', '{"breeds":["Probe"]}'::jsonb, ${actor}::uuid, ${actor}::uuid)`);
  }

  it("an appointee writes rules of their province only, never country-wide", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await insertRule(tx, w.mza, "Mendoza");
      await expectDbError(
        inSavepoint(tx, (sp) => insertRule(sp, w.mza, "San Juan")),
        { code: "42501", constraint: /jurisdiction_admin_out_of_province/ },
      );
      await expectDbError(
        inSavepoint(tx, (sp) => insertRule(sp, w.mza, null)),
        { code: "42501", constraint: /jurisdiction_admin_country_wide/ },
      );
      // The platform admin writes anywhere, country-wide included.
      await insertRule(tx, w.admin, "San Juan");
    });
  });

  it("an appointee cannot move an own-province rule to another province", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      await insertRule(tx, w.mza, "Mendoza");
      await expectDbError(
        inSavepoint(tx, (sp) =>
          sp.execute(sql`update public.govt_business_rules
                            set jurisdiction_province = 'San Juan', updated_by_user_id = ${w.mza}::uuid
                          where created_by_user_id = ${w.mza}::uuid`),
        ),
        { code: "42501", constraint: /jurisdiction_admin_out_of_province/ },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 0269 — the audit_log RLS branch, through the real `authenticated` role
// ---------------------------------------------------------------------------

describe("audit_log RLS — the jurisdiction admin of the row's province (0269)", () => {
  async function visibleTo(tx: Tx, userId: string, ids: string[]): Promise<string[]> {
    await tx.execute(
      sql`select set_config('request.jwt.claims', ${JSON.stringify({
        sub: userId,
        role: "authenticated",
        aal: "aal2",
      })}, true)`,
    );
    await tx.execute(sql`set local role authenticated`);
    const rows = (await tx.execute(
      sql`select id::text as id from public.audit_log
           where id in (${sql.join(
             ids.map((i) => sql`${i}::uuid`),
             sql`, `,
           )})`,
    )) as unknown as Array<{ id: string }>;
    await tx.execute(sql`reset role`);
    return rows.map((r) => r.id).sort();
  }

  it("the appointee reads their province's rows and no other; a plain govt reads neither", async () => {
    await inRolledBackTx(async (tx) => {
      const w = await world(tx);
      const mzaRow = await writeAudit(tx, {
        actor: w.admin,
        action: "authority_unit_renamed",
        payload: { unit_id: w.places.mzaUnit },
      });
      const sjRow = await writeAudit(tx, {
        actor: w.admin,
        action: "authority_unit_renamed",
        payload: { unit_id: w.places.sjUnit },
      });
      const ids = [mzaRow.id, sjRow.id];
      expect(await visibleTo(tx, w.mza, ids)).toEqual([mzaRow.id]);
      expect(await visibleTo(tx, w.mzaPlain, ids)).toEqual([]);
      // Revoked: the branch closes with the appointment.
      await tx.execute(sql`update public.jurisdiction_admin_appointments
                              set revoked_at = now(), revoked_by_user_id = ${w.admin}::uuid,
                                  revocation_reason = 'Fin'
                            where user_id = ${w.mza}::uuid`);
      expect(await visibleTo(tx, w.mza, ids)).toEqual([]);
    });
  });
});
