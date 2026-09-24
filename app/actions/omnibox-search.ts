"use server";

// omnibox-search.ts — thin shim (strangler 52/61, 2026-06-30).
//
// Business logic moved to:
//   src/modules/search/application/omnibox/
//
// Auth guards lifted into these wrappers so the shim satisfies the
// authz-coverage convention; the use-cases receive the pre-authenticated
// session and no longer call the guards themselves.

import { requireAdminOrGovtOrRedirect, requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import type { OmniboxResults } from "@/lib/infra/omnibox-search";
import { searchOmnibox } from "@/src/modules/search/application/omnibox/search-omnibox";
import { searchOmniboxOrg } from "@/src/modules/search/application/omnibox/search-omnibox-org";

export type { OmniboxResults } from "@/lib/infra/omnibox-search";

export async function searchOmniboxAction(query: string): Promise<OmniboxResults> {
  const session = await requireAdminOrGovtOrRedirect();
  return searchOmnibox(session, query);
}

export async function searchOmniboxOrgAction(
  orgToken: string,
  query: string,
): Promise<OmniboxResults> {
  const session = await requireOrgAccessByToken(orgToken);
  return searchOmniboxOrg(session, query);
}
