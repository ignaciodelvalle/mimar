// /gob/administracion/funcionarios — the municipal officials of the
// appointee's province (jurisdiction-admin Phase 6).
//
// Only the province's own localities are shown for each one. A funcionario the
// appointee may not act on (themself, another appointee, someone who also
// holds a grant in a second province) is listed with the reason and no link to
// act: those stay with the platform admin.

import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCard, OpCardBody, OpCrumbs, OpPill } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db } from "@/db";
import {
  type FuncionarioLock,
  listProvinceFuncionarios,
} from "@/src/modules/organizations/application/admin-authority/read-province-administration";

import {
  ADMINISTRACION_BASE,
  requireProvinceAdministrationOrRedirect,
} from "../_lib/province-administration";

export const dynamic = "force-dynamic";

const LOCK_LABELS: Record<Exclude<FuncionarioLock, null>, string> = {
  self: "Tu cuenta",
  appointee: "Administrador/a jurisdiccional",
  other_province: "También tiene localidades en otra provincia: la administra la plataforma",
};

function localitiesLabel(localities: string[], provinceName: string): string {
  return localities.map((l) => l || `toda ${provinceName}`).join(", ");
}

export default async function FuncionariosPage() {
  const { viewerId, provinceCode, provinceName } = await requireProvinceAdministrationOrRedirect();
  const funcionarios = await listProvinceFuncionarios(db, provinceCode, viewerId);

  return (
    <div className="max-w-3xl space-y-6">
      <OpCrumbs
        items={[{ label: "Administración", href: ADMINISTRACION_BASE }, { label: "Funcionarios" }]}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ScreenHeader
          title={`Funcionarios de ${provinceName}`}
          subtitle={
            <p className="text-md text-ln-op-ink-2">
              Cuentas de gobierno activas con localidades en {provinceName}: {funcionarios.length}.
            </p>
          }
        />
        <Link
          href={`${ADMINISTRACION_BASE}/funcionarios/nuevo`}
          className="shrink-0 rounded-[var(--radius-md)] bg-ln-op-azul px-3 py-1.5 text-md font-medium text-white no-underline transition-colors hover:bg-ln-op-azul-700"
        >
          {"+ Crear cuenta de gobierno"}
        </Link>
      </div>

      {funcionarios.length === 0 ? (
        <LnEmptyState
          title="Todavía no hay funcionarios en la provincia"
          description={`Creá la primera cuenta de gobierno de ${provinceName}.`}
        />
      ) : (
        <OpCard>
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line-2">
              {funcionarios.map((f) => (
                <li key={f.userId} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {f.lock === null ? (
                      <Link
                        href={`${ADMINISTRACION_BASE}/funcionarios/${f.userId}`}
                        className="text-md font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline"
                      >
                        {f.displayName}
                      </Link>
                    ) : (
                      <span className="text-md font-semibold text-ln-op-ink">{f.displayName}</span>
                    )}
                    {f.lock !== null && <OpPill tone="neutral">{LOCK_LABELS[f.lock]}</OpPill>}
                  </div>
                  <p className="text-sm text-ln-op-mute">
                    {localitiesLabel(f.localities, provinceName)}
                  </p>
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}
