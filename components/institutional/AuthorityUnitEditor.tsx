// AuthorityUnitEditor — one authority unit: its localities, the grants that
// could pass onto it, its change log, and the edits (localidades-por-id C4).
//
// Presentational, shared by two containers (jurisdiction-admin Phase 6): the
// platform admin's /admin/localidades/[unitId] and a jurisdiction admin's
// /gob/administracion/unidades/[unitId]. The containers load the data and
// decide what is theirs alone: the platform admin passes its reversals through
// `statusExtra` / `children` (they are never imported here), and the
// jurisdiction admin's page hides the reasons of the change log
// (`showChangeReasons`), which are operator prose written by others.
//
// Every form posts to an action whose writer re-derives the unit's province
// and re-checks the actor inside its own transaction; `basePath` only decides
// where a success navigates.

import Link from "next/link";
import type { ReactNode } from "react";

import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import { formatDateShort, formatDateTimeNumericAr } from "@/lib/utils/format";
import type { GrantCandidate } from "@/src/modules/organizations/application/authority-units/grant-unit";
import type {
  AuthorityUnitDetail,
  LocalityMoveOption,
} from "@/src/modules/organizations/application/authority-units/read-units";

import { GrantUnitForm } from "./GrantUnitForm";
import {
  ConfirmUnitButton,
  MoveLocalityForm,
  RemoveMemberForm,
  RenameUnitForm,
} from "./UnitEditorForms";
import { unitChangeLabel, unitKindLabel, unitLevelLabel } from "./unit-labels";

export function AuthorityUnitEditor({
  unit,
  provinceName,
  options,
  candidates,
  basePath,
  back,
  showChangeReasons,
  statusExtra,
  children,
}: {
  unit: AuthorityUnitDetail;
  provinceName: string;
  options: LocalityMoveOption[];
  candidates: GrantCandidate[];
  /** The portal's unit list; forms navigate to `${basePath}/${unit.id}`. */
  basePath: string;
  back: { href: string; label: string };
  showChangeReasons: boolean;
  /** Rendered under the confirm/rename controls (the platform's reversal). */
  statusExtra?: ReactNode;
  /** Extra cards before the change log (the platform's grant reversals). */
  children?: ReactNode;
}) {
  const provincial = unit.level === "provincial";

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <p className="text-sm text-ln-op-mute">
        <Link href={back.href} className="underline underline-offset-4 hover:text-ln-op-ink-2">
          {back.label}
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
            <dd className="text-ln-op-ink">{provinceName}</dd>
            {unit.confirmedAt && (
              <>
                <dt className="text-ln-op-mute">Confirmada</dt>
                <dd className="text-ln-op-ink">{formatDateShort(unit.confirmedAt)}</dd>
              </>
            )}
          </dl>
          {unit.status === "draft" && <ConfirmUnitButton unitId={unit.id} basePath={basePath} />}
          {statusExtra}
          <RenameUnitForm unitId={unit.id} name={unit.name} basePath={basePath} />
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
                      basePath={basePath}
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
              basePath={basePath}
            />
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Concesiones de gobierno por pasar a la unidad" />
        <OpCardBody className="space-y-4">
          <p className="text-sm text-ln-op-mute">
            Una concesión pasa a la unidad cuando registra una de sus localidades (o, en la unidad
            provincial, toda la provincia). Desde ese momento cubre las localidades de la unidad por
            identificador, no por nombre.
          </p>
          {unit.status !== "confirmed" ? (
            // A draft is the seed's proposal and governs nothing (govt_scope,
            // 0260): no grant moves onto it until it is confirmed.
            <p className="text-sm text-ln-op-mute">
              Confirmá la unidad con la autoridad antes de pasarle concesiones. Mientras sea una
              propuesta no gobierna ninguna localidad.
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-ln-op-mute">No hay concesiones por pasar a esta unidad.</p>
          ) : (
            candidates.map((c) => (
              <GrantUnitForm
                key={c.userId}
                unitId={unit.id}
                userId={c.userId}
                displayName={c.displayName}
                grants={c.grants}
                added={c.added}
                basePath={basePath}
              />
            ))
          )}
        </OpCardBody>
      </OpCard>

      {children}

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
                    {unitChangeLabel(c.action, c.after?.unit_id, unit.id)}
                    {c.localityName && `: ${c.localityName}`}
                  </span>
                  <span className="block text-xs text-ln-op-mute">
                    {formatDateTimeNumericAr(c.performedAt)} · {c.actorName ?? "Usuario eliminado"}
                    {showChangeReasons && c.reason && ` · ${c.reason}`}
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
