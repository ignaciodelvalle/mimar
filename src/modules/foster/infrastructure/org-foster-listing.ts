// The one read behind `/org/[orgToken]/transitos` — both tabs.
//
// WHY THIS FILE EXISTS (finding A10-1, 2026-09 review)
// ---------------------------------------------------------------------------
// The page used to build its two tabs from two separate queries in `app/`, and
// only one of them was bound to the viewing organization. Review 24-15 fixed
// `activos`; `historial` stayed a different query that fetched every ended
// `role='foster'` ownership for every pet the org had EVER held. So after org
// A handed a pet to org B and B placed it with a volunteer, A's historial
// listed B's volunteer by name — an arrangement A never made, on a custody
// episode A did not hold. Both tabs now come from this one function, and the
// binding lives in `orgFosterBinding` below, so the two cannot drift apart
// again by someone editing only one of them.
//
// THE BINDING, AND WHY IT IS NOT A JOIN ON `foster_proposals`
// ---------------------------------------------------------------------------
// The review suggested joining `foster_proposals` on `resolved_ownership_id`
// with the org's id. That only sees POOL fosters: a direct assignment
// (`FosterRepository.insertAssignFoster`, the member and vecino kinds) writes
// no proposal row at all, so that join would erase an org's own history of
// every foster it assigned by hand. The binding used instead:
//
//   historial — the foster STARTED inside one of this org's ownership windows
//               for that pet: org.started_at <= foster.started_at and
//               (org.ended_at IS NULL or foster.started_at < org.ended_at).
//   activos   — the org holds the pet NOW (an open ownership window) and the
//               foster is live. Unchanged from 24-15: the current custodian
//               answers for any live foster on its animal.
//
// "Started inside the window" is the same thing as "this org placed it",
// because both doors that open a foster require the org to hold the pet in
// `shelter_custody` at that moment: `assignFoster` goes through
// `findShelterPetByToken(token, orgId)`, and `acceptFosterProposal` re-checks
// `findOrgCustodyByPetId` before it inserts the row. The start is compared,
// not an overlap of the two intervals, on purpose: a cross-org transfer ends
// the live foster and opens the receiver's window at the SAME instant, so an
// overlap test would hinge on that boundary, while the start-inside test only
// compares instants separated by human time (intake → assignment, assignment
// → hand-off).

import {
  type SQL,
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db, fosterProposals, organizationMemberships, ownerships, pets, profiles } from "@/db";

export type OrgFosterTab = "activos" | "historial";

/** How a live foster reached the pet: an accepted pool proposal, an org member, or neither. */
export type OrgFosterKind = "pool" | "member" | "vecino";

type PetRow = typeof pets.$inferSelect;

export type OrgFosterRow = {
  ownershipId: string;
  startedAt: Date;
  endedAt: Date | null;
  allowCoFoster: boolean;
  fosterDisplayName: (typeof profiles.$inferSelect)["displayName"];
  pet: Pick<PetRow, "publicToken" | "name" | "species">;
  /** Only classified on the activos tab; always null on historial. */
  kind: OrgFosterKind | null;
};

/** Historial is capped; the newest endings come first. */
export const ORG_FOSTER_HISTORY_LIMIT = 200;

// The org's own ownership rows for the same pet, correlated against the outer
// `ownerships` row (which is the foster row).
const orgWindow = alias(ownerships, "org_window");

/**
 * The predicate that ties a foster ownership row (the outer `ownerships`) to
 * the viewing organization. Exported so the test can pin it; read the file
 * header before changing it.
 */
export function orgFosterBinding(organizationId: string, tab: OrgFosterTab): SQL {
  const windowClause =
    tab === "activos"
      ? isNull(orgWindow.endedAt)
      : and(
          gte(ownerships.startedAt, orgWindow.startedAt),
          or(isNull(orgWindow.endedAt), lt(ownerships.startedAt, orgWindow.endedAt)),
        );
  return exists(
    db
      .select({ one: sql`1` })
      .from(orgWindow)
      .where(
        and(
          eq(orgWindow.petId, ownerships.petId),
          eq(orgWindow.ownerOrganizationId, organizationId),
          windowClause,
        ),
      ),
  );
}

/**
 * The foster rows `/org/[orgToken]/transitos` shows for one tab, bound to the
 * viewing organization. The caller has already authorized the viewer against
 * `organizationId` (`requireOrgAccessByToken`).
 */
export async function listOrgFosters(
  organizationId: string,
  tab: OrgFosterTab,
): Promise<OrgFosterRow[]> {
  const base = db
    .select({
      ownershipId: ownerships.id,
      startedAt: ownerships.startedAt,
      endedAt: ownerships.endedAt,
      allowCoFoster: ownerships.allowCoFoster,
      fosterUserId: profiles.id,
      fosterDisplayName: profiles.displayName,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      petSpecies: pets.species,
    })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .innerJoin(pets, eq(pets.id, ownerships.petId))
    .where(
      and(
        eq(ownerships.role, "foster"),
        tab === "activos" ? isNull(ownerships.endedAt) : isNotNull(ownerships.endedAt),
        // Art. 16: erasure soft-deletes the pet but not the ownership rows.
        isNull(pets.deletedAt),
        orgFosterBinding(organizationId, tab),
      ),
    );

  const rows =
    tab === "activos"
      ? await base.orderBy(desc(ownerships.startedAt))
      : await base.orderBy(desc(ownerships.endedAt)).limit(ORG_FOSTER_HISTORY_LIMIT);

  const kindOf = tab === "activos" ? await classifyLiveFosters(organizationId, rows) : null;

  return rows.map((r) => ({
    ownershipId: r.ownershipId,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    allowCoFoster: r.allowCoFoster,
    fosterDisplayName: r.fosterDisplayName,
    pet: { publicToken: r.petPublicToken, name: r.petName, species: r.petSpecies },
    kind: kindOf ? kindOf(r.ownershipId, r.fosterUserId) : null,
  }));
}

async function classifyLiveFosters(
  organizationId: string,
  rows: { ownershipId: string; fosterUserId: string }[],
): Promise<(ownershipId: string, fosterUserId: string) => OrgFosterKind> {
  if (rows.length === 0) return () => "vecino";

  const [pooled, memberships] = await Promise.all([
    db
      .select({ resolvedOwnershipId: fosterProposals.resolvedOwnershipId })
      .from(fosterProposals)
      .where(
        and(
          inArray(
            fosterProposals.resolvedOwnershipId,
            rows.map((r) => r.ownershipId),
          ),
          eq(fosterProposals.organizationId, organizationId),
          eq(fosterProposals.status, "accepted"),
        ),
      ),
    db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          inArray(
            organizationMemberships.userId,
            rows.map((r) => r.fosterUserId),
          ),
          eq(organizationMemberships.organizationId, organizationId),
          isNull(organizationMemberships.leftAt),
        ),
      ),
  ]);

  const pooledSet = new Set(pooled.map((p) => p.resolvedOwnershipId).filter(Boolean));
  const memberSet = new Set(memberships.map((m) => m.userId));
  return (ownershipId, fosterUserId) =>
    pooledSet.has(ownershipId) ? "pool" : memberSet.has(fosterUserId) ? "member" : "vecino";
}
