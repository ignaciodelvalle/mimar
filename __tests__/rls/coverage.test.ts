// RLS coverage fitness test (V0-4 — P0 data security).
// ====================================================
//
// STRUCTURAL GUARANTEE: every table the project designates as PII or
// tenant-scoped MUST have Row Level Security ENABLED at the catalog level
// (pg_class.relrowsecurity = true). This test introspects the LIVE local
// Postgres catalog (the same stack the other db tests run against) and FAILS
// if any required table ships without RLS.
//
// WHY THIS MATTERS: the app connects as `postgres` (BYPASSRLS), so RLS never
// governs the app itself — it is pure defense-in-depth against the PostgREST
// surface reached via the supabase-js anon / publishable key. A new PII table
// shipped with RLS *disabled* is silently exposed to anon reads. This test is
// the tripwire that makes that omission a red CI run instead of a breach.
//
// HOW TO SATISFY A FAILURE: if you add a PII / tenant table, enable RLS on it
// in a migration (see db/migrations/0086_track_rls_in_migrations.sql) and add
// the table to `RLS_REQUIRED` below. If a new table is genuinely NOT PII and
// not tenant-scoped, add it to `RLS_INTENTIONALLY_EXCLUDED` with a reason —
// do NOT just delete it from the required set.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import {
  AUTHORITY_FUNCTION_TEXT_SQL,
  AUTHORITY_POLICY_TEXT_SQL,
  type AuthorityTextRow,
  DENY_ALL_ALLOWLIST,
  MIN_ADMIN_PREDICATES_IN_CATALOG,
  evaluatePlatformAdminPredicates,
  scanAuthorityTexts,
} from "../../scripts/check-rls-coverage";

// ---------------------------------------------------------------------------
// Designated PII / tenant-scoped tables — RLS MUST be enabled on each.
// Keep this list explicit (not derived) so adding a table is a deliberate act
// and the reviewer sees the security classification in the diff.
// ---------------------------------------------------------------------------
const RLS_REQUIRED: ReadonlyArray<string> = [
  // Owner-facing core (db/rls.sql → migration 0086)
  "profiles",
  "pets",
  "ownerships",
  "pet_events",
  "reminders",
  "attachments",
  "notifications",
  "libreta_share_tokens",
  // Admin governance (migration 0086)
  "govt_assignments",
  "approval_requests",
  "audit_log",
  // Organizations (migration 0086)
  "organizations",
  "organization_coverage",
  "organization_memberships",
  "organization_capability_grants", // migration 0004
  "organization_invitations", // deny-all, migration 0086
  // Welfare (migration 0086)
  "welfare_reports",
  "welfare_report_attachments",
  // Foster (migration 0086)
  "foster_volunteers",
  "foster_proposals",
  // Scheduling (migration 0086)
  "service_offerings",
  "service_schedule_rules",
  "time_slots",
  "appointments",
  // Cases + per-kind PII (migrations 0025 / 0026 / 0034 / 0046 / 0051)
  "cases",
  "case_events", // deny-all, migration 0086
  "custody_disputes",
  "custody_dispute_parties",
  "pet_service_dog",
  "pet_achievement_views",
  "org_contact_messages",
  // Newer PII / tenant tables — deny-all in migration 0086
  "pet_transfers",
  "pet_identifications",
  "physical_tag_interest",
  "eno_processing_queue",
  "event_notification_outbox",
  "notification_dead_letter", // deny-all, migration 0125 (PII payload recovery surface)
  // localidades-por-id B4 (0250): the place of each event (a projection of the
  // spine) and the append-only after-the-fact resolutions (admin actor +
  // reason). Platform-admin SELECT only, aal2-restricted.
  "event_places",
  "place_resolutions",
  // share_telemetry lived here until migration 0167 dropped the table (TEL-1,
  // PO 2026-08-04): collected per-view viewer data that nothing ever read.
  // Alert inbox + triage — deny-all backstop in migration 0111 (Paquete K).
  // Carries jurisdiction + actor FKs (acknowledged_by / contacted / resolved);
  // admin-only reads/writes go through Drizzle BYPASSRLS server actions.
  "alert_firings",
  // Threshold alert subscriptions (migration 0108): owner-scoped via
  // actor_user_id, RLS enabled with read/write-by-owner(+admin) policies.
  "alert_subscriptions",
  // Novedades feed watermark (migration 0143): per-user UI state, RLS enabled
  // with owner-only SELECT/INSERT/UPDATE policies (user_id = auth.uid()); no
  // admin branch, no DELETE (rows go via profiles CASCADE only).
  "operator_feed_watermarks",
  // Advisor remediation (migration 0113): deny-all on four tables the Supabase
  // security advisor flagged rls_disabled_in_public. The app reaches all four
  // only via Drizzle / service-role (BYPASSRLS); deny-all just closes the
  // anonymous PostgREST surface. This SUPERSEDES their 0086 PART 7 exclusion.
  "rate_limit_buckets",
  "_dim_migrations",
  "govt_business_rules",
  "jurisdictions_census",
  // Precomputed panorama aggregate cube (migration 0139): deny-all, read only
  // via analyticsDb service-role (BYPASSRLS). Values are already k-anon'd at
  // build (no sub-k value stored), but the tables still carry RLS-enabled
  // deny-all so PostgREST can never read them. Same posture as rate_limit_buckets.
  "panorama_cube",
  "panorama_cube_meta",
  // Precomputed KPI-strip cube (migration 0151): same posture as panorama_cube —
  // deny-all, tiles k-anon'd at build, read only via analyticsDb service-role.
  "panorama_kpi_cube",
  "panorama_kpi_cube_meta",
  // Web Push subscriptions (migration 0152): owner-only SELECT/INSERT/UPDATE
  // policies (user_id = auth.uid()); no DELETE (revocation is a soft
  // revoked_at update; rows go via profiles CASCADE only).
  "push_subscriptions",
  // Native push targets (migration 0222): the phone's sibling of the row above,
  // but NOT its policy shape — SELECT-own only (user_id = auth.uid()), zero
  // write policies, like pet_tags (0169) and pet_caretaker_grants (0189) below.
  // Registration, the last_used_at bump, the soft revoke and the purge are all
  // server-side over Drizzle (BYPASSRLS); the art. 16 erasure is SECURITY
  // DEFINER. 0152's owner-INSERT/UPDATE pair is the older direction, not the
  // model — 0163/0211/0212 are. The row carries the Expo delivery token, which
  // is a credential: anybody holding it can push to that device, so neither a
  // wrong reader nor a client-side writer is a privacy footnote.
  "push_targets",
  // Physical tags (migration 0169): SELECT-own policy only (activator or
  // current owner of the linked pet, TO authenticated); zero write policies —
  // issuance/activation/revocation go through server actions (BYPASSRLS).
  // Carries activation_code_hash (peppered HMAC) + two user FKs.
  "pet_tags",
  // Temporary-caretaker grants (migration 0189): SELECT-own policy only, for
  // the TWO PARTIES (granted_by_user_id or caretaker_user_id, TO
  // authenticated); zero write policies — the whole lifecycle goes through
  // server actions on the BYPASSRLS connection. A caretaker who could write
  // here could extend their own grant, which is the one thing the table must
  // never allow. Carries caretaker_email (a third party's PII) plus two user FKs.
  "pet_caretaker_grants",
  // /gob first-run onboarding checklist watermark (migration 0244, T4-O3):
  // per-user "have you visited this surface" fact, composite PK (user_id,
  // surface) — same posture as operator_feed_watermarks above, owner-only
  // SELECT/INSERT/UPDATE policies (user_id = auth.uid()), no admin branch, no
  // DELETE (rows go via profiles CASCADE, or via erase_subject_data — 0245
  // added it to both subject-rights RPCs).
  "user_surface_visits",
];

// ---------------------------------------------------------------------------
// DENY-ALL tables — RLS enabled with ZERO policies (the app reaches them only
// via Drizzle / service-role BYPASSRLS; the PostgREST surface must be fully
// closed). RLS-enabled + no policy = default-deny for every operation and role.
//
// R3 (Tier-2 authz critique): the coverage test asserted RLS-*enabled* but not
// that these deny-all tables carry NO policies — a table shipped RLS-on with an
// accidental `USING (true)` SELECT policy would still pass the enabled check
// while being wide open. This set makes the zero-policy contract explicit.
// Every entry is documented as deny-all in RLS_REQUIRED above.
// ---------------------------------------------------------------------------
// UNA SOLA DEFINICIÓN (2026-08-13). Acá vivía una copia literal de 15 nombres
// que había que mantener en sincronía a mano con DENY_ALL_ALLOWLIST de
// scripts/check-rls-coverage.ts. Estaban idénticas —lo verifiqué antes de
// tocarlas— pero dos listas de la misma cosa en dos archivos es una que se
// olvida de un miembro nuevo, que es exactamente cómo las columnas de
// jurisdicción y los buckets de storage se cayeron por el hueco.
//
// El script es la fuente porque además hace la INVERSIÓN que a esta lista le
// falta: itera el catálogo y exige que TODA tabla con RLS y cero policies esté
// declarada, así que una tabla deny-all nueva y no declarada ya falla en
// `pnpm lint:rls`. Este test consume esa misma lista para verificar el otro
// lado: que las declaradas efectivamente tengan cero policies.
//
// scripts/check-ledger-honesty.ts importa lo mismo por la misma razón.
const RLS_DENY_ALL: ReadonlyArray<string> = Object.keys(DENY_ALL_ALLOWLIST);

// ---------------------------------------------------------------------------
// Deliberately NOT under RLS — non-PII reference / system data. Each entry
// carries the justification. A reviewer must consciously move a table here.
// ---------------------------------------------------------------------------
const RLS_INTENTIONALLY_EXCLUDED: Readonly<Record<string, string>> = {
  // NOTE: govt_business_rules, jurisdictions_census, rate_limit_buckets and
  // _dim_migrations were excluded here (0086 PART 7) until migration 0113 moved
  // them to deny-all RLS — they now live in RLS_REQUIRED. See 0113.
  ar_localities:
    "Public INDEC locality reference data (already RLS-enabled by an earlier migration; not PII).",
  ar_localities_import_runs:
    "Import bookkeeping for the public locality reference dataset; no PII.",
  cron_runs: "System cron execution bookkeeping; no PII or tenant data.",
};

// ---------------------------------------------------------------------------

async function relrowsecurityMap(): Promise<Map<string, boolean>> {
  const rows = (await db.execute(sql`
    select c.relname as relname, c.relrowsecurity as rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
  `)) as unknown as Array<{ relname: string; rls: boolean }>;
  const map = new Map<string, boolean>();
  for (const row of rows) {
    map.set(row.relname, row.rls === true);
  }
  return map;
}

/** Count of RLS policies per public table, from the live catalog. */
async function policyCountMap(): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    select tablename, count(*)::int as n
    from pg_policies
    where schemaname = 'public'
    group by tablename
  `)) as unknown as Array<{ tablename: string; n: number }>;
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.tablename, Number(row.n));
  }
  return map;
}

/** Every policy on one table, with the command it applies to. */
async function policiesOn(table: string): Promise<Array<{ policyname: string; cmd: string }>> {
  return (await db.execute(sql`
    select policyname, cmd
    from pg_policies
    where schemaname = 'public'
      and tablename = ${table}
    order by policyname
  `)) as unknown as Array<{ policyname: string; cmd: string }>;
}

/** Every policy in the public schema with its role set, from the live catalog. */
async function policyRoleRows(): Promise<Array<{ tablename: string; policyname: string }>> {
  return (await db.execute(sql`
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and roles::text[] = array['public']
    order by tablename, policyname
  `)) as unknown as Array<{ tablename: string; policyname: string }>;
}

/** The USING/WITH CHECK predicates of one named policy, from the live catalog. */
async function policyPredicate(table: string, policyName: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    select coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
    from pg_policies
    where schemaname = 'public'
      and tablename = ${table}
      and policyname = ${policyName}
  `)) as unknown as Array<{ qual: string; with_check: string }>;
  if (rows.length === 0) return null;
  return `${rows[0].qual} ${rows[0].with_check}`;
}

describe("RLS coverage (V0-4 structural guarantee)", () => {
  it("every designated PII / tenant table has RLS enabled (relrowsecurity = true)", async () => {
    const map = await relrowsecurityMap();

    const missingTable = RLS_REQUIRED.filter((t) => !map.has(t));
    expect(
      missingTable,
      `Tables listed in RLS_REQUIRED but absent from the public schema. Either the migration did not run or the name is wrong: ${missingTable.join(", ")}`,
    ).toEqual([]);

    const rlsDisabled = RLS_REQUIRED.filter((t) => map.has(t) && map.get(t) !== true);
    expect(
      rlsDisabled,
      `PII / tenant tables WITHOUT RLS enabled (P0 data-security gap). Enable RLS in a migration (see 0086_track_rls_in_migrations.sql): ${rlsDisabled.join(", ")}`,
    ).toEqual([]);
  });

  it("every public table is classified — no PII table escapes the contract", async () => {
    const map = await relrowsecurityMap();
    const classified = new Set<string>([
      ...RLS_REQUIRED,
      ...Object.keys(RLS_INTENTIONALLY_EXCLUDED),
    ]);

    // Any public base table not in either list is unclassified. Forcing a
    // classification on every table is what makes a NEW PII table impossible
    // to ship unnoticed: it must be triaged into RLS_REQUIRED (and a migration)
    // or RLS_INTENTIONALLY_EXCLUDED (with a documented reason).
    const unclassified = [...map.keys()].filter((t) => !classified.has(t)).sort();
    expect(
      unclassified,
      `New public table(s) not classified for RLS. Add each to RLS_REQUIRED (and enable RLS in a migration) if it holds PII / tenant data, or to RLS_INTENTIONALLY_EXCLUDED with a reason if it does not: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("intentionally-excluded tables carry a non-empty justification", () => {
    const undocumented = Object.entries(RLS_INTENTIONALLY_EXCLUDED)
      .filter(([, reason]) => !reason || reason.trim().length === 0)
      .map(([table]) => table);
    expect(undocumented, `Excluded tables missing a reason: ${undocumented.join(", ")}`).toEqual(
      [],
    );
  });

  // R3 (Tier-2 authz critique): a deny-all table is only truly closed if it
  // carries ZERO policies. RLS-enabled + an accidental `USING (true)` SELECT
  // policy would pass the enabled check while being wide open to PostgREST. Assert
  // the zero-policy contract for every table documented as deny-all.
  it("every deny-all table carries ZERO RLS policies (default-deny, not USING(true))", async () => {
    const map = await relrowsecurityMap();
    const counts = await policyCountMap();

    // Guard: the deny-all tables must exist and have RLS enabled (else the
    // zero-policy assertion below would pass vacuously on a dropped/renamed table).
    const missingOrDisabled = RLS_DENY_ALL.filter((t) => map.get(t) !== true);
    expect(
      missingOrDisabled,
      `Deny-all tables absent or without RLS enabled: ${missingOrDisabled.join(", ")}`,
    ).toEqual([]);

    const withPolicies = RLS_DENY_ALL.filter((t) => (counts.get(t) ?? 0) > 0).map(
      (t) => `${t} (${counts.get(t)} policies)`,
    );
    expect(
      withPolicies,
      `Deny-all tables MUST have zero policies but some carry policies — a policy on a deny-all table can silently widen the PostgREST surface (P0). Investigate each: ${withPolicies.join(", ")}`,
    ).toEqual([]);
  });

  // "ZERO WRITE POLICIES" WAS A COMMENT, NOT A FENCE, AND THIS IS THE FENCE.
  //
  // `push_targets` is in RLS_REQUIRED, which asserts only that RLS is ENABLED.
  // The zero-policy assertion above reaches DENY_ALL_ALLOWLIST members and
  // `push_targets` is not one: it is SELECT-own, so it legitimately carries a
  // policy and cannot be checked by counting to zero. Its actual posture —
  // "read your own rows, and write nothing, ever" — lived in the RLS_REQUIRED
  // comment and in migration 0222's header, and nowhere a test could read.
  //
  // THAT IS NOT HYPOTHETICAL. Migration 0222 ships
  // `DROP POLICY IF EXISTS "push_targets insert by owner"` and its UPDATE
  // sibling precisely because an earlier draft created them. A future migration
  // that re-added one would open the table to PostgREST — a client writing its
  // own delivery rows directly — and every fence in this file would stay green,
  // because RLS is still enabled and the table is still not deny-all.
  //
  // THE ROW CARRIES A CREDENTIAL, which is why this table gets the assertion
  // first. `expo_push_token` is a delivery address anybody holding it can push
  // to. `pet_tags` and `pet_caretaker_grants` are documented with the same
  // SELECT-only shape and deserve the same treatment; this is the pattern to
  // copy when somebody gets to them.
  it("push_targets is SELECT-only — one policy, and not a write one", async () => {
    const policies = await policiesOn("push_targets");

    expect(
      policies.map((p) => `${p.policyname} (${p.cmd})`),
      "push_targets must carry EXACTLY ONE policy. A second one is either a write policy (which opens the table to PostgREST) or a widened read.",
    ).toHaveLength(1);

    // `cmd` is 'SELECT' for a read policy and 'INSERT' / 'UPDATE' / 'DELETE' /
    // 'ALL' for the ones that must never exist here. Asserting the value rather
    // than "is not INSERT" is what makes 'ALL' fail too.
    expect(
      policies[0]?.cmd,
      `push_targets' only policy must be a SELECT. Found '${policies[0]?.cmd}' on '${policies[0]?.policyname}': registration, the last_used_at bump, the soft revoke and the purge are all server-side over the BYPASSRLS connection, so a client-writable path here is a surface nobody asked for.`,
    ).toBe("SELECT");
  });

  // 2026-08-05: a policy with no TO clause applies to PUBLIC — every role,
  // including `anon`, whose key ships in the client bundle. Ten policies were in
  // that state (custody_disputes, custody_dispute_parties, cases,
  // pet_service_dog, pet_achievement_views ×3, cron_runs, ar_localities,
  // ar_localities_import_runs) and every existence-based check called them
  // covered. They were safe only because each predicate resolves through
  // auth.uid(), which is NULL for anon — one relaxed predicate away from an
  // anonymous read. Migration 0168 narrowed all ten to `TO authenticated`.
  it("every RLS policy names its roles explicitly (no policy falls through to PUBLIC)", async () => {
    const publicRolePolicies = (await policyRoleRows()).map(
      (r) => `${r.tablename}.${r.policyname}`,
    );
    expect(
      publicRolePolicies,
      `Policies with no TO clause, so they apply to PUBLIC (anon included). Name the roles in a forward-only migration — ALTER POLICY "<name>" ON public.<table> TO authenticated; — see 0168_rls_policies_explicit_roles.sql: ${publicRolePolicies.join(", ")}`,
    ).toEqual([]);
  });

  // R1 + R2 (Tier-2 authz critique): the govt READ policies on the two PII
  // surfaces must be jurisdiction-scoped. This is a catalog-level predicate
  // assertion (independent of any seeded session) proving migration 0140 landed:
  //   - pet_identifications govt read references jurisdiction_locality (R1), and
  //   - pet_service_dog references govt_assignments in its govt branch (R2).
  it("pet_identifications govt read policy is scoped by jurisdiction_locality (R1)", async () => {
    const predicate = await policyPredicate(
      "pet_identifications",
      "pet_identifications read by govt in jurisdiction",
    );
    expect(predicate, "govt read policy on pet_identifications is missing").not.toBeNull();
    expect(
      predicate,
      "govt read must scope by jurisdiction_locality (province-only match leaks PII province-wide — R1)",
    ).toContain("jurisdiction_locality");
    expect(predicate).toContain("govt_assignments");
    // Sibling guards: role='govt' + deactivation, matching custody_disputes.
    expect(predicate).toContain("'govt'::user_role");
    expect(predicate).toContain("deactivated_at IS NULL");
  });

  it("pet_service_dog authority policy joins govt_assignments for the govt branch (R2)", async () => {
    const predicate = await policyPredicate(
      "pet_service_dog",
      "service_dog select by owner or authority",
    );
    expect(predicate, "service_dog authority policy is missing").not.toBeNull();
    expect(
      predicate,
      "govt branch must join govt_assignments (no join = any institutional govt reads assistance-dog status nationwide — R2)",
    ).toContain("govt_assignments");
    expect(predicate).toContain("jurisdiction_locality");
  });

  // Migration 0215: an erased profile (deleted_at, Ley 25.326 art. 16) is not
  // a platform administrator. Seventeen live predicates said otherwise — every
  // `role = 'admin'` test on profiles checked deactivated_at or nothing.
  // Migration 0216: not a govt operator either — the five govt branches 0215
  // copied verbatim, plus can_read_case's, had the same hole. This reads the
  // SAME catalog text the fence reads (policies of public + storage, every
  // repo-owned function body) through the SAME scanner, so a migration-only
  // policy — the eleven admin ones and four of the five govt ones have no
  // db/*.sql source — cannot reintroduce the hole without going red here. The
  // static half over db/*.sql lives in __tests__/check-rls-coverage.test.ts;
  // the behavioural proof in __tests__/rls/erased-admin-authority.test.ts.
  it("every live platform-authority predicate (admin 0215, govt 0216) excludes erased AND deactivated profiles", async () => {
    const policies = (await db.execute(
      sql.raw(AUTHORITY_POLICY_TEXT_SQL),
    )) as unknown as AuthorityTextRow[];
    const functions = (await db.execute(
      sql.raw(AUTHORITY_FUNCTION_TEXT_SQL),
    )) as unknown as AuthorityTextRow[];
    const predicates = scanAuthorityTexts([...policies, ...functions]);

    // Non-vacuity: 25 on 2026-09-09 (19 admin: 17 policies + can_read_case +
    // pii.caller_is_admin; 6 govt: 5 policies + can_read_case). Zero is what a
    // broken scanner looks like.
    expect(
      predicates.length,
      `only ${predicates.length} platform-authority tests found in the live catalog — the scanner or the catalog query is broken, not the policies`,
    ).toBeGreaterThanOrEqual(MIN_ADMIN_PREDICATES_IN_CATALOG);
    expect(
      predicates.map((p) => p.source),
      "the two functions the erasure RPCs and the cases policies rely on must be in the inventory",
    ).toEqual(
      expect.arrayContaining(["function public.can_read_case", "function pii.caller_is_admin"]),
    );
    // The govt half must actually be in the inventory — the five 0216 policies
    // and can_read_case's govt branch — or a regex that quietly stopped
    // matching 'govt' would pass this test on the admin count alone.
    expect(
      predicates.filter((p) => p.role === "govt").map((p) => p.source),
      "the govt predicates 0216 redefined must be in the inventory",
    ).toEqual(
      expect.arrayContaining([
        'policy public.approval_requests "approval requests visible to applicant or authority"',
        'policy public.custody_dispute_parties "custody_dispute_parties select by parties and authorities"',
        'policy public.custody_disputes "custody_disputes select by parties and authorities"',
        'policy public.pet_identifications "pet_identifications read by govt in jurisdiction"',
        'policy public.pet_service_dog "service_dog select by owner or authority"',
        "function public.can_read_case",
      ]),
    );

    const { violations } = evaluatePlatformAdminPredicates(predicates);
    expect(
      violations.map(
        (v) =>
          `${v.source} (${v.role}; deleted_at: ${v.hasDeletedAt}, deactivated_at: ${v.hasDeactivatedAt}): ${v.conjunct.slice(0, 140)}`,
      ),
      "a live predicate grants platform authority to an erased or deactivated profile — redefine it in a forward-only migration (see 0215 / 0216)",
    ).toEqual([]);
  });
});

// A02-3 (T3-F1): VIEWS WERE INVISIBLE TO EVERY FENCE IN THIS FILE.
//
// Every catalog query above filters `relkind = 'r'`, and no table sets
// FORCE ROW LEVEL SECURITY. A view created without `security_invoker = true`
// executes as its OWNER — `postgres`, which is BYPASSRLS — so it reads the
// underlying tables with RLS switched off, and Supabase's default privileges
// grant SELECT on new public objects to `anon` and `authenticated`. That is an
// anonymous RLS bypass that a new migration can ship while every test here
// stays green. It already happened once: `pets_with_identifiers` (0056) was a
// definer view, caught only by the Supabase advisor, and 0113 dropped it.
//
// THE RULE: every view in a project-owned schema declares security_invoker.
// It does not look at grants on purpose: a definer view nobody can read today
// is one GRANT away from the bypass, and the grant is the line a reviewer
// skims. Materialised views cannot run as the invoker (they are populated by
// their owner and RLS never applies to them), so for those the rule is the
// only one that works: no SELECT for anon or authenticated.
//
// SHRINK-ONLY allowlist. Empty is the goal state and the current state; an
// entry needs a reason a reviewer can argue with.
const PROJECT_SCHEMAS = ["public", "pii", "ref"] as const;
const VIEW_SECURITY_INVOKER_ALLOWED: Readonly<Record<string, string>> = {};

type ViewRow = {
  schema: string;
  name: string;
  kind: "v" | "m";
  options: string[] | null;
  anon_select: boolean;
  authenticated_select: boolean;
};

async function projectViews(): Promise<ViewRow[]> {
  return (await db.execute(sql`
    select n.nspname as schema,
           c.relname as name,
           c.relkind::text as kind,
           c.reloptions as options,
           has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
           has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in (${sql.join(
      PROJECT_SCHEMAS.map((s) => sql`${s}`),
      sql`, `,
    )})
      and c.relkind in ('v', 'm')
    order by 1, 2
  `)) as unknown as ViewRow[];
}

/** Postgres stores the option as written: `security_invoker=true`, `=on`, `=1`, `=yes`. */
function declaresSecurityInvoker(options: string[] | null): boolean {
  return (options ?? []).some((o) => /^security_invoker=(true|on|1|yes)$/i.test(o.trim()));
}

describe("views run as the caller, not as their owner (A02-3)", () => {
  it("RULE: every view in a project schema declares security_invoker", async () => {
    const offenders = (await projectViews())
      .filter((v) => v.kind === "v" && !declaresSecurityInvoker(v.options))
      .map((v) => `${v.schema}.${v.name}`)
      .filter((qualified) => !(qualified in VIEW_SECURITY_INVOKER_ALLOWED));
    expect(
      offenders,
      "views WITHOUT security_invoker run as their BYPASSRLS owner — an RLS bypass for whoever can SELECT them. Fix in a forward-only migration: ALTER VIEW <schema>.<view> SET (security_invoker = true);",
    ).toEqual([]);
  });

  it("RULE: no materialised view in a project schema is readable by anon or authenticated", async () => {
    const offenders = (await projectViews())
      .filter((v) => v.kind === "m" && (v.anon_select || v.authenticated_select))
      .map((v) => `${v.schema}.${v.name}`)
      .filter((qualified) => !(qualified in VIEW_SECURITY_INVOKER_ALLOWED));
    expect(
      offenders,
      "a materialised view is populated by its owner and RLS never applies to it, so a PostgREST-readable one is an RLS bypass. REVOKE SELECT ON <schema>.<matview> FROM anon, authenticated; in a forward-only migration",
    ).toEqual([]);
  });

  it("every allowlisted view still exists and carries a reason", async () => {
    const live = new Set((await projectViews()).map((v) => `${v.schema}.${v.name}`));
    const stale = Object.entries(VIEW_SECURITY_INVOKER_ALLOWED)
      .filter(([name, reason]) => !live.has(name) || reason.trim().length === 0)
      .map(([name]) => name);
    expect(stale, "allowlist entries that no longer match a live view, or have no reason").toEqual(
      [],
    );
  });

  it("the rule is not vacuous: the enumeration sees the two known views", async () => {
    const views = await projectViews();
    // 2026-09-22: exactly these two (0186, 0210). If this fails the query stopped
    // seeing the catalog and the rules above pass for the wrong reason.
    expect(views.map((v) => `${v.schema}.${v.name}`)).toEqual(
      expect.arrayContaining([
        "public.welfare_report_content",
        "public.welfare_report_reporter_identity",
      ]),
    );
    expect(views.filter((v) => declaresSecurityInvoker(v.options)).length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

// Migration 0231: an institutional session below aal2 has no authority through
// PostgREST. Enforced by ONE restrictive policy per institution-granting table,
// so the question this pins is "is there a table that grants a platform
// principal something and lacks it". The granting set is DERIVED from the
// catalog, not listed: every public policy the platform-authority scanner above
// finds a `role = 'admin' / 'govt'` test in, plus every policy that authorises
// through can_read_case (admin + govt branches) or govt_assignments. A new
// policy with an institutional branch on a new table goes red here until the
// table gets its restrictive twin.
describe("institutional sessions require aal2 at the database layer (0231)", () => {
  it("every table with an institution-granting policy carries the restrictive aal2 policy", async () => {
    const policies = (await db.execute(
      sql.raw(AUTHORITY_POLICY_TEXT_SQL),
    )) as unknown as AuthorityTextRow[];
    const tableOf = (source: string) => /^policy public\.([a-z_0-9]+) /.exec(source)?.[1] ?? null;

    const granting = new Set<string>();
    for (const p of scanAuthorityTexts(policies)) {
      const t = tableOf(p.source);
      if (t) granting.add(t);
    }
    for (const row of policies) {
      const t = tableOf(row.source);
      if (t && /can_read_case\(|govt_assignments/.test(row.text)) granting.add(t);
    }
    // Non-vacuity: 18 tables on 2026-09-18. An empty set is a broken scanner.
    expect(
      granting.size,
      "institution-granting table inventory is suspiciously small",
    ).toBeGreaterThanOrEqual(15);

    const guarded = (await db.execute(sql`
      select distinct tablename
      from pg_policies
      where schemaname = 'public'
        and permissive = 'RESTRICTIVE'
        and cmd in ('SELECT', 'ALL')
        and roles @> array['authenticated']::name[]
        and coalesce(qual, '') like '%caller_meets_institutional_aal()%'
    `)) as unknown as Array<{ tablename: string }>;
    const guardedSet = new Set(guarded.map((r) => r.tablename));

    expect(
      [...granting].filter((t) => !guardedSet.has(t)).sort(),
      "these tables grant a platform principal a PostgREST read but do not require aal2 — add the restrictive policy (see migration 0231)",
    ).toEqual([]);
  });

  it("the one institutional WRITE grant (welfare_report_attachments INSERT) is guarded too", async () => {
    const rows = (await db.execute(sql`
      select policyname from pg_policies
      where schemaname = 'public' and tablename = 'welfare_report_attachments'
        and permissive = 'RESTRICTIVE' and cmd = 'INSERT'
        and coalesce(with_check, '') like '%caller_meets_institutional_aal()%'
    `)) as unknown as Array<{ policyname: string }>;
    expect(rows.length).toBe(1);
  });
});
