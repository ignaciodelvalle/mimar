"use server";

// Thin action controllers for the caretakers domain.
//
// Each action does ONLY:
//   1. Auth guard at the edge — the security boundary.
//   2. Parse the raw input.
//   3. Build deps (repo, clock, transaction) and call the use-case.
//   4. Map UseCaseResult<T> onto { error } / { ok }.
//   5. Flush notifications post-tx, best-effort (catch + log, never throw).
//   6. revalidatePath.
//
// NO business logic. Reference shape: src/modules/transfers/actions.ts.
//
// AUTH-SCOPE CONTRACT — the asymmetry that defines this module:
//   - designate / cancel / revoke are TITULAR actions → `requireTitularAccess`.
//     A caretaker holds a Path-1 ownership row and would pass
//     `requirePetAccess`; naming a sub-caretaker is deny-list row
//     `caretaker-sub-designation`.
//   - accept / reject / withdraw are INVITEE actions → `requireUserOrRedirect`
//     plus the id-or-email match inside the use-case. The accepting user holds
//     NO ownership row on the pet yet, so a pet-scoped guard is not merely
//     unnecessary here, it is impossible: there is nothing for it to resolve.
//     Same shape as `acceptPetTransferAction`.

import { auditLog, db } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { type CronBudgetHeaders, effectiveDeadlineMs } from "@/lib/infra/cron-dispatcher";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parseArDateEndOfDay, parseArDateStartOfDay } from "@/lib/utils/date-input-ar";
import { revalidatePath } from "next/cache";

import { acceptCaretakerGrant } from "./application/accept-caretaker-grant";
import { cancelCaretakerGrant } from "./application/cancel-caretaker-grant";
import { designateCaretaker } from "./application/designate-caretaker";
import { endCaretakerGrant } from "./application/end-caretaker-grant";
import { expireCaretakerGrants } from "./application/expire-caretaker-grants";
import { rejectCaretakerGrant } from "./application/reject-caretaker-grant";
import { CaretakersRepository } from "./infrastructure/caretakers-repository";

import type { NewNotification } from "./application/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Flush notifications post-tx, best-effort. Never throws.
 *
 * Routed through the canonical write path (lib/infra/notification-service.ts)
 * rather than a raw insert straight into the `notifications` table. The sibling
 * modules (adoption, foster, transfers) still hold their own copy of that raw
 * insert and are grandfathered into scripts/notifications-service-baseline.json;
 * this module is NOT in that baseline and must never be added to it. The
 * service buys two things the raw insert cannot:
 *   - IDEMPOTENCY — ON CONFLICT (dedupe_key) DO NOTHING, which matters most for
 *     the cron path, where a retried sweep would otherwise re-announce an
 *     expiry that already happened.
 *   - DURABILITY — a failed insert is dead-lettered instead of vanishing into a
 *     console.error, so "a veces no aparecen" becomes recoverable.
 *
 * The ARCH-P posture is unchanged: this runs OUTSIDE the business transaction
 * and swallows everything. `createNotificationsBulk` already never throws; the
 * try/catch stays as the belt to that brace, because an action that already
 * succeeded must not be reported as failed over a notification.
 */
async function flushNotifications(pending: NewNotification[]): Promise<void> {
  if (pending.length === 0) return;
  try {
    await createNotificationsBulk(pending);
  } catch (e) {
    console.error("[caretakers/actions] notifications insert failed (action did succeed):", e);
  }
}

/** Insert a single audit_log row post-tx, best-effort. Never throws. */
async function flushAuditLog(entry: {
  actorUserId: string;
  action: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLog).values(entry as typeof auditLog.$inferInsert);
  } catch (e) {
    console.error("[caretakers/actions] auditLog insert failed (action did succeed):", e);
  }
}

function deps() {
  return {
    repo: CaretakersRepository,
    now: () => new Date(),
    transaction: db.transaction.bind(db) as <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>,
  };
}

/**
 * Caller's authenticated email — the invitation may be addressed to it — AND
 * whether anybody ever proved the account controls it.
 *
 * The two travel together on purpose (A09-1): the address alone is what the
 * e-mail arm of the addressee match compares, and comparing it without the
 * confirmation term treats "I typed this at signup" as "I read this mailbox".
 */
async function callerIdentity(): Promise<{ email: string; emailConfirmed: boolean }> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  return {
    email: (data?.user?.email ?? "").toLowerCase(),
    emailConfirmed: data?.user?.email_confirmed_at != null,
  };
}

// ---------------------------------------------------------------------------
// designateCaretakerAction — the titular invites someone
// AUTH: requireTitularAccess (deny-list row caretaker-sub-designation)
// ---------------------------------------------------------------------------

export type DesignateCaretakerActionInput = {
  petPublicToken: string;
  inviteeEmail: string;
  startsAt: string;
  endsAt: string;
  note?: string | null;
};

export type DesignateCaretakerActionResult = { grantToken: string } | { error: string };

export async function designateCaretakerAction(
  input: DesignateCaretakerActionInput,
): Promise<DesignateCaretakerActionResult> {
  const access = await requireTitularAccess(input.petPublicToken);
  if (!access.ok) return { error: access.error };

  const startsAt = parseArDateStartOfDay(input.startsAt) ?? new Date();
  const endsAt = parseArDateEndOfDay(input.endsAt);
  if (!endsAt) {
    // The spec's first scenario: `endsAt` is REQUIRED. Caught here rather than
    // in the domain because an unparseable string is not a period rule.
    return { error: "Indicá hasta qué fecha va el cuidado." };
  }

  const result = await designateCaretaker(
    {
      petId: access.pet.id,
      petName: access.pet.name,
      petPublicToken: input.petPublicToken,
      titularUserId: access.user.id,
      inviteeEmail: input.inviteeEmail,
      startsAt,
      endsAt,
      note: input.note ?? null,
    },
    deps(),
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  await flushAuditLog({
    actorUserId: access.user.id,
    action: "caretaker_designated",
    payload: {
      grant_public_token: result.value.grantPublicToken,
      pet_id: access.pet.id,
      // The invitee's email is PII belonging to a third party. It is already
      // stored on the grant row (under the pii baseline) and the audit entry
      // needs to say WHO was invited, so it rides — but nothing beyond it does.
      to_email: result.value.inviteeEmail,
      to_user_known: !result.value.inviteeNeedsAccount,
    },
  });

  // Best-effort invite for an invitee with no account. Non-fatal: the grant row
  // exists either way and the titular can resend the link by hand.
  if (result.value.inviteeNeedsAccount) {
    try {
      const admin = createAdminClient();
      const origin = resolveSiteUrl();
      await admin.auth.admin.inviteUserByEmail(result.value.inviteeEmail, {
        redirectTo: `${origin}/cuidado/${result.value.grantPublicToken}`,
        data: {
          invited_for: "pet_caretaker",
          grant_token: result.value.grantPublicToken,
        },
      });
    } catch (err) {
      console.error("[caretakers] inviteUserByEmail failed (non-fatal)", err);
    }
  }

  revalidatePath(`/mis-mascotas/${input.petPublicToken}`);
  return { grantToken: result.value.grantPublicToken };
}

// ---------------------------------------------------------------------------
// acceptCaretakerGrantAction — the INVITEE accepts
// AUTH: requireUserOrRedirect + id-or-email match in the use-case
// ---------------------------------------------------------------------------

export type AcceptCaretakerGrantActionResult = { ok: true } | { error: string };

export async function acceptCaretakerGrantAction(input: {
  grantToken: string;
  /** KEY 2 of the two-key public-contact model. Absent = not consented. */
  publicContactConsent?: boolean;
}): Promise<AcceptCaretakerGrantActionResult> {
  const { user } = await requireUserOrRedirect();
  const caller = await callerIdentity();

  const result = await acceptCaretakerGrant(
    {
      grantPublicToken: input.grantToken,
      callerUserId: user.id,
      callerEmail: caller.email,
      callerEmailConfirmed: caller.emailConfirmed,
      publicContactConsent: input.publicContactConsent === true,
    },
    deps(),
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  await flushAuditLog({
    actorUserId: user.id,
    action: "caretaker_grant_accepted",
    payload: {
      grant_public_token: input.grantToken,
      public_contact_consent: input.publicContactConsent === true,
    },
  });

  if (result.value.petPublicToken) {
    revalidatePath(`/mis-mascotas/${result.value.petPublicToken}`);
  }
  revalidatePath("/mis-mascotas");
  revalidatePath(`/cuidado/${input.grantToken}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// rejectCaretakerGrantAction — the INVITEE declines
// AUTH: requireUserOrRedirect + id-or-email match in the use-case
// ---------------------------------------------------------------------------

export type RejectCaretakerGrantActionResult = { ok: true } | { error: string };

export async function rejectCaretakerGrantAction(input: {
  grantToken: string;
}): Promise<RejectCaretakerGrantActionResult> {
  const { user } = await requireUserOrRedirect();
  const caller = await callerIdentity();

  const result = await rejectCaretakerGrant(
    {
      grantPublicToken: input.grantToken,
      callerUserId: user.id,
      callerEmail: caller.email,
      callerEmailConfirmed: caller.emailConfirmed,
    },
    { repo: CaretakersRepository, now: () => new Date() },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  // A grant ENDING is the half of the lifecycle someone asks about afterwards —
  // who ended it, when, on whose initiative. Missing until 2026-08-23: the sweep
  // that added audit rows to this module flagged only `withdraw`, so reject and
  // cancel stayed silent alongside it.
  await flushAuditLog({
    actorUserId: user.id,
    action: "caretaker_grant_rejected",
    payload: { grant_public_token: input.grantToken, pet_id: result.value.petId },
  });
  revalidatePath(`/cuidado/${input.grantToken}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// cancelCaretakerGrantAction — the titular withdraws a PENDING invitation
// AUTH: requireTitularAccess
// ---------------------------------------------------------------------------

export type CancelCaretakerGrantActionResult = { ok: true } | { error: string };

export async function cancelCaretakerGrantAction(input: {
  petPublicToken: string;
  grantToken: string;
}): Promise<CancelCaretakerGrantActionResult> {
  const access = await requireTitularAccess(input.petPublicToken);
  if (!access.ok) return { error: access.error };

  const result = await cancelCaretakerGrant(
    { grantPublicToken: input.grantToken, titularUserId: access.user.id },
    { repo: CaretakersRepository, now: () => new Date() },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  // Distinct from `caretaker_grant_revoked`: that one ends an ACTIVE
  // arrangement, this one withdraws an invitation nobody accepted yet. Same
  // actor, different fact, and the audit trail has to be able to tell them
  // apart — "the titular cancelled before it started" is not "the titular cut a
  // live custody short".
  await flushAuditLog({
    actorUserId: access.user.id,
    action: "caretaker_grant_cancelled",
    payload: { grant_public_token: input.grantToken, pet_id: result.value.petId },
  });
  revalidatePath(`/mis-mascotas/${input.petPublicToken}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// revokeCaretakerGrantAction — "Finalizar ahora", the titular ends an ACTIVE
// arrangement unilaterally and immediately.
// AUTH: requireTitularAccess
// ---------------------------------------------------------------------------

export type RevokeCaretakerGrantActionResult = { ok: true } | { error: string };

export async function revokeCaretakerGrantAction(input: {
  petPublicToken: string;
  grantToken: string;
}): Promise<RevokeCaretakerGrantActionResult> {
  const access = await requireTitularAccess(input.petPublicToken);
  if (!access.ok) return { error: access.error };

  const result = await endCaretakerGrant(
    { grantPublicToken: input.grantToken, action: "revoke", actorUserId: access.user.id },
    deps(),
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  await flushAuditLog({
    actorUserId: access.user.id,
    action: "caretaker_grant_revoked",
    payload: { grant_public_token: input.grantToken, pet_id: access.pet.id },
  });

  revalidatePath(`/mis-mascotas/${input.petPublicToken}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// withdrawCaretakerGrantAction — the CARETAKER steps down.
// AUTH: requireUserOrRedirect. The caretaker DOES hold an ownership row here,
// so requirePetAccess would resolve — but it would also let the titular pass,
// and "the titular withdrew on the caretaker's behalf" is a different fact.
// The use-case checks actorUserId === grant.caretakerUserId.
// ---------------------------------------------------------------------------

export type WithdrawCaretakerGrantActionResult = { ok: true } | { error: string };

export async function withdrawCaretakerGrantAction(input: {
  grantToken: string;
}): Promise<WithdrawCaretakerGrantActionResult> {
  const { user } = await requireUserOrRedirect();

  const result = await endCaretakerGrant(
    { grantPublicToken: input.grantToken, action: "withdraw", actorUserId: user.id },
    deps(),
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications);
  // The caretaker ending it themselves. The counterpart of
  // `caretaker_grant_revoked` and deliberately not the same action: the actor
  // is the other party, and "who walked away" is the whole question if the
  // animal's whereabouts are later disputed.
  await flushAuditLog({
    actorUserId: user.id,
    action: "caretaker_grant_withdrawn",
    payload: { grant_public_token: input.grantToken, pet_id: result.value.petId },
  });
  revalidatePath("/mis-mascotas");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// expireCaretakerGrantsAction — the daily sweep. System path.
// ---------------------------------------------------------------------------

export type ExpireCaretakerGrantsActionStats = {
  invitationsExpired: number;
  grantsEnded: number;
  remindersSent: number;
  errors: number;
};

// Keyset/drain bounds, the expirePetTransfersAction shape: bound each pass and
// drain the backlog WITHIN the run instead of loading every expirable row at
// once. The dispatcher's whole-fleet budget is 55s; this job's slice is 45.
const EXPIRE_BATCH_SIZE = 500;
const EXPIRE_MAX_DURATION_MS = 45_000;
const EXPIRE_MAX_ITERATIONS = 50;

/** System action called by the cron route. Throws on fatal error (cron logs it). */
// @no-auth-required: cron/system path — auth enforced at the /api/cron/expire-caretaker-grants route via authorizeCronRequest (CRON_SECRET).
export async function expireCaretakerGrantsAction(opts?: {
  /**
   * The daily dispatcher's fair share, when this runs inside the fleet
   * (RN #9 half b): the deadline becomes min(own ceiling, share handed down)
   * so a late start cannot push the shared function past its 60 s hard kill.
   * Absent (a manual curl, Vercel hitting the route directly) the constant is
   * all there is, unchanged.
   */
  budgetHeaders?: CronBudgetHeaders;
}): Promise<ExpireCaretakerGrantsActionStats> {
  const start = Date.now();
  const maxDurationMs = opts?.budgetHeaders
    ? effectiveDeadlineMs(EXPIRE_MAX_DURATION_MS, opts.budgetHeaders)
    : EXPIRE_MAX_DURATION_MS;
  const total: ExpireCaretakerGrantsActionStats = {
    invitationsExpired: 0,
    grantsEnded: 0,
    remindersSent: 0,
    errors: 0,
  };
  let iterations = 0;

  for (;;) {
    if (iterations >= EXPIRE_MAX_ITERATIONS || Date.now() - start >= maxDurationMs) {
      break;
    }

    const result = await expireCaretakerGrants(deps(), { limit: EXPIRE_BATCH_SIZE });
    if (!result.ok) throw new Error(result.error);

    await flushNotifications(result.notifications);

    total.invitationsExpired += result.value.invitationsExpired;
    total.grantsEnded += result.value.grantsEnded;
    total.remindersSent += result.value.remindersSent;
    total.errors += result.value.errors;
    iterations += 1;

    // A partial batch in EVERY pass means the backlog is drained: each pass's
    // scan predicate excludes the rows it just resolved, so a full batch is the
    // only signal that more remain.
    const drained =
      result.value.invitationsExpired < EXPIRE_BATCH_SIZE &&
      result.value.grantsEnded < EXPIRE_BATCH_SIZE &&
      result.value.remindersSent < EXPIRE_BATCH_SIZE;
    if (drained) break;
  }

  // Per-row failures must NOT report success: the route flips the run to failed
  // so it alerts and Vercel retries.
  return total;
}

// ---------------------------------------------------------------------------
// Input parsing
//
// The dates arrive from two `<input type="date">` fields as bare "YYYY-MM-DD".
// This file used to parse them with a local `new Date(raw)` helper, which is
// MIDNIGHT UTC = 21:00 ART of the day BEFORE. Every AR-pinned formatter in the
// product then rendered the period one day early — a grant ending on the 15th
// told both parties "terminó el 14/09" — and the expiry cron closed access a
// full day sooner than the titular had promised.
//
// The boundary helpers in lib/utils/format.ts are AR-pinned and asymmetric on
// purpose: a period starts at the first instant of its first Argentine day and
// ends at the LAST instant of its last one, so "hasta el 15/09" means the
// caretaker still has access at 23:00 on the 15th. `parseDateInput` (noon UTC)
// was NOT the right reuse here — it exists to make a date DISPLAY correctly,
// and noon UTC is 09:00 ART, which would end the arrangement mid-morning.
// ---------------------------------------------------------------------------
