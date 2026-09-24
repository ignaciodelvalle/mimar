import Link from "next/link";
import { notFound } from "next/navigation";

import { db, ownerships, pets } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { and, eq, isNull } from "drizzle-orm";

import { OpBreach, OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";

import { AdoptionListingForm } from "./AdoptionListingForm";

export default async function AdoptarOrgPage({
  params,
}: {
  params: Promise<{ orgToken: string; publicToken: string }>;
}) {
  const { orgToken, publicToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);

  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("adoption.listing.manage")) {
    return (
      <main className="min-h-screen bg-ln-op-page p-6 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">Permiso requerido</h1>
          <p className="text-md text-ln-op-ink-2">
            Para publicar adopciones necesitás el permiso{" "}
            <code className="text-sm">adoption.listing.manage</code>.
          </p>
          <Link
            href={`/org/${orgToken}/mascotas`}
            className="inline-block px-4 py-2 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md hover:bg-ln-op-azul-700"
          >
            Volver al listado
          </Link>
        </div>
      </main>
    );
  }

  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        eq(ownerships.ownerOrganizationId, organization.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        // Art. 16: erasure soft-deletes the pet but not the ownership rows.
        isNull(pets.deletedAt),
      ),
    )
    .limit(1);
  if (!petRow) notFound();
  const pet = petRow.pet;

  // Pre-compute the four cross-spec guards so the form can show the right
  // reason next to a disabled "Publicar" button instead of failing on submit.
  const guards = {
    notLost: pet.status !== "lost",
    notDeceased: pet.status !== "deceased",
    eligible: pet.adoptionEligible === true,
    noDispute: pet.inCustodyDispute !== true,
    notInRabies: pet.rabiesObservationStatus !== "in_progress",
  };
  const blockingReasons: string[] = [];
  if (!guards.notLost) blockingReasons.push("La mascota figura como perdida.");
  if (!guards.notDeceased) blockingReasons.push("La mascota está registrada como fallecida.");
  if (!guards.eligible)
    blockingReasons.push(
      "La mascota no está marcada como apta para adopción todavía. Marcala apta primero en la pestaña de Elegibilidad.",
    );
  if (!guards.noDispute)
    blockingReasons.push("Hay una disputa de custodia en curso sobre esta mascota.");
  if (!guards.notInRabies)
    blockingReasons.push(
      "La mascota está en período de observación sanitaria (10 días antirrábica).",
    );
  const canPublish = blockingReasons.length === 0;

  const isPublished = pet.adoptionListedAt !== null && pet.adoptionListingPausedAt === null;
  const isPaused = pet.adoptionListedAt !== null && pet.adoptionListingPausedAt !== null;

  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <OpCrumbs
            items={[
              { label: "Mascotas", href: `/org/${orgToken}/mascotas` },
              { label: pet.name, href: `/org/${orgToken}/mascotas/${publicToken}` },
              { label: "Publicar en adopción" },
            ]}
          />
          <p className="text-sm uppercase tracking-wider text-ln-op-mute">
            {organization.displayName}
          </p>
          <h1 className="text-title font-semibold text-ln-op-ink">
            Publicar en adopción · {pet.name}
          </h1>
          <p className="text-md text-ln-op-ink-2">
            Esto controla la aparición de {pet.name} en <code className="text-sm">/adoptar</code> +
            ficha pública.
          </p>
        </header>

        <OpCard>
          <OpCardHead title="Estado actual" />
          <OpCardBody>
            <p className="text-md text-ln-op-ink-2">
              {isPublished
                ? "Publicada y visible en /adoptar."
                : isPaused
                  ? "Pausada — contenido conservado, no aparece en /adoptar."
                  : "No publicada — sin presencia en /adoptar."}
            </p>
          </OpCardBody>
        </OpCard>

        {!canPublish && (
          <OpBreach
            title="Bloqueos para publicar"
            detail={
              <ul className="mt-1 space-y-0.5 list-disc pl-4">
                {blockingReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
                <li className="mt-1 list-none pl-0 opacity-80">
                  Podés igual editar la historia y los requisitos para tenerlos listos cuando la
                  mascota califique.
                </li>
              </ul>
            }
          />
        )}

        <AdoptionListingForm
          orgToken={orgToken}
          petPublicToken={publicToken}
          initial={{
            isPublished,
            isPaused,
            story: pet.adoptionStory,
            requirements: pet.adoptionRequirements,
            ageBucket: pet.adoptionAgeBucket,
            sizeEstimate: pet.adoptionSizeEstimate,
            energyLevel: pet.adoptionEnergyLevel,
            goodWithKids: pet.adoptionGoodWithKids,
            goodWithDogs: pet.adoptionGoodWithDogs,
            goodWithCats: pet.adoptionGoodWithCats,
            needsYard: pet.adoptionNeedsYard,
            feeArs: pet.adoptionFeeArs,
          }}
          canPublish={canPublish}
          petSex={pet.sex}
        />

        <footer className="pt-4 border-t border-ln-op-line">
          <Link
            href={`/org/${orgToken}/mascotas`}
            className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
          >
            ← Volver al listado
          </Link>
        </footer>
      </div>
    </main>
  );
}
