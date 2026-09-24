// Direct-to-Postgres cleanup for e2e specs.
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// A spec that CREATES a pet cannot delete it through the app: registration is
// an append-only act by design, and there is no "delete my pet" flow — nor
// should there be. So e2e/create-pet.spec.ts left one pet behind on every run,
// forever, and the pile had consequences beyond untidiness:
//
//   * crisis-owner-lost-flow picks an arbitrary ACTIVE pet of owner@dim.test
//     and marks it lost. It reverts afterwards, but best-effort — so an
//     interrupted run leaves a test pet publicly LOST.
//   * Live review 2026-07-28 found exactly that: ProbeAlta-1785241484517 and
//     E2EPet-1785241569076 were the TOP TWO entries on the public /perdidas
//     list, above real records, on the demo an official is shown.
//   * The owner seed account's "first pet" had become an E2E leftover.
//
// Specs run in Node, so they can talk to the local database directly. This is
// deliberately NOT wired into the app's db layer (@/db is server-only and
// carries the react-server condition); it opens its own short-lived connection.
//
// LOCAL ONLY. Every call is a no-op against a non-local database — an e2e run
// pointed at staging must never delete rows there.
//
// AND NO DATABASE_URL MEANS NO CLEANUP AT ALL. This used to default to
// DEFAULT_LOCAL_URL when the variable was unset, which made "is this database
// local?" answer YES on a machine that has no database at all. The nightly
// (dim-interno:.github/workflows/e2e-nightly.yml) drives the DEPLOYED staging origin and
// deliberately sets no DATABASE_URL, so every run since 2026-08-26 got the
// localhost default: the cleanups tried to connect to a Postgres that does not
// exist on the runner (AggregateError, 24 failures a night), and — worse —
// e2e/degraded-states.spec.ts, which skips itself on `!isLocalDatabase()`
// precisely so it never registers an undeletable pet in a shared registry,
// believed it was local and ran. An absent DATABASE_URL is now the "no target
// declared" answer, not a guess. Deliberately NOT wired to
// STAGING_DATABASE_URL: the secret exists, and pointing this file at it would
// give a nightly the power to delete rows on staging, which is the one thing
// the LOCAL ONLY rule above exists to forbid.
//
// The cost, and it is real: a local `pnpm e2e` no longer cleans up unless the
// shell exports DATABASE_URL (no Playwright config loads .env.local). The skip
// says so on the first call rather than leaving the pile to be discovered on
// /perdidas weeks later.

import postgres from "postgres";

/**
 * What database, if any, this run is allowed to clean.
 *
 * Three answers, not two: "there is no declared database" is NOT the same
 * claim as "the declared database is remote", and collapsing them into a
 * localhost default is the defect described in the header.
 */
export type CleanupTarget =
  | { kind: "local"; url: string }
  | { kind: "remote"; url: string }
  | { kind: "undeclared" };

const LOCAL_HOST = /@(localhost|127\.0\.0\.1)[:/]/;

/** Hide the password before any URL reaches a log. */
function mask(url: string): string {
  return url.replace(/:[^:@]*@/, ":***@");
}

/**
 * The decision every entry point below starts from. Pure over an injected env
 * so it is unit-testable without a database (__tests__/e2e-db-cleanup.test.ts).
 */
export function resolveCleanupTarget(
  env: Record<string, string | undefined> = process.env,
): CleanupTarget {
  const declared = env.DATABASE_URL?.trim();
  if (!declared) return { kind: "undeclared" };
  return LOCAL_HOST.test(declared)
    ? { kind: "local", url: declared }
    : { kind: "remote", url: declared };
}

/**
 * True only for a database on this machine, and only when one was declared.
 *
 * Specs use the no-argument form as an ENVIRONMENT gate (see
 * e2e/degraded-states.spec.ts): "may this run create rows only a direct-to-
 * Postgres helper can remove?".
 */
export function isLocalDatabase(url?: string): boolean {
  if (url === undefined) return resolveCleanupTarget().kind === "local";
  return LOCAL_HOST.test(url);
}

const UNDECLARED_SKIP =
  "[e2e cleanup] skipped — DATABASE_URL is not set, so no database was declared for this run. A run against a deployed origin is expected to hit this; a LOCAL run that wants cleanup must export DATABASE_URL (`npx supabase status -o env`).";

// Announced once per worker process: loginAs calls resetAuthLoginRateLimits
// before every real sign-in, and one line per login would bury the report.
let undeclaredAnnounced = false;

function announceUndeclared(): void {
  if (undeclaredAnnounced) return;
  undeclaredAnnounced = true;
  console.warn(UNDECLARED_SKIP);
}

/**
 * Reset the auth login rate-limit buckets (fixture cleanup, NOT a weakening
 * of the control).
 *
 * WHY: `auth_login_email` is 5/min · 20/hour keyed on the EMAIL and enforced
 * before GoTrue, and `loginAs`'s session cache lives in worker-process module
 * state — but Playwright REPLACES the worker after every test failure (and
 * `retries: 1` doubles the churn), so each failure empties the cache and costs
 * a real sign-in. A handful of genuine failures therefore exhausts
 * owner@dim.test's hourly budget and cascades into "Demasiados intentos" for
 * every later spec (CI run 30852554456: 12 refusals on top of ~4 real
 * failures). Clearing the buckets before a REAL sign-in makes the suite's
 * login cost independent of worker churn while the limiter itself stays
 * fully active in the app — the control is exercised on every login, and
 * e2e/auth.spec.ts still walks the form's refusal paths on its own.
 *
 * Since T2-S6 an institutional sign-in also spends `auth_mfa_code_user` (5/min ·
 * 30/hour per account) when e2e/_mfa.ts answers the TOTP challenge, with the
 * same worker-churn arithmetic, so it is cleared with the other two.
 *
 * LOCAL ONLY — same guard as deletePetsByNamePrefix: a no-op against any
 * non-local database.
 */
export async function resetAuthLoginRateLimits(): Promise<void> {
  const target = resolveCleanupTarget();
  if (target.kind === "undeclared") announceUndeclared();
  if (target.kind !== "local") return;
  const url = target.url;

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`DELETE FROM rate_limit_buckets
      WHERE bucket_key LIKE ${"auth_login_ip:%"} OR bucket_key LIKE ${"auth_login_email:%"}
         OR bucket_key LIKE ${"auth_mfa_code_user:%"}`;
  } catch {
    // Best-effort: a failed reset just means the next login spends real budget.
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Repair a denuncia's jurisdiction when the geocode never resolved (fixture
 * repair, local DB only).
 *
 * WHY: the denuncia wizard fills jurisdiction_province/locality from a
 * SERVER-SIDE call to nominatim.openstreetmap.org fired when the pin drops —
 * the app never derives jurisdiction from the coordinates itself. When that
 * external call flakes (CI runners get throttled by Nominatim routinely), the
 * report still submits but lands with NULL jurisdiction, and every govt queue
 * ANDs an exact province/locality pair — so it is visible to nobody, and a
 * spec that filed a denuncia to prime a queue asserts against an empty list
 * for reasons outside the app. This sets the jurisdiction the CALLER already
 * knows (it chose the pin), and ONLY where the geocode left it NULL — a
 * resolved jurisdiction is never overwritten.
 *
 * ⚠ IT TAKES THE WELFARE REFERENCE CODE, AND IT REPAIRS BOTH TABLES.
 * This used to take one argument named `publicCode` and run a single
 * `UPDATE cases … WHERE public_code = $1`, which could never match a row:
 * `walkDenunciaWizard` returns the WELFARE REPORT's reference code
 * (`DEN-XXXXXXXX`, src/modules/welfare/domain/reference-code.ts) while a case's
 * public_code is `CAS-XXXX-XXXX` (cases-repository.generateUniqueCasePublicCode).
 * Measured on the local DB: 0 rows in `cases` carry a `DEN-` public_code
 * against 2806 welfare_reports that do. The safety net was inert.
 * It also aimed at the wrong table for the queues that matter: /gob/maltrato
 * (triage) and the Moderación stage scope on `welfare_reports.jurisdiction_*`
 * (welfareReportsScopeClause, lib/analytics/dashboards/_scope.ts), NOT on the
 * case's copy. Both are written from the same geocode, so both are repaired.
 */
export async function ensureDenunciaJurisdiction(
  referenceCode: string,
  province: string,
  locality: string,
): Promise<void> {
  const target = resolveCleanupTarget();
  if (target.kind === "undeclared") announceUndeclared();
  if (target.kind !== "local") return;
  if (!referenceCode) return;
  const url = target.url;

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // The report itself — what welfareReportsScopeClause fences the two
    // denuncia queues on.
    await sql`UPDATE welfare_reports
      SET jurisdiction_province = ${province}, jurisdiction_locality = ${locality}
      WHERE reference_code = ${referenceCode} AND jurisdiction_province IS NULL`;
    // The case create-welfare-report opened alongside it — what casesScopeClause
    // fences /gob/casos on. Joined through welfare_reports.case_id, because the
    // caller only ever holds the DEN- code.
    await sql`UPDATE cases c
      SET jurisdiction_province = ${province}, jurisdiction_locality = ${locality}
      FROM welfare_reports w
      WHERE w.reference_code = ${referenceCode}
        AND c.id = w.case_id
        AND c.jurisdiction_province IS NULL`;
  } catch {
    // Best-effort — the spec's own queue assertion reports the outcome.
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Delete every physical tag (chapa) whose lote id starts with `prefix`, plus
 * the spine events and notifications its activation/revocation produced.
 * Returns how many tag rows were removed.
 *
 * WHY: e2e/chapas.spec.ts manufactures its fixtures the way the product does —
 * an admin issues a real lote through /admin/chapas and the browser downloads
 * the issuance CSV, the ONE artifact that ever carries the plaintext activation
 * codes (issue-tag-batch.ts persists a peppered HMAC and nothing else). There
 * is no "delete a chapa" flow — nor should there be — so without this every run
 * would add a dead TAG- row to owner@dim.test's /cuenta/chapas, which is a
 * surface the demo shows to officials. Same failure mode, same remedy, as
 * deletePetsByNamePrefix below.
 *
 * `pet_events` has a BEFORE DELETE trigger enforcing the append-only spine; the
 * sanctioned escape hatch is the same GUC pair the vitest helpers use, set
 * LOCAL inside the transaction so it cannot leak to another session.
 *
 * `audit_log` is deliberately NOT swept: it is append-only by design and no
 * test cleans it (see __tests__/tag-issuance.test.ts, which keys its
 * one-row-per-batch assertion on a run-unique lote id for exactly that reason).
 *
 * LOCAL ONLY — a no-op against any non-local database.
 */
export async function deleteTagsByLotePrefix(prefix: string): Promise<number> {
  const target = resolveCleanupTarget();
  if (target.kind === "undeclared") {
    announceUndeclared();
    return 0;
  }
  if (target.kind === "remote") {
    console.warn(`[e2e cleanup] skipped — ${mask(target.url)} is not local.`);
    return 0;
  }
  const url = target.url;

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const doomed = await sql<Array<{ serial: string }>>`
      SELECT serial FROM pet_tags WHERE lote_id LIKE ${`${prefix}%`}`;
    if (doomed.length === 0) return 0;
    const serials = doomed.map((r) => r.serial);

    const actor = await sql<Array<{ id: string }>>`
      SELECT p.id::text AS id FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE u.email = 'admin@dim.test' LIMIT 1`;
    const actorId = actor[0]?.id;
    if (!actorId) {
      console.warn(
        "[e2e cleanup] skipped — no admin@dim.test profile to attribute the override to.",
      );
      return 0;
    }

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.allow_event_mutation', 'true', true)`;
      await tx`SELECT set_config('app.allow_event_mutation_actor', ${actorId}, true)`;
      // The tag_activated / tag_revoked events these serials appended, and the
      // owner notifications that hang off them. Matched on the payload serial
      // because the tag row carries no event id.
      const events = await tx<Array<{ id: string }>>`
        SELECT id::text AS id FROM pet_events
        WHERE event_type IN ('tag_activated', 'tag_revoked')
          AND payload->>'serial' = ANY(${serials}::text[])`;
      const eventIds = events.map((e) => e.id);
      if (eventIds.length > 0) {
        await tx`DELETE FROM notifications WHERE related_event_id = ANY(${eventIds}::uuid[])`;
        await tx`DELETE FROM pet_events WHERE id = ANY(${eventIds}::uuid[])`;
      }
      await tx`DELETE FROM pet_tags WHERE lote_id LIKE ${`${prefix}%`}`;
    });
    return serials.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Delete every pet whose name starts with `prefix`, plus the rows that hang off
 * it. Returns how many pets were removed.
 *
 * (This docblock used to sit ~180 lines above, stranded on top of
 * `resetAuthLoginRateLimits`, where it read as that function's contract. Moved
 * onto the function it describes in the same commit that fixed the delete order
 * below — a comment attached to the wrong function is worse than none.)
 *
 * `pet_events` has a BEFORE DELETE trigger enforcing the append-only spine; the
 * sanctioned escape hatch is the same GUC pair the vitest helpers use
 * (__tests__/_helpers/db-overrides.ts), set LOCAL inside the transaction so it
 * cannot leak to another session.
 *
 * THE CHILD ROWS ARE NOT A STYLE CHOICE — one of them is load-bearing. Every
 * table that points at `pets.id` carries `ON DELETE CASCADE` (migration 0038
 * swept the whole set) EXCEPT `pet_tags`, which arrived later, in 0169, as a
 * bare `pet_id uuid REFERENCES public.pets(id)` — i.e. NO ACTION. See the
 * comment on that DELETE below for what its absence costs.
 *
 * LOCAL ONLY — a no-op against any non-local database.
 */
export async function deletePetsByNamePrefix(prefix: string): Promise<number> {
  const target = resolveCleanupTarget();
  if (target.kind === "undeclared") {
    announceUndeclared();
    return 0;
  }
  if (target.kind === "remote") {
    console.warn(`[e2e cleanup] skipped — ${mask(target.url)} is not local.`);
    return 0;
  }
  const url = target.url;

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const actor = await sql<Array<{ id: string }>>`
      SELECT p.id::text AS id FROM profiles p
      JOIN auth.users u ON u.id = p.id
      WHERE u.email = 'admin@dim.test' LIMIT 1`;
    const actorId = actor[0]?.id;
    if (!actorId) {
      console.warn(
        "[e2e cleanup] skipped — no admin@dim.test profile to attribute the override to.",
      );
      return 0;
    }

    const doomed = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM pets WHERE name LIKE ${`${prefix}%`}`;
    if (doomed.length === 0) return 0;
    const ids = doomed.map((r) => r.id);

    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.allow_event_mutation', 'true', true)`;
      await tx`SELECT set_config('app.allow_event_mutation_actor', ${actorId}, true)`;
      // pet_caretaker_grants IS A SECOND CHILD THAT HAD TO BE NAMED, and it was
      // missing for a subtler reason than pet_tags below: its FK to `pets` IS
      // `ON DELETE CASCADE`, so reading the FK map alone says it needs no line
      // here. The blocker is not the pet delete — it is the OWNERSHIPS delete on
      // the very next statement.
      //
      // `pet_caretaker_grants.ownership_id` references `ownerships` with ON
      // DELETE SET NULL, and the table also carries a CHECK
      // (`pet_caretaker_grants_accept_check`) that an ACCEPTED grant must keep
      // an ownership. So nulling the column on an accepted grant raises 23514,
      // the whole transaction rolls back, and — exactly as the pet_tags note
      // below describes — NO pet is removed and the pile comes back in full,
      // quietly.
      //
      // MEASURED, not predicted (2026-09-07): sweeping the E2EPet-/RI0823-
      // prefixes on the shared registry failed on precisely this, with 12 grants
      // sitting on doomed pets. Locally this is latent only until a spec accepts
      // a caretaker grant on a pet it registered — `caretaker-temporal.spec.ts`
      // is one keystroke away from it.
      //
      // Deleting the grant is right rather than detaching it: a grant on a test
      // pet is spec-manufactured, and the CHECK forbids the detached state
      // anyway. It goes FIRST so the ownerships delete never sees a live row.
      await tx`DELETE FROM pet_caretaker_grants WHERE pet_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM pet_events WHERE pet_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM ownerships WHERE pet_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM pet_identifications WHERE pet_id = ANY(${ids}::uuid[])`;
      // pet_tags IS THE ONE CHILD THAT HAD TO BE NAMED, and it was missing.
      // Its FK is `pet_id uuid REFERENCES public.pets(id)` with no ON DELETE
      // (db/migrations/0169_pet_tags.sql:44) — so it defaults to NO ACTION, and
      // it is the only reference to `pets.id` that BLOCKS the delete. Not the
      // only non-CASCADE one: `notifications.related_pet_id` (db/schema.ts:1618)
      // and `welfare_reports.subject_pet_id` (db/schema.ts:1840) are ON DELETE
      // SET NULL, which resolves itself and needs no line here. So a single
      // activated chapa on a doomed pet raises 23503 on the DELETE below, the
      // whole transaction rolls back, and NO pet is removed: the pile this
      // file exists to prevent comes back in full, quietly, the first time a
      // spec activates a tag on a pet it registered. Latent today only because
      // chapas.spec.ts binds its lote to a SEEDED owner pet, which no prefix
      // here sweeps.
      //
      // DELETED, NOT DETACHED. The `pet_tags_state_machine` check forbids an
      // `active`/`revoked` row with a NULL pet_id (0169:57-60), so "orphan the
      // chapa" is not an option the schema offers — and a chapa bound to a
      // test pet is spec-manufactured stock, the same thing
      // deleteTagsByLotePrefix removes by lote. The `tag_activated` /
      // `tag_revoked` events it produced are already gone with the pet's
      // events above.
      await tx`DELETE FROM pet_tags WHERE pet_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM pets WHERE id = ANY(${ids}::uuid[])`;
    });
    return ids.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
