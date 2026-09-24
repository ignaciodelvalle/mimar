// Historial de tránsitos — Libreta Nacional redesign.

import Link from "next/link";

import { LnSectionHead } from "@/components/ui/DocElements";
import { db, fosterProposals, organizations, ownerships, pets } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";

import { formatDateShort } from "@/lib/utils/format";

const STATUS_LABELS = {
  pending: "Pendiente",
  accepted: "Aceptada",
  rejected: "Rechazada",
  expired: "Expirada",
  cancelled: "Cancelada",
} as const;

export default async function TransitosHistorialPage() {
  const { user } = await requireUserOrRedirect();

  const past = await db
    .select({ ownership: ownerships, pet: pets })
    .from(ownerships)
    // Art. 16: a foster's ownership row survives the erasure RPC (only
    // role='owner' pets are soft-deleted), so a finalized tránsito would still
    // name the erased pet and link /mis-mascotas. Drop it.
    .innerJoin(pets, and(eq(pets.id, ownerships.petId), isNull(pets.deletedAt)))
    .where(
      and(
        eq(ownerships.ownerUserId, user.id),
        eq(ownerships.role, "foster"),
        isNotNull(ownerships.endedAt),
      ),
    )
    .orderBy(desc(ownerships.endedAt));

  const noProposals = await db
    .select({ proposal: fosterProposals, pet: pets, org: organizations })
    .from(fosterProposals)
    // Art. 16: foster_proposals is untouched by the erasure RPC — an erased
    // pet's not-concretada proposal survives and would name the pet. Drop it.
    .innerJoin(pets, and(eq(pets.id, fosterProposals.petId), isNull(pets.deletedAt)))
    .innerJoin(organizations, eq(organizations.id, fosterProposals.organizationId))
    .where(
      and(
        eq(fosterProposals.volunteerUserId, user.id),
        ne(fosterProposals.status, "pending"),
        ne(fosterProposals.status, "accepted"),
      ),
    )
    .orderBy(desc(fosterProposals.proposedAt));

  return (
    <div className="mx-auto max-w-3xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/cuenta"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mi cuenta
      </Link>

      {/* Header */}
      <div className="mb-7">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          Historial de tránsitos
        </h1>
        <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
          Tránsitos terminados y propuestas que no llegaron a aceptarse.
        </p>
      </div>

      <div className="flex flex-col gap-8">
        {/* Finalized */}
        <section>
          <LnSectionHead num="01" title="Tránsitos finalizados" className="mb-4" />
          {past.length === 0 ? (
            <p className="text-md text-[var(--color-ln-mute)]">
              Todavía no tenés tránsitos finalizados.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
              {past.map(({ ownership, pet }) => (
                <div
                  key={ownership.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--color-ln-line-2)] px-4 py-3 last:border-b-0"
                >
                  <div>
                    <Link
                      href={`/mis-mascotas/${pet.publicToken}`}
                      className="text-md font-medium text-[var(--color-ln-ink)] no-underline hover:underline"
                    >
                      {pet.name}
                    </Link>
                    <p className="mt-px font-ln-mono text-sm text-[var(--color-ln-mute)]">
                      {ownership.startedAt ? formatDateShort(ownership.startedAt) : ""}
                      {ownership.endedAt && ` → ${formatDateShort(ownership.endedAt)}`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Not-accepted proposals */}
        <section>
          <LnSectionHead num="02" title="Propuestas no concretadas" className="mb-4" />
          {noProposals.length === 0 ? (
            <p className="text-md text-[var(--color-ln-mute)]">
              No hay propuestas en el historial.
            </p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
              {noProposals.map(({ proposal, pet, org }) => (
                <div
                  key={proposal.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--color-ln-line-2)] px-4 py-3 last:border-b-0"
                >
                  <div>
                    <p className="text-md font-medium text-[var(--color-ln-ink)]">
                      {pet.name}{" "}
                      <span className="font-normal text-[var(--color-ln-mute)]">
                        · {org.displayName}
                      </span>
                    </p>
                    {proposal.rejectionReason && (
                      <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">
                        Motivo: {proposal.rejectionReason}
                      </p>
                    )}
                  </div>
                  <span className="flex-shrink-0 font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-mute)]">
                    {STATUS_LABELS[proposal.status as keyof typeof STATUS_LABELS] ??
                      proposal.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Nav */}
      <div className="mt-8 border-t border-[var(--color-ln-line-2)] pt-3.5">
        <Link
          href="/cuenta/transitos/activos"
          className="font-ln-mono text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Tránsitos activos
        </Link>
      </div>
    </div>
  );
}
