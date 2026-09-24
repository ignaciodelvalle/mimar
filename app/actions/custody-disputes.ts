"use server";

// Custody disputes — thin Next.js "use server" controllers.
//
// Business logic lives in src/modules/custody-disputes/application/.
// This file: auth guard → delegate to use-case → revalidate → return.
//
// openDisputeFromEvent is NOT exported here — it's a transactional helper
// with no auth guard, so exporting it from a "use server" file would make it
// an independently-addressable server action (authz triage 2026-07-04).
// Callers import it from
// src/modules/custody-disputes/application/open-dispute directly.

import { revalidatePath } from "next/cache";

import type { Pet } from "@/db";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";

import { addDisputePartyUseCase } from "@/src/modules/custody-disputes/application/add-dispute-party";
import { escalateDisputeUseCase } from "@/src/modules/custody-disputes/application/escalate-dispute";
import { lookupTransferTargetUseCase } from "@/src/modules/custody-disputes/application/lookup-transfer-target";
import { resolveDisputeUseCase } from "@/src/modules/custody-disputes/application/resolve-dispute";
import { searchPartyCandidatesUseCase } from "@/src/modules/custody-disputes/application/search-party-candidates";
import { withdrawDisputeUseCase } from "@/src/modules/custody-disputes/application/withdraw-dispute";
import type {
  AddPartyInput,
  AddPartyResult,
  EscalateDisputeInput,
  EscalateDisputeResult,
  LookupTransferTargetInput,
  LookupTransferTargetResult,
  ResolveDisputeInput,
  ResolveDisputeResult,
  SearchPartyCandidatesInput,
  SearchPartyCandidatesResult,
  WithdrawDisputeInput,
  WithdrawDisputeResult,
} from "@/src/modules/custody-disputes/domain/types";

// ============================================================================
// Type re-exports — keep public type surface stable for existing callers
// (type-only exports are erased at runtime; allowed in "use server" files)
// ============================================================================

export type { AddPartyInput, AddPartyResult } from "@/src/modules/custody-disputes/domain/types";
export type {
  ResolveDisputeInput,
  ResolveDisputeResult,
} from "@/src/modules/custody-disputes/domain/types";
export type {
  WithdrawDisputeInput,
  WithdrawDisputeResult,
} from "@/src/modules/custody-disputes/domain/types";
export type {
  LookupTransferTargetInput,
  LookupTransferTargetResult,
} from "@/src/modules/custody-disputes/domain/types";
export type {
  PartyCandidate,
  SearchPartyCandidatesInput,
  SearchPartyCandidatesResult,
} from "@/src/modules/custody-disputes/domain/types";
export type {
  EscalateDisputeInput,
  EscalateDisputeResult,
} from "@/src/modules/custody-disputes/domain/types";

// Convenience re-export — no Pet import needed by callers.
export type DisputePet = Pick<Pet, "id" | "name" | "species" | "publicToken">;

// ============================================================================
// Server actions
// ============================================================================

export async function addDisputePartyAction(input: AddPartyInput): Promise<AddPartyResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const result = await addDisputePartyUseCase(session, input);
  if ("partyId" in result) {
    revalidatePath(`/gob/disputas/${input.disputeToken}`);
  }
  return result;
}

export async function resolveDisputeAction(
  input: ResolveDisputeInput,
): Promise<ResolveDisputeResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const result = await resolveDisputeUseCase(session, input);
  if ("resolvedAt" in result) {
    // F6 fusion (2026-07-22): the disputes queue now renders under the Casos
    // hub (/gob/casos?expediente=disputas), not /gob/disputas (a redirect
    // shim). revalidatePath("/gob/casos") revalidates the hub path for every
    // expediente/query variant.
    revalidatePath("/gob/casos");
    revalidatePath(`/gob/disputas/${input.disputeToken}`);
  }
  return result;
}

export async function withdrawDisputeAction(
  input: WithdrawDisputeInput,
): Promise<WithdrawDisputeResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const result = await withdrawDisputeUseCase(session, input);
  if ("withdrawnAt" in result) {
    // F6 fusion (2026-07-22): see resolveDisputeAction above — the queue now
    // renders under the Casos hub, not the /gob/disputas redirect shim.
    revalidatePath("/gob/casos");
    revalidatePath(`/gob/disputas/${input.disputeToken}`);
  }
  return result;
}

export async function lookupTransferTargetAction(
  input: LookupTransferTargetInput,
): Promise<LookupTransferTargetResult> {
  const session = await requireAdminOrGovtOrRedirect();
  return lookupTransferTargetUseCase(session, input);
}

// Read-only — no revalidatePath. Powers AddPartyForm's search/select picker.
export async function searchPartyCandidatesAction(
  input: SearchPartyCandidatesInput,
): Promise<SearchPartyCandidatesResult> {
  const session = await requireAdminOrGovtOrRedirect();
  return searchPartyCandidatesUseCase(session, input);
}

export async function escalateDisputeAction(
  input: EscalateDisputeInput,
): Promise<EscalateDisputeResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const result = await escalateDisputeUseCase(session, input);
  if ("escalatedAt" in result) {
    // /gob/casos JOINED THIS LIST when escalation started writing the status
    // (T4-D1). Revalidating only the detail page was correct BEFORE: escalation
    // left a note and changed nothing the queue rendered. Now the hub renders
    // the dispute's state, so skipping it leaves the arbiter looking at a
    // cached "Abierto" for a file that is in judicial hands — exactly the
    // revalidation resolve and withdraw have always done.
    revalidatePath("/gob/casos");
    revalidatePath(`/gob/disputas/${input.disputeToken}`);
  }
  return result;
}
