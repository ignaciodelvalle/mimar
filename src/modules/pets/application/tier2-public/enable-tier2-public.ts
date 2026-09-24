// Use-case: enableTier2Public — strangler migration 50/61.
//
// Auth guard (requirePetAccess) is enforced by the caller (shim). This
// use-case receives the already-resolved pet object so it never re-fetches.

import { type Pet, db, pets } from "@/db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const DAY_MS = 24 * 60 * 60 * 1000;
// Bounded share windows offered by the duration picker, keyed by the card id.
const DURATION_MS: Record<string, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

export async function enableTier2Public(
  pet: Pet,
  publicToken: string,
  formData?: FormData,
): Promise<void> {
  if (pet.status === "deceased") {
    // The public credential of a deceased pet is the in-memoriam page;
    // surfacing medical detail there has no purpose.
    throw new Error("No se puede habilitar Tier 2 en una mascota fallecida.");
  }

  // Default to 24h when no/unknown duration is submitted (back-compat with any
  // caller that invokes the action without form data).
  const duration = String(formData?.get("duration") ?? "24h");

  if (duration === "siempre") {
    // Desired-state guard (projection-writes audit §6): already permanent →
    // a re-submit is a no-op, not a fresh write.
    if (pet.tier2PublicPermanent) return;

    // Permanent — no expiry timestamp; activate via the dedicated boolean flag.
    await db
      .update(pets)
      .set({ tier2PublicPermanent: true, tier2PublicEnabledUntil: null, updatedAt: new Date() })
      .where(eq(pets.id, pet.id));
  } else {
    const windowMs = DURATION_MS[duration] ?? DAY_MS;
    const until = new Date(Date.now() + windowMs);

    // Desired-state guard (projection-writes audit §6): a double-submit posts
    // the same duration twice within moments — the second request would only
    // re-window by the seconds elapsed between clicks. If the pet already has
    // a window ending within a minute of the requested one, treat the submit
    // as a duplicate no-op. A deliberate re-window (minutes/hours later, or a
    // different duration) still extends or shortens as requested.
    const existingUntil = pet.tier2PublicPermanent ? null : pet.tier2PublicEnabledUntil;
    if (existingUntil && Math.abs(existingUntil.getTime() - until.getTime()) < 60_000) {
      return;
    }

    await db
      .update(pets)
      .set({ tier2PublicPermanent: false, tier2PublicEnabledUntil: until, updatedAt: new Date() })
      .where(eq(pets.id, pet.id));
  }

  revalidatePath(`/mis-mascotas/${publicToken}`);
  revalidatePath(`/p/${publicToken}`);
}
