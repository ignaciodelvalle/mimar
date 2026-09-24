// Anonymous "La vi cerca de acá" form — Tier 1 sighting report.
// Trilogy unification handoff §3 PR-025.
//
// Reached from the lost public credential as the lighter-weight sibling of
// "La encontré". The finder is NOT claiming custody; they're just dropping
// a pin where they saw the pet. The form is intentionally short (location
// pin + optional description + when) to maximize completion rate.

import Link from "next/link";
import { notFound } from "next/navigation";

import { db, pets } from "@/db";
import { fetchLostEpisodeForPet, publicSightingMapCenter } from "@/lib/infra/lost-mode";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import { DISPUTE_TIP_HEADING, DISPUTE_TIP_INTRO } from "@/lib/ui/dispute-copy";
import { sightingPhrase } from "@/lib/utils/format";

import { DisputeTipForm } from "../DisputeTipForm";
import { PetSightingForm } from "./PetSightingForm";

export const dynamic = "force-dynamic";

export default async function PetSightingPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // Per-IP read limit BEFORE the token lookup — this route resolves the same
  // public credential as /p/[publicToken] and was reachable without one.
  if (await isPublicTokenReadThrottled("public_token_sighting")) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <h1 className="text-title font-semibold text-ln-ink">Demasiadas consultas</h1>
        <p className="mt-2 text-md text-ln-mute">
          Recibimos muchas consultas desde tu conexión. Esperá un momento y volvé a intentarlo.
        </p>
      </main>
    );
  }

  const [pet] = await db
    .select({
      id: pets.id,
      name: pets.name,
      sex: pets.sex,
      status: pets.status,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
      discloseLastLocationWhenLost: pets.discloseLastLocationWhenLost,
      inCustodyDispute: pets.inCustodyDispute,
    })
    .from(pets)
    // PO-4: soft-deleted pets do not resolve publicly.
    .where(publicPetByToken(publicToken))
    .limit(1);
  if (!pet) notFound();

  // Custody dispute — the CHANNEL is kept, the DESTINATION moves (PO decision
  // 2026-07-30).
  //
  // D2 hardening (red-team 2026-07) was right that this flow must not run: it
  // notifies the contested owner and its payload can carry the finder's
  // contact, which takes sides in a legal dispute. What it got wrong was the
  // replacement — a notice that told the finder their information "será
  // dirigida a la autoridad competente" and then handed them a link back to
  // the profile, with nowhere to write it. A person standing over a strange
  // animal read a promise and hit a dead end. The neutral form (DisputeTipForm
  // → report-dispute-tip.ts) already existed one route away, on the credential
  // page; it just was not here.
  //
  // So the sighting route keeps its form and swaps its recipient: the
  // submission lands as a finder_tip on the open dispute case, where only the
  // reviewing authority reads it — never a notification, never either party.
  // report-pet-sighting.ts still refuses a disputed pet server-side; that gate
  // is now purely defense-in-depth for a hand-rolled POST, because no UI on
  // this page points at it anymore.
  if (pet.inCustodyDispute) {
    return (
      // Landing shell (AppShell variant=landing) owns #main-content + min-height.
      <div className="min-h-screen bg-[var(--color-ln-paper)] px-4 py-6">
        <div className="mx-auto max-w-md space-y-5">
          <header className="space-y-1">
            <Link
              href={`/p/${publicToken}`}
              className="text-sm text-[var(--color-ln-ink)] underline underline-offset-4"
            >
              ← Volver al perfil
            </Link>
            <h1 className="text-2xl font-semibold text-[var(--color-ln-ink)]">
              {DISPUTE_TIP_HEADING}
            </h1>
            <p className="text-sm text-[var(--color-ln-mute)]">{DISPUTE_TIP_INTRO}</p>
          </header>

          <section className="rounded-2xl bg-[var(--color-ln-card)] p-4">
            <DisputeTipForm publicToken={publicToken} />
          </section>
        </div>
      </div>
    );
  }

  if (pet.status !== "lost") {
    return (
      // Landing shell (AppShell variant=landing) owns #main-content + min-height.
      <div className="min-h-screen bg-[var(--color-ln-paper)] px-4 py-10">
        <div className="mx-auto max-w-md space-y-4 text-center">
          <h1 className="text-2xl font-semibold text-[var(--color-ln-ink)]">
            Esta mascota no está perdida
          </h1>
          <p className="text-sm text-[var(--color-ln-mute)]">
            El reporte de avistaje sólo aplica mientras la mascota está marcada como perdida.
          </p>
          <Link
            href={`/p/${publicToken}`}
            className="inline-block px-4 py-2 rounded-lg bg-[var(--color-ln-azul)] text-white text-sm"
          >
            Ver el perfil público
          </Link>
        </div>
      </div>
    );
  }

  // Center the map on the pet's last-known lost location (tester fix #5).
  // PRIVACY: only when the owner disclosed the last location publicly —
  // publicSightingMapCenter returns null otherwise and the map keeps its
  // neutral default. The episode fetch is skipped entirely when undisclosed.
  const episode = pet.discloseLastLocationWhenLost ? await fetchLostEpisodeForPet(pet.id) : null;
  const defaultCenter = publicSightingMapCenter({
    discloseLastLocationWhenLost: pet.discloseLastLocationWhenLost,
    lastSeenLat: episode?.lastSeenLat ?? null,
    lastSeenLng: episode?.lastSeenLng ?? null,
  });

  return (
    // Landing shell (AppShell variant=landing) owns #main-content + min-height.
    <div className="min-h-screen bg-[var(--color-ln-warn-050)] px-4 py-6">
      <div className="mx-auto max-w-md space-y-5">
        <header className="space-y-1">
          <Link
            href={`/p/${publicToken}`}
            className="text-sm text-[var(--color-ln-ink)] underline underline-offset-4"
          >
            ← Volver al perfil
          </Link>
          <h1 className="text-2xl font-semibold text-[var(--color-ln-ink)]">
            {sightingPhrase(pet.sex)}
          </h1>
          <p className="text-sm text-[var(--color-ln-mute)]">
            Marcá dónde y cuándo viste a {pet.name}. El dueño/a recibe el aviso al instante.
          </p>
        </header>

        <section className="rounded-2xl bg-[var(--color-ln-card)] p-4">
          <PetSightingForm
            publicToken={publicToken}
            petName={pet.name}
            petSex={pet.sex}
            biasProvince={pet.jurisdictionProvince}
            biasLocality={pet.jurisdictionLocality}
            defaultCenter={defaultCenter}
          />
        </section>
      </div>
    </div>
  );
}
