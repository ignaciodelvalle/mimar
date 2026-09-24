// Single source of truth for jurisdiction-scope SQL clauses on Pattern-B fetchers.
//
// Previously petsScopeClause and petEventsScopeClause were duplicated between
// lib/govt-dashboards.ts and lib/govt-home-kpis.ts, and the jurisdiction-pair
// predicate was re-derived inline ~14× across fetchers. This module eliminates
// that duplication.
//
// Import note: this file uses @/db (Drizzle) — it lives in infrastructure,
// not domain/. This is Pattern-B territory (aggregate reads, not pure rules).

import { type AnyColumn, type SQL, and, eq, sql } from "drizzle-orm";

import {
  cases,
  custodyDisputes,
  eventNotificationOutbox,
  petEvents,
  pets,
  welfareReports,
} from "@/db";
import { isWholeProvinceLocality } from "@/lib/domain/jurisdiction-canonical";

import type { DashboardJurisdiction } from "./context";
import type { ProjectionContext, ScopedForDisclosure } from "./context";

/**
 * Builds the OR-of-(province=X AND locality=Y) disjunction for a list of
 * jurisdiction assignments. Parameterized by SQL expressions so callers can
 * pass any table column or JSONB extraction as the province/locality operands.
 *
 * Returns `null` when `jurisdictions` is empty — callers that need `sql\`false\``
 * for the empty case must handle it themselves (see govtJurisdictionClause for
 * a wrapper that does so automatically).
 *
 * IMPORTANT: this function never emits the admin branch. Call it only when
 * you have already established that the actor is govt (or you need the raw
 * pairs regardless of role).
 *
 * @example
 * // pets table columns
 * jurisdictionPairClause(jurisdictions,
 *   sql`${pets.jurisdictionProvince}`,
 *   sql`${pets.jurisdictionLocality}`)
 *
 * @example
 * // JSONB payload fields
 * jurisdictionPairClause(jurisdictions,
 *   sql`(${petEvents.payload}->>'pet_jurisdiction_province')`,
 *   sql`(${petEvents.payload}->>'pet_jurisdiction_locality')`)
 */
export function jurisdictionPairClause(
  jurisdictions: DashboardJurisdiction[],
  provinceExpr: SQL,
  localityExpr: SQL,
): SQL | null {
  if (jurisdictions.length === 0) return null;
  const pairs = jurisdictions.map((j) =>
    // Whole-province assignment (e.g. CABA / "Ciudad Autónoma de Buenos Aires")
    // subsumes every locality/barrio in that province — match on province alone.
    // Province equality is always kept, so other provinces stay invisible.
    // A barrio-specific assignment (CABA / Palermo) keeps the exact pair.
    //
    // NULL-locality rows (residual/legacy welfare_reports where the point could
    // not be reverse-geocoded to a locality — see FIX #3A/#3B, QA 2026-07-10):
    // the whole-province branch tests province ONLY, so it also matches rows with
    // jurisdiction_locality IS NULL — those reach the broad-jurisdiction operators
    // exactly as the PO decided. The specific-locality branch compares
    // `locality = Y`, which is UNKNOWN (never true) for a NULL locality, so a
    // barrio/locality-scoped operator is deliberately NOT widened by them. This is
    // the intended subsumption — no separate `IS NULL` disjunction is needed.
    isWholeProvinceLocality(j.province, j.locality)
      ? sql`(${provinceExpr} = ${j.province})`
      : sql`(${provinceExpr} = ${j.province} AND ${localityExpr} = ${j.locality})`,
  );
  // Wrap the OR-chain in an outer group so the clause is a single self-contained
  // boolean. Without this, a caller composing it via `and(condA, …, pairClause)`
  // gets `condA AND … AND pair1 OR pair2 OR …`; SQL AND binds tighter than OR, so
  // every row matching pair2… is returned regardless of the other conditions —
  // breaking the jurisdiction fence AND the primaryPetId/status/kind filters
  // (dawn QA #57: Argo pet-drill leaked other pets' cases). One pair alone is
  // already parenthesized, so the extra group is a harmless no-op there.
  return sql`(${sql.join(pairs, sql` OR `)})`;
}

// ---------------------------------------------------------------------------
// Synthetic rows (PO D3, 2026-09-18 — pilot item T1-P1)
//
// The pilot runs in the one environment that also holds the national,
// population-weighted demo seed: ~41k pets stamped `pets.seed_tag`
// (migration 0160) and their welfare reports stamped
// `welfare_reports.seed_tag` (migration 0155). Every municipality has
// synthetic animals, cases and reports inside its own scope. A municipal
// operator must never see one of them as if it were a citizen's.
//
// THE RULE: only `admin` sees synthetic rows (demos keep working). `govt`
// AND `national` do not — national is a read scope over REAL data too; its
// universality is geographic, not a licence to count fixtures.
//
// WHERE IT LIVES: inside the scope clauses themselves. Every table-aware
// scope helper (`petsScopeClause`, `petEventsScopeClause`, the dashboards
// `_scope.ts` family, the panorama `repository-scope.ts` family, the
// operator list queries) ANDs the matching exclusion below, so a fetcher that
// scopes correctly is also synthetic-clean without knowing it. A fetcher that
// hand-rolls `jurisdictionPairClause` (the raw, table-blind primitive) must
// apply one of these itself — `__tests__/gob-synthetic-exclusion-fence.test.ts`
// enumerates those call sites and fails on a new one that does not.
//
// A suppressed cell is still a suppressed cell: the exclusion sits in WHERE,
// BEFORE every count, so k-anonymity runs on the real population and a cell
// that falls under k after the exclusion is suppressed exactly like any other.
// ---------------------------------------------------------------------------

/** Does this read role see synthetic (seed-tagged) rows? Admin only. */
export function seesSyntheticRows(role: string): boolean {
  return role === "admin";
}

/** A column (or SQL expression) that holds a pets.id. */
type PetIdOperand = AnyColumn | SQL;

/**
 * The exclusion predicates, one per table a /gob read path scopes. Each is a
 * self-contained boolean (parenthesised) that references ONLY its own table's
 * columns plus aliased subqueries, so it composes with any `and(...)` whose
 * FROM already carries that table. Callers normally reach these through
 * `withoutSyntheticRows`, never directly.
 */
export const syntheticRowExclusion = {
  /** `pets` is in FROM. */
  pets: (): SQL => sql`(${pets.seedTag} IS NULL)`,
  /**
   * Any row that points at a pet by id (pet_events.pet_id,
   * custody_disputes.pet_id, cases.primary_pet_id…). A NULL id is NOT
   * synthetic — a location-subject case has no pet, and it stays visible.
   */
  petId: (petIdCol: PetIdOperand): SQL =>
    sql`NOT EXISTS (SELECT 1 FROM pets synth_p WHERE synth_p.id = ${petIdCol} AND synth_p.seed_tag IS NOT NULL)`,
  /** `pet_events` is in FROM. */
  petEvents: (): SQL => syntheticRowExclusion.petId(petEvents.petId),
  /** `welfare_reports` is in FROM. */
  welfareReports: (): SQL => sql`(${welfareReports.seedTag} IS NULL)`,
  /**
   * `cases` is in FROM. A case is synthetic when its primary pet is, OR when a
   * seed-tagged welfare report opened it (welfare_reports.case_id). A
   * location-subject case with neither link carries no marker at all — see
   * the known gap in the T1-P1 report (seeded historic decomisos/disputes).
   */
  cases: (): SQL =>
    sql`(${syntheticRowExclusion.petId(cases.primaryPetId)} AND NOT EXISTS (SELECT 1 FROM welfare_reports synth_w WHERE synth_w.case_id = ${cases.id} AND synth_w.seed_tag IS NOT NULL))`,
  /** `custody_disputes` is in FROM — a dispute over a synthetic pet. */
  custodyDisputes: (): SQL => syntheticRowExclusion.petId(custodyDisputes.petId),
  /** `event_notification_outbox` is in FROM (ENO / webhook queue). */
  outbox: (): SQL =>
    sql`NOT EXISTS (SELECT 1 FROM pet_events synth_e JOIN pets synth_p ON synth_p.id = synth_e.pet_id WHERE synth_e.id = ${eventNotificationOutbox.sourceEventId} AND synth_p.seed_tag IS NOT NULL)`,
} as const;

export type SyntheticRowTable = keyof Omit<typeof syntheticRowExclusion, "petId">;

/**
 * AND the synthetic exclusion for `table` onto an existing scope clause, for a
 * viewer of `role`. Admin → the clause unchanged (including `null`, "no
 * restriction"). Anyone else → the clause AND the exclusion; a `null` clause
 * (national, undrilled) becomes the exclusion alone.
 */
export function withoutSyntheticRows(
  role: string,
  table: SyntheticRowTable,
  clause: SQL | null | undefined,
): SQL | null {
  if (seesSyntheticRows(role)) return clause ?? null;
  const exclusion = syntheticRowExclusion[table]();
  return clause ? sql`(${clause} AND ${exclusion})` : exclusion;
}

/**
 * Returns a Drizzle SQL clause that restricts a `pets`-based query to the
 * viewer's jurisdiction scope.
 *
 * - admin, no province selected → null (no restriction; caller omits the WHERE clause)
 * - admin + province selected  → province (and optionally locality) predicate
 *   (Panorama admin drill-down only — scope.kind is still "global" but we
 *   append an ADDITIONAL narrowing predicate; see ProjectionContext.adminProvince)
 * - govt with no assignments   → `false` (matches nothing; preserves early-return semantics)
 * - govt with assignments      → OR of (province=X AND locality=Y) pairs
 *
 * SECURITY: the admin province branch fires ONLY when scope.kind === "global"
 * (i.e. actor.role === "admin"). Govt actors always have scope.kind ===
 * "jurisdictions" so they never reach this branch and adminProvince has zero
 * effect on their clause.
 */
export function petsScopeClause(ctx: ProjectionContext) {
  return withoutSyntheticRows(ctx.actor.role, "pets", petsJurisdictionClause(ctx));
}

/** The jurisdiction half of `petsScopeClause`, without the synthetic exclusion. */
function petsJurisdictionClause(ctx: ProjectionContext) {
  if (ctx.scope.kind === "global") {
    // Admin province drill-down: narrow from universal to the selected province.
    // Govt users must NOT pass these fields — their scope is enforced by
    // the jurisdiction pairs below (same invariant as buildMaltratoListConditions).
    if (!ctx.adminProvince) return null;
    if (ctx.adminLocality) {
      return and(
        eq(pets.jurisdictionProvince, ctx.adminProvince),
        eq(pets.jurisdictionLocality, ctx.adminLocality),
      );
    }
    return eq(pets.jurisdictionProvince, ctx.adminProvince);
  }
  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return sql`false`;
  // synthetic: covered — petsScopeClause wraps this with withoutSyntheticRows.
  return jurisdictionPairClause(
    jurisdictions,
    sql`${pets.jurisdictionProvince}`,
    sql`${pets.jurisdictionLocality}`,
  );
}

/**
 * Is `province` part of the viewer's OWN jurisdiction?
 *
 * THE SAME scope model `petsScopeClause` compiles to SQL, read as a predicate
 * instead of a WHERE clause — deliberately NOT a second notion of scope. Every
 * branch of `jurisdictionPairClause` keeps province equality (the whole-province
 * branch tests province ALONE; the specific-locality branch tests
 * `province = X AND locality = Y`), so the set of provinces a scoped row can
 * possibly come from is exactly `scope.jurisdictions.map(j => j.province)`.
 * A locality-grain operator (CABA / Palermo) therefore OWNS the province row
 * labelled "CABA" — that row only ever aggregates their own Palermo animals,
 * because the clause already fenced it.
 *
 * `false` for `scope.kind === "global"` (admin). That is the deliberate reading
 * of D.10 (PO, 2026-07-31), not an oversight — see the ADMIN note on
 * `planProvinceDisclosure` (lib/metrics/province-disclosure.ts).
 */
export function isOwnJurisdictionProvince(ctx: ScopedForDisclosure, province: string): boolean {
  if (ctx.scope.kind === "global") return false;
  return ctx.scope.jurisdictions.some((j) => j.province === province);
}

/**
 * Returns a Drizzle SQL clause that restricts a `pet_events`-based query to the
 * viewer's jurisdiction scope, using the JSONB payload fields
 * `pet_jurisdiction_province` / `pet_jurisdiction_locality`.
 *
 * ⚠️ VALID ONLY FOR outbreak_signal-family QUERIES. Those payload keys are a
 * jurisdiction SNAPSHOT that EXACTLY ONE event type writes: `outbreak_signal`
 * (emitted by symptom-observed-use-case and record-disease-diagnosis-use-case;
 * the schema keeps the snapshot so surveillance aggregates hold even if the pet
 * later moves). NO other event type carries these keys — the insert path enriches
 * the outbox, not the payload. Applying this clause to a query over any OTHER
 * event type (vaccination_administered, incident_reported, sterilization_performed,
 * death_recorded, disease_reported, …) silently evaluates to `false` for every
 * real row of a scoped govt actor, returning ZERO results (admin/national is
 * unaffected because the clause resolves to `null`). This is the "ghost-payload"
 * bug class. For those event types, scope by the pet's home jurisdiction instead:
 * `petsScopeClause(ctx)` against `.innerJoin(pets, eq(pets.id, petEvents.petId))`
 * (that join is many-events→one-pet, so it never fans out).
 *
 * - admin, no province → null
 * - admin + province   → payload province (and optionally locality) predicate
 * - govt with no assignments → `false`
 * - govt with assignments    → OR of payload province+locality pairs
 *
 * SECURITY: same guarantee as petsScopeClause — the admin branch only fires
 * when scope.kind === "global".
 */
export function petEventsScopeClause(ctx: ProjectionContext) {
  return withoutSyntheticRows(ctx.actor.role, "petEvents", petEventsJurisdictionClause(ctx));
}

/** The jurisdiction half of `petEventsScopeClause`, without the synthetic exclusion. */
function petEventsJurisdictionClause(ctx: ProjectionContext) {
  if (ctx.scope.kind === "global") {
    if (!ctx.adminProvince) return null;
    if (ctx.adminLocality) {
      return and(
        sql`(${petEvents.payload}->>'pet_jurisdiction_province') = ${ctx.adminProvince}`,
        sql`(${petEvents.payload}->>'pet_jurisdiction_locality') = ${ctx.adminLocality}`,
      );
    }
    return sql`(${petEvents.payload}->>'pet_jurisdiction_province') = ${ctx.adminProvince}`;
  }
  const { jurisdictions } = ctx.scope;
  if (jurisdictions.length === 0) return sql`false`;
  // synthetic: covered — petEventsScopeClause wraps this with withoutSyntheticRows.
  return jurisdictionPairClause(
    jurisdictions,
    sql`(${petEvents.payload}->>'pet_jurisdiction_province')`,
    sql`(${petEvents.payload}->>'pet_jurisdiction_locality')`,
  );
}
