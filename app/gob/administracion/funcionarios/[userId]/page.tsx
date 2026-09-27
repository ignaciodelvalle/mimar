// /gob/administracion/funcionarios/[userId] — one municipal official of the
// appointee's province (jurisdiction-admin Phase 6): their localities in the
// province, and the acts the appointee may perform on them — assign a
// locality, revoke one, deactivate the account.
//
// 404 for anyone who is not an active funcionario of this province — an
// unknown id, a deactivated account, one whose grants all lie elsewhere — so
// the page tells nothing about accounts outside it. The forms are offered only
// when the writers would accept the act (never on oneself, another appointee,
// or a funcionario with grants in a second province); the writers decide
// anyway, inside their own transaction.

import { notFound } from "next/navigation";

import { AssignLocalityForm } from "@/components/institutional/AssignLocalityForm";
import { DeactivateGovtActions } from "@/components/institutional/DeactivateGovtForm";
import { RevokeLocalityRowActions } from "@/components/institutional/RevokeLocalityRowActions";
import { OpCallout, OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db } from "@/db";
import { requireUuidParam } from "@/lib/infra/route-params";
import { formatDateShort } from "@/lib/utils/format";
import { loadProvinceFuncionario } from "@/src/modules/organizations/application/admin-authority/read-province-administration";

import {
  ADMINISTRACION_BASE,
  requireProvinceAdministrationOrRedirect,
} from "../../_lib/province-administration";

export const dynamic = "force-dynamic";

const LOCK_COPY = {
  self: "Es tu propia cuenta: tus localidades y tu baja las administra la plataforma.",
  appointee: "Es un administrador/a jurisdiccional: lo administra la plataforma.",
  other_province:
    "También tiene localidades en otra provincia: sus cambios los hace el administrador de la plataforma.",
} as const;

export default async function FuncionarioPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { viewerId, provinceCode, provinceName } = await requireProvinceAdministrationOrRedirect();
  const { userId } = await params;
  requireUuidParam(userId);

  const funcionario = await loadProvinceFuncionario(db, provinceCode, userId, viewerId);
  if (!funcionario) notFound();
  const canAct = funcionario.lock === null;

  return (
    <div className="max-w-3xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Administración", href: ADMINISTRACION_BASE },
          { label: "Funcionarios", href: `${ADMINISTRACION_BASE}/funcionarios` },
          { label: funcionario.displayName },
        ]}
      />
      <ScreenHeader title={funcionario.displayName} />

      {!canAct && funcionario.lock !== null && (
        <OpCallout title="Solo lectura" body={LOCK_COPY[funcionario.lock]} />
      )}

      <OpCard>
        <OpCardHead title={`Localidades en ${provinceName}`} />
        <OpCardBody className="space-y-4">
          <ul className="divide-y divide-ln-op-line text-sm">
            {funcionario.grants.map((g) => {
              const label = g.locality || `Toda ${provinceName}`;
              return (
                <li
                  key={g.assignmentId}
                  className="flex flex-wrap items-center justify-between gap-3 py-2"
                >
                  <span className="text-ln-op-ink">
                    {label}
                    <span className="ml-2 text-xs text-ln-op-mute">
                      desde {formatDateShort(g.grantedAt)}
                    </span>
                  </span>
                  {canAct && (
                    <RevokeLocalityRowActions assignmentId={g.assignmentId} localityLabel={label} />
                  )}
                </li>
              );
            })}
          </ul>
          {canAct && (
            <AssignLocalityForm
              targetUserId={funcionario.userId}
              scopeProvince={{ code: provinceCode, name: provinceName }}
            />
          )}
        </OpCardBody>
      </OpCard>

      {canAct && (
        <OpCard>
          <OpCardHead title="Desactivar la cuenta" />
          <OpCardBody className="space-y-3">
            <p className="text-sm text-ln-op-ink-2">
              La cuenta deja de poder entrar y se revocan todas sus localidades. Pide un motivo y un
              documento que lo respalde, y queda registrada con quién la hizo y cuándo.
            </p>
            <DeactivateGovtActions
              target={{
                id: funcionario.userId,
                displayName: funcionario.displayName,
                activeLocalityCount: funcionario.grants.length,
              }}
            />
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}
