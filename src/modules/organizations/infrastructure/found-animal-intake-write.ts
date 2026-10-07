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
  isIntakeCapacityStatus,
  isIntakeContactKind,
} from "@/src/modules/organizations/domain/found-animal-intake";

/** The org's current settings, or null when it never saved any (= off). */
export async function readFoundAnimalIntake(
  organizationId: string,
): Promise<FoundAnimalIntakeSettings | null> {
  const [row] = await db
    .select({
      accepting: orgFoundAnimalIntake.accepting,
      capacityStatus: orgFoundAnimalIntake.capacityStatus,
      publicContactKind: orgFoundAnimalIntake.publicContactKind,
      publicContactValue: orgFoundAnimalIntake.publicContactValue,
      publicHours: orgFoundAnimalIntake.publicHours,
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
