// /gob/administracion/unidades — the authority units of the appointee's
// province (jurisdiction-admin Phase 6): the same list the platform admin
// reads in /admin/localidades, fixed to one province, with the same "new
// unit" form. createAuthorityUnit compares the submitted province against the
// actor's own inside its transaction; the fixed value here is only the form.

import Link from "next/link";

import { CreateUnitForm } from "@/components/institutional/UnitEditorForms";
import { unitKindLabel, unitLevelLabel } from "@/components/institutional/unit-labels";
import { OpCard, OpCardBody, OpCardHead, OpCrumbs, OpPill } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db } from "@/db";
import { pluralizeEs } from "@/lib/utils/format";
import { listAuthorityUnits } from "@/src/modules/organizations/application/authority-units/read-units";

import {
  ADMINISTRACION_BASE,
  requireProvinceAdministrationOrRedirect,
} from "../_lib/province-administration";

export const dynamic = "force-dynamic";

export default async function UnidadesPage() {
  const { provinceCode, provinceName } = await requireProvinceAdministrationOrRedirect();
  const units = await listAuthorityUnits(db, provinceCode);
  const drafts = units.filter((u) => u.status === "draft").length;
  const base = `${ADMINISTRACION_BASE}/unidades`;

  return (
    <div className="max-w-4xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Administración", href: ADMINISTRACION_BASE },
          { label: "Unidades de autoridad" },
        ]}
      />
      <ScreenHeader
        title={`Unidades de autoridad de ${provinceName}`}
        subtitle={
          <p className="text-md text-ln-op-ink-2">
            Qué autoridad gobierna cada localidad. Las unidades municipales salen de los
            departamentos del INDEC como propuesta: confirmalas con cada autoridad antes de usarlas.
            Cada cambio queda registrado con quién lo hizo, cuándo y por qué.
          </p>
        }
      />

      <OpCard>
        <OpCardHead
          title={`${units.length} ${pluralizeEs(units.length, "unidad")}, ${drafts} sin confirmar`}
        />
        <OpCardBody>
          {units.length === 0 ? (
            <p className="text-sm text-ln-op-mute">
              Esta provincia todavía no tiene unidades. Creá la primera abajo.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ln-op-mute">
                  <th className="py-1 pr-3 font-medium">Unidad</th>
                  <th className="py-1 pr-3 font-medium">Tipo</th>
                  <th className="py-1 pr-3 font-medium">Nivel</th>
                  <th className="py-1 pr-3 font-medium">Localidades</th>
                  <th className="py-1 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) => (
                  <tr key={u.id} className="border-t border-ln-op-line">
                    <td className="py-1.5 pr-3">
                      <Link
                        href={`${base}/${u.id}`}
                        className="text-ln-op-azul underline underline-offset-4"
                      >
                        {u.name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3 text-ln-op-ink-2">{unitKindLabel(u.kind)}</td>
                    <td className="py-1.5 pr-3 text-ln-op-ink-2">{unitLevelLabel(u.level)}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-ln-op-ink-2">
                      {u.members === null ? "Toda la provincia" : u.members}
                    </td>
                    <td className="py-1.5">
                      {u.status === "confirmed" ? (
                        <OpPill tone="ok">Confirmada</OpPill>
                      ) : (
                        <OpPill tone="open">Propuesta</OpPill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Nueva unidad" />
        <OpCardBody>
          <p className="mb-3 text-sm text-ln-op-mute">
            Para un municipio que el INDEC no separa, o una región que agrupa varios municipios (por
            ejemplo, una región sanitaria). Nace como propuesta y sin localidades.
          </p>
          <CreateUnitForm provinceCode={provinceCode} basePath={base} />
        </OpCardBody>
      </OpCard>
    </div>
  );
}
