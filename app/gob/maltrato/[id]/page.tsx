import dynamic from "next/dynamic";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  caseEvents,
  db,
  organizations,
  pets,
  profiles,
  welfareReportAttachments,
  welfareReports,
} from "@/db";

// Govt detail projection — all PII fields included (govt role is permitted).
// Performance projection only: drops flaggedAt, flagReasons, moderationResolvedAt,
// moderationResolvedByUserId, reporterOrganizationId, derivedByUserId — not rendered here.
const GOB_WELFARE_DETAIL_SELECT = {
  id: welfareReports.id,
  referenceCode: welfareReports.referenceCode,
  kind: welfareReports.kind,
  severity: welfareReports.severity,
  status: welfareReports.status,
  description: welfareReports.description,
  observedSymptoms: welfareReports.observedSymptoms,
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
  triagedAt: welfareReports.triagedAt,
  triagedByUserId: welfareReports.triagedByUserId,
  closedAt: welfareReports.closedAt,
  resolutionNotes: welfareReports.resolutionNotes,
  caseId: welfareReports.caseId,
  assignedToUserId: welfareReports.assignedToUserId,
  derivedToOrganizationId: welfareReports.derivedToOrganizationId,
  derivedAt: welfareReports.derivedAt,
  orgInterventionStatus: welfareReports.orgInterventionStatus,
  orgInterventionAt: welfareReports.orgInterventionAt,
  // PII — allowed: govt/admin role, not org-facing
  reporterUserId: welfareReports.reporterUserId,
  reporterContactEmail: welfareReports.reporterContactEmail,
  reporterContactPhone: welfareReports.reporterContactPhone,
} as const;
import { fetchWelfareTimeline } from "@/lib/analytics/govt-dashboards";
import { getNormativesForCase } from "@/lib/domain/case-normatives";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { readPoint } from "@/lib/domain/location";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { welfareAttachmentSignedUrl } from "@/lib/infra/storage";
import {
  isResolvableWelfareReportParam,
  welfareReportParamCondition,
} from "@/lib/infra/welfare-inspector-detail";
import { logWelfareLocationViewed } from "@/lib/infra/welfare-location-audit";
import { withoutSyntheticRows } from "@/lib/metrics/scope";
import { createClient } from "@/lib/supabase/server";
import { calendarDaysAgoInAr, formatDate, formatDateTime } from "@/lib/utils/format";
import {
  welfareAssignmentField,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
  welfareReportStatusLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";
import { and, desc, eq, inArray } from "drizzle-orm";

import {
  CaseHeader,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpKpiSm,
  type StatusTone,
} from "@/components/ui/dashboard";

import { AssignmentActions } from "./AssignmentActions";
import { DerivationPanel } from "./DerivationPanel";
import { MpfExportButton } from "./MpfExportButton";
import { PrintExpedienteButton } from "./PrintExpedienteButton";
import { Timeline } from "./Timeline";
import { TriageActions } from "./TriageActions";

// Q6 (print) — route-scoped print sheet; see expediente-print.css.
// operator-print-escape.css neutralises the /gob shell's four clipping boxes
// under print media (PRN-3): without it this expediente prints as ONE page,
// silently dropping its own timeline, normativa and attribution footer.
import { documentAttributionLine } from "@/lib/analytics/export-attribution";
import "@/components/layout/operator-print-escape.css";
import "./expediente-print.css";

const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="w-full h-64 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe animate-pulse" />
  ),
});

// welfareReports status → canonical StatusTone. The welfare enum
// (open/triaged/in_progress/closed/duplicate/invalid) does NOT match
// CaseStatus, so this caller maps its own status to the shared vocabulary and
// feeds CaseHeader an already-resolved chip (see CaseHeader's docblock).
// triaged + in_progress both read as "in review" (st-info); their distinct
// labels disambiguate.
const WELFARE_STATUS_TONE: Record<string, StatusTone> = {
  open: "st-warn",
  triaged: "st-info",
  in_progress: "st-info",
  closed: "st-ok",
  invalid: "neutral",
  duplicate: "neutral",
};

export default async function GobMaltratoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // `id` is the PUBLIC reference code (DEN-XXXX-XXXX) for new links; legacy uuid
  // links still resolve (welfareReportParamCondition accepts both).
  const { id } = await params;
  // Neither shape → 404, not a uuid-cast throw behind a 200 error boundary.
  if (!isResolvableWelfareReportParam(id)) notFound();
  const { profile, jurisdictions, user } = await requireGobReadAccessOrRedirect();

  const [report] = await db
    .select(GOB_WELFARE_DETAIL_SELECT)
    .from(welfareReports)
    // T1-P1: a seed-tagged report does not exist for a non-admin reader (404).
    .where(
      and(
        welfareReportParamCondition(id),
        withoutSyntheticRows(profile.role, "welfareReports", null) ?? undefined,
      ),
    )
    .limit(1);
  if (!report) notFound();

  // Govt scope guard — return notFound rather than a permission error so
  // we don't leak "this denuncia exists somewhere else".
  //
  // MUST use the same subsumption-aware predicate as the triage queue list
  // (jurisdictionPairClause via buildMaltratoListConditions). A whole-province
  // assignment (e.g. whole-CABA / "Ciudad Autónoma de Buenos Aires") governs
  // every barrio in that province, so a denuncia geocoded to a barrio (Almagro)
  // is in scope. Hand-rolling an exact (province, locality) pair here — as this
  // did — diverged from the list: the row appeared in the queue but the detail
  // 404'd (list-vs-detail authorization inconsistency). See jurisdiction-canonical.
  if (profile.role === "govt") {
    const inScope = jurisdictionScopeContains(
      jurisdictions,
      report.jurisdictionProvince,
      report.jurisdictionLocality,
    );
    if (!inScope) notFound();
  }

  const locationPoint = readPoint(report);

  // Audience-precision plan (2026-06-19): the authority sees the EXACT
  // coordinate (Ley 14.346 investigative need); log every such view for
  // accountability (Ley 25.326). Only logs when there's a point to view.
  // Awaited so the trail commits before the response returns (a fire-and-forget
  // insert could be dropped on serverless freeze). A route prefetch may log a
  // view without a human read — an accepted v1 tradeoff for a tamper-evident
  // access trail.
  if (locationPoint) {
    await logWelfareLocationViewed(user.id, report.id, report.referenceCode);
  }

  const attachmentRows = await db
    .select()
    .from(welfareReportAttachments)
    .where(eq(welfareReportAttachments.welfareReportId, report.id));
  const supabase = await createClient();
  const attachments = await Promise.all(
    attachmentRows.map(async (a) => ({
      ...a,
      signedUrl: await welfareAttachmentSignedUrl(a.storagePath),
    })),
  );

  // Resolve actors for transparency in the timeline at the bottom.
  const actorIds = [report.triagedByUserId, report.reporterUserId, report.assignedToUserId].filter(
    (x): x is string => x !== null,
  );
  const actorNames = new Map<string, string>();
  if (actorIds.length > 0) {
    const rows = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, actorIds));
    for (const r of rows) actorNames.set(r.id, r.displayName);
  }

  // Resolve pet publicToken when the denuncia is about a registered pet,
  // so we can pre-fill the decomiso form with the pet's token.
  let subjectPetToken: string | null = null;
  if (report.subjectPetId) {
    const [subjectPet] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, report.subjectPetId))
      .limit(1);
    subjectPetToken = subjectPet?.publicToken ?? null;
  }

  // Fetch verified shelters / rescue_networks for the derivation panel, scoped
  // to the report's jurisdiction — which, for a govt viewer, is guaranteed to be
  // inside their own assignments by the scope guard above (a govt only reaches
  // this page for a report whose (province, locality) is in `jurisdictions`).
  // The previous nationwide fallback leaked the full verified-org roster to a
  // provincial agent whenever no in-jurisdiction org existed; it is removed. An
  // empty list is the correct secure outcome (no in-scope org to derive to).
  const ORG_DERIVATION_TYPES = ["shelter", "rescue_network"] as const;
  const derivableOrgs = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      publicToken: organizations.publicToken,
      orgType: organizations.orgType,
    })
    .from(organizations)
    .where(
      and(
        eq(organizations.verified, true),
        inArray(organizations.orgType, [...ORG_DERIVATION_TYPES]),
        ...(report.jurisdictionProvince
          ? [eq(organizations.jurisdictionProvince, report.jurisdictionProvince)]
          : []),
      ),
    )
    .limit(50);

  // Resolve current derivation target (if any).
  let derivedOrgInfo: { orgId: string; orgDisplayName: string; derivedAt: Date } | null = null;
  if (report.derivedToOrganizationId) {
    const [derivedOrg] = await db
      .select({ id: organizations.id, displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, report.derivedToOrganizationId))
      .limit(1);
    if (derivedOrg && report.derivedAt) {
      derivedOrgInfo = {
        orgId: derivedOrg.id,
        orgDisplayName: derivedOrg.displayName,
        derivedAt: report.derivedAt,
      };
    }
  }

  // Org intervention state (UI-7). On "devuelto" the org cleared
  // derivedToOrganizationId, so derivedOrgInfo is null but orgInterventionStatus
  // stays 'devuelto' — surface the return reason from the latest return note.
  let orgReturnReason: string | null = null;
  if (report.orgInterventionStatus === "devuelto" && report.caseId) {
    const [returnNote] = await db
      .select({ notes: caseEvents.notes })
      .from(caseEvents)
      .where(
        and(
          eq(caseEvents.caseId, report.caseId),
          eq(caseEvents.entryType, "org_intervention_return"),
        ),
      )
      .orderBy(desc(caseEvents.occurredAt))
      .limit(1);
    orgReturnReason = returnNote?.notes ?? null;
  }

  const isTerminal =
    report.status === "closed" || report.status === "invalid" || report.status === "duplicate";

  // Case age in AR-calendar days (a case opened yesterday evening is "1 día"
  // this morning, never "Hoy" — calendarDaysAgoInAr rationale).
  const ageInDays = calendarDaysAgoInAr(new Date(report.createdAt));

  // Timeline events.
  const timelineEvents = await fetchWelfareTimeline(report.id);

  // Assignment state.
  const isAssignedToMe = report.assignedToUserId === user.id;
  const assignedToName = report.assignedToUserId
    ? (actorNames.get(report.assignedToUserId) ?? "un agente")
    : null;

  const statusTone = WELFARE_STATUS_TONE[report.status] ?? "neutral";

  return (
    // `data-print-root` is the e2e hook: print-surfaces.spec.ts walks this
    // node's ancestors under `emulateMedia({ media: "print" })` and fails if any
    // of them still clips to viewport height (the PRN-3 signature).
    <div data-print-root className="expediente-print-root space-y-6">
      {/* Q6 print-only header — the paper copy travels without the shell's
          context, so it names the instrument up front: case code +
          jurisdiction. Screen keeps CaseHeader below as before. */}
      <div className="hidden border-b border-ln-op-line pb-2 print:block">
        <p className="text-lg font-bold">
          Expediente {report.referenceCode} — Denuncia de maltrato (Ley 14.346)
        </p>
        <p className="text-sm">
          {[report.jurisdictionLocality, report.jurisdictionProvince].filter(Boolean).join(", ") ||
            "Jurisdicción sin registrar"}
        </p>
      </div>

      {/* Breadcrumb — F1 fusion (2026-07-22): Triage is now a stage of the
          Denuncias hub; link straight there instead of through the old
          /gob/maltrato redirect. "Imprimir" (Q6) sits opposite: the print
          sheet hides every button/link, so this row is screen-only chrome. */}
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/gob/denuncias?etapa=triage"
          className="text-sm text-ln-op-mute hover:text-ln-op-ink-2"
        >
          ← Volver al listado
        </Link>
        <PrintExpedienteButton />
      </div>

      <CaseHeader
        title={welfareReportKindLabel(report.kind)}
        status={{ label: welfareReportStatusLabel(report.status), tone: statusTone }}
        aside={
          <span className="text-xs uppercase tracking-wider text-ln-op-mute">
            {welfareReportSeverityLabel(report.severity)}
          </span>
        }
        meta={`${report.referenceCode} · creada ${formatDateTime(report.createdAt)}`}
      />

      {/* Summary chips row — case metadata at a glance. H2 fix
          (adversarial-gob 2026-07-23): these were 4 hand-rolled chips;
          OpKpiSm already exists and is used identically by /gob/mortalidad's
          "Contexto del fallecimiento" panel — one primitive, not a per-screen
          reinvention. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <OpKpiSm
          label="Edad del caso"
          value={ageInDays === 0 ? "Hoy" : ageInDays === 1 ? "1 día" : `${ageInDays} días`}
        />
        <OpKpiSm label="Gravedad" value={welfareReportSeverityLabel(report.severity)} />
        <OpKpiSm label="Estado" value={welfareReportStatusLabel(report.status)} />
        {/* Label and value move together — under a fixed "Asignado a" the
            derived case read "Asignado a: Derivada a Refugio Test". */}
        <OpKpiSm {...welfareAssignmentField(assignedToName, derivedOrgInfo?.orgDisplayName)} />
      </div>

      {/* Assignment actions */}
      {!isTerminal && (
        <AssignmentActions
          reportId={report.id}
          assignedToUserId={report.assignedToUserId}
          currentUserId={user.id}
          isAdmin={profile.role === "admin"}
        />
      )}

      <OpCard>
        <OpCardHead title="¿Qué pasó?" />
        <OpCardBody className="space-y-2">
          <p className="text-md text-ln-op-ink whitespace-pre-wrap">{report.description}</p>
          {report.observedSymptoms && (
            <p className="text-sm text-ln-op-ink whitespace-pre-wrap">
              <span className="font-semibold">Síntomas observados: </span>
              {report.observedSymptoms}
            </p>
          )}
          {report.occurredAt && (
            <p className="text-sm text-ln-op-mute">Ocurrió el {formatDate(report.occurredAt)}</p>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Sujeto" />
        <OpCardBody className="space-y-1">
          <p className="text-md text-ln-op-ink">
            {welfareReportSubjectKindLabel(report.subjectKind)}
          </p>
          {report.subjectDescription && (
            <p className="text-sm text-ln-op-ink-2 whitespace-pre-wrap">
              {report.subjectDescription}
            </p>
          )}
        </OpCardBody>
      </OpCard>

      <OpCard>
        <OpCardHead title="Lugar" />
        <OpCardBody className="space-y-3">
          <div className="text-sm text-ln-op-ink-2 space-y-1">
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
              {/* Q6: the map is a WebGL canvas — blank/garbage on paper. The
                  printed copy keeps the address line + the exact coordinates
                  below, which carry the same investigative fact. */}
              <div className="print:hidden">
                <LocationMap lat={locationPoint.lat} lng={locationPoint.lng} />
              </div>
              <p className="text-xs text-ln-op-mute font-ln-mono">
                {locationPoint.lat.toFixed(6)}, {locationPoint.lng.toFixed(6)}
              </p>
            </>
          )}
        </OpCardBody>
      </OpCard>

      {attachments.length > 0 && (
        <OpCard>
          <OpCardHead title={`Evidencia (${attachments.length})`} />
          <OpCardBody>
            <ul className="space-y-1.5 text-md">
              {attachments.map((a) => (
                <li key={a.id} className="flex items-baseline justify-between gap-3">
                  <span className="font-ln-mono text-sm truncate text-ln-op-ink-2">
                    {a.originalFilename ?? a.storagePath.split("/").pop()}
                  </span>
                  {a.signedUrl ? (
                    <a
                      href={a.signedUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-ln-op-azul underline hover:text-ln-op-azul-700"
                    >
                      Abrir →
                    </a>
                  ) : (
                    <span className="text-sm text-ln-op-mute">(no disponible)</span>
                  )}
                </li>
              ))}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      <OpCard>
        <OpCardHead title="Reportante" />
        <OpCardBody>
          {report.reporterUserId ? (
            <p className="text-sm text-ln-op-ink-2">
              {actorNames.get(report.reporterUserId) ?? "Usuario registrado"}
              {report.reporterContactEmail && (
                <span className="text-ln-op-mute"> · {report.reporterContactEmail}</span>
              )}
              {report.reporterContactPhone && (
                <span className="text-ln-op-mute"> · {report.reporterContactPhone}</span>
              )}
            </p>
          ) : (
            <p className="text-sm text-ln-op-mute">
              Denuncia anónima.
              {(report.reporterContactEmail || report.reporterContactPhone) && (
                <span>
                  {" "}
                  Contacto opcional dejado:{" "}
                  {[report.reporterContactEmail, report.reporterContactPhone]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </p>
          )}
        </OpCardBody>
      </OpCard>

      {(report.triagedAt || report.closedAt) && (
        <OpCard>
          <OpCardHead title="Trayectoria" />
          <OpCardBody className="space-y-2 text-md">
            {report.triagedAt && (
              <p className="text-ln-op-ink">
                Revisada el {formatDateTime(report.triagedAt)}
                {report.triagedByUserId && (
                  <span className="text-ln-op-mute">
                    {" "}
                    por {actorNames.get(report.triagedByUserId) ?? "una autoridad"}
                  </span>
                )}
              </p>
            )}
            {report.closedAt && (
              <p className="text-ln-op-ink">Cerrada el {formatDateTime(report.closedAt)}</p>
            )}
            {report.resolutionNotes && (
              <div className="rounded-[var(--radius-sm)] bg-ln-op-stripe p-3 text-sm text-ln-op-ink-2 whitespace-pre-wrap">
                {report.resolutionNotes}
              </div>
            )}
          </OpCardBody>
        </OpCard>
      )}

      {!isTerminal && (
        <section className="space-y-3 pt-2 border-t border-ln-op-line">
          <h2 className="text-md font-semibold text-ln-op-ink">Acciones</h2>
          <TriageActions welfareReportId={report.id} currentStatus={report.status} />
        </section>
      )}

      {/* Derivation to org — forward report to a verified shelter / rescue network */}
      {!isTerminal && (
        <OpCard>
          <OpCardHead title="Derivar a organización" />
          <OpCardBody className="space-y-2">
            <p className="text-sm text-ln-op-mute">
              Derivá esta denuncia a un refugio o red de rescate verificada para seguimiento en
              campo. La organización recibirá una notificación.
            </p>
            {/* Org intervention state (UI-7) */}
            {report.orgInterventionStatus === "tomado" && (
              <div className="rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-stripe px-3 py-2">
                <p className="text-sm text-ln-op-ink">
                  <span className="font-medium">En intervención</span> — la organización tomó la
                  denuncia
                  {report.orgInterventionAt && (
                    <span className="text-ln-op-mute">
                      {" "}
                      el {formatDateTime(report.orgInterventionAt)}
                    </span>
                  )}
                  .
                </p>
              </div>
            )}
            {report.orgInterventionStatus === "devuelto" && (
              <div className="rounded-[var(--radius-sm)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2">
                <p className="text-sm text-ln-op-warn">
                  <span className="font-medium">Devuelta por la organización</span>
                  {orgReturnReason ? `: ${orgReturnReason}` : "."} Volvé a derivarla a otra
                  organización o gestionala directamente.
                </p>
              </div>
            )}
            <DerivationPanel
              welfareReportId={report.id}
              availableOrgs={derivableOrgs}
              alreadyDerivedTo={derivedOrgInfo}
            />
          </OpCardBody>
        </OpCard>
      )}

      {/* Decomiso entry point — available for all non-terminal denuncias */}
      {!isTerminal && (
        <OpCard>
          <OpCardHead title="Derivar a decomiso" />
          <OpCardBody className="space-y-2">
            <p className="text-sm text-ln-op-mute">
              Si la denuncia amerita una incautación bajo Ley 14.346, iniciá el decomiso desde acá.
              El ID de esta denuncia se pre-completará en el formulario.
            </p>
            <Link
              href={`/gob/decomisos/nuevo?welfareReportId=${report.id}${subjectPetToken ? `&pet=${subjectPetToken}` : ""}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md font-medium hover:opacity-90 transition-opacity"
            >
              Iniciar decomiso →
            </Link>
            {report.subjectKind !== "registered_pet" && (
              <p className="text-sm text-ln-op-warn">
                La denuncia no tiene una mascota registrada vinculada. El formulario de decomiso
                admite solo mascotas con token DIM-XXXX-XXXX — tendrás que ingresar el token
                manualmente si la mascota está registrada.
              </p>
            )}
          </OpCardBody>
        </OpCard>
      )}

      {/* MPF export — available regardless of triage status */}
      <OpCard>
        <OpCardHead title="Exportación fiscal" />
        <OpCardBody>
          <MpfExportButton
            welfareReportId={report.id}
            jurisdictionProvince={report.jurisdictionProvince}
          />
        </OpCardBody>
      </OpCard>

      {/* Timeline — chronological event log */}
      <OpCard>
        <OpCardHead title="Línea de tiempo" />
        <OpCardBody>
          <Timeline events={timelineEvents} />
        </OpCardBody>
      </OpCard>

      {/* Normativa aplicable — sourced from case-normatives catalog */}
      <OpCard>
        <OpCardHead title="Normativa aplicable" />
        <OpCardBody>
          {(() => {
            const normativas = getNormativesForCase("welfare_denuncia", {
              country: "AR",
              province: report.jurisdictionProvince ?? undefined,
            });
            if (normativas.length === 0)
              return (
                <p className="text-sm text-ln-op-mute">
                  Sin normativa catalogada para esta jurisdicción.
                </p>
              );
            return (
              <ul className="space-y-2 text-sm text-ln-op-ink-2">
                {normativas.map((law) => (
                  <li key={law.id}>
                    <span className="font-medium text-ln-op-ink">{law.label}</span>
                    {` — ${law.scope}`}
                  </li>
                ))}
              </ul>
            );
          })()}
        </OpCardBody>
      </OpCard>

      {/* Q6 print-only footer — generation stamp + the shared attribution
          line (lib/analytics/export-attribution.ts: user-facing brand, never
          the internal codename; traceable by this expediente's reference
          code). The stamp is the render moment: this page is dynamic, so it
          IS the retrieval time of everything printed above it. */}
      {/* `data-print-footer`: the LAST node of the expediente, and the one the
          audit named as the tell — under PRN-3 the printed page ended before
          it. print-surfaces.spec.ts asserts it is laid out under print media. */}
      <footer
        data-print-footer
        className="hidden border-t border-ln-op-line pt-2 text-xs print:block"
      >
        <p>Documento impreso el {formatDateTime(new Date())} (hora de Argentina)</p>
        <p>{documentAttributionLine(report.referenceCode)}</p>
      </footer>
    </div>
  );
}
