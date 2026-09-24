// Use-case: loadProposalContext — read-only helper that fetches the latest
// proposal and resolves actor display information for the UI.
//
// @no-auth-required: read-only context loader. The calling page must have
// already auth-gated via requireOrgAccessByToken / pet-access helpers.

import { and, desc, eq } from "drizzle-orm";

import { type PetEvent, db, organizations, petEvents, profiles } from "@/db";

export type ProposalContextResult = {
  latestProposal: PetEvent | null;
  actorDisplayName: string | null;
  actorOrgName: string | null;
};

export async function loadProposalContextUseCase(petId: string): Promise<ProposalContextResult> {
  const [latestProposal] = (await db
    .select()
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1)) as PetEvent[];

  if (!latestProposal) return { latestProposal: null, actorDisplayName: null, actorOrgName: null };

  const proposalPayload = latestProposal.payload as Record<string, unknown>;
  const fromUserId = (proposalPayload.from_user_id as string | null) ?? null;
  const fromOrgId = (proposalPayload.from_organization_id as string | null) ?? null;

  let actorDisplayName: string | null = null;
  let actorOrgName: string | null = null;

  if (fromUserId) {
    const [profile] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, fromUserId))
      .limit(1);
    actorDisplayName = profile?.displayName ?? null;
  }

  if (fromOrgId) {
    const [org] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, fromOrgId))
      .limit(1);
    actorOrgName = org?.displayName ?? null;
  }

  return { latestProposal, actorDisplayName, actorOrgName };
}
