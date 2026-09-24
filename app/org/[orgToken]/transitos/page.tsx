// Org transits hub — two tabs driven by ?tab= search param:
//   activos (default): live foster rows on pets this org holds now.
//   historial:         ended foster rows this org placed, newest ending first.
//
// Both come from `listOrgFosters`, which owns the binding to the viewing org
// (finding A10-1: historial used to list fosters of pets the org had handed
// to someone else). Do not add a query here that reads `ownerships` again.

import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { formatDate, formatDateShort, pluralizeEs, speciesLabel } from "@/lib/utils/format";
import {
  type OrgFosterKind as FosterKind,
  type OrgFosterTab as TabKey,
  listOrgFosters,
} from "@/src/modules/foster/infrastructure/org-foster-listing";

import { EndFosterButton } from "./EndFosterButton";

const KIND_PILL_TONE: Record<FosterKind, "ok" | "open" | "neutral"> = {
  pool: "ok",
  member: "open",
  vecino: "neutral",
};

const KIND_LABEL: Record<FosterKind, string> = {
  pool: "Voluntario pool",
  member: "Miembro",
  vecino: "Vecino-tránsito",
};

export default async function OrgTransitosPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgToken: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgToken } = await params;
  const { tab: tabParam } = await searchParams;
  const activeTab: TabKey = tabParam === "historial" ? "historial" : "activos";

  const { organization } = await requireOrgAccessByToken(orgToken);

  const fosters = await listOrgFosters(organization.id, activeTab);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-title font-semibold text-ln-op-ink">Tránsitos</h1>
        <p className="text-md text-ln-op-mute">
          Mascotas bajo cuidado de voluntarios, miembros o vecinos de la organización.
        </p>
      </header>

      {/* Tab bar */}
      <nav className="flex gap-1 border-b border-ln-op-line">
        {(["activos", "historial"] as const).map((tab) => {
          const isActive = activeTab === tab;
          const label = tab === "activos" ? "Activos" : "Historial";
          return (
            <Link
              key={tab}
              href={`/org/${orgToken}/transitos?tab=${tab}`}
              className={`px-4 py-2 text-md font-medium no-underline border-b-2 transition-colors ${
                isActive
                  ? "border-ln-op-azul text-ln-op-azul"
                  : "border-transparent text-ln-op-mute hover:text-ln-op-ink-2"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {activeTab === "activos" && fosters.length === 0 && (
        <p className="text-md text-ln-op-mute py-6 text-center">
          Ninguna mascota tiene tránsito activo.{" "}
          <Link
            href={`/org/${orgToken}/voluntarios`}
            className="text-ln-op-azul hover:underline no-underline"
          >
            Buscar voluntarios
          </Link>
        </p>
      )}

      {activeTab === "historial" && fosters.length === 0 && (
        <LnEmptyState icon="huella" title="Todavía no hay tránsitos finalizados." />
      )}

      {fosters.length > 0 && activeTab === "activos" && (
        <OpCard>
          <OpCardHead
            title="Tránsitos en curso"
            actions={`${fosters.length} ${pluralizeEs(fosters.length, "activo")}`}
          />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line">
              {fosters.map((ownership) => {
                const { pet } = ownership;
                const kind: FosterKind = ownership.kind ?? "vecino";
                return (
                  <li key={ownership.ownershipId} className="px-4 py-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <p className="text-md font-medium text-ln-op-ink">
                          {pet.name}{" "}
                          <span className="text-ln-op-mute font-normal">
                            → {ownership.fosterDisplayName}
                          </span>
                        </p>
                        <p className="text-sm text-ln-op-mute">
                          {speciesLabel(pet.species)} · iniciado{" "}
                          {formatDateShort(ownership.startedAt)}
                          {ownership.allowCoFoster && (
                            <span className="text-ln-op-ok"> · acepta co-foster</span>
                          )}
                        </p>
                        <OpPill tone={KIND_PILL_TONE[kind]}>{KIND_LABEL[kind]}</OpPill>
                      </div>
                      <EndFosterButton orgToken={orgToken} publicToken={pet.publicToken} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {fosters.length > 0 && activeTab === "historial" && (
        <OpCard>
          <OpCardHead
            title="Tránsitos finalizados"
            actions={`${fosters.length} ${pluralizeEs(fosters.length, "registro")}`}
          />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line">
              {fosters.map((ownership) => {
                const { pet } = ownership;
                return (
                  <li key={ownership.ownershipId} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <p className="text-md font-medium text-ln-op-ink">
                          {pet.name}{" "}
                          <span className="text-ln-op-mute font-normal">
                            → {ownership.fosterDisplayName}
                          </span>
                        </p>
                        <p className="text-sm text-ln-op-mute">
                          {speciesLabel(pet.species)} · {formatDate(ownership.startedAt)}
                          {ownership.endedAt ? ` – ${formatDate(ownership.endedAt)}` : ""}
                        </p>
                      </div>
                      <Link
                        href={`/org/${orgToken}/mascotas/${pet.publicToken}`}
                        className="shrink-0 rounded-[var(--radius-md)] border border-ln-op-line px-3 py-1.5 text-sm text-ln-op-ink hover:bg-ln-op-stripe transition-colors no-underline"
                      >
                        Ver ficha
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}
