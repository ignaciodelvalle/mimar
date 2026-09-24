// Foster-assignment page. Verifies the pet is in shelter_custody by the
// active org, then lets a user with `foster.assign` pick an active member
// of the org as the foster.

import { db, organizationMemberships, ownerships, pets, profiles } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";

import { AssignFosterForm, type FosterCandidate } from "./AssignFosterForm";

export default async function AssignFosterPage({
  params,
}: {
  params: Promise<{ orgToken: string; publicToken: string }>;
}) {
  const { orgToken, publicToken } = await params;

  const { user, organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("foster.assign")) {
    return (
      <main className="min-h-screen bg-ln-op-page p-6 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">Permiso requerido</h1>
          <p className="text-md text-ln-op-ink-2">
            Para asignar tránsitos necesitás el permiso{" "}
            <code className="text-sm">foster.assign</code>.
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
    return (
      <main className="min-h-screen bg-ln-op-page p-6 flex items-center justify-center">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">Animal no disponible</h1>
          <p className="text-md text-ln-op-ink-2">
            Este animal no figura bajo custodia activa de {organization.displayName}.
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

  // Candidate fosters: every active member of the org except the actor and
  // `vet_individual` members. AGENTS.md → "A foster requires an active
  // organization_membership" doesn't name a specific membership role, so
  // admin/coordinator/member/volunteer/foster all remain eligible — but
  // `vet_individual` links a veterinarian to the org for clinical purposes,
  // not physical caretaking, so listing them as foster candidates was a bug
  // (2026-07 persona validation). The <select> sorts foster-role first so
  // coordinators see them at the top; the empty-state hint in
  // AssignFosterForm already covers orgs left with zero candidates.
  const candidateRows = await db
    .select({
      userId: organizationMemberships.userId,
      role: organizationMemberships.role,
      displayName: profiles.displayName,
    })
    .from(organizationMemberships)
    .innerJoin(profiles, eq(profiles.id, organizationMemberships.userId))
    .where(
      and(
        eq(organizationMemberships.organizationId, organization.id),
        isNull(organizationMemberships.leftAt),
        ne(organizationMemberships.userId, user.id),
        ne(organizationMemberships.role, "vet_individual"),
      ),
    )
    .orderBy(asc(organizationMemberships.role), asc(profiles.displayName));

  const candidates: FosterCandidate[] = candidateRows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    role: row.role,
  }));

  return (
    <main className="min-h-screen bg-ln-op-page p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-1">
          <OpCrumbs
            items={[
              { label: "Mascotas", href: `/org/${orgToken}/mascotas` },
              { label: pet.name, href: `/org/${orgToken}/mascotas/${publicToken}` },
              { label: "Asignar tránsito" },
            ]}
          />
          <p className="text-sm uppercase tracking-wider text-ln-op-mute">
            {organization.displayName}
          </p>
          <h1 className="text-title font-semibold text-ln-op-ink">Asignar tránsito: {pet.name}</h1>
          <p className="text-md text-ln-op-ink-2">
            La custodia del refugio sigue activa mientras el tránsito cuida físicamente al animal.
          </p>
        </header>

        <OpCard>
          <OpCardHead title="Datos del tránsito" />
          <OpCardBody>
            <AssignFosterForm
              orgToken={orgToken}
              publicToken={publicToken}
              candidates={candidates}
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
