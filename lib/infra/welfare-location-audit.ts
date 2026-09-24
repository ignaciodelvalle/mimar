import { auditLog, db } from "@/db";

// Audience-precision plan (2026-06-19): authority surfaces (/gob/maltrato/[id],
// /admin/moderacion/[id]) render the EXACT welfare-report coordinate because the
// investigative/decomiso function needs it (Ley 14.346 — maltrato). Ley 25.326
// (accountability / minimisation) requires that exact-PII access leave a trail.
//
// Mirrors the PII-query logging pattern in app/actions/admin-proposals.ts:
// a single audit_log row, action string + free-form JSONB payload, no schema
// column needed (audit_log.action is TEXT, not a DB enum).
//
// Best-effort by contract: the access trail is defense-in-depth, NOT an access
// gate. A failed insert must never 500 the authority page and lock a legitimate
// officer out of a report they're authorised to see. Callers await this for
// durability on the happy path; on failure it swallows the error (logging it to
// the server console) so render proceeds.
export async function logWelfareLocationViewed(
  actorUserId: string,
  welfareReportId: string,
  referenceCode: string,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorUserId,
      action: "welfare_location_viewed",
      payload: { welfare_report_id: welfareReportId, reference_code: referenceCode },
    });
  } catch (error) {
    console.error(
      `[welfare-location-audit] failed to log view of welfare report ${welfareReportId}:`,
      error,
    );
  }
}
