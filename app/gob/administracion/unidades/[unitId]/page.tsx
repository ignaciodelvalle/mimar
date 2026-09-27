// /gob/administracion/unidades/[unitId] — one authority unit of the
// appointee's province (jurisdiction-admin Phase 6): the same editor the
// platform admin uses (components/institutional/AuthorityUnitEditor), without
// the platform's reversals and without the reasons of the change log.
//
// 404 for a unit of any other province — the same answer as an unknown id,
// so the page tells nothing about units outside the province. Every form
// posts to an action whose writer re-reads the unit's province inside its own
// transaction and refuses anything outside the actor's.

import { notFound } from "next/navigation";

import { AuthorityUnitEditor } from "@/components/institutional/AuthorityUnitEditor";
import { OpCrumbs } from "@/components/ui/dashboard";
import { db } from "@/db";
import { requireUuidParam } from "@/lib/infra/route-params";
import { listGrantCandidates } from "@/src/modules/organizations/application/authority-units/grant-unit";
import {
  listLocalityMoveOptions,
  loadAuthorityUnitDetail,
} from "@/src/modules/organizations/application/authority-units/read-units";

import {
  ADMINISTRACION_BASE,
  requireProvinceAdministrationOrRedirect,
} from "../../_lib/province-administration";

export const dynamic = "force-dynamic";

export default async function UnidadPage({ params }: { params: Promise<{ unitId: string }> }) {
  const { provinceCode, provinceName } = await requireProvinceAdministrationOrRedirect();
  const { unitId } = await params;
  requireUuidParam(unitId);

  const unit = await loadAuthorityUnitDetail(db, unitId);
  if (!unit || unit.provinceCode !== provinceCode) notFound();
  const options =
    unit.level === "provincial"
      ? []
      : await listLocalityMoveOptions(db, unit.provinceCode, unit.level, unit.id);
  const candidates = unit.status === "confirmed" ? await listGrantCandidates(db, unit.id) : [];
  const base = `${ADMINISTRACION_BASE}/unidades`;

  return (
    <div className="space-y-4">
      <OpCrumbs
        items={[
          { label: "Administración", href: ADMINISTRACION_BASE },
          { label: "Unidades de autoridad", href: base },
          { label: unit.name },
        ]}
      />
      <AuthorityUnitEditor
        unit={unit}
        provinceName={provinceName}
        options={options}
        candidates={candidates}
        basePath={base}
        back={{ href: base, label: `Unidades de ${provinceName}` }}
        showChangeReasons={false}
      />
    </div>
  );
}
