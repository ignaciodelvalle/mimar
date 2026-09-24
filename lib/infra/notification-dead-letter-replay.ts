// The replay half of the notification dead-letter drain
// (app/api/cron/drain-notification-dead-letter/route.ts owns the scan, the
// counters and the cron bookkeeping; its header documents the behaviour).
// Lives outside app/ so the route writes nothing but cron_runs
// (lint:app-db-boundary).

import "server-only";

import { eq } from "drizzle-orm";

import { db, notificationDeadLetter, profiles } from "@/db";
import {
  type CreateNotificationInput,
  NOTIFICATION_SEVERITIES,
  createNotification,
} from "@/lib/infra/notification-service";
import { sendPushForNotifications } from "@/lib/infra/web-push";

// Reconstruct a CreateNotificationInput from a stored dead-letter payload. The
// payload was persisted verbatim from the service's insert `values`, so its
// shape is known — but it is jsonb (untyped at rest), so we validate the fields
// the service requires before replaying. Returns null for an unreplayable row.
export function toInput(payload: unknown): CreateNotificationInput | null {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const userId = p.userId;
  const notificationType = p.notificationType;
  const title = p.title;
  const dedupeKey = p.dedupeKey;
  if (
    typeof userId !== "string" ||
    typeof notificationType !== "string" ||
    typeof title !== "string" ||
    typeof dedupeKey !== "string"
  ) {
    return null;
  }
  return {
    userId,
    notificationType,
    title,
    dedupeKey,
    body: typeof p.body === "string" ? p.body : null,
    // Validated against NOTIFICATION_SEVERITIES (A06-G4) rather than a
    // hand-written `===` chain — the chain is what silently dropped
    // "success" after it joined the service's type on 2026-08-19.
    severity: (NOTIFICATION_SEVERITIES as readonly unknown[]).includes(p.severity)
      ? (p.severity as CreateNotificationInput["severity"])
      : undefined,
    category: typeof p.category === "string" ? p.category : null,
    ctaLabel: typeof p.ctaLabel === "string" ? p.ctaLabel : null,
    ctaUrl: typeof p.ctaUrl === "string" ? p.ctaUrl : null,
    relatedPetId: typeof p.relatedPetId === "string" ? p.relatedPetId : null,
    relatedEventId: typeof p.relatedEventId === "string" ? p.relatedEventId : null,
    relatedReminderId: typeof p.relatedReminderId === "string" ? p.relatedReminderId : null,
    relatedCaseId: typeof p.relatedCaseId === "string" ? p.relatedCaseId : null,
  };
}

/**
 * What a resolved dead letter keeps of its payload: nothing. `payload` is NOT
 * NULL, so the redaction is the empty object — which `toInput` refuses, so a
 * redacted row can never be replayed even if something un-resolves it.
 */
const REDACTED_PAYLOAD = {};

/**
 * What a resolved dead letter keeps of its error_message. Same literal as
 * erase_subject_data and the 0228 backfill.
 */
const REDACTED_ERROR_MESSAGE = "[redacted]";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Mark a row resolved AND drop its payload and error_message, in one statement. */
export async function resolveAndRedact(
  client: typeof db | Tx,
  id: string,
  now: Date,
): Promise<void> {
  await client
    .update(notificationDeadLetter)
    .set({
      retriedAt: now,
      resolvedAt: now,
      payload: REDACTED_PAYLOAD,
      errorMessage: REDACTED_ERROR_MESSAGE,
    })
    .where(eq(notificationDeadLetter.id, id));
}

export type ReplayOutcome = "inserted" | "duplicate" | "dead_lettered" | "erased" | "gone";

/**
 * Replay one dead letter under the locks described in the header (LOW-1):
 * profile FOR SHARE, then the dead-letter row FOR UPDATE, then re-check both
 * before the insert. The push leg has no timeout (web-push / Expo push), and a
 * stalled push must not hold the profile's FOR SHARE lock — that lock is what
 * an art. 16 erasure's first write (UPDATE profiles) blocks on, and a push
 * stuck past PostgREST's statement_timeout would carry the erasure with it.
 * So createNotification runs here with `suppressPush: true` (in-app row only)
 * and, once the transaction has committed, the push is sent separately for a
 * row that actually landed. A post-commit push to a subject erased in the
 * meantime is safe: the erasure's own scrub already ran, so there is no
 * push_subscriptions row left to send to.
 */
export async function replayLocked(id: string, input: CreateNotificationInput, now: Date) {
  const outcome = await db.transaction(async (tx): Promise<ReplayOutcome> => {
    const [profile] = await tx
      .select({ deletedAt: profiles.deletedAt })
      .from(profiles)
      .where(eq(profiles.id, input.userId))
      .for("share");
    const [current] = await tx
      .select({
        resolvedAt: notificationDeadLetter.resolvedAt,
        payload: notificationDeadLetter.payload,
      })
      .from(notificationDeadLetter)
      .where(eq(notificationDeadLetter.id, id))
      .for("update");
    // Resolved or redacted since the scan — by another run or by the erasure.
    if (!current || current.resolvedAt !== null || toInput(current.payload) === null) {
      return "gone";
    }
    // An erased recipient is not an error and not a delivery: the notification
    // must not be re-created for a subject who exercised art. 16.
    if (profile?.deletedAt != null) {
      await resolveAndRedact(tx, id, now);
      return "erased";
    }
    // createNotification never throws — it re-dead-letters on failure — so a
    // single bad row cannot poison the batch. suppressPush keeps the push leg
    // out of this transaction (see the function doc above).
    const result = await createNotification({ ...input, suppressPush: true });
    await resolveAndRedact(tx, id, now);
    return result.status;
  });
  // Only a row that actually landed as a NEW notification gets pushed — a
  // "duplicate" outcome must not re-push (same rule createNotification itself
  // applies), and "gone" / "erased" never had a row to push for.
  if (outcome === "inserted") {
    await sendPushForNotifications([
      {
        userId: input.userId,
        severity: input.severity ?? "info",
        notificationType: input.notificationType,
        title: input.title,
        body: input.body,
        ctaUrl: input.ctaUrl,
        dedupeKey: input.dedupeKey,
      },
    ]);
  }
  return outcome;
}
