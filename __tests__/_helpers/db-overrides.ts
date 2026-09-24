// Test-only helpers for the pet_events append-only escape hatch.
//
// db/triggers.sql (`enforce_pet_events_append_only`) refuses any UPDATE or
// DELETE on pet_events unless the caller sets BOTH session-local GUCs in the
// same transaction:
//   set local app.allow_event_mutation       = 'true'
//   set local app.allow_event_mutation_actor = '<actor-uuid>'
//
// The actor is mandatory since PR #56 ("require accountable actor for
// pet_events mutation override") and is written into audit_log.actor_user_id
// (nullable FK to profiles.id, ON DELETE SET NULL since ARCH-H migration 0080).
// Tests must pass an actor that exists in profiles — the FK no longer blocks
// teardown, but the trigger still validates the actor UUID at insertion time.
//
// We resolve the actor lazily to admin@dim.test (seeded by
// scripts/seed-test-users.ts). admin is never torn down by fixtures, so the
// RESTRICT side of the FK is safe.

import { sql } from "drizzle-orm";

import { db } from "@/db";

let cachedActorId: string | null = null;

// The executor matters: resolving through the POOL while the caller already
// holds a transaction connection deadlocks under parallel cleanup (each tx
// occupies a slot and waits for another slot to run the lookup — measured as
// the 30s afterAll timeout in trigger-role-from-app-metadata, 2026-08-16).
// Callers inside a tx must pass THAT tx as the executor.
async function resolveCleanupActorId(
  executor: { execute: typeof db.execute } = db,
): Promise<string> {
  if (cachedActorId) return cachedActorId;
  const rows = (await executor.execute(sql`
    select p.id::text as id
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email = 'admin@dim.test'
    limit 1
  `)) as Array<{ id: string }>;
  const first = rows[0];
  if (!first?.id) {
    throw new Error(
      "withMutationOverride: admin@dim.test profile not found. Run `pnpm db:bootstrap` (with seeds) to populate the test users before running this test.",
    );
  }
  cachedActorId = first.id;
  return first.id;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs `fn` inside a transaction with the pet_events append-only escape hatch
 * enabled. Sets both `app.allow_event_mutation = 'true'` AND
 * `app.allow_event_mutation_actor = <admin uuid>`, as required by
 * `db/triggers.sql`.
 *
 * Use this for:
 *   - Test cleanup that cascades into pet_events (e.g. `delete from pets`
 *     where the pet has any events — including the welcome event auto-written
 *     by `handle_pet_creation`).
 *   - Tests that deliberately exercise the override (see
 *     `__tests__/pet-events-append-only.test.ts`).
 *
 * The audit_log row written by the trigger is attributed to admin@dim.test.
 *
 * Example:
 *   await withMutationOverride(async (tx) => {
 *     for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
 *   });
 */
// UUID v4 shape — enforced strictly to keep `sql.raw` interpolation safe.
// Postgres can't bind parameters in SET LOCAL, so the actor UUID has to be
// inlined as a literal. Validating the shape before interpolation prevents
// any chance of SQL injection from a corrupted cache.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withMutationOverride<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const actorId = await resolveCleanupActorId();
  if (!UUID_RE.test(actorId)) {
    throw new Error(`withMutationOverride: resolved actor id is not a UUID: ${actorId}`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local app.allow_event_mutation = 'true'`);
    await tx.execute(sql.raw(`set local app.allow_event_mutation_actor = '${actorId}'`));
    return fn(tx);
  });
}

/**
 * Sets BOTH audit_log escape-hatch GUCs on an already-open transaction —
 * `app.allow_audit_mutation = 'true'` AND `app.allow_audit_mutation_actor`
 * (admin@dim.test), as migration 0182 requires: the bypass without an
 * accountable actor is refused, and every override self-logs an
 * `audit_log_mutation_override` row attributed to that actor.
 *
 * Use this to replace the old bare
 * `tx.execute(sql\`set local app.allow_audit_mutation = 'true'\`)` lines in
 * test cleanup — same transaction shape, one extra GUC.
 */
export async function setAuditMutationGucs(tx: Tx): Promise<void> {
  // Resolve THROUGH the caller's tx — a pool query here deadlocks under
  // parallel cleanup (see resolveCleanupActorId's executor note).
  const actorId = await resolveCleanupActorId(tx);
  if (!UUID_RE.test(actorId)) {
    throw new Error(`setAuditMutationGucs: resolved actor id is not a UUID: ${actorId}`);
  }
  await tx.execute(sql`set local app.allow_audit_mutation = 'true'`);
  await tx.execute(sql.raw(`set local app.allow_audit_mutation_actor = '${actorId}'`));
}

/**
 * Runs `fn` inside a transaction with the audit_log escape hatch enabled —
 * the audit_log sibling of withMutationOverride. The override row written by
 * the trigger is attributed to admin@dim.test.
 */
export async function withAuditMutationOverride<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    return fn(tx);
  });
}
