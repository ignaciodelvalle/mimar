// /admin/localidades/[unitId] — one authority unit: its localities, its
// change log, and the edits (localidades-por-id C4, design addendum #2).
//
// Current membership decides which authority sees a locality's history, so
// every change here asks for a reason and lands in audit_log together with the
// membership rows (who and when). The change log below reads those rows back.
// A municipal membership only MOVES (to another unit, from that unit's page):
// every locality stays in exactly one municipal unit. A region's locality can
// be removed.
//
// The editor itself is shared with a jurisdiction admin's
// /gob/administracion/unidades/[unitId] (components/institutional,
// jurisdiction-admin Phase 6). What stays here is the platform admin's alone:
// the reversals (jurisdiction-admin 6.4) — "Volver a borrador" and taking a
// funcionario's grants off the unit — and the change log's reasons.
//
// Authz: the /admin layout gates the segment; every write re-checks the
// actor's authority inside its transaction.

import { notFound } from "next/navigation";

import { AuthorityUnitEditor } from "@/components/institutional/AuthorityUnitEditor";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { requireUuidParam } from "@/lib/infra/route-params";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { listGrantCandidates } from "@/src/modules/organizations/application/authority-units/grant-unit";
import {
  listGrantsOnUnit,
  listLocalityMoveOptions,
  loadAuthorityUnitDetail,
} from "@/src/modules/organizations/application/authority-units/read-units";

import { UnconfirmGrantForm, UnconfirmUnitForm } from "../_components/UnitReversalForms";

export const dynamic = "force-dynamic";

export default async function AuthorityUnitPage({
  params,
}: {
  params: Promise<{ unitId: string }>;
}) {
  await requireAdminOrRedirect();
  const { unitId } = await params;
  requireUuidParam(unitId);

  const unit = await loadAuthorityUnitDetail(db, unitId);
  if (!unit) notFound();
  const options =
    unit.level === "provincial"
      ? []
      : await listLocalityMoveOptions(db, unit.provinceCode, unit.level, unit.id);
  const provinceName = provinceByCode(unit.provinceCode)?.name ?? unit.provinceCode;
  const candidates = unit.status === "confirmed" ? await listGrantCandidates(db, unit.id) : [];
  // Grants already pinned to the unit: the platform admin's reversal list
  // (jurisdiction-admin 6.4), whatever the unit's status.
  const pinned = await listGrantsOnUnit(db, unit.id);

  return (
    <AuthorityUnitEditor
      unit={unit}
      provinceName={provinceName}
      options={options}
      candidates={candidates}
      basePath="/admin/localidades"
      back={{
        href: `/admin/localidades?provincia=${unit.provinceCode}`,
        label: `Unidades de ${provinceName}`,
      }}
      showChangeReasons
      statusExtra={
        unit.status === "confirmed" ? (
          <UnconfirmUnitForm unitId={unit.id} pinnedHolders={pinned.map((h) => h.displayName)} />
        ) : null
      }
    >
      <OpCard>
        <OpCardHead title="Concesiones pasadas a esta unidad" />
        <OpCardBody className="space-y-3">
          {pinned.length === 0 ? (
            <p className="text-sm text-ln-op-mute">Ninguna concesión está pasada a esta unidad.</p>
          ) : (
            <ul className="divide-y divide-ln-op-line text-sm">
              {pinned.map((h) => (
                <li key={h.userId} className="space-y-2 py-2">
                  <p className="m-0 text-ln-op-ink">
                    <strong>{h.displayName}</strong>
                    <span className="text-ln-op-mute">
                      {" · "}
                      {h.localities.map((l) => l || "toda la provincia").join(", ")}
                    </span>
                  </p>
                  <UnconfirmGrantForm
                    unitId={unit.id}
                    userId={h.userId}
                    displayName={h.displayName}
                  />
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>
    </AuthorityUnitEditor>
  );
}
