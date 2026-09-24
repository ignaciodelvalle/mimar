// Match confirmation page — refugio path.
//
// Reached when createIntakeAction detects a microchip cross-check match with
// status='lost'. Shows the matched pet's public info and two actions:
//   "Es la misma mascota" → confirmChipMatchAction → ownership + notification
//   "No es la misma"     → note event → redirect back to intake
//
// Disclosure prefs: for Fase 2 the owner's name and last location are always
// shown. Fase 3 will gate these on the disclose_* columns.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OpCrumbs } from "@/components/ui/dashboard";
import { attachments, db, ownerships, petEvents, pets, profiles } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { validateIntakeMatchClaim } from "@/lib/infra/intake-match-claim";
import { petPhotoUrl } from "@/lib/infra/storage";
import { foundParticiple } from "@/lib/utils/format";

import { MatchConfirmationCard } from "./MatchConfirmationCard";

export default async function IntakeMatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgToken: string; matchedPetToken: string }>;
  searchParams: Promise<{ claim?: string }>;
}) {
  const { orgToken, matchedPetToken } = await params;
  const { claim } = await searchParams;

  // Auth — must be an active member of this org.
  const { organization } = await requireOrgAccessByToken(orgToken);

  // Cross-tenant PII guard (review 24 HIGH #6): the lost pet's owner name +
  // last-seen location are exposed below. Loading by publicToken alone let any
  // member of any org open this page for any lost-pet token. Require a valid
  // intake-match claim — issued only by THIS org's own intake chip cross-check
  // against THIS pet — before revealing anything. No claim → notFound (never
  // leak whether the pet exists).
  if (!claim || !validateIntakeMatchClaim(orgToken, matchedPetToken, claim)) {
    notFound();
  }

  // Load the matched pet.
  const [petResult] = await db
    .select({ pet: pets, photo: attachments })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    // Art. 16: an erased lost pet must read as never-existed to the intake
    // cross-check, not render its name and photo to any org member.
    .where(and(eq(pets.publicToken, matchedPetToken), isNull(pets.deletedAt)))
    .limit(1);

  if (!petResult) notFound();
  const { pet, photo } = petResult;

  // Must still be lost — if it was found in the meantime, tell the user.
  if (pet.status !== "lost") {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">Mascota ya no esta perdida</h1>
          <p className="text-md text-ln-op-mute">
            {pet.name} ya fue {foundParticiple(pet.sex)} o su estado cambió. Podés continuar el
            ingreso normalmente.
          </p>
          <Link
            href={`/org/${orgToken}/intake`}
            className="inline-block rounded-[var(--radius-md)] bg-ln-op-azul px-4 py-2 text-md font-medium text-white hover:opacity-90 transition-opacity no-underline"
          >
            Volver al ingreso
          </Link>
        </div>
      </div>
    );
  }

  // Load owner first name (Fase 2: always shown; Fase 3 gates on disclose_first_name_when_lost).
  const [ownerRow] = await db
    .select({ displayName: profiles.displayName })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
    )
    .limit(1);

  // Last known location from the most recent status_changed → lost event.
  const [latestLostEvent] = await db
    .select({ payload: petEvents.payload, occurredAt: petEvents.occurredAt })
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, pet.id),
        eq(petEvents.eventType, "status_changed"),
        sql`${petEvents.payload}->>'to_status' = 'lost'`,
      ),
    )
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  const lostPayload = latestLostEvent?.payload as
    | { location_description?: string | null }
    | null
    | undefined;
  const lastLocationText = lostPayload?.location_description ?? null;
  const lastLocationDate = latestLostEvent?.occurredAt?.toISOString() ?? null;

  const photoUrl = petPhotoUrl(photo?.storagePath);
  const ownerFirstName = ownerRow?.displayName?.split(" ")[0] ?? null;

  return (
    <div className="max-w-xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Panel", href: `/org/${orgToken}` },
          { label: "Ingreso", href: `/org/${orgToken}/intake` },
          { label: "Coincidencia de microchip" },
        ]}
      />

      <header className="space-y-1">
        <p className="text-sm uppercase tracking-wider text-ln-op-mute">
          {organization.displayName}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Coincidencia de microchip</h1>
        <p className="text-md text-ln-op-mute">
          Este chip ya esta registrado en miMAR. Confirmá si es el mismo animal.
        </p>
      </header>

      <MatchConfirmationCard
        matchedPetToken={matchedPetToken}
        petName={pet.name}
        petSpecies={pet.species}
        petBreed={pet.breed}
        petColor={pet.color}
        petSex={pet.sex}
        petPhotoUrl={photoUrl}
        ownerFirstName={ownerFirstName}
        lastLocationText={lastLocationText}
        lastLocationDate={lastLocationDate}
        actorMode="refugio"
        orgToken={orgToken}
        claim={claim}
        successRedirect={`/org/${orgToken}/intake?matched=true&token=${matchedPetToken}`}
        cancelRedirect={`/org/${orgToken}/intake`}
      />

      <footer className="pt-4 border-t border-ln-op-line">
        <Link
          href={`/org/${orgToken}/intake`}
          className="text-md text-ln-op-azul hover:underline no-underline"
        >
          Cancelar y volver al ingreso
        </Link>
      </footer>
    </div>
  );
}
