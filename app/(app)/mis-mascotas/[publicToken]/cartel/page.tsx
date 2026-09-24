// /mis-mascotas/[publicToken]/cartel — printable lost-pet poster (A4).
//
// Gate: requirePetAccess. If pet.status !== 'lost', renders a "mark as lost first"
// message instead of the poster.

import { and, asc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";

import { attachments, db, ownerships, profiles } from "@/db";
import { fetchLostEpisodeForPet } from "@/lib/infra/lost-mode";
import { requirePetAccess } from "@/lib/infra/pet-access";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { petPhotoUrl } from "@/lib/infra/storage";
import {
  ageFromDateOfBirth,
  lostThirdPersonPhrase,
  markLostActionLabel,
  markLostFirstPrompt,
  sexLabel,
  speciesLabel,
} from "@/lib/utils/format";

import "./cartel-print.css";
import { PosterPreview } from "./PosterPreview";

export default async function CartelPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  const access = await requirePetAccess(publicToken);
  if (!access.ok) notFound();
  const { pet } = access;

  // Guard: poster only makes sense when the pet is marked lost.
  if (pet.status !== "lost") {
    return (
      <div className="mx-auto max-w-md px-8 py-12 text-center">
        <p className="font-ln-serif text-xl font-semibold text-[var(--color-ln-ink)]">
          {pet.name} no {lostThirdPersonPhrase(pet.sex)}.
        </p>
        <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">{markLostFirstPrompt(pet.sex)}</p>
        <Link
          href={`/mis-mascotas/${publicToken}?sheet=marcar-perdida`}
          className="mt-5 inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-4 py-[9px] font-ln-sans text-md font-medium text-[var(--color-ln-warn)] no-underline hover:opacity-80 transition-opacity"
        >
          {markLostActionLabel(pet.sex)}
        </Link>
      </div>
    );
  }

  // Fetch lost episode (placeName + lastSeenAt, both reflecting the latest
  // owner location update — see fetchLostEpisodeForPet's overlay).
  const episode = await fetchLostEpisodeForPet(pet.id);

  // Resolve owner first name + phone from the active ownership row.
  // Mirrors the pattern in /p/[publicToken]/page.tsx (Tier 1 reveal).
  // NOTE: isNull(endedAt) is required — without it a transferred pet would return
  // the PREVIOUS owner's row, leaking their PII onto the poster.
  // role='owner' is required for the SAME REASON IN THE PRESENT TENSE, and the
  // note above used to stop one clause short of it. An accepted
  // temporary-caretaker grant opens a second row on this pet with no endedAt, so
  // isNull(endedAt) alone no longer narrows to one row and the limit(1) resolved
  // by heap order — printing a caretaker's name and phone on a flyer the titular
  // is about to staple to a lamppost. The disclosure prefs applied below are the
  // TITULAR's; they cannot consent for anyone else.
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
    ? ownerRow.profile.displayName.trim().split(/\s+/)[0]
    : null;
  const rawPhone = ownerRow?.profile.phone ?? null;

  // Apply disclosure prefs — only pass values the owner has opted to disclose.
  const ownerFirstName = pet.discloseFirstNameWhenLost ? rawFirstName : null;
  const ownerPhone = pet.disclosePhoneWhenLost ? rawPhone : null;

  // Resolve photo URL (pet-photos bucket is public).
  let photoUrl: string | null = null;
  if (pet.primaryPhotoId) {
    const [photo] = await db
      .select({ storagePath: attachments.storagePath })
      .from(attachments)
      .where(eq(attachments.id, pet.primaryPhotoId))
      .limit(1);
    photoUrl = petPhotoUrl(photo?.storagePath);
  }

  // Generate QR SVG server-side pointing at the public credential page.
  const baseUrl = resolveSiteUrl();
  const qrTargetUrl = `${baseUrl}/p/${publicToken}`;
  const qrSvg = await QRCode.toString(qrTargetUrl, {
    type: "svg",
    margin: 1,
    width: 180,
    errorCorrectionLevel: "M",
  });

  return (
    <div className="min-h-screen bg-[var(--color-ln-stripe)] print:bg-white">
      <PosterPreview
        publicToken={publicToken}
        petName={pet.name}
        species={speciesLabel(pet.species)}
        breed={pet.breed ?? null}
        sex={sexLabel(pet.sex)}
        sexRaw={pet.sex}
        age={ageFromDateOfBirth(pet.dateOfBirth)}
        color={pet.color ?? null}
        distinguishingFeatures={pet.distinguishingFeatures ?? null}
        photoUrl={photoUrl}
        placeName={episode?.placeName ?? null}
        lastSeenAt={episode?.lastSeenAt ?? null}
        ownerFirstName={ownerFirstName}
        ownerPhone={ownerPhone}
        locationDisclosed={pet.discloseLastLocationWhenLost}
        qrSvg={qrSvg}
      />
    </div>
  );
}
