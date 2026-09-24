// Welfare report detail — Libreta Nacional redesign.
// Presentation only; data fetching, actions, ReporterCommentForm, and LocationMap unchanged.

import { requireUuidParam } from "@/lib/infra/route-params";
import dynamic from "next/dynamic";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { db, pets, welfareReportAttachments, welfareReports } from "@/db";
import { caseEvents, cases } from "@/db/schema";
import { readPoint } from "@/lib/domain/location";
import { welfareAttachmentSignedUrl } from "@/lib/infra/storage";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import { addReporterCommentAction } from "@/src/modules/welfare/actions";
import {
  welfareReportKindLabel,
  welfareReportSeverityCitizenLabel,
  welfareReportStatusLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type CommentFormState, ReporterCommentForm } from "./_components/ReporterCommentForm";

const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="w-full h-[240px] rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] animate-pulse" />
  ),
});

// Terminal statuses where the "integration pending" banner contradicts the
// status badge and should be hidden (UI-7 B7).
function isTerminalReportStatus(status: string): boolean {
  return status === "closed" || status === "invalid" || status === "duplicate";
}

// The "aún no se envió al gobierno" banner is only honest for a report that
// genuinely hasn't been routed yet. It used to show for ANY non-terminal
// status — including triaged/in_progress, where a funcionario is already
// working the case (state-honesty audit). Allow-listing "open" (rather than
// just excluding the terminal statuses) also means any future status defaults
// to NOT showing the pending banner.
function isPendingReportStatus(status: string): boolean {
  return status === "open";
}

// Statuses where the report was routed but isn't closed yet — shown as an
// honest progress line instead of the "not sent yet" banner.
function isInProgressReportStatus(status: string): boolean {
  return !isTerminalReportStatus(status) && !isPendingReportStatus(status);
}

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

  const [report] = await db
    .select()
    .from(welfareReports)
    .where(and(eq(welfareReports.id, id), eq(welfareReports.reporterUserId, user.id)))
    .limit(1);
  if (!report) notFound();

  let subjectPet: { publicToken: string; name: string } | null = null;
  if (report.subjectPetId) {
    const [petRow] = await db
      .select({ publicToken: pets.publicToken, name: pets.name })
      .from(pets)
      // Art. 16 (Ley 25.326): the reporter is a live third party (the report is
      // scoped to reporterUserId, not the pet's owner), so an erased subject pet
      // must read as never registered — no name, no token, no working link.
      .where(and(eq(pets.id, report.subjectPetId), isNull(pets.deletedAt)))
      .limit(1);
    subjectPet = petRow ?? null;
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

  let reporterComments: Array<{
    id: string;
    notes: string | null;
    occurredAt: Date;
  }> = [];
  let casePublicCode: string | null = null;

  if (report.caseId) {
    const [caseRow, commentRows] = await Promise.all([
      db
        .select({ publicCode: cases.publicCode })
        .from(cases)
        .where(eq(cases.id, report.caseId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: caseEvents.id, notes: caseEvents.notes, occurredAt: caseEvents.occurredAt })
        .from(caseEvents)
        .where(
          and(eq(caseEvents.caseId, report.caseId), eq(caseEvents.entryType, "reporter_comment")),
        )
        .orderBy(desc(caseEvents.occurredAt)),
    ]);
    casePublicCode = caseRow?.publicCode ?? null;
    reporterComments = commentRows;
  }

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

      {/* Integration-pending notice — ONLY while the report is genuinely
          un-routed ("open"). Showing "aún no se envió" while a funcionario is
          already triaging/working the case would contradict reality
          (state-honesty audit) — those statuses get the progress line below
          instead. On closed / invalid / duplicate neither notice applies
          (UI-7 B7). */}
      {isPendingReportStatus(report.status) && (
        <div className="mb-6">
          <LnCallout tone="warn">
            Esta denuncia aún no fue enviada a la herramienta gubernamental — la integración con los
            canales oficiales de la Ley 14.346 está en desarrollo. Tu reporte queda guardado y será
            enviado cuando la integración esté disponible.
          </LnCallout>
        </div>
      )}

      {/* Honest progress line for triaged/in_progress — the report WAS
          routed and a funcionario is already working it, which is a
          materially different (better) state than "not sent yet". */}
      {isInProgressReportStatus(report.status) && (
        <div className="mb-6">
          <LnCallout tone="azul">En revisión por la autoridad.</LnCallout>
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
