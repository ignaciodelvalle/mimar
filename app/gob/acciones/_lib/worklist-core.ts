// worklist-core — PURE composition layer for /gob/acciones (G5).
//
// No Drizzle, no Next.js, no React: this module turns already-fetched domain
// rows into WorklistItem[] (one per pending obligation) and merges them into
// ONE flat list ranked by DEADLINE — the composition that did not exist
// before this screen (every bandeja ranked by count, none by "what expires
// first"). All IO lives in ./worklist-io.ts; keeping the mappers and the
// merge pure is what lets the sort contract be unit-tested without a DB.
//
// Deadline rules per domain (each computed HERE from the domain's own
// published rule — never re-derived inside a component):
//   - observación antirrábica: the caller resolves the deadline via
//     resolveObservationDeadline (10-day legal window) and passes it in.
//   - denuncia de maltrato: createdAt + WELFARE_SLA_DAYS[severity]
//     (slaDaysForSeverity — the SAME tier map the SlaBadge/queue use).
//   - caso regulatorio: openedAt + CASE_SLA_WARNING_DAYS (the shared
//     CaseQueue's own ≥14-day SLA-alert convention).

import { type DueInfo, compareDueInfo, computeDueInfo } from "@/lib/domain/due-state";
import { speciesLabel } from "@/lib/utils/format";
import { type CaseKind, caseKindLabel } from "@/src/modules/cases/domain/case-kinds";
// PURE module (NOT the "use client" CaseQueue.tsx): importing it from the client
// component would make CASE_SLA_WARNING_DAYS a throw-on-coerce Proxy in this RSC
// server module and silently kill the caso domain.
import { caseSlaDueAt } from "@/src/modules/cases/domain/case-sla";
import { OBSERVATION_DUE_SOON_DAYS } from "@/src/modules/surveillance/domain/observation-overdue";
import {
  type WelfareReportSeverity,
  welfareReportKindLabel,
  welfareReportSeverityLabel,
} from "@/src/modules/welfare/domain/types";

import { slaDaysForSeverity } from "@/app/gob/maltrato/_lib/welfare-sla";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many rows the merged list renders. Each domain fetch carries its own
 * query cap (see worklist-io.ts) and fetches oldest-first where the query
 * allows it, so truncation always drops the LEAST urgent tail.
 */
export const WORKLIST_RENDER_LIMIT = 100;

export type WorklistDomain = "observacion" | "denuncia" | "caso";

export const WORKLIST_DOMAIN_LABEL: Record<WorklistDomain, string> = {
  observacion: "Observación antirrábica",
  denuncia: "Denuncia de maltrato",
  caso: "Caso regulatorio",
};

/**
 * The row's resolution affordance. HONEST SCOPE (2026-08 scout): only the
 * welfare domain has a true one-click inline mutation (TomarButton →
 * assignWelfareToMeAction); everything else gets a link-out to the screen
 * where the resolution flow actually lives — a real "Resolver/Ver →" beats
 * a fake inline button.
 */
export type WorklistAction =
  | { type: "link"; href: string; label: string }
  | {
      type: "welfare";
      reportId: string;
      /** True → the row also offers the one-click "Tomar" self-assign. */
      unassigned: boolean;
      href: string;
    };

export type WorklistItem = {
  /** Stable render key, unique across domains ("obs:", "den:", "caso:"). */
  key: string;
  domain: WorklistDomain;
  /** Main subject line — pet name, denuncia kind, case kind. */
  subject: string;
  /** Secondary detail (species, severity) — null when nothing to add. */
  detail: string | null;
  /** Public code for the OpCodeBadge (DIM token / DEN / CAS). */
  code: string | null;
  province: string | null;
  locality: string | null;
  due: DueInfo;
  action: WorklistAction;
};

// ---------------------------------------------------------------------------
// Domain row shapes — the exact fields each mapper consumes (structural
// subsets of the fetchers' return types, so tests can build them literally).
// ---------------------------------------------------------------------------

export type ObservationWorklistRow = {
  petId: string;
  petPublicToken: string;
  petName: string;
  species: string;
  province: string | null;
  locality: string | null;
  /** Resolved by the caller via resolveObservationDeadline; null only when
   *  the observation has no rabies_observation_started event at all (a data
   *  gap — rendered honestly as "Sin plazo", ranked last, never hidden). */
  dueAt: Date | null;
};

export type WelfareWorklistRow = {
  id: string;
  referenceCode: string;
  kind: string;
  severity: WelfareReportSeverity;
  createdAt: Date;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  assignedToUserId: string | null;
};

/** Structural subset of lib/infra/case-queries' CaseListItem (kept
 *  structural — not a type import — so this module, and every test that
 *  imports it, stays off the DB import graph / in the "unit" project). */
export type CaseWorklistRow = {
  id: string;
  publicCode: string;
  caseKind: CaseKind;
  primaryPetName: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  openedAt: Date;
};

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/** In-progress rabies observations → worklist items ("Cerrar →" link-out to
 *  the professional-closure flow, which is govt-accessible under /admin —
 *  requireAdminOrGovtOrRedirect on the detail route). */
export function mapObservationRows(rows: ObservationWorklistRow[], now: Date): WorklistItem[] {
  return rows.map((r) => ({
    key: `obs:${r.petId}`,
    domain: "observacion" as const,
    subject: r.petName,
    detail: speciesLabel(r.species),
    code: r.petPublicToken,
    province: r.province,
    locality: r.locality,
    // Same due-soon window as /admin/observaciones (OBSERVATION_DUE_SOON_DAYS),
    // so the same observation reads identically on both screens.
    due: computeDueInfo(r.dueAt, now, OBSERVATION_DUE_SOON_DAYS),
    action: {
      type: "link" as const,
      // /gob, not /admin (2026-08-10). This worklist lives under app/gob and is
      // read by government operators, but it emitted an /admin href — whose
      // LAYOUT calls requireAdminOrRedirect and bounces govt to the home before
      // the destination page (which does admit govt) ever runs. The product
      // offered the action and then denied it, silently.
      //
      // /gob/observaciones/[publicToken] re-exports the same page, and the /gob
      // layout admits admin as well as govt, so this href is correct for every
      // viewer of this screen.
      href: `/gob/observaciones/${r.petPublicToken}`,
      label: "Cerrar",
    },
  }));
}

/** Non-terminal welfare reports → worklist items. dueAt = createdAt + the
 *  severity's own SLA tier (ms arithmetic, matching isSlaBreached exactly so
 *  this list and the maltrato queue can never disagree on "vencida"). */
export function mapWelfareRows(rows: WelfareWorklistRow[], now: Date): WorklistItem[] {
  return rows.map((r) => {
    const dueAt = new Date(r.createdAt.getTime() + slaDaysForSeverity(r.severity) * DAY_MS);
    return {
      key: `den:${r.id}`,
      domain: "denuncia" as const,
      subject: welfareReportKindLabel(r.kind),
      detail: welfareReportSeverityLabel(r.severity),
      code: r.referenceCode,
      province: r.jurisdictionProvince,
      locality: r.jurisdictionLocality,
      due: computeDueInfo(dueAt, now),
      action: {
        type: "welfare" as const,
        reportId: r.id,
        unassigned: r.assignedToUserId === null,
        href: `/gob/maltrato/${r.referenceCode}`,
      },
    };
  });
}

/** Open regulatory cases → worklist items. dueAt = openedAt +
 *  CASE_SLA_WARNING_DAYS. No row action exists for cases (the detail page
 *  owns every mutation) — an honest "Ver →", never an invented button. */
export function mapCaseRows(rows: CaseWorklistRow[], now: Date): WorklistItem[] {
  return rows.map((r) => ({
    key: `caso:${r.id}`,
    domain: "caso" as const,
    subject: caseKindLabel(r.caseKind),
    detail: r.primaryPetName,
    code: r.publicCode,
    province: r.jurisdictionProvince,
    locality: r.jurisdictionLocality,
    due: computeDueInfo(caseSlaDueAt(r.openedAt), now),
    action: { type: "link" as const, href: `/gob/casos/${r.publicCode}`, label: "Ver" },
  }));
}

// ---------------------------------------------------------------------------
// Merge + rank
// ---------------------------------------------------------------------------

/**
 * ONE flat list, ranked by deadline: overdue first (most overdue at the
 * top), then due-soon, then on-time — compareDueInfo owns the contract.
 * Deterministic tail tiebreak on `key` so equal deadlines render stably.
 */
export function buildWorklist(
  itemGroups: WorklistItem[][],
  limit: number = WORKLIST_RENDER_LIMIT,
): { items: WorklistItem[]; totalCount: number } {
  const all = itemGroups.flat();
  all.sort((a, b) => compareDueInfo(a.due, b.due) || a.key.localeCompare(b.key));
  return { items: all.slice(0, limit), totalCount: all.length };
}

/** The full load result the screen renders — defined HERE (pure module) so
 *  presentational components/tests never import the DB-reaching IO module. */
export type WorklistLoadResult = {
  items: WorklistItem[];
  /** Total matching items fetched across domains (before the render cap). */
  totalCount: number;
  counts: { observaciones: number; denuncias: number; casos: number };
  degraded: { observaciones: boolean; denuncias: boolean; casos: boolean };
};
