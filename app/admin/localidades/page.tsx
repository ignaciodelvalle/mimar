// /admin/localidades — authority units by province (localidades-por-id C4).
//
// Who governs which localities: the provincial unit, the regions an admin
// created, and the municipal units the seed proposed from INDEC departments
// (drafts until confirmed with the authority). Each links to its editor.
//
// Authz: the /admin layout gates the segment (requireAdminOrRedirect); every
// write re-checks the platform-admin capability inside its transaction.

import Link from "next/link";

import {
  OpButton,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpPill,
  OpSelect,
} from "@/components/ui/dashboard";
import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { PROVINCES, provinceByCode } from "@/lib/reference/ar-provincias";
import { pluralizeEs } from "@/lib/utils/format";
import { listAuthorityUnits } from "@/src/modules/organizations/application/authority-units/read-units";

import { CreateUnitForm } from "./_components/UnitEditorForms";
import { unitKindLabel, unitLevelLabel } from "./_components/unit-labels";

export const dynamic = "force-dynamic";

const DEFAULT_PROVINCE = "AR-B";

export default async function AdminLocalidadesPage({
  searchParams,
}: {
  searchParams: Promise<{ provincia?: string }>;
}) {
  await requireAdminOrRedirect();
  const { provincia } = await searchParams;
  const province =
    provinceByCode(provincia ?? DEFAULT_PROVINCE) ?? provinceByCode(DEFAULT_PROVINCE);
  const provinceCode = province?.code ?? DEFAULT_PROVINCE;
  const units = await listAuthorityUnits(db, provinceCode);
  const drafts = units.filter((u) => u.status === "draft").length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="m-0 text-xl font-semibold text-ln-op-ink">Unidades de autoridad</h1>
        <p className="mt-1 text-sm text-ln-op-mute">
          Qué autoridad gobierna cada localidad. Las unidades municipales salen de los departamentos
          del INDEC como propuesta: confirmalas con cada autoridad antes de usarlas. Cada cambio
          queda registrado con quién lo hizo, cuándo y por qué.
        </p>
      </div>

      <form method="get" className="flex items-end gap-2">
        <div>
          <label
            htmlFor="admin-localidades-provincia"
            className="block text-xs font-medium text-ln-op-ink-2"
          >
            Provincia
          </label>
          <OpSelect
            id="admin-localidades-provincia"
            name="provincia"
            defaultValue={provinceCode}
            size="sm"
            block={false}
          >
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </OpSelect>
        </div>
        <OpButton type="submit" variant="ghost" size="sm">
          Ver
        </OpButton>
      </form>

      <OpCard>
        <OpCardHead
          title={`${province?.name ?? provinceCode}: ${units.length} ${pluralizeEs(units.length, "unidad")}, ${drafts} sin confirmar`}
        />
        <OpCardBody>
          {units.length === 0 ? (
            <p className="text-sm text-ln-op-mute">
              Esta provincia todavía no tiene unidades. Corré la siembra de unidades.
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
                        href={`/admin/localidades/${u.id}`}
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
          <CreateUnitForm provinceCode={provinceCode} />
        </OpCardBody>
      </OpCard>
    </div>
  );
}
