// ServiciosScreen — govt-facing queue of service offerings within coverage (Fase 9).
//
// F3+F7 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/servicios (also /admin/servicios) page.tsx, relocated so the
// Directorio hub (app/gob/directorio/page.tsx, mirrored at
// app/admin/directorio/page.tsx) can render it as its "servicios" register
// under ?registro=servicios. /gob/servicios and /admin/servicios now only
// redirect here via their portal's hub (see app/gob/servicios/page.tsx,
// app/admin/servicios/page.tsx) — this is a RELOCATION, not a redesign: same
// searchParams contract, same auth guard, same query logic. portalBase()
// still resolves correctly from the actual request pathname
// (middleware-stamped x-portal-base), regardless of which hub route renders
// this screen.
//
// Shows service_offerings in localities the current govt user covers (via
// govt_assignments). Admins see all offerings for the selected status (no
// jurisdiction filter — universal scope).
//
// Status filter (honesty fix, 2026-07-19): the page used to hardcode
// status='pending_approval', so approved/rejected offerings were invisible to
// the operator with no way to review past decisions. A status filter (UrlTabs,
// mirroring /gob/perdidas' status tabs — the real default here is
// "pending_approval", not "show all", so it fits the tabs idiom rather than an
// OpFilterBar axis) now exposes all three review-workflow states, defaulting
// to pending_approval (previous hardcoded behavior unchanged unless the
// operator switches tabs).

import { type SQL, and, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { Suspense } from "react";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";
import { OpCard, OpCardBody, OpPill } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db, organizations, profiles, serviceOfferings } from "@/db";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { jurisdictionPairClause } from "@/lib/metrics/scope";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { portalBase } from "@/lib/ui/portal-base";
import { formatDateShort, pluralizeEs, serviceOfferingStatusLabel } from "@/lib/utils/format";

// Real offering-status enum (db/schema.ts `service_status_valid` CHECK) also
// includes 'paused' and 'archived' — not surfaced here per PO scope, since
// this screen is the review queue (pending → approved/rejected), not a full
// lifecycle browser.
type OfferingStatusFilter = "pending_approval" | "approved" | "rejected";
const VALID_OFFERING_STATUSES: OfferingStatusFilter[] = [
  "pending_approval",
  "approved",
  "rejected",
];

function parseOfferingStatus(raw: string | undefined): OfferingStatusFilter {
  if (!raw) return "pending_approval";
  return (VALID_OFFERING_STATUSES as string[]).includes(raw)
    ? (raw as OfferingStatusFilter)
    : "pending_approval";
}

const STATUS_TABS: UrlTabItem[] = [
  { value: "pending_approval", label: "Pendientes" },
  { value: "approved", label: "Aprobados" },
  { value: "rejected", label: "Rechazados" },
];

// Label comes from serviceOfferingStatusLabel (lib/utils/format.ts), shared
// with ./[offeringToken]/page.tsx so the same offering never reads two
// different words across the two screens (copy audit 2026-08-04). Tone stays
// page-local — same duplication pattern as the status/severity pill maps in
// /gob/moderacion and /admin/moderacion.
const STATUS_LABEL: Record<OfferingStatusFilter, string> = {
  pending_approval: serviceOfferingStatusLabel("pending_approval"),
  approved: serviceOfferingStatusLabel("approved"),
  rejected: serviceOfferingStatusLabel("rejected"),
};
type StatusTone = "open" | "ok" | "danger";
const STATUS_TONE: Record<OfferingStatusFilter, StatusTone> = {
  pending_approval: "open",
  approved: "ok",
  rejected: "danger",
};
const STATUS_NOUN: Record<OfferingStatusFilter, string> = {
  pending_approval: "pendiente",
  approved: "aprobado",
  rejected: "rechazado",
};

export type ServiciosScreenProps = {
  searchParams: { status?: string };
  /**
   * True when rendered as the Directorio hub's "Servicios" tab
   * (app/gob/directorio/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function ServiciosScreen({
  searchParams: sp,
  underHub = false,
}: ServiciosScreenProps) {
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const base = await portalBase();

  // Govt with no assignments: nothing to review. Early-return keeps the query
  // out of the picture entirely (and avoids a sql`false` scan).
  if (profile.role !== "admin" && jurisdictions.length === 0) {
    return (
      <div className="space-y-4">
        <ScreenHeader underHub={underHub} eyebrow="miMAR Gobierno · Servicios" title="Servicios" />
        <LnEmptyState
          icon="usuarios"
          title="Sin localidades asignadas"
          description="No tenés localidades asignadas. Contactá a un administrador para recibir cobertura jurisdiccional."
        />
      </div>
    );
  }

  const statusFilter = parseOfferingStatus(sp.status);

  // Jurisdiction scope is enforced as a SQL predicate, NOT a JS post-filter —
  // a govt operator must never READ provider PII rows outside their coverage at
  // the DB level (AGENTS.md). Admin = universal (no scope clause); govt = OR of
  // (province,locality) pairs pushed into the WHERE.
  const baseCondition = eq(serviceOfferings.status, statusFilter);
  // synthetic: exempt — service_offerings carry no seed marker (T1-P1 report).
  const scopeFilter: SQL | undefined =
    profile.role === "admin"
      ? undefined
      : (jurisdictionPairClause(
          jurisdictions,
          sql`${serviceOfferings.jurisdictionProvince}`,
          sql`${serviceOfferings.jurisdictionLocality}`,
        ) ?? sql`false`);

  const whereClause = scopeFilter ? and(baseCondition, scopeFilter) : baseCondition;

  const offerings = await db
    .select({
      offering: serviceOfferings,
      org: { displayName: organizations.displayName, publicToken: organizations.publicToken },
      provider: { displayName: profiles.displayName, matriculaNumber: profiles.matriculaNumber },
    })
    .from(serviceOfferings)
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(whereClause)
    .orderBy(serviceOfferings.submittedAt);

  const subtitle =
    offerings.length === 0
      ? statusFilter === "pending_approval"
        ? "No hay servicios pendientes de revisión en tu cobertura."
        : `No hay servicios ${STATUS_NOUN[statusFilter]}s en tu cobertura.`
      : `${offerings.length} ${pluralizeEs(offerings.length, "servicio")} ${pluralizeEs(offerings.length, STATUS_NOUN[statusFilter])} en tu cobertura.`;

  return (
    <div className="space-y-6">
      <ScreenHeader
        underHub={underHub}
        eyebrow="miMAR Gobierno · Servicios"
        title="Servicios"
        subtitle={<p className="text-md text-ln-op-ink-2">{subtitle}</p>}
      />

      <Suspense>
        <UrlTabs
          paramKey="status"
          defaultValue="pending_approval"
          tabs={STATUS_TABS}
          aria-label="Filtrar por estado del servicio"
        >
          <UrlTabsContent value={statusFilter}>
            {offerings.length === 0 ? (
              <LnEmptyState
                title={
                  statusFilter === "pending_approval"
                    ? "No hay servicios pendientes de revisión"
                    : "Sin resultados"
                }
                description={
                  statusFilter === "pending_approval"
                    ? "Cuando lleguen nuevas solicitudes vas a verlas acá."
                    : `No hay servicios ${STATUS_NOUN[statusFilter]}s en tu cobertura.`
                }
              />
            ) : (
              <ul className="space-y-2 mt-4">
                {offerings.map(({ offering, org, provider }) => {
                  const providerLabel =
                    offering.organizationId && org
                      ? org.displayName
                      : provider
                        ? `Dr/a. ${provider.displayName}${provider.matriculaNumber ? ` · Mat. ${provider.matriculaNumber}` : ""}`
                        : "Profesional independiente";

                  const kindLabel =
                    findServiceKind(offering.serviceKind)?.label ?? offering.serviceKind;
                  const location = [offering.jurisdictionLocality, offering.jurisdictionProvince]
                    .filter(Boolean)
                    .join(", ");

                  return (
                    <li key={offering.id}>
                      <OpCard>
                        <OpCardBody>
                          <Link
                            href={`${base}/servicios/${offering.publicToken}`}
                            className="flex items-start justify-between gap-3 group no-underline"
                          >
                            <div className="min-w-0 space-y-0.5">
                              <p className="text-md font-medium text-ln-op-ink">
                                {offering.displayName}
                              </p>
                              <p className="text-sm text-ln-op-mute">
                                {providerLabel} · {kindLabel}
                                {location ? ` · ${location}` : ""}
                                {` · Capacidad: ${offering.slotCapacity}`}
                              </p>
                              <p className="text-xs text-ln-op-mute font-ln-mono">
                                {offering.publicToken} · {formatDateShort(offering.submittedAt)}
                              </p>
                            </div>
                            {/* All rows in this panel share statusFilter by construction
                                (the WHERE clause above narrows to exactly one status), so
                                the pill reads straight off the active tab. */}
                            <OpPill tone={STATUS_TONE[statusFilter]}>
                              {STATUS_LABEL[statusFilter]}
                            </OpPill>
                          </Link>
                        </OpCardBody>
                      </OpCard>
                    </li>
                  );
                })}
              </ul>
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
