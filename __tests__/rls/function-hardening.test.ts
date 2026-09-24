// Function-hardening fitness test (Supabase security advisor — 2026-06-24).
// =========================================================================
//
// Sibling of coverage.test.ts (RLS). Two structural guarantees the advisor
// checks, made into a red CI run instead of a silent drift:
//
//  1. function_search_path_mutable — every project-owned function the advisor
//     flagged MUST ship with a pinned `search_path` (proconfig). A SECURITY
//     DEFINER function with a mutable search_path is a privilege-escalation
//     vector. Migration 0114 (and db/triggers.sql for the trigger function)
//     set `search_path = ''`. This test fails if a future redefinition drops it.
//
//  2. Subject-rights RPCs (export_subject_data / erase_subject_data) MUST NOT be
//     EXECUTE-able by `anon`. They self-guard on auth.uid(), but anon should not
//     even hold the grant (defense in depth). Supabase's init grants EXECUTE to
//     anon directly, so a plain `REVOKE ... FROM PUBLIC` does NOT remove it —
//     migration 0114 does `REVOKE EXECUTE ... FROM anon`. This is the tripwire.
//
// Like coverage.test.ts, the lists are EXPLICIT (not derived) so adding/removing
// a hardened function is a deliberate, reviewable act. Extension-owned functions
// (pg_trgm, unaccent, …) are intentionally out of scope — they are not ours.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

// Project functions the advisor flagged function_search_path_mutable. Each is
// pinned to `search_path = ''` (all object refs in their bodies are schema-
// qualified, so empty is safe). Keyed by proname; overloads are disambiguated
// in the assertion message via the identity args returned from the catalog.
// For SECURITY DEFINER functions this list is no longer the guarantee — the
// catalog RULE at the bottom of this file is (A02-4). It stays for the
// SECURITY INVOKER trigger functions the advisor flagged, which the rule does
// not reach.
const SEARCH_PATH_PINNED: ReadonlyArray<string> = [
  "can_read_case",
  "cases_set_updated_at",
  "check_pet_event_case_id_immutable",
  "enforce_audit_log_append_only",
  "enforce_institutional_no_pets",
  "enforce_pet_events_append_only",
];

// SECURITY DEFINER functions that must not be anon-executable.
//
// Two families, one rule. The subject-rights RPCs (0114) self-guard on
// auth.uid() and are here as defense in depth. The ORACLES do not self-guard at
// all: they run as their BYPASSRLS owner and return a boolean about a row the
// caller demonstrably cannot read, so the EXECUTE grant is the ONLY thing
// between anon and a free probing oracle. 0123 closed the two case oracles;
// has_titular_write_access (0190) reopened the same class — a POST to
// /rest/v1/rpc/has_titular_write_access with only the publishable key answered
// "does this user own this pet?" with HTTP 200 while the same anonymous session
// counted 0 rows in `ownerships`. Closed by 0199; all three are pinned here so
// that work stays done.
const NO_ANON_EXECUTE: ReadonlyArray<string> = [
  "export_subject_data",
  "erase_subject_data",
  "can_read_case",
  "is_hidden_from_subject_case",
  "has_titular_write_access",
];

// Deliberately anon-EXECUTE-able SECURITY DEFINER functions in `public`.
//
// SHRINK-ONLY. The rule below enumerates pg_proc instead of trusting a
// hand-kept list, so anything new that anon can execute lands here as a RED
// test and has to be argued for in review. Empty is the goal state.
//
// NOT listed, because they are excluded by a PREDICATE rather than by name:
// trigger functions (prorettype = 'trigger'). PostgREST refuses to expose a
// function returning `trigger` at /rest/v1/rpc/…, and a trigger function can
// only be reached by firing the trigger, which is itself RLS-gated. That is
// what excludes handle_new_user — it is not RPC-reachable by construction, so
// naming it in an allowlist would claim a decision nobody has to make.
const ANON_EXECUTE_ALLOWED: ReadonlyArray<string> = [];

type ProcConfigRow = { proname: string; args: string; has_search_path: boolean };
type ProcAclRow = { proname: string; args: string; anon_can_execute: boolean };
type SecDefRow = { proname: string; args: string; volatility: string };

describe("function hardening (Supabase advisor fitness)", () => {
  it("every flagged function pins search_path (function_search_path_mutable)", async () => {
    const rows = (await db.execute(sql`
      select p.proname as proname,
             pg_get_function_identity_arguments(p.oid) as args,
             exists (
               select 1
               from unnest(coalesce(p.proconfig, array[]::text[])) c
               where c like 'search_path=%'
             ) as has_search_path
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (${sql.join(
          SEARCH_PATH_PINNED.map((p) => sql`${p}`),
          sql`, `,
        )})
    `)) as unknown as ProcConfigRow[];

    // Each expected function must be present at least once.
    const present = new Set(rows.map((r) => r.proname));
    const missing = SEARCH_PATH_PINNED.filter((p) => !present.has(p));
    expect(
      missing,
      `Flagged functions absent from public schema (migration did not run or name changed): ${missing.join(", ")}`,
    ).toEqual([]);

    // Every overload of every expected function must have a pinned search_path.
    const mutable = rows.filter((r) => !r.has_search_path).map((r) => `${r.proname}(${r.args})`);
    expect(
      mutable,
      `Functions WITHOUT a pinned search_path (function_search_path_mutable). Add SET search_path = '' in a migration (see 0114): ${mutable.join(", ")}`,
    ).toEqual([]);
  });

  it("SECURITY DEFINER oracles and subject-rights RPCs are not executable by anon", async () => {
    const rows = (await db.execute(sql`
      select p.proname as proname,
             pg_get_function_identity_arguments(p.oid) as args,
             -- has_function_privilege resolves the WHOLE chain: a null acl
             -- (default EXECUTE to PUBLIC), an explicit anon grant, and a grant
             -- anon merely INHERITS through PUBLIC. The old aclexplode form saw
             -- only the middle one — an aclexplode row for PUBLIC carries
             -- grantee 0, never 'anon'::regrole — so a PUBLIC-only grant read
             -- as closed. 0190 shipped both, which is why revoking one alone
             -- would have been another "applied but not closed".
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (${sql.join(
          NO_ANON_EXECUTE.map((p) => sql`${p}`),
          sql`, `,
        )})
    `)) as unknown as ProcAclRow[];

    const present = new Set(rows.map((r) => r.proname));
    const missing = NO_ANON_EXECUTE.filter((p) => !present.has(p));
    expect(
      missing,
      `SECURITY DEFINER functions absent from public schema: ${missing.join(", ")}`,
    ).toEqual([]);

    const anonExecutable = rows
      .filter((r) => r.anon_can_execute)
      .map((r) => `${r.proname}(${r.args})`);
    expect(
      anonExecutable,
      `SECURITY DEFINER functions EXECUTE-able by anon (oracle / data-rights exposure). REVOKE EXECUTE ... FROM PUBLIC, anon in a migration (see 0123 / 0199): ${anonExecutable.join(", ")}`,
    ).toEqual([]);
  });

  // THE RULE, replacing the list above as the real guarantee.
  //
  // NO_ANON_EXECUTE is five names somebody remembered to add. It already missed
  // a live one: public.reap_stuck_app_backends() (0136) is SECURITY DEFINER, so
  // it runs as `postgres`, takes no arguments and is VOLATILE — which makes it
  // reachable at POST /rest/v1/rpc/reap_stuck_app_backends with nothing but the
  // publishable key — and its body calls pg_terminate_backend over
  // pg_stat_activity. 0136 revoked it FROM PUBLIC only, and Supabase's init
  // grants EXECUTE to `anon` DIRECTLY, so the grant survived (the same trap
  // migration 0114's comment describes, and the same one 0190 fell into).
  //
  // The blast radius is bounded — the WHERE clause only matches stuck Supavisor
  // backends — so this is not arbitrary process kill. It is still an
  // unauthenticated remote call with a side effect, and it is hammerable.
  //
  // Enumerating the catalog is ~5 lines of SQL and covers 7 functions today, so
  // there is no reason for the guarantee to be a list.
  it("RULE: no SECURITY DEFINER function in public is anon-executable", async () => {
    const rows = (await db.execute(sql`
      select p.proname as proname,
             pg_get_function_identity_arguments(p.oid) as args,
             p.provolatile as volatility
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        -- Trigger functions are not RPC-reachable: PostgREST refuses to expose
        -- a function returning trigger, and firing the trigger is RLS-gated.
        and p.prorettype <> 'pg_catalog.trigger'::regtype
        and has_function_privilege('anon', p.oid, 'EXECUTE')
      order by p.proname
    `)) as unknown as SecDefRow[];

    const offenders = rows
      .map((r) => `${r.proname}(${r.args})`)
      .filter((sig) => !ANON_EXECUTE_ALLOWED.includes(sig.replace(/\(.*\)$/, "")));

    expect(
      offenders,
      `SECURITY DEFINER functions anon can EXECUTE. Each runs as its owner, so the EXECUTE grant is the whole boundary. REVOKE EXECUTE ... FROM PUBLIC, anon in a forward-only migration (see 0199 / 0200): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the rule is not vacuous: public really does hold SECURITY DEFINER functions", async () => {
    const rows = (await db.execute(sql`
      select p.proname as proname,
             pg_get_function_identity_arguments(p.oid) as args,
             p.provolatile as volatility
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and p.prorettype <> 'pg_catalog.trigger'::regtype
    `)) as unknown as SecDefRow[];

    // If this floor ever fails, the enumeration stopped seeing the schema and
    // the rule above is passing for the wrong reason.
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  // A02-4 (T3-F1): THE SAME UPGRADE, FOR search_path.
  //
  // SEARCH_PATH_PINNED at the top of this file is six names, five of them
  // trigger functions — of the live non-trigger SECURITY DEFINER functions only
  // can_read_case was on it. A new migration adding a definer function that
  // forgot `SET search_path` passed green, and that is the one case where a
  // mutable search_path matters most: the body runs as the BYPASSRLS owner and
  // resolves unqualified names through a path the CALLER controls (a
  // pg_temp.<table> shadow is enough). So the guarantee is the catalog, not the
  // list — every SECURITY DEFINER function in a project schema, triggers
  // included (they run as the owner too), must carry a search_path in proconfig.
  //
  // SHRINK-ONLY. Empty is the goal state and the current state.
  const DEFINER_SEARCH_PATH_EXEMPT: Readonly<Record<string, string>> = {};

  it("RULE: every SECURITY DEFINER function in a project schema pins search_path", async () => {
    const rows = (await db.execute(sql`
      select n.nspname as schema,
             p.proname as proname,
             pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'pii', 'ref')
        and p.prosecdef
        and not exists (
          select 1
          from unnest(coalesce(p.proconfig, array[]::text[])) c
          where c like 'search_path=%'
        )
      order by 1, 2
    `)) as unknown as Array<{ schema: string; proname: string; args: string }>;

    const offenders = rows
      .filter((r) => !(`${r.schema}.${r.proname}` in DEFINER_SEARCH_PATH_EXEMPT))
      .map((r) => `${r.schema}.${r.proname}(${r.args})`);
    expect(
      offenders,
      `SECURITY DEFINER functions with a MUTABLE search_path — they run as their owner and resolve names through a path the caller sets. Pin it in a forward-only migration: ALTER FUNCTION <schema>.<fn>(<args>) SET search_path = ''; (see 0114 / 0174): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the search_path rule is not vacuous: it sees the known definer functions", async () => {
    const rows = (await db.execute(sql`
      select n.nspname || '.' || p.proname as qualified
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'pii', 'ref')
        and p.prosecdef
    `)) as unknown as Array<{ qualified: string }>;

    // 10 on 2026-09-22 (9 in public, pii.caller_is_admin). Named members make a
    // broken schema filter fail here instead of passing the rule on an empty set.
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.map((r) => r.qualified)).toEqual(
      expect.arrayContaining([
        "public.can_read_case",
        "public.export_subject_data",
        "public.handle_new_user",
        "pii.caller_is_admin",
      ]),
    );
  });
});
