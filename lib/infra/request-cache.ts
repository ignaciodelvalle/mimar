// Per-request memoized reads using React.cache().
//
// React.cache() de-duplicates identical calls within a single server-render
// pass. It is safe ONLY for reads — never cache mutations or functions whose
// result must change within the same request after a revalidation. The cache
// is automatically discarded at the end of each request; there is no cross-
// request leakage.
//
// Column contract (getProfileCached):
//   The selected columns are the UNION of every column shape used by auth
//   guards, layouts, and per-request page gate checks:
//     id            — required by requireAdminOrGovtOrRedirect, requireAdminOrRedirect
//     role          — required by every layout + guard
//     displayName   — required by every layout nav bar
//     accountType   — required by requireAdminOrRedirect (institutional check)
//     deactivatedAt — required by requireAdminOrRedirect (active check)
//
//   Pages that need additional columns (phone, avatarUrl, dniVerified, etc.)
//   for display purposes — e.g. /cuenta, /cuenta/editar — keep their own
//   targeted selects. Those pages fetch ONCE and are not part of the 220-
//   call per-sweep churn documented in PERF-2.

// NOTE: deliberately NO `import "server-only"` here. The seed and bootstrap
// scripts (tsx, outside the Next.js bundler) import action writers that reach
// this module through lib/auth-guards — "server-only" throws unconditionally
// in that context (see scripts/seed-test-users.ts header for the same
// constraint). Outside a React render pass, cache() simply doesn't memoize;
// the queries still run correctly. Never import this module from client code.

import { cache } from "react";

import { and, count, eq, isNull, ne } from "drizzle-orm";

import {
  db,
  govtAssignments,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
  profiles,
} from "@/db";
import type { Organization, OrganizationMembership, UserRole } from "@/db";
import { type OrgQueueKey, fetchOrgQueueCounts } from "@/lib/analytics/org-dashboard";
import {
  excludeResolvedLostEpisodeSql,
  excludeStaleWelcomeSql,
} from "@/lib/infra/notification-reconcile";

// ---------------------------------------------------------------------------
// Profile — canonical per-request read
// ---------------------------------------------------------------------------

export type CachedProfile = {
  id: string;
  role: UserRole;
  displayName: string;
  accountType: "personal" | "institutional";
  deactivatedAt: Date | null;
  // Soft-delete marker set by erase_subject_data (Ley 25.326 art. 16). A
  // non-null value means the account was erased at the subject's request: its
  // PII is hashed/nulled and it must NOT be able to authenticate any longer
  // (requireUserOrRedirect bounces it to /login). Distinct from deactivatedAt,
  // which is the institutional-account admin deactivation flag.
  deletedAt: Date | null;
};

/**
 * Cached profile read: union of all per-request column shapes.
 * One DB round-trip per user per render pass — layout, guard, and page all
 * share the same memoized result.
 */
export const getProfileCached = cache(async (userId: string): Promise<CachedProfile | null> => {
  const [row] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      displayName: profiles.displayName,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
      deletedAt: profiles.deletedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row ?? null;
});

// ---------------------------------------------------------------------------
// Jurisdictions — active govt_assignments for a user
// ---------------------------------------------------------------------------

export type CachedJurisdiction = { province: string; locality: string };

/**
 * Cached active-jurisdictions read. Empty array for non-govt / no assignments.
 */
export const getJurisdictionsCached = cache(
  async (userId: string): Promise<CachedJurisdiction[]> => {
    const rows = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
    return rows;
  },
);

// ---------------------------------------------------------------------------
// Org membership by token — org layout + every org page guard share this
// ---------------------------------------------------------------------------

export type CachedOrgMembership = {
  organization: Organization;
  membership: OrganizationMembership;
};

/**
 * Cached org-membership lookup by (orgToken, userId). Returns null when the
 * org does not exist or the user has no active membership. Callers decide
 * the 404 / redirect policy; this helper just caches the read.
 */
export const getOrgMembershipCached = cache(
  async (orgToken: string, userId: string): Promise<CachedOrgMembership | null> => {
    const [row] = await db
      .select({ organization: organizations, membership: organizationMemberships })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizations.publicToken, orgToken),
          isNull(organizationMemberships.leftAt),
        ),
      )
      .limit(1);
    return row ?? null;
  },
);

// ---------------------------------------------------------------------------
// Org memberships — citizen context-switcher enumeration (D6, Item 7)
// ---------------------------------------------------------------------------

export type CachedOrgMembershipSummary = { token: string; name: string };

/**
 * Cached enumeration of the orgs a user is an active member of, for the citizen
 * context-switcher (D6). Returns the org public token + display name only —
 * enough for the switcher to render "hop to org" destinations. Capability
 * checks stay in the org layout; this is purely the membership list.
 *
 * One indexed read on organization_memberships (joined to organizations),
 * filtered to active memberships (leftAt IS NULL). Memoized per request so the
 * citizen masthead and any sibling consumer share a single round-trip.
 */
export const getOrgMembershipsCached = cache(
  async (userId: string): Promise<CachedOrgMembershipSummary[]> => {
    const rows = await db
      .select({
        token: organizations.publicToken,
        name: organizations.displayName,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(
        and(eq(organizationMemberships.userId, userId), isNull(organizationMemberships.leftAt)),
      );
    return rows;
  },
);

// ---------------------------------------------------------------------------
// Unread notifications count — (app)/layout + /inicio share this
// ---------------------------------------------------------------------------

/**
 * Cached unread-notifications count. Layout and /inicio page both render in
 * the same pass; without caching they issue identical COUNT queries.
 *
 * Must apply the SAME reconciliation predicate as every other owner-inbox
 * read (fetchUnreadNotifications/fetchUnreadNotificationCount in
 * lib/analytics/owner-dashboard.ts, and the /notificaciones page itself) —
 * excludeResolvedLostEpisodeSql + excludeStaleWelcomeSql. Before this fix the
 * masthead bell badge counted raw (readAt IS NULL, archivedAt IS NULL) rows
 * without reconciling against current pet/ownership state, so a stale
 * `welcome` notification (owner already has an active pet) or a resolved
 * lost-episode alert inflated the badge to a number the /notificaciones page
 * — which DOES reconcile — could never actually show, producing "badge says
 * 1, page shows 0" (sweep-fixes-2 2026-07-23).
 */
export const getUnreadCountCached = cache(async (userId: string): Promise<number> => {
  const [{ unreadCount }] = await db
    .select({ unreadCount: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.archivedAt),
        excludeResolvedLostEpisodeSql,
        excludeStaleWelcomeSql,
      ),
    );
  return unreadCount;
});

// ---------------------------------------------------------------------------
// Owned-pets count — (app)/layout needs it to pick the tab-bar capture slot
// ---------------------------------------------------------------------------

/**
 * Cached count of the LIVE pets a user currently owns (active ownership AND the
 * pet not deceased).
 *
 * Why the layout pays for this (D.8, 2026-07-30): the citizen tab bar's centre
 * slot said "Asentar" and pointed at `/inicio?sheet=anotar`. With ZERO pets
 * `/inicio` redirects to `/mis-mascotas`, where `?sheet=anotar` is inert — so
 * the owner's primary action was a SILENT NO-OP for exactly the first-run user
 * who most needs it. Picking the right slot needs a has-pets signal, and the
 * layout had none: it reads profile, unread notifications and org memberships,
 * none of which touch `ownerships`/`pets`. The one existing indexed count that
 * would have served (`fetchPetsForOwner`) is dead in production since the
 * `/inicio` P5 fold. So this is the documented, PO-accepted cost: ONE indexed
 * count per request, on `ownerships_owner_user_id_idx`.
 *
 * CACHE KEY CONTRACT — `userId` ONLY. `React.cache()` keys on argument
 * identity/value (see `getOrgQueueCountsCached` above for the array-arg trap),
 * so a future caller that passes anything extra — an options object, a filter,
 * a "includeDeceased" flag — creates a SECOND cache entry and a second
 * round-trip in the same render pass. Any variant that needs different
 * filtering gets its OWN helper; do not widen this signature.
 *
 * Deliberately NOT the same query as the `/mis-mascotas` index count
 * (`page.tsx`), which joins `pets` and applies the name-search filter: that one
 * answers "how many match the search", this one answers "does this user own any
 * LIVE pet at all". Same index, different question.
 *
 * WHY THE `pets` JOIN, added in the pre-push review of D.8 (2026-07-30): DEATH
 * DOES NOT END AN OWNERSHIP. No code path sets `ownerships.ended_at` when a pet
 * dies — `ended_at` marks transfers and relinquishments, and In memoriam is
 * deliberately still YOUR pet. So an active-ownerships-only count returned >= 1
 * for an owner whose only pet had died, the tab bar rendered "Asentar", and
 * `/inicio?sheet=anotar` redirected to `/mis-mascotas` with an inert sheet —
 * the exact silent no-op D.8 exists to remove, landing on a grieving owner.
 *
 * THE PREDICATE IS `/inicio`'s, not a third variant: `fetchLivePetsForCarouselRanking`
 * (lib/analytics/owner-dashboard.ts) selects active ownership + `ne(pets.status,
 * 'deceased')`, and `/inicio` redirects to `/mis-mascotas` exactly when that
 * returns []. This is the COUNT of the same set, so the tab-bar slot and the
 * destination it points at can never disagree. Coherent with `/mis-mascotas`,
 * which already branches on `hasAnyOwned`: an owner with only deceased pets gets
 * no "no pets" box (the In memoriam section carries them) and now also gets the
 * "Registrar mascota" slot instead of a dead-end capture link.
 *
 * Still ONE indexed count: the join is on `pets.id` (primary key) from the same
 * `ownerships_owner_user_id_idx` scan.
 */
export const getOwnedPetsCountCached = cache(async (userId: string): Promise<number> => {
  const [row] = await db
    .select({ n: count() })
    .from(ownerships)
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
        ne(pets.status, "deceased"),
      ),
    );
  return Number(row?.n ?? 0);
});

// ---------------------------------------------------------------------------
// Org queue counts — org layout (nav badges) + org dashboard page ("Pendientes")
// share this (adversarial review 2026-07-10, MED 11)
// ---------------------------------------------------------------------------

/**
 * Cached org-queue-counts read, memoized per request by (orgId, key set).
 * The org layout (nav badges) and the org dashboard page (the "Pendientes"
 * card) both fetch `fetchOrgQueueCounts` for the SAME org within one render
 * pass — every org home paint used to issue the batched query twice.
 *
 * `React.cache()` keys on argument identity/value, not deep-equality of
 * object args, so the key list is threaded through as a stable, sorted,
 * comma-joined string (see `orgQueueCacheKey`) rather than an array — two
 * `OrgQueueKey[]` instances with identical contents but different identities
 * (layout builds its own array, the page builds its own) must still hit the
 * SAME cache entry. Both callers pass the full `applicableOrgQueues` result
 * for the org (not a further-filtered subset) so their cache keys always
 * agree; the layout filters the returned record down to badge-eligible
 * queues locally, after the shared fetch.
 */
export const getOrgQueueCountsCached = cache(
  async (orgId: string, sortedKeysJoined: string): Promise<Record<OrgQueueKey, number | null>> => {
    const keys = sortedKeysJoined.length > 0 ? (sortedKeysJoined.split(",") as OrgQueueKey[]) : [];
    return fetchOrgQueueCounts(orgId, keys);
  },
);

/** Stable, order-independent cache-key string for a list of org queue keys. */
export function orgQueueCacheKey(keys: readonly OrgQueueKey[]): string {
  return Array.from(new Set(keys)).sort().join(",");
}
