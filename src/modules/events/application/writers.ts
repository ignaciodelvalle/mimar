// ---------------------------------------------------------------------------
// Backwards-compatible 1-arg writer wrappers for integration tests.
//
// The module use-cases take (params, deps). Integration tests and any caller
// that imports the writers directly use the original 1-arg API where deps were
// hard-coded to use `db` + `EventsRepository` directly. These wrappers fill in
// deps automatically so existing callers remain unmodified.
//
// Import from here (not from @/src/modules/events/actions) — this is a server-only
// module and must NOT be imported by Client Components.
// ---------------------------------------------------------------------------

import { db, notifications } from "@/db";
import { enqueueEnoTrigger as _enqueueEnoTrigger } from "@/src/modules/surveillance/application/enqueue-eno-trigger";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";
import { EventsRepository } from "../infrastructure/events-repository";
import { recordDiseaseDiagnosisWriter as _recordDiseaseDiagnosisWriter } from "./clinical/record-disease-diagnosis-use-case";
import type { RecordDiseaseDiagnosisWriterInput as RecordDiseaseDiagnosisWriterParams } from "./clinical/record-disease-diagnosis-use-case";
import { setPetLostWriter as _setPetLostWriter } from "./lifecycle/set-pet-lost-use-case";
import type { SetPetLostWriterParams } from "./lifecycle/set-pet-lost-use-case";
import { createSymptomObservedWriter as _createSymptomObservedWriter } from "./surveillance/symptom-observed-use-case";
import type { CreateSymptomObservedWriterParams } from "./surveillance/symptom-observed-use-case";

function makeTransaction(): <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> {
  return <T>(cb: (tx: unknown) => Promise<T>) =>
    db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>;
}

const surveillanceRepo = new SurveillanceRepository();

/**
 * In-transaction ENO enqueue dep (P1-3 durability). Passes the diagnosis tx as
 * the executor so the eno_processing_queue row is atomic with the event insert;
 * DB errors propagate to roll the tx back. Idempotent on pet_event_id.
 */
async function enqueueEnoTriggerInTx(
  petEvent: {
    id: string;
    petId: string;
    authorRole: string;
    recordedByUserId: string | null;
    authorOrganizationId: string | null;
    payload: Record<string, unknown>;
  },
  tx: unknown,
): Promise<void> {
  await _enqueueEnoTrigger(petEvent, { repo: surveillanceRepo, executor: tx });
}

/**
 * Write the notifications a use-case decided on, AFTER its transaction closed.
 *
 * EXPORTED, AND NOT MOVED. `POST /api/v1/pets/{token}/events` needs this the
 * moment a kind whose write fans out reaches it — síntoma does — and the
 * obvious tidy-up was to lift the function into its own module that this file
 * and `actions.ts` both import. It was tried and TWO fences refused it, for
 * reasons better than tidiness:
 *
 *   · `lint:notifications` bans `db.insert(notifications)` in any file not in
 *     `scripts/notifications-service-baseline.json`, whose list "only ever
 *     shrinks". A new module holding this insert is baseline GROWTH, and the
 *     intent is to migrate these two sites onto `createNotification()` /
 *     `createNotificationsBulk()` — not to add a third.
 *   · `lint:audit-log` resolves reachability ONE HOP. The twin copy inside
 *     `actions.ts` is the only direct mutation left in that module, and it is
 *     what lets that fence still see that `orgRecordNoteAction` mutates. Its
 *     own docblock there carries the evidence.
 *
 * So the duplicate stays and this one is shared instead. When the migration to
 * the notification service happens, both disappear together.
 *
 * WHY IT RUNS OUTSIDE THE TRANSACTION at all: a notification is a CONSEQUENCE
 * of a fact, not part of it. A failed insert here must never roll back the
 * append that earned it — `__tests__/notifications-outside-tx.test.ts` is the
 * fence that keeps that true — which is why the catch swallows.
 */
export async function flushNotifications(
  pending: import("./types").NewNotification[],
): Promise<void> {
  if (pending.length === 0) return;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: NewNotification is structurally compatible with notifications.$inferInsert
    await db.insert(notifications).values(pending as any[]);
    // Web Push leg (ADR 2026-07-18 §4): urgent-only, best-effort, never throws.
    const { sendPushForNotifications } = await import("@/lib/infra/web-push");
    await sendPushForNotifications(pending);
  } catch (e) {
    console.error("notifications insert failed (writer succeeded)", e);
  }
}

/**
 * Backwards-compatible 1-arg wrapper for recordDiseaseDiagnosisWriter.
 * Integration tests call this with one argument; deps are filled automatically.
 */
export async function recordDiseaseDiagnosisWriter(params: RecordDiseaseDiagnosisWriterParams) {
  const repo = new EventsRepository();
  return _recordDiseaseDiagnosisWriter(params, {
    repo,
    transaction: makeTransaction(),
    flushNotifications,
    enqueueEnoTrigger: enqueueEnoTriggerInTx,
  });
}

/**
 * Backwards-compatible 1-arg wrapper for createSymptomObservedWriter.
 * Integration tests call this with one argument; deps are filled automatically.
 * Note: rabiesObservationStatus defaults to null when not supplied.
 */
export async function createSymptomObservedWriter(
  params: Omit<CreateSymptomObservedWriterParams, "rabiesObservationStatus"> & {
    rabiesObservationStatus?: string | null;
  },
) {
  const repo = new EventsRepository();
  return _createSymptomObservedWriter(
    { ...params, rabiesObservationStatus: params.rabiesObservationStatus ?? null },
    {
      repo,
      transaction: makeTransaction(),
      flushNotifications,
    },
  );
}

/**
 * Backwards-compatible 1-arg wrapper for setPetLostWriter.
 * Integration tests call this with one argument; deps are filled automatically.
 */
export async function setPetLostWriter(params: SetPetLostWriterParams) {
  const repo = new EventsRepository();
  const { broadcastLostPet } = await import("@/lib/infra/lost-pet-broadcast");
  return _setPetLostWriter(params, {
    repo,
    transaction: makeTransaction(),
    broadcastLostPet: broadcastLostPet as Parameters<
      typeof _setPetLostWriter
    >[1]["broadcastLostPet"],
  });
}
