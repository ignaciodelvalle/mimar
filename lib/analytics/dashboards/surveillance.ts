// Read helpers for the /gob regional dashboards (Fase 11) — vigilancia /
// surveillance domain (outbreak signals, zoonosis trend, cases per
// locality/subregion/capita, outbreak history).
// Split out of lib/analytics/govt-dashboards.ts (engram refactor/govt-dashboards-split).
//
// All helpers accept the actor + jurisdictions tuple already produced by
// requireAdminOrGovtOrRedirect — admin sees universal scope (jurisdictions
// is empty by contract for admin), govt sees only rows matching one of their
// active assignments.

import { type SQL, and, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { cases, analyticsDb as db, jurisdictionsCensus, petEvents, pets } from "@/db";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import type {
  DashboardActor,
  DashboardJurisdiction,
  MetricResult,
  SuppressedCells,
} from "@/lib/metrics";
import { complementarySuppress, suppressSmallCells, suppressedMetric } from "@/lib/metrics";
import { PROVINCES, provinceByCode } from "@/lib/reference/ar-provincias";
import { findDisease } from "@/lib/reference/diseases";
import { parseArDateStartOfDay } from "@/lib/utils/date-input-ar";
import { isoDateInAr } from "@/lib/utils/format";
import { EPIDEMIOLOGICAL_CASE_KINDS } from "@/src/modules/cases/domain/case-kinds";
import { aggregateRowsByDepartment } from "../subregion-aggregate";
import type { SubregionAggregate } from "../subregion-redaction";
import {
  DAY_MS,
  casesScopeClause,
  outbreakSignalScopeClause,
  petsCurrentJurisdictionClause,
  petsScopeClause,
} from "./_scope";

export type SurveillanceFilters = {
  /** Inclusive lower bound for occurredAt. */
  since: Date;
  /** Optional disease_code narrow filter. */
  diseaseCode?: string | null;
  /**
   * Admin province drill-down (Panorama). Only set when actor.role === "admin"
   * and a province was selected via the URL. Govt callers must NOT pass this —
   * their scope is already enforced by the jurisdiction pairs.
   */
  adminProvince?: string;
  adminLocality?: string;
};

export type SurveillanceSignal = {
  signalEventId: string;
  petId: string;
  petPublicToken: string;
  petName: string;
  petSpecies: string;
  diseaseCode: string;
  diseaseName: string;
  province: string | null;
  locality: string | null;
  detectedAt: Date;
  // Provenance for confidence tier computation (plan §A.5, 2026-05-22).
  // Stored here so consumers can call computeConfidence() without a second DB query.
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
  /**
   * The investigation somebody opened FROM this signal, or null when nobody
   * has. Null is the interesting value: it is the only way this screen can
   * tell "there is nothing happening" apart from "nobody looked yet".
   *
   * Read through the `signal_link` case event, which `openOutbreakInvestigation`
   * writes as its own entry type. An investigation opened by hand - a lab
   * report arriving out of band, which `manualOpenAllowed` permits - carries no
   * such row, and correctly does not make any signal look triaged.
   */
  investigation: { publicCode: string; status: string } | null;
};

export type DiseaseSummary = {
  diseaseCode: string;
  diseaseName: string;
  count30d: number;
  count7d: number;
  count24h: number;
};

// outbreakSignalScopeClause (payload-snapshot scope on outbreak_signal events)
// now lives in ./_scope alongside every other dashboard scope helper (C3, ONE
// VIEWSCOPE) — this module kept a byte-identical private copy of it.

// Same guard as petsCurrentJurisdictionClause, wrapped in an EXISTS subquery
// for pet_events queries that do NOT already join the pets table.
function petsCurrentJurisdictionExists(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  adminProvince?: string,
  adminLocality?: string,
): SQL | null {
  const clause = petsCurrentJurisdictionClause(actor, jurisdictions, adminProvince, adminLocality);
  if (!clause) return null;
  return sql`EXISTS (SELECT 1 FROM ${pets} WHERE ${pets.id} = ${petEvents.petId} AND (${clause}))`;
}

export async function fetchSurveillanceSignals(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  filters: SurveillanceFilters,
): Promise<SurveillanceSignal[]> {
  const conditions = [
    eq(petEvents.eventType, "outbreak_signal"),
    gte(petEvents.occurredAt, filters.since),
  ];
  if (filters.diseaseCode) {
    conditions.push(sql`(${petEvents.payload}->>'disease_code') = ${filters.diseaseCode}`);
  }
  const scope = outbreakSignalScopeClause(
    actor,
    jurisdictions,
    filters.adminProvince,
    filters.adminLocality,
  );
  if (scope) conditions.push(sql`(${scope})`);
  // Rows return pet identifiers (name + public token) — require the pet's
  // CURRENT jurisdiction to be in scope too (pets is inner-joined below).
  const petsScope = petsCurrentJurisdictionClause(
    actor,
    jurisdictions,
    filters.adminProvince,
    filters.adminLocality,
  );
  if (petsScope) conditions.push(sql`(${petsScope})`);

  const rows = await db
    .select({
      signalEventId: petEvents.id,
      petId: pets.id,
      petPublicToken: pets.publicToken,
      petName: pets.name,
      petSpecies: pets.species,
      diseaseCode: sql<string>`(${petEvents.payload}->>'disease_code')`,
      diseaseLabel: sql<string | null>`(${petEvents.payload}->>'disease_label')`,
      province: sql<string | null>`(${petEvents.payload}->>'pet_jurisdiction_province')`,
      locality: sql<string | null>`(${petEvents.payload}->>'pet_jurisdiction_locality')`,
      detectedAt: petEvents.occurredAt,
      // Provenance for confidence tier computation (plan §A.5).
      authorRole: petEvents.authorRole,
      authorVerified: petEvents.authorVerified,
      authorOrganizationId: petEvents.authorOrganizationId,
      payload: petEvents.payload,
      // ONE correlated subquery, not two columns and not a LEFT JOIN: the link
      // lives in a jsonb payload, so a join condition would be an expression
      // either way, and two scalar subqueries would walk `case_events` twice
      // for every one of the 500 rows this query can return.
      investigation: sql<{ code: string; status: string } | null>`(
        select json_build_object('code', c.public_code, 'status', c.status)
        from case_events ce
        join cases c on c.id = ce.case_id
        where ce.entry_type = 'signal_link'
          and ce.payload->>'signal_event_id' = ${petEvents.id}::text
        order by ce.occurred_at desc
        limit 1
      )`,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions))
    .orderBy(desc(petEvents.occurredAt))
    .limit(500);

  return rows.map((r) => ({
    signalEventId: r.signalEventId,
    petId: r.petId,
    petPublicToken: r.petPublicToken,
    petName: r.petName,
    petSpecies: r.petSpecies,
    diseaseCode: r.diseaseCode,
    diseaseName: findDisease(r.diseaseCode)?.label ?? r.diseaseLabel ?? r.diseaseCode,
    province: r.province,
    locality: r.locality,
    detectedAt: r.detectedAt,
    authorRole: r.authorRole,
    authorVerified: r.authorVerified,
    authorOrganizationId: r.authorOrganizationId,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    investigation: r.investigation
      ? { publicCode: r.investigation.code, status: r.investigation.status }
      : null,
  }));
}

// Pure rollup: groups already-fetched signals by disease_code and computes
// sub-window counts (7d, 24h) in JS. No DB call. The caller is responsible
// for fetching signals with a window >= 30 days so count30d is correct.
export function computeDiseaseSummary(signals: SurveillanceSignal[]): DiseaseSummary[] {
  const now = Date.now();
  const byCode = new Map<string, DiseaseSummary>();
  for (const s of signals) {
    const entry = byCode.get(s.diseaseCode) ?? {
      diseaseCode: s.diseaseCode,
      diseaseName: s.diseaseName,
      count30d: 0,
      count7d: 0,
      count24h: 0,
    };
    const age = now - s.detectedAt.getTime();
    entry.count30d += 1;
    if (age <= 7 * DAY_MS) entry.count7d += 1;
    if (age <= DAY_MS) entry.count24h += 1;
    byCode.set(s.diseaseCode, entry);
  }
  return [...byCode.values()].sort((a, b) => b.count30d - a.count30d);
}

// Period rollup grouped by disease_code (default last 30 days), with
// sub-counts for the last 7 days and 24h. Pulls from the same scoped query
// as the detail feed so the totals match exactly. `count30d` holds the
// window total (named for the default; callers may pass a custom `since`).
//
// When the caller already has a 30-day SurveillanceSignal[] in hand, prefer
// calling computeDiseaseSummary(signals) directly to avoid a second DB round-trip.
export async function fetchDiseaseSummary(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { since?: Date; adminProvince?: string; adminLocality?: string } = {},
): Promise<DiseaseSummary[]> {
  const since = opts.since ?? new Date(Date.now() - 30 * DAY_MS);
  const signals = await fetchSurveillanceSignals(actor, jurisdictions, {
    since,
    adminProvince: opts.adminProvince,
    adminLocality: opts.adminLocality,
  });
  return computeDiseaseSummary(signals);
}

// ============================================================================
// Vigilancia metrics — E2
// ============================================================================

export type VigilanciaMetrics = {
  /** outbreak_signal events in scope, last 30 days. There is no status to
   *  filter on: the event is append-only and carries no close state, so this
   *  is a 30-day FLOW and resolved signals are still in it. (Corrected
   *  2026-09-16 — the docblock claimed a status predicate the query never
   *  had, and the tile's label had grown to match the docblock.) */
  outbreakActiveCount: number;
  /** cases where caseKind='rabies_observation' AND status='open'. */
  rabiesActiveCount: number;
  /** pets in scope created today, counted from 00:00 of the ARGENTINE calendar
   *  day (metric-honesty audit, PO 2026-09-16 — this used to be midnight UTC,
   *  i.e. 21:00 ART of the previous day, so the tile carried three hours of
   *  yesterday every evening). See `todayStart` below; the copy says so too. */
  petsRegisteredToday: number;
  /** pet_events where event_type='vaccination_administered' in scope, last 7 days. */
  vaccinationsThisWeek: number;
  /**
   * cases where caseKind='outbreak_investigation' AND status IN ('open','escalated').
   * Mirrors the active-status filter listOutbreakInvestigationsForGovt uses
   * (lib/infra/case-queries.ts) minus its 90-day recently-closed extension —
   * this is a live stock (cases still under active investigation right now),
   * not a period-bounded flow.
   */
  investigationActiveCount: number;
  /**
   * Signals in the same 30-day window that NO investigation is linked to.
   *
   * THE COUNTERWEIGHT TO `investigationActiveCount`, and it has to ship with
   * it. Pointing this screen at the expediente - a real stock, opened and
   * closed by people - is the honest move, but it trades one silence for
   * another: a jurisdiction where nobody triaged anything reads ZERO, exactly
   * like a jurisdiction where nothing happened. Measured on the seeded database
   * on 2026-09-17: 2137 signals, 0 investigations, 0 case events. Without this
   * number the screen would have answered "nothing to see" to that.
   */
  untriagedSignalCount: number;
};

// Canonical list of Argentine provinces for /gob/* dashboard pages.
// Admin pages use all 24; govt pages derive a subset from their jurisdictions.
// The ORDER is this page's own (largest first); the names come from the one
// list (lib/reference/ar-provincias.ts; lint:province-map refuses a copy).
const GOB_PROVINCE_ORDER = [
  "AR-C",
  "AR-B",
  "AR-X",
  "AR-S",
  "AR-M",
  "AR-T",
  "AR-E",
  "AR-A",
  "AR-N",
  "AR-H",
  "AR-W",
  "AR-K",
  "AR-U",
  "AR-P",
  "AR-Y",
  "AR-L",
  "AR-F",
  "AR-Q",
  "AR-R",
  "AR-J",
  "AR-D",
  "AR-Z",
  "AR-G",
  "AR-V",
] as const;

export const GOB_ALL_PROVINCES: Array<{ code: string; name: string }> = GOB_PROVINCE_ORDER.map(
  (code) => ({ code, name: provinceByCode(code)?.name ?? code }),
);

// Province-name → ISO 3166-2:AR code, DERIVED from the one list. The cases
// table stores the canonical display name (migration 0055 + check constraint
// enforcing the 24-enum). The GeoJSON uses ISO codes. Unknown provinces return
// code: "" — should be impossible after migration 0055.
export const PROVINCE_ISO_MAP: Record<string, string> = Object.fromEntries(
  PROVINCES.map((p) => [p.name, p.code]),
);

export async function fetchVigilanciaMetrics(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<VigilanciaMetrics> {
  const now = Date.now();
  const since30d = new Date(now - 30 * DAY_MS);
  const since7d = new Date(now - 7 * DAY_MS);
  // "Hoy" is the ARGENTINE calendar day (metric-honesty audit, PO 2026-09-16).
  //
  // This line used to build midnight UTC, with a comment inviting exactly this
  // change. Midnight UTC is 21:00 ART of the PREVIOUS day, so every evening
  // between 21:00 and 24:00 the "Altas registradas hoy" tile silently carried
  // three hours of yesterday — and an operator reading it at 22:00 got a number
  // that could not be reconciled with anything they would call "hoy".
  //
  // Composed from the two canonical helpers rather than rebuilt here:
  // `isoDateInAr` decides WHICH Argentine calendar day it is (Intl pinned to
  // AR_TIME_ZONE inside lib/utils/format.ts, the one module allowed raw Intl),
  // and `parseArDateStartOfDay` turns that day into its FIRST instant. Both are
  // already unit-tested; a third spelling of "start of the Argentine day" here
  // would be the second source of truth this repo keeps paying for.
  //
  // ON DST, because the offset inside `parseArDateStartOfDay` is an assumption
  // and assumptions deserve an expiry note: Argentina has observed no DST since
  // 2009 and sits at UTC-3 year-round, which is why that helper can hardcode
  // `-03:00`. If Argentina ever reintroduces DST, the day-selection half here is
  // ALREADY correct (it goes through the IANA zone), and the only wrong half
  // would be the fixed offset — which lives in ONE place, `date-input-ar.ts`.
  // Fix it there; do not add a zone-aware branch at this call site, or the next
  // window built from the helper will still be an hour off on switch days while
  // this one is right.
  //
  // The `??` fallback is unreachable and stays for the type, mirroring the same
  // pattern (and the same reasoning) in app/api/v1/me/caretaker-grants/commands.ts:
  // `isoDateInAr` emits en-CA "YYYY-MM-DD", which is exactly the shape
  // `parseArDateStartOfDay` accepts, so it never answers null here.
  const todayStart = parseArDateStartOfDay(isoDateInAr(new Date(now))) ?? new Date(now);

  // 1. Count outbreak_signal events from the last 30 days scoped to user.
  //    NOT "open": there is no open/closed notion on this event.
  const outbreakConditions = [
    eq(petEvents.eventType, "outbreak_signal"),
    gte(petEvents.occurredAt, since30d),
  ];
  const outbreakScope = outbreakSignalScopeClause(
    actor,
    jurisdictions,
    opts.adminProvince,
    opts.adminLocality,
  );
  if (outbreakScope) outbreakConditions.push(sql`(${outbreakScope})`);

  // 1b. Of those same signals, the ones no investigation is linked to.
  //     Deliberately derived from `outbreakConditions` rather than rebuilt: the
  //     two numbers are meant to be read against each other, so they must come
  //     from the same population and the same scope, or the comparison lies.
  const untriagedConditions = [
    ...outbreakConditions,
    sql`not exists (
      select 1
      from case_events ce
      where ce.entry_type = 'signal_link'
        and ce.payload->>'signal_event_id' = ${petEvents.id}::text
    )`,
  ];

  // 2. Count open cases with caseKind='rabies_observation'.
  const casesScope = casesScopeClause(actor, jurisdictions, opts.adminProvince, opts.adminLocality);

  // 3. Count pets created today.
  const petsConditions = [gte(pets.createdAt, todayStart)];
  const petsScope = petsScopeClause(actor, jurisdictions, opts.adminProvince, opts.adminLocality);
  if (petsScope) petsConditions.push(sql`(${petsScope})`);

  // 4. Count vaccination_administered events in the last 7 days.
  const vaccConditions = [
    eq(petEvents.eventType, "vaccination_administered"),
    gte(petEvents.occurredAt, since7d),
  ];
  // vaccination_administered does NOT carry a payload jurisdiction snapshot (only
  // outbreak_signal does) — scope by the pet's HOME jurisdiction (petsScope, reused
  // from arm 3) against the pets INNER JOIN added below. The previous
  // petEventsScopeClause here was the ghost-payload bug (zeroed this count for
  // every scoped-govt viewer). The outbreak arm above keeps its payload scope.
  if (petsScope) vaccConditions.push(sql`(${petsScope})`);

  // PF1 consolidation (2026-07-22, query-fan-out audit): arms 2 (rabies open
  // cases) and 5 (outbreak-investigation open|escalated cases) are the SAME
  // table (`cases`) scoped by the IDENTICAL `casesScope` predicate — neither
  // carries a time window, so they only differ in the counted condition. That
  // is exactly the "same table, same scope, same window" shape the fan-out
  // audit calls out — merged into ONE query with two `count(*) FILTER` arms
  // instead of two round-trips. Parity pinned in
  // __tests__/pf1-consolidation-parity.test.ts against independently-written
  // reference queries over seeded fixtures (multiple scopes).
  const [outbreakRows, untriagedRows, casesRows, petsRows, vaccRows] = await Promise.all([
    db
      .select({ n: count() })
      .from(petEvents)
      .where(and(...outbreakConditions)),
    db
      .select({ n: count() })
      .from(petEvents)
      .where(and(...untriagedConditions)),
    db
      .select({
        // The rabies expediente is a `bite_incident` case, NOT the
        // 'rabies_observation' string this used to count. That string is not a
        // member of CASE_KINDS: nothing in the app opens it and — the part that
        // broke — nothing closes it, so every row that ever carried it stayed
        // open forever. Measured on staging 2026-08-01: 12 such rows against 1
        // pet actually under observation, zero overlap, each already carrying
        // its cron-written `rabies_observation_ended`. The tile was reporting a
        // pile of immortal fixtures next to a live counter that said 1.
        //
        // `bite_incident` is the real thing on every axis: reportBite opens it
        // and emits `rabies_observation_started` in the SAME transaction (so
        // the two populations coincide by construction), its lifecycle declares
        // `terminalEvents: ['rabies_observation_ended']`, and all three closers
        // resolve it via findOpenBiteCase.
        //
        // 'escalated' counts alongside 'open' — same as the investigation arm
        // below. bite-incident.ts declares escalated as a valid status (a
        // rabies-compatible symptom during observation); counting only 'open'
        // would drop the single highest-risk expediente out of a RABIES
        // counter. No writer escalates a bite case today (escalateCase is wired
        // only for outbreaks), so this is free now and correct if that declared
        // path is ever implemented.
        rabies:
          sql<number>`count(*) filter (where ${cases.caseKind} = 'bite_incident' and ${cases.status} in ('open', 'escalated'))`.mapWith(
            Number,
          ),
        investigation:
          sql<number>`count(*) filter (where ${cases.caseKind} = 'outbreak_investigation' and ${cases.status} in ('open', 'escalated'))`.mapWith(
            Number,
          ),
      })
      .from(cases)
      .where(casesScope ?? sql`true`),
    db
      .select({ n: count() })
      .from(pets)
      .where(and(...petsConditions)),
    db
      .select({ n: count() })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(and(...vaccConditions)),
  ]);

  return {
    outbreakActiveCount: outbreakRows[0]?.n ?? 0,
    rabiesActiveCount: casesRows[0]?.rabies ?? 0,
    petsRegisteredToday: petsRows[0]?.n ?? 0,
    vaccinationsThisWeek: vaccRows[0]?.n ?? 0,
    investigationActiveCount: casesRows[0]?.investigation ?? 0,
    untriagedSignalCount: untriagedRows[0]?.n ?? 0,
  };
}

/**
 * Prior-week vaccination_administered count, for the /gob/vigilancia deltaV2
 * chip on "Vacunaciones (7d)".
 *
 * Mirrors fetchVigilanciaMetrics' vaccination arm EXACTLY (same event type,
 * same petsScope — vaccination_administered carries no payload jurisdiction
 * snapshot, so scope is by the pet's HOME jurisdiction) but the 7-day window
 * shifted one full week back: [since7d − 7d, since7d) instead of [since7d, now).
 * Consumed via formatDelta (lib/analytics/campaign-metrics.ts) for an honest
 * "vs semana anterior" comparison.
 *
 * outbreakActiveCount / rabiesActiveCount are NOT given a matching prev-period
 * fetcher here, but for DIFFERENT reasons, and conflating them is what put a
 * false "status snapshot" claim on the outbreak count for so long.
 *   - rabiesActiveCount really is an open-status snapshot (a stock): it reads
 *     cases with status='open', and reopening/closing shifts it independent of
 *     when anything fired, so a period delta would read a status change as an
 *     activity trend.
 *   - outbreakActiveCount is a 30-day FLOW (see the type above). It gets no
 *     delta because a 30-day trailing window compared against the previous
 *     30 days double-counts most of its own rows, not because it is a stock. petsRegisteredToday is a genuine flow but only
 * covers a PARTIAL day-in-progress — comparing it to a full prior day (or a
 * same-hour-yesterday slice) is an inconsistent denominator that reads as a
 * false swing early in the day, so it is skipped too (see the deltaV2-extend
 * writeup, engram topic filtros/deltav2-extend).
 *
 * @param actor - The DashboardActor (role) making the request.
 * @param jurisdictions - The actor's scoped jurisdictions (empty for admin).
 * @param opts - Optional admin province/locality drill-down.
 */
export async function fetchPrevVaccinationsWeek(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<number> {
  const now = Date.now();
  const since7d = new Date(now - 7 * DAY_MS);
  const prevSince7d = new Date(now - 14 * DAY_MS);

  const petsScope = petsScopeClause(actor, jurisdictions, opts.adminProvince, opts.adminLocality);

  const conditions = [
    eq(petEvents.eventType, "vaccination_administered"),
    gte(petEvents.occurredAt, prevSince7d),
    lt(petEvents.occurredAt, since7d),
  ];
  if (petsScope) conditions.push(sql`(${petsScope})`);

  const [row] = await db
    .select({ n: count() })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .where(and(...conditions));

  return row?.n ?? 0;
}

// ============================================================================

export type LocalityCaseCount = {
  province: string;
  locality: string;
  /**
   * ISO 3166-2:AR code matching the GeoJSON `code` property if known.
   * Empty string if the province is not in PROVINCE_ISO_MAP.
   */
  code: string;
  count: number;
};

/**
 * The raw query: open EPIDEMIOLOGICAL cases grouped by (province, locality),
 * UNSUPPRESSED. NOT EXPORTED — see the A06-1 docblock on `fetchCasesPerLocality`
 * below for why a raw locality-grain reader must never leave this module.
 * Both `fetchCasesPerLocality` (locality-grain, k-anon'd) and
 * `fetchCasesPerProvinceChoropleth` (province-grain, k-anon'd at the coarser
 * grain) share this one query.
 *
 * KIND-NARROWED (audit 2026-07-26, red #4) — see fetchCasesPerLocality's
 * docblock for the full reasoning; unchanged by the A06-1 split.
 *
 * Province code mapping: uses PROVINCE_ISO_MAP (derived from PROVINCES). The cases table
 * stores jurisdictionProvince as free-text; the GeoJSON uses ISO 3166-2:AR codes.
 * Cases in provinces not present in the map return code: "".
 */
async function fetchCasesPerLocalityRaw(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<LocalityCaseCount[]> {
  const conditions = [
    eq(cases.status, "open"),
    inArray(cases.caseKind, [...EPIDEMIOLOGICAL_CASE_KINDS]),
  ];
  const scope = casesScopeClause(actor, jurisdictions, opts.adminProvince, opts.adminLocality);
  if (scope) conditions.push(sql`(${scope})`);

  const rows = await db
    .select({
      province: cases.jurisdictionProvince,
      locality: cases.jurisdictionLocality,
      n: count(),
    })
    .from(cases)
    .where(and(...conditions))
    .groupBy(cases.jurisdictionProvince, cases.jurisdictionLocality);

  return rows
    .filter((r) => r.province !== null)
    .map((r) => ({
      province: r.province as string,
      locality: r.locality ?? "",
      code: PROVINCE_ISO_MAP[r.province as string] ?? "",
      count: r.n,
    }));
}

/**
 * Counts of open EPIDEMIOLOGICAL cases grouped by (province, locality),
 * k-anon suppressed AT LOCALITY GRAIN. For a consumer that genuinely needs
 * per-locality numbers (a table, a CSV, a tooltip) — NOT what
 * /gob/vigilancia's province choropleth uses; see
 * `fetchCasesPerProvinceChoropleth` below for that.
 *
 * KIND-NARROWED (audit 2026-07-26, red #4). This used to be every open case
 * kind, so an open `custody_episode` — a custody dispute over one animal —
 * rendered as a filled cell on the OFFICIAL surveillance map, indistinguishable
 * from a rabies exposure. A map on a vigilancia screen makes an epidemiological
 * claim by placement alone; the only defensible fix is to count only what can
 * back that claim. The subset is EPIDEMIOLOGICAL_CASE_KINDS
 * (src/modules/cases/domain/case-kinds.ts) — the domain owns which kinds are
 * disease signals, not this analytics module.
 *
 * This narrowing DIVERGES this number from /gob/analytics'
 * `fetchCasesPerCapita`, which still counts every kind — deliberately, see its
 * own jsdoc. Two different numbers are fine because they no longer share a
 * name: this one is "casos epidemiológicos abiertos" everywhere it renders,
 * that one is "casos abiertos (todos los tipos)". Both screens say which they
 * are. If either label ever collapses back to a bare "casos abiertos", this
 * divergence becomes a lie — keep the labels, or re-unify the queries.
 *
 * BRANDED RETURN (audit A06-1, 2026-09). This groups by locality, so
 * `lib/metrics/anonymity.ts`'s k-anon boundary applies — the same rule
 * `fetchCasesPerSubregion` and every other locality-grouped fetcher in this
 * module already honour. Returning raw `LocalityCaseCount[]` compiled fine
 * and shipped, but nothing stopped it: a direct consumer (a table, a CSV, a
 * tooltip keyed by locality) would have rendered sub-k cells unopposed, with
 * no fence and no type error to catch it. `MetricResult<SuppressedCells>`
 * makes that impossible to construct without routing through
 * `suppressSmallCells` first — enforced at compile time, not by review.
 *
 * NOT a raw locality→province fold path (fix-round 2, 2026-09): the first
 * cut of this fix had the province choropleth fold THESE already-suppressed
 * locality cells to province grain, which silently undercounts a province
 * whenever its only open cases sit below k=5 per locality — worse for a
 * health authority than the original gap, because it looks like a true zero.
 * `fetchCasesPerProvinceChoropleth` folds the RAW rows instead and suppresses
 * once, at the grain that is actually displayed.
 */
export async function fetchCasesPerLocality(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<MetricResult<SuppressedCells>> {
  const localityRows = await fetchCasesPerLocalityRaw(actor, jurisdictions, opts);
  return suppressedMetric(localityRows, {
    count: (r) => r.count,
    key: (r) => `${r.province}::${r.locality}`,
  });
}

/**
 * {code, value, label, suppressed?} — structurally identical to
 * `lib/analytics/choropleth-data.ts`'s `ChoroplethCell` (consumed by
 * MapChoropleth's `data` prop). Declared locally rather than imported: this
 * module is already imported BY choropleth-data.ts (for PROVINCE_ISO_MAP, via
 * the `govt-dashboards` barrel), and importing choropleth-data.ts back would
 * create a real cycle — not merely a lint-fence concern but a genuine runtime
 * one, since choropleth-data.ts reads PROVINCE_ISO_MAP at MODULE TOP LEVEL
 * (`PROVINCE_NAME_BY_ISO`'s initializer), which throws
 * "Cannot convert undefined or null to object" the moment the cycle resolves
 * in this direction (reproduced while wiring this function; not a hypothetical).
 */
export type ProvinceChoroplethCell = {
  code: string;
  value: number;
  label: string;
  suppressed?: boolean;
};

/** Reverse of PROVINCE_ISO_MAP, for labelling province cells. */
const PROVINCE_NAME_BY_ISO: Record<string, string> = Object.fromEntries(
  Object.entries(PROVINCE_ISO_MAP).map(([name, code]) => [code, name]),
);

/** Same grouping choropleth-data.ts uses for complementary suppression on a
 *  province-grain map: the country is the one level above a province. */
const NATIONAL_GROUP = "AR";

/**
 * Open EPIDEMIOLOGICAL cases folded to PROVINCE grain and k-anon suppressed
 * AT THAT GRAIN — the actual display grain of the <MapChoropleth
 * metric="cases_open"> on /gob/vigilancia. Fixes A06-1 without the undercount
 * a locality-then-fold approach would carry (see `fetchCasesPerLocality`'s
 * docblock): the RAW per-locality rows are summed into province totals
 * first, and suppression runs once, on those totals — a province whose cases
 * are split across several sub-k localities still shows its true total the
 * moment that total reaches k.
 *
 * Same algorithm as `lib/analytics/choropleth-data.ts`'s
 * `aggregateChoroplethData` (primary suppression via `suppressSmallCells`,
 * then complementary/differencing suppression via `complementarySuppress`
 * grouped nationally, then every code — suppressed or not — is emitted so a
 * hidden province stipples on the map instead of vanishing as "sin datos") —
 * reimplemented here rather than imported, for the module-cycle reason on
 * `ProvinceChoroplethCell` above. Any change to that algorithm should be
 * mirrored here.
 *
 * Split into a pure fold (`foldCasesPerProvince` below) precisely so a parity
 * test can prove the two implementations still agree: feed the same
 * `LocalityCaseCount[]` fixture through this fold and through
 * `aggregateChoroplethData` (keyOf: r => r.code, getValue: r => r.count) and
 * assert `toEqual`. This module still cannot IMPORT choropleth-data.ts (same
 * cycle), so the two stay proven equivalent by test on shared fixtures, not
 * by sharing code.
 */
export function foldCasesPerProvince(localityRows: LocalityCaseCount[]): ProvinceChoroplethCell[] {
  const codeToValue = new Map<string, number>();
  for (const row of localityRows) {
    if (!row.code) continue;
    codeToValue.set(row.code, (codeToValue.get(row.code) ?? 0) + row.count);
  }
  const cells = Array.from(codeToValue.entries()).map(([code, value]) => ({ code, value }));

  const { visible, suppressed } = suppressSmallCells(
    cells.filter((c) => c.value > 0),
    { count: (c) => c.value, key: (c) => c.code },
  );
  const { suppressed: allSuppressed } = complementarySuppress(
    visible as unknown as ReadonlyArray<{ code: string; value: number }>,
    suppressed,
    { group: () => NATIONAL_GROUP, count: (c) => c.value },
  );
  const suppressedCodes = new Set(allSuppressed.map((c) => c.code));

  return cells.map((c) => {
    const label = PROVINCE_NAME_BY_ISO[c.code] ?? c.code;
    return suppressedCodes.has(c.code)
      ? { code: c.code, value: 0, suppressed: true, label }
      : { code: c.code, value: c.value, label };
  });
}

export async function fetchCasesPerProvinceChoropleth(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<ProvinceChoroplethCell[]> {
  const localityRows = await fetchCasesPerLocalityRaw(actor, jurisdictions, opts);
  return foldCasesPerProvince(localityRows);
}

// ============================================================================

export type { SubregionAggregate, SubregionCaseCount } from "../subregion-redaction";

const NO_SUBREGION_DATA: SubregionAggregate = {
  cells: [],
  sinUbicacion: { count: 0, suppressed: false },
};

/**
 * Open EPIDEMIOLOGICAL cases per sub-region within a selected province — the
 * FULL sub-region set.
 *
 * Kind-narrowed to EPIDEMIOLOGICAL_CASE_KINDS for the SAME reason as
 * `fetchCasesPerLocality` above (audit 2026-07-26, red #4) — and it MUST stay
 * in lockstep with it: this is the province drill of that very map, so a
 * department cell that counted more kinds than the province cell it drills
 * into would make the total shrink as the operator zooms in.
 *
 * Returns EVERY sub-region of the province (not only those with cases), each with
 * its open-case count (0 when there are none). This lets the caller frame and
 * render the whole province: sub-regions with 0 cases render grey via the
 * choropleth's missing-color branch.
 *
 * Thin wrapper (reusable-drill extraction, design/scoped-choropleth-drill,
 * engram #1481): fetches this screen's own open-cases-per-locality rows, then
 * folds them to department/barrio grain via the shared
 * aggregateRowsByDepartment (lib/analytics/subregion-aggregate.ts), which also
 * enforces the k=5 k-anonymity floor. Signature unchanged for existing callers.
 *
 * Scope is enforced by casesScopeClause (same as all other cases fetchers).
 * Admin always sees all cases; govt sees only their assigned localities.
 *
 * Returns the fold's residual too (`sinUbicacion`, L1·1): open cases in the
 * province that land in no department/barrio, k-protected like the cells.
 */
export async function fetchCasesPerSubregion(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  provinceIso: string,
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<SubregionAggregate> {
  const scope = casesScopeClause(actor, jurisdictions, opts.adminProvince, opts.adminLocality);
  // Govt with no assignments can never see any case. NOTE: this must key off
  // actor.role, not `scope !== null` — an admin+adminProvince drill-down now
  // also produces a non-null scope, and admin's jurisdictions is always []
  // by contract, so a `scope !== null && jurisdictions.length === 0` check
  // would have wrongly zeroed the admin drill-down result.
  if (!hasNationalReadScope(actor.role) && jurisdictions.length === 0) return NO_SUBREGION_DATA;

  // Cases store the canonical province display name (migration 0055's
  // 24-enum check constraint); CABA is stored literally as "CABA" (not
  // "Ciudad Autónoma de Buenos Aires", which is ar_localities' province row name).
  const provinceDisplayName = provinceIso === "AR-C" ? "CABA" : provinceByCode(provinceIso)?.name;
  if (!provinceDisplayName) return NO_SUBREGION_DATA;

  const conditions = [
    eq(cases.status, "open"),
    inArray(cases.caseKind, [...EPIDEMIOLOGICAL_CASE_KINDS]),
    eq(cases.jurisdictionProvince, provinceDisplayName),
  ];
  if (scope) conditions.push(sql`(${scope})`);

  const caseRows = await db
    .select({ locality: cases.jurisdictionLocality, n: count() })
    .from(cases)
    .where(and(...conditions))
    .groupBy(cases.jurisdictionLocality);

  return aggregateRowsByDepartment(
    provinceIso,
    caseRows.map((r) => ({ locality: r.locality, value: r.n })),
  );
}

// ============================================================================

export type ProvinceCasesPerCapita = {
  province: string;
  /**
   * ISO 3166-2:AR code matching the GeoJSON `code` property if known.
   * Empty string if the province is not in PROVINCE_ISO_MAP.
   */
  code: string;
  /**
   * Count of open cases in this province, or `null` when the cell is WITHHELD
   * by k-anonymity (RA-3 C4). NEVER 0 for a withheld cell: a false zero is
   * itself a disclosure (it says "sub-k" just as loudly as the real number,
   * and reads as real data) — see SUPPRESSED_MARKER's own note in
   * lib/open-data/province-suppression.ts.
   */
  count: number | null;
  /**
   * Cases per 10,000 inhabitants (count / population * 10_000), rounded to
   * one decimal. `null` when there is no census row for the province (avoids
   * divide-by-zero; the UI falls back to showing the raw count in that case)
   * — OR when the cell is k-anon suppressed. Branch on `suppressed` FIRST:
   * the two nulls mean different things and must render differently ("sin
   * censo, conteo bruto N" vs "protegido por privacidad").
   */
  ratePer10k: number | null;
  /**
   * k-anonymity (k = ANONYMITY_K = 5, AGENTS.md "Aggregation & privacy
   * policy"): true when this province has 1..k-1 open cases. A rate is not
   * exempt — it publishes its own numerator once the denominator (INDEC 2022
   * population, public) is known, so the rate is suppressed with the count.
   */
  suppressed: boolean;
};

/**
 * Open cases per province with INDEC 2022 per-capita rate.
 *
 * Aggregates open cases by jurisdictionProvince, then LEFT JOINs the
 * jurisdictions_census table (province_name = jurisdiction_province) to
 * compute rate = count / population * 10_000.
 *
 * Join key: cases.jurisdictionProvince (canonical display name, same format
 * as jurisdictionsCensus.provinceName — both enforced by migration 0055
 * canonical check constraint). Match is exact text equality.
 *
 * Fallback: provinces with no census row get ratePer10k = null so callers
 * can display the raw count as a safe fallback.
 *
 * k-ANONYMITY (RA-3 C4, 2026-07-31). Every returned province is routed through
 * `suppressSmallCells` at the shared ANONYMITY_K before it leaves this module.
 * A province with 1..4 open cases publishes `count: null, ratePer10k: null,
 * suppressed: true` — the row survives (a row that VANISHES at k makes absence
 * the disclosure channel, the same trap `toChoroplethData` documents) but
 * carries no number on either side.
 *
 * Why the RATE is suppressed too and not just the count: the denominator is
 * INDEC 2022, a published national census. `count = rate × population / 10_000`
 * is a one-line inversion, so publishing the rate publishes the count. This is
 * the same "a rate reveals its denominator" finding that made #40c non-exempt.
 *
 * Suppressed rows are NOT dropped from the return value on purpose: the render
 * has to be able to say HOW MANY provinces it is withholding (the disclosure
 * half of the rule), and it can only count what it receives.
 *
 * PRIMARY suppression only — no complementary (differencing) pass. The
 * complementary rule exists to protect a lone suppressed cell against
 * subtraction from a coarser PUBLISHED total over the same partition
 * (`complementarySuppress` jsdoc); /gob/analytics publishes no national
 * open-case total, so there is nothing to subtract from. This matches the
 * proven standard already on that same page — `fetchVetAccessByLocality` is
 * primary-only for the same reason. If a national open-case KPI is ever added
 * to this screen, this fetcher MUST gain the complementary pass with it.
 *
 * NOT scoped by `case_kind` — still deliberate, but the reason CHANGED on
 * 2026-08-07 and the old one is now wrong, so it is rewritten rather than kept.
 *
 * It used to read "narrowing one of the two would put two different numbers
 * under one name across two screens", pointing at /gob/vigilancia's choropleth
 * as the twin that had to stay identical. That twin IS now narrowed
 * (`fetchCasesPerLocality`, audit 2026-07-26 red #4): a surveillance MAP makes
 * an epidemiological claim by placement, and custody episodes cannot back it.
 * This table makes no such claim — it is a per-capita ranking of regulatory
 * load on /gob/analytics, where "cuántos expedientes abiertos por habitante"
 * is the honest question and every kind belongs in it.
 *
 * So the two numbers now differ ON PURPOSE, and the rule that replaces "same
 * number" is "different names": this one renders as "casos abiertos (todos los
 * tipos)" with its inventory spelled out below the table, the map renders as
 * "casos epidemiológicos abiertos". Neither may drop its qualifier.
 *
 * Narrowing here would also SHRINK every cell, which raises re-identifiability
 * rather than lowering it — an independent reason to leave this one wide.
 */
export async function fetchCasesPerCapita(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
): Promise<ProvinceCasesPerCapita[]> {
  const conditions = [eq(cases.status, "open")];
  const scope = casesScopeClause(actor, jurisdictions);
  if (scope) conditions.push(sql`(${scope})`);

  // Aggregate by province only (no locality grouping — per-capita is a
  // province-level figure because the census table is province-level).
  // The LEFT JOIN is 1:1 (province_name is the PK of jurisdictions_census),
  // so grouping by province alone and using MAX(population) is safe.
  const rows = await db
    .select({
      province: cases.jurisdictionProvince,
      n: count(),
      population: sql<string | null>`MAX(${jurisdictionsCensus.population})`,
    })
    .from(cases)
    .leftJoin(
      jurisdictionsCensus,
      and(
        eq(jurisdictionsCensus.provinceName, cases.jurisdictionProvince),
        eq(jurisdictionsCensus.censusYear, 2022),
      ),
    )
    .where(and(...conditions))
    .groupBy(cases.jurisdictionProvince);

  const raw = rows
    .filter((r) => r.province !== null)
    .map((r) => {
      const pop = r.population !== null ? Number(r.population) : null;
      const ratePer10k =
        pop !== null && pop > 0 ? Math.round((r.n / pop) * 10_000 * 10) / 10 : null;
      return {
        province: r.province as string,
        code: PROVINCE_ISO_MAP[r.province as string] ?? "",
        count: r.n,
        ratePer10k,
      };
    });

  // k-anon at the shared ANONYMITY_K — the SAME primitive the locality,
  // department and open-data tiers use. No second k is defined here.
  const { suppressed } = suppressSmallCells(raw, {
    count: (r) => r.count,
    key: (r) => r.province,
  });
  const suppressedProvinces = new Set(suppressed.map((r) => r.province));

  return raw.map((r) =>
    suppressedProvinces.has(r.province)
      ? { province: r.province, code: r.code, count: null, ratePer10k: null, suppressed: true }
      : { ...r, suppressed: false },
  );
}

// ============================================================================

export type ZoonosisTrendPoint = {
  /** Pre-formatted x-axis label, e.g. "ene.", "feb.". Month abbreviation in es-AR locale. */
  x: string;
  /** Count of outbreak_signal events in that month. */
  y: number;
  /** ISO date of the period start (month start), for upstream sorting. */
  periodStart: string;
};

/**
 * Outbreak signal counts grouped by month, last 12 months, within the user's
 * scope. Used for <TimeSeriesChart> on /gob/vigilancia.
 *
 * We use date_trunc('month', occurred_at) to group by calendar month. The
 * pet_events table lacks a dedicated "event_category" column — we match on
 * eventType LIKE 'outbreak_%' by listing all known outbreak_* event types.
 * Currently only 'outbreak_signal' exists; this pattern extends naturally.
 */
export async function fetchZoonosisTrend(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { since?: Date; adminProvince?: string; adminLocality?: string } = {},
): Promise<ZoonosisTrendPoint[]> {
  const since12m = opts.since ?? new Date(Date.now() - 365 * DAY_MS);

  const conditions = [
    sql`${petEvents.eventType} LIKE ${"outbreak_%"}`,
    gte(petEvents.occurredAt, since12m),
  ];
  const scope = outbreakSignalScopeClause(
    actor,
    jurisdictions,
    opts.adminProvince,
    opts.adminLocality,
  );
  if (scope) conditions.push(sql`(${scope})`);
  // Payload jurisdiction is an event-time snapshot — also require the pet's
  // CURRENT jurisdiction in scope (scope-security review 2026-07-04 A2).
  const petsGuard = petsCurrentJurisdictionExists(
    actor,
    jurisdictions,
    opts.adminProvince,
    opts.adminLocality,
  );
  if (petsGuard) conditions.push(petsGuard);

  const rows = await db
    .select({
      month: sql<string>`date_trunc('month', ${petEvents.occurredAt})`,
      n: count(),
    })
    .from(petEvents)
    .where(and(...conditions))
    .groupBy(sql`date_trunc('month', ${petEvents.occurredAt})`)
    .orderBy(sql`date_trunc('month', ${petEvents.occurredAt})`);

  return rows.map((r) => {
    const d = new Date(r.month);
    return {
      // r.month is a date_trunc('month') UTC boundary — pin UTC so the label
      // names the bucket month (an ambient/AR render shifts midnight-UTC
      // boundaries into the PREVIOUS month).
      x: d.toLocaleString("es-AR", { month: "short", timeZone: "UTC" }),
      y: r.n,
      periodStart: d.toISOString(),
    };
  });
}

// ============================================================================

export type OutbreakHistoryRow = {
  diseaseCode: string;
  diseaseName: string;
  locality: string;
  province: string;
  /**
   * ISO date (YYYY-MM-DD) of the calendar day with the highest number of
   * outbreak_signal events for this (disease_code, locality, province) group.
   * Tie-break: highest signal count first, then most-recent day.
   */
  peakDate: string;
  /**
   * Most recent signal in the cluster (MAX(occurred_at)) — the field the query
   * actually ORDERs BY. It was computed and used for ordering but never
   * returned, so the promised ordering was unverifiable from outside; the test
   * that tried ended up asserting `peakDate` instead, a DIFFERENT quantity that
   * only agreed by luck (measured: 1 violating pair in 100). Surfacing it makes
   * "most recently active first" checkable, and answers the surveillance
   * question the ordering exists for: where is something still happening?
   */
  lastSeen: string;
  /** Total outbreak_signal events from this disease in this locality, full history. */
  totalSignals: number;
};

/**
 * The k-anonymised outbreak history: the rows that may be published, plus the
 * count of the ones that may not.
 *
 * `suppressedCount` is NOT decoration — it is the disclosure half of the rule.
 * Without it the table cannot tell "nobody ever reported an outbreak here" from
 * "every outbreak here is a group of fewer than k", and it renders the former,
 * which is a lie in the direction that matters (an all-clear that was never
 * measured).
 */
export type OutbreakHistoryResult = {
  rows: OutbreakHistoryRow[];
  /** (disease, locality, province) groups withheld by k-anon — counted, never listed. */
  suppressedCount: number;
};

/**
 * Historical outbreaks grouped by (disease_code, disease_label, locality, province),
 * ordered by most-recent signal descending.
 *
 * peakDate = the calendar day (date_trunc('day', occurred_at)::date) that
 * had the most outbreak_signal events within the group. Ties broken by most-
 * recent day. Group-level totalSignals counts all signals across all days.
 *
 * Implemented as a three-CTE query (daily → peak → totals) joined together so
 * that per-day counts, busiest-day selection (DISTINCT ON), and group totals
 * are each computed in a single pass.
 *
 * Scope via outbreak_signal payload fields pet_jurisdiction_province/locality
 * (same as fetchSurveillanceSignals). No time restriction — full history.
 *
 * k-ANONYMITY (RA-3 C3, 2026-07-31 — the highest-re-identifiability finding in
 * that report). A row here is a (disease, LOCALITY, province, peak DAY) tuple.
 * At `totalSignals = 1` the row reads "Rabia · Ushuaia · Tierra del Fuego ·
 * 12 mar 2026 · 1": one animal, one locality, one date, a reportable disease.
 * Every attribute of the row is a quasi-identifier of the same small group, so
 * blanking only the number is not enough — the ROW is the disclosure. Sub-k
 * groups are therefore DROPPED and COUNTED, not blanked.
 *
 * This is the standard already proven on the very page that renders this table:
 * `fetchVetAccessByLocality` (lib/metrics/vet-access.ts) drops sub-k localities
 * and hands back `suppressedCount`, and /gob/analytics announces it in the
 * card header. Same primitive (`suppressSmallCells`), same k (ANONYMITY_K),
 * same disclosure shape — no second mechanism.
 *
 * PRIMARY suppression only, deliberately: complementary (differencing)
 * suppression defends a lone hidden cell against subtraction from a coarser
 * PUBLISHED total over the SAME partition. Nothing on this page publishes a
 * per-disease or per-province lifetime signal total (the trend card is
 * period-bounded, all-disease, and separately suppressed), so there is no
 * subtraction to defend against. Add the pass together with any future
 * lifetime total, not before — see `complementarySuppress`'s jsdoc.
 */
export async function fetchOutbreakHistory(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  opts: { adminProvince?: string; adminLocality?: string } = {},
): Promise<OutbreakHistoryResult> {
  if (!hasNationalReadScope(actor.role) && jurisdictions.length === 0)
    return { rows: [], suppressedCount: 0 };

  // Build the jurisdiction scope clause once; reused in both CTEs. The pets
  // guard (EXISTS on the pet's CURRENT jurisdiction) closes the payload-drift
  // hole for govt viewers (scope-security review 2026-07-04 A2).
  const scope = outbreakSignalScopeClause(
    actor,
    jurisdictions,
    opts.adminProvince,
    opts.adminLocality,
  );
  const petsGuard = petsCurrentJurisdictionExists(
    actor,
    jurisdictions,
    opts.adminProvince,
    opts.adminLocality,
  );
  const scopeFragment = sql.join(
    [scope ? sql` AND (${scope})` : sql``, petsGuard ? sql` AND ${petsGuard}` : sql``],
    sql``,
  );

  type RawRow = {
    disease_code: string;
    disease_label: string | null;
    province: string;
    locality: string;
    peak_day: string;
    total_signals: number;
    last_seen: string;
  };

  // THE GROUP IS (disease_code, province, locality) — three columns, and
  // `disease_label` is deliberately NOT one of them. It is free text chosen by
  // whichever writer emitted the signal: the production use cases funnel it
  // through `findDisease()`, `scripts/seed-panorama.ts` writes "Rabia
  // (sospechada)", older/foreign writers store the raw code. Grouping by it
  // split ONE locality's outbreak into one SQL row per spelling while the
  // suppression key below still saw a single group — the visible row
  // under-counted and `suppressedCount` reported a suppression that protected
  // nobody, since the same signals were published under the other spelling
  // (CI run 32525430323). The label is now an OUTPUT of the group, not part of
  // its identity: `MAX(disease_label)` picks one stored spelling as a fallback
  // for codes the catalog does not know, and the catalog lookup below overrides
  // it for every code it does.
  const rows = (await db.execute(sql`
    WITH daily AS (
      -- Per-(group, day) signal counts. Groups share the same 3-tuple key.
      SELECT
        (${petEvents.payload}->>'disease_code')                                AS disease_code,
        COALESCE((${petEvents.payload}->>'pet_jurisdiction_province'), '')      AS province,
        COALESCE((${petEvents.payload}->>'pet_jurisdiction_locality'), '')      AS locality,
        date_trunc('day', ${petEvents.occurredAt})::date                        AS day,
        COUNT(*)::int                                                           AS day_count
      FROM ${petEvents}
      WHERE ${petEvents.eventType} = 'outbreak_signal'${scopeFragment}
      GROUP BY disease_code, province, locality, day
    ),
    peak AS (
      -- Pick the single busiest day per group.
      -- Tie-break: most signals first, then most-recent day.
      SELECT DISTINCT ON (disease_code, province, locality)
        disease_code,
        province,
        locality,
        day AS peak_day
      FROM daily
      ORDER BY disease_code, province, locality,
               day_count DESC, day DESC
    ),
    totals AS (
      -- Group-level aggregates: total signal count + last-seen timestamp
      -- (used for ordering the final result) + one stored label spelling.
      -- MAX over the COALESCE'd text, so a real label always beats the '' a
      -- missing disease_label collapses to.
      SELECT
        (${petEvents.payload}->>'disease_code')                                AS disease_code,
        COALESCE((${petEvents.payload}->>'pet_jurisdiction_province'), '')      AS province,
        COALESCE((${petEvents.payload}->>'pet_jurisdiction_locality'), '')      AS locality,
        MAX(COALESCE((${petEvents.payload}->>'disease_label'), ''))             AS disease_label,
        COUNT(*)::int                                                           AS total_signals,
        MAX(${petEvents.occurredAt})                                            AS last_seen
      FROM ${petEvents}
      WHERE ${petEvents.eventType} = 'outbreak_signal'${scopeFragment}
      GROUP BY disease_code, province, locality
    )
    SELECT
      t.disease_code,
      t.disease_label,
      t.province,
      t.locality,
      p.peak_day,
      t.total_signals,
      t.last_seen
    FROM totals t
    JOIN peak p USING (disease_code, province, locality)
    ORDER BY t.last_seen DESC
    LIMIT 100
  `)) as RawRow[];

  const mapped: OutbreakHistoryRow[] = rows.map((r) => ({
    diseaseCode: r.disease_code,
    diseaseName: findDisease(r.disease_code)?.label ?? (r.disease_label || null) ?? r.disease_code,
    locality: r.locality,
    province: r.province,
    // peak_day arrives as a Postgres ::date string (YYYY-MM-DD); wrap in Date
    // only to normalise, then emit as ISO date string.
    peakDate: new Date(r.peak_day).toISOString(),
    totalSignals: r.total_signals,
    lastSeen: new Date(r.last_seen).toISOString(),
  }));

  // k-anon at the shared ANONYMITY_K (no `k` override — the policy number has
  // exactly one home, lib/metrics/anonymity.ts). No rollup: folding sub-k
  // groups into a coarser bucket would have to name a disease or a province to
  // be useful, and either one re-opens the leak this suppression closes.
  const { visible, suppressedCount } = suppressSmallCells(mapped, {
    count: (r) => r.totalSignals,
    // This key is the SQL GROUP BY, column for column: (disease_code, province,
    // locality). That is not a coincidence to be re-checked by hand — it is the
    // invariant. A grouping wider than the suppression key hands this primitive
    // several rows where it thinks it has one, and every count it then compares
    // against ANONYMITY_K is a fragment of the real group.
    key: (r) => `${r.diseaseCode}::${r.province}::${r.locality}`,
  });

  return { rows: visible as unknown as OutbreakHistoryRow[], suppressedCount };
}
