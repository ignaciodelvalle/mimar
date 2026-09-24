// canReadCase — the branches that do NOT need a pet or a case row on disk.
//
// Anonymous branch (handoff P0-1). Verifies that:
//   - anon viewer (null) gets true for kinds in PUBLIC_ANONYMOUS_KINDS
//   - anon viewer gets false for every other kind → page surfaces notFound
//   - admin viewer always gets true (regression guard, no behavior change)
//
// custody_dispute party branch (2026-09-04). Verifies that BOTH shapes of a
// registered party read the case: the user-side row and — new — an active
// member of an organization filed as `party_organization_id`. That half hits
// REAL POSTGRES on purpose: it is a join over custody_dispute_parties and
// organization_memberships with a lifecycle filter (`left_at IS NULL`), which
// is exactly the shape a mock gets wrong. See the block near the bottom.

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  custodyDisputeParties,
  custodyDisputes,
  db,
  organizationMemberships,
  organizations,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { canReadCase, isPubliclyVisibleKind } from "@/lib/infra/case-access";
import type { CaseDetail } from "@/lib/infra/case-queries";
import { CASE_KINDS, type CaseKind } from "@/src/modules/cases/domain/case-kinds";

import { withMutationOverride } from "./_helpers/db-overrides";

const ANON = null;
const ADMIN = {
  userId: "00000000-0000-0000-0000-000000000001",
  role: "admin" as const,
  jurisdictions: [],
};

function fixtureDetail(kind: CaseKind, overrides: Partial<CaseDetail> = {}): CaseDetail {
  // Minimal CaseDetail — canReadCase only touches caseKind for the anon
  // and admin branches under test. The owner/foster branches do DB joins over
  // `ownerships`; those are covered elsewhere. The dispute branch keys on
  // `custodyDispute.id` alone, so the block at the bottom of this file passes a
  // real dispute id through `overrides` and seeds only the joined tables.
  return {
    id: "fixture-id",
    publicCode: "CAS-TEST-0001",
    caseKind: kind,
    status: "open",
    closedReason: null,
    supersededByCaseId: null,
    primarySubjectKind: "registered_pet",
    pet: null,
    primaryLocationLat: null,
    primaryLocationLng: null,
    jurisdictionCountry: "AR",
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    openedAt: new Date(),
    openedByUser: null,
    openedByOrganization: null,
    closedByUser: null,
    closedAt: null,
    openedReason: null,
    custodyDispute: null,
    events: [],
    ...overrides,
  } as unknown as CaseDetail;
}

const PUBLIC_KINDS: CaseKind[] = ["bite_incident", "lost_pet_episode", "adoption_listing"];

describe("canReadCase — anonymous branch (P0-1)", () => {
  it("returns true for every kind in the public allow-list", async () => {
    for (const kind of PUBLIC_KINDS) {
      const ok = await canReadCase(fixtureDetail(kind), ANON);
      expect(ok, `${kind} should be publicly visible`).toBe(true);
    }
  });

  it("returns false for every kind NOT in the public allow-list", async () => {
    const privateKinds = CASE_KINDS.filter(
      (k): k is CaseKind => !PUBLIC_KINDS.includes(k as CaseKind),
    );
    for (const kind of privateKinds) {
      const ok = await canReadCase(fixtureDetail(kind), ANON);
      expect(ok, `${kind} must NOT be publicly visible (anon should 404)`).toBe(false);
    }
  });

  // Regression guard for legal/denuncias-despublicadas (2026-08-17). This case
  // used to assert the OPPOSITE. welfare_denuncia was public under a
  // transparency rationale, and the anonymous branch of CaseDetailView renders
  // jurisdictionProvince + jurisdictionLocality + openedReason for it — locality
  // plus prose about an unverified crime allegation (Ley 14.346 art. 1, prison)
  // against someone who cannot answer. Unpublishing /denuncias/codigo/[code]
  // without this would have shut the front door and left this one open.
  it("welfare_denuncia is NOT anonymously readable — /casos/[publicCode] must 404 for anon", async () => {
    expect(await canReadCase(fixtureDetail("welfare_denuncia"), ANON)).toBe(false);
    expect(isPubliclyVisibleKind("welfare_denuncia")).toBe(false);
  });

  it("admin retains universal access for every kind (regression guard)", async () => {
    for (const kind of CASE_KINDS) {
      const ok = await canReadCase(fixtureDetail(kind), ADMIN);
      expect(ok, `admin should always read ${kind}`).toBe(true);
    }
  });
});

describe("isPubliclyVisibleKind", () => {
  it("matches the three remaining public kinds", () => {
    expect(isPubliclyVisibleKind("bite_incident")).toBe(true);
    expect(isPubliclyVisibleKind("lost_pet_episode")).toBe(true);
    expect(isPubliclyVisibleKind("adoption_listing")).toBe(true);
  });

  it("rejects every other kind", () => {
    expect(isPubliclyVisibleKind("welfare_denuncia")).toBe(false);
    expect(isPubliclyVisibleKind("custody_dispute")).toBe(false);
    expect(isPubliclyVisibleKind("adoption_application")).toBe(false);
    expect(isPubliclyVisibleKind("foster_placement")).toBe(false);
    expect(isPubliclyVisibleKind("microchip_remediation")).toBe(false);
    expect(isPubliclyVisibleKind("not-a-real-kind")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// custody_dispute — an ORGANISATION party reads its own case (2026-09-04)
//
// WHY THIS HALF HITS REAL POSTGRES. The rule is a join over
// custody_dispute_parties and organization_memberships with a lifecycle filter
// (`left_at IS NULL`); a mock returns whatever the mock says, and the whole
// question here is which ROWS match. Same reasoning as
// __tests__/caretaker-case-access.test.ts and __tests__/rehome-inbox-visibility.test.ts.
//
// WHAT MADE IT URGENT. Commit ecb192c99 made a shelter-held pet disputable:
// the organisation holding the animal is filed as a `current_org_custody` party
// with party_organization_id (party_user_id null — migration 0025's
// `dispute_party_exactly_one_subject` CHECK allows exactly one of the two), and
// its active members are notified with a CTA to /casos/<code>. The TypeScript
// access check only ever matched party_user_id, so those notifications landed
// on notFound(). The SQL `can_read_case` had the org arm since migration 0034 —
// this closes the drift between the two, it does not widen the model.
//
// No `cases` row is needed: canReadCase takes a CaseDetail and keys the dispute
// branch on custodyDispute.id alone. Seed only what the join touches.
// ---------------------------------------------------------------------------

const PET_TOKEN = "DIM-CDOP-0001";
const ORG_PARTY_TOKEN = "DIM-CDOP-ORG1";
const ORG_OTHER_TOKEN = "DIM-CDOP-ORG2";
const DISPUTE_TOKEN = "DIS-CDOP-0001";

const USER_PARTY_ID = "0d15c0de-0000-4000-8000-000000000001";
const MEMBER_ACTIVE_ID = "0d15c0de-0000-4000-8000-000000000002";
const MEMBER_LEFT_ID = "0d15c0de-0000-4000-8000-000000000003";
const MEMBER_OTHER_ORG_ID = "0d15c0de-0000-4000-8000-000000000004";
const PROFILE_IDS = [USER_PARTY_ID, MEMBER_ACTIVE_ID, MEMBER_LEFT_ID, MEMBER_OTHER_ORG_ID];

describe("canReadCase — custody_dispute org-side parties", () => {
  let disputeId: string;
  let partyOrgId: string;
  let otherOrgId: string;

  const owner = (userId: string) => ({
    userId,
    role: "owner" as const,
    jurisdictions: [],
  });

  async function cleanup(): Promise<void> {
    const staleDisputes = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, DISPUTE_TOKEN));
    for (const { id } of staleDisputes) {
      await db.delete(custodyDisputeParties).where(eq(custodyDisputeParties.disputeId, id));
      await db.delete(custodyDisputes).where(eq(custodyDisputes.id, id));
    }
    // Deleting the pet cascades into pet_events, and `handle_pet_creation`
    // writes a welcome event on every insert — so the append-only trigger has
    // to be told this is fixture teardown.
    await withMutationOverride(async (tx) => {
      const stalePets = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, PET_TOKEN));
      for (const { id } of stalePets) {
        await tx.delete(petEvents).where(eq(petEvents.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    });
    for (const token of [ORG_PARTY_TOKEN, ORG_OTHER_TOKEN]) {
      const staleOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.publicToken, token));
      for (const { id } of staleOrgs) {
        await db
          .delete(organizationMemberships)
          .where(eq(organizationMemberships.organizationId, id));
        await db.delete(organizations).where(eq(organizations.id, id));
      }
    }
    await db.delete(profiles).where(inArray(profiles.id, PROFILE_IDS));
  }

  async function insertOrg(token: string, displayName: string): Promise<string> {
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: token,
        legalName: `${displayName} SRL`,
        displayName,
        orgType: "shelter",
        email: `${token.toLowerCase()}@dim-test.local`,
        verified: true,
      })
      .returning({ id: organizations.id });
    return org.id;
  }

  beforeAll(async () => {
    await cleanup();

    await db.insert(profiles).values([
      { id: USER_PARTY_ID, displayName: "Parte Usuaria Disputa", role: "owner" },
      { id: MEMBER_ACTIVE_ID, displayName: "Miembro Activo Disputa", role: "owner" },
      { id: MEMBER_LEFT_ID, displayName: "Miembro Saliente Disputa", role: "owner" },
      { id: MEMBER_OTHER_ORG_ID, displayName: "Miembro Ajeno Disputa", role: "owner" },
    ]);

    partyOrgId = await insertOrg(ORG_PARTY_TOKEN, "Refugio En Disputa");
    otherOrgId = await insertOrg(ORG_OTHER_TOKEN, "Refugio Ajeno Disputa");

    await db.insert(organizationMemberships).values([
      { organizationId: partyOrgId, userId: MEMBER_ACTIVE_ID, role: "admin" },
      // The whole point of `left_at IS NULL`: this person WAS a member of the
      // party org and is a stranger now.
      {
        organizationId: partyOrgId,
        userId: MEMBER_LEFT_ID,
        role: "volunteer",
        leftAt: new Date("2026-08-01"),
      },
      { organizationId: otherOrgId, userId: MEMBER_OTHER_ORG_ID, role: "admin" },
    ]);

    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: PET_TOKEN,
        name: "Disputa Org",
        species: "dog",
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      })
      .returning({ id: pets.id });

    const [raisingEvent] = await db
      .insert(petEvents)
      .values({
        petId: pet.id,
        eventType: "custody_dispute_raised",
        occurredAt: new Date(),
        recordedByUserId: USER_PARTY_ID,
        authorRole: "owner",
      })
      .returning({ id: petEvents.id });

    const [dispute] = await db
      .insert(custodyDisputes)
      .values({
        publicToken: DISPUTE_TOKEN,
        petId: pet.id,
        raisedByUserId: USER_PARTY_ID,
        raisedByRole: "owner",
        raisingEventId: raisingEvent.id,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      })
      .returning({ id: custodyDisputes.id });
    disputeId = dispute.id;

    // The shape submit-claim-dispute now writes: a user claimant plus the
    // organisation that holds the animal, as two rows of the SAME dispute.
    await db.insert(custodyDisputeParties).values([
      { disputeId, partyUserId: USER_PARTY_ID, partyRole: "claimant_owner" },
      { disputeId, partyOrganizationId: partyOrgId, partyRole: "current_org_custody" },
    ]);
  });

  afterAll(cleanup);

  const disputeDetail = () =>
    fixtureDetail("custody_dispute", {
      custodyDispute: { id: disputeId, publicToken: DISPUTE_TOKEN, status: "open" },
    } as Partial<CaseDetail>);

  it("an ACTIVE member of the party organisation can read the case", async () => {
    expect(await canReadCase(disputeDetail(), owner(MEMBER_ACTIVE_ID))).toBe(true);
  });

  it("a member who LEFT that organisation cannot — left_at closes the door", async () => {
    expect(await canReadCase(disputeDetail(), owner(MEMBER_LEFT_ID))).toBe(false);
  });

  it("an active member of an UNRELATED organisation cannot", async () => {
    expect(await canReadCase(disputeDetail(), owner(MEMBER_OTHER_ORG_ID))).toBe(false);
  });

  it("the user-side party still reads it (regression guard, no behaviour change)", async () => {
    expect(await canReadCase(disputeDetail(), owner(USER_PARTY_ID))).toBe(true);
  });

  it("anonymous is still denied — custody_dispute is not a public kind", async () => {
    expect(await canReadCase(disputeDetail(), ANON)).toBe(false);
  });

  it("the fixture is real — non-vacuity", async () => {
    // A party row with party_organization_id set and party_user_id NULL is the
    // exact shape under test; if the seed ever degraded into a user row, every
    // assertion above would still pass for the wrong reason.
    const rows = await db
      .select({
        userId: custodyDisputeParties.partyUserId,
        organizationId: custodyDisputeParties.partyOrganizationId,
        role: custodyDisputeParties.partyRole,
      })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.disputeId, disputeId));
    expect(rows).toContainEqual({
      userId: null,
      organizationId: partyOrgId,
      role: "current_org_custody",
    });
    const memberships = await db
      .select({ userId: organizationMemberships.userId, leftAt: organizationMemberships.leftAt })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, partyOrgId));
    expect(memberships).toContainEqual({ userId: MEMBER_ACTIVE_ID, leftAt: null });
    expect(memberships.find((m) => m.userId === MEMBER_LEFT_ID)?.leftAt).not.toBeNull();
  });
});
