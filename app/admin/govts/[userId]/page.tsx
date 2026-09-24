import { requireUuidParam } from "@/lib/infra/route-params";
import Link from "next/link";
import { notFound } from "next/navigation";

import { and, desc, eq, inArray, or } from "drizzle-orm";

import { ResetCredentialsButton } from "@/app/admin/_components/ResetCredentialsButton";
import { ResetMfaButton } from "@/app/admin/_components/ResetMfaButton";
import { AssignLocalityForm } from "@/app/admin/govts/_components/AssignLocalityForm";
import { DeactivateGovtActions } from "@/app/admin/govts/_components/DeactivateGovtForm";
import { RevokeLocalityRowActions } from "@/app/admin/govts/_components/RevokeLocalityRowActions";
import { Icon } from "@/components/Icon";
import {
  OpCallout,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCodeBadge,
  OpPill,
} from "@/components/ui/dashboard";
import { auditLog, db, govtAssignments, profiles } from "@/db";
import { isWholeProvinceAssignment } from "@/lib/domain/jurisdiction-canonical";
import { accountTypeLabel } from "@/lib/domain/role-labels";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { DEAD_GOVT_REMEDY } from "@/lib/infra/govt-roster";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeAuditEntry } from "@/lib/ui/audit-entry-view";
import { formatDateShort, formatDateTimeNumericAr } from "@/lib/utils/format";

// Scaling note: auth.admin.getUserById() called once per page load.
// Safe at v1 institutional volume. See ADR-8.
//
// Also the detail page of a NATIONAL observer (pilot T1-P9): the read-only,
// country-wide role holds no localities, so those sections do not render, but
// deactivation and credential reset do — through the same use cases a govt
// uses. Before this, a national had no page at all and could not be switched
// off from the admin UI.

export default async function GovtDetailPage({ params }: { params: Promise<{ userId: string }> }) {
  await requireAdminOrRedirect();
  const { userId } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(userId);

  // Load govt profile
  const [govt] = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      accountType: profiles.accountType,
      role: profiles.role,
      deactivatedAt: profiles.deactivatedAt,
      createdAt: profiles.createdAt,
    })
    .from(profiles)
    .where(
      and(eq(profiles.id, userId), or(eq(profiles.role, "govt"), eq(profiles.role, "national"))),
    )
    .limit(1);

  if (!govt) notFound();

  // Fetch email from auth.users via admin SDK
  const supabase = createAdminClient();
  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const email = authUser?.user?.email ?? "(email no disponible)";

  // Load active and revoked locality assignments
  const allAssignments = await db
    .select({
      id: govtAssignments.id,
      jurisdictionProvince: govtAssignments.jurisdictionProvince,
      jurisdictionLocality: govtAssignments.jurisdictionLocality,
      grantedAt: govtAssignments.grantedAt,
      revokedAt: govtAssignments.revokedAt,
      revocationReason: govtAssignments.revocationReason,
    })
    .from(govtAssignments)
    .where(eq(govtAssignments.userId, userId))
    .orderBy(desc(govtAssignments.grantedAt));

  const activeAssignments = allAssignments.filter((a) => a.revokedAt === null);
  const revokedAssignments = allAssignments.filter((a) => a.revokedAt !== null);

  // Load audit log tail (last 10 entries where this user is the target)
  const auditEntries = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      payload: auditLog.payload,
      performedAt: auditLog.performedAt,
    })
    .from(auditLog)
    .where(eq(auditLog.targetUserId, userId))
    .orderBy(desc(auditLog.performedAt))
    .limit(10);

  // Resolve actor display names in one batch query
  const auditActorIds = Array.from(
    new Set(auditEntries.map((e) => e.actorUserId).filter((id): id is string => id !== null)),
  );
  const auditActorNamesById = new Map<string, string>();
  if (auditActorIds.length > 0) {
    const rows = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, auditActorIds));
    for (const r of rows) auditActorNamesById.set(r.id, r.displayName);
  }

  const isActive = govt.deactivatedAt === null;
  const isNational = govt.role === "national";

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <p className="text-sm text-ln-op-mute">
        {/* Straight to the hub tab (privileged-accounts fusion 2026-08-02) —
            /admin/govts is redirect-only now, no reason to pay the hop. */}
        <Link
          href="/admin/cuentas?registro=govts"
          className="underline underline-offset-4 hover:text-ln-op-ink-2"
        >
          {"←"} Volver a Gobiernos
        </Link>
      </p>

      {/* Identity card */}
      <OpCard>
        <OpCardHead
          title={govt.displayName}
          actions={
            <OpPill tone={isActive ? "ok" : "neutral"}>
              {isActive ? "Activo" : "Desactivado"}
            </OpPill>
          }
        />
        <OpCardBody>
          <p className="text-sm text-ln-op-mute mb-3">{email}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-ln-op-mute">Tipo de cuenta</dt>
            <dd className="text-ln-op-ink">{accountTypeLabel(govt.accountType)}</dd>
            <dt className="text-ln-op-mute">Rol</dt>
            <dd className="text-ln-op-ink">
              {isNational ? "Observador nacional (solo lectura)" : "Gobierno"}
            </dd>
            <dt className="text-ln-op-mute">Creado</dt>
            <dd className="text-ln-op-ink">{formatDateShort(govt.createdAt)}</dd>
            {!isActive && govt.deactivatedAt && (
              <>
                <dt className="text-ln-op-mute">Desactivado</dt>
                <dd className="text-ln-op-danger">{formatDateShort(govt.deactivatedAt)}</dd>
              </>
            )}
          </dl>
        </OpCardBody>
      </OpCard>

      {/* Active localities — a national holds none by construction */}
      {!isNational && (
        <section className="space-y-3">
          <h2 className="text-md font-semibold text-ln-op-ink">
            Localidades activas ({activeAssignments.length})
          </h2>

          {activeAssignments.length === 0 ? (
            // V4: an active govt with zero localities cannot enter /gob. State the
            // consequence AND the remedy here — the assign form sits right below,
            // so this turns a dead end into a one-step operation.
            isActive ? (
              // `nature` is for data epistemics (measured zero vs no signal); this
              // is an operational blocker, so it takes the default jurisdiction-
              // warning treatment the callout already serves.
              <OpCallout
                title="Sin localidades — no puede operar"
                body={DEAD_GOVT_REMEDY}
                icon={<Icon name="alerta" decorative />}
              />
            ) : (
              <p className="text-sm text-ln-op-mute">Sin localidades activas.</p>
            )
          ) : (
            <ul className="space-y-2">
              {activeAssignments.map((a) => {
                const label = isWholeProvinceAssignment({
                  province: a.jurisdictionProvince,
                  locality: a.jurisdictionLocality,
                })
                  ? `Toda la provincia · ${a.jurisdictionProvince}`
                  : `${a.jurisdictionLocality}, ${a.jurisdictionProvince}`;
                return (
                  <li key={a.id}>
                    <OpCard>
                      <OpCardBody className="flex items-center justify-between gap-3">
                        <span className="text-md text-ln-op-ink">{label}</span>
                        {isActive && (
                          <RevokeLocalityRowActions assignmentId={a.id} localityLabel={label} />
                        )}
                      </OpCardBody>
                    </OpCard>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Assign locality — PR-C */}
          {isActive && (
            <div className="mt-2">
              <AssignLocalityForm targetUserId={userId} />
            </div>
          )}
        </section>
      )}

      {/* Revoked localities (collapsible) */}
      {revokedAssignments.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm text-ln-op-mute hover:text-ln-op-ink-2 select-none">
            Localidades revocadas ({revokedAssignments.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {revokedAssignments.map((a) => (
              <li key={a.id} className="text-sm text-ln-op-mute px-3 space-y-0.5">
                <span className="text-ln-op-ink-2">
                  {isWholeProvinceAssignment({
                    province: a.jurisdictionProvince,
                    locality: a.jurisdictionLocality,
                  })
                    ? `Toda la provincia · ${a.jurisdictionProvince}`
                    : `${a.jurisdictionLocality}, ${a.jurisdictionProvince}`}
                </span>
                {a.revokedAt && (
                  <span className="ml-2 text-ln-op-faint">
                    (revocada {formatDateShort(a.revokedAt)})
                  </span>
                )}
                {a.revocationReason && (
                  <p className="text-ln-op-mute">
                    <span className="text-ln-op-faint">Motivo:</span> {a.revocationReason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Account actions */}
      {isActive && (
        <section className="space-y-3">
          <h2 className="text-md font-semibold text-ln-op-ink">Acciones de cuenta</h2>
          <div className="flex items-start gap-3 flex-wrap">
            <DeactivateGovtActions
              target={{
                id: govt.id,
                displayName: govt.displayName,
                activeLocalityCount: activeAssignments.length,
                role: isNational ? "national" : "govt",
              }}
            />
            <ResetCredentialsButton
              targetUserId={govt.id}
              displayName={govt.displayName}
              email={email}
              detailPath={`/admin/govts/${govt.id}`}
            />
            <ResetMfaButton
              targetUserId={govt.id}
              displayName={govt.displayName}
              email={email}
              detailPath={`/admin/govts/${govt.id}`}
            />
          </div>
        </section>
      )}

      {/* Audit log tail */}
      <section className="space-y-3">
        <h2 className="text-md font-semibold text-ln-op-ink">
          Audit log (últimas {auditEntries.length} entradas)
        </h2>
        {auditEntries.length === 0 ? (
          <p className="text-sm text-ln-op-mute">Sin registros.</p>
        ) : (
          <ul className="divide-y divide-ln-op-line-2">
            {auditEntries.map((entry) => {
              const view = describeAuditEntry(entry.action, entry.payload);
              const actorName = entry.actorUserId
                ? (auditActorNamesById.get(entry.actorUserId) ?? "Desconocido")
                : "Sistema";
              return (
                <li key={entry.id} className="py-2 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-md font-medium text-ln-op-ink" title={entry.action}>
                      {view.label}
                    </span>
                    <OpCodeBadge tone="neutral">{entry.action}</OpCodeBadge>
                  </div>
                  <p className="text-sm text-ln-op-mute">
                    {actorName}
                    <span className="mx-1 text-ln-op-faint">·</span>
                    <span className="tabular-nums">
                      {formatDateTimeNumericAr(entry.performedAt)}
                    </span>
                  </p>
                  {view.reason && (
                    <p className="text-sm text-ln-op-ink-2">
                      <span className="text-ln-op-mute">Motivo:</span> {view.reason}
                    </p>
                  )}
                  {view.evidenceCount !== undefined && (
                    <p className="text-sm text-ln-op-mute">
                      {view.evidenceCount} archivo(s) de evidencia
                    </p>
                  )}
                  {view.resetMethod && (
                    <p className="text-sm text-ln-op-mute">Método: {view.resetMethod}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
