// May THIS clinic record a death during THIS rabies observation?
//
// Walk-in trust is how the atender portal works: a vet with a validated licence
// at an org with event-write scans the pet's QR and records what they saw. That
// is proportionate for a vaccine or a check-up, and for the professional CLOSE
// of an observation (an outcome that other actors can still contradict).
//
// A death is different: `death_recorded` is terminal and runs the whole death
// cascade (ownerships end, the credential goes dark, the owners and the
// authority are alerted). The public code is on the QR, so without a second
// anchor any licensed vet in the country could end any pet under observation
// (security review 2026-09-18, MEDIUM D8). The anchor is either of:
//
//   · the clinic sits in the same PROVINCE as the animal — the ordinary case: a
//     vet in the animal's own area. Province, not locality: a clinic serves
//     neighbouring localities, and the observation vet is often not in the
//     owner's own barrio; or
//   · the clinic has ALREADY signed an event on this animal since the
//     observation started — it is demonstrably the clinic doing the
//     observation, wherever it is.
//
// Anything else fails closed with a message that points at the authority.

import { and, eq, gte } from "drizzle-orm";

import { db, organizations, petEvents } from "@/db";

export async function clinicMayRecordObservationDeath(input: {
  organizationId: string;
  petId: string;
  petProvince: string | null;
  observationStartedAt: Date | null;
}): Promise<boolean> {
  const [org] = await db
    .select({ province: organizations.jurisdictionProvince })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!org) return false;

  if (org.province !== null && input.petProvince !== null && org.province === input.petProvince) {
    return true;
  }

  if (!input.observationStartedAt) return false;
  const [signed] = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, input.petId),
        eq(petEvents.authorOrganizationId, input.organizationId),
        gte(petEvents.occurredAt, input.observationStartedAt),
      ),
    )
    .limit(1);
  return Boolean(signed);
}
