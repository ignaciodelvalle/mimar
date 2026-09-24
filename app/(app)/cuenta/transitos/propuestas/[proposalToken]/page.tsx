// Proposal detail — Libreta Nacional redesign.
// ProposalActions (client component) unchanged.

import Link from "next/link";
import { notFound } from "next/navigation";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { db, fosterProposals, organizations, pets, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { formatDate, pluralizeEs, sexLabel, speciesLabel } from "@/lib/utils/format";
import { and, eq, isNull } from "drizzle-orm";

import { STATUS_LABELS } from "../status-labels";
import { ProposalActions } from "./ProposalActions";

export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ proposalToken: string }>;
}) {
  const { user } = await requireUserOrRedirect();
  const { proposalToken } = await params;

  const [row] = await db
    .select({ proposal: fosterProposals, pet: pets, org: organizations, proposer: profiles })
    .from(fosterProposals)
    // Art. 16: foster_proposals survives the erasure RPC, so an erased pet's
    // proposal detail would still render its name to the volunteer. Drop it —
    // the row falls out and the page 404s, as an erased pet should.
    .innerJoin(pets, and(eq(pets.id, fosterProposals.petId), isNull(pets.deletedAt)))
    .innerJoin(organizations, eq(organizations.id, fosterProposals.organizationId))
    .innerJoin(profiles, eq(profiles.id, fosterProposals.proposedByUserId))
    .where(eq(fosterProposals.publicToken, proposalToken))
    .limit(1);

  if (!row) notFound();
  if (row.proposal.volunteerUserId !== user.id) notFound();

  const { proposal, pet, org, proposer } = row;
  const expires = new Date(proposal.expiresAt);
  const warnings = (proposal.matchWarnings ?? []) as string[];

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/cuenta/transitos/propuestas"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Propuestas
      </Link>

      {/* Header */}
      <div className="mb-6">
        <p className="mb-1 font-ln-mono text-sm uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
          {org.displayName} te propone cuidar a
        </p>
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          {pet.name}
        </h1>
        <p className="mt-1 text-md text-[var(--color-ln-mute)]">
          {speciesLabel(pet.species)}
          {pet.breed && ` · ${pet.breed}`}
          {pet.sex && ` · ${sexLabel(pet.sex)}`}
        </p>
      </div>

      {/* Details card */}
      <LnCard className="mb-5">
        <LnCardHead title="Detalles de la propuesta" />
        <LnCardBody>
          <dl className="flex flex-col gap-2.5">
            <DetailRow label="Propuesto por">{proposer.displayName}</DetailRow>
            <DetailRow label="Duración estimada">
              {proposal.proposedDurationWeeks
                ? `${proposal.proposedDurationWeeks} ${pluralizeEs(proposal.proposedDurationWeeks, "semana")}`
                : "Sin definir"}
            </DetailRow>
            <DetailRow label="Expira">{formatDate(expires)}</DetailRow>
            {proposal.proposedNotes && (
              <DetailRow label="Notas del refugio">
                <span className="whitespace-pre-wrap">{proposal.proposedNotes}</span>
              </DetailRow>
            )}
          </dl>
        </LnCardBody>
      </LnCard>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mb-5">
          <LnCallout tone="warn" title="Avisos del matching">
            <ul className="mt-1.5 flex flex-col gap-1">
              {warnings.map((w) => (
                <li key={w} className="text-sm">
                  · {w}
                </li>
              ))}
            </ul>
          </LnCallout>
        </div>
      )}

      {/* Actions */}
      {proposal.status === "pending" ? (
        <ProposalActions
          proposalPublicToken={proposal.publicToken}
          petName={pet.name}
          orgName={org.displayName}
        />
      ) : (
        <p className="text-md text-[var(--color-ln-mute)]">
          Esta propuesta está en estado{" "}
          <strong>
            {STATUS_LABELS[proposal.status as keyof typeof STATUS_LABELS] ?? proposal.status}
          </strong>
          .
        </p>
      )}
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-md text-[var(--color-ln-ink-2)]">{children}</dd>
    </div>
  );
}
