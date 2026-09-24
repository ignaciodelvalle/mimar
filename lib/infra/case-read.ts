// `readCaseForViewer` — THE one answer to "may this viewer read this case, and
// which of its entries?", shared by the web case page and `/api/v1/me/cases`.
//
// WHY IT WAS LIFTED OUT OF CaseDetailView
// ---------------------------------------------------------------------------
// The web page (`components/casos/CaseDetailView.tsx`) resolved a viewer,
// called `canReadCase`, told a caretaker apart from a stranger, logged an
// authority's PII read and filtered dispute tips — inline, in a React server
// component. The native app now reads the same case over `/api/v1`, and a
// route handler that re-derived even one of those five steps would be a second
// authorization path for the same document: the kind that agrees on the day it
// is written and drifts on the first change to one of them. Both callers now
// run THIS function, so a change to who reads a case is made once.
//
// WHAT IT DOES NOT DECIDE: presentation. The anonymous redaction (pet name,
// personal party names, notes) stays with the caller that renders it, because
// only the web has an anonymous branch — the API requires a session.

import { type CaseViewer, canReadCase, holdsActiveCaretakerRow } from "@/lib/infra/case-access";
import {
  type CaseDetail,
  type CaseEventRow,
  getCaseDetailByPublicCode,
} from "@/lib/infra/case-queries";
import { type CachedProfile, getJurisdictionsCached } from "@/lib/infra/request-cache";
import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

/**
 * The `CaseViewer` for a resolved profile, or `null` for "no profile" — which
 * `canReadCase` treats as anonymous. The web passes `getProfileCached(user.id)`
 * from the cookie session; the API passes `requireLiveUser`'s already-resolved
 * profile. Same shape in, same viewer out: a govt reader carries its
 * jurisdictions, every other role an empty list.
 */
export async function caseViewerFromProfile(
  profile: Pick<CachedProfile, "id" | "role"> | null,
): Promise<CaseViewer | null> {
  if (!profile) return null;
  const jurisdictions = profile.role === "govt" ? await getJurisdictionsCached(profile.id) : [];
  return { userId: profile.id, role: profile.role, jurisdictions };
}

export type CaseReadOutcome =
  /** No such case, or one this viewer may not learn exists. Always a 404. */
  | { kind: "not_found" }
  /**
   * Denied, and the viewer holds a LIVE caretaker row on the case's pet — the
   * one denial that must not read as "does not exist" (custodia-temporal
   * T9.11/T9.12, see `holdsActiveCaretakerRow`). Carries only what the
   * caretaker already knows: the pet they are looking after.
   */
  | { kind: "caretaker_only"; pet: { publicToken: string; name: string } | null }
  | {
      kind: "readable";
      detail: CaseDetail;
      viewer: CaseViewer | null;
      /** govt/admin — the only viewers who see dispute tips and the case map. */
      isAuthorityViewer: boolean;
      /** `detail.events` with the authority-only entries removed for everyone else. */
      timelineEvents: CaseEventRow[];
    };

export async function readCaseForViewer(
  publicCode: string,
  viewer: CaseViewer | null,
): Promise<CaseReadOutcome> {
  const detail = await getCaseDetailByPublicCode(publicCode);
  if (!detail) return { kind: "not_found" };

  const allowed = await canReadCase(detail, viewer);
  if (!allowed) {
    // Cases are titular-only in v1 (design F2), but a CARETAKER sees the case
    // links on the pet they look after. Case existence still never leaks: this
    // branch requires a live caretaker ownership row on THIS pet.
    if (await holdsActiveCaretakerRow(detail.pet?.id, viewer?.userId ?? null)) {
      return {
        kind: "caretaker_only",
        pet: detail.pet ? { publicToken: detail.pet.publicToken, name: detail.pet.name } : null,
      };
    }
    return { kind: "not_found" };
  }

  const isAuthorityViewer = viewer?.role === "govt" || viewer?.role === "admin";

  // Lote B3 — an AUTHORITY reading a case detail is a PII read and leaves a
  // pii_queried trail. Never for owners: self-views are not logged. Fail-soft.
  if (isAuthorityViewer && viewer) {
    await logPiiReadSafely(viewer.userId, publicCode, 1, "case_detail");
  }

  // Dispute-safe finder tips (PO 2026-07-24): a "finder_tip" entry is written
  // for the reviewing authority ONLY. The disputing parties pass canReadCase
  // for the case, so the filter lives here: everyone else must not even learn
  // a tip exists.
  const timelineEvents = detail.events.filter(
    (e) => e.eventType !== "finder_tip" || isAuthorityViewer,
  );

  return { kind: "readable", detail, viewer, isAuthorityViewer, timelineEvents };
}
