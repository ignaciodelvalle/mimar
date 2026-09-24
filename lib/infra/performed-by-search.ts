// Performed_by autocomplete helper (spec
// 2026-05-19-performed-by-autocomplete-design).
//
// Returns a unified ranked list of suggestions for who performed a
// clinical action: verified organizations (clinic / sanitary_authority
// / rescue_network / shelter) AND verified vet profiles (role='vet'
// AND matriculaVerified=true). Each suggestion carries a discriminator
// so the UI can render the right label.
//
// Ranking (PB6 + PB7):
//   - Start-match on display_name gets the biggest boost.
//   - Locality match (when context is provided) boosts further.
//   - Province match (when context is provided) boosts less than locality.
//   - All other matches still appear — jurisdiction is "priority but
//     not filter" (PB7), because real cross-jurisdiction visits exist.

import { and, eq, inArray, sql } from "drizzle-orm";

import { db, organizations, profiles } from "@/db";
import { likeContains } from "@/lib/utils/like-helpers";

export type PerformedBySuggestion =
  | {
      kind: "organization";
      id: string;
      displayName: string;
      orgType: string;
      jurisdictionProvince: string | null;
      jurisdictionLocality: string | null;
      verified: boolean;
    }
  | {
      kind: "profile";
      id: string;
      displayName: string;
      matriculaVerified: boolean;
      matriculaJurisdiccion: string | null;
    };

export interface SearchJurisdiction {
  province?: string | null;
  locality?: string | null;
}

const MIN_QUERY_LEN = 2;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

const ELIGIBLE_ORG_TYPES = ["clinic", "sanitary_authority", "rescue_network", "shelter"] as const;

export async function searchVetsAndClinics(
  query: string,
  jurisdiction?: SearchJurisdiction,
  limit: number = DEFAULT_LIMIT,
): Promise<PerformedBySuggestion[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LEN) return [];
  const cap = Math.min(limit, MAX_LIMIT);
  const pattern = likeContains(q);

  const [orgRows, profileRows] = await Promise.all([
    db
      .select({
        id: organizations.id,
        displayName: organizations.displayName,
        orgType: organizations.orgType,
        jurisdictionLocality: organizations.jurisdictionLocality,
        jurisdictionProvince: organizations.jurisdictionProvince,
        verified: organizations.verified,
        status: organizations.status,
      })
      .from(organizations)
      .where(
        and(
          eq(organizations.verified, true),
          inArray(organizations.orgType, [...ELIGIBLE_ORG_TYPES]),
          // unaccent() on both sides: "gonzalez" finds "González".
          // likeContains() escapes % and _ to prevent wildcard injection.
          sql`unaccent(${organizations.displayName}) ILIKE unaccent(${pattern}) ESCAPE '\'`,
        ),
      )
      .limit(cap),
    db
      .select({
        id: profiles.id,
        displayName: profiles.displayName,
        matriculaVerified: profiles.matriculaVerified,
        matriculaJurisdiccion: profiles.matriculaJurisdiccion,
        deactivatedAt: profiles.deactivatedAt,
      })
      .from(profiles)
      .where(
        and(
          eq(profiles.role, "vet"),
          eq(profiles.matriculaVerified, true),
          sql`unaccent(${profiles.displayName}) ILIKE unaccent(${pattern}) ESCAPE '\'`,
        ),
      )
      .limit(cap),
  ]);

  const filteredOrgs = orgRows.filter((o) => o.status === "active");
  const filteredProfiles = profileRows.filter((p) => p.deactivatedAt === null);

  const ranked = [
    ...filteredOrgs.map((o) => ({
      suggestion: {
        kind: "organization" as const,
        id: o.id,
        displayName: o.displayName,
        orgType: o.orgType,
        jurisdictionProvince: o.jurisdictionProvince,
        jurisdictionLocality: o.jurisdictionLocality,
        verified: o.verified,
      },
      score: rankScore(o.displayName, q, {
        locality: o.jurisdictionLocality,
        province: o.jurisdictionProvince,
        contextLocality: jurisdiction?.locality ?? null,
        contextProvince: jurisdiction?.province ?? null,
      }),
    })),
    ...filteredProfiles.map((p) => ({
      suggestion: {
        kind: "profile" as const,
        id: p.id,
        displayName: p.displayName,
        matriculaVerified: p.matriculaVerified,
        matriculaJurisdiccion: p.matriculaJurisdiccion,
      },
      score: rankScore(p.displayName, q, {
        // Profiles don't store jurisdiction directly; rank purely by name.
        locality: null,
        province: null,
        contextLocality: jurisdiction?.locality ?? null,
        contextProvince: jurisdiction?.province ?? null,
      }),
    })),
  ];

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, cap).map((r) => r.suggestion);
}

interface RankInput {
  locality: string | null;
  province: string | null;
  contextLocality: string | null;
  contextProvince: string | null;
}

function rankScore(displayName: string, query: string, ctx: RankInput): number {
  let score = 0;
  const nameLower = displayName.toLowerCase();
  const qLower = query.toLowerCase();
  if (nameLower.startsWith(qLower)) score += 100;
  else if (nameLower.includes(qLower)) score += 10;
  if (ctx.contextLocality && ctx.locality === ctx.contextLocality) score += 50;
  else if (ctx.contextProvince && ctx.province === ctx.contextProvince) score += 25;
  return score;
}
