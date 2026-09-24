# Mortality & disposal dashboard (`/gob/mortalidad`) — design spec

> **Status:** 🟢 Ready for Claude Code · **Date:** 2026-06-18 · **Item 2 — highest leverage**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` · **Depends on Item 0 (`lib/metrics/`)**

## 1. Por qué este documento existe

`death_recorded` already captures everything a disposal-traceability view needs — `cause`, `cause_detail`, `disposition_method`, `facility`, `confirmed_by_vet`, `death_at_clinic`, `owner_to_private_crematorium`, `disease_code`, `confirmed_by_lab`, `is_reportable` — and `DeathRecordForm.tsx` writes the disposition select today (`cremation_collective`, `cremation_individual_ashes`, `owner_burial`, …). But the only consumer is `fetchDeathCauses` on `/gob/analytics`, which shows cause mix and nothing about **disposition**. Ley CABA 5470 (cremation traceability for canines/felines) and the Sweden/Finland "report-the-death-to-deregister" model both want exactly the disposal/lifecycle view we're throwing away. This screen surfaces it. **Pure projection — no schema, no form, no event-type change.**

## 2. Decisiones cerradas

- **D1 — Standalone screen `/gob/mortalidad`**, jurisdiction-scoped, period-aware (reuse `PeriodPicker` + `resolveAnalyticsPeriod` + `JurisdictionSwitcher` like `/gob/analytics`).
- **D2 — Read `disposition_method` from payload** (`payload->>'disposition_method'`). Do NOT add a column (see umbrella §6).
- **D3 — Normalize disposition into buckets** for the mix tile: `cremation` (collective+individual), `burial` (owner_burial), `rendering`, `other/unknown`. Keep the raw value available in the table drill-down. Put the bucket map in `lib/disposition.ts` (new, tiny, unit-tested) so the form's option list and the dashboard agree.
- **D4 — k-anonymity applies, via Item 0.** Locality-grouped rows with `< 5` deaths are suppressed/rolled to province through `suppressSmallCells` from `lib/metrics/anonymity.ts` (built in **Item 0 — projection primitives**, which this item depends on). The fetcher consumes `ProjectionContext` and the shared `activePets`/scope helpers; it does **not** introduce its own anonymity or scope code.
- **D5 — Capability:** same guard as the rest of `/gob` (`requireAdminOrGovtOrRedirect`, `analytics.read` derivation already used by `/gob/analytics`).

## 3. Metrics (all shippable now unless flagged)

| Code | Metric | Definition (over `death_recorded` in scope+period) |
|------|--------|----------------------------------------------------|
| B1 | Mortality by cause | count grouped by `payload->>'cause'`, by week |
| B2 | **Disposition mix** | share of deaths per normalized bucket (D3) |
| B3 | **Traceable-disposal rate** | `count(method known AND facility present) / count(all deaths)` — the Ley 5470 headline |
| B4 | Unknown-disposition rate | `count(method null/'unknown') / count(all)` — the compliance gap |
| B7 | Disposal-context splits | vet-confirmed death rate (`confirmed_by_vet`), `death_at_clinic` share, `owner_to_private_crematorium` share |
| B8 | Mortality clusters | deaths by `location_point` for the map overlay (anomaly highlight is a stretch; ship the heat layer) |
| B9 | Reportable-death share | `count(is_reportable) / count(all)`, and `disease_code` breakdown where present |
| B5 | Death→deregistration lag | median(`status terminal timestamp − death_recorded.occurred_at`). **Ship only if a terminal-status timestamp is cleanly derivable**; else mark deferred with a one-line note. |
| B6 | Death under-reporting proxy | **Deferred** — needs an external population denominator we don't trust yet (umbrella §6). Do not implement. |

## 4. Layout (Op* components)

```
OpCrumbs: Gobierno › Vigilancia sanitaria › Mortalidad
[ JurisdictionSwitcher ]   [ PeriodPicker ]

KPI row (OpKpi):  Muertes (período)  ·  Trazabilidad de disposición B3  ·  Disposición desconocida B4  ·  Muertes notificables B9
OpCard "Disposición"   → bucket bar/mix B2 + table drill-down (raw method × count, facility coverage)
OpCard "Causas"        → cause-by-week B1 (reuse the analytics chart component)
OpCard "Contexto"      → B7 splits (vet-confirmed / at-clinic / private-crematorium) as OpKpiSm row
OpCard "Mapa"          → MapChoropleth/heat B8 (reuse MapChoroplethDynamic; placeholder pins if no provider)
OpBreach (conditional) → shown when B4 > threshold (e.g. >25% unknown) — "Baja trazabilidad de disposición"
```

## 5. Implementation

- **`lib/govt-dashboards.ts`** (or a new `lib/mortality-metrics.ts` if the file is already large): add `fetchMortalityDisposition(actor, jurisdiction, period)` returning `{ total, byBucket, traceableRate, unknownRate, contextSplits, reportableShare, byCauseWeek, byLocality }`. Mirror the signature/scoping of `fetchAnalyticsMetrics`/`fetchDeathCauses`. One query with conditional aggregation is fine; keep it a single round-trip.
- **`lib/disposition.ts`** (new): `DISPOSITION_BUCKETS` map + `bucketOf(method): 'cremation'|'burial'|'rendering'|'other'` + `isTraceable(method, facility)`. Unit-tested; imported by both the fetcher and (optionally) the death form to keep option lists aligned.
- **`app/gob/mortalidad/page.tsx`** (new): server component, guard, fetch, render Op* layout. `export const dynamic = "force-dynamic"` like `/gob/analytics`.
- **`app/gob/mortalidad/_components/`**: any client chart wrappers (`DispositionChartDynamic`, etc.), following the `_components` pattern used by `/gob/analytics`.
- **Nav**: add `/gob/mortalidad` to the "Vigilancia sanitaria" section (Item 1 Fase 3).

## 6. Test plan (test-first)

`__tests__/mortality-disposition.test.ts` (Vitest, local Postgres):
1. Seed deaths with mixed dispositions; assert B2 bucket shares and B3 traceable rate to the expected fraction.
2. Seed a death with `disposition_method` null/`unknown`; assert it lands in B4 and not in B3 numerator.
3. Seed `is_reportable` deaths with `disease_code`; assert B9 share + code breakdown.
4. **k-anonymity:** a locality with 3 deaths is suppressed/rolled to province; one with ≥5 appears.
5. **Scope:** deaths in another province don't appear for a locality-scoped govt viewer.
6. `lib/disposition.test.ts`: `bucketOf`/`isTraceable` truth table for every form option value (guards against the form adding an option the dashboard silently drops).

## 7. Docs to update (same PR)

- `AGENTS.md` → **Dashboards & projections › Sanitary authority**: add "Disposition mix & traceable-disposal rate (Ley CABA 5470)" and "Reportable-death share" under the existing "Mortality clusters" bullet.
- `AGENTS.md` → **Event catalog**: in the `death_recorded` row note that `disposition_method`/`facility` now power `/gob/mortalidad` (remove the "payload enrichment to add when forms get built" caveat for disposition_method, which is already built).
- `README.md` → **Portal surfaces** table: add `/gob/mortalidad` row (Gob, jurisdiction-scoped, Live).
- `docs/superpowers/README.md` — row ✅ + SHA.

## 8. Lo que NO está acá

- No `disposition_method` column, no rollup table (umbrella §6).
- No change to `DeathRecordForm` beyond optionally importing `lib/disposition.ts` for its option labels (nice-to-have, not required).
- No B6 under-reporting estimate (deferred — no denominator).
- No cross-jurisdiction national rollup view (that's a public-health-analyst extension; `/gob/analytics` already does cross-region and can gain a disposal slice later).

## 9. Phasing

- **Fase 1 (1 PR):** `lib/disposition.ts` + `fetchMortalityDisposition` + tests (B1–B4, B9). No UI yet.
- **Fase 2 (1 PR):** `/gob/mortalidad` page + Op* layout + nav link + B7 context + B8 map. Conditional `OpBreach`.
- **Fase 3 (optional):** B5 death→deregistration lag if a clean terminal-status timestamp exists.

---

## Próximo paso
Confirm the standalone-vs-tab call (umbrella §7). Confirm whether B5's deregistration timestamp is derivable from `status_changed`/pet status today — if not, ship Fases 1–2 and leave B5 as a documented TODO.
