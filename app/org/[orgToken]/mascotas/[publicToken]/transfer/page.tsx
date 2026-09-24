// Custody transfer page (org → org handoff). Gates on
// custody.transfer + verifies the pet is currently held by the active org
// under a transferable role (shelter_custody or owner). The form posts to
// transferCustodyAction.

import { db, organizations, ownerships, pets } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OpBreach, OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";

import { TransferCustodyForm } from "./TransferCustodyForm";

const TRANSFERABLE_ROLES = ["shelter_custody", "owner"] as const;

export default async function TransferCustodyPage({
  params,
}: {
  params: Promise<{ orgToken: string; publicToken: string }>;
}) {
  const { orgToken, publicToken } = await params;
  const { organization: orgFromToken } = await requireOrgAccessByToken(orgToken);
  // A page READ (the form; the action re-checks on POST with the write
  // default): a deactivated institutional account keeps it, per
  // lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapability("custody.transfer", orgFromToken.id, { access: "read" });
  if (auth.error !== null) {
    return (
      <main className="min-h-screen bg-ln-op-page p-6">
        <div className="max-w-2xl mx-auto pt-8 space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">Sin acceso</h1>
          <p className="text-md text-ln-op-ink-2">{auth.error}</p>
          <Link
            href={`/org/${orgToken}/mascotas`}
            className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
          >
            ← Volver a mascotas
          </Link>
        </div>
      </main>
    );
  }
  const { organization } = auth;

  // Verify the pet is currently held by the source org under a transferable
  // role. We don't gate the form on this in the UI — the action will reject
  // too — but pre-validating saves the user a round trip.
  const [petRow] = await db
    .select({ pet: pets, role: ownerships.role })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        eq(ownerships.ownerOrganizationId, organization.id),
        isNull(ownerships.endedAt),
        // Art. 16: erasure soft-deletes the pet but not the ownership rows.
        isNull(pets.deletedAt),
      ),
    )
    .limit(1);
  if (!petRow) notFound();
  if (!(TRANSFERABLE_ROLES as readonly string[]).includes(petRow.role as string)) {
    return (
      <main className="min-h-screen bg-ln-op-page p-6">
        <div className="max-w-2xl mx-auto pt-8 space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">No se puede transferir</h1>
          <p className="text-md text-ln-op-ink-2">
            {petRow.pet.name} no está en un rol transferible (custodia o dueño). Solo se pueden
            transferir esos dos roles.
          </p>
          <Link
            href={`/org/${orgToken}/mascotas`}
            className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
          >
            ← Volver a mascotas
          </Link>
        </div>
      </main>
    );
  }

  // Destination options: every verified org except the source. Ordered by
  // displayName for predictable picking.
  const destinations = await db
    .select({ id: organizations.id, displayName: organizations.displayName })
    .from(organizations)
    .where(and(eq(organizations.verified, true), ne(organizations.id, organization.id)))
    .orderBy(asc(organizations.displayName));

  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <OpCrumbs
            items={[
              { label: "Mascotas", href: `/org/${orgToken}/mascotas` },
              { label: petRow.pet.name, href: `/org/${orgToken}/mascotas/${publicToken}` },
              { label: "Transferir custodia" },
            ]}
          />
          <p className="text-sm uppercase tracking-wider text-ln-op-mute">
            {organization.displayName}
          </p>
          <h1 className="text-title font-semibold text-ln-op-ink">Transferir {petRow.pet.name}</h1>
          <p className="text-md text-ln-op-ink-2">
            Pasá la custodia a otra organización verificada. La acción es atómica: cierra el
            registro actual y abre uno nuevo en el destino con el evento{" "}
            <code className="text-sm bg-ln-op-stripe px-1 rounded">custody_transferred</code>.
          </p>
        </header>

        {destinations.length === 0 ? (
          <OpBreach
            title="Sin destinos disponibles"
            detail="No hay otras organizaciones verificadas en el sistema. Pediles que se verifiquen antes de transferir."
          />
        ) : (
          <OpCard>
            <OpCardHead title="Datos de la transferencia" />
            <OpCardBody>
              <TransferCustodyForm
                orgToken={orgToken}
                publicToken={petRow.pet.publicToken}
                destinations={destinations}
              />
            </OpCardBody>
          </OpCard>
        )}

        <footer className="pt-4 border-t border-ln-op-line">
          <Link
            href={`/org/${orgToken}/mascotas`}
            className="text-sm text-ln-op-mute underline hover:text-ln-op-ink"
          >
            ← Volver a mascotas
          </Link>
        </footer>
      </div>
    </main>
  );
}
