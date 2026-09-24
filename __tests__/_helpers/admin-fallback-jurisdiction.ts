// The jurisdiction the ADMIN-FALLBACK suites use, and the precondition they all
// silently depended on until 2026-08-26.
//
// WHAT THE PREMISE IS
// ---------------------------------------------------------------------------
// `findAuthoritiesForJurisdiction` is GOVT-FIRST: if any active
// `govt_assignments` row covers the (province, locality) being routed, it
// returns those govts and the admin fallback NEVER FIRES. So every test that
// asserts "the admin got the authority notification" is really asserting a
// global absence — that nobody, anywhere in the database, holds an assignment
// covering this jurisdiction.
//
// That is a fragile thing to depend on and it has now broken twice:
//
//   · CABA/Balvanera and CABA/Belgrano stopped working when the demo seed gave
//     Lucas the whole East region. Both suites were moved to Mendoza/Bowen and
//     each left a comment saying "move this again if that changes".
//   · Mendoza/Bowen then broke too, and NOT because of a seed. `admin-decisions
//     .test.ts` gives its govt fixture a WHOLE-PROVINCE Mendoza assignment
//     (`WHOLE_PROVINCE_LOCALITY.Mendoza`) inside a test body, cleaned up only at
//     file teardown. When a worker dies before that teardown — two workers died
//     in the run that surfaced this — the row survives, and from then on every
//     run of these suites fails until something happens to clean it.
//
// WHY THE FAILURE WAS SO HARD TO READ. The victims fail with `expected 0 to be
// greater than 0` on a notification count, which looks like broken routing or a
// broken fixture in the suite that failed. Nothing points at the real cause,
// which is a row left behind by a DIFFERENT file. Three assertions across two
// files failed together for days and were logged as flakes.
//
// WHAT THIS MODULE DOES ABOUT IT
// ---------------------------------------------------------------------------
//   1. ONE DEFINITION of the jurisdiction, so the two suites cannot drift onto
//      different localities and lose the shared reason they were chosen. They
//      had `"Mendoza"` / `"Bowen"` typed out separately, with two paragraphs of
//      identical reasoning in two files.
//   2. `assertAdminFallbackAvailable()` — the precondition, CHECKED. A suite
//      calls it in `beforeAll`, and if the premise is broken the failure names
//      the real cause and the row that caused it, instead of a notification
//      count that mentions nothing.
//
// It deliberately does NOT delete the offending row. A helper that quietly
// revoked another suite's fixture would be the same class of cross-file
// mutation that caused this, and it would hide the leak instead of reporting
// it. The assertion's job is to make the cause legible; fixing the leak is the
// leaking file's job (see the `try/finally` in `admin-decisions.test.ts`).

import { and, eq, isNull } from "drizzle-orm";

import { db, govtAssignments, profiles } from "@/db";
import { localitiesCoveringSearch } from "@/lib/domain/jurisdiction-canonical";

/**
 * A jurisdiction no govt operator holds, for the suites that test the
 * admin-fallback path.
 *
 * STILL Mendoza/Bowen. Relocating again was the obvious move and it is the one
 * thing this file exists to stop: the previous two relocations each fixed the
 * symptom for a while and left the next author the same trap. What changes here
 * is that the premise is now checked, so the third break — whenever it comes,
 * and from wherever — announces itself instead of looking like a routing bug.
 */
export const ADMIN_FALLBACK_JURISDICTION = {
  province: "Mendoza",
  locality: "Bowen",
} as const;

/**
 * Fails the calling suite if any active assignment covers the fallback
 * jurisdiction, naming what holds it.
 *
 * COVERAGE IS NOT EQUALITY. `localitiesCoveringSearch` expands a locality to the
 * set of assignment localities that reach it, which includes the WHOLE-PROVINCE
 * SENTINEL — so a row scoped to "all of Mendoza" covers Bowen without ever
 * mentioning it. The leak that prompted this module was exactly that shape, and
 * a check written as `locality = 'Bowen'` would have missed it completely.
 */
export async function assertAdminFallbackAvailable(): Promise<void> {
  const covering = localitiesCoveringSearch(
    ADMIN_FALLBACK_JURISDICTION.province,
    ADMIN_FALLBACK_JURISDICTION.locality,
  );

  const holders = await db
    .select({
      assignmentId: govtAssignments.id,
      userId: govtAssignments.userId,
      locality: govtAssignments.jurisdictionLocality,
      displayName: profiles.displayName,
    })
    .from(govtAssignments)
    .leftJoin(profiles, eq(profiles.id, govtAssignments.userId))
    .where(
      and(
        eq(govtAssignments.jurisdictionProvince, ADMIN_FALLBACK_JURISDICTION.province),
        isNull(govtAssignments.revokedAt),
      ),
    );

  const blocking = holders.filter((h) => covering.includes(h.locality ?? ""));
  if (blocking.length === 0) return;

  const described = blocking
    .map(
      (h) =>
        `  · assignment ${h.assignmentId} → ${h.displayName ?? h.userId} scoped to ` +
        `"${h.locality === "" ? "(toda la provincia)" : h.locality}"`,
    )
    .join("\n");

  throw new Error(
    [
      "This suite asserts the ADMIN-FALLBACK path, which requires that NO govt covers",
      `${ADMIN_FALLBACK_JURISDICTION.province}/${ADMIN_FALLBACK_JURISDICTION.locality}.`,
      `${blocking.length} active assignment(s) cover it right now:`,
      described,
      "",
      "findAuthoritiesForJurisdiction is govt-first, so the fallback cannot fire and",
      'every admin-notification assertion below would fail with a bare "expected 0".',
      "",
      "This is almost always a LEAKED FIXTURE from another test file rather than a seed:",
      "admin-decisions.test.ts scopes its govt fixture to the whole of Mendoza. It now",
      "revokes it in a `finally`, but a worker that dies mid-test still strands the row.",
      "Delete the assignment above (or re-run that suite to completion) and this suite",
      "goes green again.",
    ].join("\n"),
  );
}
