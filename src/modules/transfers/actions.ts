"use server";

// Thin action controllers for the transfers domain.
//
// Each action does ONLY:
//   1. Auth guard at the edge (requireCapability or requireUserOrRedirect) — security boundary.
//   2. Parse raw formData or input DTO.
//   3. Build deps (repo, actor, transaction) and call the corresponding use-case.
//   4. Handle UseCaseResult<T> — on error, return { error: string }.
//   5. Flush pendingNotifications post-tx, best-effort (catch+log, never throw).
//   6. revalidatePath or redirect.
//
// NO business logic. NO direct Drizzle imports beyond the notifications insert.
//
// Auth-scope contract (CRITICAL — foster cross-org auth bypass was caught here):
//   - owner→owner flows: scope to the USER (requireUserOrRedirect), not a capability.
//   - cross-org accept/reject: scope to case.receiverOrganizationId via use-case
//     (load the case first, then validateReceiverOrgScope inside use-case).
//   - cross-org cancel: scope to case.openedByOrganizationId via use-case.
//   - direct handoff: scope to caller's active org (repo query scoped to organization.id).
//
// Reference: src/modules/foster/actions.ts, src/modules/adoption/actions.ts

import { auditLog, db, notifications } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { type CronBudgetHeaders, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { revalidatePath } from "next/cache";

import { acceptCrossOrgTransfer } from "./application/accept-cross-org-transfer";
import { acceptPetTransfer } from "./application/accept-pet-transfer";
import { cancelCrossOrgTransfer } from "./application/cancel-cross-org-transfer";
import { cancelPetTransfer } from "./application/cancel-pet-transfer";
import { expirePetTransfers } from "./application/expire-pet-transfers";
import { getTransferForViewer } from "./application/get-transfer-for-viewer";
import { initiatePetTransfer } from "./application/initiate-pet-transfer";
import { proposeCrossOrgTransfer } from "./application/propose-cross-org-transfer";
import { rejectCrossOrgTransfer } from "./application/reject-cross-org-transfer";
import { rejectPetTransfer } from "./application/reject-pet-transfer";
import { transferCustody } from "./application/transfer-custody";
import { TransfersRepository } from "./infrastructure/transfers-repository";

import type { NewNotification } from "./application/types";

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
    console.error("[transfers/actions] notifications insert failed (action did succeed):", e);
  }
}

type AuditEntry = {
  actorUserId: string;
  action: string;
  payload: Record<string, unknown>;
};

/**
 * Insert a single audit_log row post-tx, best-effort. Never throws.
 *
 * A DUPLICATE OF `TransfersRepository.insertAuditLog`, AND THE REASON IT STAYS
 * IS A FENCE RATHER THAN A PREFERENCE — the same shape, and the same reason, as
 * the `flushNotifications` twin in `src/modules/events/actions.ts`.
 *
 * The four owner→owner commands acquired a second door in WU-O
 * (`POST /api/v1/me/transfers`), and an audit row written by only one of them is
 * an operation that, performed from a phone, leaves no trace — indistinguishable
 * forever from the operation never having happened. So the repository grew a
 * named method for the route to call, and collapsing THIS function into it was
 * the obvious third step.
 *
 * It was tried, and `src/modules/transfers/__tests__/actions-parity.test.ts`
 * went red on 27 assertions. Not incidentally: that file mocks the repository
 * down to one method on purpose (its dependency graph is large) and pins the
 * audit rows by asserting `db.insert` was called with the `auditLog` table
 * SENTINEL. Delegating hides the insert behind a mock the test cannot see
 * through, and every "R1…R10 inserts auditLog with action=…" assertion — the
 * C-1 parity fence for nine operations — stops testing anything.
 *
 * Making that mock partial would pull the real repository's whole import graph
 * into a suite that deliberately avoids it. The duplicate is three lines; the
 * fence covers nine operations. The duplicate stays.
 *
 * WHAT MUST BE KEPT IN AGREEMENT is not this code, it is the `action` NAMES and
 * the payload shape — `pet_transfer_initiated` / `_accepted` / `_rejected` /
 * `_cancelled`, all four in the `audit_log_action_valid` CHECK constraint. The
 * route's copies are asserted against the same names in
 * `__tests__/api-v1-me-transfers-route.test.ts`.
 */
async function flushAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values(entry as typeof auditLog.$inferInsert);
  } catch (e) {
    console.error("[transfers/actions] auditLog insert failed (action did succeed):", e);
  }
}

// ---------------------------------------------------------------------------
// initiatePetTransferAction — R1: owner→owner initiate
// AUTH: current owner USER (requireUserOrRedirect)
// ---------------------------------------------------------------------------

export type InitiatePetTransferInput = {
  petToken: string;
  toEmail: string;
  reason: string;
  note?: string | null;
};

export type InitiatePetTransferResult = { transferToken: string } | { error: string };

export async function initiatePetTransferAction(
  input: InitiatePetTransferInput,
): Promise<InitiatePetTransferResult> {
  const { user } = await requireUserOrRedirect();

  // Resolve caller email from Supabase session (needed for recipient-match domain rule).
  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getUser();
  const callerEmail = (sessionData?.user?.email ?? "").toLowerCase();

  const result = await initiatePetTransfer(
    {
      petToken: input.petToken,
      toEmail: input.toEmail,
      reason: input.reason,
      note: input.note ?? null,
      callerEmail,
    },
    {
      repo: TransfersRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R1 (pet_transfer_initiated).
  await flushAuditLog({
    actorUserId: user.id,
    action: "pet_transfer_initiated",
    payload: {
      transfer_public_token: result.value.transferToken,
      pet_id: result.value.petId,
      to_email: input.toEmail,
      to_user_known: !result.value.recipientNeedsInvite,
    },
  });

  // Best-effort invite for recipients without an account.
  if (result.value.recipientNeedsInvite) {
    try {
      const admin = createAdminClient();
      const origin = resolveSiteUrl();
      await admin.auth.admin.inviteUserByEmail(input.toEmail.trim().toLowerCase(), {
        redirectTo: `${origin}/transferencias/${result.value.transferToken}`,
        data: {
          invited_for: "pet_transfer",
          transfer_token: result.value.transferToken,
        },
      });
    } catch (err) {
      // Non-fatal — the transfer row still exists.
      console.error("inviteUserByEmail failed (non-fatal)", err);
    }
  }

  revalidatePath(`/mis-mascotas/${input.petToken}`);
  return { transferToken: result.value.transferToken };
}

// ---------------------------------------------------------------------------
// acceptPetTransferAction — R2: owner→owner accept
// AUTH: recipient USER (id-or-email match, enforced in use-case)
// ---------------------------------------------------------------------------

export type AcceptPetTransferResult = { ok: true } | { error: string };

export async function acceptPetTransferAction(
  transferToken: string,
): Promise<AcceptPetTransferResult> {
  const { user } = await requireUserOrRedirect();

  // Resolve caller email — recipient may have been invited by email only.
  // `emailConfirmed` travels with it: the e-mail arm of the addressee rule is
  // what moves titularidad, and an unproved address is not addressee proof
  // (A09-1).
  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getUser();
  const callerEmail = (sessionData?.user?.email ?? "").toLowerCase();
  const callerEmailConfirmed = sessionData?.user?.email_confirmed_at != null;

  const result = await acceptPetTransfer(
    { transferToken, callerEmail, callerEmailConfirmed },
    {
      repo: TransfersRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R2 (pet_transfer_accepted).
  await flushAuditLog({
    actorUserId: user.id,
    action: "pet_transfer_accepted",
    payload: {
      transfer_public_token: transferToken,
      pet_id: result.value.petId,
      from_user_id: result.value.fromOwnerId,
    },
  });

  // W-2 parity: revalidate specific pet page when publicToken is available
  // (use-case returns petPublicToken if the view was fetched inside the tx).
  if (result.value.petPublicToken) {
    revalidatePath(`/mis-mascotas/${result.value.petPublicToken}`);
  }
  revalidatePath("/mis-mascotas");

  return { ok: true };
}

// ---------------------------------------------------------------------------
// rejectPetTransferAction — R3: owner→owner reject
// AUTH: recipient USER (id-or-email, enforced in use-case)
// ---------------------------------------------------------------------------

export type RejectPetTransferInput = { transferToken: string; reason?: string | null };

export type RejectPetTransferResult = { ok: true } | { error: string };

export async function rejectPetTransferAction(
  input: RejectPetTransferInput,
): Promise<RejectPetTransferResult> {
  const { user } = await requireUserOrRedirect();

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getUser();
  const callerEmail = (sessionData?.user?.email ?? "").toLowerCase();
  const callerEmailConfirmed = sessionData?.user?.email_confirmed_at != null;

  const result = await rejectPetTransfer(
    {
      transferToken: input.transferToken,
      reason: input.reason ?? null,
      callerEmail,
      callerEmailConfirmed,
    },
    {
      repo: TransfersRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R3 (pet_transfer_rejected).
  await flushAuditLog({
    actorUserId: user.id,
    action: "pet_transfer_rejected",
    payload: {
      transfer_public_token: input.transferToken,
      pet_id: result.value.petId,
      reason: input.reason ?? null,
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// cancelPetTransferAction — R4: owner→owner cancel (sender only)
// AUTH: SENDER USER only (fromOwnerId check in use-case)
// ---------------------------------------------------------------------------

export type CancelPetTransferResult = { ok: true } | { error: string };

export async function cancelPetTransferAction(
  transferToken: string,
): Promise<CancelPetTransferResult> {
  const { user } = await requireUserOrRedirect();

  const result = await cancelPetTransfer(
    { transferToken },
    {
      repo: TransfersRepository,
      actor: { user },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R4 (pet_transfer_cancelled).
  await flushAuditLog({
    actorUserId: user.id,
    action: "pet_transfer_cancelled",
    payload: {
      transfer_public_token: transferToken,
      pet_id: result.value.petId,
    },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// getTransferForViewerAction — R5: read-only view
// AUTH: sender OR recipient USER (enforced in use-case via id-or-email match)
// Returns page-compatible shape with petName, petToken, fromDisplayName.
// ---------------------------------------------------------------------------

export type PetTransferStatusForView =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled";

export type GetTransferForViewerResult =
  | {
      ok: true;
      transfer: {
        publicToken: string;
        status: PetTransferStatusForView;
        petName: string;
        petToken: string;
        fromDisplayName: string | null;
        toEmail: string;
        reason: string | null;
        note: string | null;
        expiresAt: string;
        isRecipient: boolean;
        isSender: boolean;
      };
    }
  | { ok: false; error: string };

export async function getTransferForViewerAction(
  transferToken: string,
): Promise<GetTransferForViewerResult> {
  const { user } = await requireUserOrRedirect();

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getUser();
  const callerEmail = (sessionData?.user?.email ?? "").toLowerCase();
  const callerEmailConfirmed = sessionData?.user?.email_confirmed_at != null;

  // Run auth check via use-case (id-or-email match).
  const authResult = await getTransferForViewer(
    { transferToken, callerEmail, callerEmailConfirmed },
    { repo: TransfersRepository, actor: { user } },
  );

  if (!authResult.ok) return { ok: false, error: authResult.error };

  // Fetch joined view data (petName, petToken, fromDisplayName) after auth passes.
  const viewRow = await TransfersRepository.findTransferViewByToken(transferToken);
  if (!viewRow) return { ok: false, error: "Transferencia no encontrada." };

  return {
    ok: true,
    transfer: {
      publicToken: authResult.value.publicToken,
      status: authResult.value.status as PetTransferStatusForView,
      petName: viewRow.petName,
      petToken: viewRow.petToken,
      fromDisplayName: viewRow.fromDisplayName,
      toEmail: viewRow.transfer.toOwnerEmail,
      reason: authResult.value.reason,
      note: authResult.value.note,
      expiresAt: authResult.value.expiresAt,
      isRecipient: authResult.value.isRecipient,
      isSender: authResult.value.isSender,
    },
  };
}

// ---------------------------------------------------------------------------
// expirePetTransfersAction — R6: cron
// AUTH: NONE (CRON_SECRET gated at route level)
// @no-auth-required: invoked only from /api/cron/expire-pet-transfers
// ---------------------------------------------------------------------------

export type ExpirePetTransfersStats = { expired: number; errors: number };

// Keyset/drain bounds (review 23 item 12): bound each pass and drain the
// backlog within the run instead of loading ALL expired transfers at once.
const EXPIRE_TRANSFERS_BATCH_SIZE = 500;
const EXPIRE_TRANSFERS_MAX_DURATION_MS = 45_000;
const EXPIRE_TRANSFERS_MAX_ITERATIONS = 50;

/** System action called by the cron route. Throws on fatal error (cron logs it). */
// @no-auth-required: cron/system path — auth enforced at the /api/cron/expire-pet-transfers route via authorizeCronRequest (CRON_SECRET).
export async function expirePetTransfersAction(opts?: {
  /**
   * The daily dispatcher's fair share, when this runs inside the fleet
   * (RN #9 half b): the deadline becomes min(own ceiling, share handed down)
   * so a late start cannot push the shared function past its 60 s hard kill.
   * Absent (a manual curl, Vercel hitting the route directly) the constant is
   * all there is, unchanged.
   */
  budgetHeaders?: CronBudgetHeaders;
}): Promise<ExpirePetTransfersStats> {
  const start = Date.now();
  const maxDurationMs = opts?.budgetHeaders
    ? effectiveDeadlineMs(EXPIRE_TRANSFERS_MAX_DURATION_MS, opts.budgetHeaders)
    : EXPIRE_TRANSFERS_MAX_DURATION_MS;
  let totalExpired = 0;
  let totalErrors = 0;
  let iterations = 0;

  for (;;) {
    if (iterations >= EXPIRE_TRANSFERS_MAX_ITERATIONS || Date.now() - start >= maxDurationMs) {
      break;
    }

    const result = await expirePetTransfers(
      { repo: TransfersRepository },
      { limit: EXPIRE_TRANSFERS_BATCH_SIZE },
    );
    if (!result.ok) throw new Error(result.error);

    // Flush per-row notifications best-effort.
    await flushNotifications(result.notifications);

    // Parity (R6): audit_log insert per expired row; actor=fromOwnerId per row.
    for (const entry of result.value.auditEntries) {
      await flushAuditLog({
        actorUserId: entry.actorUserId,
        action: "pet_transfer_expired",
        payload: {
          transfer_public_token: entry.transferToken,
          pet_id: entry.petId,
        },
      });
    }

    totalExpired += result.value.expired;
    totalErrors += result.value.errors;
    iterations += 1;

    // A partial batch means no more expirable rows this pass (expired rows drop
    // out of the 'pending' scope). A full batch of expirals → keep draining.
    if (result.value.expired < EXPIRE_TRANSFERS_BATCH_SIZE) break;
  }

  // Surface per-row failures to the caller (cron route) so a run where rows
  // failed to expire reports HTTP 500 instead of a silent success (review 23
  // fleet extension). The use-case already tracks per-row errors; this action
  // previously discarded them.
  return { expired: totalExpired, errors: totalErrors };
}

// ---------------------------------------------------------------------------
// proposeCrossOrgTransferAction — R7: cross-org propose
// AUTH: SENDER ORG (org.transfer.propose) scoped to senderOrgToken
// ---------------------------------------------------------------------------

export type CrossOrgTransferResult = { ok: true; publicCode: string } | { error: string };

export interface ProposeCrossOrgInput {
  senderOrgToken: string;
  petPublicToken: string;
  receiverOrgId: string;
  reason: string;
  notes?: string | null;
}

export async function proposeCrossOrgTransferAction(
  input: ProposeCrossOrgInput,
): Promise<CrossOrgTransferResult> {
  // URL-pinned org resolution (same confused-deputy fix as accept/reject): a
  // multi-org member proposing from /org/{sender}/… must be authorized against
  // the sender org, not the session-default (most-recently-joined) membership.
  // Sender custody (findActiveShelterCustody scoped to org.id) stays enforced
  // inside the use-case.
  const auth = await requireCapabilityForOrgToken("org.transfer.propose", input.senderOrgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const result = await proposeCrossOrgTransfer(
    {
      senderOrgToken: input.senderOrgToken,
      petPublicToken: input.petPublicToken,
      receiverOrgId: input.receiverOrgId,
      reason: input.reason,
      notes: input.notes ?? null,
    },
    {
      repo: TransfersRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R7 (cross_org_transfer_proposed).
  await flushAuditLog({
    actorUserId: user.id,
    action: "cross_org_transfer_proposed",
    payload: {
      case_id: result.value.caseId,
      pet_id: result.value.petId,
      sender_org_id: result.value.senderOrgId,
      receiver_org_id: result.value.receiverOrgId,
      reason: input.reason,
    },
  });

  revalidatePath(`/org/${input.senderOrgToken}/transferencias`);
  return { ok: true, publicCode: result.value.publicCode };
}

// ---------------------------------------------------------------------------
// acceptCrossOrgTransferAction — R8: cross-org accept
// AUTH: RECEIVER ORG (org.transfer.accept) scoped to case.receiverOrganizationId
// CRITICAL: receiver auth is the case's receiverOrganizationId column, NOT bare cap.
// ---------------------------------------------------------------------------

export async function acceptCrossOrgTransferAction(input: {
  receiverOrgToken: string;
  casePublicCode: string;
}): Promise<CrossOrgTransferResult> {
  // Resolve the acting org FROM the receiver URL token, not the session-default
  // (most-recently-joined) membership. A member of several orgs operating under
  // /org/{receiver}/… must be authorized against the receiver org — otherwise
  // the use-case's receiver-token match rejects a legitimate accept with
  // "operando desde una organización distinta a la receiver". org.id vs
  // case.receiverOrganizationId stays enforced inside the use-case (defense in depth).
  const auth = await requireCapabilityForOrgToken("org.transfer.accept", input.receiverOrgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const result = await acceptCrossOrgTransfer(
    {
      receiverOrgToken: input.receiverOrgToken,
      casePublicCode: input.casePublicCode,
    },
    {
      repo: TransfersRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R8 (cross_org_transfer_accepted).
  await flushAuditLog({
    actorUserId: user.id,
    action: "cross_org_transfer_accepted",
    payload: {
      case_id: result.value.caseId,
      pet_id: result.value.petId,
      sender_org_id: result.value.senderOrgId,
      receiver_org_id: result.value.receiverOrgId,
    },
  });

  revalidatePath(`/org/${input.receiverOrgToken}/transferencias/recibidas`);
  return { ok: true, publicCode: result.value.publicCode };
}

// ---------------------------------------------------------------------------
// rejectCrossOrgTransferAction — R9: cross-org reject
// AUTH: RECEIVER ORG (org.transfer.accept) scoped to canonicalReceiverOrgId
// ---------------------------------------------------------------------------

export async function rejectCrossOrgTransferAction(input: {
  receiverOrgToken: string;
  casePublicCode: string;
  reason?: string | null;
  message?: string | null;
}): Promise<CrossOrgTransferResult> {
  // Same URL-pinned org resolution as accept: the receiver's inbox reject must
  // resolve the acting org from the URL token, not the last-joined membership.
  const auth = await requireCapabilityForOrgToken("org.transfer.accept", input.receiverOrgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const result = await rejectCrossOrgTransfer(
    {
      receiverOrgToken: input.receiverOrgToken,
      casePublicCode: input.casePublicCode,
      reason: input.reason ?? null,
      message: input.message ?? null,
    },
    {
      repo: TransfersRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R9 (cross_org_transfer_rejected).
  await flushAuditLog({
    actorUserId: user.id,
    action: "cross_org_transfer_rejected",
    payload: {
      case_id: result.value.caseId,
      pet_id: result.value.petId,
      sender_org_id: result.value.senderOrgId,
      receiver_org_id: result.value.receiverOrgId,
      reason: input.reason ?? null,
    },
  });

  revalidatePath(`/org/${input.receiverOrgToken}/transferencias/recibidas`);
  return { ok: true, publicCode: result.value.publicCode };
}

// ---------------------------------------------------------------------------
// cancelCrossOrgTransferAction — R10: cross-org cancel
// AUTH: SENDER ORG (org.transfer.propose) scoped to case.openedByOrganizationId
// ---------------------------------------------------------------------------

export async function cancelCrossOrgTransferAction(input: {
  senderOrgToken: string;
  casePublicCode: string;
  reason?: string | null;
  message?: string | null;
}): Promise<CrossOrgTransferResult> {
  // Same URL-pinned org resolution as propose: the sender's cancel must resolve
  // the acting org from the URL token, not the last-joined membership. org.id vs
  // case.openedByOrganizationId stays enforced in the use-case (defense in depth).
  const auth = await requireCapabilityForOrgToken("org.transfer.propose", input.senderOrgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const result = await cancelCrossOrgTransfer(
    {
      senderOrgToken: input.senderOrgToken,
      casePublicCode: input.casePublicCode,
      reason: input.reason ?? null,
      message: input.message ?? null,
    },
    {
      repo: TransfersRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);

  // Parity: audit_log insert for R10 (cross_org_transfer_cancelled_by_sender).
  await flushAuditLog({
    actorUserId: user.id,
    action: "cross_org_transfer_cancelled_by_sender",
    payload: {
      case_id: result.value.caseId,
      pet_id: result.value.petId,
      sender_org_id: result.value.senderOrgId,
      receiver_org_id: result.value.receiverOrgId ?? null,
      reason: input.reason ?? null,
    },
  });

  revalidatePath(`/org/${input.senderOrgToken}/transferencias`);
  return { ok: true, publicCode: result.value.publicCode };
}

// ---------------------------------------------------------------------------
// transferCustodyAction — R11: direct org-to-org handoff
// AUTH: SOURCE ORG (custody.transfer) = caller's active org (implicit-org scope)
// CRITICAL: pet ownership row MUST match caller's active organization.id —
//   enforced by repo.findPetUnderOrg scoped to organization.id in use-case.
// ---------------------------------------------------------------------------

export type TransferCustodyFormState = {
  error: string | null;
  /**
   * N3 post-action destination. The action must NOT redirect() — the App
   * Router drops a server action's own redirect in production: the write
   * commits and the screen never moves (lib/ui/full-page-action-nav.ts).
   */
  redirectTo?: string | null;
};

export async function transferCustodyAction(
  orgToken: string,
  publicToken: string,
  _previous: TransferCustodyFormState,
  formData: FormData,
): Promise<TransferCustodyFormState> {
  // URL-pinned org resolution (same confused-deputy fix as propose/accept/reject/
  // cancel): a multi-org member operating from /org/{orgToken}/… must be
  // authorized against THAT org, not the session-default (most-recently-joined)
  // membership. Pet ownership vs organization.id stays enforced inside the
  // use-case via repo.findPetUnderOrg (defense in depth).
  const auth = await requireCapabilityForOrgToken("custody.transfer", orgToken);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  const destinationOrgId = String(formData.get("destinationOrgId") ?? "").trim();
  const newRoleRaw = String(formData.get("newRole") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const result = await transferCustody(
    { petPublicToken: publicToken, destinationOrgId, newRoleRaw, notes },
    {
      repo: TransfersRepository,
      actor: { user, organization },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  // The direct custody handoff now OPENS a receiver-consent handshake instead of
  // an immediate flip — the pet stays under the source org until the receiver
  // accepts. Send the proposer to the transfers hub (where the pending proposal
  // lives), not to a "transferido" toast that would misrepresent an unaccepted
  // proposal as a completed handoff.
  revalidatePath(`/org/${orgToken}/transferencias`);
  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: `/org/${orgToken}/transferencias` };
}
