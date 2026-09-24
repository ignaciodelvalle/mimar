// Public-health alert dispatcher (spec
// 2026-05-19-eno-vet-direct-report-and-owner-alerts §7.2).
//
// Sends a notification to each active human owner / co-owner of a pet
// when a disease in the closed PUBLIC_ALERT_DISEASES set is signaled.
// Org-held pets without a human user have no recipient — skipped here
// (org-side dispatching is a follow-up).
//
// Throttling rule: at most 1 alert per (pet, disease) per 30 days. The
// caller can opt out via `{ skipThrottle: true }` for tests.

import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";

import { type Pet, db, notifications, ownerships } from "@/db";
import {
  type PublicHealthAlert,
  getPublicAlertForDisease,
  renderPublicAlertCopy,
} from "@/lib/reference/disease-public-alert-catalog";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Tx | typeof db;

const THROTTLE_DAYS = 30;
const ALERT_NOTIFICATION_TYPE = "disease_public_alert";

export interface MaybeNotifyOwnersInput {
  pet: Pick<Pet, "id" | "name">;
  diseaseCode: string;
  triggerEventId: string;
  /** Skip the 30-day throttle (used by tests). */
  skipThrottle?: boolean;
}

export interface MaybeNotifyOwnersResult {
  /** The matched alert def — null when the disease isn't in the closed set. */
  alert: PublicHealthAlert | null;
  /** Number of notifications inserted. */
  delivered: number;
  /** True when throttled (an alert for this disease+pet exists in the last 30 days). */
  throttled: boolean;
}

/**
 * Dispatch a public-health alert to all current human owners of the pet
 * when `diseaseCode` is in the curated public-alert catalog. Returns
 * structured info about what was done so the caller can log / audit.
 *
 * Pass `executor` (the tx from db.transaction) to participate in the
 * caller's transaction. Default is db (out-of-tx delivery).
 */
export async function maybeNotifyOwnersOfPublicAlert(
  input: MaybeNotifyOwnersInput,
  executor: Executor = db,
): Promise<MaybeNotifyOwnersResult> {
  const alert = getPublicAlertForDisease(input.diseaseCode);
  if (!alert) return { alert: null, delivered: 0, throttled: false };

  // Resolve current human owners / co-owners. Org-only ownerships have
  // ownerUserId=null and are skipped here (no human to notify).
  const owners = await executor
    .select({ userId: ownerships.ownerUserId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, input.pet.id),
        inArray(ownerships.role, ["owner", "co_owner"]),
        isNull(ownerships.endedAt),
      ),
    );
  const userIds = owners.map((o) => o.userId).filter((id): id is string => typeof id === "string");
  if (userIds.length === 0) {
    return { alert, delivered: 0, throttled: false };
  }

  // Throttle: skip when an alert for the same (pet, disease) was sent
  // in the last 30 days. The notification body carries the disease
  // label so substring-checking is non-trivial; we anchor on the
  // notification_type + relatedPetId + a payload-style title match
  // via sql.
  if (!input.skipThrottle) {
    const since = new Date(Date.now() - THROTTLE_DAYS * 24 * 60 * 60 * 1000);
    const [{ c }] = await executor
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(
          eq(notifications.notificationType, ALERT_NOTIFICATION_TYPE),
          eq(notifications.relatedPetId, input.pet.id),
          gte(notifications.createdAt, since),
          // Match the disease via the title — alert.ownerNotificationTitle
          // is unique per disease.
          sql`${notifications.title} = ${renderPublicAlertCopy(alert, { pet_name: input.pet.name }).title}`,
        ),
      );
    if (c > 0) {
      return { alert, delivered: 0, throttled: true };
    }
  }

  const copy = renderPublicAlertCopy(alert, { pet_name: input.pet.name });
  await executor.insert(notifications).values(
    userIds.map((userId) => ({
      userId,
      notificationType: ALERT_NOTIFICATION_TYPE,
      severity: copy.severity,
      title: copy.title,
      body: copy.body,
      ctaLabel: copy.ctaLabel,
      ctaUrl: copy.ctaUrl,
      relatedPetId: input.pet.id,
      relatedEventId: input.triggerEventId,
    })),
  );

  return { alert, delivered: userIds.length, throttled: false };
}
