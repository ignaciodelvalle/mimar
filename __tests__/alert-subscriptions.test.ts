// __tests__/alert-subscriptions.test.ts — alert subscriptions: authorization +
// DB CHECK constraints.
//
// HISTORY — why this header changed (2026-07-30)
// ----------------------------------------------
// This file used to say its tests "do NOT run against a live database" and were
// blocked until "a local Supabase stack must be running and the
// alert_subscriptions table must exist (migration 0108)". That precondition
// arrived and nobody came back: `db/migrations/0108_alert_subscriptions.sql` is
// committed, the table is live locally with all three CHECK constraints, and
// the repo has a dedicated "db" vitest project (see vitest.config.ts +
// __tests__/db-reachability.ts) built for exactly this. The blocked note was
// stale, so it is gone.
//
// This file therefore runs in the "db" project — SERIALLY, against the local
// Postgres, with __tests__/setup.ts forcing the local URLs. Classification is
// mechanical: it imports `@/db`, so the partitioner puts it here automatically.
//
// WHAT IS COVERED
// ---------------
//   1. deleteAlertSubscriptionForUser ownership — the ONLY access-control gate
//      on this surface. The use-case checks `existing.actorUserId !== actorUserId`
//      and, belt-and-braces, re-filters the DELETE on actor_user_id. Both layers
//      are asserted: the returned error AND the survival of the victim's row.
//      Remove either and a test here fails.
//   2. The three CHECK constraints of migration 0108, exercised as real
//      constraint violations (SQLSTATE 23514), not as Zod rejections.
//   3. Migration parity — the DDL's three literal lists are parsed out of the
//      .sql and compared against the code's source-of-truth constants
//      (ALERT_METRIC_KEYS, ALERT_DIRECTIONS, PROVINCES). Change one without the
//      other and this fails loudly. Same idea as the 0033_cases.sql parity block
//      in __tests__/seed-case-guards.test.ts.
//
// WHAT IS DELIBERATELY NOT COVERED
// --------------------------------
// The five `it.todo`s under createAlertSubscriptionForUser are Zod shape checks
// the compiler already covers most of. They were explicitly deprioritised by the
// PO on 2026-07-30 — left as todos on purpose, not forgotten and not silently
// closed.
//
// TEARDOWN
// --------
// Every row this file inserts is tracked and deleted in afterAll. alert_subscriptions
// carries NO append-only trigger (unlike pet_events), so the
// `withMutationOverride` escape hatch in __tests__/_helpers/db-overrides.ts is
// not needed here — a plain scoped DELETE is the correct teardown, and reaching
// for the override would be cargo-culting. alert_firings references this table
// ON DELETE SET NULL, so teardown cannot orphan anything.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreateAlertSubscriptionInput } from "@/app/actions/alert-subscriptions";
import {
  ALERT_DIRECTIONS,
  ALERT_METRIC_KEYS,
  type AlertDirection,
  type AlertMetricKey,
  type AlertSubscription,
  alertSubscriptions,
  db,
} from "@/db";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { createAlertSubscriptionForUser } from "@/src/modules/alerts/application/subscriptions/create-alert-subscription";
import { deleteAlertSubscriptionForUser } from "@/src/modules/alerts/application/subscriptions/delete-alert-subscription";
import { CreateAlertSubscriptionSchema } from "@/src/modules/alerts/application/subscriptions/types";

import { expectDbError } from "./_helpers/expect-db-error";

// ---------------------------------------------------------------------------
// Compile-time shape assertions (always run)
// ---------------------------------------------------------------------------

// createAlertSubscriptionForUser returns AlertSubscription | { error: string }
type _CreateResult = Awaited<ReturnType<typeof createAlertSubscriptionForUser>>;
type _CreateOk = Extract<_CreateResult, AlertSubscription>;
type _CreateErr = Extract<_CreateResult, { error: string }>;

// deleteAlertSubscriptionForUser returns { ok: true } | { error: string }
type _DeleteResult = Awaited<ReturnType<typeof deleteAlertSubscriptionForUser>>;
type _DeleteOk = Extract<_DeleteResult, { ok: true }>;
type _DeleteErr = Extract<_DeleteResult, { error: string }>;

// CreateAlertSubscriptionInput is validated by Zod
const _validInput: CreateAlertSubscriptionInput = {
  metricKey: "active_zoonosis",
  direction: "above",
  threshold: 10,
  jurisdictionProvince: null,
  jurisdictionLocality: null,
  label: null,
};
void _validInput;

// Type-check: AlertSubscription has the expected shape
type _HasId = _CreateOk extends { id: string } ? true : never;
type _HasMetricKey = _CreateOk extends { metricKey: string } ? true : never;
type _HasIsActive = _CreateOk extends { isActive: boolean } ? true : never;
const _typeCheck: [_HasId, _HasMetricKey, _HasIsActive] = [true, true, true];
void _typeCheck;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Distinctive label so a leaked row is traceable to this file, not anonymous. */
const LABEL_PREFIX = "test:alert-subscriptions.test.ts";

/** Every id this file inserts, dropped in afterAll. */
const createdIds = new Set<string>();

function track<T extends { id: string }>(row: T): T {
  createdIds.add(row.id);
  return row;
}

async function profileIdForEmail(email: string): Promise<string> {
  const rows = (await db.execute(sql`
    select p.id::text as id
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email = ${email}
    limit 1
  `)) as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      `alert-subscriptions.test.ts: profile for ${email} not found. Run \`pnpm db:bootstrap\` (with seeds) first.`,
    );
  }
  return id;
}

/** The row owner in the authorization tests. */
let ownerId = "";
/** A DIFFERENT real user — the would-be attacker. Must exist: actor_user_id is
 *  an FK to profiles, so a made-up UUID would fail on insert, not on authz. */
let strangerId = "";

/** Insert a subscription owned by `actorUserId`, tracked for teardown. */
async function seedSubscription(actorUserId: string, label: string): Promise<AlertSubscription> {
  const result = await createAlertSubscriptionForUser(actorUserId, {
    metricKey: "active_zoonosis",
    direction: "above",
    threshold: 42,
    jurisdictionProvince: null,
    jurisdictionLocality: null,
    label: `${LABEL_PREFIX} ${label}`,
  });
  if ("error" in result) {
    throw new Error(`seedSubscription failed: ${result.error}`);
  }
  return track(result);
}

async function rowExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: alertSubscriptions.id })
    .from(alertSubscriptions)
    .where(eq(alertSubscriptions.id, id))
    .limit(1);
  return Boolean(row);
}

beforeAll(async () => {
  ownerId = await profileIdForEmail("admin@dim.test");
  strangerId = await profileIdForEmail("owner@dim.test");
  expect(ownerId).not.toBe(strangerId);
});

afterAll(async () => {
  if (createdIds.size > 0) {
    await db.delete(alertSubscriptions).where(inArray(alertSubscriptions.id, [...createdIds]));
    createdIds.clear();
  }
  // Belt-and-braces: anything this file labelled but failed to track (e.g. a
  // row inserted by a test that threw mid-assertion) still goes away, so
  // check-seed-hygiene / check-spine-integrity stay clean for the next run.
  await db.execute(sql`
    delete from public.alert_subscriptions
    where label like ${`${LABEL_PREFIX}%`}
  `);
});

// ---------------------------------------------------------------------------
// createAlertSubscriptionForUser — Zod shape, deliberately still pending
// ---------------------------------------------------------------------------
//
// PO decision 2026-07-30: deprioritised. `CreateAlertSubscriptionSchema` mirrors
// ALERT_METRIC_KEYS / ALERT_DIRECTIONS via z.enum, so tsc already rejects the
// literal-typed call sites; what is left untested is only the runtime path for
// unvalidated input crossing the server-action boundary. Left as todos ON
// PURPOSE — do not close these without covering them.

describe("createAlertSubscriptionForUser", () => {
  it.todo("inserts a row owned by the provided actorUserId");
  it.todo("rejects an invalid metric_key via Zod validation");
  it.todo("rejects an invalid direction via Zod validation");
  it.todo("rejects a threshold that is not a finite number");
  it.todo("returns the inserted row with a generated UUID");
});

// ---------------------------------------------------------------------------
// deleteAlertSubscriptionForUser — ownership enforcement
// ---------------------------------------------------------------------------

describe("deleteAlertSubscriptionForUser", () => {
  it("deletes a row when actorUserId matches the owner", async () => {
    const row = await seedSubscription(ownerId, "owner-can-delete");
    expect(await rowExists(row.id)).toBe(true);

    const result = await deleteAlertSubscriptionForUser(ownerId, row.id);

    expect(result).toEqual({ ok: true });
    expect(await rowExists(row.id)).toBe(false);
  });

  it("returns { error } when the row does not exist", async () => {
    const missingId = crypto.randomUUID();
    // Guard the guard: the id must genuinely not be there, or the assertion
    // below would pass for the wrong reason.
    expect(await rowExists(missingId)).toBe(false);

    const result = await deleteAlertSubscriptionForUser(ownerId, missingId);

    expect(result).toEqual({ error: "Suscripción no encontrada" });
  });

  it("returns { error } and LEAVES THE ROW INTACT when actorUserId is not the owner", async () => {
    // THE access-control test for this surface. Two assertions, guarding two
    // independent layers:
    //   - the returned { error } guards the explicit ownership branch in
    //     delete-alert-subscription.ts;
    //   - the row still existing guards the actor_user_id predicate on the
    //     DELETE itself.
    // Weaken either layer and exactly one of these fails.
    const victimRow = await seedSubscription(ownerId, "stranger-cannot-delete");

    const result = await deleteAlertSubscriptionForUser(strangerId, victimRow.id);

    expect(result).toEqual({ error: "No tenés permiso para eliminar esta suscripción" });
    expect(await rowExists(victimRow.id)).toBe(true);

    // …and the owner can still delete it afterwards — the failed attempt left
    // no side effect.
    expect(await deleteAlertSubscriptionForUser(ownerId, victimRow.id)).toEqual({ ok: true });
    expect(await rowExists(victimRow.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB CHECK constraints (migration 0108)
// ---------------------------------------------------------------------------
//
// These bypass Zod on purpose and hit the table directly: the point is that the
// DATABASE refuses the value, so a future code path that forgets to validate
// still cannot write garbage. SQLSTATE 23514 = check_violation.

describe("DB CHECK constraints (migration 0108)", () => {
  it("metric_key CHECK rejects an unknown key at the DB level", async () => {
    await expectDbError(
      db.insert(alertSubscriptions).values({
        actorUserId: ownerId,
        // Cast past $type<AlertMetricKey>() — the DB, not tsc, is under test.
        metricKey: "not_a_real_metric" as AlertMetricKey,
        direction: "above",
        threshold: "1",
        label: `${LABEL_PREFIX} bad-metric`,
      }),
      { code: "23514", constraint: "alert_subscriptions_metric_key_valid" },
    );
  });

  it("direction CHECK rejects a value other than 'above' or 'below'", async () => {
    await expectDbError(
      db.insert(alertSubscriptions).values({
        actorUserId: ownerId,
        metricKey: "active_zoonosis",
        direction: "sideways" as AlertDirection,
        threshold: "1",
        label: `${LABEL_PREFIX} bad-direction`,
      }),
      { code: "23514", constraint: "alert_subscriptions_direction_valid" },
    );
  });

  it("jurisdiction_province CHECK rejects a non-canonical province name", async () => {
    // "Provincia de Buenos Aires" is the everyday Spanish long form and a very
    // plausible thing to write — the canonical spelling is "Buenos Aires".
    await expectDbError(
      db.insert(alertSubscriptions).values({
        actorUserId: ownerId,
        metricKey: "active_zoonosis",
        direction: "above",
        threshold: "1",
        jurisdictionProvince: "Provincia de Buenos Aires",
        label: `${LABEL_PREFIX} bad-province`,
      }),
      { code: "23514", constraint: "alert_subscriptions_province_valid" },
    );
  });

  it("jurisdiction_province CHECK admits NULL and a canonical name", async () => {
    // The DDL is `jurisdiction_province IS NULL OR jurisdiction_province IN (…)`,
    // so NULL is legal — without this the rejection test above would also pass
    // against a constraint that banned everything.
    const [nullProvince] = await db
      .insert(alertSubscriptions)
      .values({
        actorUserId: ownerId,
        metricKey: "active_zoonosis",
        direction: "above",
        threshold: "1",
        jurisdictionProvince: null,
        label: `${LABEL_PREFIX} null-province`,
      })
      .returning();
    expect(nullProvince).toBeDefined();
    if (nullProvince) track(nullProvince);

    const [canonicalProvince] = await db
      .insert(alertSubscriptions)
      .values({
        actorUserId: ownerId,
        metricKey: "active_zoonosis",
        direction: "above",
        threshold: "1",
        jurisdictionProvince: "Buenos Aires",
        label: `${LABEL_PREFIX} canonical-province`,
      })
      .returning();
    expect(canonicalProvince?.jurisdictionProvince).toBe("Buenos Aires");
    if (canonicalProvince) track(canonicalProvince);
  });

  // REWRITTEN 2026-07-31 (P3.2). This test used to assert the OPPOSITE — that
  // the DB CHECK was the only gate and an un-canonical province came back as a
  // raw SQLSTATE 23514 — and it carried the note "if that UX is ever fixed,
  // THIS test is the one that will tell you". It told us. The schema now
  // validates jurisdictionProvince against the same catalog, so the test
  // asserts the new contract instead of the old defect.
  it("a non-canonical province is refused by Zod as a friendly { error } — it never reaches Postgres", async () => {
    const label = `${LABEL_PREFIX} usecase-bad-province`;
    const result = await createAlertSubscriptionForUser(ownerId, {
      metricKey: "active_zoonosis",
      direction: "above",
      threshold: 1,
      jurisdictionProvince: "Cordoba", // missing the accent → not canonical
      jurisdictionLocality: null,
      label,
    });

    expect(result).toHaveProperty("error");
    // The message must NAME the problem. A generic "Datos inválidos" here would
    // be a different defect wearing this test's green.
    expect("error" in result && result.error).toMatch(/provincia/i);

    // The load-bearing half: rejected BEFORE the insert, not after catching the
    // constraint. Without this the assertion above would also pass on a version
    // that wrote the row and then reported an error.
    const written = await db
      .select({ id: alertSubscriptions.id })
      .from(alertSubscriptions)
      .where(eq(alertSubscriptions.label, label));
    for (const r of written) createdIds.add(r.id);
    expect(written).toHaveLength(0);
  });

  it("a canonical province still goes through the use-case unharmed (the enum is a gate, not a wall)", async () => {
    const result = await createAlertSubscriptionForUser(ownerId, {
      metricKey: "active_zoonosis",
      direction: "above",
      threshold: 1,
      jurisdictionProvince: "Córdoba",
      jurisdictionLocality: null,
      label: `${LABEL_PREFIX} usecase-good-province`,
    });
    expect(result).not.toHaveProperty("error");
    if (!("error" in result)) {
      track(result);
      expect(result.jurisdictionProvince).toBe("Córdoba");
    }
  });
});

// ---------------------------------------------------------------------------
// Migration parity — the DDL's literal lists vs the code's constants
// ---------------------------------------------------------------------------
//
// The CHECK tests above prove the constraints work TODAY against today's
// constants. They would not notice someone adding a 7th metric key to
// ALERT_METRIC_KEYS and forgetting the migration (or vice versa) — the two
// would just silently disagree until an insert failed in production. This block
// parses the shipped .sql and compares. Mirrors the 0033_cases.sql parity block
// in __tests__/seed-case-guards.test.ts.

describe("migration 0108 DDL parity with code constants", () => {
  const MIGRATION_SQL = readFileSync(
    join(process.cwd(), "db", "migrations", "0108_alert_subscriptions.sql"),
    "utf8",
  );

  /** The single-quoted literals of the first `IN ( … )` list after a named CHECK. */
  function literalsAfterConstraint(constraintName: string): string[] {
    const tail =
      MIGRATION_SQL.split(new RegExp(`CONSTRAINT\\s+${constraintName}\\b`, "i"))[1] ?? "";
    const list = tail.match(/\bIN\s*\(([^)]*)\)/i)?.[1] ?? "";
    return [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  }

  it("declares all three CHECK constraints", () => {
    for (const name of [
      "alert_subscriptions_metric_key_valid",
      "alert_subscriptions_direction_valid",
      "alert_subscriptions_province_valid",
    ]) {
      expect(MIGRATION_SQL).toContain(`CONSTRAINT ${name}`);
    }
  });

  it("metric_key list matches ALERT_METRIC_KEYS", () => {
    const parsed = literalsAfterConstraint("alert_subscriptions_metric_key_valid");
    expect(parsed.length).toBe(6);
    expect([...parsed].sort()).toEqual([...ALERT_METRIC_KEYS].sort());
  });

  it("direction list matches ALERT_DIRECTIONS", () => {
    const parsed = literalsAfterConstraint("alert_subscriptions_direction_valid");
    expect([...parsed].sort()).toEqual([...ALERT_DIRECTIONS].sort());
  });

  it("jurisdiction_province list matches the canonical PROVINCES catalog", () => {
    const parsed = literalsAfterConstraint("alert_subscriptions_province_valid");
    expect([...parsed].sort()).toEqual(PROVINCES.map((p) => p.name).sort());
  });

  it("keeps jurisdiction_province nullable in the CHECK (optional scope)", () => {
    const tail = MIGRATION_SQL.split(/CONSTRAINT\s+alert_subscriptions_province_valid\b/i)[1] ?? "";
    expect(tail).toMatch(/jurisdiction_province\s+IS\s+NULL\s+OR/i);
  });

  // P3.2 — the third side of the triangle. The two tests above pin
  // DDL ↔ PROVINCES; this one pins DDL ↔ the Zod gate, so the friendly
  // rejection and the constraint can never admit different sets. Without it,
  // adding a province to PROVINCES + the migration while forgetting the schema
  // (or vice-versa) would turn a legitimate value into a 400, or an illegitimate
  // one back into a raw 23514 — the exact defect P3.2 closed.
  function parseProvince(name: string | null) {
    return CreateAlertSubscriptionSchema.safeParse({
      metricKey: "active_zoonosis",
      direction: "above",
      threshold: 1,
      jurisdictionProvince: name,
    });
  }

  it("the Zod enum admits EXACTLY the provinces the DDL CHECK admits", () => {
    const fromDdl = literalsAfterConstraint("alert_subscriptions_province_valid");
    // Guard against the parser silently returning [] and making the loop vacuous.
    expect(fromDdl).toHaveLength(24);
    for (const name of fromDdl) {
      expect(parseProvince(name).success, `DDL admits "${name}" but Zod rejects it`).toBe(true);
    }
    // NULL is legal on both sides (optional scope).
    expect(parseProvince(null).success).toBe(true);
  });

  it("the Zod enum rejects a province the DDL CHECK would also reject", () => {
    for (const bad of ["Cordoba", "Provincia de Buenos Aires", "Ciudad Autónoma de Buenos Aires"]) {
      expect(literalsAfterConstraint("alert_subscriptions_province_valid")).not.toContain(bad);
      expect(parseProvince(bad).success, `Zod admits "${bad}" but the DDL does not`).toBe(false);
    }
  });
});
