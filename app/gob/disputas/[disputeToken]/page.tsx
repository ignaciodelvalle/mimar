import Link from "next/link";
import { notFound } from "next/navigation";

import { OpCard, OpCardBody, OpPill } from "@/components/ui/dashboard";
import {
  custodyDisputeParties,
  custodyDisputes,
  db,
  isInDisputeStatus,
  organizations,
  petEvents,
  pets,
  profiles,
} from "@/db";
import type { EventType } from "@/db/schema";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { eventTypeLabel, formatDateShort, speciesLabel } from "@/lib/utils/format";
import { and, desc, eq, inArray } from "drizzle-orm";

import { AddPartyForm } from "./AddPartyForm";
import { EscalateDisputeForm } from "./EscalateDisputeForm";
import { ResolveDisputeForm } from "./ResolveDisputeForm";
import { WithdrawDisputeButton } from "./WithdrawDisputeButton";
import { partyRoleLabel } from "./_party-roles";

// "open" must read the same word as the list screen (DisputasScreen.tsx maps
// dispute.status === "open" into CaseStatus "open" → canonical "Abierto" via
// CaseStatusBadge). "resolved"/"withdrawn" have no CaseStatus equivalent (the
// list collapses both into "closed"), so they stay local.
const STATUS_LABELS: Record<string, string> = {
  open: "Abierto",
  escalated: "Escalada",
  resolved: "Resuelta",
  withdrawn: "Retirada",
};

type StatusPillTone = "open" | "escalated" | "ok" | "neutral";

const STATUS_TONE: Record<string, StatusPillTone> = {
  open: "open",
  escalated: "escalated",
  resolved: "ok",
  withdrawn: "neutral",
};

export default async function DisputeDetailPage({
  params,
}: {
  params: Promise<{ disputeToken: string }>;
}) {
  const { disputeToken } = await params;
  const { profile, jurisdictions, user } = await requireGobReadAccessOrRedirect();

  const [row] = await db
    .select({ dispute: custodyDisputes, pet: pets })
    .from(custodyDisputes)
    .innerJoin(pets, eq(pets.id, custodyDisputes.petId))
    .where(eq(custodyDisputes.publicToken, disputeToken))
    .limit(1);
  if (!row) notFound();
  const { dispute, pet } = row;

  // Govt scope guard — subsumption-aware so a whole-province operator (e.g.
  // whole-CABA) opens a dispute tagged to a barrio in that province, matching
  // the list clause. See jurisdictionScopeContains / jurisdiction-canonical.
  if (profile.role === "govt") {
    const inScope = jurisdictionScopeContains(
      jurisdictions,
      dispute.jurisdictionProvince,
      dispute.jurisdictionLocality,
    );
    if (!inScope) notFound();
  }

  const parties = await db
    .select({
      party: custodyDisputeParties,
      userProfile: profiles,
      org: organizations,
    })
    .from(custodyDisputeParties)
    .leftJoin(profiles, eq(profiles.id, custodyDisputeParties.partyUserId))
    .leftJoin(organizations, eq(organizations.id, custodyDisputeParties.partyOrganizationId))
    .where(eq(custodyDisputeParties.disputeId, dispute.id))
    .orderBy(custodyDisputeParties.addedAt);

  // Pet timeline filtered to custody-related events. Read-only context for the
  // resolver -- full history lives in the pet detail surfaces.
  const CUSTODY_EVENT_TYPES = [
    "pet_registered",
    "custody_transferred",
    "custody_transfer_proposed",
    "shelter_intake_recorded",
    "foster_assigned",
    "foster_ended",
    "adoption_finalized",
    "adoption_withdrawn",
    "adoption_revoked",
    "abandonment_reported",
    "custody_dispute_raised",
    "custody_dispute_resolved",
  ] as const;
  const timeline = await db
    .select({
      id: petEvents.id,
      eventType: petEvents.eventType,
      occurredAt: petEvents.occurredAt,
      authorRole: petEvents.authorRole,
    })
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), inArray(petEvents.eventType, [...CUSTODY_EVENT_TYPES])))
    .orderBy(desc(petEvents.occurredAt))
    .limit(25);

  // The read-only national role reads the file and gets NO resolve/withdraw
  // form: the actions behind them gate on the write-authority guard, so
  // rendering the forms could only end in a bounce.
  // Both LIVE states carry the same authority actions. An escalated dispute is
  // still resolvable and still withdrawable (PO decision 2A, 2026-09-22) — the
  // matter moved to judicial channels, the file did not close, and an arbiter
  // who could no longer act on it would have no way to record the outcome when
  // the judgement arrives.
  const isLive = isInDisputeStatus(dispute.status);
  const canResolve = isLive && profile.role !== "national";
  const canWithdraw = isLive && (profile.role === "admin" || dispute.raisedByUserId === user.id);
  // Escalating twice is refused by the use-case; do not offer the form either.
  const canEscalate = canResolve && dispute.status !== "escalated";

  return (
    <div className="space-y-6 max-w-3xl">
      <header className="space-y-2">
        <Link
          href="/gob/casos?expediente=disputas"
          className="text-md text-ln-op-mute hover:text-ln-op-ink underline underline-offset-4"
        >
          {"←"} Volver a la lista
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-title font-semibold text-ln-op-ink">{pet.name}</h1>
          <OpPill tone={STATUS_TONE[dispute.status] ?? "neutral"}>
            {STATUS_LABELS[dispute.status] ?? dispute.status}
          </OpPill>
        </div>
        <p className="text-md text-ln-op-mute">
          {speciesLabel(pet.species)}
          {pet.breed && ` · ${pet.breed}`} · {dispute.jurisdictionLocality},{" "}
          {dispute.jurisdictionProvince}
        </p>
        <p className="text-xs text-ln-op-faint font-ln-mono">{dispute.publicToken}</p>
      </header>

      {isLive && (
        <div className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg p-3 text-md text-ln-op-warn">
          {dispute.status === "escalated"
            ? "Disputa escalada a la vía judicial — la mascota sigue bloqueada para transferencias o adopción hasta que se resuelva o retire."
            : "Disputa abierta — la mascota queda bloqueada para transferencias o adopción hasta que se resuelva o retire."}
        </div>
      )}

      {dispute.status === "resolved" && dispute.resolutionSummary && (
        <section className="rounded-[var(--radius-md)] border border-ln-op-ok-bd bg-ln-op-ok-bg p-4 space-y-2">
          <p className="text-md font-medium text-ln-op-ok">Resolucion: {dispute.resolution}</p>
          <p className="text-md text-ln-op-ok whitespace-pre-wrap">{dispute.resolutionSummary}</p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-ln-op-ink">Partes</h2>
        {parties.length === 0 ? (
          <p className="text-md text-ln-op-mute">Sin partes registradas todavía.</p>
        ) : (
          <ul className="space-y-2">
            {parties.map(({ party, userProfile, org }) => (
              <li key={party.id}>
                <OpCard>
                  <OpCardBody>
                    <p className="text-md font-medium text-ln-op-ink">
                      {userProfile?.displayName ?? org?.displayName ?? "Desconocido"}
                      <span className="ml-2 text-sm text-ln-op-mute font-normal">
                        {partyRoleLabel(party.partyRole)}
                      </span>
                    </p>
                    {party.partyPositionSummary && (
                      <p className="text-sm text-ln-op-mute mt-1">{party.partyPositionSummary}</p>
                    )}
                    <p className="text-xs text-ln-op-faint mt-1">
                      Sumada el {formatDateShort(party.addedAt)}
                    </p>
                  </OpCardBody>
                </OpCard>
              </li>
            ))}
          </ul>
        )}
        {canResolve && <AddPartyForm disputeToken={disputeToken} />}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-ln-op-ink">Historia de custodia</h2>
        {timeline.length === 0 ? (
          <p className="text-md text-ln-op-mute">Sin eventos de custodia previos.</p>
        ) : (
          <ul className="space-y-1.5 text-md">
            {timeline.map((e) => (
              <li
                key={e.id}
                className="flex items-baseline justify-between gap-3 border-l-2 border-ln-op-line pl-3 py-1"
              >
                <span className="font-ln-mono text-sm text-ln-op-ink-2">
                  {eventTypeLabel(e.eventType as EventType)}
                </span>
                <span className="text-sm text-ln-op-mute whitespace-nowrap">
                  {formatDateShort(e.occurredAt)}
                  {e.authorRole && <span className="ml-2 text-ln-op-faint">· {e.authorRole}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canResolve && (
        <section className="space-y-3 pt-2 border-t border-ln-op-line">
          <h2 className="text-base font-semibold text-ln-op-ink">Resolver disputa</h2>
          <ResolveDisputeForm disputeToken={disputeToken} />
          <div className="pt-2 space-y-2">
            <p className="text-sm text-ln-op-mute">Otras acciones</p>
            {canEscalate && <EscalateDisputeForm disputeToken={disputeToken} />}
            {canWithdraw && <WithdrawDisputeButton disputeToken={disputeToken} />}
          </div>
        </section>
      )}
    </div>
  );
}
