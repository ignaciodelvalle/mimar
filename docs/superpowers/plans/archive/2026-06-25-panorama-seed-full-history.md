> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# Full Multi-Year Seed History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dashboard panel and Panorama map layer has continuous 2024-2026 data in every province, by generalizing the additive history seed to all 24 provinces and all event/data types.

**Architecture:** Additive — the recent base dataset is untouched. `seedModelProvinceHistory` in `scripts/seed-panorama.ts` is generalized: Córdoba (improving) + Salta (worsening) stay featured with full event coverage; the other 22 provinces use a uniform monthly-rate model. New pure helpers in `scripts/seed-history-utils.ts` (deterministic, unit-tested) drive event dating. A verification script asserts completeness.

**Tech Stack:** TypeScript, tsx, Drizzle ORM, Postgres (local Supabase), vitest. Fixed-seed mulberry32 PRNG already in the seed.

## Global Constraints

- Determinism: all randomness from the existing fixed-seed `rng` (mulberry32); anchor date hardcoded `2026-06-20`. Re-running is identical. Date.now()/Math.random() forbidden in helpers.
- Idempotency: every generated row is `PANO-` tagged (token prefix `PANO-HIST-` for pets). `seed:panorama --clean` must remove all of it. No new cleanup path.
- Window: `HISTORY_YEARS = [2024, 2025, 2026]`.
- Volume knob: `HISTORY_SCALE` env var governs total rows; default tuned so `pnpm seed:panorama` finishes in a few minutes.
- Featured provinces: `Córdoba` (improving), `Salta` (worsening) keep marked trends AND get every event type.
- Tests: pure helpers unit-tested in `scripts/seed-history-utils.test.ts`; `pnpm typecheck` + `pnpm lint` clean; full `pnpm test` green.
- No AI attribution in commits; conventional commits.

---

### Task 1: Province trend profiles (all 24)

**Files:**
- Modify: `scripts/seed-panorama.ts` (replace `MODEL_PROVINCES`, `PROVINCE_YEAR_COVERAGE`, `PROVINCE_YEAR_ZOONOSIS` ~L2494-2548 with a profile table covering all provinces)
- Test: `scripts/seed-history-utils.test.ts`

**Interfaces:**
- Produces: `type TrendArchetype = "improving" | "worsening" | "uniform"`; `provinceProfile(provinceName: string): { archetype: TrendArchetype; coverageByYear; zoonosisByYear }` — Córdoba→improving, Salta→worsening, all others→uniform defaults.

- [ ] **Step 1: Write the failing test** in `seed-history-utils.test.ts`:
```ts
import { provinceProfile } from "./seed-history-utils";
it("Córdoba is improving, Salta worsening, others uniform", () => {
  expect(provinceProfile("Córdoba").archetype).toBe("improving");
  expect(provinceProfile("Salta").archetype).toBe("worsening");
  expect(provinceProfile("Mendoza").archetype).toBe("uniform");
  // improving coverage rises year over year
  const c = provinceProfile("Córdoba").coverageByYear;
  expect(c[2026].vacc).toBeGreaterThan(c[2024].vacc);
  // worsening coverage falls
  const s = provinceProfile("Salta").coverageByYear;
  expect(s[2026].vacc).toBeLessThan(s[2024].vacc);
});
```
- [ ] **Step 2:** Run `pnpm exec vitest run scripts/seed-history-utils.test.ts` → FAIL (provinceProfile not exported).
- [ ] **Step 3:** Implement `provinceProfile` in `seed-history-utils.ts`: keep the existing Córdoba/Salta coverage+zoonosis numbers (move them here); add `UNIFORM_COVERAGE`/`UNIFORM_ZOONOSIS` defaults (mild upward vacc/ster, mild seasonal zoonosis). Export `TrendArchetype`.
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit `feat(seed): province trend profiles for all 24 provinces`.

---

### Task 2: Shared monthly-rate model (pure helpers)

**Files:**
- Modify: `scripts/seed-history-utils.ts`
- Test: `scripts/seed-history-utils.test.ts`

**Interfaces:**
- Produces:
  - `monthIndex(year, month): number` (months since Jan 2024).
  - `seasonalFactor(month: number): number` (0.7–1.3 sinusoid; peak summer DJF).
  - `trendFactor(archetype, monthIndex): number` (improving ↑, worsening ↓, uniform mild ↑).
  - `monthlyEventCount(baseRate: number, archetype, year, month, rng): number` — deterministic integer count = `baseRate × trendFactor × seasonalFactor × jitter`, realised via floor + Bernoulli remainder.
  - `pickDateInMonth(year, month, rng): Date` (uniform day within the month, clamped ≤ anchor).

- [ ] **Step 1: Write failing tests:**
```ts
import { seasonalFactor, trendFactor, monthlyEventCount, monthIndex } from "./seed-history-utils";
it("seasonalFactor is bounded and periodic", () => {
  for (let m = 0; m < 12; m++) { const f = seasonalFactor(m); expect(f).toBeGreaterThan(0.5); expect(f).toBeLessThan(1.6); }
});
it("trendFactor rises for improving, falls for worsening", () => {
  expect(trendFactor("improving", 24)).toBeGreaterThan(trendFactor("improving", 0));
  expect(trendFactor("worsening", 24)).toBeLessThan(trendFactor("worsening", 0));
});
it("monthlyEventCount is deterministic and non-negative", () => {
  const rngA = makeRng(1); const rngB = makeRng(1);
  expect(monthlyEventCount(10, "uniform", 2025, 5, rngA)).toBe(monthlyEventCount(10, "uniform", 2025, 5, rngB));
  expect(monthlyEventCount(0, "uniform", 2025, 5, rngA)).toBe(0);
});
```
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the helpers (pure, rng passed in). `monthIndex(y,m)=(y-2024)*12+m`. `seasonalFactor(m)=1+0.25*cos(2π*m/12)`. `trendFactor`: uniform `1+0.01*mi`; improving `1+0.025*mi`; worsening `max(0.2, 1-0.02*mi)`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(seed): shared monthly-rate model for history generation`.

---

### Task 3: Generalize pets + coverage events (vacc/ster) to all provinces

**Files:**
- Modify: `scripts/seed-panorama.ts` `seedModelProvinceHistory` (~L2571 loop) — iterate ALL provinces (from `provinceProfile`), not just `MODEL_PROVINCES`. Use `provinceProfile(name)` for coverage. Keep the existing per-pet vaccination/sterilization Bernoulli-by-year logic (L2658-2700).

**Interfaces:**
- Consumes: `provinceProfile` (Task 1), `monthlyEventCount`/`pickDateInMonth` (Task 2).
- Produces: history pets across all 24 provinces with `pet_registered` (dated by registration year), `vaccination_administered`, `sterilization_performed` events.

- [ ] **Step 1:** Change the iteration source from `MODEL_PROVINCES` to all provinces with coordinates; resolve coverage via `provinceProfile(provinceName)`.
- [ ] **Step 2:** Tune `historyPetsPerLocality` / `HISTORY_SCALE` so total history pets stay within budget (e.g. ≤ ~30k) across 24 provinces.
- [ ] **Step 3:** Run `pnpm seed:panorama --dry-run` (or a guarded count) to sanity-check volume; then a real run on local DB.
- [ ] **Step 4:** Verify query: `pet_registered`, `vaccination_administered`, `sterilization_performed` exist for Córdoba, Salta, AND Mendoza in each of 2024/2025/2026.
- [ ] **Step 5:** Commit `feat(seed): multi-year pets + coverage events for all provinces`.

---

### Task 4: Zoonosis history (outbreak_signal + disease_reported) — all provinces

**Files:** Modify `seedModelProvinceHistory` zoonosis loop (~L2768/2856). Generalize to all provinces; date events with `monthlyEventCount(zoonosisRate, archetype, y, m, rng)` + `pickDateInMonth`.

- [ ] **Step 1:** Mirror the existing zoonosis insertion but loop months 2024-01..2026-06, emitting `outbreak_signal` + `disease_reported` events at locality centroids with payload `{province, locality, ...}`.
- [ ] **Step 2:** Run seed.
- [ ] **Step 3:** Verify query: zoonosis events for Córdoba/Salta/Mendoza in all 3 years; Salta rising, Córdoba falling.
- [ ] **Step 4:** Commit `feat(seed): multi-year zoonosis history for all provinces`.

---

### Task 5: Mortality history (death_recorded) — all provinces

**Files:** Modify `seedModelProvinceHistory`. New per-month `death_recorded` events (payload incl. `disposal_method` from the base seed's distribution).

- [ ] **Step 1:** Mirror the base seed's `death_recorded` generation (find it in the recent-window code); emit dated across the window via the rate model. Worsening provinces (Salta) trend up.
- [ ] **Step 2:** Run seed. **Step 3:** Verify: mortality layer + `/gob/mortalidad` trend has data for Córdoba/Salta/Mendoza across years. **Step 4:** Commit `feat(seed): multi-year mortality history`.

---

### Task 6: Bites history (incident_reported) — all provinces

**Files:** Modify `seedModelProvinceHistory`. Per-month `incident_reported` events with `incident_type ∈ {bite_inflicted,bite_suffered}`, seasonal (summer peak).

- [ ] **Step 1:** Emit dated bite events at locality centroids. **Step 2:** Run. **Step 3:** Verify: mordeduras layer + vigilancia bites for Córdoba/Salta/Mendoza across years. **Step 4:** Commit `feat(seed): multi-year bite-incident history`.

---

### Task 7: Pérdidas history (pet_lost / pet_found_sighting / status_changed)

**Files:** Modify `seedModelProvinceHistory`. Per-month lost/found events on a subset of history pets.

- [ ] **Step 1:** Emit `pet_lost` + later `pet_found_sighting`/`status_changed` events dated across the window (payload `{kind, province, locality}`). **Step 2:** Run. **Step 3:** Verify: perdidas layer + `/gob/perdidas` for Córdoba/Salta/Mendoza across years. **Step 4:** Commit `feat(seed): multi-year pérdidas history`.

---

### Task 8: Adoptions history (adoption_finalized + ownerships)

**Files:** Modify `seedModelProvinceHistory`. Per-month adoption events + custody/foster ownerships for the funnel.

- [ ] **Step 1:** Mirror the base adoption/ownership generation; date across window. **Step 2:** Run. **Step 3:** Verify: `/gob/adopciones` funnel + trend + time-in-state for Córdoba/Salta/Mendoza across years. **Step 4:** Commit `feat(seed): multi-year adoptions history`.

---

### Task 9: Denuncias history (welfare_reports)

**Files:** Modify `seedModelProvinceHistory` (or a sibling `seedHistoryWelfare`). Per-month `welfare_reports` rows (PANO-tagged), varied kind/severity, at locality centroids.

- [ ] **Step 1:** Mirror the base welfare-report generation; date `createdAt` across window. **Step 2:** Run. **Step 3:** Verify: denuncias layer + `/gob/maltrato` for Córdoba/Salta/Mendoza across years. **Step 4:** Commit `feat(seed): multi-year denuncias history`.

---

### Task 10: Cases history (custody_dispute + decomiso)

**Files:** Modify the seed. Per-quarter `cases` rows (PANO-tagged) for disputes + decomisos across the window.

- [ ] **Step 1:** Mirror the base `cases` generation (custody_dispute, decomiso) with `openedAt`/`jurisdictionProvince`/`jurisdictionLocality` dated across window. **Step 2:** Run. **Step 3:** Verify: disputas + decomisos (panorama decomisos layer + `/gob/disputas` + `/gob/decomisos`) for Córdoba/Salta/Mendoza across years. **Step 4:** Commit `feat(seed): multi-year cases (disputes+decomisos) history`.

---

### Task 11: Campaigns history (offerings/slots/appointments)

**Files:** Modify the seed (campaign generation block). Historical campaign offerings + slots + appointments across the window.

- [ ] **Step 1:** Mirror the base campaign generation; create offerings dated across quarters with appointments (attended/no-show/confirmed). **Step 2:** Run. **Step 3:** Verify: `/gob/campanas` trend + attendance for Córdoba/Salta/Mendoza across years. **Step 4:** Commit `feat(seed): multi-year campaigns history`.

---

### Task 12: Verification Matrix script + assertion

**Files:**
- Create: `scripts/verify-history-coverage.ts` (queries the DB, prints a matrix, exits non-zero if any cell is empty for Córdoba/Salta).
- Test: optional `__tests__/history-coverage.test.ts` (DB-integration) asserting the matrix.

**Interfaces:**
- Consumes: a seeded DB.
- Produces: a pass/fail report — for {Córdoba, Salta} × {every event type} × {2024,2025,2026}, count > 0; plus spot-checks for Buenos Aires/Mendoza/Tucumán.

- [ ] **Step 1:** Write `verify-history-coverage.ts`: for each (province, eventType, year) cell in the spec's matrix, run a COUNT query and collect zeros.
- [ ] **Step 2:** Run `pnpm tsx scripts/verify-history-coverage.ts` → expect ALL cells non-zero for Córdoba & Salta.
- [ ] **Step 3:** If any cell is zero, go back to the owning task and fix the generation. Re-run until clean.
- [ ] **Step 4:** Commit `chore(seed): history-coverage verification script`.

---

## Final gate (after all tasks)

- [ ] `pnpm seed:panorama` runs clean; `pnpm seed:panorama --clean` removes all PANO- rows (idempotency check: clean → re-seed → identical counts).
- [ ] `pnpm typecheck` + `pnpm lint` clean.
- [ ] `pnpm test` green (full suite).
- [ ] `scripts/verify-history-coverage.ts` passes (every matrix cell for Córdoba/Salta non-zero across 2024-2026).
- [ ] Manual: rebuild prod, browser-check the scrubber + each dashboard in Córdoba, Salta, and a uniform province.
