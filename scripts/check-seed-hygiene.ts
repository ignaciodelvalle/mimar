// Seed-hygiene DB validator — plan-maestro-integridad C5 dynamic gate.
//
// Queries the LIVE Postgres for seed-marker patterns (scripts/seed-hygiene-
// rules.ts) inside renderable text columns. A hit means a funcionario (or a
// citizen, on a public denuncia page) could see raw seed plumbing —
// "PANO-Seed-Owner" as a case's "Abrió:", "PANO-HIST-WEL-001243" inside a
// denuncia description — exactly the S5 symptom class this gate kills.
//
// Two callers:
//   - CLI: `pnpm tsx scripts/check-seed-hygiene.ts` (or the seed scripts
//     themselves, at the end of their run — see seed-panorama.ts).
//   - __tests__/seed-hygiene.test.ts — same `findSeedHygieneOffenders`
//     against the local DB, so CI enforces this even without re-seeding.
//
// It also enforces the SEED ACCOUNT CONTRACTS (see SEED_ACCOUNT_CONTRACTS
// below): the accounts whose value is what they must NOT have. Staging drift
// of exactly that kind — owner@dim.test holding an organization membership,
// which lands every owner e2e spec on /org instead of the owner surface — was
// observed between 2026-08-26 and 2026-09-02, and is what the
// NO_ORG_MEMBERSHIP_EMAILS rows guard.
//
// Mirrors check-locality-integrity.ts's connection/skip conventions: if the
// DB is unreachable, exit 0 with a warning rather than hard-failing CI that
// has no local Supabase running.
//
// Run:  pnpm tsx scripts/check-seed-hygiene.ts
// Exits 1 listing every offending row (table.column, id, matched pattern).
// Exits 0 when clean (or when the DB is unreachable).

import postgres from "postgres";

import { WRONG_CASE_BRAND } from "./check-brand-casing";
import { RENDERABLE_TEXT_COLUMNS, findSeedMarker } from "./hygiene-rules";
import { RESERVED_ACCOUNT_EMAILS } from "./seed-reserved-accounts";

export type SeedHygieneOffender = {
  table: string;
  column: string;
  id: string;
  matchedPattern: string;
  sample: string;
};

/**
 * Scan every renderable text column for seed-marker hits. Pure over an
 * injected `sql` client so it is reusable from the CLI and from the vitest
 * DB-backed test without duplicating connection logic.
 */
export async function findSeedHygieneOffenders(sql: postgres.Sql): Promise<SeedHygieneOffender[]> {
  const offenders: SeedHygieneOffender[] = [];

  for (const { table, column } of RENDERABLE_TEXT_COLUMNS) {
    // Identifiers come from the fixed RENDERABLE_TEXT_COLUMNS list above (not
    // user input), so building the query with sql.unsafe is safe here — the
    // postgres.js tagged-template helpers don't parameterize identifiers.
    const rows = await sql.unsafe<Array<{ id: string; value: string | null }>>(
      `SELECT id::text AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`,
    );
    for (const row of rows) {
      const matched = findSeedMarker(row.value);
      if (matched) {
        offenders.push({
          table,
          column,
          id: row.id,
          matchedPattern: matched,
          sample: (row.value ?? "").slice(0, 80),
        });
      }
    }
  }

  return offenders;
}

/**
 * Notification-specific hygiene checks (sweep-fixes-2 2026-07-23), separate
 * from the generic seed-marker scan above because these two checks aren't
 * "does this text carry a seed marker" — they're structural:
 *
 *   1. Brand casing — notifications.title must never carry the wrong-cased
 *      "MiMAR"/"Mimar"/"MIMAR" literal (canonical is "miMAR", PO decision
 *      2026-07-18). check-brand-casing.ts already fences app/**+components/**
 *      SOURCE; this is the DB-side companion for content a Postgres trigger
 *      writes (handle_new_user's welcome insert), which that static scanner
 *      cannot see.
 *   2. `welcome` category presence — the ONE notification_type this repo
 *      fully controls end-to-end (a single trigger, migration 0157). NOT a
 *      blanket "category must never be NULL" rule: several OTHER production
 *      write paths (notifyOwnerOfFirstStrangerScan, the
 *      approval_request_auto_expired cron, and a handful of direct
 *      db.insert(notifications) call sites — see 0157's follow-up note)
 *      still omit category, and asserting NOT NULL across the whole table
 *      would fail for reasons unrelated to seed/trigger hygiene. Scoping to
 *      `welcome` keeps this gate honest about what it actually guarantees.
 */
export type NotificationHygieneOffender = {
  id: string;
  issue: "wrong_cased_brand" | "welcome_missing_category";
  sample: string;
};

export async function findNotificationHygieneOffenders(
  sql: postgres.Sql,
): Promise<NotificationHygieneOffender[]> {
  const offenders: NotificationHygieneOffender[] = [];

  const titledRows = await sql.unsafe<Array<{ id: string; title: string }>>(
    "SELECT id::text AS id, title FROM notifications WHERE title IS NOT NULL",
  );
  for (const row of titledRows) {
    WRONG_CASE_BRAND.lastIndex = 0;
    if (WRONG_CASE_BRAND.test(row.title)) {
      offenders.push({
        id: row.id,
        issue: "wrong_cased_brand",
        sample: row.title.slice(0, 80),
      });
    }
  }

  const staleWelcomeRows = await sql.unsafe<Array<{ id: string; title: string }>>(
    "SELECT id::text AS id, title FROM notifications WHERE notification_type = 'welcome' AND category IS NULL",
  );
  for (const row of staleWelcomeRows) {
    offenders.push({
      id: row.id,
      issue: "welcome_missing_category",
      sample: row.title.slice(0, 80),
    });
  }

  return offenders;
}

/**
 * Accounts that must hold NO ACTIVE organization membership, and that legitimately
 * OWN PETS — so they cannot join RESERVED_ACCOUNT_EMAILS, whose whole contract
 * is emptiness (scripts/seed-reserved-accounts.ts, and the static fence in
 * __tests__/seed-reserved-accounts.test.ts that forbids spelling a reserved
 * address anywhere but its definition file — these two are spelled out across
 * a dozen specs and could never satisfy it).
 *
 * WHY THE ROW EXISTS. lib/infra/role-landing.ts rule 7: an owner with an active
 * org-ADMIN membership lands on `/org`, not `/inicio`. owner@dim.test is the
 * account every owner-side e2e spec signs in as, so one membership turns the
 * whole owner suite into "expected /mis-mascotas, got /org" — a product-shaped
 * red with a data-shaped cause. That drift was observed on staging between
 * 2026-08-26 and 2026-09-02, and is exactly what these rows guard.
 *
 * owner2@dim.test is here for the same reason from the other direction:
 * e2e/authz-ab-isolation.spec.ts uses it as Owner B *and* as the non-member,
 * so its emptiness of memberships is an ASSERTED property of three tests.
 *
 * The counterpart accounts are deliberately absent: orgadmin@dim.test and
 * vet@dim.test hold memberships by design (scripts/seed-test-users.ts).
 */
export const NO_ORG_MEMBERSHIP_EMAILS: readonly string[] = ["owner@dim.test", "owner2@dim.test"];

/**
 * One account's seed contract. Both kinds forbid an org membership; only a
 * reserved account must also own nothing.
 */
type SeedAccountContract = { email: string; mustOwnNoPets: boolean };

const SEED_ACCOUNT_CONTRACTS: readonly SeedAccountContract[] = [
  ...RESERVED_ACCOUNT_EMAILS.map((email) => ({ email, mustOwnNoPets: true })),
  ...NO_ORG_MEMBERSHIP_EMAILS.map((email) => ({ email, mustOwnNoPets: false })),
];

/**
 * Reserved-account hygiene — the DETECTOR behind the zero-pet owner contract,
 * and behind the no-org-membership contract above. "Reserved" here means an
 * account whose value is what it must NOT have, whether that is pets or a
 * membership.
 *
 * scripts/seed-reserved-accounts.ts guarantees an owner with no pets so the
 * owner empty state is verifiable (e2e/owner-ia-p6.spec.ts test 6). The seed
 * can guarantee creation; it cannot guarantee that nobody ever gives the
 * account a pet afterwards. That is exactly how the previous stand-in was lost:
 * a QA wizard run on 2026-07-17 registered two pets while logged in as
 * carla@dim.test, and a demo seed handed her two more on 2026-07-26. Nothing
 * went red. The e2e assertion just started failing weeks later, looking like a
 * product regression.
 *
 * This check makes that drift LOUD and NAMED. It runs from the CLI and, more
 * importantly, from __tests__/seed-hygiene.test.ts inside `pnpm test`.
 *
 * "missing" is an offender too: an account the seed promises and the database
 * does not have is the same broken contract from the other direction.
 */
export type ReservedAccountOffender = {
  email: string;
  issue: "missing" | "owns_pets" | "has_org_membership";
  detail: string;
};

export async function findReservedAccountOffenders(
  sql: postgres.Sql,
): Promise<ReservedAccountOffender[]> {
  const offenders: ReservedAccountOffender[] = [];

  for (const { email, mustOwnNoPets } of SEED_ACCOUNT_CONTRACTS) {
    const rows = await sql.unsafe<
      Array<{ id: string; pet_count: string; membership_count: string }>
    >(
      `SELECT u.id::text AS id,
              (SELECT count(*) FROM ownerships o
                WHERE o.owner_user_id = u.id AND o.ended_at IS NULL)::text AS pet_count,
              (SELECT count(*) FROM organization_memberships m
                WHERE m.user_id = u.id AND m.left_at IS NULL)::text AS membership_count
         FROM auth.users u
        WHERE lower(u.email) = lower($1)`,
      [email],
    );

    const row = rows[0];
    if (!row) {
      offenders.push({
        email,
        issue: "missing",
        detail: "no auth user — run `pnpm seed:test` (or `pnpm db:bootstrap`)",
      });
      continue;
    }

    const petCount = Number(row.pet_count);
    if (mustOwnNoPets && petCount > 0) {
      offenders.push({
        email,
        issue: "owns_pets",
        detail: `${petCount} active ownership(s) — this account must own none`,
      });
    }

    // ACTIVE ONLY — `left_at IS NULL`, the same predicate role-landing itself
    // uses (lib/infra/role-landing.ts, three `isNull(organizationMemberships
    // .leftAt)` clauses) and the same shape as the pet count above, which has
    // always said `ended_at IS NULL` and called the result "active".
    //
    // The word was right and the count was wrong, and the mismatch had teeth:
    // a membership someone properly ENDED changes no landing and breaks no
    // spec, but it made this gate red — and the failure text below forbids
    // deleting rows to clear it, so the only exits were an untrue "fix
    // whatever assigned them" or a hand-edit of the row. A guard whose only
    // remedy is to disobey its own instructions is a guard people switch off.
    const membershipCount = Number(row.membership_count);
    if (membershipCount > 0) {
      offenders.push({
        email,
        issue: "has_org_membership",
        detail: `${membershipCount} active organization membership(s) — an owner with an active org-admin membership lands on /org (lib/infra/role-landing.ts rule 7), not on the owner surface every e2e spec asserts against`,
      });
    }
  }

  return offenders;
}

async function runCheck(): Promise<void> {
  const dbUrl =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54322/postgres";

  const sql = postgres(dbUrl, { max: 1, connect_timeout: 5 });

  let offenders: SeedHygieneOffender[];
  let notificationOffenders: NotificationHygieneOffender[];
  let reservedOffenders: ReservedAccountOffender[];
  try {
    offenders = await findSeedHygieneOffenders(sql);
    notificationOffenders = await findNotificationHygieneOffenders(sql);
    reservedOffenders = await findReservedAccountOffenders(sql);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] check-seed-hygiene: could not reach the DB (${reason}). Skipping this run.\n  This guard needs the local Supabase stack (pnpm db:start) or a DATABASE_URL.`,
    );
    await sql.end({ timeout: 1 }).catch(() => {});
    process.exit(0);
    return;
  }
  await sql.end({ timeout: 1 }).catch(() => {});

  let failed = false;

  if (offenders.length > 0) {
    failed = true;
    for (const o of offenders) {
      console.error(
        `✗ ${o.table}.${o.column} id=${o.id}: seed marker "${o.matchedPattern}" in "${o.sample}"`,
      );
    }
    console.error(
      `\n✗ ${offenders.length} seed-hygiene offender(s) — a renderable column carries a seed-identifiable marker. Run scripts/seed-demo-polish.ts to repair, or fix the generator at the source (scripts/seed-panorama.ts).`,
    );
  }

  if (notificationOffenders.length > 0) {
    failed = true;
    for (const o of notificationOffenders) {
      console.error(`✗ notifications id=${o.id}: ${o.issue} — "${o.sample}"`);
    }
    console.error(
      `\n✗ ${notificationOffenders.length} notification-hygiene offender(s) — see db/migrations/0157_welcome_notification_category_and_casing.sql for the repair pattern.`,
    );
  }

  if (reservedOffenders.length > 0) {
    failed = true;
    for (const o of reservedOffenders) {
      console.error(`✗ reserved account ${o.email}: ${o.issue} — ${o.detail}`);
    }
    console.error(
      `\n✗ ${reservedOffenders.length} seed-account contract offender(s) — an account no longer lacks what it exists to lack. Do NOT delete its rows to make this pass unless they were created by mistake; read scripts/seed-reserved-accounts.ts (pets) and NO_ORG_MEMBERSHIP_EMAILS in this file (memberships), and fix whatever assigned them.`,
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `✓ Seed hygiene clean — 0 seed-marker hits across ${RENDERABLE_TEXT_COLUMNS.length} renderable column(s), 0 notification-hygiene offenders, ${RESERVED_ACCOUNT_EMAILS.length} reserved account(s) still empty, ${NO_ORG_MEMBERSHIP_EMAILS.length} owner account(s) still in no active organization membership.`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-seed-hygiene.ts") ||
    process.argv[1].endsWith("check-seed-hygiene.js"));

if (isMain) {
  runCheck();
}
