// Consolidated query for the public refugio profile (handoff P2-1).
//
// Replaces ad-hoc inline selects in app/refugios/[orgToken]/page.tsx with
// a single typed projection. The shape matches the contract specified in
// the handoff: every panel (P2-2 hero, P2-3 about, P2-6 location, P2-7
// donations, P2-11 admin banner) receives this object and decides
// whether to render based on which optional fields are set.
//
// Visibility gate is enforced here — the query returns null for orgs
// the public directory does not list: verified shelters and rescue networks,
// plus verified clinics that opted in (migration 0283). The rule is shared
// with the directory and the sitemap through publicDirectoryVisible().
// Caller passes the null straight to notFound().
//
// PUBLIC FIELDS ONLY, decided HERE so no panel can leak what it never got:
//   - no PERSON. The verifier used to be joined from profiles.display_name —
//     a staff member's own name, served to anonymous visitors. The profile
//     now says HOW the org was verified (verifiedVia), never by whom.
//   - a clinic's legal name is withheld: for a solo-vet clinic it is the
//     vet's own full name, and the org's directory consent lists the display
//     name, not the razón social.
//   - a clinic never gets coordinates. disclose_address defaults to true and
//     no form lets a clinic set it, so a true there is a default, not a
//     choice; the profile shows the locality only. (Shelters keep the rule
//     they had: disclose_address gates the pin.)

import { and, eq } from "drizzle-orm";

import { db, organizations } from "@/db";
import { publicDirectoryVisible } from "@/lib/infra/org-directory";
import type { PublicVerificationPath } from "@/src/modules/organizations/domain/public-directory";

export type DonationMethods = {
  cbu?: string;
  cvu?: string;
  alias?: string;
  mpLink?: string;
  btcAddress?: string;
};

/** The org types a public profile can belong to (see publicDirectoryVisible). */
export type PublicProfileOrgType = "shelter" | "rescue_network" | "clinic";

export type OrgPublicProfile = {
  /** Internal UUID — never rendered, only used server-side to join other
   * queries (memberships, offerings). Not PII; serializing it client-side
   * is fine but unnecessary. */
  id: string;
  publicToken: string;
  displayName: string;
  /** Null for a clinic, whatever is stored (see the header). */
  legalName: string | null;
  description: string | null;
  logoStoragePath: string | null;
  orgType: PublicProfileOrgType;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  /** True jurisdictional address — null when disclose_address is false
   * (rescue networks operating from private homes). Per spec we never
   * surface free-text address columns directly on /refugios; this is the
   * P1-1 model where the only structured address is lat/lng + locality. */
  jurisdictionAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  verifiedAt: Date | null;
  verifiedVia: PublicVerificationPath;
  donationMethods: DonationMethods | null;
};

export async function queryOrgPublicProfile(orgToken: string): Promise<OrgPublicProfile | null> {
  const [row] = await db
    .select({
      id: organizations.id,
      publicToken: organizations.publicToken,
      displayName: organizations.displayName,
      legalName: organizations.legalName,
      description: organizations.description,
      logoStoragePath: organizations.logoStoragePath,
      orgType: organizations.orgType,
      verified: organizations.verified,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
      discloseAddress: organizations.discloseAddress,
      // Canonical columns only (P3 Phase B). Output keys kept as latitude/longitude —
      // public consumer-facing DTO shape consumed by /refugios/[orgToken]/* is unchanged.
      latitude: organizations.locationLat,
      longitude: organizations.locationLng,
      email: organizations.email,
      phone: organizations.phone,
      website: organizations.website,
      verifiedAt: organizations.verifiedAt,
      autoVerifiedViaMatricula: organizations.autoVerifiedViaMatricula,
      donationMethods: organizations.donationMethods,
    })
    .from(organizations)
    .where(and(eq(organizations.publicToken, orgToken), publicDirectoryVisible()))
    .limit(1);

  if (!row) return null;

  // disclose_address acts as the gate for everything address-derived.
  // When false, the LocationPanel doesn't render — see handoff P2-6. A clinic
  // never chose it (see the header), so it never shows a pin.
  const isClinic = row.orgType === "clinic";
  const showAddress = row.discloseAddress && !isClinic;

  return {
    id: row.id,
    publicToken: row.publicToken,
    displayName: row.displayName,
    legalName: isClinic ? null : row.legalName,
    description: row.description,
    logoStoragePath: row.logoStoragePath,
    orgType: row.orgType as PublicProfileOrgType,
    jurisdictionProvince: row.jurisdictionProvince,
    jurisdictionLocality: row.jurisdictionLocality,
    jurisdictionAddress: null, // no structured-address column on orgs today
    latitude: showAddress && row.latitude != null ? Number(row.latitude) : null,
    longitude: showAddress && row.longitude != null ? Number(row.longitude) : null,
    email: row.email,
    phone: row.phone,
    website: row.website,
    verifiedAt: row.verifiedAt,
    verifiedVia: row.autoVerifiedViaMatricula ? "matricula" : "mimar_team",
    donationMethods: row.donationMethods as DonationMethods | null,
  };
}
