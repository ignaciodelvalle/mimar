// The two 0208 mutants that nothing killed — Ley 25.326 art. 14 + art. 16.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// Migration 0208 put three tables into the subject-rights RPCs
// (operator_feed_watermarks, physical_tag_interest, organization_invitations)
// and shipped with its coverage split across two instruments, NEITHER of which
// can see the thing that matters:
//
//   * scripts/check-subject-rights-coverage.ts greps the live function TEXT for
//     `public.<table>`. By its own header it proves MENTION, not predicate
//     correctness — a table named with the wrong WHERE clause passes it.
//   * __tests__/subject-rights-rpcs.test.ts pins the top-level shape: the
//     section key exists and is an array. It says so out loud, and hands the
//     contents off: "this test seeds no rows into any of the three, so an empty
//     array satisfies it, and that is the honest limit here. Contents are the
//     0208 lane's own tests."
//
// The 0208 lane's own tests were never written. So two mutations of the live
// RPC bodies survived every gate in the repo:
//
//   A. art. 14 — drop the `- 'invitation_token'` projection from the export.
//      A LIVE BEARER CREDENTIAL then ships inside the subject's own data
//      export. Sharper than it first reads: the export is also callable by an
//      ADMIN over another subject, and an invitation the subject SENT carries a
//      token that opens an organization membership addressed to somebody else.
//   B. art. 16 — drop `WHERE user_id = p_user_id` from the watermark DELETE.
//      One person exercising their right to erasure then wipes the /gob and
//      /admin "Novedades" reading position of EVERY operator in the country.
//
// WHAT WAS RECOUNTED, AND WHAT CAME BACK
// ---------------------------------------------------------------------------
// Both were handed to this lane as production defects to close with an 0209.
// Recounted against the live body via `pg_get_functiondef`, NEITHER is: the
// export really does strip `invitation_token`, and the DELETE really does carry
// its predicate. There is no second path to the token either — no audit_log or
// notification payload carries it, and `invitation_token` is the real column
// name, not a comment that drifted off the schema. So 0208's SQL is correct and
// there is no 0209: the defect is that nothing was WATCHING it, and the fix for
// an unwatched invariant is a test, not a migration.
//
// HOW THE KILL IS OBSERVED RATHER THAN INFERRED
// ---------------------------------------------------------------------------
// Each mutant is applied for real — `CREATE OR REPLACE FUNCTION` over the live
// body — and the RPC is then called through it, so vitest reads the leaked
// token and the destroyed bystander row as DATA. Nothing here asserts "the
// source text contains a WHERE clause"; that is the class of assertion that let
// both mutants through in the first place.
//
// The mutant is derived from the live body at run time and the anchor must
// match EXACTLY ONCE (`applyMutant` fails loudly otherwise). That is deliberate:
// when a future migration rewrites either statement, this file does not quietly
// keep testing a shape that no longer exists — it goes red naming the anchor it
// could no longer find.
//
// THE ROLLBACK IS A SAFETY PROPERTY, NOT A TIDINESS ONE
// ---------------------------------------------------------------------------
// Local Supabase is SHARED by every parallel worktree. A `CREATE OR REPLACE`
// that commits would hand the other lanes a sabotaged RPC and they would have no
// way to know. Every mutation and every seeded row in this file lives inside one
// transaction that always ends in ROLLBACK — DDL in Postgres is transactional,
// so the function definition reverts with the data. `describe("the harness
// leaves nothing behind")` at the bottom is the assertion on that promise, and
// it is the most important block in the file.

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Row = Record<string, unknown>;

/** Thrown to force the rollback. Never escapes `inRolledBackTx`. */
class RollbackSignal extends Error {
  constructor() {
    super("intentional rollback — see subject-rights-0208-mutants.test.ts");
  }
}

/**
 * Runs `body` in a transaction that ALWAYS rolls back, and returns whatever it
 * observed. The observation is asserted OUTSIDE, by vitest, on plain data — so
 * a failing expectation can never be the thing that skips the rollback.
 */
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
 * `replacement`. Refuses to proceed unless the anchor occurs EXACTLY once —
 * zero means the production statement moved and this mutant no longer tests
 * anything; more than one means the mutation is ambiguous.
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
 * Seeds an auth user inside the transaction. The `on_auth_user_created` trigger
 * creates the profile the subject-rights FKs need, so nothing else is required.
 * Nothing is created through the Supabase admin API on purpose: that call is
 * outside the transaction and would survive the rollback.
 */
async function seedUser(tx: Tx): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `sr0208-${id}@dim-test.local`;
  await tx.execute(sql`INSERT INTO auth.users (id, email) VALUES (${id}::uuid, ${email})`);
  return { id, email };
}

async function seedOrganization(tx: Tx): Promise<string> {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const created = await rows(
    tx,
    sql`INSERT INTO public.organizations
          (public_token, legal_name, display_name, org_type, email)
        VALUES (${`ORG-SR0208-${suffix}`}, 'Refugio Mutante SR0208', 'Refugio Mutante SR0208',
                'shelter'::org_type, ${`org-${suffix.toLowerCase()}@dim-test.local`})
        RETURNING id`,
  );
  return created[0].id as string;
}

// ---------------------------------------------------------------------------
// Mutant A — art. 14, export_subject_data
// ---------------------------------------------------------------------------

const EXPORT_ANCHOR = "SELECT jsonb_agg(row_to_json(oi)::jsonb - 'invitation_token')";
const EXPORT_MUTANT = "SELECT jsonb_agg(row_to_json(oi)::jsonb)";

type ExportProbe = { invitations: Row[]; token: string };

/**
 * Seeds one OUTSTANDING invitation the subject SENT, then exports the subject's
 * own data — through the live body, or through the mutant that forgets to strip
 * the token.
 */
async function probeExport(mutated: boolean): Promise<ExportProbe> {
  return inRolledBackTx(async (tx) => {
    const subject = await seedUser(tx);
    const organizationId = await seedOrganization(tx);
    const token = `INV-SR0208-${randomUUID()}`;

    // Addressed to a THIRD PARTY, sent BY the subject. That is the shape the
    // leak is worst in: the token is a live door into someone else's
    // membership, and it would be handed to the subject — or to any admin who
    // exports on their behalf — as part of an art. 14 access request.
    await tx.execute(
      sql`INSERT INTO public.organization_invitations
            (organization_id, email, invited_role, can_write_pet_events,
             invited_by_user_id, invitation_token, expires_at)
          VALUES (${organizationId}::uuid, ${`invitee-${randomUUID()}@dim-test.local`},
                  'vet_individual'::organization_membership_role, true,
                  ${subject.id}::uuid, ${token}, now() + interval '7 days')`,
    );

    if (mutated) await applyMutant(tx, "export_subject_data", EXPORT_ANCHOR, EXPORT_MUTANT);

    await actAs(tx, subject.id);
    const result = await rows(
      tx,
      sql`SELECT public.export_subject_data(${subject.id}::uuid) AS result`,
    );
    const payload = result[0].result as Row;
    return { invitations: payload.organization_invitations as Row[], token };
  });
}

describe("art. 14 — the export must not carry a live invitation token", () => {
  it("returns the subject's outstanding invitation, without invitation_token", async () => {
    const { invitations, token } = await probeExport(false);

    // The section is POPULATED. Without this the next assertion is vacuous —
    // an export that returned `[]` would satisfy "no token" perfectly, which is
    // exactly how the existing shape test in subject-rights-rpcs.test.ts can
    // pass over a broken projection.
    expect(invitations).toHaveLength(1);
    const invitation = invitations[0];
    expect(invitation.email).toEqual(expect.stringContaining("@dim-test.local"));
    expect(invitation.invited_role).toBe("vet_individual");

    // The key is absent, not merely null or empty.
    expect(Object.hasOwn(invitation, "invitation_token")).toBe(false);
    // And the token is nowhere else in the row under a different name.
    expect(Object.values(invitation)).not.toContain(token);
  });

  it("KILL: dropping `- 'invitation_token'` puts the live token in the export", async () => {
    const { invitations, token } = await probeExport(true);

    expect(invitations).toHaveLength(1);
    // Observed, not inferred: this is the credential itself, read back out of
    // the art. 14 payload the RPC returned.
    expect(invitations[0].invitation_token).toBe(token);
  });
});

// ---------------------------------------------------------------------------
// Mutant B — art. 16, erase_subject_data
// ---------------------------------------------------------------------------

const ERASE_ANCHOR =
  "    DELETE FROM public.operator_feed_watermarks\n" +
  "     WHERE user_id = p_user_id\n" +
  "    RETURNING user_id";
const ERASE_MUTANT = "    DELETE FROM public.operator_feed_watermarks\n" + "    RETURNING user_id";

type EraseProbe = { survivors: string[]; subjectId: string; bystanderId: string; deleted: number };

/**
 * Seeds a watermark for the subject AND one for an unrelated operator, then
 * runs the erasure — through the live body, or through the mutant whose DELETE
 * has no predicate.
 */
async function probeErase(mutated: boolean): Promise<EraseProbe> {
  return inRolledBackTx(async (tx) => {
    const subject = await seedUser(tx);
    const bystander = await seedUser(tx);

    await tx.execute(
      sql`INSERT INTO public.operator_feed_watermarks (user_id, last_seen_recorded_at)
          VALUES (${subject.id}::uuid, now()), (${bystander.id}::uuid, now())`,
    );

    if (mutated) await applyMutant(tx, "erase_subject_data", ERASE_ANCHOR, ERASE_MUTANT);

    await actAs(tx, subject.id);
    await tx.execute(
      sql`SELECT public.erase_subject_data(${subject.id}::uuid, 'mutation probe — rolled back')`,
    );

    const left = await rows(
      tx,
      sql`SELECT user_id FROM public.operator_feed_watermarks
           WHERE user_id IN (${subject.id}::uuid, ${bystander.id}::uuid)`,
    );
    // The RPC returns void; its counters land in the audit row it writes.
    const audit = await rows(
      tx,
      sql`SELECT (payload->>'operator_watermarks_deleted')::int AS deleted
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

describe("art. 16 — the erasure deletes the subject's watermark and nobody else's", () => {
  it("removes the subject's row and leaves an unrelated operator's row standing", async () => {
    const { survivors, subjectId, bystanderId, deleted } = await probeErase(false);

    expect(survivors).not.toContain(subjectId);
    // The whole point of the predicate. A test that only checked the subject's
    // row was gone would pass under the mutant too.
    expect(survivors).toEqual([bystanderId]);
    expect(deleted).toBe(1);
  });

  it("KILL: dropping `WHERE user_id = p_user_id` erases the bystander's watermark too", async () => {
    const { survivors, bystanderId, deleted } = await probeErase(true);

    // Observed: the unrelated operator's reading position is gone, destroyed by
    // somebody else's art. 16 request.
    expect(survivors).toHaveLength(0);
    expect(survivors).not.toContain(bystanderId);
    expect(deleted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The promise the two blocks above depend on
// ---------------------------------------------------------------------------

describe("the harness leaves nothing behind", () => {
  // Local Supabase is shared with the other worktrees. A committed
  // CREATE OR REPLACE here is not a flaky test — it is a sabotaged RPC in
  // everyone else's run, and it would look like their bug.
  it("restores both RPC bodies after the mutants have run", async () => {
    const exportDef = await inRolledBackTx((tx) => liveDefinition(tx, "export_subject_data"));
    const eraseDef = await inRolledBackTx((tx) => liveDefinition(tx, "erase_subject_data"));

    expect(exportDef).toContain(EXPORT_ANCHOR);
    expect(exportDef).not.toContain(
      `${EXPORT_MUTANT}\n        FROM public.organization_invitations`,
    );
    expect(eraseDef).toContain(ERASE_ANCHOR);
  });

  it("leaves no seeded rows behind", async () => {
    const leftovers = await inRolledBackTx(async (tx) => {
      const invitations = await rows(
        tx,
        sql`SELECT count(*)::int AS n FROM public.organization_invitations
             WHERE invitation_token LIKE 'INV-SR0208-%'`,
      );
      const watermarks = await rows(
        tx,
        sql`SELECT count(*)::int AS n FROM public.operator_feed_watermarks w
             JOIN auth.users u ON u.id = w.user_id
            WHERE u.email LIKE 'sr0208-%@dim-test.local'`,
      );
      const users = await rows(
        tx,
        sql`SELECT count(*)::int AS n FROM auth.users WHERE email LIKE 'sr0208-%@dim-test.local'`,
      );
      return {
        invitations: invitations[0].n as number,
        watermarks: watermarks[0].n as number,
        users: users[0].n as number,
      };
    });

    expect(leftovers).toEqual({ invitations: 0, watermarks: 0, users: 0 });
  });
});
