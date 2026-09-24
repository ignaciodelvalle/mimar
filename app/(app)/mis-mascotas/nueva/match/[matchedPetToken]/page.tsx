// Match confirmation page — Libreta Nacional redesign.
// Presentation only; MatchConfirmationCardVecino and data fetching unchanged.

import Link from "next/link";
import { notFound } from "next/navigation";

import { LnButton } from "@/components/ui/Button";
import { attachments, db, ownerships, petEvents, pets, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { attemptedChipMatchesPet } from "@/lib/infra/chip-lookup";
import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";
import { petPhotoUrl } from "@/lib/infra/storage";
import { foundParticiple } from "@/lib/utils/format";
import { trimmedSearchParam } from "@/lib/utils/search-params";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { MatchConfirmationCardVecino } from "./MatchConfirmationCardVecino";

export default async function VecinoMatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ matchedPetToken: string }>;
  // `string | string[]`, not `string`: Next passes an ARRAY when the key
  // repeats (`?chip=a&chip=b`), and the old `chip?.trim()` below threw
  // "chip.trim is not a function" — a raw 500 screen on a link anyone can
  // produce by copy-pasting. firstSearchParam collapses it.
  searchParams: Promise<{ chip?: string | string[] }>;
}) {
  const { matchedPetToken } = await params;
  const { chip } = await searchParams;
  const attemptedMicrochipId = trimmedSearchParam(chip) ?? "";

  await requireUserOrRedirect();

  // Art. 16: an erased lost pet must read as never-existed here, exactly as
  // its refugio twin (org intake match) already does — this page renders the
  // pet's name, photo, owner first name and last-seen location, and the
  // confirm writer it fronts filters the same way. `unerasedPetByToken` is the
  // authenticated alias of the PO-4 predicate.
  const [petResult] = await db
    .select({ pet: pets, photo: attachments })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(unerasedPetByToken(matchedPetToken))
    .limit(1);

  if (!petResult) notFound();
  const { pet, photo } = petResult;

  // Same gate as the confirm action, applied before a single field is read.
  // This page renders the owner's first name and the last-seen location the
  // /perdidas board withholds when the owner opted out of disclosure — and a
  // live session was its only requirement, for ANY lost pet's public token.
  // The refugio twin gates on an HMAC intake claim (review 24 HIGH #6/#7); the
  // vecino equivalent is knowing the code that produced the collision. Note
  // this is defence in depth, not the authorization: the action is callable
  // directly, so it re-checks.
  if (!(await attemptedChipMatchesPet(pet.id, attemptedMicrochipId))) notFound();

  if (pet.status !== "lost") {
    return (
      <div className="mx-auto max-w-md px-8 py-7 pb-12 text-center">
        <p className="font-ln-serif text-xl font-semibold text-[var(--color-ln-ink)]">
          Mascota ya no está perdida
        </p>
        <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
          {pet.name} ya fue {foundParticiple(pet.sex)} o su estado cambió. Podés continuar
          registrando la mascota.
        </p>
        <div className="mt-5 flex justify-center">
          <Link href="/mis-mascotas/nueva">
            <LnButton variant="primary" size="md">
              Volver al registro
            </LnButton>
          </Link>
        </div>
      </div>
    );
  }

  const [ownerRow] = await db
    .select({ displayName: profiles.displayName })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
    )
    .limit(1);

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
    <div className="mx-auto max-w-xl px-8 py-7 pb-12">
      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Coincidencia de microchip
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          El chip que ingresaste ya está registrado en miMAR. Confirmá si es el mismo animal.
        </p>
      </div>

      <MatchConfirmationCardVecino
        matchedPetToken={matchedPetToken}
        attemptedMicrochipId={attemptedMicrochipId}
        petName={pet.name}
        petSpecies={pet.species}
        petBreed={pet.breed}
        petColor={pet.color}
        petSex={pet.sex}
        petPhotoUrl={photoUrl}
        ownerFirstName={ownerFirstName}
        lastLocationText={lastLocationText}
        lastLocationDate={lastLocationDate}
      />

      <div className="mt-6 border-t border-[var(--color-ln-line-2)] pt-4">
        <Link
          href="/mis-mascotas/nueva"
          className="font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Cancelar y volver al registro
        </Link>
      </div>
    </div>
  );
}
