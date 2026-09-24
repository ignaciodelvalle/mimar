// The `/api/v1/me/foster` hub read, in one file.
//
// WHY IT LIVES OUTSIDE foster-repository.ts (2026-09-22)
// ---------------------------------------------------------------------------
// Exactly the reason `foster-convert-to-owner-writer.ts` and
// `foster-end-writer.ts` left: the repository lives on a size ratchet
// (`scripts/check-file-size.ts`), and this read pushed it over. Their own
// header states the remedy — extract the largest thing, delegate from the
// repository — so this read sits beside those two writers as a named,
// extracted piece rather than growing the file it left.
//
// FOLDS TWO WEB QUERIES INTO ONE — `propuestas/page.tsx`'s "activas" section
// (status = 'pending') and `activos/page.tsx`'s active-foster list, widened
// here to ALSO return ended rows so a phone can show "cuándo terminó" the way
// the web's own libreta timeline does for the animal, per the pet payload's
// own convention. See `@dim/contract/api`'s `my-foster.ts` for the full note.
//
// THE PER-PET ORG LOOKUP IS THE SAME N+1 `activos/page.tsx` ALREADY RUNS (one
// `shelter_custody` query per pet), not a new pattern invented here — the
// fosters list is bounded to `FOSTER_HUB_LIMIT` rows so the loop stays cheap.

import { and, desc, eq, isNull } from "drizzle-orm";

import { type db, fosterProposals, organizations, ownerships, pets } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

type PetRow = typeof pets.$inferSelect;
type ProposalRow = typeof fosterProposals.$inferSelect;

/**
 * Bound on the fosters list, which runs one extra query per row (the per-pet
 * custody lookup). A volunteer with an unusually long history should still
 * get a bounded read rather than an unbounded fan-out.
 */
const FOSTER_HUB_LIMIT = 50;

export type FosterHubRows = {
  proposals: Array<{ proposal: ProposalRow; pet: PetRow; organizationName: string }>;
  fosters: Array<{
    ownership: typeof ownerships.$inferSelect;
    pet: PetRow;
    organizationName: string | null;
    proposedDurationWeeks: number | null;
  }>;
};

/**
 * Pending proposals addressed to this volunteer, plus every foster ownership
 * row (active or ended) they hold.
 */
export async function listFosterHubRowsForVolunteer(
  userId: string,
  client: DbOrTx,
): Promise<FosterHubRows> {
  const proposalRows = await client
    .select({ proposal: fosterProposals, pet: pets, organizationName: organizations.displayName })
    .from(fosterProposals)
    // Art. 16: an erased pet's proposal survives the erasure RPC (it never
    // touches foster_proposals) and would otherwise surface its name to the
    // volunteer — same reasoning as propuestas/page.tsx.
    .innerJoin(pets, and(eq(pets.id, fosterProposals.petId), isNull(pets.deletedAt)))
    .innerJoin(organizations, eq(organizations.id, fosterProposals.organizationId))
    .where(and(eq(fosterProposals.volunteerUserId, userId), eq(fosterProposals.status, "pending")))
    .orderBy(desc(fosterProposals.proposedAt));

  const fosterRows = await client
    .select({ ownership: ownerships, pet: pets })
    .from(ownerships)
    // Art. 16: a foster ownership survives the erasure RPC too (it only
    // soft-deletes role='owner' pets) — same drop as activos/page.tsx.
    .innerJoin(pets, and(eq(pets.id, ownerships.petId), isNull(pets.deletedAt)))
    .where(and(eq(ownerships.ownerUserId, userId), eq(ownerships.role, "foster")))
    .orderBy(desc(ownerships.startedAt))
    .limit(FOSTER_HUB_LIMIT);

  const fosters: FosterHubRows["fosters"] = [];

  for (const row of fosterRows) {
    const [orgRow] = await client
      .select({ displayName: organizations.displayName })
      .from(ownerships)
      .innerJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
      .where(
        and(
          eq(ownerships.petId, row.pet.id),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);

    const [resolvedProposal] = await client
      .select({ proposedDurationWeeks: fosterProposals.proposedDurationWeeks })
      .from(fosterProposals)
      .where(eq(fosterProposals.resolvedOwnershipId, row.ownership.id))
      .limit(1);

    fosters.push({
      ownership: row.ownership,
      pet: row.pet,
      organizationName: orgRow?.displayName ?? null,
      proposedDurationWeeks: resolvedProposal?.proposedDurationWeeks ?? null,
    });
  }

  return {
    proposals: proposalRows.map((r) => ({
      proposal: r.proposal,
      pet: r.pet,
      organizationName: r.organizationName,
    })),
    fosters,
  };
}
