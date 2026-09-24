// /gob/servicios/[offeringToken] — detail + approve/reject for a pending service offering (Fase 9).
//
// Gate: actor must be admin OR a govt whose assigned localities include the offering's
// jurisdiction. Out-of-scope requests 404 to avoid information leakage.

import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OpCard, OpCardBody, OpCodeBadge, OpPill } from "@/components/ui/dashboard";
import { db, organizations, profiles, serviceOfferings } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { portalBase } from "@/lib/ui/portal-base";
import {
  formatDateTimeNumericAr,
  pluralizeEs,
  serviceOfferingStatusLabel,
  speciesLabelPlural,
} from "@/lib/utils/format";

import { OfferingReviewActions } from "./OfferingReviewActions";

// Label comes from serviceOfferingStatusLabel (lib/utils/format.ts), shared
// with ../ServiciosScreen.tsx so the same offering never reads two different
// words across the two screens (copy audit 2026-08-04).
const STATUS_LABELS: Record<string, string> = {
  pending_approval: serviceOfferingStatusLabel("pending_approval"),
  approved: serviceOfferingStatusLabel("approved"),
  rejected: serviceOfferingStatusLabel("rejected"),
};

type StatusTone = "open" | "ok" | "danger";
const STATUS_TONES: Record<string, StatusTone> = {
  pending_approval: "open",
  approved: "ok",
  rejected: "danger",
};

export default async function GobServicioDetailPage({
  params,
}: {
  params: Promise<{ offeringToken: string }>;
}) {
  const { offeringToken } = await params;
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const base = await portalBase();

  const [row] = await db
    .select({
      offering: serviceOfferings,
      org: {
        displayName: organizations.displayName,
        publicToken: organizations.publicToken,
        legalName: organizations.legalName,
      },
      provider: {
        displayName: profiles.displayName,
        matriculaNumber: profiles.matriculaNumber,
      },
    })
    .from(serviceOfferings)
    .leftJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .leftJoin(profiles, eq(profiles.id, serviceOfferings.providerUserId))
    .where(eq(serviceOfferings.publicToken, offeringToken))
    .limit(1);

  if (!row) notFound();

  const { offering, org, provider } = row;

  // Scope check: govt can only act on offerings in their localities.
  // Subsumption-aware so a whole-province operator (e.g. whole-CABA) covers an
  // offering tagged to a barrio in that province. See jurisdictionScopeContains.
  if (profile.role === "govt") {
    const covers = jurisdictionScopeContains(
      jurisdictions,
      offering.jurisdictionProvince,
      offering.jurisdictionLocality,
    );
    if (!covers) notFound();
  }

  const kindLabel = findServiceKind(offering.serviceKind)?.label ?? offering.serviceKind;
  const location = [offering.jurisdictionLocality, offering.jurisdictionProvince]
    .filter(Boolean)
    .join(", ");

  const providerLabel =
    offering.organizationId && org
      ? org.displayName
      : provider
        ? `Dr/a. ${provider.displayName}${provider.matriculaNumber ? ` · Mat. ${provider.matriculaNumber}` : ""}`
        : "Profesional independiente";

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href={`${base}/servicios`}
          className="text-md text-ln-op-azul underline underline-offset-4 hover:text-ln-op-ink no-underline"
        >
          {"←"} Volver a servicios pendientes
        </Link>
      </div>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <OpPill tone={STATUS_TONES[offering.status] ?? "neutral"}>
            {STATUS_LABELS[offering.status] ?? offering.status}
          </OpPill>
        </div>
        <h1 className="text-title font-semibold text-ln-op-ink">{offering.displayName}</h1>
        <p className="text-sm text-ln-op-mute">
          <OpCodeBadge tone="neutral">{offering.publicToken}</OpCodeBadge>
          {location ? ` · ${location}` : ""}
          {" · enviado "}
          {formatDateTimeNumericAr(offering.submittedAt)}
        </p>
      </header>

      <DetailSection title="Proveedor">
        <p className="text-md text-ln-op-ink">{providerLabel}</p>
        {offering.organizationId && org?.legalName && (
          <p className="text-sm text-ln-op-mute">{org.legalName}</p>
        )}
      </DetailSection>

      <DetailSection title="Servicio">
        <p className="text-md text-ln-op-ink">{kindLabel}</p>
        {offering.description && (
          <p className="text-sm text-ln-op-ink-2 mt-1">{offering.description}</p>
        )}
      </DetailSection>

      <DetailSection title="Detalles">
        <dl className="space-y-1">
          <div className="flex gap-3">
            {/* "Duración" — en esta misma pantalla "Capacidad", "Precio" y
                "Especies" están bien, y el formulario que da de alta el
                servicio escribe "Duración (minutos)". La versión sin tilde era
                local a este <dt>. */}
            <dt className="text-sm text-ln-op-mute w-32 shrink-0">Duración</dt>
            <dd className="text-md text-ln-op-ink">{offering.durationMinutes} min</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-sm text-ln-op-mute w-32 shrink-0">Capacidad</dt>
            <dd className="text-md text-ln-op-ink">
              {offering.slotCapacity} {pluralizeEs(offering.slotCapacity, "turno")} por slot
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-sm text-ln-op-mute w-32 shrink-0">Precio</dt>
            <dd className="text-md text-ln-op-ink">
              {offering.priceArs !== null
                ? `$${Number(offering.priceArs).toLocaleString("es-AR")}`
                : "Gratuito"}
            </dd>
          </div>
          {offering.eligibilitySpecies && offering.eligibilitySpecies.length > 0 && (
            <div className="flex gap-3">
              <dt className="text-sm text-ln-op-mute w-32 shrink-0">Especies</dt>
              <dd className="text-md text-ln-op-ink">
                {offering.eligibilitySpecies.map(speciesLabelPlural).join(", ")}
              </dd>
            </div>
          )}
          {(offering.eligibilityAgeMinMonths !== null ||
            offering.eligibilityAgeMaxMonths !== null) && (
            <div className="flex gap-3">
              <dt className="text-sm text-ln-op-mute w-32 shrink-0">Edad elegible</dt>
              <dd className="text-md text-ln-op-ink">
                {offering.eligibilityAgeMinMonths !== null
                  ? `desde ${offering.eligibilityAgeMinMonths} ${pluralizeEs(offering.eligibilityAgeMinMonths, "mes")}`
                  : ""}
                {offering.eligibilityAgeMinMonths !== null &&
                offering.eligibilityAgeMaxMonths !== null
                  ? " — "
                  : ""}
                {offering.eligibilityAgeMaxMonths !== null
                  ? `hasta ${offering.eligibilityAgeMaxMonths} ${pluralizeEs(offering.eligibilityAgeMaxMonths, "mes")}`
                  : ""}
              </dd>
            </div>
          )}
        </dl>
      </DetailSection>

      {offering.status === "pending_approval" ? (
        <DetailSection title="Decisión">
          <OfferingReviewActions publicToken={offering.publicToken} />
        </DetailSection>
      ) : (
        <DetailSection title="Decisión">
          <p className="text-md text-ln-op-ink">
            {STATUS_LABELS[offering.status] ?? offering.status}
            {offering.reviewedAt && ` el ${formatDateTimeNumericAr(offering.reviewedAt)}`}
          </p>
          {offering.rejectionReason && (
            <p className="text-sm text-ln-op-ink-2 mt-1">Motivo: {offering.rejectionReason}</p>
          )}
        </DetailSection>
      )}
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-[0.18em] text-ln-op-mute">{title}</h2>
      <OpCard>
        <OpCardBody className="space-y-1">{children}</OpCardBody>
      </OpCard>
    </section>
  );
}
