// Sender entry point — propose a cross-org transfer for a pet currently
// under this org's active shelter_custody. The form requires a pet
// token via `?petToken=DIM-…` (typically linked from
// /org/[orgToken]/mascotas/[petToken]).

// ---------------------------------------------------------------------------
// WIRED (sprint 4 PR-033 — 2026-05-27)
//
// Reachable from /org/[orgToken]/mascotas/[publicToken] "Proponer transferencia"
// action; form is now a 3-step Poncho wizard with SuccessScreen on submit.
// ---------------------------------------------------------------------------

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import Link from "next/link";

import { OpBreach, OpCard, OpCardBody, OpCrumbs } from "@/components/ui/dashboard";
import { db, organizations, ownerships, pets } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { speciesLabel } from "@/lib/utils/format";
import { firstSearchParam } from "@/lib/utils/search-params";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { ProposeTransferForm } from "./ProposeTransferForm";

export default async function OrgTransferenciaNuevaPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgToken: string }>;
  searchParams: Promise<{ petToken?: string | string[] }>;
}) {
  const { orgToken } = await params;
  const sp = await searchParams;
  const petToken = firstSearchParam(sp.petToken)?.trim() ?? "";
  const { organization } = await requireOrgAccessByToken(orgToken);

  // Capability gate — the SAME predicate the action enforces
  // (requireCapabilityForOrgToken('org.transfer.propose') in
  // src/modules/transfers/actions.ts). This used to be a membership-ROLE check
  // against {admin, coordinator}, which made an explicitly granted
  // `org.transfer.propose` inert: nav-presets.ts already shows Transferencias
  // to anyone holding the capability, so a `member` with the grant could reach
  // this page, be told "solo roles admin o coordinator", and never discover
  // that the action would in fact have accepted them. admin/coordinator still
  // pass — the capability is implicit for both (COORDINATOR_IMPLICIT_CAPS /
  // the admin universal grant), so this gate is a superset of the old one.
  // A page READ (the form; the action re-checks on POST with the write
  // default): a deactivated institutional account keeps it, per
  // lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapability("org.transfer.propose", organization.id, {
    access: "read",
  });

  if (auth.error !== null) {
    return (
      <div className="max-w-2xl space-y-6">
        <OpCrumbs
          items={[
            { label: "Panel", href: `/org/${orgToken}` },
            { label: "Transferencias", href: `/org/${orgToken}/transferencias` },
            { label: "Nueva propuesta" },
          ]}
        />
        <h1 className="text-title font-semibold text-ln-op-ink">
          Nueva propuesta de transferencia
        </h1>
        <OpBreach
          title="Te falta el permiso «Proponer transferencias entre orgs»"
          detail={`Tu membresía en ${organization.displayName} no tiene esa capacidad concedida, así que no podés abrir una propuesta de transferencia. Un admin de la organización puede otorgártela desde Permisos — no hace falta cambiarte el rol.`}
        />
        <p className="text-md text-ln-op-mute">{auth.error}</p>
        <div className="flex gap-4">
          <Link
            href={`/org/${orgToken}/admin/permisos`}
            className="text-md text-ln-op-azul hover:underline no-underline"
          >
            Ver mis permisos
          </Link>
          <Link
            href={`/org/${orgToken}/transferencias`}
            className="text-md text-ln-op-azul hover:underline no-underline"
          >
            ← Volver a transferencias
          </Link>
        </div>
      </div>
    );
  }

  if (!petToken) {
    // Step-0 pet picker: show org's active shelter_custody pets so the user can
    // choose one rather than hitting a dead wall.
    const custodyPets = await db
      .select({
        publicToken: pets.publicToken,
        name: pets.name,
        species: pets.species,
      })
      .from(pets)
      .innerJoin(
        ownerships,
        and(
          eq(ownerships.petId, pets.id),
          eq(ownerships.ownerOrganizationId, organization.id),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
          // Art. 16: erasure soft-deletes the pet but not the ownership rows.
          isNull(pets.deletedAt),
        ),
      )
      .orderBy(pets.name);

    return (
      <div className="max-w-2xl space-y-6">
        <OpCrumbs
          items={[
            { label: "Panel", href: `/org/${orgToken}` },
            { label: "Transferencias", href: `/org/${orgToken}/transferencias` },
            { label: "Nueva propuesta" },
          ]}
        />
        <header className="space-y-1">
          <h1 className="text-title font-semibold text-ln-op-ink">
            Nueva propuesta de transferencia
          </h1>
          <p className="text-md text-ln-op-mute">
            Elegí la mascota en custodia que querés transferir.
          </p>
        </header>

        {custodyPets.length === 0 ? (
          <div className="space-y-3">
            <p className="rounded-[var(--radius-md)] border border-dashed border-ln-op-line p-8 text-center text-md text-ln-op-mute">
              No tenés mascotas en custodia para transferir.
            </p>
            <Link
              href={`/org/${orgToken}/mascotas`}
              className="inline-block text-md text-ln-op-azul hover:underline no-underline"
            >
              → Ir a Mascotas
            </Link>
          </div>
        ) : (
          <OpCard>
            <OpCardBody className="p-0">
              <ul className="divide-y divide-ln-op-line">
                {custodyPets.map((p) => (
                  <li key={p.publicToken}>
                    <Link
                      href={`/org/${orgToken}/transferencias/nueva?petToken=${p.publicToken}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ln-op-stripe transition-colors no-underline"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-md font-medium text-ln-op-ink">{p.name}</p>
                        <p className="text-sm text-ln-op-mute">{speciesLabel(p.species)}</p>
                      </div>
                      <span className="text-sm text-ln-op-azul shrink-0">Seleccionar →</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </OpCardBody>
          </OpCard>
        )}
      </div>
    );
  }

  // Resolve pet + verify the org holds active shelter_custody.
  const [petRow] = await db
    .select({ pet: pets })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, petToken),
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
      <div className="max-w-2xl space-y-6">
        <OpCrumbs
          items={[
            { label: "Panel", href: `/org/${orgToken}` },
            { label: "Transferencias", href: `/org/${orgToken}/transferencias` },
            { label: "Nueva propuesta" },
          ]}
        />
        <h1 className="text-title font-semibold text-ln-op-ink">
          Nueva propuesta de transferencia
        </h1>
        <OpBreach
          title="Mascota no encontrada"
          detail={`No encontramos una mascota con ese token bajo custodia activa de ${organization.displayName}.`}
        />
        <Link
          href={`/org/${orgToken}/transferencias`}
          className="text-md text-ln-op-azul hover:underline no-underline"
        >
          ← Volver a transferencias
        </Link>
      </div>
    );
  }
  const pet = petRow.pet;

  // Pre-fetch the verified-org candidates (small list, capped at 200).
  const receivers = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      orgType: organizations.orgType,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.verified, true),
        eq(organizations.status, "active"),
        inArray(organizations.orgType, ["shelter", "rescue_network", "clinic"]),
        ne(organizations.id, organization.id),
      ),
    )
    .orderBy(organizations.displayName)
    .limit(200);

  const receiverOptions = receivers.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    orgType: r.orgType,
    jurisdiction:
      r.jurisdictionLocality && r.jurisdictionProvince
        ? `${r.jurisdictionLocality}, ${r.jurisdictionProvince}`
        : (r.jurisdictionProvince ?? ""),
  }));

  return (
    <div className="max-w-xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Panel", href: `/org/${orgToken}` },
          { label: "Transferencias", href: `/org/${orgToken}/transferencias` },
          { label: "Nueva propuesta" },
        ]}
      />

      <header className="space-y-1">
        <h1 className="text-title font-semibold text-ln-op-ink">Transferir {pet.name}</h1>
        <p className="text-md text-ln-op-mute">
          Proponer la transferencia de custodia desde {organization.displayName} a otra organización
          verificada.
        </p>
      </header>

      <ProposeTransferForm
        senderOrgToken={orgToken}
        petPublicToken={pet.publicToken}
        petName={pet.name}
        receivers={receiverOptions}
      />
    </div>
  );
}
