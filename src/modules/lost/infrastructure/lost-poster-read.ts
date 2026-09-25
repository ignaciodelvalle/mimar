// The lost-pet poster's data — ONE resolver for both doors.
//
// Moved out of `app/(app)/mis-mascotas/[publicToken]/cartel/page.tsx` when the
// native app got the poster (M13), so the web page and
// `GET /api/v1/pets/{token}/poster` resolve the owner's contact through the
// same query and the same disclosure filter. Two copies of this function is
// exactly the duplication the app's lost screen used to cite as its reason for
// not having a poster at all.
//
// THE CALLER HAS ALREADY AUTHORIZED. Both doors resolve the pet through
// `resolvePetHolderAccess` first (the web via `requirePetAccess`); this file
// decides only what the poster may SAY, never who may print it.

import { and, asc, eq, isNull } from "drizzle-orm";
import QRCode from "qrcode";

import { attachments, db, ownerships, profiles } from "@/db";
import type { Pet } from "@/db/schema";
import { fetchLostEpisodeForPet } from "@/lib/infra/lost-mode";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { petPhotoUrl } from "@/lib/infra/storage";
import { ageFromDateOfBirth, sexLabel, speciesLabel } from "@/lib/utils/format";

import type { LostPosterData } from "../application/lost-poster-html";

export async function loadLostPoster(pet: Pet, publicToken: string): Promise<LostPosterData> {
  // Lost episode (placeName + lastSeenAt, both reflecting the latest owner
  // location update — see fetchLostEpisodeForPet's overlay).
  const episode = await fetchLostEpisodeForPet(pet.id);

  // Resolve owner first name + phone from the active ownership row.
  // Mirrors the pattern in /p/[publicToken]/page.tsx (Tier 1 reveal).
  // NOTE: isNull(endedAt) is required — without it a transferred pet would return
  // the PREVIOUS owner's row, leaking their PII onto the poster.
  // role='owner' is required for the SAME REASON IN THE PRESENT TENSE. An
  // accepted temporary-caretaker grant opens a second row on this pet with no
  // endedAt, so isNull(endedAt) alone no longer narrows to one row and the
  // limit(1) resolved by heap order — printing a caretaker's name and phone on a
  // flyer the titular is about to staple to a lamppost. The disclosure prefs
  // applied below are the TITULAR's; they cannot consent for anyone else.
  // EMAIL is intentionally omitted: discloseEmailWhenLost is not surfaced here
  // by design — phone/firstName/location only (Tier 1 contact subset for print).
  const [ownerRow] = await db
    .select({ profile: profiles })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
    )
    .orderBy(asc(ownerships.startedAt))
    .limit(1);

  const rawFirstName = ownerRow?.profile.displayName
    ? (ownerRow.profile.displayName.trim().split(/\s+/)[0] ?? null)
    : null;
  const rawPhone = ownerRow?.profile.phone ?? null;

  // Photo URL (pet-photos bucket is public).
  let photoUrl: string | null = null;
  if (pet.primaryPhotoId) {
    const [photo] = await db
      .select({ storagePath: attachments.storagePath })
      .from(attachments)
      .where(eq(attachments.id, pet.primaryPhotoId))
      .limit(1);
    photoUrl = petPhotoUrl(photo?.storagePath);
  }

  // QR SVG, server-side, pointing at the public credential page.
  const qrSvg = await QRCode.toString(`${resolveSiteUrl()}/p/${publicToken}`, {
    type: "svg",
    margin: 1,
    width: 180,
    errorCorrectionLevel: "M",
  });

  return {
    publicToken,
    petName: pet.name,
    species: speciesLabel(pet.species),
    breed: pet.breed ?? null,
    sex: sexLabel(pet.sex),
    sexRaw: pet.sex,
    age: ageFromDateOfBirth(pet.dateOfBirth),
    color: pet.color ?? null,
    distinguishingFeatures: pet.distinguishingFeatures ?? null,
    photoUrl,
    placeName: episode?.placeName ?? null,
    lastSeenAt: episode?.lastSeenAt ?? null,
    // Disclosure prefs — only values the owner has opted to disclose.
    ownerFirstName: pet.discloseFirstNameWhenLost ? rawFirstName : null,
    ownerPhone: pet.disclosePhoneWhenLost ? rawPhone : null,
    locationDisclosed: pet.discloseLastLocationWhenLost,
    qrSvg,
  };
}
