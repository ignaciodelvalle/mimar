"use server";

// Thin action controllers for the foster domain.
//
// Each action does ONLY:
//   1. Auth guard at the edge (requireCapability or supabase session) — security boundary.
//   2. Parse raw formData or input DTO.
//   3. Build deps (repo, actor, transaction) and call the corresponding use-case.
//   4. Handle UseCaseResult<T> — on error, return { error: string }.
//   5. Flush pendingNotifications post-tx, best-effort (catch+log, never throw).
//   6. revalidatePath or redirect.
//
// NO business logic. NO direct Drizzle imports beyond the notifications insert
// and db.transaction pass-through.
//
// Reference: src/modules/adoption/actions.ts

import { db, notifications } from "@/db";
import type { CronBudgetHeaders } from "@/lib/infra/cron-dispatcher";
import { requireLiveUser } from "@/lib/infra/live-user";
import {
  requireCapability,
  requireCapabilityForOrgToken,
} from "@/src/modules/organizations/infrastructure/authz-resolver";
import { revalidatePath } from "next/cache";

import { acceptFosterProposal } from "./application/accept-foster-proposal";
import { assignFoster } from "./application/assign-foster";
import { cancelFosterProposal } from "./application/cancel-foster-proposal";
import { convertFosterToOwner } from "./application/convert-foster-to-owner";
import { endFoster } from "./application/end-foster";
import { expireFosterProposals as expireFosterProposalsUseCase } from "./application/expire-foster-proposals";
import { sendRehomeRequest } from "./application/find-rehome-orgs";
import { proposeFoster } from "./application/propose-foster";
import { rejectFosterProposal } from "./application/reject-foster-proposal";
import { searchFosterVolunteers as searchFosterVolunteersUseCase } from "./application/search-foster-volunteers";
import { setCoFosterAllowed } from "./application/set-co-foster-allowed";
import { upsertFosterVolunteer } from "./application/upsert-foster-volunteer";
import { withdrawFosterVolunteer } from "./application/withdraw-foster-volunteer";
import { FosterRepository } from "./infrastructure/foster-repository";

import type {
  FosterVolunteerSearchRow,
  SearchFosterVolunteersInput as UseCaseSearchInput,
} from "./application/search-foster-volunteers";
import type { NewNotification } from "./application/types";
import type { UpsertFosterVolunteerInput } from "./domain/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Flush notifications post-tx, best-effort. Never throws. */
async function flushNotifications(pending: NewNotification[]): Promise<void> {
  if (pending.length === 0) return;
  try {
    await db
      .insert(notifications)
      .values(pending as unknown as (typeof notifications.$inferInsert)[]);
  } catch (e) {
    console.error("[foster/actions] notifications insert failed (action did succeed):", e);
  }
}

// ---------------------------------------------------------------------------
// assignFosterAction
// ---------------------------------------------------------------------------

export type AssignFosterFormState = {
  error: string | null;
  /**
   * N3 post-action destination. The action must NOT redirect() — the App
   * Router drops a server action's own redirect in production: the write
   * commits and the screen never moves (lib/ui/full-page-action-nav.ts).
   */
  redirectTo?: string | null;
};

export async function assignFosterAction(
  orgToken: string,
  publicToken: string,
  _previous: AssignFosterFormState,
  formData: FormData,
): Promise<AssignFosterFormState> {
  // Pin the capability check to the org in the URL, not the session-default
  // membership — the actor org flows into the foster ownership + events.
  const auth = await requireCapabilityForOrgToken("foster.assign", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const fosterUserId = String(formData.get("fosterUserId") ?? "").trim();
  const expectedWeeksRaw = String(formData.get("expectedWeeks") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const result = await assignFoster(
    { petPublicToken: publicToken, fosterUserId, expectedWeeksRaw, notes },
    {
      repo: FosterRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: result.value.redirectPath };
}

// ---------------------------------------------------------------------------
// endFosterAction
// ---------------------------------------------------------------------------

export type EndFosterFormState = {
  error: string | null;
  /**
   * N3 post-action destination. The action must NOT redirect() — the App
   * Router drops a server action's own redirect in production: the write
   * commits and the screen never moves (lib/ui/full-page-action-nav.ts).
   */
  redirectTo?: string | null;
};

export async function endFosterAction(
  orgToken: string,
  publicToken: string,
  _previous: EndFosterFormState,
  formData: FormData,
): Promise<EndFosterFormState> {
  // Pin to the URL org, not the session-default membership.
  const auth = await requireCapabilityForOrgToken("foster.end", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const reasonRaw = String(formData.get("reason") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const result = await endFoster(
    { petPublicToken: publicToken, reasonRaw, notes },
    {
      repo: FosterRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  // PARITY: ?fostend= (not ?foster=) — preserve exactly.
  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: result.value.redirectPath };
}

// ---------------------------------------------------------------------------
// proposeFosterAction
// ---------------------------------------------------------------------------

export type ProposeFosterInput = {
  orgToken: string;
  volunteerUserId: string;
  petPublicToken: string;
  proposedDurationWeeks?: number | null;
  proposedNotes?: string | null;
};

export type ProposeFosterResult = { proposalPublicToken: string } | { error: string };

export async function proposeFosterAction(input: ProposeFosterInput): Promise<ProposeFosterResult> {
  // Pin the capability check to the org named by input.orgToken (the URL org),
  // never the session-default membership — the actor org authors the proposal.
  const auth = await requireCapabilityForOrgToken("foster.assign", input.orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const result = await proposeFoster(
    {
      petPublicToken: input.petPublicToken,
      volunteerUserId: input.volunteerUserId,
      proposedDurationWeeks: input.proposedDurationWeeks ?? null,
      proposedNotes: input.proposedNotes ?? null,
    },
    {
      repo: FosterRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  revalidatePath(result.value.revalidatePath);
  return { proposalPublicToken: result.value.proposalPublicToken };
}

// ---------------------------------------------------------------------------
// cancelFosterProposalAction
// Authentication note: auth MUST be scoped to the proposal's organization, not
// the session's most-recent active membership. Fix for spec R6:
//   1. Load the proposal by token first (or return not-found).
//   2. Call requireCapability("foster.assign", proposal.organizationId) so that
//      only a user with the capability in THAT specific org can cancel it.
//   3. Pass the pre-authorized actor to the use-case (which skips its own auth).
// ---------------------------------------------------------------------------

export type CancelFosterProposalInput = {
  proposalPublicToken: string;
  cancellationReason?: string | null;
};

export type CancelFosterProposalResult = { ok: true } | { error: string };

export async function cancelFosterProposalAction(
  input: CancelFosterProposalInput,
): Promise<CancelFosterProposalResult> {
  // 1. Load proposal first to obtain the owning organizationId for auth scoping.
  const proposal = await FosterRepository.findProposalByToken(input.proposalPublicToken);
  if (!proposal) return { error: "Propuesta no encontrada." };

  // 2. Auth check scoped to the proposal's org (spec R6).
  const auth = await requireCapability("foster.assign", proposal.organizationId);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const result = await cancelFosterProposal(
    {
      proposalPublicToken: input.proposalPublicToken,
      cancellationReason: input.cancellationReason ?? null,
    },
    {
      repo: FosterRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// acceptFosterProposalAction — volunteer side (session auth)
// ---------------------------------------------------------------------------

export type AcceptFosterProposalInput = {
  proposalPublicToken: string;
  allowCoFoster: boolean;
  responseNotes?: string | null;
};

export type AcceptFosterProposalResult =
  | {
      fosterOwnershipId: string;
      remainingSlots: number;
      cascadeCancelledProposals: string[];
    }
  | { error: string };

export async function acceptFosterProposalAction(
  input: AcceptFosterProposalInput,
): Promise<AcceptFosterProposalResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await acceptFosterProposal(
    {
      proposalPublicToken: input.proposalPublicToken,
      allowCoFoster: input.allowCoFoster,
      responseNotes: input.responseNotes ?? null,
    },
    {
      repo: FosterRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  revalidatePath("/cuenta/transitos/propuestas");
  revalidatePath("/mis-mascotas");
  return {
    fosterOwnershipId: result.value.fosterOwnershipId,
    remainingSlots: result.value.remainingSlots,
    cascadeCancelledProposals: result.value.cascadeCancelledProposals,
  };
}

// ---------------------------------------------------------------------------
// rejectFosterProposalAction — volunteer side (session auth)
// ---------------------------------------------------------------------------

export type RejectFosterProposalInput = {
  proposalPublicToken: string;
  rejectionReason: string;
  responseNotes?: string | null;
};

export type RejectFosterProposalResult = { ok: true } | { error: string };

export async function rejectFosterProposalAction(
  input: RejectFosterProposalInput,
): Promise<RejectFosterProposalResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await rejectFosterProposal(
    {
      proposalPublicToken: input.proposalPublicToken,
      rejectionReason: input.rejectionReason,
      responseNotes: input.responseNotes ?? null,
    },
    {
      repo: FosterRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  revalidatePath(result.value.revalidatePath);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// expireFosterProposalsAction — cron/system path, no user actor
// ---------------------------------------------------------------------------

export type ExpireFosterProposalsStats = {
  candidates: number;
  expired: number;
  errors: number;
};

/** System action called by the cron route. Throws on fatal error (cron logs it). */
// @no-auth-required: cron/system path — auth enforced at the /api/cron/expire-foster-proposals route via authorizeCronRequest (CRON_SECRET).
export async function expireFosterProposalsAction(opts?: {
  /**
   * The daily dispatcher's fair share, when this runs inside the fleet
   * (RN #9 half b): the sweep's deadline becomes min(own ceiling, share handed
   * down) so a late start cannot push the shared function past its 60 s hard
   * kill. Absent (a manual curl, Vercel hitting the route directly) the
   * constant is all there is, unchanged.
   */
  budgetHeaders?: CronBudgetHeaders;
}): Promise<ExpireFosterProposalsStats> {
  const result = await expireFosterProposalsUseCase(
    { repo: FosterRepository },
    { budgetHeaders: opts?.budgetHeaders },
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

// ---------------------------------------------------------------------------
// upsertFosterVolunteerAction — volunteer side (session auth)
// ---------------------------------------------------------------------------

export type UpsertFosterVolunteerResult =
  | { volunteerId: string; availableSlots: number }
  | { error: string };

export async function upsertFosterVolunteerAction(
  input: UpsertFosterVolunteerInput,
): Promise<UpsertFosterVolunteerResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await upsertFosterVolunteer(input, {
    repo: FosterRepository,
    actor: { user },
    transaction: db.transaction.bind(db),
  });

  if (!result.ok) return { error: result.error };

  revalidatePath(result.value.revalidatePath);
  return { volunteerId: result.value.volunteerId, availableSlots: result.value.availableSlots };
}

// ---------------------------------------------------------------------------
// withdrawFosterVolunteerAction — volunteer side (session auth)
// ---------------------------------------------------------------------------

export type WithdrawFosterVolunteerResult = { ok: true } | { error: string };

export async function withdrawFosterVolunteerAction(): Promise<WithdrawFosterVolunteerResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await withdrawFosterVolunteer({
    repo: FosterRepository,
    actor: { user },
    transaction: db.transaction.bind(db),
  });

  if (!result.ok) return { error: result.error };

  revalidatePath(result.value.revalidatePath);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// setCoFosterAllowedAction — volunteer side (session auth)
// ---------------------------------------------------------------------------

export type SetCoFosterAllowedInput = {
  fosterOwnershipId: string;
  allowCoFoster: boolean;
};

export type SetCoFosterAllowedResult = { ok: true } | { error: string };

export async function setCoFosterAllowedAction(
  input: SetCoFosterAllowedInput,
): Promise<SetCoFosterAllowedResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await setCoFosterAllowed(
    {
      fosterOwnershipId: input.fosterOwnershipId,
      allowCoFoster: input.allowCoFoster,
    },
    {
      repo: FosterRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  revalidatePath(result.value.revalidatePath);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// searchFosterVolunteers — read action, org side
// Preserves the original input shape (including orgToken) for drop-in
// consumer compatibility. Auth is checked at the edge via requireCapability.
// ---------------------------------------------------------------------------

export type SearchFosterVolunteersInput = {
  orgToken: string;
  province?: string | null;
  locality?: string | null;
  species?: "dog" | "cat" | "other";
  petPublicToken?: string | null;
  proposedDurationWeeks?: number | null;
  limit?: number;
};

export type { FosterVolunteerSearchRow };

export type SearchFosterVolunteersResult = { rows: FosterVolunteerSearchRow[] } | { error: string };

// @no-audit-required: READ ONLY — a ranked volunteer search. It reaches
// FosterRepository, which contains writes belonging to other methods, and
// lint:audit-log resolves reachability one hop out, so widening the fence to
// capability guards (2026-08-22) surfaced it as a candidate. This action calls
// only finder methods and returns rows; there is no mutation to account for.
export async function searchFosterVolunteers(
  input: SearchFosterVolunteersInput,
): Promise<SearchFosterVolunteersResult> {
  // Pin the read to the org named by input.orgToken (the URL org), so a
  // multi-org member can only search volunteers scoped to the org they act as.
  const auth = await requireCapabilityForOrgToken("foster.assign", input.orgToken);
  if (auth.error !== null) return { error: auth.error };

  // Build optional petShape from petPublicToken if provided.
  let petShape: UseCaseSearchInput["petShape"] = null;
  if (input.petPublicToken) {
    // Load the pet shape from the repo (needed for match scoring).
    const petRow = await FosterRepository.findShelterPetByToken(
      input.petPublicToken,
      auth.organization.id,
    );
    if (petRow) {
      petShape = {
        species: (petRow as { species: string }).species,
        estimatedWeightKg:
          (petRow as { estimatedWeightKg?: number | null }).estimatedWeightKg ?? null,
        dateOfBirth: (petRow as { dateOfBirth?: Date | null }).dateOfBirth ?? null,
        isPpp: (petRow as { potentiallyDangerousBreed: boolean }).potentiallyDangerousBreed,
      };
    }
  }

  const result = await searchFosterVolunteersUseCase(
    {
      province: input.province ?? null,
      locality: input.locality ?? null,
      species: input.species,
      petShape,
      proposedDurationWeeks: input.proposedDurationWeeks ?? null,
      limit: input.limit,
    },
    { repo: FosterRepository },
  );

  if (!result.ok) return { error: result.error };
  return { rows: result.value.rows };
}

// ---------------------------------------------------------------------------
// convertFosterToOwnerAction — owner portal / transit banner CTA 1
// ---------------------------------------------------------------------------

export type ConvertFosterToOwnerResult = { redirectPath: string } | { error: string };

/**
 * Converts an active foster into permanent ownership.
 * Auth: session user must be the active foster of the pet identified by
 * petPublicToken (enforced server-side via FosterRepository.findActiveFosterByUser).
 */
export async function convertFosterToOwnerAction(
  petPublicToken: string,
): Promise<ConvertFosterToOwnerResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await convertFosterToOwner(
    { petPublicToken },
    {
      repo: FosterRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  revalidatePath(`/mis-mascotas/${petPublicToken}`);
  revalidatePath("/mis-mascotas");
  return { redirectPath: result.value.redirectPath };
}

// ---------------------------------------------------------------------------
// sendRehomeRequestAction — owner portal / transit banner CTA 2
// ---------------------------------------------------------------------------

export type SendRehomeRequestResult = { ok: true } | { error: string };

/**
 * Sends a rehome request notification to an org's admins/coordinators.
 * Auth: session user must be the active foster of the pet.
 * No new schema — lean notification-based MVP.
 */
export async function sendRehomeRequestAction(
  petPublicToken: string,
  targetOrgId: string,
): Promise<SendRehomeRequestResult> {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  const user = live.user;

  const result = await sendRehomeRequest(
    { petPublicToken, targetOrgId },
    {
      repo: FosterRepository,
      actor: { user },
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  return { ok: true };
}
