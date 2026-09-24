# Compliance & enforcement metrics — design spec

> **Status:** 🟢 Ready for Claude Code · **Date:** 2026-06-18 · **Item 4**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` · **Depends on Item 0 (`lib/metrics/`)**

## 1. Por qué este documento existe

The international scan (reference doc) showed that almost no national system publishes **compliance percentages** — UK and NSW both came back empty — because their registries are fragmented. MiMAR's single event log can produce them. This item surfaces the enforcement-grade metrics: **microchip penetration** (Ley Prov 14.107 makes the chip a legal artifact), **ISO-validity** (Res. SENASA 284/2024), **chip-fraud signal** (the Estonia anti-theft rationale), **dangerous-breed registry compliance** (Ley CABA 4078 / Prov 14.107; the UK XL-Bully / NZ-menacing analogue), plus the two welfare-enforcement throughput numbers — **lost→reunification rate** (UK ~39% benchmark) and **seizures/decomisos**. These live on the gob Panel + "Casos y cumplimiento" + "Registro y aprobaciones" sections from Item 1.

## 2. Decisiones cerradas

- **D1 — Penetration is over *active* pets in scope.** C1 = `pets with a microchip_implanted event / active pets`, jurisdiction-scoped. Denominator is the registered active population (we have it), not an external estimate — so C1/C2/C5/C7 are all shippable now. (C3 "registration completeness vs *external* population" stays deferred — no trustworthy denominator; umbrella §6.)
- **D2 — ISO validity reads `pet_identifications`.** C2 = chipped pets whose `pet_identifications` row has valid decomposed ISO fields (`iso_country_code`/`manufacturer_code`/`national_id`) / all chipped. Reuse the PR-0 polymorphic identifier table.
- **D3 — Chip-fraud signal is a count, not a judgment.** C5 = `microchip_replaced` grouped by `reason`, highlighting `fraud_detected` + `duplicate_detected`. It flags for human review; it does not auto-classify fraud.
- **D4 — Dangerous-breed compliance degrades gracefully.** C7 = PPP-flagged pets with a `dangerous_breed_attested` event / all PPP-flagged pets. The attestation event is `later` in the catalog, so until that form ships C7 reads "0 attested / N flagged" — a *true and useful* compliance number (it says "registry adoption is 0%"), not a bug. Confirm acceptable (umbrella §7) vs deferring.
- **D5 — Reunification + seizures reuse existing fetchers.** D4 extends `fetchPerdidasMetrics`; D5 reads decomiso/`shelter_intake_recorded(intake_reason='seizure')` already surfaced on `/gob/decomisos` + `/gob/perdidas`.

## 3. Metrics

| Code | Metric | Definition | Source |
|------|--------|------------|--------|
| C1 | **Microchip penetration** | chipped active pets / active pets, by jurisdiction | `microchip_implanted`, `pets` |
| C2 | **ISO-validity rate** | valid-ISO chipped / all chipped | `pet_identifications` |
| C5 | **Chip-fraud signal** | `microchip_replaced` by `reason` (highlight fraud/duplicate) | `microchip_replaced` |
| C7 | **Dangerous-breed registry compliance** | PPP pets attested / all PPP pets | `dangerous_breed_attested`, `pets.potentially_dangerous_breed` |
| D4 | **Reunification rate** | lost episodes returned to `active` / all lost; median time-to-recovery | `status_changed`→lost/active (lost episodes) |
| D5 | **Seizures (decomisos)** | count by `intake_reason='seizure'` + decomiso cases, by period | `shelter_intake_recorded`, decomiso cases |
| C3 | Registration completeness vs external population | **Deferred** — no trustworthy denominator | — |

## 4. UI surfaces

- **`/gob` Panel:** add C1 (microchip penetration) and C7 (PPP compliance) to the KPI row — they're the two headline "are people complying with the law" numbers an authority wants at a glance.
- **`/gob/perdidas`:** add D4 reunification-rate KPI + median time-to-recovery (the screen already lists lost/recovered/deceased filters).
- **`/gob/decomisos`:** add D5 seizures-this-period KPI + by-reason breakdown.
- **`/gob/usuarios` or `/gob/organizaciones` (Registro section):** add C2 ISO-validity and C5 chip-fraud `OpBreach` list (replacements flagged fraud/duplicate route to review).
- **`/gob/analytics`:** add C1/C7 trend lines (period-aware) for the strategic view.

## 5. Implementation

- **`lib/govt-home-kpis.ts`:** add `fetchMicrochipPenetration` and `fetchDangerousBreedCompliance` next to `fetchRabiesCoverage` (same actor/jurisdiction signature) so the Panel can `Promise.all` them in.
- **`lib/govt-dashboards.ts`:** add `fetchIsoValidity`, `fetchChipReplacementSignal`; extend `fetchPerdidasMetrics` with reunification rate + median recovery; extend the decomiso fetcher with by-reason counts.
- **Reuse** `lib/metrics/` (Item 0): `ProjectionContext`, shared scope/denominator helpers, and `suppressSmallCells` for any locality grouping. C1's denominator is `activePets(ctx)` — the *same* shared definition rabies-coverage and sterilization-rate consume, so the compliance rates can't drift apart.
- **Pages:** wire tiles into the five surfaces above using `OpKpi`/`OpKpiSm`/`OpBreach`. No new screens.

## 6. Test plan (test-first)

`__tests__/compliance-enforcement.test.ts`:
1. Seed active pets with/without `microchip_implanted` → assert C1 fraction; assert pets outside jurisdiction excluded.
2. Seed `pet_identifications` with valid vs malformed ISO fields → C2 rate.
3. Seed `microchip_replaced` with each `reason` → C5 buckets; fraud/duplicate isolated.
4. Seed PPP pets with/without `dangerous_breed_attested` → C7 ratio; assert graceful "0 attested" when none exist.
5. Seed lost episodes resolved to active vs still lost → D4 rate + median; deceased excluded from numerator.
6. Seed `shelter_intake_recorded(intake_reason='seizure')` → D5 count by reason.
7. k-anonymity + scope cases on any locality-grouped output.

## 7. Docs to update (same PR)

- `AGENTS.md` → **Dashboards & projections**: C1/C2/C5/C7 under Sanitary authority; D4 under Animal-welfare officer (it already lists "Lost-pet hotspots"); D5 under welfare/enforcement.
- `AGENTS.md` → **Legal framework**: annotate the Ley 14.107 / Ley 4078 rows — these laws now have a *measured* compliance metric, not just a data field.
- `AGENTS.md` → **Feature inventory**.
- `docs/superpowers/README.md` — row ✅ + SHA.

## 8. Lo que NO está acá

- No C3 external-population completeness (deferred).
- No auto-classification of fraud — C5 surfaces for human review only.
- No enforcement *actions* (fines, infraction acts) — this is measurement; the infraction-act form is a separate operator-form spec.
- No change to the microchip or PPP write flows; if `dangerous_breed_attested` form doesn't exist yet, C7 reads the true 0% and a future spec adds the form.

## 9. Phasing

- **Fase 1 (1 PR):** C1 + C7 on Panel + tests (highest-visibility, pure reads).
- **Fase 2 (1 PR):** C2 + C5 on Registro section + fraud `OpBreach`.
- **Fase 3 (1 PR):** D4 reunification on `/gob/perdidas` + D5 seizures on `/gob/decomisos`.
- **Fase 4 (optional):** C1/C7 trend lines on `/gob/analytics`.

---

## Próximo paso
Confirm the C7 graceful-degradation call (umbrella §7): ship the 0%-until-form-exists compliance number, or defer C7 until `dangerous_breed_attested` has a writer. Recommendation: ship it — "registry adoption is 0%" is exactly the kind of gap an authority should see.
