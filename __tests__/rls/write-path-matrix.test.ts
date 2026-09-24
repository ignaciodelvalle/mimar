// RLS WRITE-PATH matrix fitness test (regression armor — capstone readiness gap).
// ============================================================================
//
// STRUCTURAL GUARANTEE (writes): no RLS-enabled `public` table exposes an
// UNCONDITIONAL write (INSERT / UPDATE / DELETE) to the `anon` or
// `authenticated` PostgREST roles — i.e. deny-all holds for WRITES, not just
// reads. This COMPLEMENTS coverage.test.ts, which proves RLS is ENABLED
// (relrowsecurity = true) but says nothing about whether the write policies on
// top of it are safely scoped.
//
// WHY THIS MATTERS: coverage.test.ts closes the "PII table shipped with RLS
// disabled" hole. But a table can have RLS enabled AND still be wide open if a
// permissive write policy is added with `WITH CHECK (true)` / `USING (true)`
// and granted to `anon` / `authenticated` / `public`. That is a write breach
// through the supabase-js anon/publishable-key PostgREST surface — the exact
// channel the app's BYPASSRLS Drizzle connection never governs. This test is
// the tripwire that turns a new unconditional write policy into a red CI run.
//
// HEURISTIC (pure catalog introspection — same pattern as coverage.test.ts):
//   For every PERMISSIVE write policy (cmd ∈ INSERT/UPDATE/DELETE/ALL) on an
//   RLS-enabled public table, the policy is UNSAFE if BOTH:
//     (a) it is reachable by a low-trust role — its `roles` array includes
//         `anon`, `authenticated`, or `public`; AND
//     (b) its gating clause is UNCONDITIONAL — trivially `true` or absent:
//           · INSERT → WITH CHECK          · DELETE → USING
//           · UPDATE → USING (row-selection gate; `true` = target ANY row)
//           · ALL    → USING
//   A scoped policy (clause references `auth.uid()`, `organization_id`, an
//   ownerships subquery, etc.) is SAFE: `anon` has a NULL `auth.uid()` so a
//   `user_id = auth.uid()` check can never pass for it, and `authenticated`
//   users are pinned to their own rows.
//
// HOW TO SATISFY A FAILURE: a NEW unconditional anon/authenticated write policy
// is almost always a bug — scope it (add an `auth.uid()` / tenant predicate in
// the migration). If the open write is GENUINELY intentional (a public intake
// surface), add `${table}.${cmd}` to INTENTIONAL_UNCONDITIONAL_WRITES below
// with a reason — do NOT weaken the assertion.

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

// ---------------------------------------------------------------------------
// Deliberately-open write surfaces — public intake by design. Each entry is a
// `${table}.${cmd}` key with the justification a reviewer must consciously add.
// These are the ONLY tables allowed to accept an unconditional anon/auth write.
// ---------------------------------------------------------------------------
const INTENTIONAL_UNCONDITIONAL_WRITES: Readonly<Record<string, string>> = {
  // welfare_reports.INSERT vivía acá hasta la migración 0173. La justificación
  // era falsa en su premisa: decía que "the public 5-step wizard submits with no
  // account (createWelfareReportAction path)" y que "WITH CHECK (true) is the
  // point". El wizard NO escribe por PostgREST — llama a una server action que
  // inserta por Drizzle con BYPASSRLS (welfare-repository.ts:120). La policy no
  // habilitaba al ciudadano: habilitaba a cualquiera con la anon key a saltear
  // rate-limit, honeypot, dwell-time, strip de EXIF y auto-flag, y a spoofear
  // reporter_user_id. Ver 0173 para el detalle.
  //
  // Este test es el que avisó que la excepción quedaba obsoleta al dropear la
  // policy — funcionó exactamente como está diseñado.
  // pets.INSERT vivió acá hasta la migración 0175. Su justificación —"una fila
  // recién insertada no tiene PII ni ownership, así que es inerte"— hablaba del
  // DAÑO, no del USO: nunca dijo que la app la necesitara. Cuando la defensa de
  // una apertura describe por qué no duele en vez de quién la usa, casi siempre
  // es que no la usa nadie.
  //
  // Medido antes de borrarla: el cliente de browser se usa en 4 archivos y los
  // cuatro sólo suben a storage; los tres caminos de alta escriben por Drizzle;
  // ni e2e ni rls-smoke insertan en pets. Y matrix.data.ts YA declaraba
  // `deny` para el INSERT de pets en los cuatro roles — la policy contradecía
  // una intención que el repo tenía escrita, sin que nada lo cazara porque
  // OPERATIONS_UNDER_TEST sólo probaba `select` (desde T3-F1 prueba también
  // insert y update).
  //
  // La allowlist quedó VACÍA a propósito. Si algún día vuelve a tener una
  // entrada, que sea porque alguien pudo escribir qué la usa, no por qué no
  // duele.
};

// ---------------------------------------------------------------------------
// Types + introspection
// ---------------------------------------------------------------------------

type WritePolicyRow = {
  tablename: string;
  policyname: string;
  cmd: string; // INSERT | UPDATE | DELETE | ALL
  roles: string; // comma-joined role names, e.g. "anon,authenticated"
  qual: string | null; // USING expression (NULL when absent)
  with_check: string | null; // WITH CHECK expression (NULL when absent)
};

const LOW_TRUST_ROLES = new Set(["anon", "authenticated", "public"]);

/** All PERMISSIVE write policies on RLS-enabled public base tables. */
async function writePolicies(): Promise<WritePolicyRow[]> {
  return (await db.execute(sql`
    select
      p.tablename                     as tablename,
      p.policyname                    as policyname,
      p.cmd                           as cmd,
      array_to_string(p.roles, ',')   as roles,
      p.qual                          as qual,
      p.with_check                    as with_check
    from pg_policies p
    join pg_class c     on c.relname = p.tablename
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where p.schemaname = 'public'
      and c.relkind = 'r'
      and c.relrowsecurity = true
      and p.permissive = 'PERMISSIVE'
      and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  `)) as unknown as WritePolicyRow[];
}

/** A clause is "unconditional" when it is absent or trivially `true`. */
function isUnconditional(clause: string | null): boolean {
  if (clause === null || clause === undefined) return true;
  return clause.trim().toLowerCase() === "true";
}

/** The gating clause that decides whether the role can effect the write. */
function gatingClause(row: WritePolicyRow): string | null {
  switch (row.cmd) {
    case "INSERT":
      return row.with_check;
    // DELETE/UPDATE/ALL are gated on row selection (USING). For UPDATE, a
    // trivially-true USING means the role can target ANY row — that is the hole
    // even if WITH CHECK narrows the written values.
    default:
      return row.qual;
  }
}

function isLowTrustReachable(row: WritePolicyRow): boolean {
  return row.roles
    .split(",")
    .map((r) => r.trim())
    .some((r) => LOW_TRUST_ROLES.has(r));
}

type Offender = WritePolicyRow & { key: string };

function findUnsafeWrites(rows: WritePolicyRow[]): Offender[] {
  const out: Offender[] = [];
  for (const row of rows) {
    if (!isLowTrustReachable(row)) continue;
    if (!isUnconditional(gatingClause(row))) continue;
    out.push({ ...row, key: `${row.tablename}.${row.cmd}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RLS write-path matrix (deny-all holds for writes)", () => {
  it("introspects a non-empty RLS-enabled write surface (guards against a silent no-op)", async () => {
    const rows = await writePolicies();
    // Sanity: if this is empty the join is wrong / DB is unseeded, which would
    // make every assertion below vacuously pass. The stack ships dozens of
    // write policies on RLS-enabled tables.
    expect(rows.length, "expected write policies on RLS-enabled public tables").toBeGreaterThan(0);
  });

  it("no RLS-enabled table exposes an UNCONDITIONAL anon/authenticated write outside the allowlist", async () => {
    const offenders = findUnsafeWrites(await writePolicies());
    const unexpected = offenders.filter((o) => !(o.key in INTENTIONAL_UNCONDITIONAL_WRITES));

    const detail = unexpected
      .map(
        (o) =>
          `${o.tablename}.${o.cmd} (policy "${o.policyname}", roles={${o.roles}}) — unconditional gate; scope it in a migration or add "${o.key}" to INTENTIONAL_UNCONDITIONAL_WRITES with a reason.`,
      )
      .join("\n");

    expect(
      unexpected,
      `Unscoped anon/authenticated write policies (P0 write breach):\n${detail}`,
    ).toEqual([]);
  });

  it("every allowlisted open write still corresponds to a real unconditional policy (no stale exceptions)", async () => {
    const offenders = findUnsafeWrites(await writePolicies());
    const liveKeys = new Set(offenders.map((o) => o.key));

    const stale = Object.keys(INTENTIONAL_UNCONDITIONAL_WRITES).filter((k) => !liveKeys.has(k));
    expect(
      stale,
      `Allowlist entries with no matching unconditional write policy anymore — the policy was scoped or removed, so delete the stale exception: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("allowlisted open writes carry a non-empty justification", () => {
    const undocumented = Object.entries(INTENTIONAL_UNCONDITIONAL_WRITES)
      .filter(([, reason]) => !reason || reason.trim().length === 0)
      .map(([key]) => key);
    expect(undocumented, `Allowlisted writes missing a reason: ${undocumented.join(", ")}`).toEqual(
      [],
    );
  });
});
