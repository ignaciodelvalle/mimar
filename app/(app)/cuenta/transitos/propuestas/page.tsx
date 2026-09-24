// Propuestas de tránsito inbox — Libreta Nacional redesign.

import Link from "next/link";

import { LnSectionHead } from "@/components/ui/DocElements";
import { db, fosterProposals, organizations, pets } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { formatDate, pluralizeEs, speciesLabel } from "@/lib/utils/format";
import { and, desc, eq, isNull } from "drizzle-orm";

import { STATUS_LABELS } from "./status-labels";

export default async function PropuestasInboxPage() {
  const { user } = await requireUserOrRedirect();

  const proposals = await db
    .select({ proposal: fosterProposals, pet: pets, org: organizations })
    .from(fosterProposals)
    // Art. 16: the erasure RPC never touches foster_proposals, so an erased
    // pet's proposal survives and would surface its name to the volunteer (a
    // third party). Drop it — every action on the pet 404s anyway (same
    // reasoning as voluntarios/propuestas/page.tsx).
    .innerJoin(pets, and(eq(pets.id, fosterProposals.petId), isNull(pets.deletedAt)))
    .innerJoin(organizations, eq(organizations.id, fosterProposals.organizationId))
    .where(eq(fosterProposals.volunteerUserId, user.id))
    .orderBy(desc(fosterProposals.proposedAt));

  const active = proposals.filter((p) => p.proposal.status === "pending");
  const past = proposals.filter((p) => p.proposal.status !== "pending");

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
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Propuestas de tránsito
          </h1>
          <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
            Los refugios te proponen cuidar mascotas que tienen en custodia. Tenés 7 días para
            responder antes de que la propuesta expire.
          </p>
        </div>
        <Link
          href="/cuenta/ofrecerme-como-transito"
          className="mt-1 flex-shrink-0 rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-3.5 py-2 font-ln-sans text-md font-semibold text-white no-underline hover:bg-[var(--color-ln-azul-700)]"
        >
          Ofrecerme como tránsito
        </Link>
      </div>

      <div className="flex flex-col gap-8">
        {/* Active */}
        <section>
          <LnSectionHead
            num="01"
            title="Activas"
            meta={
              active.length > 0
                ? `${active.length} ${pluralizeEs(active.length, "pendiente", "pendientes")}`
                : undefined
            }
            className="mb-4"
          />
          {active.length === 0 ? (
            <p className="text-md text-[var(--color-ln-mute)]">No tenés propuestas pendientes.</p>
          ) : (
            <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
              {active.map(({ proposal, pet, org }) => (
                <Link
                  key={proposal.id}
                  href={`/cuenta/transitos/propuestas/${proposal.publicToken}`}
                  className="flex items-center justify-between gap-3 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
                >
                  <div>
                    <p className="text-md font-medium text-[var(--color-ln-ink)]">
                      {org.displayName}{" "}
                      <span className="font-normal text-[var(--color-ln-mute)]">→ {pet.name}</span>
                    </p>
                    <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                      {speciesLabel(pet.species)}
                      {proposal.proposedDurationWeeks &&
                        ` · ${proposal.proposedDurationWeeks} sem.`}{" "}
                      · Expira {formatDate(proposal.expiresAt)}
                    </p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="flex-shrink-0 text-base text-[var(--color-ln-mute)]"
                  >
                    ›
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* History */}
        {past.length > 0 && (
          <section>
            <LnSectionHead num="02" title="Historial" className="mb-4" />
            <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
              {past.map(({ proposal, pet, org }) => (
                <div
                  key={proposal.id}
                  className="flex items-center justify-between gap-3 border-b border-[var(--color-ln-line-2)] px-4 py-3 last:border-b-0"
                >
                  <p className="text-md text-[var(--color-ln-ink-2)]">
                    {org.displayName} · {pet.name}
                  </p>
                  <span
                    className={`flex-shrink-0 font-ln-mono text-xs uppercase tracking-[.06em] ${
                      proposal.status === "accepted"
                        ? "text-[var(--color-ln-ok)]"
                        : "text-[var(--color-ln-mute)]"
                    }`}
                  >
                    {STATUS_LABELS[proposal.status as keyof typeof STATUS_LABELS] ??
                      proposal.status}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
