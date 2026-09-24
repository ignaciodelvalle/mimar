// Discovery-only jurisdiction gating for physical-tag surfaces (design D6).
//
// The `physical_credential_channels.engraved_plate` business rule gates
// DISCOVERY (the /cuenta/chapas nav entry and chapita interest CTAs), NEVER
// resolution or activation: a shipped tag must keep working — /t/[serial] and
// /cuenta/chapas/activar stay reachable regardless of the rule — because a
// rule flip must not strand a chapa that is already on a collar.
//
// Visibility = "the user already participates" OR "their jurisdiction offers
// the channel":
//   1. The user has any pet_tags row (activated by them, or on a pet they
//      currently own) — once a tag exists they must always be able to manage
//      it, rule or no rule.
//   2. Any of their owned pets' jurisdictions resolves engraved_plate.enabled.

import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { db, ownerships, petTags, pets } from "@/db";
import { resolvePhysicalCredentialChannels } from "@/lib/infra/physical-credential-channels";

// Cap on distinct jurisdictions resolved per call — the cuenta hub renders on
// every visit and each resolution is a business-rule read.
const MAX_JURISDICTIONS_CHECKED = 5;

export async function shouldShowTagSurfaces(userId: string): Promise<boolean> {
  if (!userId) return false;

  const ownedPetIds = (
    await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(and(eq(ownerships.ownerUserId, userId), isNull(ownerships.endedAt)))
  ).map((r) => r.petId);

  // 1. Existing participation: any tag row reachable by this user.
  const [existingTag] = await db
    .select({ id: petTags.id })
    .from(petTags)
    .where(
      ownedPetIds.length > 0
        ? or(eq(petTags.activatedByUserId, userId), inArray(petTags.petId, ownedPetIds))
        : eq(petTags.activatedByUserId, userId),
    )
    .limit(1);
  if (existingTag) return true;

  // 2. Channel availability in any owned pet's jurisdiction.
  if (ownedPetIds.length === 0) return false;

  const jurisdictionRows = await db
    .selectDistinct({
      province: pets.jurisdictionProvince,
      locality: pets.jurisdictionLocality,
    })
    .from(pets)
    .where(and(inArray(pets.id, ownedPetIds), isNull(pets.deletedAt)))
    .limit(MAX_JURISDICTIONS_CHECKED);

  for (const j of jurisdictionRows) {
    const channels = await resolvePhysicalCredentialChannels({
      country: "AR",
      province: j.province ?? null,
      locality: j.locality ?? null,
    });
    if (channels.engraved_plate.enabled) return true;
  }

  return false;
}
