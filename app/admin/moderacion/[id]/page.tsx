import { requireUuidParam } from "@/lib/infra/route-params";
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

// Admin moderation projection — all PII fields included (admin role).
// Performance projection only: drops reporter contact fields, workflow/triage
// fields, derivation fields, and org-intervention fields not shown in this view.
const ADMIN_WELFARE_MODERATION_SELECT = {
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
} as const;
import { readPoint } from "@/lib/domain/location";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { welfareAttachmentSignedUrl } from "@/lib/infra/storage";
import { logWelfareLocationViewed } from "@/lib/infra/welfare-location-audit";
import { type FlagReason, reasonLabel } from "@/lib/infra/welfare-moderation";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import {
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";
import { eq } from "drizzle-orm";

import { ModerationActions } from "./ModerationActions";

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

export default async function ModeracionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(id);
  const { user } = await requireAdminOrRedirect();

  const [report] = await db
    .select(ADMIN_WELFARE_MODERATION_SELECT)
    .from(welfareReports)
    .where(eq(welfareReports.id, id))
    .limit(1);
  if (!report) notFound();
  if (!report.flaggedAt) notFound();

  const locationPoint = readPoint(report);

  // Audience-precision plan (2026-06-19): admin moderation sees the EXACT
  // coordinate (Ley 14.346); log every such view for accountability (Ley
  // 25.326). Only when there's a point to view. See the gob detail page for the
  // awaited/prefetch rationale.
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
  const severityTone: SeverityTone = SEVERITY_PILL[report.severity] ?? "neutral";

  return (
    <div className="space-y-6">
      <OpCrumbs
        items={[
          // Fix (adversarial-admin 2026-07-23, mirrors the gob twin): /admin/
          // moderacion is now a redirect into the Denuncias hub — the crumb
          // links straight there instead of through that redirect hop.
          { label: "Moderación", href: "/gob/denuncias?etapa=moderacion" },
          { label: report.referenceCode ?? "Sin código", mono: true },
        ]}
      />

      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {"Admin · Moderación"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-title font-semibold text-ln-op-ink">
            {welfareReportKindLabel(report.kind)}
          </h1>
          <OpPill tone={severityTone}>{welfareReportSeverityLabel(report.severity)}</OpPill>
        </div>
        <p className="font-ln-mono text-xs text-ln-op-faint">
          {report.referenceCode}
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
                    // Honest empty state (Cowork M3): the signed URL is null when
                    // the object isn't in the welfare-evidence bucket. Say so —
                    // "(no disponible)" left an operator unsure if it was a
                    // permission wall or a missing file.
                    <span className="shrink-0 text-right text-sm text-ln-op-faint">
                      No disponible — el archivo no se encontró en el almacenamiento
                    </span>
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
      ) : (
        <OpCard>
          <OpCardHead title="Resolución" />
          <OpCardBody>
            <ModerationActions welfareReportId={report.id} />
          </OpCardBody>
        </OpCard>
      )}
    </div>
  );
}
