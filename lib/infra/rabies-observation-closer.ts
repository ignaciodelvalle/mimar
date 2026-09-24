// SHIM — delegates to src/modules/surveillance/application/close-eligible-observations.
// All importers (cron route, CLI script, __tests__) continue to work unchanged.
// Delete this file when all importers are repointed to the module directly (WU-5).
//
// The shim wraps the use-case function so it matches the original signature exactly:
//   closeEligibleRabiesObservations(options?: { now?: Date })
// and delegates to the module use-case with the real DB-backed deps injected.

import { db } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import {
  type CloseRabiesObservationsStats,
  closeEligibleObservations,
} from "@/src/modules/surveillance/application/close-eligible-observations";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";

export type { CloseRabiesObservationsStats };

const repo = new SurveillanceRepository();

export async function closeEligibleRabiesObservations(options?: {
  now?: Date;
  afterId?: string | null;
  limit?: number;
}): Promise<CloseRabiesObservationsStats> {
  return closeEligibleObservations(options ?? {}, {
    repo,
    transaction: db.transaction.bind(db),
    createNotificationsBulk: (inputs) => createNotificationsBulk(inputs),
    // Route label lives at the composition root so an empty fan-out's audit row
    // names the notification that went nowhere.
    findAuthoritiesForJurisdiction: (jurisdiction) =>
      findAuthoritiesForJurisdiction(jurisdiction, {
        route: "rabies_observation_pending_review",
      }),
  });
}
