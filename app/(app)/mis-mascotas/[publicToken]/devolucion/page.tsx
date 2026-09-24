// Devolucion — Libreta Nacional redesign.
// Three modes:
//   1. Inbound acceptance: org-sourced custody_transfer_proposed is pending →
//      show ReturnAcceptanceCard so the owner accepts/rejects.
//   2. Owner initiation (adoption): no pending proposal + pet has adoption_finalized →
//      show OwnerInitiateReturnForm so the owner proposes return to the org.
//   3. Owner initiation (foster): no pending proposal + user has active foster role +
//      there is a parallel active shelter_custody org ownership →
//      show OwnerInitiateReturnForm routing through ownerProposeReturnToOrgAction.

import { LnButton } from "@/components/ui/Button";
import { LnCallout } from "@/components/ui/DocElements";
import { type Pet, db, organizations, ownerships, petEvents, pets, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { hasPendingProposal } from "@/src/modules/return-to-owner/application/proposal-queries";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OwnerInitiateReturnForm } from "./OwnerInitiateReturnForm";
import { ReturnAcceptanceCard } from "./ReturnAcceptanceCard";

const ROLE_LABELS: Record<string, string> = {
  shelter_custody: "custodia temporal (tránsito)",
  foster: "tránsito formal",
  co_owner: "co-dueño",
  caretaker: "cuidador",
};

function FriendlyOwnerOnlyPage({ pet, role }: { pet: Pet; role: string }) {
  const roleLabel = ROLE_LABELS[role] ?? role;
  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      <Link
        href={`/mis-mascotas/${pet.publicToken}`}
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Volver al perfil
      </Link>
      <h1 className="m-0 mb-4 font-ln-serif text-2xl font-semibold text-[var(--color-ln-ink)]">
        Devolución de {pet.name}
      </h1>
      <LnCallout tone="warn" title="Aceptar una devolución es acción del dueño legal.">
        Tu vínculo actual con <strong>{pet.name}</strong> es de <strong>{roleLabel}</strong>. Si el
        dueño original ya no es el correcto, primero hay que completar la transferencia formal de
        custodia antes de aceptar la devolución.
      </LnCallout>
    </div>
  );
}

export default async function DevolucionPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { user } = await requireUserOrRedirect();

  const [accessRow] = await db
    .select({ pet: pets, role: ownerships.role })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        // Art. 16 (Ley 25.326): an erased pet reads as never registered. Access
        // is resolved INLINE here; the foster and co-owner branches are reachable
        // by ownership rows the erasure leaves intact, so without this term a
        // non-owner holder would still see the erased pet's name.
        isNull(pets.deletedAt),
        eq(ownerships.ownerUserId, user.id),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);

  if (!accessRow) notFound();

  // Foster path: user has an active foster role — allow initiation of a return
  // to the org that holds the parallel shelter_custody. Non-foster non-owner
  // roles still land on the guidance page.
  if (accessRow.role === "foster") {
    const pet = accessRow.pet;

    // Resolve source org via active parallel shelter_custody ownership.
    const [parallelCustody] = await db
      .select({ ownerOrganizationId: ownerships.ownerOrganizationId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, pet.id),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    const fosterSourceOrgId = parallelCustody?.ownerOrganizationId ?? null;

    const [fosterOrgRow] = fosterSourceOrgId
      ? await db
          .select({ displayName: organizations.displayName })
          .from(organizations)
          .where(eq(organizations.id, fosterSourceOrgId))
          .limit(1)
      : [undefined];
    const fosterOrgDisplayName = fosterOrgRow?.displayName ?? null;

    if (!fosterSourceOrgId || !fosterOrgDisplayName) {
      return (
        <div className="mx-auto max-w-lg px-8 py-7 pb-12">
          <Link
            href={`/mis-mascotas/${pet.publicToken}`}
            className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            ← Volver al perfil
          </Link>
          <h1 className="m-0 mb-4 font-ln-serif text-2xl font-semibold text-[var(--color-ln-ink)]">
            Devolución de {pet.name}
          </h1>
          <LnCallout tone="warn" title="Sin organización asociada.">
            No encontramos el refugio de origen para este tránsito. Contactá a la organización
            directamente para coordinar la devolución.
          </LnCallout>
          <div className="mt-6 flex justify-start">
            <Link href="/mis-mascotas">
              <LnButton variant="primary" size="md">
                Volver a mis mascotas
              </LnButton>
            </Link>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-lg px-8 py-7 pb-12">
        <Link
          href={`/mis-mascotas/${pet.publicToken}`}
          className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Volver al perfil
        </Link>
        <div className="mb-6">
          <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Devolver {pet.name}
          </h1>
          <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
            Estás en tránsito con <strong>{pet.name}</strong>. Podés proponer la devolución a{" "}
            <strong>{fosterOrgDisplayName}</strong>.
          </p>
        </div>
        <div className="mb-6">
          <LnCallout tone="warn" title="Esta acción notifica al refugio.">
            El refugio va a recibir tu propuesta y debe aceptarla. El tránsito sigue activo hasta
            que confirmen la recepción.
          </LnCallout>
        </div>
        <OwnerInitiateReturnForm
          petPublicToken={publicToken}
          petName={pet.name}
          orgDisplayName={fosterOrgDisplayName}
          backUrl="/mis-mascotas"
        />
      </div>
    );
  }

  if (accessRow.role !== "owner") {
    return <FriendlyOwnerOnlyPage pet={accessRow.pet} role={accessRow.role} />;
  }

  const pet = accessRow.pet;

  const [latestProposal] = await db
    .select()
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transfer_proposed")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  // Canonical pending-proposal predicate (proposal-queries.ts) — the same
  // tri-check (accepted / structured cancellation / legacy cancel marker)
  // used by the rest of the return-to-owner flow. A rejected/cancelled
  // proposal must NOT re-render as actionable here.
  const isPending = await hasPendingProposal(pet.id, db);

  if (!isPending) {
    // Initiation mode: check if this pet was received via adoption so the
    // owner can propose a return to the source org.
    const [adoptionEvent] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "adoption_finalized")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);

    const adoptionPayload = adoptionEvent?.payload as
      | { previous_owner_organization_id?: string | null; adopter_user_id?: string | null }
      | undefined;
    const sourceOrgId =
      adoptionPayload?.adopter_user_id === user.id
        ? (adoptionPayload?.previous_owner_organization_id ?? null)
        : null;

    let orgDisplayName: string | null = null;
    if (sourceOrgId) {
      const [orgRow] = await db
        .select({ displayName: organizations.displayName })
        .from(organizations)
        .where(eq(organizations.id, sourceOrgId))
        .limit(1);
      orgDisplayName = orgRow?.displayName ?? null;
    }

    if (sourceOrgId && orgDisplayName) {
      return (
        <div className="mx-auto max-w-lg px-8 py-7 pb-12">
          {/* Back link */}
          <Link
            href={`/mis-mascotas/${pet.publicToken}`}
            className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            ← Volver al perfil
          </Link>

          {/* Header */}
          <div className="mb-6">
            <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
              Devolver {pet.name}
            </h1>
            <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
              Estás iniciando la devolución de una mascota recibida en adopción de{" "}
              <strong>{orgDisplayName}</strong>.
            </p>
          </div>

          {/* Warning callout */}
          <div className="mb-6">
            <LnCallout tone="warn" title="Esta acción notifica al refugio.">
              El refugio va a recibir tu propuesta y debe aceptarla. La custodia de {pet.name} sigue
              siendo tuya hasta que ellos confirmen la recepción.
            </LnCallout>
          </div>

          {/* Initiation form */}
          <OwnerInitiateReturnForm
            petPublicToken={publicToken}
            petName={pet.name}
            orgDisplayName={orgDisplayName}
            backUrl="/mis-mascotas"
          />
        </div>
      );
    }

    // No adoption found — show guidance only.
    return (
      <div className="mx-auto max-w-lg px-8 py-7 pb-12">
        <Link
          href={`/mis-mascotas/${pet.publicToken}`}
          className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Volver al perfil
        </Link>
        <h1 className="m-0 mb-4 font-ln-serif text-2xl font-semibold text-[var(--color-ln-ink)]">
          Devolución de {pet.name}
        </h1>
        <LnCallout tone="warn" title="Sin propuestas activas.">
          No hay propuestas de devolución pendientes para {pet.name} y no encontramos una adopción
          registrada a tu nombre. Si recibiste esta mascota de un refugio fuera de miMAR, contactá
          al refugio directamente.
        </LnCallout>
        <div className="mt-6 flex justify-start">
          <Link href="/mis-mascotas">
            <LnButton variant="primary" size="md">
              Volver a mis mascotas
            </LnButton>
          </Link>
        </div>
      </div>
    );
  }

  if (!latestProposal) notFound();
  const proposalPayload = latestProposal.payload as Record<string, unknown>;
  const fromUserId = (proposalPayload.from_user_id as string | null) ?? null;
  const fromOrgId = (proposalPayload.from_organization_id as string | null) ?? null;
  const proposalNotes = (proposalPayload.notes as string | null) ?? null;
  const proposedAt =
    (proposalPayload.proposed_at as string | null) ?? latestProposal.occurredAt.toISOString();

  let actorName = "Alguien";
  if (fromUserId) {
    const [profile] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, fromUserId))
      .limit(1);
    if (profile) actorName = profile.displayName.split(" ")[0];
  } else if (fromOrgId) {
    const [org] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, fromOrgId))
      .limit(1);
    if (org) actorName = org.displayName;
  }

  return (
    <div className="mx-auto max-w-lg px-8 py-7 pb-12">
      {/* Header */}
      <div className="mb-6">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Devolución de {pet.name}
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Alguien tiene a {pet.name} y quiere devolvértela. Confirmá cuando la tengas físicamente.
        </p>
      </div>

      <ReturnAcceptanceCard
        petPublicToken={publicToken}
        petName={pet.name}
        actorName={actorName}
        proposalNotes={proposalNotes}
        proposedAt={proposedAt}
        backUrl="/mis-mascotas"
      />

      <div className="mt-6 border-t border-[var(--color-ln-line-2)] pt-4">
        <Link
          href="/mis-mascotas"
          className="font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Mis mascotas
        </Link>
      </div>
    </div>
  );
}
