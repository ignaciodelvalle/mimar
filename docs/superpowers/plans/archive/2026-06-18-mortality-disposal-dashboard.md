# Mortality & disposal dashboard (`/gob/mortalidad`) — executable plan

> **Item 2** of the metrics-IA package · Spec: `specs/2026-06-18-mortality-disposal-dashboard-design.md`
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` · **Depends on Item 0 (`lib/metrics/`) + Item 1 (nav sections).**
> Pure read-time projection over the existing `death_recorded` event log. **No new tables, event types, or migrations (D1).**

## 0. Base & invariants

- Built on develop (`lib/metrics/` present: `index`, `context`, `scope`, `period`, `population`, `anonymity`, `cache`).
- `disposition_method` is read from `payload->>'disposition_method'` — **never** denormalized to a column (umbrella §6).
- Deaths are scoped through an `INNER JOIN pets ON pets.id = pet_events.pet_id`, restricted by `pets.jurisdictionProvince/Locality` via `petsScopeClause(ctx)`. (`death_recorded` payload does not carry jurisdiction fields, so the pet row is the scope anchor — same as `fetchDeathCauses`.)
- Every locality-grouped result routes through `suppressSmallCells` (k=5).

## 1. Metric scope (what ships now vs deferred)

| Code | Metric | Status here | Notes |
|------|--------|-------------|-------|
| B1 | Mortality by cause (by week) | **Ship** | `payload->>'cause'`, bucketed by ISO week. |
| B2 | Disposition-method mix (normalized buckets) | **Ship** | `bucketOf()` from `lib/disposition.ts`. |
| B3 | Traceable-disposal rate (Ley 5470 headline) | **Ship** | `isTraceable()` = method known AND facility present. |
| B4 | Unknown-disposition rate | **Ship** | method null/`unknown`. |
| B7 | Disposal-context splits | **Ship** | `confirmed_by_vet`, `death_at_clinic`, `owner_to_private_crematorium` shares. |
| B8 | Mortality clusters | **Ship (degraded)** | deaths grouped **by locality** (suppressed), not per-point. The per-death geo heat layer is **deferred**: `death_recorded` payload carries no `location_point` (Zod `.strict()`). Documented for the owner list. |
| B9 | Reportable-death share + `disease_code` breakdown | **Ship** | `is_reportable`. |
| B5 | Death→deregistration lag | **Deferred** | `death_recorded` IS the terminal/deregistration event (`lib/projections/pet-status.ts`: `deceasedAt = death.occurredAt`). No separate terminal-status timestamp exists, so the lag is identically zero/undefined — not "cleanly derivable" per the spec's conditional. Documented TODO. |
| B6 | Death under-reporting proxy | **Deferred** | No trustworthy external population denominator (umbrella §6). |

## 2. Files

### New — projection layer
- **`lib/disposition.ts`** — `DISPOSITION_BUCKETS` map covering **every** form/enum value (`cremation_collective`, `cremation_individual_ashes`, `authorized_cemetery`, `owner_burial`, `household_waste`, `rendering`, `unknown`, `null`); `bucketOf(method) → 'cremation' | 'burial' | 'rendering' | 'other'`; `isTraceable(method, facility) → boolean`. Pure, no DB. File-header comment.
- **`lib/mortality-metrics.ts`** — single fetcher `fetchMortalityDisposition(ctx: ProjectionContext)` returning `{ total, byBucket, traceableRate, unknownRate, contextSplits, reportableShare, byCauseWeek, reportableByCode, byLocality }`. One round-trip for the scalar aggregates (conditional aggregation), plus the by-week, by-code and by-locality group queries. Locality query routed through `suppressSmallCells` (k=5, rollup to province). Pure SQL/Drizzle. File-header comment.

### New — UI
- **`app/gob/mortalidad/page.tsx`** — server component. Guard (`requireAdminOrGovtOrRedirect` + `analytics.read` derivation, mirroring `/gob/analytics`). Builds `ProjectionContext` at the boundary (`buildProjectionContext(actor, filteredJurisdictions, resolveAnalyticsPeriod(sp))`). Renders Op* layout: KPI row (B-total / B3 / B4 / B9), `OpCard` Disposición (B2 bucket bars + raw-method table), `OpCard` Causas (B1 by-week bars), `OpCard` Contexto (B7 `OpKpiSm` row), `OpCard` Distribución (B8 by-locality table, with "N localidades ocultas" privacy note), conditional `OpBreach` when B4 > 25%. `export const dynamic = "force-dynamic"`. File-header comment.
- (No `_components/` client wrappers needed for v1 — bars are server-rendered HTML/CSS like `/gob/analytics` death-cause bars.)

### New — tests
- **`__tests__/mortality-disposition.test.ts`** (Vitest, local Postgres):
  1. **B2 + B3** — seed mixed dispositions; assert bucket shares + traceable rate.
  2. **B4** — seed null/`unknown` disposition; assert it lands in B4 and not in the B3 numerator.
  3. **B9** — seed `is_reportable` deaths with `disease_code`; assert share + code breakdown.
  4. **k-anonymity (mandatory)** — locality with 3 deaths suppressed/rolled to province; locality with ≥5 visible.
  5. **scope (mandatory)** — deaths in another province don't appear for a locality-scoped govt viewer.
  6. **B7** — context splits (vet-confirmed / at-clinic / private-crematorium) shares.
- **`lib/disposition.test.ts`** — truth table for `bucketOf`/`isTraceable` over every enum value (guards against the form adding an option the dashboard silently drops).

### Edited — wiring + docs
- **`components/layout/nav-presets.ts`** — add `/gob/mortalidad` ("Mortalidad") to the "Vigilancia sanitaria" `GOB_NAV_SECTIONS` section; remove the "intentionally absent" note.
- **`AGENTS.md`** — Dashboards & projections › Sanitary authority: disposition mix + traceable-disposal rate (Ley 5470) and reportable-death share; Event catalog: note `disposition_method`/`facility` now power `/gob/mortalidad`; drop the "payload enrichment to add" caveat for `disposition_method`.
- **`README.md`** — Portal surfaces table: add `/gob/mortalidad` (Govt, jurisdiction-scoped, Live).
- **`docs/superpowers/README.md`** — flip the Item 2 row status cell only: 🟢 → ✅ Implementado (#PR). No other change.

## 3. Test-first order (TDD)

1. Write `lib/disposition.test.ts` + `__tests__/mortality-disposition.test.ts`. Run → red (modules don't exist).
2. Implement `lib/disposition.ts`. `disposition.test.ts` → green.
3. Implement `lib/mortality-metrics.ts`. `mortality-disposition.test.ts` → green.
4. Wire `app/gob/mortalidad/page.tsx` + nav.
5. Docs.
6. Gate: `biome format --write` changed files → `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## 4. Gate & ship

- Conventional commit `feat(gob): mortality & disposal dashboard /gob/mortalidad (Item 2)`. No AI attribution.
- PR to `develop`. Body: Item 2, B1–B9 projections over `death_recorded`, k-anon + scope tested, Ley CABA 5470.

## 5. Owner-list notes (spec deviations, faithful)

- **B5 deferred** (spec marks "ship if derivable"): not derivable — `death_recorded` is itself the deregistration event; no distinct terminal timestamp.
- **B8 per-point heat map deferred** (spec says "ship the heat layer"): `death_recorded` payload has no `location_point`; shipped as suppressed by-locality breakdown instead. A geo point would need a payload enrichment (out of scope, D1).
