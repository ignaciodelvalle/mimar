// user_surface_visits joins the subject-rights RPCs (migration 0245, T4-O3,
// PO review 2026-09-22: "a brand-new table cannot be born with a hole in
// both export and erasure").
//
// Same harness and the same reasoning as __tests__/subject-rights-0208-
// mutants.test.ts, which this file is a sibling of: scripts/check-subject-
// rights-coverage.ts proves only that public.user_surface_visits is MENTIONED
// in the live RPC bodies, never that the WHERE clause is right. A mutant that
// drops the subject predicate from either statement would still mention the
// table and would still pass that fence. The kill has to be observed as DATA
// — a bystander's row leaking into the wrong export, or surviving an erasure
// that should have reached only the subject — never inferred from the SQL
// text.
//
// Both mutants are applied for real (`CREATE OR REPLACE FUNCTION` over the
// live body) and every probe runs inside a transaction that always rolls
// back — local Supabase is shared with every other worktree, so a committed
// mutation here would sabotage everyone else's run. See "the harness leaves
// nothing behind" below for the assertion on that promise.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = Record<string, unknown>;

/** Thrown to force the rollback. Never escapes `inRolledBackTx`. */
class RollbackSignal extends Error {
  constructor() {
    super("intentional rollback — see subject-rights-user-surface-visits.test.ts");
  }
}

async function inRolledBackTx<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let observed: T | undefined;
  let reached = false;
  try {
    await db.transaction(async (tx) => {
      observed = await body(tx);
      reached = true;
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
  if (!reached) throw new Error("transaction body did not complete");
  return observed as T;
}

async function rows(tx: Tx, q: ReturnType<typeof sql>): Promise<Row[]> {
  return (await tx.execute(q)) as unknown as Row[];
}

async function liveDefinition(tx: Tx, proname: string): Promise<string> {
  const found = await rows(
    tx,
    sql`SELECT pg_get_functiondef(p.oid) AS def
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ${proname}`,
  );
  const def = found[0]?.def;
  if (typeof def !== "string") throw new Error(`public.${proname} not found in the live catalog`);
  return def;
}

/**
 * Replaces the live body of `public.<proname>` with one where `anchor` became
 * `replacement`. Refuses to proceed unless the anchor occurs EXACTLY once.
 */
async function applyMutant(
  tx: Tx,
  proname: string,
  anchor: string,
  replacement: string,
): Promise<void> {
  const def = await liveDefinition(tx, proname);
  const hits = def.split(anchor).length - 1;
  if (hits !== 1) {
    const why =
      "The production statement changed — re-derive the mutant against pg_get_functiondef before trusting this file again.";
    throw new Error(
      `mutant anchor found ${hits}× in the live body of public.${proname}, expected exactly 1. ${why} Anchor:\n${anchor}`,
    );
  }
  await tx.execute(sql.raw(def.replace(anchor, replacement)));
}

/** Makes `auth.uid()` answer `userId` for the rest of this transaction. */
async function actAs(tx: Tx, userId: string): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`,
  );
}

/**
 * Seeds an auth user inside the transaction. The `on_auth_user_created`
 * trigger creates the profile the surface-visits FK needs.
 */
async function seedUser(tx: Tx): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `srusv-${id}@dim-test.local`;
  await tx.execute(sql`INSERT INTO auth.users (id, email) VALUES (${id}::uuid, ${email})`);
  return { id, email };
}

async function seedVisit(tx: Tx, userId: string, surface: string): Promise<void> {
  await tx.execute(
    sql`INSERT INTO public.user_surface_visits (user_id, surface, first_visited_at, last_seen_at)
        VALUES (${userId}::uuid, ${surface}, now(), now())`,
  );
}

// ---------------------------------------------------------------------------
// Mutant A — art. 14, export_subject_data
// ---------------------------------------------------------------------------

const EXPORT_ANCHOR =
  "        FROM public.user_surface_visits v\n       WHERE v.user_id = p_user_id";
const EXPORT_MUTANT = "        FROM public.user_surface_visits v\n       WHERE true";

type ExportProbe = { visits: Row[]; subjectId: string; bystanderId: string };

/**
 * Seeds a visit for the subject AND one for an unrelated operator, then
 * exports the subject's own data — through the live body, or through the
 * mutant whose WHERE always matches.
 */
async function probeExport(mutated: boolean): Promise<ExportProbe> {
  return inRolledBackTx(async (tx) => {
    const subject = await seedUser(tx);
    const bystander = await seedUser(tx);
    await seedVisit(tx, subject.id, "panorama");
    await seedVisit(tx, bystander.id, "casos");

    if (mutated) await applyMutant(tx, "export_subject_data", EXPORT_ANCHOR, EXPORT_MUTANT);

    await actAs(tx, subject.id);
    const result = await rows(
      tx,
      sql`SELECT public.export_subject_data(${subject.id}::uuid) AS result`,
    );
    const payload = result[0].result as Row;
    return {
      visits: payload.user_surface_visits as Row[],
      subjectId: subject.id,
      bystanderId: bystander.id,
    };
  });
}

describe("art. 14 — export_subject_data includes user_surface_visits, only the subject's own", () => {
  it("returns the subject's visited surface", async () => {
    const { visits } = await probeExport(false);

    // Populated, not vacuous — see the module header on why an empty-array
    // pass is worthless here.
    expect(visits).toHaveLength(1);
    expect(visits[0].surface).toBe("panorama");
    expect(visits[0].first_visited_at).toBeTruthy();
    expect(visits[0].last_seen_at).toBeTruthy();
  });

  it("KILL: dropping the subject predicate leaks a bystander's visit into the export", async () => {
    const { visits, bystanderId } = await probeExport(true);

    // Observed as data: the export now carries a row this subject never
    // visited, belonging to somebody else's account.
    expect(visits.length).toBeGreaterThanOrEqual(2);
    expect(visits.map((v) => v.user_id)).toContain(bystanderId);
  });
});

// ---------------------------------------------------------------------------
// Mutant B — art. 16, erase_subject_data
// ---------------------------------------------------------------------------

const ERASE_ANCHOR =
  "    DELETE FROM public.user_surface_visits\n" +
  "     WHERE user_id = p_user_id\n" +
  "    RETURNING user_id";
const ERASE_MUTANT = "    DELETE FROM public.user_surface_visits\n" + "    RETURNING user_id";

type EraseProbe = { survivors: string[]; subjectId: string; bystanderId: string; deleted: number };

/**
 * Seeds a visit for the subject AND one for an unrelated operator, then runs
 * the erasure — through the live body, or through the mutant whose DELETE has
 * no predicate.
 */
async function probeErase(mutated: boolean): Promise<EraseProbe> {
  return inRolledBackTx(async (tx) => {
    const subject = await seedUser(tx);
    const bystander = await seedUser(tx);
    await seedVisit(tx, subject.id, "gob_home");
    await seedVisit(tx, bystander.id, "gob_home");

    if (mutated) await applyMutant(tx, "erase_subject_data", ERASE_ANCHOR, ERASE_MUTANT);

    await actAs(tx, subject.id);
    await tx.execute(
      sql`SELECT public.erase_subject_data(${subject.id}::uuid, 'mutation probe — rolled back')`,
    );

    const left = await rows(
      tx,
      sql`SELECT user_id FROM public.user_surface_visits
           WHERE user_id IN (${subject.id}::uuid, ${bystander.id}::uuid)`,
    );
    const audit = await rows(
      tx,
      sql`SELECT (payload->>'surface_visits_deleted')::int AS deleted
            FROM public.audit_log
           WHERE action = 'subject_erasure' AND target_user_id = ${subject.id}::uuid
           ORDER BY performed_at DESC
           LIMIT 1`,
    );

    return {
      survivors: left.map((r) => r.user_id as string),
      subjectId: subject.id,
      bystanderId: bystander.id,
      deleted: Number(audit[0].deleted),
    };
  });
}

describe("art. 16 — the erasure deletes the subject's surface visits and nobody else's", () => {
  it("removes the subject's row and leaves an unrelated operator's row standing", async () => {
    const { survivors, subjectId, bystanderId, deleted } = await probeErase(false);

    expect(survivors).not.toContain(subjectId);
    expect(survivors).toEqual([bystanderId]);
    expect(deleted).toBe(1);
  });

  it("KILL: dropping `WHERE user_id = p_user_id` erases the bystander's visit too", async () => {
    const { survivors, bystanderId, deleted } = await probeErase(true);

    expect(survivors).toHaveLength(0);
    expect(survivors).not.toContain(bystanderId);
    expect(deleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The promise the two blocks above depend on
// ---------------------------------------------------------------------------

describe("the harness leaves nothing behind", () => {
  it("restores both RPC bodies after the mutants have run", async () => {
    const exportDef = await inRolledBackTx((tx) => liveDefinition(tx, "export_subject_data"));
    const eraseDef = await inRolledBackTx((tx) => liveDefinition(tx, "erase_subject_data"));

    expect(exportDef).toContain(EXPORT_ANCHOR);
    expect(eraseDef).toContain(ERASE_ANCHOR);
  });

  it("leaves no seeded rows behind", async () => {
    const leftovers = await inRolledBackTx(async (tx) => {
      const visits = await rows(
        tx,
        sql`SELECT count(*)::int AS n FROM public.user_surface_visits v
             JOIN auth.users u ON u.id = v.user_id
            WHERE u.email LIKE 'srusv-%@dim-test.local'`,
      );
      const users = await rows(
        tx,
        sql`SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'srusv-%@dim-test.local'`,
      );
      return { visits: visits[0].n as number, users: users[0].n as number };
    });

    expect(leftovers).toEqual({ visits: 0, users: 0 });
  });
});
