// Server-only: this module queries the DB. A client import is a hard build error.
import "server-only";

// lib/infra/surface-visits.ts — per-user "have you been here" watermark
// (migration 0244, table user_surface_visits).
//
// Shared infra for the /gob first-run onboarding checklist (T4-O3,
// docs/plans/gob-onboarding-scoping.md): G1/G2/G4 each ask "has this operator
// ever visited surface X", and the scoping doc asks for ONE table backing all
// three instead of three bespoke ones (same idea as operator_feed_watermarks,
// generalized to more than one surface).
//
// UNLIKE operator_feed_watermarks, a surface visit is recorded AUTOMATICALLY
// on render — there is no "mark as seen" button, because the fact being
// tracked ("have you ever opened this screen") has nothing to acknowledge.
// Callers MUST read (hasVisitedSurfaces) BEFORE recording the current visit
// (recordSurfaceVisit) — reading after writing would make every surface
// permanently report "visited" from its very first render, which is the
// bug S3-F04 already taught this codebase once on the org-checklist side
// (see org-setup-checklist.ts's hasEverHeldAnimal note) in a different shape:
// here the failure mode is a checklist step that can never be seen pending.

import { and, eq, inArray } from "drizzle-orm";

import { db, userSurfaceVisits } from "@/db";

/**
 * The surfaces the gob-onboarding checklist currently tracks. Not exhaustive
 * of every possible surface the table could hold — new callers may pass any
 * string (the column has no CHECK/enum, see migration 0244) — but every
 * caller in THIS feature reads through this closed set so a typo in a surface
 * key fails at compile time instead of silently never matching.
 */
export const GOB_ONBOARDING_SURFACES = ["gob_home", "panorama", "casos", "cola"] as const;
export type GobOnboardingSurface = (typeof GOB_ONBOARDING_SURFACES)[number];

/**
 * Returns the subset of `surfaces` the user has EVER visited before this
 * call (i.e. rows that already existed). Callers must call this BEFORE
 * `recordSurfaceVisit` for the current request's surface — see module header.
 */
export async function hasVisitedSurfaces(
  userId: string,
  surfaces: readonly GobOnboardingSurface[],
): Promise<Set<GobOnboardingSurface>> {
  if (surfaces.length === 0) return new Set();
  const rows = await db
    .select({ surface: userSurfaceVisits.surface })
    .from(userSurfaceVisits)
    .where(
      and(eq(userSurfaceVisits.userId, userId), inArray(userSurfaceVisits.surface, [...surfaces])),
    );
  return new Set(rows.map((r) => r.surface as GobOnboardingSurface));
}

/**
 * Records a visit to `surface` for `userId` — an upsert: `first_visited_at`
 * is set only on insert (DEFAULT now(), untouched on conflict); `last_seen_at`
 * advances every time. Best-effort: swallows its own errors so a write
 * hiccup here can never fail (or slow down the render path of) the page that
 * called it — the checklist step just stays pending one render longer, which
 * is the honest outcome of not knowing whether the visit was recorded.
 */
export async function recordSurfaceVisit(
  userId: string,
  surface: GobOnboardingSurface,
): Promise<void> {
  const now = new Date();
  try {
    await db
      .insert(userSurfaceVisits)
      .values({ userId, surface, firstVisitedAt: now, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [userSurfaceVisits.userId, userSurfaceVisits.surface],
        set: { lastSeenAt: now },
      });
  } catch {
    // Best-effort — see doc comment above.
  }
}
