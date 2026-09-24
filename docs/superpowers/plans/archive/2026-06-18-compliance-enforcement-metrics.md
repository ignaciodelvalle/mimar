# Compliance & enforcement metrics — executable plan (Item 4)

> Spec: `specs/2026-06-18-compliance-enforcement-metrics-design.md` (THE contract).
> Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` §3/§5/§7. Depends on Item 0 (`lib/metrics/`).
> Pure read-time projections over the existing event log. NO new tables / event types / migrations.

## Scope

Ship the six metrics the spec marks shippable now, all jurisdiction-scoped, period-aware,
built on `ProjectionContext` (Pattern B). Reuse `lib/metrics/anonymity.ts` for k-anon — no
duplicate helper.

| Code | Metric | Definition | Source | Surface |
|------|--------|------------|--------|---------|
| C1 | Microchip penetration | chipped active pets / active pets, by jurisdiction | `pet_identifications(kind='microchip_iso', status='active')` ∩ active `pets` | `/gob` Panel KPI + locality breakdown (k-anon) |
| C2 | ISO-validity rate | valid-ISO chipped / all chipped | `pet_identifications` decomposed ISO fields | `/gob/usuarios` Registro tile |
| C5 | Chip-fraud signal | `microchip_replaced` by `reason` (highlight `fraud_detected`+`duplicate_detected`) | `pet_events(event_type='microchip_replaced')` | `/gob/usuarios` `OpBreach` |
| C7 | Dangerous-breed registry compliance | PPP attested / all PPP (graceful 0%) | `pets.potentially_dangerous_breed` ∩ `dangerous_breed_attested` events | `/gob` Panel KPI |
| D4 | Reunification rate | lost episodes returned to active / all lost; median days-to-recovery | `status_changed`→lost/active episodes | `/gob/perdidas` KPI |
| D5 | Seizures (decomisos) | `shelter_intake_recorded(intake_reason='seizure')` by `seizure_motive` + period | `pet_events` | `/gob/decomisos` KPI + by-reason |

**Deferred (omitted, noted):** C3 (registration completeness vs *external* population) — no
trustworthy denominator (umbrella §6). Not implemented.

## C7 graceful degradation (umbrella §7, closed decision)

C7 ships showing the honest number. Until a `dangerous_breed_attested` writer-form exists,
the attested numerator is 0, so C7 reads **`0 attested / N flagged` = 0%**. That is a TRUE and
USEFUL compliance figure ("registry adoption is 0%"), not a bug. The tile carries a clear label
(`registro PPP`) and the denominator (N flagged) so the authority sees the gap. When N=0 (no PPP
pets in scope) the rate is reported as 0% with `flaggedCount: 0` — the UI labels that "sin PPP".

## Data sources (verified in schema + event-schemas)

- **C1 numerator:** `pet_identifications` rows with `kind='microchip_iso' AND status='active'`,
  joined to in-scope active pets. Denominator: `activePetsCondition(ctx)` (the SAME shared
  definition rabies-coverage + sterilization consume — rates can't drift).
- **C2:** of chipped pets (active microchip_iso rows), the fraction whose decomposed ISO fields
  (`iso_country_code` len-3, `iso_manufacturer_code` len-4, `iso_national_id` len-8) are all
  present + well-formed. `pet_identifications` has no jurisdiction column → scope via JOIN to
  `pets.jurisdiction*`.
- **C5:** `pet_events(event_type='microchip_replaced')` grouped by payload `reason`
  (enum: damaged, unreadable, duplicate_detected, fraud_detected, owner_request, device_failure,
  other). Scope via pet JOIN (replacement events don't carry jurisdiction in payload). Period-aware.
- **C7:** `pets.potentially_dangerous_breed = true` in scope (denominator);
  `pet_events(event_type='dangerous_breed_attested')` distinct pets (numerator).
- **D4:** lost EPISODES = pets with a `status_changed → to_status='lost'` event in scope+window;
  recovered = those whose latest post-lost transition is `to_status='active'`. Median
  days-to-recovery from lost-event → recovery-event. Deceased excluded from numerator.
- **D5:** `pet_events(event_type='shelter_intake_recorded')` where payload
  `intake_reason='seizure'`, grouped by `seizure_motive`, period-aware, scope via pet JOIN.

## Files

- **NEW `lib/compliance-metrics.ts`** — the six fetchers. Sibling to `govt-home-kpis.ts` /
  `govt-dashboards.ts`; cohesive new module (the spec's §5 placements `fetchMicrochipPenetration`,
  `fetchDangerousBreedCompliance`, `fetchIsoValidity`, `fetchChipReplacementSignal` are gathered
  here rather than scattered, keeping Item-4 logic discoverable in one file). Built natively on
  `lib/metrics` exports: `ProjectionContext`, `activePetsCondition`, `petsScopeClause`,
  `petEventsScopeClause`, `suppressedMetric`.
- **NEW `__tests__/compliance-enforcement.test.ts`** — integration (local Postgres), test-first,
  one describe per fetcher, plus a k-anon suppression case (C1 locality breakdown) and a
  jurisdiction-scope case (C1 + D5).
- **EDIT `app/gob/page.tsx`** — add C1 + C7 KPI tiles to the Panel KPI strip.
- **EDIT `app/gob/perdidas/page.tsx`** — add D4 reunification-rate + median-days KPIs.
- **EDIT `app/gob/decomisos/page.tsx`** — add D5 seizures-this-period KPI + by-reason breakdown.
- **EDIT `app/gob/usuarios/page.tsx`** — add C2 ISO-validity tile + C5 chip-fraud `OpBreach`.
- **DOCS:** `AGENTS.md` (Dashboards & projections + Legal framework annotations);
  `docs/superpowers/README.md` (flip Item 4 row to ✅ + PR).

## Return shapes (server-fetched, presentational tiles stay dumb)

```ts
MicrochipPenetrationKpi   { ratePct; chipped; active; byLocality: MetricResult<SuppressedCells> }
DangerousBreedComplianceKpi { ratePct; attested; flaggedCount }      // C7: flaggedCount=0 → "sin PPP"
IsoValidityKpi            { ratePct; valid; chipped }
ChipReplacementSignal     { total; byReason: Record<reason, number>; flaggedForReview }
ReunificationKpi          { ratePct; recovered; lostEpisodes; medianDaysToRecovery }
SeizuresKpi               { total; byMotive: Array<{ motive; count }> }
```

All fetchers early-return zero-shapes for `govt` with empty jurisdictions (no DB hit), mirroring
the existing `fetchRabiesCoverage` / `fetchPerdidasMetrics` contract.

## Test-first sequence (TDD)

1. Write `__tests__/compliance-enforcement.test.ts` seeding events/rows per metric and asserting
   each shape. Include ≥1 k-anon suppression case + ≥1 jurisdiction-scope case. RUN → red
   (module/fetchers don't exist yet).
2. Implement `lib/compliance-metrics.ts` until green.
3. Wire UI tiles (server fetches; tiles dumb).
4. Docs.

## Gate

`biome format --write` → `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (foreground).
New tests MUST pass vs local Postgres. Ignore known noise
(`pet-cache-rederivation.test.ts`, `location-p3-convergence` lint, build `DATABASE_URL` static-gen).

## Non-goals

No C3. No fraud auto-classification (C5 surfaces for human review only). No enforcement actions
(fines/actas). No write-flow changes. No new schema/events/migrations. No duplicate k-anon helper.
