// org_found_animal_intake — the settings row's read (for its own admins) and
// its one writer (migration 0292).
//
// The writer sets the transaction-local `app.actor_user_id` before it writes:
// the row trigger that audits every change (org_found_animal_intake_changed)
// takes the actor from there when there is no PostgREST auth.uid(), and
// REFUSES a write with neither. So this is not a nicety — a Drizzle write
// without it fails.

import { eq, sql } from "drizzle-orm";

import { db, orgFoundAnimalIntake } from "@/db";
import {
  type FoundAnimalIntakeSettings,
  INTAKE_CONFIRMATION_DAYS,
  isIntakeCapacityStatus,
  isIntakeContactKind,
} from "@/src/modules/organizations/domain/found-animal-intake";

/**
 * The org's current settings, or null when it never saved any (= off).
 * `confirmationExpired`: the card was last saved more than
 * INTAKE_CONFIRMATION_DAYS ago (on the DB clock) — the settings card reminds
 * the admin, because the public list already shows "Recibimos" as
 * "Consultar antes".
 */
export async function readFoundAnimalIntake(
  organizationId: string,
): Promise<(FoundAnimalIntakeSettings & { confirmationExpired: boolean }) | null> {
  const [row] = await db
    .select({
      accepting: orgFoundAnimalIntake.accepting,
      capacityStatus: orgFoundAnimalIntake.capacityStatus,
      publicContactKind: orgFoundAnimalIntake.publicContactKind,
      publicContactValue: orgFoundAnimalIntake.publicContactValue,
      publicHours: orgFoundAnimalIntake.publicHours,
      confirmationExpired: sql<boolean>`(${orgFoundAnimalIntake.updatedAt} < now() - make_interval(days => ${INTAKE_CONFIRMATION_DAYS}::int))`,
    })
    .from(orgFoundAnimalIntake)
    .where(eq(orgFoundAnimalIntake.organizationId, organizationId))
    .limit(1);
  if (!row) return null;
  return {
    accepting: row.accepting,
    capacityStatus: isIntakeCapacityStatus(row.capacityStatus) ? row.capacityStatus : "recibimos",
    publicContactKind:
      row.publicContactKind && isIntakeContactKind(row.publicContactKind)
        ? row.publicContactKind
        : null,
    publicContactValue: row.publicContactKind ? row.publicContactValue : null,
    publicHours: row.publicHours,
    confirmationExpired: row.confirmationExpired === true,
  };
}

/** Insert or update the org's row, attributed to `actorUserId` in the audit. */
export async function upsertFoundAnimalIntake(
  organizationId: string,
  settings: FoundAnimalIntakeSettings,
  actorUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.actor_user_id', ${actorUserId}, true)`);
    const values = {
      accepting: settings.accepting,
      capacityStatus: settings.capacityStatus,
      publicContactKind: settings.publicContactKind,
      publicContactValue: settings.publicContactValue,
      publicHours: settings.publicHours,
    };
    await tx
      .insert(orgFoundAnimalIntake)
      .values({ organizationId, ...values })
      .onConflictDoUpdate({ target: orgFoundAnimalIntake.organizationId, set: values });
  });
}
