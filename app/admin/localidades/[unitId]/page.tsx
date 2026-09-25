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
// Authz: the /admin layout gates the segment; every write re-checks the
// platform-admin capability inside its transaction.

import Link from "next/link";
import { notFound } from "next/navigation";

import { sql } from "drizzle-orm";

import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { requireUuidParam } from "@/lib/infra/route-params";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { formatDateShort, formatDateTimeNumericAr } from "@/lib/utils/format";
import { loadAuthorityUnitDetail } from "@/src/modules/organizations/application/authority-units/read-units";

import {
  ConfirmUnitButton,
  type LocalityOption,
  MoveLocalityForm,
  RemoveMemberForm,
  RenameUnitForm,
} from "../_components/UnitEditorForms";
import { unitKindLabel, unitLevelLabel } from "../_components/unit-labels";

export const dynamic = "force-dynamic";

const CHANGE_LABELS: Record<string, string> = {
  authority_unit_created: "Unidad creada",
  authority_unit_renamed: "Unidad renombrada",
  authority_unit_confirmed: "Unidad confirmada",
  authority_unit_membership_moved: "Localidad sumada",
  authority_unit_membership_removed: "Localidad quitada",
};

/** The province's live localities, labelled with the unit that holds them today. */
async function localityOptions(provinceCode: string, level: string, unitId: string) {
  const rows = (await db.execute(sql`
    select l.id::text as id, l.locality_name as name, l.department_name as department,
           u.name as current_unit
      from public.ar_localities l
      left join public.authority_unit_localities m
        on m.locality_id = l.id and m.valid_to is null and m.level = ${level}
      left join public.authority_units u on u.id = m.unit_id
     where l.province_code = ${provinceCode} and l.removed_at is null
       and m.unit_id is distinct from ${unitId}::uuid
     order by l.locality_name, l.department_name nulls first, l.id
  `)) as unknown as Array<{
    id: string;
    name: string;
    department: string | null;
    current_unit: string | null;
  }>;
  return rows.map<LocalityOption>((r) => ({
    id: r.id,
    label: `${r.name}${r.department ? ` (${r.department})` : ""} — ${
      r.current_unit ? `hoy en ${r.current_unit}` : "sin unidad"
    }`,
  }));
}

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
  const provincial = unit.level === "provincial";
  const options = provincial ? [] : await localityOptions(unit.provinceCode, unit.level, unit.id);
  const province = provinceByCode(unit.provinceCode);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <p className="text-sm text-ln-op-mute">
        <Link
          href={`/admin/localidades?provincia=${unit.provinceCode}`}
          className="underline underline-offset-4 hover:text-ln-op-ink-2"
        >
          Unidades de {province?.name ?? unit.provinceCode}
        </Link>
      </p>

      <OpCard>
        <OpCardHead
          title={unit.name}
          actions={
            unit.status === "confirmed" ? (
              <OpPill tone="ok">Confirmada</OpPill>
            ) : (
              <OpPill tone="open">Propuesta</OpPill>
            )
          }
        />
        <OpCardBody className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-ln-op-mute">Tipo</dt>
            <dd className="text-ln-op-ink">{unitKindLabel(unit.kind)}</dd>
            <dt className="text-ln-op-mute">Nivel</dt>
            <dd className="text-ln-op-ink">{unitLevelLabel(unit.level)}</dd>
            <dt className="text-ln-op-mute">Provincia</dt>
            <dd className="text-ln-op-ink">{province?.name ?? unit.provinceCode}</dd>
            {unit.confirmedAt && (
              <>
                <dt className="text-ln-op-mute">Confirmada</dt>
                <dd className="text-ln-op-ink">{formatDateShort(unit.confirmedAt)}</dd>
              </>
            )}
          </dl>
          {unit.status === "draft" && <ConfirmUnitButton unitId={unit.id} />}
          <RenameUnitForm unitId={unit.id} name={unit.name} />
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title={provincial ? "Localidades" : `Localidades (${unit.members.length})`} />
        <OpCardBody className="space-y-4">
          {provincial ? (
            <p className="text-sm text-ln-op-mute">
              La unidad provincial abarca toda la provincia, también los lugares que no se pudieron
              resolver a una localidad. No se le suman localidades una por una.
            </p>
          ) : unit.members.length === 0 ? (
            <p className="text-sm text-ln-op-mute">Esta unidad todavía no tiene localidades.</p>
          ) : (
            <ul className="divide-y divide-ln-op-line text-sm">
              {unit.members.map((m) => (
                <li key={m.localityId} className="flex items-start justify-between gap-3 py-1.5">
                  <span className="text-ln-op-ink">
                    {m.localityName}
                    {m.departmentName && (
                      <span className="text-ln-op-mute"> ({m.departmentName})</span>
                    )}
                    <span className="ml-2 text-xs text-ln-op-mute">
                      desde {formatDateShort(m.since)}
                    </span>
                  </span>
                  {unit.level !== "municipal" && (
                    <RemoveMemberForm
                      unitId={unit.id}
                      localityId={m.localityId}
                      localityName={m.localityName}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {!provincial && (
            <MoveLocalityForm
              unitId={unit.id}
              options={options}
              levelLabel={unitLevelLabel(unit.level)}
            />
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Historial de cambios" />
        <OpCardBody>
          {unit.changes.length === 0 ? (
            <p className="text-sm text-ln-op-mute">Sin cambios desde la siembra inicial.</p>
          ) : (
            <ul className="divide-y divide-ln-op-line text-sm">
              {unit.changes.map((c, i) => (
                <li key={`${c.performedAt.toISOString()}-${i}`} className="py-1.5">
                  <span className="text-ln-op-ink">
                    {c.action === "authority_unit_membership_moved" && c.after?.unit_id !== unit.id
                      ? "Localidad movida a otra unidad"
                      : (CHANGE_LABELS[c.action] ?? c.action)}
                    {c.localityName && `: ${c.localityName}`}
                  </span>
                  <span className="block text-xs text-ln-op-mute">
                    {formatDateTimeNumericAr(c.performedAt)} · {c.actorName ?? "Usuario eliminado"}
                    {c.reason && ` · ${c.reason}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>
    </div>
  );
}
