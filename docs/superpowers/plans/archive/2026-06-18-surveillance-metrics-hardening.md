# Surveillance metrics hardening (`/gob/vigilancia`) — executable plan (Item 3)

> Spec: `docs/superpowers/specs/2026-06-18-surveillance-metrics-hardening-design.md`
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` (§3/§5/§7)
> · Depends on Item 0 (`lib/metrics/`). Date: 2026-06-18.

## Scope

Pure read-time projections over the existing event log. **No new tables, event
types, or migrations.** Extends `/gob/vigilancia` with five surveillance metrics
that the spec marks shippable-now:

| Code | Metric | Source |
|------|--------|--------|
| A7 | ENO-notification SLA (our outbox latency) | `event_notification_outbox` (`target_kind='eno_authority'`) |
| A8 | Rabies 10-day observation compliance | `rabies_observation_started/_ended` + `pets.rabies_observation_status` |
| A9 | Rabies-observation breaches (live `OpBreach`) | same |
| A12 | AMR / antimicrobial-use density | `medication_started` + `isAntimicrobial` (lib/drugs.ts) |
| A6 | Reportable-disease incidence | `disease_reported`, `death_recorded.is_reportable` |
| A10 | Lab-confirmation rate | `*.confirmed_by_lab` |

**Deferred / omitted:** A5 (symptom→signal latency) is a spec "stretch" item, not
in the shippable set — omitted. No metric required a denominator that is missing,
so nothing was deferred pending denominator. A12's denominator (active pets) is
available via `lib/metrics/cache.ts` `cachedActivePetCount`, so A12 ships as a
rate (with a provisional raw-count fallback for unclassifiable drug codes).

## `lib/anonymity.ts` → `lib/metrics/anonymity.ts` reconciliation

The spec (D5) and the README master row say this item "introduces
`lib/anonymity.ts`". That text predates Item 0. **The k-anonymity boundary already
shipped in Item 0 as `lib/metrics/anonymity.ts`** (`suppressSmallCells`,
`suppressedMetric`, `SuppressedCells`, k=5). This item **reuses** it and does NOT
create a duplicate `lib/anonymity.ts`. The AGENTS.md privacy policy already points
to `lib/metrics/anonymity.ts` as the enforcement boundary — no change needed there.

## Files

| File | Change |
|------|--------|
| `lib/surveillance-metrics.ts` | **NEW.** `ProjectionContext`-based fetchers: `fetchEnoSla`, `fetchRabiesObservationCompliance`, `fetchAmrDensity`, `fetchReportableIncidence`, plus the `fetchSurveillanceCompliance` aggregate. Built on `lib/metrics` (scope, period, k-anon, cached denominator). Sibling to `govt-dashboards.ts` (which is already 2k+ lines). |
| `lib/drugs.ts` | Add `isAntimicrobial(code)`, `isClassifiedDrug(code)`, `ANTIMICROBIAL_CATEGORIES`. Truth source for A12 classification over `DRUG_CATALOG`. |
| `app/gob/vigilancia/page.tsx` | Server-fetch `fetchSurveillanceCompliance(ctx)`; render 3 compliance KPI tiles (A8/A7/A12), an A9 `OpBreach` panel, and 4 `OpCard`s (legal compliance, ENO, diseases A6/A10, AMR). Presentational only. |
| `__tests__/surveillance-compliance.test.ts` | **NEW.** Integration (Vitest + local Postgres). Per-fetcher seed-and-assert; includes a k-anon suppression case and jurisdiction-scope cases. |
| `__tests__/antimicrobials.test.ts` | **NEW.** Classifier truth table over known catalog codes. |
| `AGENTS.md` | Dashboards & projections (Sanitary authority + Public-health analyst) and SENASA-vocab cross-link. |
| `docs/superpowers/README.md` | Item 3 master-row status flip 🟢 → ✅ (#PR). |

## Implementation decisions

- **D1 (A7) — measure our pipeline, not external delivery.** Reads outbox rows
  with `target_kind='eno_authority'`. On-time % = of *delivered* rows, the share
  with `delivered_at <= sla_due_at`. Breached = `status='pending'` AND
  `sla_due_at < now()` (live). Median latency = `percentile_cont(0.5)` over
  `delivered_at - created_at` (hours). Scope on the outbox row's own
  `target_jurisdiction_province/locality` snapshot.
- **D2 (A8/A9) — read the existing pair.** Each `rabies_observation_ended` row is
  paired to its start via `payload.observation_started_event_id`; elapsed time
  is `ended.occurred_at - started.occurred_at` compared to the 10-day window. A9
  breach = a `started` with no matching `ended` whose start is > 10 days old.
- **D3 (A12) — antimicrobial classifier.** `isAntimicrobial` over `DRUG_CATALOG`;
  the only antimicrobial `DrugCategory` today is `antibiotic`. Confident codes →
  per-1,000-active-pets rate. Codes **not in the catalog** (or null) → a separate
  provisional raw count ("clasificación provisional"), never folded into the rate
  (umbrella §7).
- **D4 (A6/A10) — reuse existing reportable sources.** `disease_reported`
  (`payload.disease`, `payload.confirmed_by_lab`) UNION ALL `death_recorded` where
  `payload.is_reportable='true'` (`payload.disease_code`, `payload.confirmed_by_lab`).
  A6 = per-disease incidence (k-anon suppressed, k=5). A10 = confirmed/total %.
- **D5 — k-anon + scope via Item 0.** `suppressSmallCells`/`suppressedMetric`,
  `ProjectionContext`, `petsScopeClause`, `cachedActivePetCount`.

### Scope gotcha (load-bearing)

`death_recorded`, `disease_reported`, `medication_started`, and the rabies
observation events do **not** carry jurisdiction in their JSONB payload (unlike
`outbreak_signal`/`vaccination_administered`). So A6/A8/A9/A10/A12 scope via an
**inner join to `pets` + `petsScopeClause`** (`pets.jurisdiction*` columns). Only
A7 scopes on the row's own snapshot columns. This mirrors the existing
`fetchDeathCauses` pattern in `govt-dashboards.ts`.

### Field-name gotchas (corrected vs. spec prose)

- `disease_reported` payload uses `disease` (enum `lepto`/`hidatidosis`/`other`),
  **not** `disease_code`. The spec table's "disease_code" refers to the
  `death_recorded` source, which *does* use `disease_code`.
- `medication_started` payload uses `drug_code`.
- Raw `db.execute(sql\`...\`)` cannot bind a JS `Date` (postgres.js limitation);
  timestamps are passed as ISO strings with an explicit `::timestamptz` cast
  (same fix as `fetchLostPets`).

## Test plan (test-first, Vitest + local Postgres)

`__tests__/surveillance-compliance.test.ts`:
1. A7 — outbox rows delivered in/out of SLA + pending-overdue → on-time %,
   breached count, median present; null-% when no deliveries; **jurisdiction
   scope**; zeros for govt with no assignments.
2. A8/A9 — closed on day 8 (compliant) vs day 12 (late) → 50% A8; open-past-10d →
   1 A9 breach (fresh one not counted); **jurisdiction scope**.
3. A12 — antimicrobial vs NSAID vs uncatalogued/null → rate counts only
   antimicrobials, per-1,000 math, provisional bucket for uncertain;
   **jurisdiction scope**.
4. A6/A10 — disease reports + reportable deaths with/without `confirmed_by_lab`
   → totals + lab %; **k-anonymity** (a <5 disease cell is suppressed);
   **jurisdiction scope**.

`__tests__/antimicrobials.test.ts`: classifier truth table (antibiotics true;
NSAID/analgesic/etc. false; unknown/null false; provisional detection via
`isClassifiedDrug`).

## Gate

`biome format --write` changed files → `pnpm typecheck && pnpm lint && pnpm test
&& pnpm build`. New integration tests must pass against local Postgres. Known
noise ignored: `pet-cache-rederivation.test.ts`, `location-p3-convergence` lint
warnings, build `DATABASE_URL` static-gen.
