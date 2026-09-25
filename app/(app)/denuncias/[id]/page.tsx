// Welfare report detail — Libreta Nacional redesign.
// Presentation only; data fetching, actions, ReporterCommentForm, and LocationMap unchanged.

import { requireUuidParam } from "@/lib/infra/route-params";
import dynamic from "next/dynamic";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { readPoint } from "@/lib/domain/location";
import { welfareAttachmentSignedUrl } from "@/lib/infra/storage";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import { addReporterCommentAction } from "@/src/modules/welfare/actions";
import {
  welfareReportKindLabel,
  welfareReportReporterNotice,
  welfareReportSeverityCitizenLabel,
  welfareReportStatusLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";
import { getReporterWelfareReport } from "@/src/modules/welfare/infrastructure/reporter-reports-read";
import { type CommentFormState, ReporterCommentForm } from "./_components/ReporterCommentForm";

const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="w-full h-[240px] rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] animate-pulse" />
  ),
});

// LN status badge class mapping.
function statusBadgeClass(status: string): string {
  switch (status) {
    case "closed":
      return "border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]";
    case "invalid":
    case "duplicate":
      return "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]";
    case "in_progress":
      return "border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]";
    case "triaged":
      return "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]";
    default:
      return "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink-2)]";
  }
}

function severityBadgeClass(severity: string): string {
  switch (severity) {
    case "critical":
      return "border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-050)] text-[var(--color-ln-err)]";
    case "high":
    case "medium":
      return "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]";
    default:
      return "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]";
  }
}

export default async function WelfareReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(id);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/iniciar-sesion");

  // The same reader `GET /api/v1/me/welfare-reports/{code}` runs — scoped to
  // the verified reporter, subject pet filtered for erasure (art. 16), and only
  // the reporter's OWN comments from the case timeline.
  const detail = await getReporterWelfareReport({ reporterUserId: user.id, lookup: { id } });
  if (!detail) notFound();
  const { report, subjectPet, reporterComments, casePublicCode } = detail;

  const attachments = await Promise.all(
    detail.attachments.map(async (a) => ({
      ...a,
      signedUrl: await welfareAttachmentSignedUrl(a.storagePath),
    })),
  );

  const notice = welfareReportReporterNotice(report.status);
  const locationPoint = readPoint(report);
  const hasLocation =
    report.locationAddress ||
    report.jurisdictionProvince ||
    report.jurisdictionLocality ||
    locationPoint !== null;

  const hasContact = report.reporterContactEmail || report.reporterContactPhone;

  async function commentAction(
    _prev: CommentFormState,
    formData: FormData,
  ): Promise<CommentFormState> {
    "use server";
    const text = String(formData.get("text") ?? "").trim();
    const result = await addReporterCommentAction(id, text);
    if (!result.ok) return { error: result.error, success: false };
    return { error: null, success: true };
  }

  return (
    <div className="mx-auto max-w-2xl px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/denuncias/mias"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Mis denuncias
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <h1 className="m-0 font-ln-serif text-3xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
            {welfareReportKindLabel(report.kind)}
          </h1>
          <div className="flex flex-shrink-0 flex-wrap gap-1.5">
            <span
              className={`inline-flex items-center rounded-[var(--radius-xs)] border px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] ${statusBadgeClass(report.status)}`}
            >
              {welfareReportStatusLabel(report.status)}
            </span>
            <span
              className={`inline-flex items-center rounded-[var(--radius-xs)] border px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] ${severityBadgeClass(report.severity)}`}
            >
              {welfareReportSeverityCitizenLabel(report.severity)}
            </span>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1">
          <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
            Código <span className="text-[var(--color-ln-ink-2)]">{report.referenceCode}</span>
          </p>
          <a
            href={`/denuncias/codigo/${report.referenceCode}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-ln-mono text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Compartir link ↗
          </a>
        </div>
        <p className="mt-1 font-ln-mono text-sm text-[var(--color-ln-mute)]">
          Enviada {formatDateTime(report.createdAt)}
          {report.occurredAt && ` · Ocurrió el ${formatDate(report.occurredAt)}`}
        </p>
        {casePublicCode && (
          <Link
            href={`/casos/${casePublicCode}`}
            className="mt-1 inline-block font-ln-mono text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Ver caso {casePublicCode} →
          </Link>
        )}
      </div>

      {/* The author's status banner — `welfareReportReporterNotice` decides
          it (and the API serves the same one): "aún no se envió" only while
          the report is genuinely un-routed, a progress line while a
          funcionario works it, nothing once it is closed. */}
      {notice && (
        <div className="mb-6">
          <LnCallout tone={notice.tone === "warn" ? "warn" : "azul"}>{notice.text}</LnCallout>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {/* Description */}
        <LnCard>
          <LnCardHead title="¿Qué pasó?" />
          <LnCardBody>
            <p className="text-md text-[var(--color-ln-ink-2)] leading-relaxed whitespace-pre-wrap">
              {report.description}
            </p>
          </LnCardBody>
        </LnCard>

        {/* Subject */}
        <LnCard>
          <LnCardHead title="¿Sobre quién?" />
          <LnCardBody>
            <p className="text-md text-[var(--color-ln-ink-2)]">
              {welfareReportSubjectKindLabel(report.subjectKind)}
            </p>
            {report.subjectKind === "registered_pet" && subjectPet && (
              <Link
                href={`/mis-mascotas/${subjectPet.publicToken}`}
                className="mt-1.5 inline-flex items-center gap-1.5 text-md text-[var(--color-ln-azul)] no-underline hover:underline"
              >
                {subjectPet.name}
                <span className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
                  {subjectPet.publicToken}
                </span>
              </Link>
            )}
            {report.subjectDescription && (
              <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
                {report.subjectDescription}
              </p>
            )}
          </LnCardBody>
        </LnCard>

        {/* Location */}
        {hasLocation && (
          <LnCard>
            <LnCardHead title="Lugar" />
            <LnCardBody>
              <div className="flex flex-col gap-2">
                {report.locationAddress && (
                  <p className="text-md text-[var(--color-ln-ink-2)]">{report.locationAddress}</p>
                )}
                {(report.jurisdictionLocality || report.jurisdictionProvince) && (
                  <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
                    {[report.jurisdictionLocality, report.jurisdictionProvince]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                )}
                {locationPoint && (
                  <>
                    <LocationMap lat={locationPoint.lat} lng={locationPoint.lng} />
                    <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
                      {locationPoint.lat.toFixed(6)}, {locationPoint.lng.toFixed(6)}
                    </p>
                  </>
                )}
              </div>
            </LnCardBody>
          </LnCard>
        )}

        {/* Contact */}
        {hasContact && (
          <LnCard>
            <LnCardHead title="Contacto que dejaste" />
            <LnCardBody>
              <div className="flex flex-col gap-1.5">
                {report.reporterContactEmail && (
                  <p className="text-md text-[var(--color-ln-ink-2)]">
                    {report.reporterContactEmail}
                  </p>
                )}
                {report.reporterContactPhone && (
                  <p className="text-md text-[var(--color-ln-ink-2)]">
                    {report.reporterContactPhone}
                  </p>
                )}
              </div>
            </LnCardBody>
          </LnCard>
        )}

        {/* Evidence gallery */}
        {attachments.length > 0 && (
          <LnCard>
            <LnCardHead title="Evidencia adjunta" />
            <LnCardBody>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {attachments.map((a) =>
                  a.signedUrl ? (
                    a.mimeType.startsWith("video/") ? (
                      <div
                        key={a.id}
                        className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)]"
                      >
                        {/* biome-ignore lint/a11y/useMediaCaption: evidence video, no captions available */}
                        <video
                          src={a.signedUrl}
                          controls
                          className="w-full aspect-video object-cover bg-[var(--color-ln-stripe)]"
                        />
                        {a.originalFilename && (
                          <p className="px-2 py-1 font-ln-mono text-xs text-[var(--color-ln-mute)] truncate">
                            {a.originalFilename}
                          </p>
                        )}
                      </div>
                    ) : (
                      <a
                        key={a.id}
                        href={a.signedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] hover:opacity-90 transition-opacity"
                      >
                        <img
                          src={a.signedUrl}
                          alt={a.originalFilename ?? "Evidencia adjunta"}
                          className="w-full aspect-square object-cover bg-[var(--color-ln-stripe)]"
                        />
                      </a>
                    )
                  ) : null,
                )}
              </div>
            </LnCardBody>
          </LnCard>
        )}

        {/* Reporter comments */}
        {report.caseId && (
          <LnCard>
            <LnCardHead title="Tus comentarios sobre el caso" />
            <LnCardBody>
              {reporterComments.length > 0 && (
                <ol className="mb-4 flex flex-col gap-2.5">
                  {reporterComments.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3.5 py-3"
                    >
                      <p className="text-md text-[var(--color-ln-ink-2)] whitespace-pre-wrap">
                        {c.notes}
                      </p>
                      <time className="mt-1 block font-ln-mono text-xs text-[var(--color-ln-mute)]">
                        {formatDateTime(c.occurredAt)}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
              <ReporterCommentForm action={commentAction} />
            </LnCardBody>
          </LnCard>
        )}
      </div>
    </div>
  );
}
