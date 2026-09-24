// Admin approval queue + member × capability matrix.
// Lists pending capability requests, recent approvals, and a full matrix of
// who has what (implicit via role vs explicit grant). Layout gates on capability.grant.

import { OpCard, OpCardBody, OpCardHead, OpCodeBadge, OpPill } from "@/components/ui/dashboard";
import { db, organizationCapabilityGrants, organizationMemberships, profiles } from "@/db";
import { ORGANIZATION_CAPABILITIES } from "@/db/schema";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { formatDateTimeNumericAr } from "@/lib/utils/format";
import {
  CAPABILITY_CATALOG,
  resolveGrantedCaps,
} from "@/src/modules/organizations/domain/capabilities";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import Link from "next/link";
import type { MatrixColumn, MatrixMember } from "./CapabilityMatrix";
import { CapabilityMatrix } from "./CapabilityMatrix";
import { DecideForm } from "./DecideForm";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador/a",
  coordinator: "Coordinador/a",
  member: "Miembro",
  volunteer: "Voluntario/a",
  foster: "Tránsito",
  vet_individual: "Veterinario/a",
};

// Caps in ORGANIZATION_CAPABILITIES but absent from CAPABILITY_CATALOG get a fallback label.
const EXTRA_CAP_LABELS: Record<string, string> = {
  "org.transfer.propose": "Proponer transferencia",
  "org.transfer.accept": "Aceptar transferencia",
};

// Full ordered column list: catalog order first, then extras.
const CATALOG_MAP = new Map(CAPABILITY_CATALOG.map((e) => [e.capability as string, e.label]));
const MATRIX_COLUMNS: MatrixColumn[] = ORGANIZATION_CAPABILITIES.map((cap) => ({
  capability: cap,
  label: CATALOG_MAP.get(cap) ?? EXTRA_CAP_LABELS[cap] ?? cap,
}));

const LABEL_BY_CAPABILITY = new Map(
  CAPABILITY_CATALOG.map((entry) => [entry.capability as string, entry.label]),
);

function formatDate(d: Date | string): string {
  return formatDateTimeNumericAr(d);
}

export default async function PermisosPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership: callerMembership } = await requireOrgAccessByToken(orgToken);

  // --- Query 1: pending + approved grants for the requests queue ---
  const rows = await db
    .select({
      id: organizationCapabilityGrants.id,
      capability: organizationCapabilityGrants.capability,
      status: organizationCapabilityGrants.status,
      requestedAt: organizationCapabilityGrants.requestedAt,
      requestedReason: organizationCapabilityGrants.requestedReason,
      decidedAt: organizationCapabilityGrants.decidedAt,
      decisionReason: organizationCapabilityGrants.decisionReason,
      requesterUserId: organizationMemberships.userId,
      requesterRole: organizationMemberships.role,
      requesterDisplayName: profiles.displayName,
    })
    .from(organizationCapabilityGrants)
    .innerJoin(
      organizationMemberships,
      eq(organizationMemberships.id, organizationCapabilityGrants.membershipId),
    )
    .innerJoin(profiles, eq(profiles.id, organizationMemberships.userId))
    .where(
      and(
        eq(organizationCapabilityGrants.organizationId, organization.id),
        inArray(organizationCapabilityGrants.status, ["pending", "approved"]),
      ),
    )
    .orderBy(desc(organizationCapabilityGrants.requestedAt));

  // H2 (2026-08-22) — the caller's OWN pending requests leave the actionable
  // queue. The server refuses a self-decision now (domain/self-grant.ts), so
  // leaving them here would only offer a button that always fails.
  //
  // The comparison is on USER, not on membership id: one person can hold two
  // membership rows in the same org (leave and rejoin, or a second seat), and a
  // seat comparison would keep showing them a working-looking Approve button
  // over their own request from the other seat.
  //
  // They are shown, not hidden — a request that silently disappears from the
  // one screen that lists requests reads as "it was never filed". They render
  // read-only, below, saying who has to decide it.
  const allPending = rows.filter((r) => r.status === "pending");
  const pending = allPending.filter((r) => r.requesterUserId !== callerMembership.userId);
  const ownPending = allPending.filter((r) => r.requesterUserId === callerMembership.userId);
  const approved = rows.filter((r) => r.status === "approved");

  // --- Query 2 (matrix): active members + all approved grants for the org ---
  // Two flat queries; implicit caps resolved in memory — no per-member DB round trips.
  const [activeMembers, approvedGrants] = await Promise.all([
    db
      .select({
        membershipId: organizationMemberships.id,
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
        ),
      ),
    db
      .select({
        id: organizationCapabilityGrants.id,
        membershipId: organizationCapabilityGrants.membershipId,
        capability: organizationCapabilityGrants.capability,
      })
      .from(organizationCapabilityGrants)
      .where(
        and(
          eq(organizationCapabilityGrants.organizationId, organization.id),
          eq(organizationCapabilityGrants.status, "approved"),
        ),
      ),
  ]);

  // Build per-membership explicit grant index: membershipId → { capability → grantId }
  const grantsByMembership = new Map<string, Record<string, string>>();
  for (const g of approvedGrants) {
    let m = grantsByMembership.get(g.membershipId);
    if (!m) {
      m = {};
      grantsByMembership.set(g.membershipId, m);
    }
    m[g.capability] = g.id;
  }

  // Resolve implicit caps per member using pure domain function (no extra DB calls).
  const matrixMembers: MatrixMember[] = activeMembers.map((m) => {
    const explicitGrants = grantsByMembership.get(m.membershipId) ?? {};
    const resolvedSet = resolveGrantedCaps(m.role, Object.keys(explicitGrants));
    // Implicit = in resolvedSet but NOT an explicit grant row.
    const implicitCaps = new Set<string>();
    for (const cap of resolvedSet) {
      if (!explicitGrants[cap]) implicitCaps.add(cap);
    }
    return {
      membershipId: m.membershipId,
      displayName: m.displayName ?? m.userId,
      role: m.role,
      explicitGrants,
      implicitCaps,
    };
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        {/* No page-level OpCrumbs here — the topbar (OrgBreadcrumbs) already
            renders "Panel > Permisos" for this route (#815 audit finding #4:
            the two used to disagree, showing 3 conflicting labels at once). */}
        {/* Org-name eyebrow — standardized identity marker across the
            Administración section (audit #13: servicios/miembros/permisos now
            all mark tenancy the same way). */}
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {organization.displayName}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Solicitudes de permisos</h1>
        <p className="text-md text-ln-op-mute">
          Aprobá o denegá pedidos pendientes. También podés revocar un permiso ya concedido.
        </p>
      </div>

      {/* Pending */}
      <OpCard accent={pending.length > 0 ? "warn" : undefined}>
        <OpCardHead
          title={
            <>
              Pendientes{" "}
              <span className="text-sm text-ln-op-mute font-normal">({pending.length})</span>
            </>
          }
        />
        <OpCardBody className="p-0">
          {pending.length === 0 ? (
            <p className="px-4 py-4 text-md text-ln-op-mute">No hay solicitudes pendientes.</p>
          ) : (
            <ul className="divide-y divide-ln-op-line">
              {pending.map((row) => (
                <li key={row.id} className="px-4 py-3 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-md font-medium text-ln-op-ink">
                        {LABEL_BY_CAPABILITY.get(row.capability) ?? row.capability}{" "}
                        <OpCodeBadge tone="neutral">{row.capability}</OpCodeBadge>
                      </p>
                      <p className="text-sm text-ln-op-mute">
                        {row.requesterDisplayName} ·{" "}
                        {ROLE_LABELS[row.requesterRole] ?? row.requesterRole} ·{" "}
                        {formatDate(row.requestedAt)}
                      </p>
                      {row.requestedReason && (
                        <p className="text-sm italic text-ln-op-faint">"{row.requestedReason}"</p>
                      )}
                    </div>
                    <OpPill tone="open">Pendiente</OpPill>
                  </div>
                  <DecideForm
                    orgToken={orgToken}
                    grantId={row.id}
                    pending={true}
                    approved={false}
                  />
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>

      {/* Your own pending requests — visible, never actionable (H2). */}
      {ownPending.length > 0 && (
        <OpCard>
          <OpCardHead
            title={
              <>
                Tus solicitudes{" "}
                <span className="text-sm text-ln-op-mute font-normal">({ownPending.length})</span>
              </>
            }
          />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line">
              {ownPending.map((row) => (
                <li key={row.id} className="px-4 py-3 space-y-1">
                  <p className="text-md font-medium text-ln-op-ink">
                    {LABEL_BY_CAPABILITY.get(row.capability) ?? row.capability}{" "}
                    <OpCodeBadge tone="neutral">{row.capability}</OpCodeBadge>
                  </p>
                  <p className="text-sm text-ln-op-mute">
                    Pedida el {formatDate(row.requestedAt)}. La tiene que decidir otra persona de la
                    organización: no podés aprobarte permisos a vos mismo.
                  </p>
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {/* Approved / active grants */}
      <OpCard>
        <OpCardHead
          title={
            <>
              Concedidos activos{" "}
              <span className="text-sm text-ln-op-mute font-normal">({approved.length})</span>
            </>
          }
        />
        <OpCardBody className="p-0">
          {approved.length === 0 ? (
            <p className="px-4 py-4 text-md text-ln-op-mute">
              Ningún permiso concedido fuera del rol admin.
            </p>
          ) : (
            <ul className="divide-y divide-ln-op-line">
              {approved.map((row) => (
                <li key={row.id} className="px-4 py-3 space-y-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0 space-y-1">
                      <p className="text-md font-medium text-ln-op-ink">
                        {LABEL_BY_CAPABILITY.get(row.capability) ?? row.capability}{" "}
                        <OpCodeBadge tone="neutral">{row.capability}</OpCodeBadge>
                      </p>
                      <p className="text-sm text-ln-op-mute">
                        {row.requesterDisplayName} ·{" "}
                        {ROLE_LABELS[row.requesterRole] ?? row.requesterRole} · concedido{" "}
                        {row.decidedAt ? formatDate(row.decidedAt) : "—"}
                      </p>
                    </div>
                    <OpPill tone="ok">Concedido</OpPill>
                  </div>
                  <DecideForm
                    orgToken={orgToken}
                    grantId={row.id}
                    pending={false}
                    approved={true}
                  />
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>

      {/* Member × capability matrix */}
      <OpCard>
        <OpCardHead
          title="Matriz de permisos"
          actions={
            <span className="text-sm font-normal text-ln-op-mute">
              Solo lectura · los permisos explícitos son revocables
            </span>
          }
        />
        <OpCardBody>
          <CapabilityMatrix
            members={matrixMembers}
            columns={MATRIX_COLUMNS}
            organizationId={organization.id}
            orgToken={orgToken}
            callerMembershipId={callerMembership.id}
          />
        </OpCardBody>
      </OpCard>

      <footer className="pt-2">
        <Link href={`/org/${orgToken}`} className="text-md text-ln-op-azul hover:underline">
          ← Volver al panel
        </Link>
      </footer>
    </div>
  );
}
