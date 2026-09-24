# Projection primitives (`lib/metrics/`) — design spec

> **Status:** 🟢 Ready for Claude Code · **Date:** 2026-06-18 · **Item 0 (Phase 0) of the metrics-IA handoff**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` · **Blocks Items 2, 3, 4**

## 1. Por qué este documento existe

MiMAR has **two** projection patterns and only one is governed:

- **Pattern A — pure replay** (`lib/projections/*`): pure functions, per-pet, deterministic event replay, harness-tested. Blessed as "first-class" in `docs/architecture/hexagonal-lite.md`.
- **Pattern B — aggregate fetchers** (`lib/govt-dashboards.ts`, `lib/govt-home-kpis.ts`, `lib/admin-metrics.ts`): population-level SQL aggregates. This is the layer every dashboard reads — and it has **no shared contract, no doc, and several duplications**.

An audit on 2026-06-18 found, with file evidence:

1. **Scope helpers are duplicated.** `petsScopeClause` / `petEventsScopeClause` are defined **twice** — once in `lib/govt-dashboards.ts` and once in `lib/govt-home-kpis.ts` — and the jurisdiction-pair predicate is **re-derived inline ~14×** across fetchers even though the helper exists. They can (and will) drift.
2. **The denominator is copy-pasted.** "active pets in scope" (`status IN ('active','lost')` + species + jurisdiction) is re-expressed per fetcher, with comments like *"Mirrors the 'active','lost' scope used by fetchAnalyticsMetrics"* instead of a shared function. The rabies-regex undercount bug already documented in `fetchRabiesCoverage` is this exact failure class.
3. **k-anonymity is documented but not implemented.** `AGENTS.md → Aggregation & privacy policy` mandates `k=5` suppression; column comments say "K-anonymity rollups group on this column" — but **no suppression code exists**. Every locality-grouped tile (current and future) can leak sub-5 cells.
4. **Period contract is inconsistent.** `/gob/analytics` uses `resolveAnalyticsPeriod` (period picker); `/gob` home KPIs hardcode `since12m`/`since30d`/`since7d`. The *same metric label* means a different window on different screens.
5. **No caching / query dedup.** All dashboard pages are `force-dynamic`; each tile issues independent COUNTs; the shared base ("active pets in scope") is recomputed N times per render. Items 2–4 add ~15 tiles on top of this.

This spec codifies **Pattern B** as a small shared foundation under `lib/metrics/` **before** the metric items pour ~15 tiles onto it. It is mostly a **refactor + one new privacy boundary**; it changes no metric's intended value (except where a value was already wrong, e.g. an unsuppressed small cell or a drifted denominator).

## 2. Decisiones cerradas

- **D1 — One home: `lib/metrics/`.** All Pattern-B shared primitives live here. Existing fetchers migrate to consume them; they may stay in their current files (`govt-dashboards.ts`, etc.) or move under `lib/metrics/` opportunistically — migration is incremental, not a big-bang move.
- **D2 — `ProjectionContext` is the single fetcher argument.** Every aggregate fetcher takes one `ctx: ProjectionContext`. No more bespoke `(actor, jurisdictions)` vs `(…, period)` signatures.
- **D3 — Denominators are defined once.** `population.ts` owns "what is an active pet / a dog in scope." Fetchers call it; they do not re-express the predicate.
- **D4 — Suppression is a mandatory boundary, not a convention.** Any locality-grouped result passes through `suppressSmallCells`. Enforce it so it can't be silently forgotten (see §4.4 for the enforcement mechanism).
- **D5 — Period is unified.** Home KPIs adopt `resolveAnalyticsPeriod`. A metric's window is a property of the `ctx.period`, not hardcoded per fetcher. Default windows (e.g. "trailing 12 months" for coverage) become named constants, not magic numbers.
- **D6 — Backward-compatible, test-pinned.** Migrating an existing fetcher must not change its output for cells with `≥ k` pets. Each migrated fetcher keeps/get a test that pins its value against seeded data before and after.
- **D7 — Denormalized columns are the authoritative source for aggregates, by design.** Pattern B reads `pets.status`/`pets.species` (denormalized) rather than replaying events per pet (too slow at population scale). This invariant gets documented (§6) so the lag risk is explicit and owned.

## 3. The primitives (`lib/metrics/`)

```
lib/metrics/
  context.ts      ProjectionContext + builders
  scope.ts        the single petsScopeClause / petEventsScopeClause (delete both duplicates)
  population.ts    activePets(ctx), dogsInScope(ctx), petEventsInScope(ctx) — the ONE denominator defs
  anonymity.ts    suppressSmallCells(rows, opts) — the missing k=5 privacy boundary
  period.ts       re-export resolveAnalyticsPeriod + named default windows (TRAILING_12M, …)
  types.ts        MetricResult<T>, Cell, SuppressedCell
  index.ts        barrel
```

### 3.1 `context.ts`

```ts
export type ProjectionScope =
  | { kind: "global" }                                   // admin / universal
  | { kind: "jurisdictions"; jurisdictions: DashboardJurisdiction[] }; // govt

export type ProjectionContext = {
  actor: DashboardActor;            // { role: 'admin' | 'govt' }
  scope: ProjectionScope;           // derived from actor + assignments at the page boundary
  period: ResolvedPeriod;           // from resolveAnalyticsPeriod; carries {from, to, grain}
};

export function buildProjectionContext(
  actor: DashboardActor,
  jurisdictions: DashboardJurisdiction[],
  period: ResolvedPeriod,
): ProjectionContext;
```

The page (server component) builds `ctx` once via the existing guard (`requireAdminOrGovtOrRedirect`) + `resolveAnalyticsPeriod`, then passes the same `ctx` to every fetcher on that screen — which also unlocks dedup (§3.6).

### 3.2 `scope.ts`

Move the **one** canonical `petsScopeClause(ctx)` / `petEventsScopeClause(ctx)` here. Signature takes `ctx` (reads `ctx.scope`). Internally builds the jurisdiction-pair predicate **once**; fetchers never hand-roll the `OR`-joined pairs again. Delete the two existing copies and the ~14 inline re-derivations, replacing each with a call.

### 3.3 `population.ts`

```ts
// The single definition of each base population. Changing "what counts" happens HERE, once.
export function activePets(ctx): SQL;            // status IN ('active','lost') + scope
export function dogsInScope(ctx): SQL;           // activePets + species='dog'
export function petEventsInScope(ctx, eventType?, window?): SQL;
```

Each returns a composable Drizzle/SQL fragment, not a query, so fetchers keep building their numerators on top. The rabies-coverage denominator, sterilization-rate denominator, microchip-penetration denominator (Item 4 C1) all consume `activePets(ctx)` — guaranteeing the coverage rates share a denominator.

### 3.4 `anonymity.ts` — the missing boundary

```ts
export type SuppressOpts<Row> = {
  count: (r: Row) => number;     // the cell size
  key: (r: Row) => string;       // the grouping key (e.g. locality)
  k?: number;                     // default 5
  rollup?: (suppressed: Row[]) => Row | null; // optional: roll into coarser jurisdiction
};
export function suppressSmallCells<Row>(rows: Row[], opts: SuppressOpts<Row>): {
  visible: Row[];
  suppressed: Row[];
  suppressedCount: number;
};
```

Default behavior: drop cells with `count < k`. With `rollup`, fold them into the next coarser level (province) instead of dropping. Returns the suppressed count so a dashboard can honestly show "3 localities hidden (privacy)".

### 3.5 `period.ts`

Re-export `resolveAnalyticsPeriod` and define named windows so no fetcher writes `365 * DAY_MS` again: `TRAILING_12M`, `TRAILING_30D`, `TRAILING_7D`, etc. A fetcher that legitimately needs a fixed clinical window (e.g. the 10-day rabies-observation legal period — that's a *rule*, not a *reporting window*) keeps it as a named domain constant, clearly distinct from reporting periods.

### 3.6 Caching / dedup

- Wrap the shared base-population queries in **`React.cache`** so that within a single render, `activePets(ctx)` resolves once and is reused across every tile on the page (the `ctx` identity is the cache key surrogate — pass a stable serialized scope+period key).
- Leave pages `force-dynamic` (data must be fresh per request); `React.cache` dedups **within** a request, not across. If cross-request caching is later justified by real volume, that's a separate `unstable_cache`/revalidate decision — **out of scope here** (umbrella §6: no premature optimization).

## 4. Implementation

### 4.1 Build the primitives (no behavior change yet)
Create `lib/metrics/*` with the types, helpers, and the suppression boundary. Unit-test each in isolation (`anonymity` and `period` are pure; `scope`/`population` return SQL fragments testable via a seeded integration test).

### 4.2 Migrate existing fetchers incrementally
For each fetcher in `govt-home-kpis.ts` / `govt-dashboards.ts`:
1. Add/confirm a value-pinning test on seeded data.
2. Swap its signature to `(ctx)`; replace inline scope/denominator with `scope.ts` + `population.ts`.
3. Route any locality-grouped output through `suppressSmallCells`.
4. Confirm the pinned value is unchanged for `≥ k` cells (and that a `< k` cell is now correctly suppressed — this is an intended *fix*, asserted by a new test).

### 4.3 Unify period on the home panel
Replace `since12m`/`since30d` constants in `govt-home-kpis.ts` with `ctx.period` (or the named default window where the panel intentionally shows a fixed trailing window). Document any metric whose displayed value shifts because the window definition was reconciled.

### 4.4 Enforce the suppression boundary (decisión cerrada: branded type)
El mecanismo es el **branded `MetricResult` type**: los fetchers agrupados por localidad devuelven `MetricResult<Cell[]>` cuyo `Cell[]` **solo** puede construirse vía `suppressSmallCells` (tipo branded), así un array sin suprimir **no typechequea**. Falla en compile-time, no en runtime ni en CI-only. (No se usa una lint/test rule como mecanismo primario; un test de cobertura puede complementar pero el branded type es la barrera.)

## 5. Test plan (test-first)

- `lib/metrics/anonymity.test.ts`: cells below/above `k` (drop vs keep); `rollup` folds correctly; `suppressedCount` accurate.
- `lib/metrics/period.test.ts`: named windows resolve to expected `{from,to}`; picker period passes through.
- `__tests__/metrics-scope.test.ts` (seeded Postgres): `activePets(ctx)` excludes deceased; excludes out-of-jurisdiction pets for a govt ctx; includes all for a global ctx.
- **Migration pins** (`__tests__/`): for each migrated fetcher, the value on a fixed seed is identical pre/post for `≥ k` cells; a `< k` locality is suppressed post-migration.
- **Dedup test**: with `React.cache`, two tiles sharing `activePets(ctx)` issue the base query once (assert via a query spy/counter in the test harness).

## 6. Docs to update (same PR)

- **`docs/architecture/hexagonal-lite.md`** — add a section blessing **Pattern B (aggregate projections)** alongside Pattern A: where it lives (`lib/metrics/`), the `ProjectionContext` contract, the mandatory suppression boundary, and **D7** (denormalized columns are authoritative for aggregates; the lag risk is owned, not accidental). This is the doc gap that let Pattern B drift.
- **`AGENTS.md → Aggregation & privacy policy`** — change "k-anonymity for small cells" from an aspirational bullet to "enforced by `lib/metrics/anonymity.ts`; every locality-grouped projection passes through `suppressSmallCells`."
- **`AGENTS.md → Dashboards & projections`** — add a one-line "all dashboard fetchers consume `ProjectionContext`" note so future metrics follow the contract.
- **`docs/superpowers/README.md`** — index row ✅ + SHA; mark Items 2/3/4 as depending on this.

## 7. Lo que NO está acá

- **No new metrics.** This is foundation only; metric tiles land in Items 2–4.
- **No cross-request caching layer / materialized rollups** (umbrella §6 — deferred until real volume justifies).
- **No big-bang file move.** Fetchers migrate incrementally; they may stay in their current files while consuming `lib/metrics/`.
- **No change to Pattern A** (`lib/projections/*`) — it's already first-class; this only gives Pattern B the same treatment.
- **No change to RLS/auth.** Scope here is the *analytics* jurisdiction filter, not the security boundary (that stays in `actions.ts`, per `AGENTS.md`).

## 8. Phasing

- **Fase 0.1 (1 PR):** build `lib/metrics/*` + unit tests (`anonymity`, `period`, `context`, `scope`, `population`). No fetcher touched yet. Ships the missing suppression boundary as available API.
- **Fase 0.2 (1 PR):** migrate `govt-home-kpis.ts` fetchers to `ctx` + shared denominator + suppression; pin values; unify period on the panel.
- **Fase 0.3 (1 PR):** migrate the locality-grouped `govt-dashboards.ts` fetchers (the ones that can leak small cells) through `suppressSmallCells`; delete the duplicate scope helpers.
- **Fase 0.4 (1 PR):** `hexagonal-lite.md` + `AGENTS.md` doc updates; enforcement mechanism (§4.4).

Items 2–4 then build their new fetchers natively on `lib/metrics/` and drop their per-item `lib/anonymity.ts` proposals (now redundant).

---

## Próximo paso
Sequence: this is **Phase 0**, ahead of Items 2–4 in the umbrella. **Decisión cerrada (umbrella §7):** el enforcement de §4.4 es el **branded `MetricResult` type** (falla en compile-time), no una lint/test rule. Y la reconciliación de period acepta el valor corregido/consistente. Sin pendientes del dueño — Fase 0.1 puede arrancar ya.
