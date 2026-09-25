// The two reads behind `/api/v1/me/welfare-reports`, each under a DB budget.
//
// NO LOADER OF ITS OWN. Both run the reader `/denuncias/mias` and
// `/denuncias/{id}` render from (`reporter-reports-read.ts`), keyed on the
// verified caller's id and nothing from the request. A change to what an author
// may read about their own denuncia is made there and reaches both surfaces.

import { apiV1Error } from "@/lib/infra/api-v1";
import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { welfareAttachmentSignedUrl } from "@/lib/infra/storage";
import {
  type ReporterReportCursor,
  getReporterWelfareReport,
  listReporterWelfareReports,
} from "@/src/modules/welfare/infrastructure/reporter-reports-read";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * One indexed page read for the list; for the detail, the report plus three
 * small reads in parallel and one signing round-trip per attachment. The same
 * eight seconds the casos take — short enough that a degraded pooler yields a
 * 503 a client can retry rather than a spinner it cannot.
 */
const READ_BUDGET_MS = 8_000;

/** The 503 this endpoint answers for every degraded read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export function readReports(reporterUserId: string, cursor: ReporterReportCursor | null) {
  return withDbBudgetOrThrow(
    listReporterWelfareReports({ reporterUserId, cursor }),
    READ_BUDGET_MS,
    "api-v1-me-welfare-reports-read",
  );
}

/**
 * One denuncia by its reference code, only if the caller filed it under their
 * account — `null` otherwise, and the route answers that `null` as a 404. The
 * evidence is signed here, the way the web page signs it; an attachment whose
 * url could not be minted is dropped, as the web draws nothing for it.
 */
export function readReport(reporterUserId: string, referenceCode: string) {
  return withDbBudgetOrThrow(
    (async () => {
      const detail = await getReporterWelfareReport({
        reporterUserId,
        lookup: { referenceCode },
      });
      if (!detail) return null;
      const signed = await Promise.all(
        detail.attachments.map(async (a) => ({
          mimeType: a.mimeType,
          filename: a.originalFilename,
          url: await welfareAttachmentSignedUrl(a.storagePath),
        })),
      );
      return { detail, evidence: signed };
    })(),
    READ_BUDGET_MS,
    "api-v1-me-welfare-report-detail-read",
  );
}
