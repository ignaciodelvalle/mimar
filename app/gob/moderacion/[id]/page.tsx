// /gob/moderacion/[id] — jurisdiction-scoped denuncia moderation detail (SDD phase 1+2).
//
// Spec: dim-interno:docs/design/handoffs/2026-07-07-govt-jurisdiction-moderation-sdd.md
//
// Mirrors /admin/moderacion/[id] but jurisdiction-scoped: a govt may only open a
// flagged report whose (province, locality) is in their assignments. A report
// out of scope — or with no jurisdiction — returns notFound() for a govt (it
// stays admin-only). Admin has universal scope. Phase 2 adds the triage actions
// (approve / reject-as-abuse / escalate-to-admin) via GovtModerationActions.

import dynamic from "next/dynamic";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  OpBreach,
  OpCallout,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCrumbs,
  OpPill,
} from "@/components/ui/dashboard";
import { db, pets, welfareReportAttachments, welfareReports } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { readPoint } from "@/lib/domain/location";
import { requireDenunciaModerationPrincipal } from "@/lib/infra/auth-guards";
import { welfareAttachmentSignedUrl } from "@/lib/infra/storage";
import {
  isResolvableWelfareReportParam,
  welfareReportParamCondition,
} from "@/lib/infra/welfare-inspector-detail";
import { logWelfareLocationViewed } from "@/lib/infra/welfare-location-audit";
import { type FlagReason, reasonLabel } from "@/lib/infra/welfare-moderation";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import {
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";
import { eq } from "drizzle-orm";

import { GovtModerationActions } from "./GovtModerationActions";

// Govt moderation projection — same shape as the admin moderation detail
// (audience-precision plan: officials see the exact coordinate under Ley 14.346,
// logged for accountability). Drops reporter-contact / workflow fields not shown.
const GOVT_WELFARE_MODERATION_SELECT = {
  id: welfareReports.id,
  referenceCode: welfareReports.referenceCode,
  kind: welfareReports.kind,
  severity: welfareReports.severity,
  status: welfareReports.status,
  description: welfareReports.description,
  subjectKind: welfareReports.subjectKind,
  subjectPetId: welfareReports.subjectPetId,
  subjectDescription: welfareReports.subjectDescription,
  locationAddress: welfareReports.locationAddress,
  jurisdictionProvince: welfareReports.jurisdictionProvince,
  jurisdictionLocality: welfareReports.jurisdictionLocality,
  locationLat: welfareReports.locationLat,
  locationLng: welfareReports.locationLng,
  occurredAt: welfareReports.occurredAt,
  createdAt: welfareReports.createdAt,
  flaggedAt: welfareReports.flaggedAt,
  flagReasons: welfareReports.flagReasons,
  moderationResolvedAt: welfareReports.moderationResolvedAt,
  moderationEscalatedAt: welfareReports.moderationEscalatedAt,
} as const;

type SeverityTone = "danger" | "open" | "neutral";

const SEVERITY_PILL: Record<string, SeverityTone> = {
  critical: "danger",
  high: "open",
  medium: "open",
  low: "neutral",
};

const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="h-64 w-full animate-pulse rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe" />
  ),
});

export default async function GobModeracionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // `id` is the PUBLIC reference code (DEN-XXXX-XXXX) for new links; legacy uuid
  // links still resolve (welfareReportParamCondition accepts both). Resolving the
  // code to the row here — BEFORE the govt scope guard below — keeps authorization
  // byte-for-byte identical to the old uuid path.
  const { id } = await params;
  // Neither shape → 404, not a uuid-cast throw behind a 200 error boundary.
  if (!isResolvableWelfareReportParam(id)) notFound();
  const { user, profile, jurisdictions } = await requireDenunciaModerationPrincipal();

  const [report] = await db
    .select(GOVT_WELFARE_MODERATION_SELECT)
    .from(welfareReports)
    .where(welfareReportParamCondition(id))
    .limit(1);
  if (!report) notFound();
  if (!report.flaggedAt) notFound();

  // Jurisdiction scope guard (Wave A/F — never widen beyond assignments). A govt
  // may only open a report whose (province, locality) is in their assignments;
  // a report with no jurisdiction is never in scope → admin-only. Admin passes.
  if (profile.role === "govt") {
    // Subsumption-aware: a whole-province assignment (e.g. whole-CABA) governs
    // every barrio in it, so a report geocoded to a barrio is in scope. A raw
    // (province, locality) pair here would 404 a whole-province operator on a
    // barrio-tagged row (list-vs-detail divergence). See jurisdiction-canonical.
    const inScope = jurisdictionScopeContains(
      jurisdictions,
      report.jurisdictionProvince,
      report.jurisdictionLocality,
    );
    if (!inScope) notFound();
  }

  const locationPoint = readPoint(report);

  // Officials see the EXACT coordinate (Ley 14.346); log every such view for
  // accountability (Ley 25.326). Only when there's a point to view.
  if (locationPoint) {
    await logWelfareLocationViewed(user.id, report.id, report.referenceCode);
  }

  const reasons = (report.flagReasons as string[]) ?? [];

  // Resolve subjectPetId → publicToken for an operator-safe link to /p/{token}.
  let subjectPetPublicToken: string | null = null;
  if (report.subjectKind === "registered_pet" && report.subjectPetId) {
    const [petRow] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, report.subjectPetId))
      .limit(1);
    subjectPetPublicToken = petRow?.publicToken ?? null;
  }

  const attachmentRows = await db
    .select()
    .from(welfareReportAttachments)
    .where(eq(welfareReportAttachments.welfareReportId, report.id));
  const attachments = await Promise.all(
    attachmentRows.map(async (a) => ({
      ...a,
      signedUrl: await welfareAttachmentSignedUrl(a.storagePath),
    })),
  );

  const isResolved = report.moderationResolvedAt !== null;
  const isEscalated = report.moderationEscalatedAt !== null;
  const severityTone: SeverityTone = SEVERITY_PILL[report.severity] ?? "neutral";

  return (
    <div className="space-y-6">
      <OpCrumbs
        items={[
          // F1 fusion (2026-07-22) — Moderación is now a stage of the
          // Denuncias hub; the crumb links straight there instead of through
          // the old /gob/moderacion redirect.
          { label: "Moderación", href: "/gob/denuncias?etapa=moderacion" },
          { label: report.referenceCode ?? id, mono: true },
        ]}
      />

      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Moderación</p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-title font-semibold text-ln-op-ink">
            {welfareReportKindLabel(report.kind)}
          </h1>
          <OpPill tone={severityTone}>{welfareReportSeverityLabel(report.severity)}</OpPill>
        </div>
        <p className="font-ln-mono text-xs text-ln-op-faint">
          {report.referenceCode}
          {" · "}
          {[report.jurisdictionLocality, report.jurisdictionProvince].filter(Boolean).join(", ")}
          {" · creada "}
          {formatDateTime(report.createdAt)}
          {" · flagged "}
          {report.flaggedAt && formatDateTime(report.flaggedAt)}
        </p>
      </header>

      {/* Flag reasons */}
      <OpBreach
        title="Razones del flag"
        detail={
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {reasons.map((reason) => (
              <li key={reason}>{reasonLabel(reason as FlagReason)}</li>
            ))}
          </ul>
        }
      />

      {/* Description */}
      <OpCard>
        <OpCardHead title="¿Qué pasó?" />
        <OpCardBody>
          <p className="whitespace-pre-wrap text-md text-ln-op-ink">{report.description}</p>
          {report.occurredAt && (
            <p className="mt-2 text-sm text-ln-op-mute">
              {"Ocurrió el "}
              {formatDate(report.occurredAt)}
            </p>
          )}
        </OpCardBody>
      </OpCard>

      {/* Subject */}
      <OpCard>
        <OpCardHead title="Sujeto" />
        <OpCardBody>
          <p className="text-md text-ln-op-ink">
            {welfareReportSubjectKindLabel(report.subjectKind)}
            {report.subjectPetId && subjectPetPublicToken && (
              <Link
                href={`/p/${subjectPetPublicToken}`}
                className="ml-2 font-ln-mono text-sm text-ln-op-azul underline underline-offset-4 hover:opacity-80"
              >
                {subjectPetPublicToken}
              </Link>
            )}
          </p>
          {report.subjectDescription && (
            <p className="mt-1 whitespace-pre-wrap text-sm text-ln-op-ink-2">
              {report.subjectDescription}
            </p>
          )}
        </OpCardBody>
      </OpCard>

      {/* Location */}
      {(locationPoint || report.jurisdictionProvince || report.locationAddress) && (
        <OpCard>
          <OpCardHead title="Lugar" />
          <OpCardBody className="space-y-3">
            <div className="space-y-1 text-sm text-ln-op-ink-2">
              {report.locationAddress && <p>{report.locationAddress}</p>}
              {(report.jurisdictionLocality || report.jurisdictionProvince) && (
                <p>
                  {[report.jurisdictionLocality, report.jurisdictionProvince]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              )}
            </div>
            {locationPoint && (
              <>
                <p className="text-xs uppercase tracking-wider text-ln-op-mute">
                  Ubicación exacta — uso oficial (Ley 14.346)
                </p>
                <LocationMap lat={locationPoint.lat} lng={locationPoint.lng} />
              </>
            )}
          </OpCardBody>
        </OpCard>
      )}

      {/* Attachments */}
      {attachments.length > 0 && (
        <OpCard>
          <OpCardHead title={`Evidencia (${attachments.length})`} />
          <OpCardBody>
            <ul className="space-y-1.5">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3">
                  <span className="truncate font-ln-mono text-sm text-ln-op-mute">
                    {a.originalFilename ?? a.storagePath.split("/").pop()}
                  </span>
                  {a.signedUrl ? (
                    <a
                      href={a.signedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-semibold text-ln-op-azul underline underline-offset-4"
                    >
                      {"Abrir →"}
                    </a>
                  ) : (
                    <span className="text-sm text-ln-op-faint">(no disponible)</span>
                  )}
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      {/* Resolution */}
      {isResolved ? (
        <OpCallout
          title="Denuncia moderada"
          body={`Esta denuncia ya fue moderada el ${report.moderationResolvedAt && formatDateTime(report.moderationResolvedAt)}.`}
        />
      ) : isEscalated ? (
        <OpCallout
          title="Escalada a la administración"
          body={`Esta denuncia fue escalada al equipo de plataforma el ${report.moderationEscalatedAt && formatDateTime(report.moderationEscalatedAt)}. Ahora la modera la administración nacional.`}
        />
      ) : (
        <OpCard>
          <OpCardHead title="Resolución" />
          <OpCardBody>
            <GovtModerationActions welfareReportId={report.id} />
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}
