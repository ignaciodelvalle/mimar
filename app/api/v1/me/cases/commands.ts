// The two reads behind `/api/v1/me/cases`, each under a DB budget.
//
// NO LOADER OF ITS OWN. The list runs `fetchOpenWorkflows` and
// `fetchPreviousWorkflows` — the exact calls `/mis-mascotas` makes, keyed on the
// verified caller's id and nothing from the request. The detail runs
// `readCaseForViewer`, the same function `components/casos/CaseDetailView.tsx`
// runs, with the viewer built by the same `caseViewerFromProfile`. A change to
// who sees which case is therefore made in one place and reaches both surfaces.

import { fetchOpenWorkflows, fetchPreviousWorkflows } from "@/lib/analytics/owner-dashboard";
import { apiV1Error } from "@/lib/infra/api-v1";
import { caseViewerFromProfile, readCaseForViewer } from "@/lib/infra/case-read";
import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import type { CachedProfile } from "@/lib/infra/request-cache";
import { MY_CASES_HISTORY_LIMIT } from "@dim/contract/api";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Eleven concurrent queries for the list (seven open-cycle sources, four
 * history sources) and a multi-join case read for the detail — the same eight
 * seconds the libreta and the inbox take. Short enough that a degraded pooler
 * yields a 503 a client can retry rather than a spinner it cannot.
 */
const READ_BUDGET_MS = 8_000;

/** The 503 this endpoint answers for every degraded read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * Open cycles plus the most recent closed ones. History asks for ONE MORE row
 * than it shows, so `hasMore` is a fact rather than a guess; the web asks for
 * exactly the limit because it has no "more" to offer.
 */
export async function readCases(userId: string) {
  const [open, previous] = await withDbBudgetOrThrow(
    Promise.all([
      fetchOpenWorkflows(userId),
      fetchPreviousWorkflows(userId, MY_CASES_HISTORY_LIMIT + 1),
    ]),
    READ_BUDGET_MS,
    "api-v1-me-cases-read",
  );
  return { open, previous };
}

/**
 * One case, as `readCaseForViewer` decides it for this caller.
 *
 * A caller WITHOUT a profile row (the mid-signup window) is refused here as
 * `not_found` rather than passed on as anonymous. The web would render the
 * redacted public view for that caller; this endpoint has no redacted view to
 * render (see the contract), and narrowing is the safe direction.
 */
export async function readCase(args: {
  publicCode: string;
  profile: Pick<CachedProfile, "id" | "role"> | null;
}) {
  const { profile, publicCode } = args;
  if (!profile) return { kind: "not_found" as const };
  return withDbBudgetOrThrow(
    (async () => readCaseForViewer(publicCode, await caseViewerFromProfile(profile)))(),
    READ_BUDGET_MS,
    "api-v1-me-case-detail-read",
  );
}
