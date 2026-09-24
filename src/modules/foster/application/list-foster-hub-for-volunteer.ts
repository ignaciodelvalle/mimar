// Use-case: everything a volunteer needs to see about their own tránsito —
// proposals awaiting an answer, and the fosters that came of one.
//
// READ ONLY — no mutations, no notifications.
//
// Folds `propuestas/page.tsx`'s "activas" section and `activos/page.tsx`'s
// active-foster list into one read, widened to also carry ENDED fosters —
// see `list-foster-hub-for-volunteer.test.ts` and the api contract
// (`my-foster.ts`) for why. The repository (`listHubRowsForVolunteer`)
// already narrows the rows to ones this volunteer may see; this shapes them
// into the DTO the route serializes.

import type { FosterRepository } from "../infrastructure/foster-repository";

type Deps = {
  repo: Pick<typeof FosterRepository, "listHubRowsForVolunteer">;
  /** Injected so a test can pin the expiry boundary instead of racing it. */
  now?: () => Date;
};

export type FosterHubPet = {
  publicToken: string;
  name: string;
  species: string;
};

export type FosterHubProposal = {
  proposalToken: string;
  pet: FosterHubPet;
  organizationName: string;
  proposedDurationWeeks: number | null;
  proposedNotes: string | null;
  proposedAt: Date;
  expiresAt: Date;
  /** By the SERVER'S clock. Informational only — see `my-foster.ts`'s header. */
  expired: boolean;
};

export type FosterHubOwnership = {
  fosterOwnershipId: string;
  pet: FosterHubPet;
  organizationName: string | null;
  startedAt: Date;
  endedAt: Date | null;
  active: boolean;
  proposedDurationWeeks: number | null;
};

export type FosterHubForVolunteer = {
  proposals: FosterHubProposal[];
  fosters: FosterHubOwnership[];
};

export async function listFosterHubForVolunteer(
  input: { userId: string },
  deps: Deps,
): Promise<FosterHubForVolunteer> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = await deps.repo.listHubRowsForVolunteer(input.userId);

  const proposals: FosterHubProposal[] = rows.proposals.map((row) => ({
    proposalToken: row.proposal.publicToken,
    pet: { publicToken: row.pet.publicToken, name: row.pet.name, species: row.pet.species },
    organizationName: row.organizationName,
    proposedDurationWeeks: row.proposal.proposedDurationWeeks,
    proposedNotes: row.proposal.proposedNotes,
    proposedAt: row.proposal.proposedAt,
    expiresAt: row.proposal.expiresAt,
    expired: row.proposal.expiresAt.getTime() <= now.getTime(),
  }));

  const fosters: FosterHubOwnership[] = rows.fosters.map((row) => ({
    fosterOwnershipId: row.ownership.id,
    pet: { publicToken: row.pet.publicToken, name: row.pet.name, species: row.pet.species },
    organizationName: row.organizationName,
    startedAt: row.ownership.startedAt,
    endedAt: row.ownership.endedAt,
    active: row.ownership.endedAt === null,
    proposedDurationWeeks: row.proposedDurationWeeks,
  }));

  return { proposals, fosters };
}
