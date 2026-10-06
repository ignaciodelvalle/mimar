// One unresolved place with everything the admin needs to decide, right above
// the "Resolver el lugar" button (PO rule: a resolve button never sits next to
// a bare name). Server component: the only client islands are the static map
// and the form. Role and kind only — no creator name, no contact, no DNI.

import Link from "next/link";
import type { ReactNode } from "react";

import { StaticFirstMap } from "@/components/maps/StaticFirstMap";
import {
  type CandidateWithDistance,
  creatorLabel,
  formatDistanceKm,
  rankCandidates,
  subjectKindLabel,
} from "@/lib/place/queue-context";
import type { QueueItem } from "@/lib/place/unresolved-queue";
import { formatDateShort } from "@/lib/utils/format";

import { ResolvePlaceForm } from "./ResolvePlaceForm";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ln-op-mute">{label}</dt>
      <dd className="m-0 text-sm text-ln-op-ink">{children}</dd>
    </div>
  );
}

function CandidateList({ candidates }: { candidates: CandidateWithDistance[] }) {
  if (candidates.length === 0) return null;
  return (
    <ul className="m-0 list-none space-y-0.5 p-0 text-sm text-ln-op-ink-2">
      {candidates.map((c) => (
        <li key={c.localityId}>
          {c.name}
          {c.department ? ` (${c.department})` : " (sin departamento)"}
          {c.distanceKm !== null && (
            <span className="text-ln-op-mute"> · a {formatDistanceKm(c.distanceKm)} del punto</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PendingPlaceCard({
  item,
  provinceCode,
}: {
  item: QueueItem;
  provinceCode: string;
}) {
  const { context: ctx } = item;
  const pin = ctx.lat !== null && ctx.lng !== null ? { lat: ctx.lat, lng: ctx.lng } : null;
  const candidates = rankCandidates(item.candidates, pin);
  const kind = subjectKindLabel(item.subjectTable, ctx.kind);
  const href = ctx.caseCode
    ? `/admin/casos/${ctx.caseCode}`
    : ctx.welfareReportId
      ? `/admin/moderacion/${ctx.welfareReportId}`
      : null;

  return (
    <li className="space-y-3 py-4">
      <dl className="m-0 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Fact label="Lo que se escribió">
          «{item.enteredLocality}», {item.province}
        </Fact>
        <Fact label="Qué es">
          {kind}
          {ctx.code &&
            (href ? (
              <>
                {" "}
                <Link
                  href={href}
                  className="font-mono text-xs underline underline-offset-4 hover:text-ln-op-ink-2"
                >
                  {ctx.code}
                </Link>
              </>
            ) : (
              <span className="ml-1 font-mono text-xs">{ctx.code}</span>
            ))}
        </Fact>
        <Fact label="Creado">
          {formatDateShort(item.createdAt)} ·{" "}
          {creatorLabel({
            subjectTable: item.subjectTable,
            role: ctx.creatorRole,
            viaOrganization: ctx.creatorViaOrganization,
          })}
        </Fact>
        {ctx.address && <Fact label="Dirección declarada">{ctx.address}</Fact>}
        {ctx.petLocality && (
          <Fact label="Localidad de la mascota">
            {ctx.petLocality.name}
            {ctx.petLocality.department ? ` (${ctx.petLocality.department})` : ""}
          </Fact>
        )}
        {ctx.linkedPlace && <Fact label="Otro lugar en el mismo caso">{ctx.linkedPlace}</Fact>}
      </dl>

      {pin ? (
        <StaticFirstMap
          lat={pin.lat}
          lng={pin.lng}
          label={`Punto registrado de «${item.enteredLocality}»`}
          precision="exact"
          heightClassName="h-40"
        />
      ) : (
        <p className="m-0 text-sm text-ln-op-mute">
          Sin punto en el mapa: no se registraron coordenadas, así que las opciones no se pueden
          ordenar por distancia.
        </p>
      )}

      <div>
        <p className="m-0 mb-1 text-xs font-medium text-ln-op-mute">
          {pin ? "Localidades posibles, de la más cercana al punto" : "Localidades posibles"}
        </p>
        <CandidateList candidates={candidates} />
      </div>

      <ResolvePlaceForm
        subjectTable={item.subjectTable}
        subjectId={item.subjectId}
        provinceCode={provinceCode}
        candidates={candidates}
      />
    </li>
  );
}
