// Adoption-finalize page. Capability-gated on `adoption.finalize`, validates
// the pet is in shelter_custody by the active org, and renders the composite-
// event form. Heavy lifting (DNI lookup, atomic custody transfer, stub-profile
// creation) lives in app/actions/adoption.ts.

import { db, fosterProposals, ownerships, pets, profiles } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { safePayloadUuid } from "@/lib/infra/sql-fragments";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { and, eq, isNull, sql } from "drizzle-orm";
import Link from "next/link";
import QRCode from "qrcode";

import { SponsorshipPossessionNotice } from "@/components/adoption/SponsorshipPossessionNotice";
import { OpBreach, OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";

import { FinalizeAdoptionForm } from "./FinalizeAdoptionForm";

export default async function AdoptionPage({
  params,
}: {
  params: Promise<{ orgToken: string; publicToken: string }>;
}) {
  const { orgToken, publicToken } = await params;

  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("adoption.finalize")) {
    return (
      <main className="min-h-screen bg-ln-op-page p-6 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">Permiso requerido</h1>
          <p className="text-md text-ln-op-ink-2">
            Para finalizar adopciones necesitás el permiso{" "}
            <code className="text-sm">adoption.finalize</code>.
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
  if (!petRow) {
    // "No disponible" is the WRONG story for the commonest way to arrive here:
    // having just finalized the adoption. Custody ends as part of that write, so
    // this guard fires on the re-render and the most important action a refugio
    // performs ended on a screen that reads as a failure — cowork had to open
    // another account to find out it had worked (master test CIU, A-2-a).
    //
    // finalizeAdoption DOES return `redirectTo` to the listing's success banner,
    // and the listing DOES consume `?adopcion=`. What is unreliable is the trip:
    // the client half of the N3 contract (useActionRedirect → location.assign)
    // does not always fire under the Next 15.5.x post-action navigation drop
    // this repo documents in lib/ui/full-page-action-nav.ts — the same defect
    // family as the dead sheet links. Rather than fight it again, the screen the
    // operator actually lands on now tells the truth: a custody row that ENDED
    // means the animal left this org, and that is the successful outcome.
    const [endedCustody] = await db
      .select({ endedAt: ownerships.endedAt })
      .from(ownerships)
      .innerJoin(pets, eq(ownerships.petId, pets.id))
      .where(
        and(
          eq(pets.publicToken, publicToken),
          eq(ownerships.ownerOrganizationId, organization.id),
          eq(ownerships.role, "shelter_custody"),
          sql`${ownerships.endedAt} IS NOT NULL`,
          // Art. 16: for an erased pet the "adopcion ya finalizada" story must
          // not be told either — generic "No disponible" is the honest floor.
          isNull(pets.deletedAt),
        ),
      )
      .limit(1);

    return (
      <main className="min-h-screen bg-ln-op-page p-6 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">
            {endedCustody
              ? "Listo — el animal ya no está bajo tu custodia"
              : "Animal no disponible"}
          </h1>
          <p className="text-md text-ln-op-ink-2">
            {endedCustody
              ? `La salida de la custodia de ${organization.displayName} quedó registrada como evento inmutable. Si acabás de finalizar una adopción, ya está hecha: la persona adoptante la ve en "Mis mascotas" y recibió su notificación.`
              : `Este animal no figura bajo custodia activa de ${organization.displayName}.`}
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
  const pet = petRow.pet;

  // rehome-by-titular, REQ-11: finalizing a SPONSORED pet moves the title from
  // the family it lives with to the adopter in one act; the org never held the
  // animal. The screen says so before the form does anything.
  const openSponsorship = await findOpenSponsorship(pet.id, db);
  const livesWithFamily = openSponsorship?.sponsoringOrganizationId === organization.id;

  // Detect "foster came from the pool" shortcut (spec §15.1). When an active
  // foster row was created via an accepted foster_proposal, surface the
  // shortcut button so the org can finalize directly to that foster.
  const [poolFosterRow] = await db
    .select({
      ownership: ownerships,
      foster: profiles,
    })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .innerJoin(
      fosterProposals,
      and(
        eq(fosterProposals.resolvedOwnershipId, ownerships.id),
        eq(fosterProposals.status, "accepted"),
      ),
    )
    .where(
      and(eq(ownerships.petId, pet.id), eq(ownerships.role, "foster"), isNull(ownerships.endedAt)),
    )
    .limit(1);

  const fosterShortcut = poolFosterRow
    ? {
        adopterUserId: poolFosterRow.foster.id,
        displayName: poolFosterRow.foster.displayName,
      }
    : null;

  // Approved online applications for this pet — the PRIMARY finalize path.
  // Finalizing against one of these transfers ownership to the applicant's real
  // account (closing the 100%-digital loop). D17: this is the org-side surface,
  // so listing applicants here is legitimate (unlike the applicant-facing pages).
  const approvedRows = await db.execute<{
    application_id: string;
    applicant_name: string | null;
  }>(sql`
    SELECT
      s.id::text AS application_id,
      pr.display_name AS applicant_name
    FROM pet_events s
    JOIN pet_events r ON r.pet_id = s.pet_id
      AND r.event_type = 'adoption_application_resolved'
      AND r.payload->>'application_event_id' = s.id::text
      AND r.payload->>'outcome' = 'approved'
    LEFT JOIN profiles pr ON pr.id = ${safePayloadUuid(sql`s.payload->>'applicant_user_id'`)}
    WHERE s.event_type = 'adoption_application_submitted'
      AND s.pet_id = ${pet.id}
      AND s.payload->>'applicant_user_id' IS NOT NULL
    ORDER BY r.recorded_at DESC
  `);

  const approvedApplications = approvedRows.map((r) => ({
    applicationEventId: r.application_id,
    applicantName: r.applicant_name,
  }));

  // Signup QR for the registered-adopter refusal panel (org-pilot-pack D9).
  // resolveSiteUrl() is the PRN-4 empty-SITE_URL fix — never an empty origin,
  // so the QR can never encode a host-less relative URL. Signup step 2 already
  // captures the DNI, so after registering the org simply re-verifies.
  const signupQrSvg = await QRCode.toString(`${resolveSiteUrl()}/signup`, {
    type: "svg",
    margin: 1,
    width: 160,
    errorCorrectionLevel: "M",
  });

  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <OpCrumbs
            items={[
              { label: "Mascotas", href: `/org/${orgToken}/mascotas` },
              { label: pet.name, href: `/org/${orgToken}/mascotas/${publicToken}` },
              { label: "Finalizar adopción" },
            ]}
          />
          <p className="text-sm uppercase tracking-wider text-ln-op-mute">
            {organization.displayName}
          </p>
          <h1 className="text-title font-semibold text-ln-op-ink">
            Finalizar adopción: {pet.name}
          </h1>
          <p className="text-md text-ln-op-ink-2">
            Esta acción cierra la custodia del refugio y, si hay un tránsito activo, también lo
            cierra. Queda registrado como evento inmutable en la historia de {pet.name}.
          </p>
        </header>

        {livesWithFamily && (
          <>
            <SponsorshipPossessionNotice
              petName={pet.name}
              orgDisplayName={organization.displayName}
              surface="op"
            />
            <p className="text-md text-ln-op-ink-2">
              Al finalizar, la titularidad de {pet.name} pasa de su familia actual a la persona
              adoptante en el mismo acto y {organization.displayName} deja de tener custodia
              registral.
            </p>
          </>
        )}

        {!pet.adoptionEligible && (
          <OpBreach
            title={
              pet.adoptionEligible === false
                ? `Mascota NO apta para adopción (motivo: ${pet.adoptionIneligibleReason ?? "sin motivo"})`
                : "Mascota sin evaluación de elegibilidad"
            }
            detail={
              <Link
                href={`/org/${orgToken}/mascotas/${publicToken}/eligibility`}
                className="underline"
              >
                Resolver elegibilidad
              </Link>
            }
          />
        )}

        <OpCard>
          <OpCardHead title="Datos de adopción" />
          <OpCardBody>
            <FinalizeAdoptionForm
              orgToken={orgToken}
              publicToken={publicToken}
              fosterShortcut={fosterShortcut}
              approvedApplications={approvedApplications}
              signupQrSvg={signupQrSvg}
            />
          </OpCardBody>
        </OpCard>

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
