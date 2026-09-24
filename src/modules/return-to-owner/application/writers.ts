// Internal writers for the return-to-owner domain — NOT server actions.
//
// This module is intentionally NOT a "use server" file: each export accepts a
// caller-supplied userId/orgId (Writer-pattern) and must never be
// independently addressable from the client (authz triage 2026-07-04,
// residual close-out — mirrors organizations/actions.internal.ts). The
// guarded public entry points live in app/actions/return-to-owner.ts, which
// derive the userId/orgId from the session (or a verified org token) before
// delegating here. __tests__/return-to-owner.test.ts imports these directly
// for unit coverage of the use-case behavior, bypassing session plumbing.

import { actorCancelProposalUseCase } from "@/src/modules/return-to-owner/application/actor-cancel-proposal";
import { orgAcceptOwnerReturnUseCase } from "@/src/modules/return-to-owner/application/org-accept-owner-return";
import { orgRejectOwnerReturnUseCase } from "@/src/modules/return-to-owner/application/org-reject-owner-return";
import { ownerAcceptReturnUseCase } from "@/src/modules/return-to-owner/application/owner-accept-return";
import { ownerProposeReturnToOrgUseCase } from "@/src/modules/return-to-owner/application/owner-propose-return-to-org";
import { ownerRejectReturnUseCase } from "@/src/modules/return-to-owner/application/owner-reject-return";
import { proposeReturnAsRefugioUseCase } from "@/src/modules/return-to-owner/application/propose-return-as-refugio";
import { proposeReturnAsVecinoUseCase } from "@/src/modules/return-to-owner/application/propose-return-as-vecino";

export async function proposeReturnAsRefugioWriter(args: {
  userId: string;
  organization: { id: string; displayName: string };
  petPublicToken: string;
  notes: string | null;
}) {
  return proposeReturnAsRefugioUseCase(args);
}

export async function proposeReturnAsVecinoWriter(args: {
  userId: string;
  petPublicToken: string;
  notes: string | null;
}) {
  return proposeReturnAsVecinoUseCase(args);
}

export async function ownerAcceptReturnWriter(args: {
  userId: string;
  petPublicToken: string;
}) {
  return ownerAcceptReturnUseCase(args);
}

export async function ownerRejectReturnWriter(args: {
  userId: string;
  petPublicToken: string;
  reason: string;
}) {
  return ownerRejectReturnUseCase(args);
}

export async function actorCancelProposalWriter(args: {
  userId: string;
  petPublicToken: string;
  reason: string;
  actorOrgId?: string;
}) {
  return actorCancelProposalUseCase(args);
}

export async function ownerProposeReturnToOrgWriter(args: {
  userId: string;
  petPublicToken: string;
  reason: string;
  notes: string | null;
  proposedAt: string;
  callerRole?: "owner" | "foster";
}) {
  return ownerProposeReturnToOrgUseCase(args);
}

export async function orgAcceptOwnerReturnWriter(args: {
  orgId: string;
  orgDisplayName: string;
  actingUserId: string;
  petPublicToken: string;
}) {
  return orgAcceptOwnerReturnUseCase(args);
}

export async function orgRejectOwnerReturnWriter(args: {
  orgId: string;
  orgDisplayName: string;
  actingUserId: string;
  petPublicToken: string;
  reason: string;
}) {
  return orgRejectOwnerReturnUseCase(args);
}
