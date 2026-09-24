// Access check for /casos/[publicCode]. Mirrors what Fase F's
// `can_read_case` RLS function will enforce at the DB level — the page
// uses this helper today so the same rules are visible in app code.
//
// Returns true if the viewer can read this case. Caller treats false as
// 404 (not 403) to avoid leaking case existence to outside parties.
//
// Anonymous viewers (viewer = null, per handoff P0-1): allowed only for
// case kinds whose existence + outline is intentionally public — bite
// incidents (public-health interest), lost pet episodes (already public
// via /p/[token]) and adoption listings (already public via /adoptar).
// All other kinds 404 for anon. The page additionally redacts PII for the
// anonymous render path.
//
// welfare_denuncia used to be a fourth entry; see the note on
// PUBLIC_ANONYMOUS_KINDS for why it is gone.

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { custodyDisputeParties, db, organizationMemberships, ownerships } from "@/db";
import {
  hasNationalReadScope,
  jurisdictionScopeContains,
} from "@/lib/domain/jurisdiction-canonical";
import type { CaseDetail } from "@/lib/infra/case-queries";
import type { CaseKind } from "@/src/modules/cases/domain/case-kinds";

export interface CaseViewer {
  userId: string;
  role: "owner" | "vet" | "govt" | "admin" | "national";
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>;
}

// Case kinds whose existence + redacted outline can be shown without auth.
// Keep this list narrow — every new entry exposes a new surface to scraping
// and competing-fact harassment. Off-list kinds 404 for anon (no leak).
// `welfare_denuncia` was REMOVED from this set (legal review 2026-08-17,
// change `legal/denuncias-despublicadas`). It was here under a transparency
// rationale — "so the community can follow the institutional response" — and
// that rationale collapses on contact with what the anonymous branch of
// CaseDetailView actually renders for the kind: jurisdictionProvince,
// jurisdictionLocality and openedReason. A denuncia is an UNVERIFIED allegation
// of a crime that carries prison (Ley 14.346 art. 1) against a person who has
// not been investigated and cannot answer; locality + prose is enough to
// identify that person in a small town. Transparency about the state's response
// does not require publishing the accusation.
//
// This removal is load-bearing for the change, not incidental. Unpublishing
// /denuncias/codigo/[code] while leaving welfare_denuncia here would have shut
// the front door and left /casos/[publicCode] open on the same data — and that
// URL is not even protected by the DEN code's ~31^8 entropy.
const PUBLIC_ANONYMOUS_KINDS: ReadonlySet<CaseKind> = new Set<CaseKind>([
  "bite_incident",
  "lost_pet_episode",
  "adoption_listing",
]);

export function isPubliclyVisibleKind(kind: string): boolean {
  return PUBLIC_ANONYMOUS_KINDS.has(kind as CaseKind);
}

// Case kinds that must NEVER surface to the subject pet's owner — the owner
// is the subject of the investigation, not a party entitled to see it.
// Consumed by canReadCase's subject-owner branch AND by every app-layer
// query that lists/reads cases or case-linked events for a pet's owner
// (pet-document-redesign privacy fix, REQ-1.1/1.2). Keep this list narrow;
// today it's a single kind, but the shape is a Set so future additions
// (if any) don't require touching every call site.
export const HIDDEN_FROM_SUBJECT_CASE_KINDS: ReadonlySet<CaseKind> = new Set<CaseKind>([
  "welfare_denuncia",
]);

export function isHiddenFromSubjectKind(kind: string): boolean {
  return HIDDEN_FROM_SUBJECT_CASE_KINDS.has(kind as CaseKind);
}

/**
 * Does this user hold an ACTIVE membership in this org? The one membership
 * read every org-party branch of canReadCase makes — written once so the
 * rehome_request branch (keyed on the RECEIVER org) and the two opened_by
 * branches cannot drift apart on what "member" means (`left_at IS NULL`).
 */
export async function isActiveOrgMember(orgId: string, userId: string): Promise<boolean> {
  const [memberRow] = await db
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, orgId),
        eq(organizationMemberships.userId, userId),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .limit(1);
  return Boolean(memberRow);
}

export async function canReadCase(detail: CaseDetail, viewer: CaseViewer | null): Promise<boolean> {
  // Anonymous: allow only if the case kind is in the public allow-list.
  // The page renders a PII-redacted view; see `app/casos/[publicCode]`.
  if (!viewer) {
    return isPubliclyVisibleKind(detail.caseKind);
  }

  // Admin / national: universal READ scope (case detail is a read; every
  // mutation on a case gates separately on the write-authority guard).
  if (hasNationalReadScope(viewer.role)) return true;

  // Govt: scope-bound to jurisdiction. Subsumption-aware — a whole-province
  // assignment (e.g. whole-CABA) governs every barrio in it, so a case tagged
  // to a barrio is readable. See jurisdictionScopeContains.
  if (viewer.role === "govt") {
    const inScope = jurisdictionScopeContains(
      viewer.jurisdictions,
      detail.jurisdictionProvince,
      detail.jurisdictionLocality,
    );
    if (inScope) return true;
    // Govt out-of-scope keeps falling through to the per-kind checks
    // below — they still don't apply, so the function returns false.
    return false;
  }

  // Subject pet owner — except welfare_denuncia, where the owner is the
  // subject of the investigation and must not see the case detail.
  if (detail.pet) {
    const [ownerRow] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, detail.pet.id),
          eq(ownerships.ownerUserId, viewer.userId),
          eq(ownerships.role, "owner"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    if (ownerRow) {
      if (isHiddenFromSubjectKind(detail.caseKind)) return false;
      return true;
    }
  }

  // adoption_application — only the applicant.
  if (detail.caseKind === "adoption_application") {
    // applicantUserId lives on the case row, but it's not in the
    // CaseDetail projection. For v1 we accept the simpler check:
    // the applicant accessing their own application is a write-only
    // path today (the list page exists). When Fase F lands the SQL
    // function makes this authoritative.
    return false;
  }

  // adoption_listing — members of the opened_by org.
  if (detail.caseKind === "adoption_listing" && detail.openedByOrganization) {
    if (await isActiveOrgMember(detail.openedByOrganization.id, viewer.userId)) return true;
  }

  // rehome_request — members of the SPONSORING org (rehome-by-titular, design
  // ADR-4). openedByOrganization is null by construction: the TITULAR opens
  // this case. The sponsoring org lives in receiver_organization_id, the same
  // column the cross-org transfer accept path authorizes against. NOT the
  // live shelter_custody row: it does not exist before accept (exactly the
  // inbox window this branch is for) and it is closed after a withdraw (when
  // the org must still read the case it worked on).
  if (detail.caseKind === "rehome_request" && detail.receiverOrganization) {
    if (await isActiveOrgMember(detail.receiverOrganization.id, viewer.userId)) return true;
  }

  // foster_placement — the active foster on the pet OR org-side members
  // of the opened_by org.
  if (detail.caseKind === "foster_placement" && detail.pet) {
    const [fosterRow] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, detail.pet.id),
          eq(ownerships.ownerUserId, viewer.userId),
          eq(ownerships.role, "foster"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    if (fosterRow) return true;
    if (detail.openedByOrganization) {
      if (await isActiveOrgMember(detail.openedByOrganization.id, viewer.userId)) return true;
    }
  }

  // custody_dispute — registered parties. The party model is POLYMORPHIC by
  // construction: migration 0025's `dispute_party_exactly_one_subject` CHECK
  // says a row names EITHER a user OR an organization, never both. Both shapes
  // are real counter-parties to the same dispute, so both read the case.
  if (detail.caseKind === "custody_dispute" && detail.custodyDispute) {
    const [partyRow] = await db
      .select({ id: custodyDisputeParties.id })
      .from(custodyDisputeParties)
      .where(
        and(
          eq(custodyDisputeParties.disputeId, detail.custodyDispute.id),
          eq(custodyDisputeParties.partyUserId, viewer.userId),
        ),
      )
      .limit(1);
    if (partyRow) return true;

    // Org-side parties. This branch closes a DRIFT, not a policy gap: the SQL
    // `can_read_case` this file mirrors has carried the org arm since migration
    // 0034 (`cdp.party_organization_id in (select ... where left_at is null)`,
    // mirrored in db/cases_rls.sql) — only this TypeScript mirror was user-only. It
    // stopped being harmless on 2026-09-04, when submit-claim-dispute began
    // filing a shelter that holds the pet as `current_org_custody` with
    // party_organization_id AND notifying that org's members with a link to
    // /casos/<code>. Every one of those notifications landed on notFound().
    //
    // `isActiveOrgMember` is reused verbatim so this cannot drift from the
    // adoption_listing / rehome_request / foster_placement branches on what a
    // member IS (`left_at IS NULL`) — an ex-member of a party org is a stranger.
    const orgPartyRows = await db
      .select({ organizationId: custodyDisputeParties.partyOrganizationId })
      .from(custodyDisputeParties)
      .where(
        and(
          eq(custodyDisputeParties.disputeId, detail.custodyDispute.id),
          isNotNull(custodyDisputeParties.partyOrganizationId),
        ),
      );
    const partyOrgIds = new Set(
      orgPartyRows
        .map((row) => row.organizationId)
        .filter((id): id is string => typeof id === "string"),
    );
    for (const orgId of partyOrgIds) {
      if (await isActiveOrgMember(orgId, viewer.userId)) return true;
    }
  }

  return false;
}

/**
 * Does this viewer hold an ACTIVE `caretaker` ownership row on this pet?
 *
 * NOT an access check — it is the opposite. `canReadCase` has already said no,
 * and this answers the follow-up question the caller needs before deciding HOW
 * to say no: "is this a stranger, or the person currently caring for the
 * animal?"
 *
 * WHY THE DISTINCTION IS WORTH A QUERY. Case reads are titular-only by design
 * (design F2, accepted by the PO for v1): `can_read_case` grants the
 * subject-pet branch on `role='owner'`, and widening a SECURITY DEFINER
 * function that also governs welfare denuncias is a separate decision. But the
 * caretaker SEES the case links — LostCaseBlock and the open-case badges render
 * on the pet they are looking after — and every one of them used to land on
 * notFound(). Telling somebody caring for an animal that its case does not
 * exist is a lie with nothing on the other side of it. With this, the page can
 * render the real answer: not available to caretakers, and here is what you can
 * still do.
 *
 * `ended_at IS NULL` is load-bearing: once the arrangement closes the person is
 * a stranger again and gets the ordinary 404.
 */
export async function holdsActiveCaretakerRow(
  petId: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!petId || !userId) return false;
  const [row] = await db
    .select({ id: ownerships.id })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.ownerUserId, userId),
        eq(ownerships.role, "caretaker"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}
