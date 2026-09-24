// /denuncias/seguimiento — the reporter's own view. Authenticated, no account.
//
// This is the surface that had to exist before the public code page could be
// unpublished. The function it preserves is not decorative: a person can report
// animal cruelty and follow their case WITHOUT creating an account, which is the
// reason anonymous denuncias get made at all. What changed is the credential.
// Reaching this page requires a `session` cookie minted either from a link
// delivered to the email the reporter left, or at the moment of submission — see
// lib/infra/denuncia-reporter-token.ts.
//
// THE CAPABILITY BINDS TO A SUBJECT, NOT TO A CASE. This page resolves "the
// reporter's view of report X". It never resolves the expediente: there is no
// caseId in the projection below, no link to /casos, and no path from here into
// the investigation. The reporter is not a party to the proceeding.
//
// WHAT MAY BE ON THIS PAGE is decided in lib/domain/denuncia-reporter-view.ts,
// not here, and the SQL projection is the second fence around the same line: the
// columns that would breach the entitlement are not selected, so they are not in
// scope to be rendered by accident. In particular there are NO signed evidence
// URLs anywhere on this route — the reporter already holds their own files, and
// a signed URL is a bearer capability that outlives the page view and bypasses
// our rate limiter on its way to Supabase Storage.

import { LnButton } from "@/components/ui/Button";
import { db, organizations, welfareReportAttachments, welfareReports } from "@/db";
import {
  REPORTER_TIMELINE_LABELS,
  type ReporterOrganism,
  buildReporterView,
} from "@/lib/domain/denuncia-reporter-view";
import {
  REPORTER_SESSION_COOKIE_NAME,
  readReporterSessionCookie,
  reporterAccessRevoked,
} from "@/lib/infra/denuncia-reporter-token";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { formatDate, formatDateTime, pluralizeEs } from "@/lib/utils/format";
import {
  welfareReportKindLabel,
  welfareReportSeverityCitizenLabel,
} from "@/src/modules/welfare/domain/types";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";

import { DescargarComprobante } from "../codigo/[code]/DescargarComprobante";
import { SalirDelSeguimiento } from "./SalirDelSeguimiento";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="text-xs uppercase tracking-[.1em] font-semibold text-[var(--color-ln-mute)]"
      style={{ fontFamily: "var(--font-ln-mono)" }}
    >
      {children}
    </h2>
  );
}

// Shown for every failure mode — no session, expired session, forged token,
// revoked-after-close, deleted report. One screen for all of them on purpose: a
// distinct "this denuncia was closed a year ago" message would confirm the
// existence of a report to someone holding a stale or forged link.
function SinAcceso({ reason }: { reason: string }) {
  return (
    <div className="p-6 bg-[var(--color-ln-paper)]">
      <div className="max-w-lg mx-auto pt-10 space-y-6">
        <h1
          className="text-2xl font-semibold tracking-[-0.015em] text-[var(--color-ln-ink)] leading-tight"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          No podemos mostrar el seguimiento
        </h1>
        <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">{reason}</p>
        <LnButton href="/denuncias/buscar" variant="primary" size="lg">
          Pedir un enlace nuevo
        </LnButton>
      </div>
    </div>
  );
}

const EXPIRED_REASON =
  "El enlace venció o la sesión se cerró. Los enlaces de acceso duran 30 minutos por seguridad: la denuncia describe a una persona que todavía no fue investigada, así que el acceso no puede quedar abierto. Pedí uno nuevo con tu código de constancia.";

export default async function SeguimientoDenunciaPage({
  searchParams,
}: {
  searchParams: Promise<{ nueva?: string }>;
}) {
  const { nueva } = await searchParams;

  try {
    const reqHeaders = await headers();
    await enforceRateLimit("denuncia_seguimiento", callerIp(reqHeaders), {
      maxPerMinute: 30,
      maxPerHour: 200,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return (
        <SinAcceso reason="Estás realizando demasiadas consultas desde esta conexión. Esperá unos minutos y volvé a intentarlo." />
      );
    }
    throw err;
  }

  // readReporterSessionCookie verifies the MAC before handing back the id, so
  // there is no path where an attacker-chosen reportId reaches the query below.
  const jar = await cookies();
  const session = readReporterSessionCookie(jar.get(REPORTER_SESSION_COOKIE_NAME)?.value);
  if (!session) return <SinAcceso reason={EXPIRED_REASON} />;

  // FIRST FENCE: the projection. `description` is here because it is the
  // reporter's own text and they are entitled to it verbatim. `subjectDescription`,
  // `resolutionNotes`, `locationAddress`, `locationLat/Lng` and `caseId` are NOT
  // selected, so no later edit to the JSX can leak them. jurisdiction* is
  // selected for exactly one purpose: naming the responsible organism.
  const [report] = await db
    .select({
      id: welfareReports.id,
      referenceCode: welfareReports.referenceCode,
      createdAt: welfareReports.createdAt,
      occurredAt: welfareReports.occurredAt,
      kind: welfareReports.kind,
      severity: welfareReports.severity,
      description: welfareReports.description,
      reporterContactEmail: welfareReports.reporterContactEmail,
      reporterContactPhone: welfareReports.reporterContactPhone,
      status: welfareReports.status,
      triagedAt: welfareReports.triagedAt,
      derivedAt: welfareReports.derivedAt,
      closedAt: welfareReports.closedAt,
      derivedToOrganizationId: welfareReports.derivedToOrganizationId,
      jurisdictionProvince: welfareReports.jurisdictionProvince,
      jurisdictionLocality: welfareReports.jurisdictionLocality,
    })
    .from(welfareReports)
    .where(eq(welfareReports.id, session.reportId))
    .limit(1);

  if (!report) return <SinAcceso reason={EXPIRED_REASON} />;
  // Live half of revocation, re-read on every render rather than trusted from
  // the token: a capability minted the day before the close must not outlive it.
  if (reporterAccessRevoked(report.closedAt)) return <SinAcceso reason={EXPIRED_REASON} />;

  const organism = await resolveOrganism(report);

  // COUNT only. No storagePath, no mimeType, and above all no signed URL.
  const attachmentRows = await db
    .select({ id: welfareReportAttachments.id })
    .from(welfareReportAttachments)
    .where(eq(welfareReportAttachments.welfareReportId, report.id));

  const view = buildReporterView(report, {
    attachmentCount: attachmentRows.length,
    organism,
  });

  // Terminal-state predicate for the notices below. Read off the timeline (which
  // coarsens closed/invalid/duplicate into a single dated "cerrada") rather than
  // the raw status, so neither notice can contradict what the timeline shows.
  const isClosed = view.timeline.some((entry) => entry.stage === "cerrada");

  // S8-F03, preserved from the old receipt: `?nueva=1` declares an INTENTION,
  // but anyone can type a URL, and the banner below asserts a FACT in the present
  // tense. Check it against the data, not the query string.
  const JUST_SUBMITTED_WINDOW_MS = 10 * 60 * 1000;
  const justSubmitted =
    nueva === "1" && Date.now() - view.submittedAt.getTime() < JUST_SUBMITTED_WINDOW_MS;

  return (
    <div id="comprobante-root" className="p-6 bg-[var(--color-ln-paper)]">
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static print CSS, no user input
        dangerouslySetInnerHTML={{
          __html: `
@media print {
  body > *:not(main):not(#comprobante-root) { display: none !important; }
  [data-print-hide] { display: none !important; }
  #comprobante-root, #comprobante-root * { color: #000 !important; border-color: #ccc !important; background: #fff !important; }
}
          `.trim(),
        }}
      />
      <div className="max-w-2xl mx-auto pt-6 space-y-8">
        {justSubmitted && (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-5 py-5 space-y-2">
            <p className="text-sm font-semibold text-[var(--color-ln-ok)]">
              Tu denuncia fue registrada.
            </p>
            <p className="text-xs text-[var(--color-ln-ok)] leading-relaxed">
              Guardá el código de abajo. Es tu número de constancia y lo vas a necesitar para volver
              a esta pantalla.
            </p>
          </div>
        )}

        <header className="space-y-3">
          <h1
            className="text-3xl font-semibold tracking-[-0.015em] leading-tight text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Seguimiento de tu denuncia
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <p
              className="text-sm text-[var(--color-ln-mute)]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              {view.constanciaNumber}
            </p>
            <DescargarComprobante />
            <SalirDelSeguimiento />
          </div>
          <div
            className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--color-ln-mute)]"
            style={{ fontFamily: "var(--font-ln-mono)" }}
          >
            <span>{welfareReportKindLabel(view.kind)}</span>
            <span>Gravedad que indicaste: {welfareReportSeverityCitizenLabel(view.severity)}</span>
            <span>Enviada {formatDateTime(view.submittedAt)}</span>
            {view.occurredAt && <span>Ocurrió el {formatDate(view.occurredAt)}</span>}
          </div>
        </header>

        {/* Status timeline — coarse stages with dates. Never a substantive step,
            never the grounds of the resolution: the reporter is entitled to know
            where their report is, not to the content of the investigation. */}
        <section className="space-y-3">
          <SectionLabel>Estado</SectionLabel>
          <ol className="space-y-2.5">
            {view.timeline.map((entry) => (
              <li key={`${entry.stage}-${entry.at.getTime()}`} className="flex gap-3 text-sm">
                <span
                  className="text-[var(--color-ln-mute)] shrink-0"
                  style={{ fontFamily: "var(--font-ln-mono)" }}
                >
                  {formatDate(entry.at)}
                </span>
                <span className="text-[var(--color-ln-ink-2)]">
                  {REPORTER_TIMELINE_LABELS[entry.stage]}
                </span>
              </li>
            ))}
          </ol>

          {/* UI-7 B7, ported from the old public receipt. This banner belonged on
              a reporter-facing surface, and after the unpublish this is the only
              one: the code page no longer shows status at all. It says something
              about OUR system, not about the accused, so it is squarely inside the
              entitlement — and a reporter who sees "Recibida" and nothing else for
              weeks deserves to know why.

              Gated on the TIMELINE, not on the raw status enum, which
              buildReporterView deliberately does not expose. `length === 1` means
              only "recibida" has a timestamp — nothing was derived, triaged or
              closed — so the report genuinely has not been routed. That is a
              stronger claim than `status === "open"` because it is grounded in
              timestamps rather than an enum someone could widen, and it fails
              SAFE: any future stage that gets a date stops the banner instead of
              letting it contradict reality. */}
          {view.timeline.length === 1 ? (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-025)] px-5 py-4 text-sm text-[var(--color-ln-warn)] leading-relaxed">
              Esta denuncia aún no fue enviada a la herramienta gubernamental — la integración con
              los canales oficiales de la Ley 14.346 está en desarrollo. Tu reporte queda guardado y
              será enviado cuando la integración esté disponible.
            </div>
          ) : (
            !isClosed && (
              <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] px-5 py-4 text-sm text-[var(--color-ln-azul)] leading-relaxed">
                En revisión por la autoridad.
              </div>
            )
          )}
        </section>

        {/* Their own words, verbatim. Never summarised — this is the Ley 25.326
            access answer to "what does the state hold that I wrote". */}
        <section className="space-y-2">
          <SectionLabel>Lo que contaste</SectionLabel>
          <p className="text-[var(--color-ln-ink-2)] leading-relaxed whitespace-pre-wrap">
            {view.ownText}
          </p>
        </section>

        {/* Contact retained — shown IN FULL, unlike the old public receipt which
            masked it. Masking made sense when any code holder could read the
            screen; here the reader has proven control of the channel, and a
            data-access answer that hides half the datum answers nothing. */}
        <section className="space-y-2">
          <SectionLabel>Datos de contacto que guardamos</SectionLabel>
          <div className="text-sm text-[var(--color-ln-ink-2)] space-y-1">
            {view.retainedContact.email && <p>{view.retainedContact.email}</p>}
            {view.retainedContact.phone && <p>{view.retainedContact.phone}</p>}
            {!view.retainedContact.email && !view.retainedContact.phone && (
              <p className="text-[var(--color-ln-mute)]">
                Ninguno. Enviaste la denuncia de forma anónima.
              </p>
            )}
          </div>
        </section>

        {/* Count, not content. The files are the reporter's own; re-serving them
            here would recreate the signed-URL leak this change closed. */}
        {view.attachmentCount > 0 && (
          <section className="space-y-2">
            <SectionLabel>Archivos que adjuntaste</SectionLabel>
            <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
              {view.attachmentCount} {pluralizeEs(view.attachmentCount, "archivo")}. El organismo
              los recibe completos. No los mostramos acá: ya son tuyos, y publicar un enlace de
              descarga en esta pantalla sería un riesgo sin beneficio.
            </p>
          </section>
        )}

        {view.organism && (
          <section className="space-y-2">
            <SectionLabel>Organismo responsable</SectionLabel>
            <div className="text-sm text-[var(--color-ln-ink-2)] space-y-1">
              <p>{view.organism.name}</p>
              {view.organism.email && <p>{view.organism.email}</p>}
              {view.organism.phone && <p>{view.organism.phone}</p>}
              {!view.organism.email && !view.organism.phone && (
                <p className="text-[var(--color-ln-mute)]">
                  Todavía no tenemos un canal de contacto directo cargado para este organismo.
                  Presentá tu código de constancia ante la autoridad local.
                </p>
              )}
            </div>
          </section>
        )}

        {/* The boundary, said out loud. A reporter who is not told where the wall
            is reads the missing sections as a malfunction. */}
        <section className="space-y-2 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-5 py-4">
          <SectionLabel>Qué no podemos mostrarte</SectionLabel>
          <p className="text-sm text-[var(--color-ln-ink-2)] leading-relaxed">
            No podemos mostrarte quién fue denunciado, las anotaciones internas, el contenido de la
            investigación ni los fundamentos de una decisión. La denuncia la hiciste vos, pero el
            expediente es entre el organismo y la persona investigada, que tiene derecho a
            defenderse antes de que nadie más lea nada sobre ella.
          </p>
        </section>

        <p className="text-xs text-[var(--color-ln-mute)] leading-relaxed" data-print-hide>
          Esta pantalla se cierra sola: el acceso vence a la hora. Después pedís un enlace nuevo con
          tu código.
        </p>
      </div>
    </div>
  );
}

/**
 * Who is answerable for this report.
 *
 * Derived to a verified organisation → that org, with its channel. Otherwise the
 * jurisdiction that owns it, named but without a channel, because this product
 * has no directory of municipal welfare contacts yet. Saying "the authority of
 * X, and we don't have its number" is worth more to a reporter than a confident
 * blank, and it is the truth.
 */
async function resolveOrganism(report: {
  derivedToOrganizationId: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
}): Promise<ReporterOrganism | null> {
  if (report.derivedToOrganizationId) {
    const [org] = await db
      .select({
        displayName: organizations.displayName,
        email: organizations.email,
        phone: organizations.phone,
      })
      .from(organizations)
      .where(eq(organizations.id, report.derivedToOrganizationId))
      .limit(1);
    if (org) return { name: org.displayName, email: org.email, phone: org.phone };
  }

  const place = [report.jurisdictionLocality, report.jurisdictionProvince]
    .filter(Boolean)
    .join(", ");
  if (!place) return null;
  return { name: `Autoridad competente de ${place}`, email: null, phone: null };
}
