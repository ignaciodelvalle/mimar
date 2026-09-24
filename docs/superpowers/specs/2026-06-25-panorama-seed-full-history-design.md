# Design — Full multi-year seed history for all events & dashboards

**Date:** 2026-06-25
**Branch:** `feat/panorama-seed-full-history`
**Status:** Approved design (pending spec review)

## Problem

The Panorama time scrubber now defaults to a 3-year window, but the seeded
multi-year history (`seedModelProvinceHistory` in `scripts/seed-panorama.ts`)
only covers **2 provinces** (Córdoba, Salta) and **3 dimensions** (vaccination,
sterilization, zoonosis). Every other province and every other event type is
concentrated in the recent ~90-day window. As a result, when an operator drills
into another province — or looks at mortality / bites / denuncias / decomisos /
adoptions / pérdidas / campaigns even in Córdoba/Salta — the multi-year
dashboards and the scrubber are sparse or empty.

**Goal (measurable):** No dashboard panel and no Panorama map layer is empty in
ANY province across the full 2024-2026 window. Every time-series shows a
continuous curve. The demo "shines" everywhere.

## Decisions (from brainstorming)

1. **Additive history layer** — the existing recent base dataset stays INTACT
   (current-state KPIs unchanged, demo-safe). We generalize the historical seed
   to fill 2024-2026; we do NOT re-spread the base dataset.
2. **Uniform + simple model** for the 22 non-featured provinces (a shared
   monthly-rate function, no hand-crafted per-province archetypes).
3. **Córdoba (improving) + Salta (worsening) stay featured** — they keep their
   marked trend, but are extended to FULL event coverage (not just the 3 current
   dimensions).
4. **"No des por hecho"** — completeness is verified by an explicit per-query
   checklist (the Verification Matrix below), province × event-type × window.

## Temporal model

A single shared monthly-rate function drives all provinces:

```
rate(province, month) = baseRate(province) × trendFactor(province, monthIndex)
                                            × seasonalFactor(month)
                                            × jitter(rng)
```

- `baseRate(province)` — scaled by province size (reuse the census /
  PETS_PER_CAPITA weighting the seed already computes). Bigger provinces → more
  events/month.
- `trendFactor(province, monthIndex)`:
  - **Uniform provinces (22):** mild global upward drift on coverage dimensions
    (vaccination, sterilization) so progress reads; flat-with-noise on
    incident/mortality/zoonosis.
  - **Córdoba (featured, improving):** stronger upward coverage, declining
    zoonosis/mortality.
  - **Salta (featured, worsening):** declining coverage, rising
    zoonosis/mortality.
- `seasonalFactor(month)` — a gentle sinusoid (e.g. bites/zoonosis peak in
  summer months) shared by all provinces.
- `jitter(rng)` — small multiplicative noise from the existing fixed-seed
  mulberry32 PRNG (determinism preserved).

All pure, side-effect-free, deterministic → unit-testable in
`scripts/seed-history-utils.ts`.

## Event / data coverage (every dashboard)

Grouped by storage. Each row must be generated across 2024-2026 for all 24
provinces (featured + uniform), tagged `PANO-` for idempotent cleanup.

| Storage | Event / row type | Dashboards / layers fed |
|---|---|---|
| `pet_events` | `pet_registered` (varied `acquisition_method`) | analytics (acquisition trend), censo, poblacion, adopciones, panorama population |
| `pet_events` | `vaccination_administered` (rabies) | analytics cobertura, panorama cobertura layer, KPI |
| `pet_events` | `sterilization_performed` | poblacion, panorama esterilización layer |
| `pet_events` | `outbreak_signal` + `disease_reported` | vigilancia, vigilancia/zoonosis, vigilancia/brotes, panorama zoonosis layer |
| `pet_events` | `incident_reported` (bite) | vigilancia mordeduras, panorama mordeduras layer |
| `pet_events` | `death_recorded` (with disposal method) | mortalidad, panorama mortalidad layer |
| `pet_events` | `adoption_finalized` (+ reversals) & custody/foster ownerships | adopciones (funnel, trend, time-in-state) |
| `pet_events` | `pet_lost` / `pet_found_sighting` / `status_changed` | perdidas, panorama perdidas layer |
| `pet_events` | `microchip_implanted` | population completeness |
| `welfare_reports` | denuncias (varied kind/severity) | maltrato, panorama denuncias layer |
| `cases` | `custody_dispute` | disputas, analytics dispute count |
| `cases` | `decomiso` | decomisos, panorama decomisos layer |
| `campaign_offerings` / slots / `appointments` | campaigns over time | campañas (trend, attendance) |
| derived (rabies obs / ENO) | rabies_observation + ENO queue/outbox | sistema (SLA), vigilancia |

`investigaciones` (vigilancia/investigaciones) and `programa` (north-star
composite) are derived from the above — confirmed in the Verification Matrix,
not separately seeded.

## Spatial distribution

Events are placed at **locality centroids** (reuse `localitiesByCode` the seed
already loads) so the map layers AND the locality-level drill have data.
k-anonymity (k=5) is respected: the monthly rate is tuned so province-level
cells always clear the threshold; very fine locality-months may suppress (by
design, same as production).

## Determinism & idempotency

- Reuse the existing fixed-seed mulberry32 PRNG and the hardcoded anchor
  (`2026-06-20`). Re-running produces an identical dataset.
- Every generated row is `PANO-` tagged (pets, orgs, cases, welfare reports,
  campaigns) so `seed:panorama --clean` removes it. No new cleanup path.

## Volume control & performance

- New env knob `HISTORY_SCALE` (default tuned for a full-but-fast seed) caps
  total historical rows. 24 prov × 36 months × ~10 event types is large; the
  knob governs it.
- Batched inserts (the seed already batches). Target: seed completes in a few
  minutes locally.

## Testing

- **Pure helpers** (`scripts/seed-history-utils.ts`): `monthlyRate`,
  `seasonalFactor`, `trendFactor`, distribution helpers — deterministic unit
  tests (extend the existing `seed-history-utils.test.ts`).
- **Seed smoke / integration:** run `pnpm seed:panorama` and assert the
  Verification Matrix (below) via SQL counts.

## Verification Matrix ("no des por hecho")

After seeding, a verification step (script or test) MUST assert **data exists in
the 2024, 2025, AND 2026 slices** for each cell below. The featured provinces
are checked explicitly; a sample of uniform provinces is spot-checked.

For **Córdoba** AND **Salta** (every event type — explicit, not assumed):
- [ ] pet_registered  - [ ] vaccination_administered  - [ ] sterilization_performed
- [ ] outbreak_signal / disease_reported  - [ ] incident_reported (bite)
- [ ] death_recorded  - [ ] adoption_finalized  - [ ] pet_lost / found
- [ ] welfare_reports  - [ ] cases custody_dispute  - [ ] cases decomiso
- [ ] campaign offerings + appointments

For **each dashboard**, assert its primary query returns non-empty across the
window for Córdoba & Salta:
- [ ] analytics (acquisition trend + cobertura)  - [ ] mortalidad  - [ ] vigilancia (+ zoonosis, brotes)
- [ ] campañas  - [ ] adopciones  - [ ] poblacion  - [ ] censo  - [ ] programa
- [ ] perdidas  - [ ] maltrato  - [ ] disputas  - [ ] decomisos  - [ ] sistema
- [ ] Panorama: each of the 9 layers + the unit-history detail, at province AND locality level

Plus: spot-check 2-3 uniform provinces (e.g. Buenos Aires, Mendoza, Tucumán)
have data in all pet_events dimensions across the window.

## Definition of done

- `seedModelProvinceHistory` generalized to all 24 provinces and all event/data
  types per the table above; Córdoba/Salta featured, others uniform.
- Pure helpers added + unit tests green.
- `pnpm seed:panorama` runs clean and idempotent; `--clean` removes all rows.
- Verification Matrix passes (every box checked by query).
- `pnpm typecheck` + `pnpm lint` clean; full `pnpm test` green.

## Out of scope

- UI changes (the scrubber/dashboards already render whatever the data shows).
- Changing the recent base dataset (additive only).
- Per-province hand-crafted archetypes beyond Córdoba/Salta.
