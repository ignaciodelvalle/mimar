// `MyWelfareReportsV1` and `MyWelfareReportDetailV1`, built from what the
// web's own reader already decided.
//
// THIS FILE DECIDES NOTHING ABOUT ACCESS. Which denuncias are the caller's, and
// which columns of one its author may read, is `reporter-reports-read.ts` — the
// reader `/denuncias/mias` and `/denuncias/{id}` render from. What is left here
// is serialisation in the web's own words: the same labels, the same 150-char
// excerpt, the same "Localidad, Provincia" line, the same status banner.
//
// The row's uuid never crosses this boundary: the list is keyed by reference
// code, which the author already holds on their receipt.

import { apiV1Envelope } from "@/lib/infra/api-v1";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { encodeCursor } from "@/lib/utils/keyset-pagination";
import {
  welfareReportKindLabel,
  welfareReportReporterNotice,
  welfareReportSeverityCitizenLabel,
  welfareReportStatusLabel,
  welfareReportSubjectKindLabel,
} from "@/src/modules/welfare/domain/types";
import type {
  ReporterReportDetail,
  ReporterReportList,
} from "@/src/modules/welfare/infrastructure/reporter-reports-read";
import {
  MY_WELFARE_REPORTS_PAYLOAD_VERSION,
  MY_WELFARE_REPORTS_STALE_AFTER_MS,
  MY_WELFARE_REPORT_DETAIL_PAYLOAD_VERSION,
  type MyWelfareReportDetailV1,
  type MyWelfareReportStatusV1,
  type MyWelfareReportsV1,
} from "@dim/contract/api";
import { deepLinkUrl } from "@dim/contract/links";

import { appRouteForWebPath } from "../cases/payload";

/** The web list's excerpt rule, character for character. */
const EXCERPT_CHARS = 150;

function excerptOf(description: string): string {
  return description.length > EXCERPT_CHARS
    ? `${description.slice(0, EXCERPT_CHARS)}…`
    : description;
}

/** The web's "Localidad, Provincia" join; `null` when both are empty. */
function placeLine(locality: string | null, province: string | null): string | null {
  const line = [locality, province].filter(Boolean).join(", ");
  return line === "" ? null : line;
}

function pointOf(lat: string | null, lng: string | null): { lat: number; lng: number } | null {
  if (lat === null || lng === null) return null;
  const la = Number(lat);
  const ln = Number(lng);
  return Number.isFinite(la) && Number.isFinite(ln) ? { lat: la, lng: ln } : null;
}

export function buildMyWelfareReportsV1(input: {
  list: ReporterReportList;
  now: Date;
}): MyWelfareReportsV1 {
  return {
    ...apiV1Envelope({
      payloadVersion: MY_WELFARE_REPORTS_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: MY_WELFARE_REPORTS_STALE_AFTER_MS,
    }),
    reports: input.list.rows.map((row) => ({
      referenceCode: row.referenceCode,
      kindLabel: welfareReportKindLabel(row.kind),
      severityLabel: welfareReportSeverityCitizenLabel(row.severity),
      status: row.status as MyWelfareReportStatusV1,
      statusLabel: welfareReportStatusLabel(row.status),
      excerpt: excerptOf(row.description),
      filedAt: row.createdAt.toISOString(),
      place: placeLine(row.jurisdictionLocality, row.jurisdictionProvince),
    })),
    nextCursor: input.list.nextCursor
      ? encodeCursor(input.list.nextCursor.ts, input.list.nextCursor.id)
      : null,
  };
}

export function buildMyWelfareReportDetailV1(input: {
  detail: ReporterReportDetail;
  evidence: Array<{ mimeType: string; filename: string | null; url: string | null }>;
  now: Date;
}): MyWelfareReportDetailV1 {
  const { report, subjectPet, reporterComments, casePublicCode } = input.detail;
  const jurisdiction = placeLine(report.jurisdictionLocality, report.jurisdictionProvince);
  const point = pointOf(report.locationLat, report.locationLng);
  const hasPlace = report.locationAddress !== null || jurisdiction !== null || point !== null;
  const hasContact = Boolean(report.reporterContactEmail || report.reporterContactPhone);

  return {
    ...apiV1Envelope({
      payloadVersion: MY_WELFARE_REPORT_DETAIL_PAYLOAD_VERSION,
      issuedAt: input.now,
      staleAfterMs: MY_WELFARE_REPORTS_STALE_AFTER_MS,
    }),
    referenceCode: report.referenceCode,
    kindLabel: welfareReportKindLabel(report.kind),
    severity: report.severity,
    severityLabel: welfareReportSeverityCitizenLabel(report.severity),
    status: report.status as MyWelfareReportStatusV1,
    statusLabel: welfareReportStatusLabel(report.status),
    notice: welfareReportReporterNotice(report.status),
    filedAt: report.createdAt.toISOString(),
    occurredAt: report.occurredAt === null ? null : report.occurredAt.toISOString(),
    description: report.description,
    subject: {
      label: welfareReportSubjectKindLabel(report.subjectKind),
      // The web links the pet only for a registered-pet subject.
      pet: report.subjectKind === "registered_pet" && subjectPet ? subjectPet : null,
      description: report.subjectDescription,
    },
    place: hasPlace ? { address: report.locationAddress, jurisdiction, point } : null,
    contact: hasContact
      ? { email: report.reporterContactEmail, phone: report.reporterContactPhone }
      : null,
    evidence: input.evidence.flatMap((a) =>
      a.url === null
        ? []
        : [
            {
              kind: a.mimeType.startsWith("video/") ? ("video" as const) : ("image" as const),
              url: a.url,
              filename: a.filename,
            },
          ],
    ),
    comments: reporterComments.flatMap((c) =>
      c.notes === null ? [] : [{ text: c.notes, at: c.occurredAt.toISOString() }],
    ),
    case:
      casePublicCode === null
        ? null
        : { publicCode: casePublicCode, route: appRouteForWebPath(`/casos/${casePublicCode}`) },
    constanciaUrl: deepLinkUrl(resolveSiteUrl(), "welfareReport", {
      referenceCode: report.referenceCode,
    }),
  };
}
