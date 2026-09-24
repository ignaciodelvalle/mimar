import "server-only";

// Shared server loader for the govt/admin welfare-report INSPECTOR (task #12).
//
// The master-detail inspector on /gob/maltrato fetches a case through
// GET /api/gob/maltrato/[id] instead of a full navigation. This module owns the
// authorization + audit + data projection for that route, so the fence
// invariants live in ONE tested place:
//
//   - Scope guard: govt callers see a report ONLY when its (province, locality)
//     is inside their assignments (jurisdictionScopeContains, whole-province
//     subsumption). Out of scope → { ok: false } → the route answers 404 and
//     NEVER leaks that the report exists elsewhere. This is the SAME predicate
//     the full page (app/gob/maltrato/[id]/page.tsx) and the queue list use.
//
//   - Coordinate-view audit (PO decision): logWelfareLocationViewed fires ON
//     CASE OPEN, exactly as the full page does at page.tsx:145-147 — parity
//     with today's behavior (a route prefetch may log a view without a human
//     read; accepted v1 tradeoff for a tamper-evident access trail, Ley 25.326).
//     Awaited so the trail commits before the response returns.
//
// The full page keeps its own inline loading (the escape hatch stays working);
// wave 2 (QueueInspectorLayout extraction) can converge them. Returned Dates
// serialize to ISO strings through NextResponse.json — the client inspector
// rehydrates them with new Date(...).

import {
  caseEvents,
  db,
  organizations,
  pets,
  profiles,
  welfareReportAttachments,
  welfareReports,
} from "@/db";
import { type TimelineEvent, fetchWelfareTimeline } from "@/lib/analytics/govt-dashboards";
import { getNormativesForCase } from "@/lib/domain/case-normatives";
import {
  type GobReadRole,
  hasNationalReadScope,
  jurisdictionScopeContains,
} from "@/lib/domain/jurisdiction-canonical";
import { readPoint } from "@/lib/domain/location";
import { welfareAttachmentSignedUrl } from "@/lib/infra/storage";
import { logWelfareLocationViewed } from "@/lib/infra/welfare-location-audit";
import { withoutSyntheticRows } from "@/lib/metrics/scope";
import { calendarDaysAgoInAr } from "@/lib/utils/format";
import { isUuid } from "@/lib/utils/uuid";
import {
  isValidReferenceCodeFormat,
  normalizeReferenceCode,
} from "@/src/modules/welfare/domain/reference-code";
import { and, desc, eq, inArray } from "drizzle-orm";

/**
 * Where-condition for a welfare report addressed by EITHER its public reference
 * code (DEN-XXXX-XXXX — the user-visible identifier now carried in `?caso=` and
 * the /gob/maltrato/[id] segment) OR its internal uuid (legacy links, still
 * accepted during the transition).
 *
 * Resolving the public code to the row HERE — before the govt scope guard — is
 * what keeps authorization identical to the old uuid path: the scope check still
 * runs on the fetched row's (province, locality), so a public code can never
 * reach a report outside the caller's jurisdiction. This is the ONE place the
 * mapping lives, shared by the inspector API and the full-page escape hatch.
 */
export function welfareReportParamCondition(param: string) {
  const normalized = normalizeReferenceCode(param);
  return isValidReferenceCodeFormat(normalized)
    ? eq(welfareReports.referenceCode, normalized)
    : eq(welfareReports.id, param);
}

/**
 * True when `param` is a shape `welfareReportParamCondition` can actually
 * resolve — a valid DEN-XXXX-XXXX code, or a uuid.
 *
 * Callers MUST check this before building the condition. The `else` branch
 * above falls through to `eq(welfareReports.id, param)`, and `welfare_reports.id`
 * is a uuid column: a param that is neither shape (a mistyped or stale URL
 * segment) makes Postgres throw "invalid input syntax for type uuid", which
 * surfaces as the generic error boundary under HTTP **200** rather than the 404
 * the product already ships. QA 2026-08-07 found that class of 200-for-missing
 * on the adoption detail route; these two welfare routes shared it.
 *
 * The check lives HERE, beside the condition it guards, because the two are one
 * contract — a caller cannot know that the uuid branch is the unguarded one.
 * It is deliberately NOT folded into `welfareReportParamCondition` (which must
 * keep returning a condition, not null) so the caller decides the 404.
 */
export function isResolvableWelfareReportParam(param: string): boolean {
  return isValidReferenceCodeFormat(normalizeReferenceCode(param)) || isUuid(param);
}

// Govt detail projection — all PII fields included (govt role is permitted).
// Mirrors GOB_WELFARE_DETAIL_SELECT on the full page.
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
  reporterUserId: welfareReports.reporterUserId,
  reporterContactEmail: welfareReports.reporterContactEmail,
  reporterContactPhone: welfareReports.reporterContactPhone,
} as const;

export type WelfareInspectorAttachment = {
  id: string;
  originalFilename: string | null;
  storagePath: string;
  signedUrl: string | null;
};

export type WelfareInspectorDerivableOrg = {
  id: string;
  displayName: string;
  publicToken: string;
  orgType: string;
};

export type WelfareInspectorLaw = {
  id: string;
  label: string;
  scope: string;
};

export type WelfareInspectorDetail = {
  id: string;
  referenceCode: string;
  kind: string;
  severity: string;
  status: string;
  description: string;
  observedSymptoms: string | null;
  subjectKind: string;
  subjectDescription: string | null;
  subjectPetToken: string | null;
  locationAddress: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  locationPoint: { lat: number; lng: number } | null;
  occurredAt: Date | null;
  createdAt: Date;
  ageInDays: number;
  triagedAt: Date | null;
  triagedByName: string | null;
  closedAt: Date | null;
  resolutionNotes: string | null;
  assignedToUserId: string | null;
  assignedToName: string | null;
  isTerminal: boolean;
  reporter: {
    isAnonymous: boolean;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  orgInterventionStatus: string | null;
  orgInterventionAt: Date | null;
  orgReturnReason: string | null;
  derivedOrgInfo: { orgId: string; orgDisplayName: string; derivedAt: Date } | null;
  derivableOrgs: WelfareInspectorDerivableOrg[];
  attachments: WelfareInspectorAttachment[];
  normativas: WelfareInspectorLaw[];
  timelineEvents: TimelineEvent[];
  // Viewer context needed by the Acciones tab (assignment / admin-only affordances).
  currentUserId: string;
  isAdmin: boolean;
};

export type WelfareInspectorResult = { ok: true; detail: WelfareInspectorDetail } | { ok: false };

// Structural subset of AdminOrGovtSession — accepts both the page's
// requireAdminOrGovtOrRedirect() result and the API guard's resolved actor
// (profile.id === auth user id, verified in request-cache getProfileCached).
export type WelfareInspectorSession = {
  profile: { id: string; role: GobReadRole };
  jurisdictions: ReadonlyArray<{ province: string; locality: string }>;
  user: { id: string };
};

const ORG_DERIVATION_TYPES = ["shelter", "rescue_network"] as const;

/**
 * Load the inspector detail for a welfare report, enforcing the govt scope
 * guard and firing the coordinate-view audit ON OPEN. Returns { ok: false }
 * when the report does not exist OR is out of the caller's scope — the route
 * maps both to a 404 so existence never leaks.
 */
export async function loadWelfareInspectorDetail(
  session: WelfareInspectorSession,
  // Accepts the public reference code (DEN-XXXX-XXXX) or the internal uuid.
  idOrCode: string,
): Promise<WelfareInspectorResult> {
  const { profile, jurisdictions, user } = session;

  // An unresolvable param folds into the SAME { ok: false } as "does not exist"
  // — the route maps it to 404, so a garbage segment cannot be distinguished
  // from a real-but-out-of-scope report either. Without this it reached the
  // uuid branch of welfareReportParamCondition and threw instead of 404ing.
  if (!isResolvableWelfareReportParam(idOrCode)) return { ok: false };

  const [report] = await db
    .select(GOB_WELFARE_DETAIL_SELECT)
    .from(welfareReports)
    // T1-P1: a seed-tagged report does not exist for a non-admin reader (404).
    .where(
      and(
        welfareReportParamCondition(idOrCode),
        withoutSyntheticRows(profile.role, "welfareReports", null) ?? undefined,
      ),
    )
    .limit(1);
  if (!report) return { ok: false };

  // Govt scope guard — out of scope is INDISTINGUISHABLE from "does not exist"
  // (404, never a permission error). Same subsumption-aware predicate as the
  // triage queue list and the full page (jurisdictionScopeContains).
  if (!hasNationalReadScope(profile.role)) {
    const inScope = jurisdictionScopeContains(
      jurisdictions,
      report.jurisdictionProvince,
      report.jurisdictionLocality,
    );
    if (!inScope) return { ok: false };
  }

  const locationPoint = readPoint(report);

  // Coordinate-view audit ON OPEN (PO decision — parity with page.tsx:145-147).
  // Awaited so the trail commits before the response returns.
  if (locationPoint) {
    await logWelfareLocationViewed(user.id, report.id, report.referenceCode);
  }

  // Attachments (signed URLs).
  const attachmentRows = await db
    .select()
    .from(welfareReportAttachments)
    .where(eq(welfareReportAttachments.welfareReportId, report.id));
  const attachments: WelfareInspectorAttachment[] = await Promise.all(
    attachmentRows.map(async (a) => ({
      id: a.id,
      originalFilename: a.originalFilename,
      storagePath: a.storagePath,
      signedUrl: await welfareAttachmentSignedUrl(a.storagePath),
    })),
  );

  // Resolve actor display names for the reporter / triage attribution.
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

  // Resolve subject pet public token (used by the "Ver mascota" drill).
  let subjectPetToken: string | null = null;
  if (report.subjectPetId) {
    const [subjectPet] = await db
      .select({ publicToken: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, report.subjectPetId))
      .limit(1);
    subjectPetToken = subjectPet?.publicToken ?? null;
  }

  // Derivable verified orgs, scoped to the report's jurisdiction.
  const derivableOrgs: WelfareInspectorDerivableOrg[] = await db
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

  // Current derivation target.
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

  // Org "devuelto" return reason.
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

  // AR-calendar days, not elapsed-ms floor (calendarDaysAgoInAr rationale).
  const ageInDays = calendarDaysAgoInAr(new Date(report.createdAt));

  const timelineEvents = await fetchWelfareTimeline(report.id);

  const assignedToName = report.assignedToUserId
    ? (actorNames.get(report.assignedToUserId) ?? "un agente")
    : null;

  const normativas: WelfareInspectorLaw[] = getNormativesForCase("welfare_denuncia", {
    country: "AR",
    province: report.jurisdictionProvince ?? undefined,
  }).map((law) => ({ id: law.id, label: law.label, scope: law.scope }));

  return {
    ok: true,
    detail: {
      id: report.id,
      referenceCode: report.referenceCode,
      kind: report.kind,
      severity: report.severity,
      status: report.status,
      description: report.description,
      observedSymptoms: report.observedSymptoms,
      subjectKind: report.subjectKind,
      subjectDescription: report.subjectDescription,
      subjectPetToken,
      locationAddress: report.locationAddress,
      jurisdictionProvince: report.jurisdictionProvince,
      jurisdictionLocality: report.jurisdictionLocality,
      locationPoint,
      occurredAt: report.occurredAt,
      createdAt: report.createdAt,
      ageInDays,
      triagedAt: report.triagedAt,
      triagedByName: report.triagedByUserId
        ? (actorNames.get(report.triagedByUserId) ?? null)
        : null,
      closedAt: report.closedAt,
      resolutionNotes: report.resolutionNotes,
      assignedToUserId: report.assignedToUserId,
      assignedToName,
      isTerminal,
      reporter: {
        isAnonymous: report.reporterUserId === null,
        name: report.reporterUserId
          ? (actorNames.get(report.reporterUserId) ?? "Usuario registrado")
          : null,
        email: report.reporterContactEmail,
        phone: report.reporterContactPhone,
      },
      orgInterventionStatus: report.orgInterventionStatus,
      orgInterventionAt: report.orgInterventionAt,
      orgReturnReason,
      derivedOrgInfo,
      derivableOrgs,
      attachments,
      normativas,
      timelineEvents,
      currentUserId: user.id,
      isAdmin: profile.role === "admin",
    },
  };
}
