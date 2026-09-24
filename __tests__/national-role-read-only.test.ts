// The read-only NATIONAL role (migration 0214) — the contract, pinned.
//
// Two halves:
//   1. SCOPE — a national reads with the same universal scope as admin, decided
//      ONLY through hasNationalReadScope (never through an empty jurisdiction
//      list), and every read-side resolver honours that.
//   2. WRITES — nothing on the government slice lets a national write, and the
//      guarantee is STRUCTURAL: the read gate is not a recognised guard for
//      "use server" exports or route handlers (scripts/check-authz-guards.ts),
//      so no writer can adopt it; the write-authority gates refuse the role
//      (pinned in __tests__/auth-guards.test.ts); and the write-side scope
//      predicate (canDecideRequest) refuses it too.
//
// Pure — no DB. The SQL clause is rendered through PgDialect, the file scans
// read the repo tree the same way the fences do.

import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type GobReadRole,
  NATIONAL_READ_SCOPE_ROLES,
  hasNationalReadScope,
  isGobReadRole,
} from "@/lib/domain/jurisdiction-canonical";
import { roleLabel } from "@/lib/domain/role-labels";
import { canDecideRequest, visibleRequestsClause } from "@/lib/infra/approval-scope";
import { resolveScopedJurisdictions } from "@/lib/infra/gov-scope";
import { pathForRole } from "@/lib/infra/role-landing";
import { buildProjectionScope } from "@/lib/metrics/context";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import {
  AUTH_GUARDS,
  GUARD_HOMES,
  INSTITUTIONAL_GUARDS,
  listActionFiles,
  listRouteHandlerFiles,
} from "../scripts/check-authz-guards";
import { stripComments } from "../scripts/lib/strip-comments.mjs";

const READ_GATE = "requireGobReadAccessOrRedirect";

/**
 * WHY THE RULE BELOW STRIPS COMMENTS FIRST.
 *
 * It used to be a bare `src.includes(READ_GATE)` over the raw file, and on
 * 2026-09-11 it went red on `app/gob/senasa/export/route.ts` â a route that
 * does not call the gate and whose comment explains, at some length, WHY it
 * declines it. The fence read that explanation as the violation.
 *
 * That is not a near-miss, it is the fence testing the wrong thing. A comment
 * recording "we considered the wider gate and refused it" is the strongest
 * evidence the author got this right, and a rule that punishes it teaches the
 * next person to delete the reasoning instead of writing it down.
 *
 * THE STRIPPER IS THE REPO'S, NOT A SIXTH COPY OF IT. The first version of
 * this fix hand-rolled a two-line regex here. `scripts/lib/strip-comments.mjs`
 * already existed, already carried this exact lesson in its own header, and
 * had already absorbed five other fences that each wrote their own â two of
 * which had DIVERGED toward deleting real code.
 *
 * The hand-rolled one was not merely redundant, it was WORSE, and in the
 * direction a security fence must never fail: a plain `//` regex eats the rest
 * of any line after a `//` inside a STRING, so a `"https://â¦"` literal blanked
 * whatever followed it â including, in principle, a real call to the very gate
 * this rule exists to catch. Failing closed on a comment was the bug that
 * started this; failing OPEN on a string literal would have been the bug that
 * replaced it. The shared one keeps string contents, substitutes whitespace
 * 1:1 so reported line numbers still point at the original file, and states
 * its own known gap.
 *
 * Stripping comments only ever makes the rule LOOSER, so the rule carries a
 * floor that proves it can still fail on the two shapes that genuinely reach
 * the gate: an import and a call.
 */

// ---------------------------------------------------------------------------
// 1. Scope — decided by role, never by list emptiness
// ---------------------------------------------------------------------------

describe("hasNationalReadScope — the one place universality is decided", () => {
  it("is true for admin and national, false for govt and the personal roles", () => {
    expect(hasNationalReadScope("admin")).toBe(true);
    expect(hasNationalReadScope("national")).toBe(true);
    expect(hasNationalReadScope("govt")).toBe(false);
    expect(hasNationalReadScope("owner")).toBe(false);
    expect(hasNationalReadScope("vet")).toBe(false);
    expect(hasNationalReadScope("")).toBe(false);
    expect([...NATIONAL_READ_SCOPE_ROLES].sort()).toEqual(["admin", "national"]);
  });

  it("isGobReadRole admits exactly admin | govt | national", () => {
    const admitted = ["admin", "govt", "national"] satisfies GobReadRole[];
    for (const r of admitted) expect(isGobReadRole(r)).toBe(true);
    for (const r of ["owner", "vet", "system", ""]) expect(isGobReadRole(r)).toBe(false);
  });

  it("buildProjectionScope: national → global (like admin); govt with [] → an EMPTY jurisdictions scope, never global", () => {
    expect(buildProjectionScope({ role: "national" }, [])).toEqual({ kind: "global" });
    expect(buildProjectionScope({ role: "admin" }, [])).toEqual({ kind: "global" });
    expect(buildProjectionScope({ role: "govt" }, [])).toEqual({
      kind: "jurisdictions",
      jurisdictions: [],
    });
  });

  it("resolveScopedJurisdictions: a national's list is returned unchanged (its URL selection is a drill, not a mandate intersection)", () => {
    expect(
      resolveScopedJurisdictions({
        role: "national",
        jurisdictions: [],
        selectedProvinceName: "Buenos Aires",
        selectedLocalityName: "La Plata",
      }),
    ).toEqual([]);
    // The govt fence still narrows — and narrows to nothing outside the mandate.
    expect(
      resolveScopedJurisdictions({
        role: "govt",
        jurisdictions: [{ province: "Tierra del Fuego", locality: "Ushuaia" }],
        selectedProvinceName: "Buenos Aires",
      }),
    ).toEqual([]);
  });

  it("visibleRequestsClause: a national READS the whole approval queue (renders `true`)", () => {
    const clause = visibleRequestsClause({ id: "n-1", role: "national" }, []);
    expect(clause).toBeDefined();
    const { sql } = new PgDialect().sqlToQuery(clause as NonNullable<typeof clause>);
    expect(sql.trim()).toBe("true");
  });

  it("describeNarrowedView: a national with no drill discloses nothing; with a drill, the drilled area", () => {
    expect(describeNarrowedView({ role: "national", mandateJurisdictions: [] })).toBeNull();
    expect(
      describeNarrowedView({
        role: "national",
        mandateJurisdictions: [],
        adminProvince: "Mendoza",
        adminLocality: "Godoy Cruz",
      }),
    ).toBe("Godoy Cruz, Mendoza");
  });

  it("lands on /gob and is labelled in es-AR", () => {
    expect(pathForRole("national", {})).toBe("/gob");
    expect(roleLabel("national")).toBe("Lectura nacional");
  });
});

// ---------------------------------------------------------------------------
// 2. Writes — refused, and structurally unreachable
// ---------------------------------------------------------------------------

describe("national role — writes are refused", () => {
  it("canDecideRequest (the write-side scope predicate) refuses a national even with no jurisdiction fence to fail", () => {
    // The type already excludes "national"; the runtime check must agree, so a
    // caller that widened the type could not silently gain the decision.
    const request = {
      type: "role_upgrade_vet" as const,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    };
    const nationalAsProfile = { role: "national" } as unknown as { role: "admin" | "govt" };
    expect(canDecideRequest(nationalAsProfile, request, [])).toBe(false);
    expect(
      canDecideRequest(nationalAsProfile, request, [
        { province: "Buenos Aires", locality: "La Plata" },
      ]),
    ).toBe(false);
  });

  it("the read gate is an INSTITUTIONAL page guard with a home, and NOT a recognised guard for server actions or route handlers", () => {
    expect(INSTITUTIONAL_GUARDS).toContain(READ_GATE);
    expect(GUARD_HOMES[READ_GATE]).toEqual(["lib/infra/auth-guards.ts"]);
    // The load-bearing half: absent from AUTH_GUARDS, a "use server" export
    // that called only the read gate would be flagged as UNGUARDED by
    // lint:authz — the fence, not this test, is what keeps writers off it.
    expect(AUTH_GUARDS).not.toContain(READ_GATE);
  });

  it("no server-action module and no route handler REACHES the read gate", () => {
    const offenders: string[] = [];
    for (const rel of [...listActionFiles(), ...listRouteHandlerFiles()]) {
      if (stripComments(readFileSync(rel, "utf8")).includes(READ_GATE)) offenders.push(rel);
    }
    expect(offenders, "writers must gate on requireAdminOrGovtOrRedirect").toEqual([]);
  });

  it("the fence is not vacuous: it still catches an import of the read gate", () => {
    // The comment-stripping above only ever makes this rule LOOSER, so the
    // rule needs a floor that proves it can still fail. These are the two
    // shapes that actually reach the gate.
    expect(stripComments(`import { ${READ_GATE} } from "@/lib/infra/auth-guards";`)).toContain(
      READ_GATE,
    );
    expect(stripComments(`  const r = await ${READ_GATE}();`)).toContain(READ_GATE);
  });

  it("the fence does NOT fire on a comment that explains why the gate is refused", () => {
    // The case that made this necessary, verbatim in shape from
    // app/gob/senasa/export/route.ts: a raw `src.includes(READ_GATE)`
    // flagged a route for CORRECTLY documenting that it declines the wider gate.
    expect(
      stripComments(
        `// Deliberately NOT ${READ_GATE} — see the header.\nexport async function GET() {}`,
      ),
    ).not.toContain(READ_GATE);
    expect(stripComments(`/* never ${READ_GATE} here */\nconst x = 1;`)).not.toContain(READ_GATE);
  });
});
