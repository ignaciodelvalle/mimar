// Turning `export_subject_data`'s JSON into something a person can read on a
// phone — and the one place in this app that is allowed to look inside it.
//
// WHY A SEPARATE MODULE AND NOT SIX LINES IN THE SCREEN
// ---------------------------------------------------------------------------
// The same reason `AccountDeletionCard` is a component: this is logic over the
// shape of a legal deliverable, and logic gets a test. It is also the only code
// in the app that reads the export at all, so if it is wrong the failure is
// "the person is told their file holds three pets when it holds none" — a lie
// about a Ley 25.326 art. 14 response, delivered in a friendly card.
//
// LABELS NOW COME FROM THE SHARED CONTRACT (PO decision 13A, 2026-09-23)
// ---------------------------------------------------------------------------
// This module used to have NO list of expected sections and no friendly-names
// table on principle — it "never spoke for the file", showing the RPC's own
// snake_case key lightly unshouted ("operator_feed_watermarks" →
// "Operator feed watermarks"). That satisfied art. 14 to the letter but failed
// the screen's own promise ("te mostramos todo lo que guardamos") for a citizen
// who has never heard the word "watermark".
//
// `@dim/contract/reference`'s `subjectRightsSections` now owns the label table
// and the hide rules — full rationale (which sections get plain Spanish
// labels, which are hidden as pure bookkeeping, and why an unrecognised key
// still shows up rather than vanishing) lives in that module's own header.
// This file re-exports it under the names every existing caller already uses,
// so `PrivacyScreen.tsx` and its test did not have to change their imports.
export {
  type SubjectRightsSection as ExportSection,
  subjectRightsSections as exportSections,
} from "@dim/contract/reference";

/**
 * The bytes that leave through the OS share sheet.
 *
 * THE FILE ITSELF, PRETTY-PRINTED, AND NOTHING ELSE ADDED. `PrivacyActions.tsx`
 * hands the browser `JSON.stringify(result.data, null, 2)` and this is the same
 * two arguments, so a person who exports from both surfaces gets the same
 * document rather than two dialects of it.
 *
 * WHAT IS DELIBERATELY NOT PREPENDED: a header line, a date, a "generado por
 * miMAR". They would make the payload no longer be valid JSON, which turns a
 * file another system can read into a message only a human can — and the point
 * of art. 14 is portability, not a printout. The envelope's `issuedAt` is
 * already inside the app if a screen ever needs to say when it was minted.
 *
 * DELIBERATELY UNAFFECTED BY PO decision 13A: the readable summary above may
 * hide a bookkeeping section or relabel one, but the shared bytes here are
 * the RPC's own output, complete and untouched — legal completeness lives in
 * this function, not in the labels.
 */
export function exportShareText(view: { subject: Record<string, unknown> }): string {
  return JSON.stringify(view.subject, null, 2);
}
