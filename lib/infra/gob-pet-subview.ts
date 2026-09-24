import "server-only";

// Shared server loaders for the govt/admin PET sub-view (#12, search/omnibox-
// upgrade). Two independent access paths reach the SAME read-only projection
// (identity, species/sex/status, microchip, owner-of-record, open cases):
//
//   1. loadGobPetSubView — the maltrato INSPECTOR path. A pet is reachable
//      ONLY when it is the SUBJECT of a welfare report OR the PRIMARY pet of a
//      case that lies INSIDE the caller's jurisdiction (linking-case gate):
//        - govt: at least one linking welfare report / case whose (province,
//          locality) passes jurisdictionScopeContains (whole-province
//          subsumption).
//        - admin: at least one linking welfare report / case in ANY
//          jurisdiction (universal scope still REQUIRES a linking record — a
//          pet with no welfare nexus is never reachable this way).
//      No linking record in scope → { ok: false } → the route 404s.
//
//   2. loadOperatorPetSubView — the OPERATOR ROUTE path (app/gob/mascotas,
//      app/admin/mascotas), fed by the omnibox pet search
//      (lib/infra/omnibox-search.ts). Gates by JURISDICTION ALONE, no linking
//      record required:
//        - admin: universal (no jurisdiction predicate).
//        - govt: the pet's (jurisdictionProvince, jurisdictionLocality) must
//          be in the viewer's assignments (jurisdictionScopeContains).
//          Fail-closed: zero assignments → null, never a DB hit that could leak
//          existence.
//      Out of scope or missing → null → the route 404s, never leaking
//      existence.

import {
  cases,
  db,
  organizations,
  ownerships,
  petIdentifications,
  pets,
  profiles,
  welfareReports,
} from "@/db";
import {
  hasNationalReadScope,
  jurisdictionScopeContains,
} from "@/lib/domain/jurisdiction-canonical";
import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";
import { type PetOpenCase, findOpenCasesForPetWithCodes } from "@/lib/infra/case-queries";
import { withoutSyntheticRows } from "@/lib/metrics/scope";
import type { WelfareReportStatus } from "@/src/modules/welfare/domain/types";
import { isTerminalStatus } from "@/src/modules/welfare/domain/welfare-status-rules";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { WelfareInspectorSession } from "./welfare-inspector-detail";

// Cases whose status still grants a pet-read nexus. Mirrors the "open/escalated"
// active set findOpenCasesForPetWithCodes uses (case-queries.ts) — terminal
// cases (closed / merged) do not. Kept as a set for O(1) membership.
const ACTIVE_CASE_STATUSES: ReadonlySet<string> = new Set(["open", "escalated"]);

export type GobPetSubView = {
  publicToken: string;
  name: string;
  species: string;
  sex: string;
  status: string;
  breed: string | null;
  color: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  microchipCode: string | null;
  ownerOfRecord: string | null;
  openCases: PetOpenCase[];
};

export type GobPetSubViewResult = { ok: true; pet: GobPetSubView } | { ok: false };

// Scope for the operator-route loader (path 2, see module header). Mirrors the
// admin/govt discriminant of OmniboxScope (lib/infra/omnibox-search.ts) — kept
// as a local type so this module's public surface doesn't depend on the
// omnibox module (the dependency should point the other way: omnibox hrefs
// point AT these routes, not the reverse).
export type OperatorPetScope =
  | { role: "admin" }
  | { role: "govt"; jurisdictions: readonly AdminOrGovtJurisdiction[] };

// Sentinel pet id for the timing-oracle-hardening linking lookups when the token
// resolves to no pet: a valid UUID that matches no row, keeping the query shape
// identical for the not-found and out-of-scope paths.
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Load the read-only pet sub-view for an authority, enforcing the linking-case
 * jurisdiction gate. Returns { ok: false } when the pet does not exist OR has no
 * in-jurisdiction linking welfare report / case (route → 404, no existence leak).
 */
export async function loadGobPetSubView(
  session: WelfareInspectorSession,
  publicToken: string,
): Promise<GobPetSubViewResult> {
  const { profile, jurisdictions } = session;
  // NAMED FOR THE CAPABILITY IT GRANTS, NOT FOR THE ROLE IT EXCLUDES.
  //
  // This was `const isGovt = profile.role === "govt"`, and every use below is
  // its negation: not-govt meant "see the whole country, unfiltered". That is
  // the same rule `loadWelfareInspectorDetail` states as
  // `!hasNationalReadScope(profile.role)` — the two halves of ONE inspector —
  // and the two spellings answered identically for as long as `admin` was the
  // only non-govt caller. `session.profile.role` is `GobReadRole`, a union that
  // GREW on 2026-09-09 (migration 0214 added `national`), and a rule phrased as
  // the complement of one role reads as narrowing while behaving as widening:
  // the next role added to that union would inherit country-wide reach here
  // without anyone writing a line that says so. Phrased this way it inherits
  // the jurisdiction filter instead, which is the safe default.
  //
  // No behaviour changes today: `hasNationalReadScope` is true for exactly
  // `admin` and `national`, the two roles `!isGovt` already admitted.
  const isScoped = !hasNationalReadScope(profile.role);

  const [pet] = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      sex: pets.sex,
      status: pets.status,
      breed: pets.breed,
      color: pets.color,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
    })
    .from(pets)
    // T1-P1: a synthetic (seed-tagged) animal does not exist for a non-admin
    // reader — same { ok:false } as a missing token, same query shape.
    .where(
      and(
        eq(pets.publicToken, publicToken),
        withoutSyntheticRows(profile.role, "pets", null) ?? undefined,
      ),
    )
    .limit(1);

  // Linking authorization — gather every welfare report / case that names this
  // pet as subject/primary, then require at least one INSIDE the caller's scope.
  const inScope = (province: string | null, locality: string | null): boolean =>
    isScoped ? jurisdictionScopeContains(jurisdictions, province, locality) : true;

  // Timing-oracle hardening (task #59, LOW-1): run the linking-record lookups
  // with the SAME query shape whether or not the pet exists, so response latency
  // does not distinguish "token does not exist" (previously 1 query) from "exists
  // but out of jurisdiction" (3 queries). Both still resolve to { ok:false }. A
  // missing pet uses a sentinel id that matches no row.
  const linkPetId = pet?.id ?? NIL_UUID;

  const [reportRows, caseRows] = await Promise.all([
    db
      .select({
        province: welfareReports.jurisdictionProvince,
        locality: welfareReports.jurisdictionLocality,
        status: welfareReports.status,
      })
      .from(welfareReports)
      .where(eq(welfareReports.subjectPetId, linkPetId)),
    db
      .select({
        province: cases.jurisdictionProvince,
        locality: cases.jurisdictionLocality,
        status: cases.status,
      })
      .from(cases)
      .where(eq(cases.primaryPetId, linkPetId)),
  ]);

  // #12 LOW-2 — the pet-read nexus EXPIRES when the linking case/report closes
  // (Ley 25.326 minimal-exposure, PO-approved). For a GOVT operator, only an
  // OPEN (non-terminal) in-scope linking record grants access: once the welfare
  // nexus reaches a terminal state the purpose is spent and access is cut. Admin
  // (universal scope, platform controller) is unaffected — any linking record,
  // any status, still resolves, as before. Status is filtered in JS to preserve
  // the task-#59 timing-oracle hardening (identical per-table query shape for the
  // not-found and out-of-scope paths).
  const reportGrants = (r: {
    province: string | null;
    locality: string | null;
    status: string;
  }): boolean =>
    inScope(r.province, r.locality) &&
    (!isScoped || !isTerminalStatus(r.status as WelfareReportStatus));
  const caseGrants = (c: {
    province: string | null;
    locality: string | null;
    status: string;
  }): boolean =>
    inScope(c.province, c.locality) && (!isScoped || ACTIVE_CASE_STATUSES.has(c.status));

  const hasLink = reportRows.some(reportGrants) || caseRows.some(caseGrants);
  if (!pet || !hasLink) return { ok: false };

  // Fence the open-cases list to the caller's jurisdiction (task #59) — see
  // loadPetSubViewTail. A country-wide reader keeps universal visibility
  // (undefined → unfiltered).
  return { ok: true, pet: await loadPetSubViewTail(pet, isScoped ? jurisdictions : undefined) };
}

// Row shape shared by both loaders' initial `pets` SELECT.
type PetRow = {
  id: string;
  publicToken: string;
  name: string;
  species: string;
  sex: string;
  status: string;
  breed: string | null;
  color: string | null;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
};

/**
 * Shared tail: resolves microchip, owner-of-record, and the jurisdiction-fenced
 * open-cases list, and assembles the GobPetSubView. Both loaders call this once
 * their respective gate has already confirmed the caller may see `pet` — this
 * function does no additional authorization, only projection.
 *
 * `openCasesScope`: `undefined` = admin/universal (unfiltered). A govt array
 * fences the open-cases list to the caller's jurisdiction (task #59) — a govt
 * operator who legitimately reaches a pet must NOT see cases in provinces they
 * do not govern (case existence + publicCode + kind + open-date would leak
 * cross-fence otherwise). Same subsumption-aware predicate as the caller's gate.
 */
async function loadPetSubViewTail(
  pet: PetRow,
  openCasesScope: ReadonlyArray<{ province: string; locality: string }> | undefined,
): Promise<GobPetSubView> {
  // Active microchip (canonical pet_identifications row).
  const [chip] = await db
    .select({ code: petIdentifications.code })
    .from(petIdentifications)
    .where(
      and(
        eq(petIdentifications.petId, pet.id),
        eq(petIdentifications.kind, "microchip_iso"),
        eq(petIdentifications.status, "active"),
      ),
    )
    .orderBy(desc(petIdentifications.recordedAt))
    .limit(1);

  // Owner-of-record — most recent active 'owner' ownership (person or org).
  const [ownership] = await db
    .select({
      ownerUserId: ownerships.ownerUserId,
      ownerOrganizationId: ownerships.ownerOrganizationId,
    })
    .from(ownerships)
    .where(
      and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
    )
    .orderBy(desc(ownerships.startedAt))
    .limit(1);

  let ownerOfRecord: string | null = null;
  if (ownership?.ownerUserId) {
    const [ownerProfile] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, ownership.ownerUserId))
      .limit(1);
    ownerOfRecord = ownerProfile?.displayName ?? null;
  } else if (ownership?.ownerOrganizationId) {
    const [ownerOrg] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, ownership.ownerOrganizationId))
      .limit(1);
    ownerOfRecord = ownerOrg?.displayName ?? null;
  }

  const openCases = await findOpenCasesForPetWithCodes(pet.id, openCasesScope);

  return {
    publicToken: pet.publicToken,
    name: pet.name,
    species: pet.species,
    sex: pet.sex,
    status: pet.status,
    breed: pet.breed,
    color: pet.color,
    jurisdictionProvince: pet.jurisdictionProvince,
    jurisdictionLocality: pet.jurisdictionLocality,
    microchipCode: chip?.code ?? null,
    ownerOfRecord,
    openCases,
  };
}

/**
 * Load the operator-route pet sub-view, gating by JURISDICTION ALONE (no
 * linking welfare report / case required — see module header, path 2). Fed by
 * app/gob/mascotas/[token], app/admin/mascotas/[token], and the omnibox pet
 * search (lib/infra/omnibox-search.ts).
 *
 * Returns null when the pet does not exist, is soft-deleted, or is out of the
 * caller's jurisdiction — the route maps all three to notFound() so existence
 * never leaks. Fail-closed: a govt scope with zero assignments returns null
 * WITHOUT querying the pet row (mirrors searchUsers / searchOmnibox).
 */
export async function loadOperatorPetSubView(
  publicToken: string,
  scope: OperatorPetScope,
): Promise<GobPetSubView | null> {
  if (scope.role === "govt" && scope.jurisdictions.length === 0) return null;

  const [pet] = await db
    .select({
      id: pets.id,
      publicToken: pets.publicToken,
      name: pets.name,
      species: pets.species,
      sex: pets.sex,
      status: pets.status,
      breed: pets.breed,
      color: pets.color,
      jurisdictionProvince: pets.jurisdictionProvince,
      jurisdictionLocality: pets.jurisdictionLocality,
    })
    .from(pets)
    .where(and(eq(pets.publicToken, publicToken), isNull(pets.deletedAt)))
    .limit(1);
  if (!pet) return null;

  if (scope.role === "govt") {
    const inScope = jurisdictionScopeContains(
      scope.jurisdictions,
      pet.jurisdictionProvince,
      pet.jurisdictionLocality,
    );
    if (!inScope) return null;
  }

  return loadPetSubViewTail(pet, scope.role === "govt" ? scope.jurisdictions : undefined);
}
