// searchOmniboxOrg use-case (strangler 52/61, 2026-06-30).
// Auth guard lifted to the shim wrapper; this function receives the
// pre-authenticated session and no longer calls requireOrgAccessByToken.
// orgToken is read from session.organization.publicToken.

import type { OrgAccessSession } from "@/lib/infra/auth-guards";
import { type OmniboxResults, searchOmnibox } from "@/lib/infra/omnibox-search";
import { logPiiQueryForAuthority } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

// Minimum query length before we touch the DB or log a PII read. A single
// character is too broad to be a meaningful lookup and would log noise.
const MIN_QUERY_LENGTH = 2;

const EMPTY: OmniboxResults = { pets: [], persons: [], cases: [], total: 0 };

export async function searchOmniboxOrg(
  session: OrgAccessSession,
  query: string,
): Promise<OmniboxResults> {
  const { user, organization, membership } = session;

  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return EMPTY;

  // Capability gate — same canRead check the mascotas page uses.
  const granted = await getGrantedCapabilities(membership);
  if (!(granted.has("pet.read_held") || membership.role === "admin")) return EMPTY;

  const results = await searchOmnibox(trimmed, {
    role: "org",
    organizationId: organization.id,
    orgToken: organization.publicToken,
  });

  await logPiiQueryForAuthority(user.id, trimmed, results.total, "omnibox");

  return results;
}
