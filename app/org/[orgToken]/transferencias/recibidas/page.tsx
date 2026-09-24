// Receiver inbox of incoming transfer proposals — two kinds:
//
// 1. custody_transfer_handshake  — routine cross-org custody transfer.
//    Sender opened a handshake case; the proposal event contains reason/notes.
//
// 2. custody_episode (decomiso)  — state seizure under Ley 14.346.
//    Discriminator: caseKind='custody_episode' + openedByOrganizationId.orgType=
//    'sanitary_authority'. These carry a DECOMISO badge, the govt org name, and
//    the seizure motive from the shelter_intake_recorded payload.
//    Reference: decomiso spec §7 + DC13.
//
// Both kinds use receiverOrganizationId (canonical, migration 0043) as the
// "directed at this org" signal, with a payload fallback for legacy rows.

// ---------------------------------------------------------------------------
// WIRED (sprint 5 PR-047 + sprint 4 PR-033 — 2026-05-27)
// S5 extension: decomiso badge + custody_episode proposals (2026-06-04).
// ---------------------------------------------------------------------------

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { ResultCount } from "@/components/ui/ResultCount";
import { OpBreach, OpCard, OpCardBody, OpCrumbs, OpPill } from "@/components/ui/dashboard";
import { cases, db, organizations, petEvents, pets } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { formatDate, requestOutcomeLabel } from "@/lib/utils/format";
import { capRows } from "@/lib/utils/list-pagination";

import { DecomisoHandoffActions } from "./DecomisoHandoffActions";
import { IncomingTransferActions } from "./IncomingTransferActions";

const REASON_LABEL: Record<string, string> = {
  space_constraint: "Falta de espacio",
  specialization_needed: "Especialización requerida",
  network_redistribution: "Redistribución en network",
  shelter_closing: "Cierre operativo",
  post_adoption_failed_return: "Devolución post-adopción",
  org_to_org_handoff: "Handoff inter-organizacional",
  other: "Otro motivo",
};

const SEIZURE_MOTIVE_LABEL: Record<string, string> = {
  maltrato_fisico: "Maltrato físico",
  abandono_extremo: "Abandono extremo",
  acumulacion: "Acumulación",
  trafico: "Tráfico",
  sin_refugio_critico: "Sin refugio (crítico)",
  pelea_de_perros: "Pelea de perros",
  otro: "Otro motivo",
};

// "open" comes from requestOutcomeLabel — shared with the sender's
// Transferencias screen so the same case status never reads two different
// words across the org's own two tabs (copy audit 2026-08-04).
const STATUS_LABEL: Record<string, string> = {
  open: requestOutcomeLabel("open") ?? "Pendiente",
  closed: "Cerrada",
};

const CLOSED_REASON_LABEL: Record<string, string> = {
  resolved: "Aceptada",
  cancelled: "Rechazada / Cancelada",
  auto_expired: "Expirada",
};

export default async function OrgTransferenciasEntrantesPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization } = await requireOrgAccessByToken(orgToken);

  // -------------------------------------------------------------------------
  // 1. Routine cross-org transfer proposals (custody_transfer_handshake)
  // -------------------------------------------------------------------------
  // Cases where receiverOrganizationId = this org (canonical, migration 0043),
  // with payload fallback for legacy rows.
  const handshakeRows = await db
    .select({
      caseId: cases.id,
      publicCode: cases.publicCode,
      caseKind: cases.caseKind,
      status: cases.status,
      closedReason: cases.closedReason,
      openedAt: cases.openedAt,
      closedAt: cases.closedAt,
      petName: pets.name,
      reason: sql<string | null>`(${petEvents.payload}->>'reason')`.as("reason"),
      notes: sql<string | null>`(${petEvents.payload}->>'notes')`.as("notes"),
      // The DESTINATION ROLE the proposal carries (closing report L1,
      // 2026-08-22). A cross-org transfer can be `owner`, which makes the
      // receiving organisation the pet's permanent legal owner — a first-class
      // product state (sanctuary, institutional adoption, seizure without
      // rehoming), not an anomaly. This inbox never read the field, so it showed
      // the same copy for a temporary hand-off and a permanent one.
      // Null defaults to shelter_custody, matching the accept path
      // (accept-cross-org-transfer.ts: `to_role ?? "shelter_custody"`).
      toRole: sql<string | null>`(${petEvents.payload}->>'to_role')`.as("to_role"),
      senderOrgName: organizations.displayName,
      senderOrgType: organizations.orgType,
      // seizure_motive not applicable for handshakes; NULL here.
      seizureMotive: sql<string | null>`NULL`.as("seizure_motive"),
    })
    .from(cases)
    .innerJoin(
      petEvents,
      and(eq(petEvents.caseId, cases.id), eq(petEvents.eventType, "custody_transfer_proposed")),
    )
    // Art. 16: the inbox row (the org's own case) survives; an erased pet's
    // name nulls out to "(sin pet)". Filter in the join, same as salientes.
    .leftJoin(pets, and(eq(pets.id, cases.primaryPetId), isNull(pets.deletedAt)))
    .leftJoin(organizations, eq(organizations.id, cases.openedByOrganizationId))
    .where(
      and(
        eq(cases.caseKind, "custody_transfer_handshake"),
        or(
          eq(cases.receiverOrganizationId, organization.id),
          and(
            isNull(cases.receiverOrganizationId),
            sql`${petEvents.payload}->>'to_organization_id' = ${organization.id}`,
          ),
        ),
      ),
    )
    .orderBy(desc(cases.openedAt))
    .limit(201);

  // -------------------------------------------------------------------------
  // 2. Decomiso handoff proposals (custody_episode opened by sanitary_authority)
  // -------------------------------------------------------------------------
  // Discriminator: caseKind='custody_episode' + opener.orgType='sanitary_authority'.
  // The seizure_motive comes from the shelter_intake_recorded event payload.
  // We join on the intake event to pull the motive; custody_transfer_proposed
  // is also present but we don't need it for display (the case itself IS the
  // proposal — the custody_episode case represents the in-flight handoff).
  const decommissaRows = await db
    .select({
      caseId: cases.id,
      publicCode: cases.publicCode,
      caseKind: cases.caseKind,
      status: cases.status,
      closedReason: cases.closedReason,
      openedAt: cases.openedAt,
      closedAt: cases.closedAt,
      petName: pets.name,
      reason: sql<string | null>`NULL`.as("reason"),
      notes: sql<string | null>`NULL`.as("notes"),
      // A decomiso handoff is state custody by definition — it never carries a
      // destination role, and its rows render DecomisoHandoffActions, not the
      // handshake actions. NULL keeps the two selects union-compatible.
      toRole: sql<string | null>`NULL`.as("to_role"),
      senderOrgName: organizations.displayName,
      senderOrgType: organizations.orgType,
      seizureMotive: sql<string | null>`(${petEvents.payload}->>'seizure_motive')`.as(
        "seizure_motive",
      ),
    })
    .from(cases)
    .innerJoin(
      organizations,
      and(
        eq(organizations.id, cases.openedByOrganizationId),
        eq(organizations.orgType, "sanitary_authority"),
      ),
    )
    .innerJoin(
      petEvents,
      and(eq(petEvents.caseId, cases.id), eq(petEvents.eventType, "shelter_intake_recorded")),
    )
    // Art. 16: same join-level filter as the handshake query above.
    .leftJoin(pets, and(eq(pets.id, cases.primaryPetId), isNull(pets.deletedAt)))
    .where(
      and(eq(cases.caseKind, "custody_episode"), eq(cases.receiverOrganizationId, organization.id)),
    )
    .orderBy(desc(cases.openedAt))
    .limit(201);

  // Merge and sort by openedAt desc.
  //
  // #815 audit finding #7: previously both queries used a bare limit(200)
  // with no truncation signal — a network with >200 historical transfers
  // silently lost visibility into the oldest ones. Each query now fetches
  // one extra row (limit 201, same pattern as adopciones/page.tsx) so the
  // merged+sorted list can detect truncation before capping at 200.
  const mergedRows = [...handshakeRows, ...decommissaRows].sort(
    (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime(),
  );
  const { rows: allRows, truncated } = capRows(mergedRows, 200);

  return (
    <div className="space-y-6">
      <OpCrumbs
        items={[
          { label: "Panel", href: `/org/${orgToken}` },
          { label: "Transferencias", href: `/org/${orgToken}/transferencias` },
          { label: "Entrantes" },
        ]}
      />

      <header className="space-y-1">
        <h1 className="text-title font-semibold text-ln-op-ink">Transferencias entrantes</h1>
        <p className="text-md text-ln-op-mute">
          Propuestas dirigidas a {organization.displayName}.
        </p>
      </header>

      <nav className="flex gap-4 text-sm">
        <Link
          href={`/org/${orgToken}/transferencias`}
          className="text-ln-op-azul hover:underline no-underline"
        >
          ← Salientes
        </Link>
        <span className="font-semibold text-ln-op-ink">Entrantes</span>
      </nav>

      {allRows.length === 0 ? (
        <LnEmptyState
          icon="transferencia"
          title="No tenés propuestas de transferencia entrantes."
        />
      ) : (
        <>
          <OpCard>
            <OpCardBody className="p-0">
              <ul className="divide-y divide-ln-op-line">
                {allRows.map((r) => {
                  const isDecomiso =
                    r.caseKind === "custody_episode" && r.senderOrgType === "sanitary_authority";

                  const statusLabel =
                    r.status === "closed" && r.closedReason
                      ? (CLOSED_REASON_LABEL[r.closedReason] ?? STATUS_LABEL[r.status])
                      : (STATUS_LABEL[r.status] ?? r.status);

                  return (
                    <li key={r.caseId} className="px-4 py-3 space-y-2">
                      {isDecomiso && (
                        <OpBreach
                          title="DECOMISO — Custodia estatal · Ley 14.346"
                          detail={
                            r.status === "open"
                              ? "Tenés 7 días para aceptar o rechazar esta custodia estatal."
                              : undefined
                          }
                        />
                      )}

                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <p className="text-md font-medium text-ln-op-ink">
                            {r.petName ?? "(sin pet)"}
                          </p>
                          <p className="text-sm text-ln-op-mute">
                            {isDecomiso ? (
                              <>
                                Autoridad sanitaria: <strong>{r.senderOrgName ?? "—"}</strong>
                                {r.seizureMotive
                                  ? ` · Motivo: ${SEIZURE_MOTIVE_LABEL[r.seizureMotive] ?? r.seizureMotive}`
                                  : ""}
                              </>
                            ) : (
                              <>
                                De <strong>{r.senderOrgName ?? "—"}</strong>
                                {r.reason ? ` · ${REASON_LABEL[r.reason] ?? r.reason}` : ""}
                                {" · "}
                                {/* WHAT is being handed over, on the row itself — a
                                    reader should not have to open the confirmation
                                    dialog to learn that this one is permanent. Same
                                    two words the sender's form and the incoming
                                    notification use. */}
                                <strong>
                                  {r.toRole === "owner" ? "Dueño permanente" : "Custodia temporal"}
                                </strong>
                              </>
                            )}
                          </p>
                          <p className="text-sm text-ln-op-mute">
                            Recibida el {formatDate(r.openedAt)}
                            {r.closedAt ? ` · Resuelta el ${formatDate(r.closedAt)}` : ""}
                          </p>
                          {!isDecomiso && r.notes ? (
                            <p className="text-sm italic text-ln-op-ink-2">"{r.notes}"</p>
                          ) : null}
                          <Link
                            href={`/casos/${r.publicCode}`}
                            className="inline-block text-sm text-ln-op-azul hover:underline no-underline"
                          >
                            Ver caso →
                          </Link>
                        </div>
                        <OpPill
                          tone={r.status === "open" ? (isDecomiso ? "danger" : "open") : "neutral"}
                        >
                          {statusLabel}
                        </OpPill>
                      </div>

                      {/* Accept / reject actions — only for open handshake rows */}
                      {r.status === "open" && !isDecomiso && (
                        <IncomingTransferActions
                          receiverOrgToken={orgToken}
                          casePublicCode={r.publicCode}
                          petName={r.petName ?? "(sin pet)"}
                          permanentOwnership={r.toRole === "owner"}
                        />
                      )}

                      {/* Accept / reject custody — only for open decomiso rows */}
                      {r.status === "open" && isDecomiso && (
                        <DecomisoHandoffActions
                          receiverOrgToken={orgToken}
                          casePublicCode={r.publicCode}
                          petName={r.petName ?? "(sin pet)"}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </OpCardBody>
          </OpCard>
          {truncated && (
            <p className="text-sm text-ln-op-mute">
              <ResultCount
                shown={allRows.length}
                noun="transferencias"
                hint="Este listado todavía no tiene filtros."
                className="text-sm text-ln-op-mute"
              />
            </p>
          )}
        </>
      )}
    </div>
  );
}
