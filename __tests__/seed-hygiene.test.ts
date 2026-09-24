// DB-backed test for scripts/check-seed-hygiene.ts (plan-maestro-integridad
// C5 — "el seed es ciudadano de primera").
//
// Runs the SAME `findSeedHygieneOffenders` scan the CLI gate + the seed
// scripts' end-of-run check use, against the local Supabase Postgres
// (pnpm db:start). Asserts zero seed-marker hits in any renderable column —
// this is the assertion that actually fails CI when a re-seed regresses,
// independent of anyone remembering to run the CLI script by hand.
//
// Requires the local DB to be up; this file reaches a live Postgres
// connection so vitest's db-reachability partition runs it serially with the
// DB-integration project (see vitest.config.ts).

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import {
  NO_ORG_MEMBERSHIP_EMAILS,
  findNotificationHygieneOffenders,
  findReservedAccountOffenders,
  findSeedHygieneOffenders,
} from "../scripts/check-seed-hygiene";
import { RENDERABLE_TEXT_COLUMNS } from "../scripts/hygiene-rules";
import { RESERVED_ACCOUNT_EMAILS, ZERO_PET_OWNER_EMAIL } from "../scripts/seed-reserved-accounts";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:54322/postgres";

const sql = postgres(DATABASE_URL, { max: 1, connect_timeout: 5 });

afterAll(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

describe("seed hygiene — renderable columns carry no seed markers", () => {
  it(`is clean across all ${RENDERABLE_TEXT_COLUMNS.length} renderable column(s)`, async () => {
    const offenders = await findSeedHygieneOffenders(sql);

    if (offenders.length > 0) {
      const summary = offenders
        .slice(0, 10)
        .map((o) => `  ${o.table}.${o.column} id=${o.id}: "${o.sample}" (${o.matchedPattern})`)
        .join("\n");
      throw new Error(
        `${offenders.length} seed-hygiene offender(s) found — a renderable column carries a seed-identifiable marker.\n${summary}\n\nRun \`pnpm exec tsx scripts/seed-demo-polish.ts\` to repair, or fix the generator at the source (scripts/seed-panorama.ts).`,
      );
    }

    expect(offenders).toEqual([]);
  });
});

describe("notification hygiene — brand casing + welcome category (migration 0157)", () => {
  it("has 0 wrong-cased brand titles and 0 welcome rows missing a category", async () => {
    const offenders = await findNotificationHygieneOffenders(sql);

    if (offenders.length > 0) {
      const summary = offenders
        .slice(0, 10)
        .map((o) => `  id=${o.id}: ${o.issue} — "${o.sample}"`)
        .join("\n");
      throw new Error(
        `${offenders.length} notification-hygiene offender(s) found.\n${summary}\n\nSee db/migrations/0157_welcome_notification_category_and_casing.sql for the repair pattern.`,
      );
    }

    expect(offenders).toEqual([]);
  });
});

// A5 — the owner empty state must be verifiable by anyone, at any time.
//
// carla@dim.test was the documented zero-pet owner in e2e/owner-ia-p6.spec.ts
// and ended up with four pets: two from a QA wizard run (2026-07-17), two from
// scripts/seed-demo-polish.ts's round-robin reassignment (2026-07-26). Nothing
// in the repo noticed. This is the thing that notices — and it runs in
// `pnpm test`, so the next account to be eaten is named on the spot instead of
// surfacing as a mystery e2e failure weeks later.
describe("reserved seed accounts — the zero-pet owner is still empty", () => {
  it(`keeps ${RESERVED_ACCOUNT_EMAILS.length} reserved account(s) with 0 pets, and ${NO_ORG_MEMBERSHIP_EMAILS.length} owner account(s) in no organization`, async () => {
    const offenders = await findReservedAccountOffenders(sql);

    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.email}: ${o.issue} — ${o.detail}`).join("\n");
      throw new Error(
        [
          `${offenders.length} reserved-account offender(s) found.`,
          summary,
          "",
          "A reserved account exists to stay EMPTY — see scripts/seed-reserved-accounts.ts.",
          '"missing" means the seed never ran here: `pnpm seed:test`.',
          '"owns_pets" / "has_org_membership" means something assigned to it. Fix the',
          "assigner. Do NOT clear the account's rows to make this green unless the",
          "assignment itself was the mistake — deleting data to satisfy a test is how",
          "the previous zero-pet owner was lost in the first place.",
        ].join("\n"),
      );
    }

    expect(offenders).toEqual([]);
  });

  it("is not vacuous — the same predicate reports pets when an account has them", async () => {
    // The guard above passes trivially if the query never matches anybody. Run
    // the SAME count predicate against an account KNOWN to own pets and require
    // a non-zero answer, so a broken join or a typo'd email cannot masquerade
    // as clean.
    const [populated] = await sql<Array<{ email: string; pet_count: string }>>`
      SELECT u.email,
             (SELECT count(*) FROM ownerships o
               WHERE o.owner_user_id = u.id AND o.ended_at IS NULL)::text AS pet_count
        FROM auth.users u
       WHERE lower(u.email) <> lower(${ZERO_PET_OWNER_EMAIL})
         AND (SELECT count(*) FROM ownerships o
               WHERE o.owner_user_id = u.id AND o.ended_at IS NULL) > 0
       LIMIT 1
    `;

    if (!populated) {
      throw new Error(
        "No account in this database owns a pet, so the reserved-account guard cannot be proven non-vacuous. Seed the data (`pnpm seed:test`) and re-run.",
      );
    }

    expect(Number(populated.pet_count)).toBeGreaterThan(0);
  });
});

// The other half of the contract: accounts that must hold NO organization
// membership while legitimately OWNING pets.
//
// owner@dim.test is the account every owner-side e2e spec signs in as, and
// lib/infra/role-landing.ts rule 7 sends an owner with an active org-admin
// membership to /org. Staging drifted into exactly that between 2026-08-26 and
// 2026-09-02: the specs failed as if the owner surface had regressed, and the
// cause was one row in organization_memberships.
describe("seed owner accounts — still in no organization", () => {
  it("reports no membership offender for any of them", async () => {
    const offenders = (await findReservedAccountOffenders(sql)).filter((o) =>
      NO_ORG_MEMBERSHIP_EMAILS.some((email) => email.toLowerCase() === o.email.toLowerCase()),
    );

    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.email}: ${o.issue} — ${o.detail}`).join("\n");
      throw new Error(
        [
          `${offenders.length} offender(s) against the no-org-membership contract.`,
          summary,
          "",
          "Fix the assigner, not the row — unless the membership itself was the",
          "mistake. See NO_ORG_MEMBERSHIP_EMAILS in scripts/check-seed-hygiene.ts.",
        ].join("\n"),
      );
    }

    expect(offenders).toEqual([]);
  });

  it("covers accounts that DO own pets — the contract is memberships only", async () => {
    // Non-vacuity in the direction this contract could silently break: these
    // accounts are NOT reserved-empty, so a copy-paste that gave them
    // `mustOwnNoPets: true` would red the gate on correctly seeded data. Prove
    // both halves at once — the accounts exist, they own pets, and the scan
    // does not complain about the pets.
    const rows = await sql<Array<{ email: string; pet_count: string }>>`
      SELECT u.email,
             (SELECT count(*) FROM ownerships o
               WHERE o.owner_user_id = u.id AND o.ended_at IS NULL)::text AS pet_count
        FROM auth.users u
       WHERE lower(u.email) = ANY(${NO_ORG_MEMBERSHIP_EMAILS.map((e) => e.toLowerCase())}::text[])
    `;

    if (rows.length !== NO_ORG_MEMBERSHIP_EMAILS.length) {
      throw new Error(
        `Expected ${NO_ORG_MEMBERSHIP_EMAILS.length} seeded owner account(s), found ${rows.length}. Seed the data (\`pnpm seed:test\`) and re-run.`,
      );
    }

    const petless = rows.filter((r) => Number(r.pet_count) === 0).map((r) => r.email);
    expect(
      petless,
      "these accounts own pets by design; if one is empty the seed is incomplete, not the contract wrong",
    ).toEqual([]);

    const petOffenders = (await findReservedAccountOffenders(sql)).filter(
      (o) =>
        o.issue === "owns_pets" &&
        NO_ORG_MEMBERSHIP_EMAILS.some((email) => email.toLowerCase() === o.email.toLowerCase()),
    );
    expect(petOffenders, "owning a pet is not an offence for these accounts").toEqual([]);
  });
});
