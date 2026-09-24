// findAuthoritiesForJurisdiction — the two failures that were invisible.
//
// WHY THIS FILE EXISTS (routing audit, 2026-08-17 — engram onboarding/ruteo-y-fallback)
// ---------------------------------------------------------------------------
// The system has exactly ONE good notification fallback: this resolver routes to
// the jurisdiction's govt operators and, failing that, to every active
// institutional admin. Seventeen call sites depend on it. Two structural defects
// went around it, and BOTH were undetectable from inside the product:
//
//   1. THE WHOLE-PROVINCE OPERATOR WAS INVISIBLE TO THE WRITER. The locality was
//      matched with plain equality, while "covers the whole province" is stored
//      as the `""` sentinel (or, in CABA, the INDEC whole-city entry). The READ
//      side was taught this in July — jurisdictionPairClause, approval-scope,
//      case-queries — so a province-wide operator SAW the bite / denuncia /
//      request sitting in her queue and was NEVER notified about it, while the
//      resolver concluded "no govt covers this locality" and paged national
//      admins. Nothing in the product could show the difference: the row was
//      there, the queue worked, only the notification never happened.
//
//   2. AN EMPTY FAN-OUT LEFT NO TRACE AT ALL. When the resolver returned zero
//      users, the recipients loop ran zero times, the action returned ok, and
//      nothing was written anywhere — no notification, no audit row, no cron
//      alert. It was the only failure in the system with no evidence of its own,
//      which is exactly why it would be the last one anyone ever found.
//
// These are integration tests on purpose. Both defects lived in the SQL, not in
// the branching: a mocked resolver would have agreed with the buggy version.

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, govtAssignments, profiles } from "@/db";
import { WHOLE_PROVINCE_SENTINEL } from "@/lib/domain/jurisdiction-canonical";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";
import { setAuditMutationGucs } from "./_helpers/db-overrides";

// A province nothing else in the seeds operates in, so the fixtures below are
// the ONLY active assignments the resolver can find there.
const PROVINCE = "Tierra del Fuego";
const LOCALITY = "Ushuaia";
const OTHER_LOCALITY = "Río Grande";

// Deterministic ids — greppable in a failed run, and unique enough to clean up.
const WHOLE_PROVINCE_GOVT_ID = "d1a90000-0000-4000-8000-00000000fa01";
const LOCALITY_GOVT_ID = "d1a90000-0000-4000-8000-00000000fa02";
// A service account: role admin, accountType institutional, never deactivated —
// it satisfies every predicate the fallback used to apply. See defect 3 below.
const SYSTEM_ADMIN_ID = "d1a90000-0000-4000-8000-00000000fa03";

// T2-S5: an operator whose PROFILE is deactivated while one of her assignment
// rows is still open, and a service account that holds an assignment.
const DEACTIVATED_GOVT_ID = "d1a90000-0000-4000-8000-00000000fa04";
const SYSTEM_GOVT_ID = "d1a90000-0000-4000-8000-00000000fa05";
// A locality no other fixture in this file covers, so the only candidates the
// resolver can find there are the two above.
const HOLDER_LOCALITY = "Tolhuin";

// Security review 2026-09-18: an ERASED operator and a RE-ROLED one, each still
// holding an open assignment, plus an erased administrator for the fallback.
const ERASED_GOVT_ID = "d1a90000-0000-4000-8000-00000000fa06";
const REROLED_GOVT_ID = "d1a90000-0000-4000-8000-00000000fa07";
const ERASED_ADMIN_ID = "d1a90000-0000-4000-8000-00000000fa08";
// One locality per holder so each positive control sees exactly one candidate.
const ERASED_LOCALITY = "Lago Escondido";
const REROLED_LOCALITY = "Puerto Almanza";

const FIXTURE_IDS = [
  WHOLE_PROVINCE_GOVT_ID,
  LOCALITY_GOVT_ID,
  SYSTEM_ADMIN_ID,
  DEACTIVATED_GOVT_ID,
  SYSTEM_GOVT_ID,
  ERASED_GOVT_ID,
  REROLED_GOVT_ID,
  ERASED_ADMIN_ID,
];
const TRACE_ROUTE = "test_empty_fanout";

/**
 * The admins the fallback is actually FOR. Mirrors the production query,
 * `isSystem` clause included — a helper that drifted from it would deactivate a
 * different set than the resolver reads, and the tests below would be measuring
 * two different populations.
 */
async function activeInstitutionalAdminIds(): Promise<string[]> {
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "admin"),
        eq(profiles.accountType, "institutional"),
        isNull(profiles.deactivatedAt),
        isNull(profiles.deletedAt),
        eq(profiles.isSystem, false),
      ),
    );
  return rows.map((r) => r.id);
}

async function cleanup() {
  for (const id of FIXTURE_IDS) {
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, id));
    await db.delete(profiles).where(eq(profiles.id, id));
  }
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx
      .delete(auditLog)
      .where(
        and(
          eq(auditLog.action, "notification_fanout_empty"),
          sql`${auditLog.payload}->>'route' = ${TRACE_ROUTE}`,
        ),
      );
  });
}

beforeAll(async () => {
  await cleanup();

  await db.insert(profiles).values([
    {
      id: WHOLE_PROVINCE_GOVT_ID,
      displayName: "routing-fixture-whole-province-govt",
      role: "govt",
      accountType: "institutional",
    },
    {
      id: LOCALITY_GOVT_ID,
      displayName: "routing-fixture-locality-govt",
      role: "govt",
      accountType: "institutional",
    },
    {
      id: SYSTEM_ADMIN_ID,
      displayName: "routing-fixture-system-admin",
      role: "admin",
      accountType: "institutional",
      isSystem: true,
    },
    {
      id: DEACTIVATED_GOVT_ID,
      displayName: "routing-fixture-deactivated-govt",
      role: "govt",
      accountType: "institutional",
    },
    {
      id: SYSTEM_GOVT_ID,
      displayName: "routing-fixture-system-govt",
      role: "govt",
      accountType: "institutional",
      isSystem: true,
    },
    {
      id: ERASED_GOVT_ID,
      displayName: "routing-fixture-erased-govt",
      role: "govt",
      accountType: "institutional",
    },
    {
      id: REROLED_GOVT_ID,
      displayName: "routing-fixture-reroled-govt",
      role: "govt",
      accountType: "institutional",
    },
  ]);
});

afterAll(cleanup);

describe("findAuthoritiesForJurisdiction — whole-province subsumption (writer side)", () => {
  it("notifies the WHOLE-PROVINCE operator about a locality-level event inside her province", async () => {
    await db.insert(govtAssignments).values({
      userId: WHOLE_PROVINCE_GOVT_ID,
      jurisdictionProvince: PROVINCE,
      // "Toda la provincia" — the same sentinel describeMandate, censusEligibleProvince
      // and jurisdictionPairClause have honoured since D3 (2026-08-04).
      jurisdictionLocality: WHOLE_PROVINCE_SENTINEL,
    });

    const recipients = await findAuthoritiesForJurisdiction({
      province: PROVINCE,
      locality: LOCALITY,
    });

    // THE BUG: this used to be the admin list, because plain `eq(locality, 'Ushuaia')`
    // matched no assignment and the resolver fell through to the national fallback.
    expect(recipients).toContain(WHOLE_PROVINCE_GOVT_ID);

    // And she is the ONLY recipient: a covering govt exists, so admins are not
    // paged. This is the half that proves the fallback did not merely also fire.
    const admins = await activeInstitutionalAdminIds();
    expect(recipients.filter((id) => admins.includes(id))).toEqual([]);
  });

  it("a LOCALITY-specific assignment never widens to a sibling locality", async () => {
    await db.insert(govtAssignments).values({
      userId: LOCALITY_GOVT_ID,
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    });

    const recipients = await findAuthoritiesForJurisdiction({
      province: PROVINCE,
      locality: OTHER_LOCALITY,
    });

    // Subsumption goes UP (locality → whole province), never sideways. The
    // Ushuaia operator must not be paged about Río Grande.
    expect(recipients).not.toContain(LOCALITY_GOVT_ID);
    // The whole-province operator still covers it — that is the point.
    expect(recipients).toContain(WHOLE_PROVINCE_GOVT_ID);
  });

  it("a REVOKED whole-province assignment stops covering the province", async () => {
    await db
      .update(govtAssignments)
      .set({ revokedAt: new Date() })
      .where(eq(govtAssignments.userId, WHOLE_PROVINCE_GOVT_ID));

    const recipients = await findAuthoritiesForJurisdiction({
      province: PROVINCE,
      locality: OTHER_LOCALITY,
    });

    expect(recipients).not.toContain(WHOLE_PROVINCE_GOVT_ID);
  });
});

describe("findAuthoritiesForJurisdiction — the holder must still be reachable (T2-S5)", () => {
  // The resolver used to read govt_assignments alone. A deactivated operator
  // with one assignment left open was paged forever — and, because she made the
  // govt list non-empty, the admin fallback for "nobody covers this" never
  // fired. Not every deactivation path revokes assignments
  // (reset-institutional-credentials does not), so the profile has to decide.
  it("returns an ACTIVE operator holding an open assignment", async () => {
    await db.insert(govtAssignments).values({
      userId: DEACTIVATED_GOVT_ID,
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: HOLDER_LOCALITY,
    });

    const recipients = await findAuthoritiesForJurisdiction({
      province: PROVINCE,
      locality: HOLDER_LOCALITY,
    });

    // The positive control: without it, the negative case below would pass
    // against a resolver that returns nobody for this locality at all.
    expect(recipients).toEqual([DEACTIVATED_GOVT_ID]);
  });

  it("drops a DEACTIVATED operator whose assignment is still open, and falls back to admins", async () => {
    await db
      .update(profiles)
      .set({ deactivatedAt: new Date() })
      .where(eq(profiles.id, DEACTIVATED_GOVT_ID));

    const recipients = await findAuthoritiesForJurisdiction({
      province: PROVINCE,
      locality: HOLDER_LOCALITY,
    });

    expect(recipients).not.toContain(DEACTIVATED_GOVT_ID);
    // The half that matters most: with her gone nobody covers Tolhuin, so the
    // fallback must reach the active human admins instead of nobody.
    const admins = await activeInstitutionalAdminIds();
    expect(admins.length).toBeGreaterThan(0);
    expect([...recipients].sort()).toEqual([...admins].sort());
  });

  it("drops a SERVICE ACCOUNT that holds an open assignment", async () => {
    await db.insert(govtAssignments).values({
      userId: SYSTEM_GOVT_ID,
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: HOLDER_LOCALITY,
    });

    const recipients = await findAuthoritiesForJurisdiction({
      province: PROVINCE,
      locality: HOLDER_LOCALITY,
    });

    expect(recipients).not.toContain(SYSTEM_GOVT_ID);
    expect(recipients).not.toContain(DEACTIVATED_GOVT_ID);
  });

  // Security review 2026-09-18. Each case opens with its positive control (the
  // holder IS returned while live) so the negative half cannot pass against a
  // resolver that simply finds nobody in that locality.
  it("drops an ERASED operator whose assignment is still open", async () => {
    await db.insert(govtAssignments).values({
      userId: ERASED_GOVT_ID,
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: ERASED_LOCALITY,
    });
    const live = { province: PROVINCE, locality: ERASED_LOCALITY };
    expect(await findAuthoritiesForJurisdiction(live)).toEqual([ERASED_GOVT_ID]);

    await db.update(profiles).set({ deletedAt: new Date() }).where(eq(profiles.id, ERASED_GOVT_ID));

    const recipients = await findAuthoritiesForJurisdiction(live);
    expect(recipients).not.toContain(ERASED_GOVT_ID);
    // With her gone nobody covers the locality, so the fallback fires.
    expect([...recipients].sort()).toEqual([...(await activeInstitutionalAdminIds())].sort());
  });

  it("drops a holder who no longer has the govt ROLE, even with an open assignment", async () => {
    await db.insert(govtAssignments).values({
      userId: REROLED_GOVT_ID,
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: REROLED_LOCALITY,
    });
    const live = { province: PROVINCE, locality: REROLED_LOCALITY };
    expect(await findAuthoritiesForJurisdiction(live)).toEqual([REROLED_GOVT_ID]);

    await db.update(profiles).set({ role: "owner" }).where(eq(profiles.id, REROLED_GOVT_ID));

    expect(await findAuthoritiesForJurisdiction(live)).not.toContain(REROLED_GOVT_ID);
  });

  it("the admin fallback never returns an ERASED administrator", async () => {
    await db.insert(profiles).values({
      id: ERASED_ADMIN_ID,
      displayName: "routing-fixture-erased-admin",
      role: "admin",
      accountType: "institutional",
    });
    try {
      // Positive control: a live human admin IS in the fallback set.
      expect(await activeHumanInstitutionalAdminIds()).toContain(ERASED_ADMIN_ID);

      await db
        .update(profiles)
        .set({ deletedAt: new Date() })
        .where(eq(profiles.id, ERASED_ADMIN_ID));

      expect(await activeHumanInstitutionalAdminIds()).not.toContain(ERASED_ADMIN_ID);
      const recipients = await findAuthoritiesForJurisdiction({
        province: PROVINCE,
        locality: ERASED_LOCALITY,
      });
      expect(recipients).not.toContain(ERASED_ADMIN_ID);
    } finally {
      // Never leave a live fixture admin behind for the empty-fan-out window below.
      await db.delete(profiles).where(eq(profiles.id, ERASED_ADMIN_ID));
    }
  });
});

// DB round trips + audit rows — gate 0901f measured these tests at 3006ms
// and 2967ms clean; 30s matches the repo's convention for DB-backed cases.
const DB_BUDGET = { timeout: 30_000 };

describe("findAuthoritiesForJurisdiction — an empty fan-out leaves a trace", DB_BUDGET, () => {
  it("writes a notification_fanout_empty audit row when NOBODY can be reached", async () => {
    // The fallback is global by construction, so the only way to observe an
    // empty fan-out is to make the fallback empty. Deactivate every active
    // institutional admin for the length of one call and put them back.
    // (The db project runs with fileParallelism:false, so nothing else is
    // reading profiles while this window is open.)
    const admins = await activeInstitutionalAdminIds();
    expect(
      admins.length,
      "expected at least one active institutional admin in the local DB — run pnpm db:bootstrap",
    ).toBeGreaterThan(0);

    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "notification_fanout_empty"));

    let recipients: string[] = [];
    try {
      for (const id of admins) {
        await db.update(profiles).set({ deactivatedAt: new Date() }).where(eq(profiles.id, id));
      }

      recipients = await findAuthoritiesForJurisdiction(
        // A province with no active assignment left (the whole-province fixture
        // was revoked above) — govt-first finds nobody either.
        { province: PROVINCE, locality: OTHER_LOCALITY },
        { route: TRACE_ROUTE },
      );
    } finally {
      for (const id of admins) {
        await db.update(profiles).set({ deactivatedAt: null }).where(eq(profiles.id, id));
      }
    }

    expect(recipients).toEqual([]);

    const after = await db
      .select({ id: auditLog.id, payload: auditLog.payload, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(eq(auditLog.action, "notification_fanout_empty"));

    // The whole deliverable in one assertion: the fan-out reached nobody AND
    // said so.
    expect(after.length).toBe(before.length + 1);

    const row = after.find((r) => !before.some((b) => b.id === r.id));
    expect(row).toBeDefined();
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.route).toBe(TRACE_ROUTE);
    expect(payload.province).toBe(PROVINCE);
    expect(payload.locality).toBe(OTHER_LOCALITY);
    expect(payload.reason).toBe("no_govt_no_admin");
    // No human acted — the row exists precisely because the system produced no
    // recipient. The FK is nullable for system writers like this one.
    expect(row?.actorUserId).toBeNull();
  });

  it("does not count a service account as somebody the fan-out reached", async () => {
    // DEFECT 3 (2026-08-17). The fallback filtered role, accountType and
    // deactivatedAt — every one of which a service account satisfies. So it was
    // notified about real bite reports and outbreaks nobody would read, and,
    // worse, it PADDED the list this very check reads: with a system account
    // present the fan-out looked successful and the silence was never recorded.
    // The audit row's own reason is "no_govt_no_admin"; the surrounding comment
    // says the announcement "reaches zero humans". A service account is not one.
    const humans = await activeInstitutionalAdminIds();
    expect(humans).not.toContain(SYSTEM_ADMIN_ID);

    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "notification_fanout_empty"));

    let recipients: string[] = [];
    try {
      for (const id of humans) {
        await db.update(profiles).set({ deactivatedAt: new Date() }).where(eq(profiles.id, id));
      }
      // The system admin stays ACTIVE for this call — that is the whole point.
      recipients = await findAuthoritiesForJurisdiction(
        { province: PROVINCE, locality: OTHER_LOCALITY },
        { route: TRACE_ROUTE },
      );
    } finally {
      for (const id of humans) {
        await db.update(profiles).set({ deactivatedAt: null }).where(eq(profiles.id, id));
      }
    }

    expect(recipients).toEqual([]);

    const after = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "notification_fanout_empty"));
    expect(after.length).toBe(before.length + 1);
  });

  it("writes NO row when the admin fallback DOES reach somebody", async () => {
    // The fallback firing is a success, not a gap: a row here would drown the
    // real signal in noise from every unseeded locality in the country.
    const before = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "notification_fanout_empty"));

    const recipients = await findAuthoritiesForJurisdiction(
      { province: PROVINCE, locality: OTHER_LOCALITY },
      { route: TRACE_ROUTE },
    );
    expect(recipients.length).toBeGreaterThan(0);

    const after = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "notification_fanout_empty"));
    expect(after.length).toBe(before.length);
  });
});
