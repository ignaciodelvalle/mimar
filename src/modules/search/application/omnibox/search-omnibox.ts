// searchOmnibox use-case (strangler 52/61, 2026-06-30).
// Auth guard lifted to the shim wrapper; this function receives the
// pre-authenticated session and no longer calls requireAdminOrGovtOrRedirect.

import type { AdminOrGovtSession } from "@/lib/infra/auth-guards";
import { type OmniboxResults, searchOmnibox as runSearch } from "@/lib/infra/omnibox-search";
import { logPiiQueryForAuthority } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

// Minimum query length before we touch the DB or log a PII read. A single
// character is too broad to be a meaningful lookup and would log noise.
const MIN_QUERY_LENGTH = 2;

const EMPTY: OmniboxResults = { pets: [], persons: [], cases: [], total: 0 };

export async function searchOmnibox(
  session: AdminOrGovtSession,
  query: string,
): Promise<OmniboxResults> {
  const { user, profile, jurisdictions } = session;

  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return EMPTY;

  const results = await runSearch(
    trimmed,
    profile.role === "admin" ? { role: "admin" } : { role: "govt", jurisdictions },
  );

  // PII-query trail — same pattern as /gob/usuarios. Awaited: under Ley 25.326
  // the access audit must be durable. Fire-and-forget loses the insert if the
  // serverless function is frozen/killed after the response, leaving an
  // unlogged PII access.
  await logPiiQueryForAuthority(user.id, trimmed, results.total, "omnibox");

  return results;
}
