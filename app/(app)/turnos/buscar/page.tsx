// /turnos/buscar — Libreta Nacional redesign.
// SearchFiltersForm (client component) unchanged.

import { db, organizations, ownerships, pets, profiles, serviceOfferings, timeSlots } from "@/db";
import { localitiesCoveringSearch } from "@/lib/domain/jurisdiction-canonical";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { slotRuleIsLive } from "@/lib/infra/slot-rule-liveness";
import { SERVICE_KINDS, findServiceKind } from "@/lib/reference/service-kinds";
import { pluralizeEs } from "@/lib/utils/format";
import { trimmedSearchParam } from "@/lib/utils/search-params";
import { type SQL, and, eq, inArray, isNull, sql } from "drizzle-orm";
import Link from "next/link";

import { SearchFiltersForm } from "./SearchFiltersForm";

export default async function BuscarTurnosPage({
  searchParams,
}: {
  searchParams: Promise<{
    service_kind?: string;
    province?: string;
    locality?: string;
    fecha_desde?: string;
    solo_gratis?: string;
  }>;
}) {
  const { user } = await requireUserOrRedirect();
  const params = await searchParams;

  // Q1: repeated params (?service_kind=a&service_kind=b) hand Next a
  // string[], not string — raw `.trim()` on that throws (500).
  // An unrecognized service_kind is treated as ABSENT, never echoed. The <h1>
  // below is the service's name, so an unvalidated param let whoever wrote the
  // URL choose this page's heading: QA 2026-08-08 (S3-F07) loaded
  // ?service_kind=spay_female_dog and got a 200 whose first line read
  // "spay_female_dog". React escapes the markup, so this is not injection —
  // it is the page asserting a service that does not exist.
  //
  // Falling through to the picker is what the app already does for a missing
  // param, and an unknown service is exactly that: no service chosen yet.
  const requestedKind = trimmedSearchParam(params.service_kind) ?? "";
  const serviceKind = findServiceKind(requestedKind) ? requestedKind : "";
  const fechaDesde = trimmedSearchParam(params.fecha_desde) ?? "";
  const soloGratis = params.solo_gratis === "true";

  let province = trimmedSearchParam(params.province) ?? "";
  let locality = trimmedSearchParam(params.locality) ?? "";

  if ((!province || !locality) && serviceKind) {
    const [firstPet] = await db
      .select({
        jurisdictionProvince: pets.jurisdictionProvince,
        jurisdictionLocality: pets.jurisdictionLocality,
      })
      .from(pets)
      .innerJoin(ownerships, eq(ownerships.petId, pets.id))
      // Art. 16 (Ley 25.326): an erased pet reads as never registered. This only
      // prefills the search jurisdiction, but a foster/co-owner row survives the
      // erasure, so without pets.deletedAt IS NULL an erased pet's location would
      // still seed a live third party's search — a per-pet read of a dead row.
      .where(
        sql`${ownerships.ownerUserId} = ${user.id} AND ${ownerships.endedAt} IS NULL AND ${pets.deletedAt} IS NULL`,
      )
      .orderBy(pets.createdAt)
      .limit(1);

    if (firstPet) {
      if (!province) province = firstPet.jurisdictionProvince ?? "";
      if (!locality) locality = firstPet.jurisdictionLocality ?? "";
    }
  }

  if (!serviceKind) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
        <div className="mb-6">
          <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Buscar turno
          </h1>
          <p className="mt-[5px] text-md text-[var(--color-ln-mute)]">
            Indicá qué servicio buscás.
          </p>
        </div>
        <ServiceKindSelector />
        <div className="mt-8">
          <Link
            href="/mis-mascotas"
            className="font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            ← Mis mascotas
          </Link>
        </div>
      </div>
    );
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const slotWindowStart =
    fechaDesde && /^\d{4}-\d{2}-\d{2}$/.test(fechaDesde)
      ? new Date(Math.max(now.getTime(), new Date(fechaDesde).getTime()))
      : now;

  const offeringConditions: SQL[] = [
    eq(serviceOfferings.serviceKind, serviceKind),
    eq(serviceOfferings.status, "approved"),
  ];

  if (province) offeringConditions.push(eq(serviceOfferings.jurisdictionProvince, province));
  // Locality is subsumption-aware, NOT plain equality. An offering tagged to the
  // whole province (CABA's INDEC "Ciudad Autónoma de Buenos Aires", or the ""
  // sentinel elsewhere) MUST be reachable from a barrio search — otherwise the
  // campaign that covers all of CABA is invisible to every citizen in it, which
  // is exactly what staging was doing on 2026-08-13. Same subsumption
  // narrowGovtScope applies to govt scope, read in the other direction.
  if (locality) {
    offeringConditions.push(
      inArray(serviceOfferings.jurisdictionLocality, localitiesCoveringSearch(province, locality)),
    );
  }
  if (soloGratis) offeringConditions.push(isNull(serviceOfferings.priceArs));

  const offeringRows = await db
    .select({
      offering: serviceOfferings,
      org: {
        displayName: organizations.displayName,
        avatarUrl: organizations.avatarUrl,
        tier0ShowBranding: organizations.tier0ShowBranding,
        verified: organizations.verified,
      },
      provider: {
        displayName: profiles.displayName,
        matriculaNumber: profiles.matriculaNumber,
      },
    })
    .from(serviceOfferings)
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(and(...offeringConditions));

  const offeringIds = offeringRows.map((r) => r.offering.id);
  type TimeSlotRow = typeof timeSlots.$inferSelect;
  const slotsByOffering = new Map<string, TimeSlotRow[]>();

  if (offeringIds.length > 0) {
    const slotsRaw = await db
      .select()
      .from(timeSlots)
      .where(
        sql`${timeSlots.serviceOfferingId} = ANY(${sql.raw(`ARRAY[${offeringIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
            AND ${timeSlots.status} = 'open'
            AND ${slotRuleIsLive()}
            AND ${timeSlots.startsAt} >= ${slotWindowStart.toISOString()}
            AND ${timeSlots.startsAt} <= ${windowEnd.toISOString()}
            AND ${timeSlots.bookingsCount} < ${timeSlots.capacity}`,
      )
      .orderBy(timeSlots.startsAt);

    for (const slot of slotsRaw) {
      const list = slotsByOffering.get(slot.serviceOfferingId) ?? [];
      list.push(slot);
      slotsByOffering.set(slot.serviceOfferingId, list);
    }
  }

  const offeringsWithSlots = offeringRows.filter(
    (r) => (slotsByOffering.get(r.offering.id)?.length ?? 0) > 0,
  );

  // Non-null by construction: serviceKind was validated above, and an empty
  // one already returned the picker. No `?? serviceKind` fallback here — that
  // is the very shape that printed the raw param as a heading.
  const kindDef = findServiceKind(serviceKind);
  const locationLabel = locality ? locality : province ? province : null;

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Header */}
      <div className="mb-5">
        <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
          {kindDef?.label}
        </h1>
        {locationLabel && (
          <p className="mt-1 font-ln-mono text-sm text-[var(--color-ln-mute)]">{locationLabel}</p>
        )}
      </div>

      {/* Filters */}
      <div className="mb-6">
        <SearchFiltersForm
          currentServiceKind={serviceKind}
          currentProvince={province}
          currentLocality={locality}
          currentFechaDesde={fechaDesde}
          currentSoloGratis={soloGratis}
        />
      </div>

      {/* Results */}
      {offeringsWithSlots.length === 0 ? (
        <p className="py-6 text-md text-[var(--color-ln-mute)]">
          {locationLabel
            ? `Sin servicios disponibles en ${locationLabel}. Probá otra localidad.`
            : "No hay turnos disponibles para este servicio en los próximos 7 días."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
          {offeringsWithSlots.map(({ offering, org, provider }) => {
            const slots = slotsByOffering.get(offering.id) ?? [];
            const providerLabel =
              offering.organizationId && org
                ? org.displayName
                : provider
                  ? `Dr/a. ${provider.displayName.split(" ")[0]}${provider.matriculaNumber ? ` · Mat. ${provider.matriculaNumber}` : ""}`
                  : "Profesional independiente";

            return (
              <Link
                key={offering.id}
                href={`/turnos/buscar/${offering.publicToken}`}
                className="flex items-center justify-between gap-4 border-b border-[var(--color-ln-line-2)] px-4 py-3.5 no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-ln-serif text-base font-semibold text-[var(--color-ln-ink)]">
                    {offering.displayName}
                  </p>
                  <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
                    {providerLabel}
                    {offering.priceArs !== null
                      ? ` · $${Number(offering.priceArs).toLocaleString("es-AR")}`
                      : " · Gratuito"}
                    {` · ${offering.durationMinutes} min`}
                  </p>
                  <p className="mt-1 text-sm text-[var(--color-ln-ok)]">
                    {`${slots.length} ${pluralizeEs(slots.length, "turno")} ${pluralizeEs(
                      slots.length,
                      "disponible",
                    )} en 7 días`}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2.5">
                  {offering.organizationId &&
                    org?.avatarUrl &&
                    org.tier0ShowBranding &&
                    org.verified && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={org.avatarUrl}
                        alt={org.displayName}
                        className="h-[36px] w-[36px] rounded-full object-cover"
                      />
                    )}
                  <span aria-hidden="true" className="text-base text-[var(--color-ln-mute)]">
                    ›
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <div className="mt-8">
        <Link
          href="/mis-mascotas"
          className="font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Mis mascotas
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ServiceKindSelector() {
  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]">
      {SERVICE_KINDS.map((kind) => (
        <Link
          key={kind.code}
          href={`/turnos/buscar?service_kind=${kind.code}`}
          className="flex items-center justify-between border-b border-[var(--color-ln-line-2)] px-4 py-[13px] no-underline last:border-b-0 hover:bg-[var(--color-ln-stripe)] transition-colors"
        >
          <span className="text-md text-[var(--color-ln-ink)]">{kind.label}</span>
          <span aria-hidden="true" className="text-base text-[var(--color-ln-mute)]">
            ›
          </span>
        </Link>
      ))}
    </div>
  );
}
