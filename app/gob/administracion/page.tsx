// /gob/administracion — a jurisdiction admin's home (jurisdiction-admin
// Phase 6): the funcionarios, authority units and rules of their ONE province,
// and where to read what happened there.
//
// Gate: requireProvinceAdministrationOrRedirect (a LIVE appointee; a plain
// govt or a revoked appointee go home, the platform admin goes to /admin).
// Nothing here writes; every form it leads to posts to an action whose writer
// re-checks the province inside its own transaction.

import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db } from "@/db";
import { pluralizeEs } from "@/lib/utils/format";
import { listProvinceFuncionarios } from "@/src/modules/organizations/application/admin-authority/read-province-administration";
import { listAuthorityUnits } from "@/src/modules/organizations/application/authority-units/read-units";

import {
  ADMINISTRACION_BASE,
  requireProvinceAdministrationOrRedirect,
} from "./_lib/province-administration";

export const dynamic = "force-dynamic";

const LINK_CLASS =
  "text-sm font-semibold text-ln-op-azul no-underline underline-offset-4 hover:underline";

export default async function AdministracionPage() {
  const { viewerId, provinceCode, provinceName } = await requireProvinceAdministrationOrRedirect();
  const [funcionarios, units] = await Promise.all([
    listProvinceFuncionarios(db, provinceCode, viewerId),
    listAuthorityUnits(db, provinceCode),
  ]);
  const drafts = units.filter((u) => u.status === "draft").length;

  return (
    <div className="max-w-3xl space-y-6">
      <ScreenHeader
        eyebrow="miMAR Gobierno · Administración"
        title={`Administración de ${provinceName}`}
        subtitle={
          <p className="text-md text-ln-op-ink-2">
            Te designaron administrador/a jurisdiccional. Solo podés actuar dentro de {provinceName}
            . Cada cambio queda registrado con quién lo hizo, cuándo y por qué, y el administrador
            de la plataforma puede revertirlo.
          </p>
        }
      />

      <OpCard>
        <OpCardHead
          title="Funcionarios"
          actions={
            <Link href={`${ADMINISTRACION_BASE}/funcionarios`} className={LINK_CLASS}>
              {"Ver funcionarios →"}
            </Link>
          }
        />
        <OpCardBody>
          <p className="text-sm text-ln-op-ink-2">
            {funcionarios.length} {pluralizeEs(funcionarios.length, "funcionario")} con localidades
            en {provinceName}. Podés dar de alta cuentas de gobierno, asignarles localidades y
            desactivarlas.
          </p>
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead
          title="Unidades de autoridad"
          actions={
            <Link href={`${ADMINISTRACION_BASE}/unidades`} className={LINK_CLASS}>
              {"Ver unidades →"}
            </Link>
          }
        />
        <OpCardBody>
          <p className="text-sm text-ln-op-ink-2">
            {units.length} {pluralizeEs(units.length, "unidad")}, {drafts} sin confirmar. Qué
            autoridad gobierna cada localidad de la provincia.
          </p>
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead
          title="Reglas"
          actions={
            <Link href="/gob/reglas" className={LINK_CLASS}>
              {"Ver reglas →"}
            </Link>
          }
        />
        <OpCardBody>
          <p className="text-sm text-ln-op-ink-2">
            Las reglas de {provinceName} y de sus localidades. Las reglas de todo el país las
            administra la plataforma.
          </p>
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead
          title="Historial"
          actions={
            <Link href="/gob/historial" className={LINK_CLASS}>
              {"Ver historial →"}
            </Link>
          }
        />
        <OpCardBody>
          <p className="text-sm text-ln-op-ink-2">Qué se hizo en {provinceName}, quién y cuándo.</p>
        </OpCardBody>
      </OpCard>
    </div>
  );
}
