// Pure audience filter for Face 2 (Libreta) — pet-document-redesign ADR-10.
// Replaces the old 3-way lens system (Todo/Vacunas/Oficial + chips) with a
// single consolidated timeline: owners see everything, org/vet viewers see
// only the libreta-sanitaria-relevant subset ("oficial", unchanged
// whitelist). There is no user-facing toggle anymore — the audience is
// derived entirely from `isOwner`.

import { isLibretaSanitariaEvent } from "@/lib/infra/libreta-sanitaria";

export type LibretaAudience = "owner" | "org";

/**
 * Filters a past (historial) event by audience.
 *   owner — everything.
 *   org   — the full LIBRETA_SANITARIA_EVENT_TYPES whitelist only (same
 *           predicate the old "oficial" lens used).
 */
export function pastEventMatchesAudience(eventType: string, audience: LibretaAudience): boolean {
  if (audience === "owner") return true;
  return isLibretaSanitariaEvent(eventType);
}
