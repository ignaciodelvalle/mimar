// Consolidated query for the public refugio profile (handoff P2-1).
//
// Replaces ad-hoc inline selects in app/refugios/[orgToken]/page.tsx with
// a single typed projection. The shape matches the contract specified in
// the handoff: every panel (P2-2 hero, P2-3 about, P2-6 location, P2-7
// donations, P2-11 admin banner) receives this object and decides
// whether to render based on which optional fields are set.
//
// Visibility gate is enforced here — the query returns null for orgs
// that are not (verified AND orgType in shelter/rescue_network). Caller
// passes the null straight to notFound().

import { and, eq, inArray } from "drizzle-orm";

import { db, organizations, profiles } from "@/db";

export type DonationMethods = {
  cbu?: string;
  cvu?: string;
  alias?: string;
  mpLink?: string;
  btcAddress?: string;
};

export type OrgPublicProfile = {
  /** Internal UUID — never rendered, only used server-side to join other
   * queries (memberships, offerings). Not PII; serializing it client-side
   * is fine but unnecessary. */
  id: string;
  publicToken: string;
  displayName: string;
  legalName: string | null;
  description: string | null;
  logoStoragePath: string | null;
  orgType: "shelter" | "rescue_network";
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
  verifiedBy: { displayName: string } | null;
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
      verifiedByDisplayName: profiles.displayName,
      donationMethods: organizations.donationMethods,
    })
    .from(organizations)
    .leftJoin(profiles, eq(profiles.id, organizations.verifiedByUserId))
    .where(
      and(
        eq(organizations.publicToken, orgToken),
        eq(organizations.verified, true),
        inArray(organizations.orgType, ["shelter", "rescue_network"]),
      ),
    )
    .limit(1);

  if (!row) return null;

  // disclose_address acts as the gate for everything address-derived.
  // When false, the LocationPanel doesn't render — see handoff P2-6.
  const showAddress = row.discloseAddress;

  return {
    id: row.id,
    publicToken: row.publicToken,
    displayName: row.displayName,
    legalName: row.legalName,
    description: row.description,
    logoStoragePath: row.logoStoragePath,
    orgType: row.orgType as "shelter" | "rescue_network",
    jurisdictionProvince: row.jurisdictionProvince,
    jurisdictionLocality: row.jurisdictionLocality,
    jurisdictionAddress: null, // no structured-address column on orgs today
    latitude: showAddress && row.latitude != null ? Number(row.latitude) : null,
    longitude: showAddress && row.longitude != null ? Number(row.longitude) : null,
    email: row.email,
    phone: row.phone,
    website: row.website,
    verifiedAt: row.verifiedAt,
    verifiedBy: row.verifiedByDisplayName ? { displayName: row.verifiedByDisplayName } : null,
    donationMethods: row.donationMethods as DonationMethods | null,
  };
}
