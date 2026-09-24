import { requireUuidParam } from "@/lib/infra/route-params";
import Link from "next/link";
import { notFound } from "next/navigation";

import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";

import { ResetCredentialsButton } from "@/app/admin/_components/ResetCredentialsButton";
import { ResetMfaButton } from "@/app/admin/_components/ResetMfaButton";
import { DeactivateAdminActions } from "@/app/admin/admins/_components/DeactivateAdminForm";
import { OpCard, OpCardBody, OpCardHead, OpCodeBadge, OpPill } from "@/components/ui/dashboard";
import { auditLog, db, profiles } from "@/db";
import { accountTypeLabel } from "@/lib/domain/role-labels";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { describeAuditEntry } from "@/lib/ui/audit-entry-view";
import { formatDateShort, formatDateTimeNumericAr } from "@/lib/utils/format";

// Scaling note: auth.admin.getUserById() called once per page load.
// Safe at v1 institutional volume. See ADR-8.

export default async function AdminDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { user: actorUser } = await requireAdminOrRedirect();
  const { userId } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(userId);

  // Load target admin profile
  const [target] = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      accountType: profiles.accountType,
      role: profiles.role,
      deactivatedAt: profiles.deactivatedAt,
      createdAt: profiles.createdAt,
    })
    .from(profiles)
    .where(and(eq(profiles.id, userId), eq(profiles.role, "admin")))
    .limit(1);

  if (!target) notFound();

  // Load actor profile for capability check
  const [actorProfile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, actorUser.id))
    .limit(1);

  // Count active HUMAN admins for the last-admin guard (C21). System/service
  // accounts (profiles.is_system = true) are excluded so the UI floor matches
  // the server-side human-only floor in deactivateAdminForAuthority.
  const [{ activeCount }] = await db
    .select({ activeCount: count(profiles.id) })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "admin"),
        eq(profiles.accountType, "institutional"),
        isNull(profiles.deactivatedAt),
        eq(profiles.isSystem, false),
      ),
    );

  // Fetch email from auth.users via admin SDK
  const supabase = createAdminClient();
  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const email = authUser?.user?.email ?? "(email no disponible)";

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

  const isActive = target.deactivatedAt === null;
  const isSelf = actorUser.id === userId;

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <p className="text-sm text-ln-op-mute">
        {/* Straight to the hub tab (privileged-accounts fusion 2026-08-02) —
            /admin/admins is redirect-only now, no reason to pay the hop. */}
        <Link
          href="/admin/cuentas?registro=admins"
          className="underline underline-offset-4 hover:text-ln-op-ink-2"
        >
          {"←"} Volver a Administradores
        </Link>
      </p>

      {/* Identity card */}
      <OpCard>
        <OpCardHead
          title={
            <span className="flex items-center gap-2">
              {target.displayName}
              {isSelf && <OpPill tone="open">Vos</OpPill>}
            </span>
          }
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
            <dd className="text-ln-op-ink">{accountTypeLabel(target.accountType)}</dd>
            <dt className="text-ln-op-mute">Rol</dt>
            <dd className="text-ln-op-ink">Administrador</dd>
            <dt className="text-ln-op-mute">Creado</dt>
            <dd className="text-ln-op-ink">{formatDateShort(target.createdAt)}</dd>
            {!isActive && target.deactivatedAt && (
              <>
                <dt className="text-ln-op-mute">Desactivado</dt>
                <dd className="text-ln-op-danger">{formatDateShort(target.deactivatedAt)}</dd>
              </>
            )}
          </dl>
        </OpCardBody>
      </OpCard>

      {/* Account actions */}
      {isActive && actorProfile && (
        <section className="space-y-3">
          <h2 className="text-md font-semibold text-ln-op-ink">Acciones de cuenta</h2>
          <div className="flex items-start gap-3 flex-wrap">
            <DeactivateAdminActions
              target={{ id: target.id, displayName: target.displayName }}
              actor={{
                id: actorProfile.id,
                role: actorProfile.role as "owner" | "vet" | "govt" | "admin",
                accountType: actorProfile.accountType as "personal" | "institutional",
                deactivatedAt: actorProfile.deactivatedAt,
              }}
              activeAdminCount={Number(activeCount)}
            />
            {!isSelf && (
              <ResetCredentialsButton
                targetUserId={target.id}
                displayName={target.displayName}
                email={email}
                detailPath={`/admin/admins/${target.id}`}
              />
            )}
            {!isSelf && (
              <ResetMfaButton
                targetUserId={target.id}
                displayName={target.displayName}
                email={email}
                detailPath={`/admin/admins/${target.id}`}
              />
            )}
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
