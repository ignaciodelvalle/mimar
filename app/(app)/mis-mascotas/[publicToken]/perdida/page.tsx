// Marcar como perdida / Actualizar última ubicación — Libreta Nacional redesign.
//
// Two flows share this route depending on pet.status:
//   - status !== 'lost' (and !== 'deceased'): first-time MarkLostWizard.
//   - status === 'lost' WITH an open lost_pet_episode case: UpdateLastSeenForm
//     — the "ACTUALIZAR" affordance on LostCaseBlock's "Última vez visto" card
//     links here. This does NOT redirect away: doing so unconditionally for
//     status='lost' was a regression that turned "ACTUALIZAR" into a dead end
//     (it always bounced back to the profile it was launched from).
//   - status === 'lost' WITHOUT an open case: the episode auto-closed for
//     inactivity (ADR-18 stale cron) but pets.status is still 'lost'. The
//     profile's StaleLostCaseBanner already offers "Reactivar búsqueda" /
//     "Marcar encontrada" for this state, so redirecting there is correct —
//     there's nothing for this route to update.
//   - status === 'deceased': unchanged — always redirect to the profile.

import Link from "next/link";
import { redirect } from "next/navigation";

import { fetchLatestLostDescription, fetchLostEpisodeForPet } from "@/lib/infra/lost-mode";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { lostLabel, markLostActionLabel } from "@/lib/utils/format";
import { setPetLostAction, updateLostLastSeenAction } from "@/src/modules/events/actions";
import { MarkLostWizard } from "./MarkLostWizard";
import { UpdateLastSeenForm } from "./UpdateLastSeenForm";

export default async function MarkPetLostPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet } = session;

  if (pet.status === "deceased") {
    redirect(`/mis-mascotas/${publicToken}`);
  }

  if (pet.status === "lost") {
    const episode = await fetchLostEpisodeForPet(pet.id);
    if (!episode) {
      // Stale (auto-closed) episode — nothing to update here; the profile's
      // StaleLostCaseBanner is the correct next step.
      redirect(`/mis-mascotas/${pet.publicToken}`);
    }

    const updateAction = updateLostLastSeenAction.bind(null, pet.publicToken);

    return (
      <div className="mx-auto max-w-md px-8 py-7 pb-12">
        <Link
          href={`/mis-mascotas/${pet.publicToken}`}
          className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← {pet.name}
        </Link>

        <UpdateLastSeenForm
          action={updateAction}
          petName={pet.name}
          petJurisdictionProvince={pet.jurisdictionProvince ?? null}
          petJurisdictionLocality={pet.jurisdictionLocality ?? null}
          defaultPlaceName={episode.placeName}
          defaultNote={episode.ownerNote}
          defaultLat={episode.lastSeenLat != null ? Number(episode.lastSeenLat) : null}
          defaultLng={episode.lastSeenLng != null ? Number(episode.lastSeenLng) : null}
        />
      </div>
    );
  }

  const boundAction = setPetLostAction.bind(null, pet.publicToken);
  const [canonicalIds, priorLostDescription] = await Promise.all([
    fetchActiveIdentifications(pet.id),
    fetchLatestLostDescription(pet.id),
  ]);

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href={`/mis-mascotas/${pet.publicToken}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← {pet.name}
      </Link>

      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          {markLostActionLabel(pet.sex)}
        </h1>
        <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
          Al marcar a {pet.name} como {lostLabel(pet.sex).toLowerCase()}, su credencial pública
          mostrará el aviso de búsqueda. En el último paso elegís qué datos tuyos compartir. Vas a
          poder ajustar qué se ve, o revertir el estado, desde su perfil.
        </p>
      </div>

      <MarkLostWizard
        action={boundAction}
        petName={pet.name}
        petSex={pet.sex}
        petPublicToken={pet.publicToken}
        petHasMicrochip={canonicalIds.microchip !== null}
        petHasTattoo={canonicalIds.tattoo !== null}
        petColor={pet.color ?? null}
        petDistinguishingFeatures={pet.distinguishingFeatures ?? null}
        petJurisdictionProvince={pet.jurisdictionProvince ?? null}
        petJurisdictionLocality={pet.jurisdictionLocality ?? null}
        priorAccessoriesWhenLost={priorLostDescription?.accessoriesWhenLost ?? null}
        priorBehaviorNotes={priorLostDescription?.behaviorNotes ?? null}
        priorLastSeenContext={priorLostDescription?.lastSeenContext ?? null}
      />
    </div>
  );
}
