import { LnEmptyState } from "@/components/ui/EmptyState";
import { db, fosterProposals, pets, profiles } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { formatDateShort } from "@/lib/utils/format";
import { capRows } from "@/lib/utils/list-pagination";
import { and, desc, eq, isNull } from "drizzle-orm";

import { CancelProposalButton } from "./CancelProposalButton";

const STATUS_LABELS = {
  pending: "Pendiente",
  accepted: "Aceptada",
  rejected: "Rechazada",
  expired: "Expirada",
  cancelled: "Cancelada",
} as const;

type ProposalStatus = keyof typeof STATUS_LABELS;

function isProposalStatus(value: string | undefined): value is ProposalStatus {
  return value !== undefined && value in STATUS_LABELS;
}

const STATUS_TONE: Record<string, string> = {
  pending: "text-ln-op-warn",
  accepted: "text-ln-op-ok",
  rejected: "text-ln-op-mute",
  expired: "text-ln-op-mute",
  cancelled: "text-ln-op-mute",
};

export default async function OrgPropuestasPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgToken: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { orgToken } = await params;
  const { organization } = await requireOrgAccessByToken(orgToken);
  const filters = await searchParams;

  // #815 audit finding #8: previously fetched limit(200) and THEN filtered by
  // status in memory — a status tab with truncated visibility (e.g. 200
  // "pending" rows exist but only some fit before the cap) could show fewer
  // rows than actually exist, with no signal that data was dropped. The
  // status filter is now pushed into the SQL WHERE before the limit, and a
  // truncated notice covers whatever cap is left (fetch N+1, same pattern as
  // adopciones/page.tsx).
  const statusFilter = isProposalStatus(filters.status) ? filters.status : null;

  const rows = await db
    .select({
      proposal: fosterProposals,
      pet: pets,
      volunteer: profiles,
    })
    .from(fosterProposals)
    // Art. 16: a proposal names the pet (full row selected below) and the
    // erasure RPC never touches foster_proposals — an erased pet's proposal
    // is a card of dead ends (every action on the pet 404s), so it drops,
    // same reasoning as mascotas/page.tsx.
    .innerJoin(pets, and(eq(pets.id, fosterProposals.petId), isNull(pets.deletedAt)))
    .innerJoin(profiles, eq(profiles.id, fosterProposals.volunteerUserId))
    .where(
      statusFilter
        ? and(
            eq(fosterProposals.organizationId, organization.id),
            eq(fosterProposals.status, statusFilter),
          )
        : eq(fosterProposals.organizationId, organization.id),
    )
    .orderBy(desc(fosterProposals.proposedAt))
    .limit(201);

  const { rows: filtered, truncated } = capRows(rows, 200);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Voluntarios</p>
        <h1 className="text-title font-semibold text-ln-op-ink">Propuestas de tránsito emitidas</h1>
        <p className="mt-1 text-md text-ln-op-mute">
          Propuestas que tu organización envió al pool de voluntarios.
        </p>
      </header>

      {/* Tab bar — Pool links to the index; Propuestas is this page */}
      <nav className="flex gap-1 border-b border-ln-op-line">
        <a
          href={`/org/${orgToken}/voluntarios`}
          className="px-4 py-2 text-md font-medium no-underline border-b-2 border-transparent text-ln-op-mute hover:text-ln-op-ink-2 transition-colors"
        >
          Pool
        </a>
        <span
          className="px-4 py-2 text-md font-medium border-b-2 border-ln-op-azul text-ln-op-azul"
          aria-current="page"
        >
          Propuestas
        </span>
      </nav>

      <div className="flex flex-wrap gap-2">
        <FilterLink orgToken={orgToken} current={filters.status} value={null} label="Todas" />
        {(["pending", "accepted", "rejected", "expired", "cancelled"] as const).map((s) => (
          <FilterLink
            key={s}
            orgToken={orgToken}
            current={filters.status}
            value={s}
            label={STATUS_LABELS[s]}
          />
        ))}
      </div>

      {filtered.length === 0 ? (
        <LnEmptyState icon="propuesta" title="No hay propuestas." />
      ) : (
        <>
          <ul className="space-y-2">
            {filtered.map(({ proposal, pet, volunteer }) => (
              <li
                key={proposal.id}
                className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-md font-medium text-ln-op-ink">
                      {volunteer.displayName}{" "}
                      <span className="font-normal text-ln-op-mute">→ {pet.name}</span>
                    </p>
                    <p className="text-sm text-ln-op-mute">
                      {formatDateShort(proposal.proposedAt)} ·{" "}
                      <span className={STATUS_TONE[proposal.status] ?? ""}>
                        {STATUS_LABELS[proposal.status as keyof typeof STATUS_LABELS] ??
                          proposal.status}
                      </span>
                      {proposal.proposedDurationWeeks &&
                        ` · ${proposal.proposedDurationWeeks} sem.`}
                      {proposal.rejectionReason && ` · motivo: ${proposal.rejectionReason}`}
                    </p>
                  </div>
                  {proposal.status === "pending" && (
                    <CancelProposalButton proposalPublicToken={proposal.publicToken} />
                  )}
                </div>
              </li>
            ))}
          </ul>
          {truncated && (
            <p className="text-sm text-ln-op-mute">
              Mostrando las primeras 200. Hay más — usá los filtros de estado de arriba para acotar
              la lista.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FilterLink({
  orgToken,
  current,
  value,
  label,
}: {
  orgToken: string;
  current: string | undefined;
  value: string | null;
  label: string;
}) {
  const href = value
    ? `/org/${orgToken}/voluntarios/propuestas?status=${value}`
    : `/org/${orgToken}/voluntarios/propuestas`;
  const active = (current ?? null) === value;
  return (
    <a
      href={href}
      className={[
        "rounded-full border px-3 py-[5px] text-sm no-underline transition-colors",
        active
          ? "border-ln-op-azul bg-ln-op-azul text-white"
          : "border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe",
      ].join(" ")}
    >
      {label}
    </a>
  );
}
