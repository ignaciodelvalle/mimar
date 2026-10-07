// The public directory's visibility rule as SQL, and its one read.
//
// `publicDirectoryVisible()` is the WHERE clause every public directory
// surface shares — the list at /refugios, the profile at /refugios/[orgToken]
// (lib/infra/org-public-profile.ts) and the sitemap (app/sitemap.ts). Before
// 0283 each of the three spelled `verified AND org_type IN (shelter,
// rescue_network)` on its own; a fourth copy for clinics would have been the
// one that drifted. The rule in words, and its pure twin, is
// src/modules/organizations/domain/public-directory.ts.
//
// Reads go through Drizzle (BYPASSRLS), like every public org read: RLS does
// not decide what this directory shows — this predicate does.

import { and, asc, eq, inArray, or } from "drizzle-orm";

import { db, organizations } from "@/db";
import { REHOMING_ORG_TYPES } from "@/src/modules/organizations/domain/org-type";
import { PUBLIC_DIRECTORY_OPT_IN_ORG_TYPES } from "@/src/modules/organizations/domain/public-directory";

type OrgType = (typeof organizations.orgType.enumValues)[number];

const REHOMING = [...REHOMING_ORG_TYPES] as OrgType[];
const OPT_IN = [...PUBLIC_DIRECTORY_OPT_IN_ORG_TYPES] as OrgType[];

/** Verified, active, and either a rehoming org or an opted-in clinic. */
export function publicDirectoryVisible() {
  return and(
    eq(organizations.verified, true),
    // A suspended or dissolved org leaves every public surface at once.
    eq(organizations.status, "active"),
    or(
      inArray(organizations.orgType, REHOMING),
      and(inArray(organizations.orgType, OPT_IN), eq(organizations.publicDirectoryOptIn, true)),
    ),
  );
}

/** Upper bound on one directory read; the page groups and filters in memory. */
export const PUBLIC_DIRECTORY_LIMIT = 1000;

/**
 * One directory row. Public-safe fields only: the name, the type and the
 * jurisdiction. Contact details live on the profile page, behind its own
 * per-IP throttle — the list never carries an email or a phone.
 */
export type PublicDirectoryRow = {
  publicToken: string;
  displayName: string;
  orgType: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

export async function queryPublicDirectory(): Promise<PublicDirectoryRow[]> {
  return db
    .select({
      publicToken: organizations.publicToken,
      displayName: organizations.displayName,
      orgType: organizations.orgType,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
    })
    .from(organizations)
    .where(publicDirectoryVisible())
    .orderBy(asc(organizations.jurisdictionProvince), asc(organizations.displayName))
    .limit(PUBLIC_DIRECTORY_LIMIT);
}
