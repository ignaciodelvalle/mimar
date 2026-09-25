// "Mis denuncias" — the reporter's own welfare reports, for BOTH doors.
//
// WHY THIS IS A MODULE AND NOT A SECOND QUERY
// ---------------------------------------------------------------------------
// Both reads lived inline in `app/(app)/denuncias/mias/page.tsx` and
// `app/(app)/denuncias/[id]/page.tsx`. `GET /api/v1/me/welfare-reports` (M16)
// needs the same two answers, and a route handler with its own copy of "which
// denuncias are yours" and "what of a denuncia may its author read" is how the
// app would one day show a field the web withholds. Same carve-out WU-U made for
// `my-applications-read.ts`: the cookie door and the bearer door run the same
// steps, and the extraction is LITERAL — the web's predicate, the web's cap,
// the web's columns.
//
// THREE THINGS IN HERE ARE RULES, NOT PLUMBING, AND MUST SURVIVE ANY REWRITE:
//
//   · SCOPE IS `reporter_user_id = <verified caller>`, and nothing else. A
//     denuncia filed ANONYMOUSLY is written with `reporter_user_id = null`
//     (`actions.ts` and the v1 `commands.ts` both null it on that branch), so it
//     is structurally absent here — not filtered out, never linked. Anonymous
//     follow-up stays where it has always lived: the reference code plus the
//     e-mailed reporter token (`/denuncias/codigo/[code]`, `/denuncias/seguimiento`).
//     Nothing in this file may ever re-link one to an account.
//   · THE PROJECTION IS WHAT THE REPORTER TYPED PLUS THE PUBLIC STATUS. No
//     `resolution_notes`, no `flag_reasons`, no moderation or assignment
//     columns, no derivation org, no `seed_tag`, no reporter organisation. The
//     case's timeline is read for ONE entry type, `reporter_comment` — the
//     reporter's own comments. The authority's intervention notes are on the
//     same table and are exactly what this must never return.
//   · `pets.deleted_at IS NULL` on the subject pet. Art. 16 (Ley 25.326): the
//     reporter is a live third party to the subject pet's owner, so an ERASED
//     pet reads as never registered — no name, no token.
//     `__tests__/public-soft-delete-resolution.test.ts` pins this file by path.

import { and, desc, eq, isNull } from "drizzle-orm";

import { db, pets, welfareReportAttachments, welfareReports } from "@/db";
import { caseEvents, cases } from "@/db/schema";
import { keysetWhere } from "@/lib/utils/keyset-pagination";

/**
 * One page of the list. The web page has always read the newest 50 and no
 * more; the API pages past it with a cursor, the web keeps its single page.
 */
export const REPORTER_REPORTS_PAGE_SIZE = 50;

/** The list row: what the web's list draws, and nothing it does not. */
const LIST_SELECT = {
  id: welfareReports.id,
  referenceCode: welfareReports.referenceCode,
  kind: welfareReports.kind,
  severity: welfareReports.severity,
  status: welfareReports.status,
  description: welfareReports.description,
  createdAt: welfareReports.createdAt,
  jurisdictionProvince: welfareReports.jurisdictionProvince,
  jurisdictionLocality: welfareReports.jurisdictionLocality,
};

// `id` after `created_at` in the ORDER BY so the page is a function of the data:
// rows one transaction writes share `created_at` exactly, and a cursor over a
// non-unique key would skip or repeat them.
function listQuery(reporterUserId: string, cursor: ReporterReportCursor | null, limit: number) {
  return db
    .select(LIST_SELECT)
    .from(welfareReports)
    .where(
      and(
        eq(welfareReports.reporterUserId, reporterUserId),
        keysetWhere(welfareReports.createdAt, welfareReports.id, cursor),
      ),
    )
    .orderBy(desc(welfareReports.createdAt), desc(welfareReports.id))
    .limit(limit);
}

export type ReporterReportRow = Awaited<ReturnType<typeof listQuery>>[number];

/** A decoded keyset cursor over `(created_at, id)` — see `keyset-pagination.ts`. */
export type ReporterReportCursor = { ts: string; id: string };

export type ReporterReportList = {
  rows: ReporterReportRow[];
  /** Built from the last row THIS call returned; `null` at the end of the set. */
  nextCursor: ReporterReportCursor | null;
};

/**
 * The caller's own denuncias, newest first. Fetched `limit + 1` deep so a next
 * page is detected without a COUNT — the trick `listOwnerPets` uses.
 */
export async function listReporterWelfareReports(input: {
  reporterUserId: string;
  cursor?: ReporterReportCursor | null;
  limit?: number;
}): Promise<ReporterReportList> {
  const limit = input.limit ?? REPORTER_REPORTS_PAGE_SIZE;
  const rows = await listQuery(input.reporterUserId, input.cursor ?? null, limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: hasMore && last ? { ts: last.createdAt.toISOString(), id: last.id } : null,
  };
}

/** The detail columns — the web's detail page, column for column. */
const DETAIL_SELECT = {
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
  reporterContactEmail: welfareReports.reporterContactEmail,
  reporterContactPhone: welfareReports.reporterContactPhone,
  occurredAt: welfareReports.occurredAt,
  createdAt: welfareReports.createdAt,
  caseId: welfareReports.caseId,
};

export type ReporterReportDetail = {
  report: {
    id: string;
    referenceCode: string;
    kind: string;
    severity: string;
    status: string;
    description: string;
    subjectKind: string;
    subjectDescription: string | null;
    locationAddress: string | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
    locationLat: string | null;
    locationLng: string | null;
    reporterContactEmail: string | null;
    reporterContactPhone: string | null;
    occurredAt: Date | null;
    createdAt: Date;
    caseId: string | null;
  };
  /** `null` when there is none, or when it was erased (art. 16). */
  subjectPet: { publicToken: string; name: string } | null;
  /** Storage paths, not urls: each door signs them the way it serves them. */
  attachments: Array<{
    id: string;
    storagePath: string;
    mimeType: string;
    originalFilename: string | null;
  }>;
  /** The reporter's OWN comments on the case, newest first. Nothing else. */
  reporterComments: Array<{ id: string; notes: string | null; occurredAt: Date }>;
  casePublicCode: string | null;
};

/**
 * One denuncia, IF the caller filed it under their account. `null` for one
 * that does not exist, one somebody else filed and one filed anonymously —
 * three facts a caller must not be able to tell apart.
 */
export async function getReporterWelfareReport(input: {
  reporterUserId: string;
  lookup: { id: string } | { referenceCode: string };
}): Promise<ReporterReportDetail | null> {
  const key =
    "id" in input.lookup
      ? eq(welfareReports.id, input.lookup.id)
      : eq(welfareReports.referenceCode, input.lookup.referenceCode);

  const [row] = await db
    .select(DETAIL_SELECT)
    .from(welfareReports)
    .where(and(key, eq(welfareReports.reporterUserId, input.reporterUserId)))
    .limit(1);
  if (!row) return null;

  const { subjectPetId, ...report } = row;

  const [subjectPet, attachments, caseBits] = await Promise.all([
    subjectPetId
      ? db
          .select({ publicToken: pets.publicToken, name: pets.name })
          .from(pets)
          .where(and(eq(pets.id, subjectPetId), isNull(pets.deletedAt)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db
      .select({
        id: welfareReportAttachments.id,
        storagePath: welfareReportAttachments.storagePath,
        mimeType: welfareReportAttachments.mimeType,
        originalFilename: welfareReportAttachments.originalFilename,
      })
      .from(welfareReportAttachments)
      .where(eq(welfareReportAttachments.welfareReportId, report.id)),
    report.caseId ? readCaseBits(report.caseId) : Promise.resolve(null),
  ]);

  return {
    report,
    subjectPet,
    attachments,
    reporterComments: caseBits?.reporterComments ?? [],
    casePublicCode: caseBits?.publicCode ?? null,
  };
}

async function readCaseBits(caseId: string) {
  const [caseRow, reporterComments] = await Promise.all([
    db
      .select({ publicCode: cases.publicCode })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: caseEvents.id, notes: caseEvents.notes, occurredAt: caseEvents.occurredAt })
      .from(caseEvents)
      .where(and(eq(caseEvents.caseId, caseId), eq(caseEvents.entryType, "reporter_comment")))
      .orderBy(desc(caseEvents.occurredAt)),
  ]);
  return { publicCode: caseRow?.publicCode ?? null, reporterComments };
}
