// Search helpers for the admin pages (/admin/usuarios, /admin/organizaciones).
//
// Govt scope for users (P1-2):
//   A govt user should only see users who are meaningfully linked to their
//   assigned jurisdiction(s). The most defensible link in the current schema
//   is: the user owns at least one pet whose (jurisdictionProvince, jurisdictionLocality)
//   matches one of the viewer's assignments. We JOIN profiles → ownerships →
//   pets and apply the scope predicate. The alternative (profiles' own province
//   field) was rejected because profiles have no jurisdiction columns — only
//   personal accounts carry dniNumber/matricula data that is unrelated to
//   geographic jurisdiction.
//
//   Consequence: users with zero pets (or pets with null jurisdiction) do NOT
//   appear in a govt viewer's search. This is intentional — prefer showing LESS
//   over showing cross-jurisdiction PII (security decision, see docs/qa/ui-flow-review-2026-06.md P1-2).
//
// Admin: universal scope (no predicate — same as before).

import { and, eq, isNull, or, sql } from "drizzle-orm";

import { db, organizations, ownerships, petServiceDog, pets, profiles } from "@/db";
import type { ServiceDogType, UserRole, orgTypeEnum } from "@/db";
import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";
import { jurisdictionPairClause, withoutSyntheticRows } from "@/lib/metrics/scope";
import { hashDni } from "@/lib/utils/dni-hash";
import { likeContains } from "@/lib/utils/like-helpers";

// A trimmed query that is ALL DIGITS and 7-8 chars long is treated as a DNI
// (Argentine DNI space) rather than a name fragment — operators paste the
// number they have on hand, not a partial name that happens to be numeric.
function looksLikeDni(trimmed: string): boolean {
  return /^\d{7,8}$/.test(trimmed);
}

export type UserSearchResult = {
  id: string;
  displayName: string;
  role: "owner" | "vet" | "govt" | "admin" | "national";
  // Jurisdiction that issued the vet's professional license. Used by
  // RevokeUserActions (Fase 4+) for client-side canRevoke scope check.
  // Null for non-vet users.
  matriculaJurisdiccion: string | null;
  // Account activation state — null when active, a timestamp when deactivated.
  // Drives the "estado" line on the usuarios roster (I1). Selected so the row is
  // useful at a glance without a per-user detail trip.
  deactivatedAt: Date | null;
};

export type UserSearchScope =
  | { role: "admin" }
  | { role: "govt"; jurisdictions: readonly AdminOrGovtJurisdiction[] };

// Canonical roles come straight from userRoleEnum (db/schema.ts) — "all" is the
// UI-only "no filter" sentinel, never pushed into the WHERE clause.
//
// DERIVED FROM `UserRole`, NOT RETYPED. It was a hand-written literal union,
// and on 2026-09-09 migration 0214 added `national` to the enum without this
// line changing — so the Directorio roster could not filter for the new role
// and every `Record<UserRoleFilter, …>` in the UI still compiled with a case
// missing. A union that restates an enum is a copy that goes stale in silence;
// derived, the compiler names every map that has to grow with it.
export type UserRoleFilter = UserRole | "all";

export type OrgSearchResult = {
  id: string;
  displayName: string;
  legalName: string;
  orgType: string;
  cuit: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  verified: boolean;
};

const SEARCH_LIMIT = 25;
// Larger limit for the default (no-query) paginated listing.
const DEFAULT_LIST_LIMIT = 50;

// Look up users by display_name, OR by exact DNI when the query looks like one.
// Wave 5 Item 25a: DNI is no longer stored in plaintext — prefix search on
// dni_number is removed. Exact DNI lookup (search/omnibox-upgrade, 2026-07-19)
// computes hashDni(query) and matches profiles.dni_hash by equality — see the
// looksLikeDni / textPredicate construction below for the union with the name
// search.
//
// Empty query returns a default list ordered by role priority then display
// name, limited to DEFAULT_LIST_LIMIT rows so the page is always useful on
// landing without PII search intent.
//
// `scope` controls jurisdiction filtering:
//   - admin: no scope predicate — returns all users.
//   - govt: scoped to users who own at least one pet in the viewer's jurisdiction
//     (see module-level comment for the rationale). Govt with zero assignments
//     returns an empty list immediately.
//
// `scope` is REQUIRED (A01-6, 2026-09-18). It used to default to
// `{ role: "admin" }`, so a future caller that forgot the argument got the
// universal PII search: the default failed open. Every caller already passed
// one; now the compiler makes the next one say which viewer it is.
export async function searchUsers(
  query: string,
  scope: UserSearchScope,
  roleFilter: UserRoleFilter = "all",
): Promise<UserSearchResult[]> {
  // Govt with no assignments must see nothing (prefer showing LESS).
  if (scope.role === "govt" && scope.jurisdictions.length === 0) return [];

  const trimmed = query.trim();

  // Build the jurisdiction scope predicate for govt viewers.
  // We join profiles → ownerships → pets and filter on the pet's jurisdiction
  // columns. This is a semi-join: DISTINCT ensures each user appears once even
  // if they have multiple pets in the matching jurisdiction.
  //
  // System/service accounts (profiles.is_system, migration 0109 — e.g. the
  // `system:backfill-*` rows migrations insert to author bulk audit trails)
  // must never surface here: they have role='admin' so the default (no-query)
  // listing sorted admin-first put them at the very top, reading as
  // manageable human administrators. `/admin/admins` already partitions on
  // this same flag — mirror it here rather than a display-name heuristic.
  const scopeConditions: ReturnType<typeof and>[] = [eq(profiles.isSystem, false)];
  // Role filter (ROLE param, narrows only — "all" pushes no predicate).
  if (roleFilter !== "all") {
    scopeConditions.push(eq(profiles.role, roleFilter));
  }
  if (scope.role === "govt") {
    // At least one active ownership linking the user to a scoped pet.
    // ownerships.role = 'owner' ensures we only count real owners (not caretakers).
    // ownerships.endedAt IS NULL restricts to current owners.
    // jurisdictionPairClause applies whole-province subsumption (a whole-CABA
    // assignment matches every barrio, not just the sentinel locality string)
    // — see lib/metrics/scope.ts. Found via authz-subsumption fence hardening
    // (2026-07-22) — same bug class as commit 68501bb4.
    // T1-P1: an owner is in scope through a REAL pet only — the owner of a
    // synthetic (seed-tagged) animal is not a citizen of this municipality.
    const jurisdictionClause = withoutSyntheticRows(
      scope.role,
      "pets",
      jurisdictionPairClause(
        [...scope.jurisdictions],
        sql`${pets.jurisdictionProvince}`,
        sql`${pets.jurisdictionLocality}`,
      ) ?? sql`false`,
    );
    scopeConditions.push(
      // profiles.id ∈ SELECT DISTINCT ownerUserId FROM ownerships JOIN pets ON ...
      sql`${profiles.id} IN (
        SELECT DISTINCT ${ownerships.ownerUserId}
        FROM ${ownerships}
        INNER JOIN ${pets} ON ${pets.id} = ${ownerships.petId}
        WHERE ${ownerships.endedAt} IS NULL
          AND ${ownerships.role} = 'owner'
          AND (${jurisdictionClause})
      )`,
    );
  }

  // Role sort priority: admin → govt → vet → owner (others sort last).
  const rolePriority = sql`CASE ${profiles.role}
    WHEN 'admin' THEN 1
    WHEN 'govt'  THEN 2
    WHEN 'vet'   THEN 3
    WHEN 'owner' THEN 4
    ELSE 5
  END`;

  if (!trimmed) {
    const whereClause = scopeConditions.length > 0 ? and(...scopeConditions) : undefined;
    const rows = await db
      .select({
        id: profiles.id,
        displayName: profiles.displayName,
        role: profiles.role,
        matriculaJurisdiccion: profiles.matriculaJurisdiccion,
        deactivatedAt: profiles.deactivatedAt,
      })
      .from(profiles)
      .where(whereClause)
      .orderBy(rolePriority, profiles.displayName)
      .limit(DEFAULT_LIST_LIMIT);
    return rows;
  }

  const pattern = likeContains(trimmed);
  // Use unaccent() so "gonzalez" finds "González" (Postgres ILIKE folds case
  // but NOT diacritics). Wildcard-safe via likeContains().
  //
  // Wave 5 Item 25a removed dni_number (plaintext); dni_hash is the only DNI
  // column left, and it is an equality-only column — it cannot support a
  // "contains" search. When the trimmed query LOOKS like a DNI (all digits,
  // 7-8 chars, looksLikeDni above) we ALSO match on hashDni(query) = dni_hash,
  // unioned (OR) with the name search rather than replacing it — an operator
  // pasting a DNI should never lose the ability to instead be typing a numeric
  // display name fragment. hashDni() is deterministic (HMAC-SHA256 + server
  // pepper, lib/utils/dni-hash.ts): computing it here and comparing by
  // equality never touches plaintext DNI storage, preserving the "no DNI in
  // plaintext" invariant while still giving operators exact-match lookup.
  const namePredicate = sql`unaccent(${profiles.displayName}) ILIKE unaccent(${pattern}) ESCAPE '\'`;
  const textPredicate = looksLikeDni(trimmed)
    ? or(namePredicate, eq(profiles.dniHash, hashDni(trimmed)))
    : namePredicate;
  const whereClause =
    scopeConditions.length > 0 ? and(textPredicate, ...scopeConditions) : textPredicate;

  const rows = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      role: profiles.role,
      matriculaJurisdiccion: profiles.matriculaJurisdiccion,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(whereClause)
    .limit(SEARCH_LIMIT);
  return rows;
}

export type OrgVerifiedFilter = "pending" | "verified" | "all";

// Canonical org types come straight from orgTypeEnum (db/schema.ts) — "all" is
// the UI-only "no filter" sentinel, never pushed into the WHERE clause.
export type OrgType = (typeof orgTypeEnum.enumValues)[number];
export type OrgTypeFilter = OrgType | "all";

// Search organizations. Admin sees all; govt sees only orgs whose
// (jurisdiction_province, jurisdiction_locality) matches one of their
// active assignments.
//
// `verifiedFilter` pushes the verified/unverified predicate into SQL so the
// LIMIT is applied AFTER the filter — preventing the "Pendientes" tab from
// silently truncating the queue when more than SEARCH_LIMIT orgs exist.
// `orgTypeFilter` mirrors the same shape for the org-type predicate.
export async function searchOrganizations(
  query: string,
  scope: { role: "admin" | "govt"; jurisdictions: readonly AdminOrGovtJurisdiction[] },
  verifiedFilter: OrgVerifiedFilter = "all",
  orgTypeFilter: OrgTypeFilter = "all",
): Promise<{ items: OrgSearchResult[]; truncated: boolean }> {
  // Govt with zero assignments sees nothing; skip the query entirely.
  if (scope.role === "govt" && scope.jurisdictions.length === 0)
    return { items: [], truncated: false };

  const trimmed = query.trim();
  const orgPattern = likeContains(trimmed);
  // Use unaccent() on both sides for accent-insensitive matching; likeContains
  // escapes % and _ so user input cannot inject wildcards. CUIT is digits-only
  // so unaccent is a no-op there, but the escaping still matters.
  const textPredicate = trimmed
    ? or(
        sql`unaccent(${organizations.displayName}) ILIKE unaccent(${orgPattern}) ESCAPE '\'`,
        sql`unaccent(${organizations.legalName}) ILIKE unaccent(${orgPattern}) ESCAPE '\'`,
        sql`unaccent(${organizations.cuit}) ILIKE unaccent(${orgPattern}) ESCAPE '\'`,
      )
    : undefined;

  // jurisdictionPairClause applies whole-province subsumption — see
  // lib/metrics/scope.ts. Found via authz-subsumption fence hardening
  // (2026-07-22) — same bug class as commit 68501bb4.
  // synthetic: exempt — organizations carry no seed marker (T1-P1 report).
  const scopePredicate =
    scope.role === "admin"
      ? undefined
      : (jurisdictionPairClause(
          [...scope.jurisdictions],
          sql`${organizations.jurisdictionProvince}`,
          sql`${organizations.jurisdictionLocality}`,
        ) ?? sql`false`);

  const verifiedPredicate =
    verifiedFilter === "pending"
      ? eq(organizations.verified, false)
      : verifiedFilter === "verified"
        ? eq(organizations.verified, true)
        : undefined;

  const orgTypePredicate =
    orgTypeFilter !== "all" ? eq(organizations.orgType, orgTypeFilter) : undefined;

  // Combine all predicates. and() with every defined clause produces a single
  // SQL<unknown> that drizzle's .where() accepts cleanly.
  const activeClauses = [textPredicate, scopePredicate, verifiedPredicate, orgTypePredicate].filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
  const where =
    activeClauses.length === 0
      ? undefined
      : activeClauses.length === 1
        ? activeClauses[0]
        : and(...activeClauses);

  // Fetch one extra row to detect truncation without a separate COUNT query.
  const limit = SEARCH_LIMIT;
  const rows = await db
    .select({
      id: organizations.id,
      displayName: organizations.displayName,
      legalName: organizations.legalName,
      orgType: organizations.orgType,
      cuit: organizations.cuit,
      jurisdictionProvince: organizations.jurisdictionProvince,
      jurisdictionLocality: organizations.jurisdictionLocality,
      verified: organizations.verified,
    })
    .from(organizations)
    .where(where)
    .limit(limit + 1);

  const truncated = rows.length > limit;
  return { items: truncated ? rows.slice(0, limit) : rows, truncated };
}

export type ServiceDogCredentialSearchResult = {
  petId: string;
  petPublicToken: string;
  petName: string;
  serviceType: ServiceDogType;
  credentialStatus: string;
  rupgaCredential: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

// Search pets holding a RUPGA service-dog credential. Mirrors
// searchOrganizations: admin sees all, govt is scoped to a
// (jurisdiction_province, jurisdiction_locality) match.
//
// Status filter (honesty fix, 2026-07-19): defaults to "vigente" (previous
// hardcoded behavior, unchanged unless the caller opts in) — "revocada" and
// "all" let the operator review past revocations/history instead of them
// being permanently invisible. "en_entrenamiento"/"pendiente_verificacion"
// aren't credentials yet (no verified RUPGA number to revoke/review) and
// "vencida" is a natural expiry — neither is exposed by this filter; "all"
// only widens across the two review-relevant states (vigente/revocada), it
// does not surface every credentialStatus value in the enum.
export type ServiceDogCredentialStatusFilter = "vigente" | "revocada" | "all";

export async function searchServiceDogCredentials(
  query: string,
  scope: { role: "admin" | "govt"; jurisdictions: readonly AdminOrGovtJurisdiction[] },
  filters: { status?: ServiceDogCredentialStatusFilter } = {},
): Promise<{ items: ServiceDogCredentialSearchResult[]; truncated: boolean }> {
  // Govt with zero assignments sees nothing; skip the query entirely.
  if (scope.role === "govt" && scope.jurisdictions.length === 0)
    return { items: [], truncated: false };

  const trimmed = query.trim();
  const pattern = likeContains(trimmed);
  // Search by pet name, public token, or the RUPGA credential number itself.
  const textPredicate = trimmed
    ? or(
        sql`unaccent(${pets.name}) ILIKE unaccent(${pattern}) ESCAPE '\'`,
        sql`unaccent(${pets.publicToken}) ILIKE unaccent(${pattern}) ESCAPE '\'`,
        sql`unaccent(${petServiceDog.rupgaCredential}) ILIKE unaccent(${pattern}) ESCAPE '\'`,
      )
    : undefined;

  // jurisdictionPairClause applies whole-province subsumption — see
  // lib/metrics/scope.ts. Found via authz-subsumption fence hardening
  // (2026-07-22) — same bug class as commit 68501bb4.
  // T1-P1: a service-dog credential on a synthetic pet is synthetic.
  const scopePredicate =
    scope.role === "admin"
      ? undefined
      : (withoutSyntheticRows(
          scope.role,
          "pets",
          jurisdictionPairClause(
            [...scope.jurisdictions],
            sql`${pets.jurisdictionProvince}`,
            sql`${pets.jurisdictionLocality}`,
          ) ?? sql`false`,
        ) ?? undefined);

  const statusFilter = filters.status ?? "vigente";
  const statusPredicate =
    statusFilter === "all" ? undefined : eq(petServiceDog.credentialStatus, statusFilter);

  const activeClauses = [textPredicate, scopePredicate, statusPredicate].filter(
    (c): c is NonNullable<typeof c> => c !== undefined,
  );
  const where = activeClauses.length === 1 ? activeClauses[0] : and(...activeClauses);

  // Fetch one extra row to detect truncation without a separate COUNT query.
  const limit = SEARCH_LIMIT;
  const rows = await db
    .select({
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      serviceType: petServiceDog.serviceType,
      credentialStatus: petServiceDog.credentialStatus,
      rupgaCredential: petServiceDog.rupgaCredential,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
    })
    .from(pets)
    .innerJoin(petServiceDog, eq(petServiceDog.petId, pets.id))
    .where(where)
    .limit(limit + 1);

  const truncated = rows.length > limit;
  return { items: truncated ? rows.slice(0, limit) : rows, truncated };
}

// Re-export for keep-it-tree-shakeable test imports.
void isNull;
