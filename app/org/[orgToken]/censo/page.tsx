// Org census page — shelter census & occupancy view (Wave 3 Item 16).
//
// Shows a breakdown of animals currently in shelter_custody per species,
// with optional occupancy % when capacity has been declared.
//
// Gated by intake.create capability (shelter-type orgs only, per spec D2 edge).

import Link from "next/link";

import { OpCard, OpCardBody, OpCardHead, OpCrumbs, OpKpi } from "@/components/ui/dashboard";
import { computeOccupancyBreakdown, fetchOrgCensus } from "@/lib/analytics/org-census";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { speciesLabelPlural } from "@/lib/utils/species";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

// Shelters and rescue networks are the only org types where occupancy is meaningful.
const SHELTER_TYPES = new Set(["shelter", "rescue_network"]);

export default async function OrgCensoPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);

  const granted = await getGrantedCapabilities(membership);
  const canIntake = granted.has("intake.create") || membership.role === "admin";

  // Non-shelter orgs or users without intake.create capability see a not-applicable notice.
  const isShelterOrg = SHELTER_TYPES.has(organization.orgType);
  if (!isShelterOrg || !canIntake) {
    // Reached only by URL now (the nav item is shelterOnly) — still needs an
    // H1 for a11y/scanability (cursor citizen UX V1, 2026-07-24).
    return (
      <div className="space-y-6">
        <OpCrumbs items={[{ label: "Panel", href: `/org/${orgToken}` }, { label: "Censo" }]} />
        <h1 className="text-title font-semibold text-ln-op-ink">Censo de animales</h1>
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-6 text-md text-ln-op-mute">
          El censo de ocupación solo está disponible para refugios y redes de rescate con acceso a
          ingresos.
        </div>
      </div>
    );
  }

  const capacity = {
    capacityDogs: organization.capacityDogs ?? null,
    capacityCats: organization.capacityCats ?? null,
    capacityOther: organization.capacityOther ?? null,
    capacityTotal: organization.capacityTotal ?? null,
  };

  const census = await fetchOrgCensus(organization.id);
  const breakdown = computeOccupancyBreakdown(census, capacity);

  // Tone based on occupancy state.
  function kpiTone(slot: { overCapacity: boolean; pct: number | null }) {
    if (slot.overCapacity) return "danger" as const;
    if (slot.pct !== null && slot.pct >= 90) return "warn" as const;
    return "neutral" as const;
  }

  function kpiValue(slot: { count: number; pct: number | null; capacity: number | null }) {
    if (slot.pct !== null) return `${slot.count} / ${slot.capacity} (${slot.pct}%)`;
    return String(slot.count);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <OpCrumbs items={[{ label: "Panel", href: `/org/${orgToken}` }, { label: "Censo" }]} />
        <h1 className="text-title font-semibold text-ln-op-ink">Censo de animales</h1>
        <p className="text-md text-ln-op-mute">
          Animales actualmente en custodia de{" "}
          <strong className="text-ln-op-ink-2">{organization.displayName}</strong>.
        </p>
      </div>

      {/* Over-capacity warning */}
      {breakdown.anyOverCapacity && (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-4 py-3 text-md text-ln-op-danger font-medium"
        >
          Sobre capacidad — la organización tiene más animales de los que declaró como capacidad
          máxima. Esto no bloquea nuevos ingresos, es solo informativo.
        </div>
      )}

      {/* Census KPI grid */}
      <section aria-label="Ocupación por especie" className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <OpKpi
          label={speciesLabelPlural("dog")}
          value={kpiValue(breakdown.dogs)}
          tone={kpiTone(breakdown.dogs)}
          href={`/org/${orgToken}/mascotas?species=dog`}
          info={{
            definition: "Perros actualmente en custodia de la organización.",
            formula:
              breakdown.dogs.capacity != null
                ? "en custodia / capacidad perros × 100"
                : "count(*) where species = 'dog'",
          }}
        />
        <OpKpi
          label={speciesLabelPlural("cat")}
          value={kpiValue(breakdown.cats)}
          tone={kpiTone(breakdown.cats)}
          href={`/org/${orgToken}/mascotas?species=cat`}
          info={{
            definition: "Gatos actualmente en custodia de la organización.",
            formula:
              breakdown.cats.capacity != null
                ? "en custodia / capacidad gatos × 100"
                : "count(*) where species = 'cat'",
          }}
        />
        <OpKpi
          label={speciesLabelPlural("other")}
          value={kpiValue(breakdown.other)}
          tone={kpiTone(breakdown.other)}
          href={`/org/${orgToken}/mascotas?species=other`}
          info={{
            definition: "Animales de otras especies actualmente en custodia.",
            formula:
              breakdown.other.capacity != null
                ? "en custodia / capacidad otros × 100"
                : "count(*) where species not in ('dog','cat')",
          }}
        />
        <OpKpi
          label="Total"
          value={kpiValue(breakdown.total)}
          tone={kpiTone(breakdown.total)}
          href={`/org/${orgToken}/mascotas`}
          info={{
            definition: "Total de animales en custodia activa de la organización.",
            formula:
              breakdown.total.capacity != null
                ? "total en custodia / capacidad total × 100"
                : "count(*) animales en custodia",
            caveat: breakdown.noCapacityDeclared
              ? "Declarar la capacidad habilita el porcentaje de ocupación."
              : undefined,
          }}
        />
      </section>

      {/* No capacity declared — CTA */}
      {breakdown.noCapacityDeclared && (
        <OpCard>
          <OpCardBody>
            <p className="text-md text-ln-op-mute">
              No declaraste capacidad para esta organización. Declarar la capacidad te permite ver
              el porcentaje de ocupación y recibir alertas cuando estés llegando al límite.
            </p>
            <Link
              href={`/org/${orgToken}/configuracion`}
              className="mt-3 inline-block text-md font-medium text-ln-op-azul hover:underline no-underline"
            >
              Declarar capacidad →
            </Link>
          </OpCardBody>
        </OpCard>
      )}

      {/* Detail breakdown */}
      <OpCard>
        <OpCardHead title="Desglose por especie" />
        <OpCardBody className="p-0">
          <table className="w-full text-md">
            <caption className="sr-only">Desglose de animales en custodia por especie</caption>
            <thead>
              <tr className="border-b border-ln-op-line text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">
                <th scope="col" className="px-4 py-2 text-left">
                  Especie
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  En custodia
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  Capacidad
                </th>
                <th scope="col" className="px-4 py-2 text-right">
                  Ocupación
                </th>
                <th scope="col" className="px-4 py-2 text-right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-ln-op-line">
              {(
                [
                  { slot: breakdown.dogs, species: "dog" },
                  { slot: breakdown.cats, species: "cat" },
                  { slot: breakdown.other, species: "other" },
                ] as const
              ).map(({ slot, species }) => (
                <tr key={species}>
                  <td className="px-4 py-3 font-medium text-ln-op-ink">
                    {speciesLabelPlural(species)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{slot.count}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-ln-op-mute">
                    {slot.capacity ?? "—"}
                  </td>
                  <td
                    className={[
                      "px-4 py-3 text-right tabular-nums font-medium",
                      slot.overCapacity
                        ? "text-ln-op-danger"
                        : slot.pct !== null && slot.pct >= 90
                          ? "text-ln-op-warn"
                          : "text-ln-op-ink",
                    ].join(" ")}
                  >
                    {slot.pct !== null ? `${slot.pct}%` : "—"}
                    {slot.overCapacity && (
                      <span className="ml-1 text-xs font-bold">SOBRE CAP.</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/org/${orgToken}/mascotas?species=${species}`}
                      className="text-sm text-ln-op-azul hover:underline no-underline"
                    >
                      Ver listado →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </OpCardBody>
      </OpCard>
    </div>
  );
}
