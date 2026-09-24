# Location domain — P3 (DB column-convergence, deploy 2/3) — executable plan

> **EXECUTION GATED — do NOT run migrations as part of the autonomous block.**
> This plan is written and ready; execution requires owner sign-off (Nacho) before any migration runs.
>
> **Date:** 2026-06-18
> **Owner:** Ignacio Del Valle (sign-off required before any deploy step)
> **Epic:** Location domain #41 — "deploy 2/3" phase
> **Spec/proposal:** `docs/planning/location-domain-proposal-2026-06.md` (§4 phases, §5 non-goals, §8 P3/P4 gate)
> **Prior plan:** `docs/superpowers/plans/2026-06-18-location-domain-p1-p2-p35.md` (P1/P2/P3.5 record)
> **NO includes:** P4 (PostGIS). Documented NO-OP for v1.0 — see §7.

---

## Status of prior phases (record)

| Phase | PR | Status |
|---|---|---|
| P3.5 — fix `LocalityPickerAcross` id/name | #601 | ✅ merged |
| P1 — `LocationValue` + `parseLocationFromFormData` | #602 | ✅ merged |
| P2 — `normalizeLocationForWrite` gate + MarkLost hardening | #603 | ✅ merged |
| P3 Deploy 1 — additive migration 0101 + dual-write + COALESCE reads | #604 | ✅ merged |

**Deploy 1 is done.** Migration 0101 has landed. The schema state as of develop is:

- `pet_events.location_lat/lng` — `numeric(10,7)` — canonical, always-written, always-read (no legacy columns).
- `welfare_reports.location_lat/lng` — `numeric(10,7)` — same.
- `organizations.location_lat/lng` — `numeric(10,7)` — **new canonical**, added in 0101; dual-written alongside legacy `latitude/longitude numeric(9,6)`.
- `organizations.latitude/longitude` — `numeric(9,6)` — **legacy**, kept for backward compat; still dual-written; reads use `COALESCE(location_lat, latitude)`.
- `cases.location_lat/lng` — `numeric(10,7)` — **new canonical**, added in 0101; dual-written alongside legacy `primary_location_lat/lng numeric(10,7)`.
- `cases.primary_location_lat/lng` — `numeric(10,7)` — **legacy**, kept for backward compat; reads use `COALESCE(location_lat, primary_location_lat)`.
- `lib/location.ts` — universal `readPoint(row, mapping?)` / `writePoint(value, mapping?)` with `ColumnMapping` type and exported `CASE_PRIMARY_COLUMNS` / `ORG_LEGACY_COLUMNS` constants for the dual-write transition window.

---

## 0. Before you touch anything

Mandatory reading:

1. **`docs/planning/location-domain-proposal-2026-06.md`** — design proposal. If this plan contradicts it, the proposal wins.
2. **`db/schema.ts` lines ~778–784 (organizations)** and **~3073–3081 (cases)** — current dual-column state for both tables.
3. **`db/migrations/0101_location_columns_converge.sql`** — Deploy 1 migration (additive). This plan adds Deploy 2 only; Deploy 3 (FK) is a separate optional migration.
4. **`lib/location.ts`** — universal `readPoint`/`writePoint` with column-mapping overloads. Already the single PostGIS swap point.
5. **All callers of `ORG_LEGACY_COLUMNS` and `CASE_PRIMARY_COLUMNS`** — these must be rotated to default canonical columns before any legacy column drop runs.

**Baseline:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` must be green on develop before starting any step.

**STOP:** If any step in §4 touches a running production database, get explicit sign-off from Nacho first. Do not batch migrations with feature code.

---

## 1. What this plan builds

**Deploy 2 — contract phase (drop legacy columns):**
- Remove dual-write of legacy columns in all code that writes `organizations` and `cases` locations.
- Rotate all reads from `COALESCE(canonical, legacy)` to `canonical` only (no fallback needed — backfill in 0101 already populated canonicals).
- New migration `0102_location_drop_legacy.sql`: drop `organizations.latitude`, `organizations.longitude`, `cases.primary_location_lat`, `cases.primary_location_lng`. Also `VALIDATE CONSTRAINT` the pair checks added as `NOT VALID` in 0101.
- Clean up the exported `CASE_PRIMARY_COLUMNS` / `ORG_LEGACY_COLUMNS` constants and the `ColumnMapping` fallback logic from `lib/location.ts` once no callers remain.

**Deploy 3 (optional) — nullable FK `ar_localities(indec_id)`:**
- Add optional `locality_indec_id text REFERENCES ar_localities(indec_id)` to relevant tables (pet_events, welfare_reports, organizations) as a nullable audit column populated from `LocationValue.localityIndecId`.
- This is additive (expand-only), so it can ship independently after Deploy 2.

---

## 2. Closed decisions (from proposal — do NOT relitigate)

- **Expand → migrate code → contract** phasing: NEVER drop the old columns in the same migration that adds the new ones. Deploy 1 (0101) is already done. Deploy 2 (0102) is the contract.
- **`readPoint` / `writePoint` with `ColumnMapping`** are the universal API. App code MUST NOT access `latitude`/`longitude` or `primary_location_lat/lng` directly after Deploy 2. The mapping constants in `lib/location.ts` are the only allowed transition bridge.
- **PostGIS = documented NO-OP (Option B, v1.0).** `lib/location.ts` is already the single swap point. No geography columns in this plan.
- **Widen `organizations.latitude/longitude` from `numeric(9,6)` → `numeric(10,7)`** is already done implicitly: Deploy 1 added the canonical `location_lat/lng numeric(10,7)` and backfilled from the old columns. Deploy 2 drops the old narrow columns — no explicit widen migration needed.
- **Nullable FK `ar_localities(indec_id)`** travels with Deploy 3, not Deploy 2.

---

## 3. Scope

**Included:** Deploy 2 (contract: code rotation + legacy column drop migration). Deploy 3 (FK) as an optional follow-on.

**Excluded (still gated):**
- P4 — PostGIS. NO-OP for v1.0. `lib/location.ts` is the documented swap point; when PostGIS lands, only the body of `readPoint`/`writePoint` changes.
- Any change to `ar_localities` data or import pipeline.
- Any change to province-name storage (CHECK 0055 still governs; display names stay as-is).

---

## 4. Step-by-step phases

### Phase A — Audit: confirm all callers are rotatable

Before writing any migration, run the caller audit:

```bash
# Find all uses of the legacy mapping constants (must go to zero before 0102 runs)
rg -n "ORG_LEGACY_COLUMNS|CASE_PRIMARY_COLUMNS" app lib components

# Find any direct column reads that bypass readPoint (should already be zero after P3 Deploy 1)
rg -n "\.latitude\b|\.longitude\b|\.primaryLocationLat|\.primaryLocationLng" app lib components

# Find any direct writes that bypass writePoint
rg -n "latitude:|longitude:|primaryLocationLat:|primaryLocationLng:" app lib components
```

Expected: `ORG_LEGACY_COLUMNS` and `CASE_PRIMARY_COLUMNS` appear only in `lib/location.ts` (definitions) and their dual-write call sites. Direct column accesses should already be zero (P3 Deploy 1 rotated them). If any remain, fix them before proceeding to Phase B.

**STOP if any direct accesses remain — do not proceed to Phase B until the audit is clean.**

### Phase B — Code rotation (no DB changes)

1. **Organizations writes:** In all server actions / mutations that write `organizations` location:
   - Remove the dual-write of `ORG_LEGACY_COLUMNS` (the secondary `writePoint(point, ORG_LEGACY_COLUMNS)` call).
   - Keep only `writePoint(point)` (canonical columns, default mapping).

2. **Cases writes:** In all server actions / mutations that write `cases` location:
   - Remove the dual-write of `CASE_PRIMARY_COLUMNS`.
   - Keep only `writePoint(point)` (canonical columns).

3. **Organizations reads:** Where `readPoint(row, ORG_LEGACY_COLUMNS)` or `COALESCE`-style fallback reads are used:
   - Switch to `readPoint(row)` (canonical columns only).
   - The backfill in migration 0101 already populated `location_lat/lng` from `latitude/longitude` for all existing rows — the fallback is no longer needed.

4. **Cases reads:** Where `readPoint(row, CASE_PRIMARY_COLUMNS)` or fallback reads are used:
   - Switch to `readPoint(row)` (canonical columns only).
   - Same justification: 0101 backfill covered all existing rows.

5. **`lib/location.ts` cleanup (after callers are rotated):**
   - Remove `ORG_LEGACY_COLUMNS` export.
   - Remove `CASE_PRIMARY_COLUMNS` export.
   - Optionally remove the `ColumnMapping` type and the second `writePoint` overload if no caller passes a custom mapping anymore.
   - Keep the single-arg `readPoint(row)` / `writePoint(point)` signatures and all existing JSDoc unchanged — they are the PostGIS swap contract.

6. **Verification after Phase B (before any migration):**
   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   rg -n "ORG_LEGACY_COLUMNS|CASE_PRIMARY_COLUMNS" app lib components  # must be zero callers
   ```

### Phase C — Deploy 2 migration (OWNER SIGN-OFF REQUIRED before running)

> **⚠️ GATE:** Do not write or apply this migration without explicit go-ahead from Nacho. Phase B (code) must be merged and deployed first. The migration runs only after the code that reads/writes the legacy columns is no longer in production.

New file: `db/migrations/0102_location_drop_legacy.sql`

```sql
-- Migration 0102: location column convergence (DEPLOY 2 — contract phase).
--
-- Drops the legacy coordinate columns now that all code reads/writes the
-- canonical location_lat/location_lng numeric(10,7) columns added in 0101.
--
-- Pre-conditions (must be verified before running):
--   1. Migration 0101 is applied and all canonical columns are populated.
--   2. All app code no longer reads latitude/longitude or primary_location_lat/lng.
--   3. Phase B code rotation is merged and in production (or staging sign-off given).
--
-- EXECUTION GATED on owner sign-off (Nacho). Do NOT run as part of autonomous block.

BEGIN;

-- Validate pair-check constraints added as NOT VALID in 0101.
-- Now that the backfill ran and code is rotated, full-table validation is safe.
ALTER TABLE public.cases
  VALIDATE CONSTRAINT cases_location_pair_check;

ALTER TABLE public.organizations
  VALIDATE CONSTRAINT organizations_location_pair_check;

-- Drop legacy organizations coordinate columns (9,6 precision; superseded by location_lat/lng 10,7).
ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS latitude,
  DROP COLUMN IF EXISTS longitude;

-- Drop legacy cases coordinate columns (primary_location_lat/lng; superseded by location_lat/lng).
ALTER TABLE public.cases
  DROP COLUMN IF EXISTS primary_location_lat,
  DROP COLUMN IF EXISTS primary_location_lng;

COMMIT;
```

**Rollback for Deploy 2:** If the drop causes an unexpected issue, restore the columns from backup (Supabase point-in-time recovery). There is no forward-compatible `ADD COLUMN` rollback for column drops — verify Phase B is complete and tested before running. The expand→migrate→contract phasing means rollback at this stage requires a DB restore, which is why owner sign-off is mandatory.

**Schema changes after 0102 applies:**
- Remove `latitude/longitude` fields from the `organizations` Drizzle table definition in `db/schema.ts`.
- Remove `primaryLocationLat/primaryLocationLng` fields from the `cases` Drizzle table definition in `db/schema.ts`.
- Remove the migration-comment annotations referencing them.
- Run `pnpm drizzle-kit generate` if needed to sync; alternatively, since 0102 is a hand-written migration, just edit `schema.ts` to reflect the post-drop state.

### Phase D — Deploy 3: nullable FK `ar_localities(indec_id)` (optional, independent)

> This phase is additive (expand-only) and can ship as a separate PR after Deploy 2. No owner gate beyond normal review — it's a nullable FK, zero data loss risk.

New file: `db/migrations/0103_locality_fk.sql`:

```sql
-- Migration 0103: optional nullable FK locality_indec_id on coordinate tables.
--
-- Adds audit-quality FK linking stored localityIndecId values back to the
-- ar_localities catalogue. Nullable — existing rows without a resolved INDEC ID
-- are unaffected. Not a hard constraint on writes: the FK is DEFERRABLE
-- INITIALLY DEFERRED so bulk imports can still run in a single transaction.

BEGIN;

ALTER TABLE public.pet_events
  ADD COLUMN IF NOT EXISTS locality_indec_id text
    REFERENCES public.ar_localities(indec_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.welfare_reports
  ADD COLUMN IF NOT EXISTS locality_indec_id text
    REFERENCES public.ar_localities(indec_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS locality_indec_id text
    REFERENCES public.ar_localities(indec_id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

COMMIT;
```

Code changes for Deploy 3:
- Update `lib/location.ts` `writePoint` return types (or add a separate helper) to include `localityIndecId` when the caller has it from `LocationValue`.
- Update server actions that receive `LocationValue` to persist `localityIndecId` alongside coordinates.
- Update Drizzle schema `db/schema.ts` to declare the three new nullable columns.

---

## 5. Verification checklist

After Phase B (before 0102 runs):
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm test` green
- [ ] `rg "ORG_LEGACY_COLUMNS|CASE_PRIMARY_COLUMNS" app lib components` — zero results outside `lib/location.ts` definition file
- [ ] `rg "\.latitude\b|\.longitude\b|\.primaryLocationLat|\.primaryLocationLng" app lib components` — zero results
- [ ] Smoke: create/edit an org with coordinates → confirm `location_lat/lng` populated, `latitude/longitude` NOT dual-written
- [ ] Smoke: create a case with coordinates → confirm `location_lat/lng` populated, `primary_location_lat/lng` NOT dual-written

After 0102 runs (Deploy 2 complete):
- [ ] `pnpm typecheck` clean (schema updated to remove dropped columns)
- [ ] `pnpm test` green
- [ ] Smoke: org profile map pin still renders correctly
- [ ] Smoke: case location still readable and correct
- [ ] `SELECT location_lat, location_lng FROM organizations LIMIT 5` — canonical values present
- [ ] Confirm old columns absent: `SELECT latitude FROM organizations LIMIT 1` → error (column does not exist)

---

## 6. Rollback strategy per phase

| Phase | Rollback |
|---|---|
| Phase A (audit) | No DB changes — no rollback needed. |
| Phase B (code rotation) | Revert the PR. Legacy columns still exist; dual-write and COALESCE reads can be re-enabled. |
| Phase C (Deploy 2 migration 0102) | **Point-in-time DB restore required** (Supabase PITR). Column drops are not reversible via migration. This is why owner sign-off and Phase B deployment are mandatory pre-conditions. |
| Phase D (Deploy 3 migration 0103) | `ALTER TABLE ... DROP COLUMN locality_indec_id` on each table — additive FK, safe to reverse. |

**The expand→migrate→contract phasing means that if Phase B is fully deployed before Phase C runs, the risk window is zero: no code will break when the legacy columns disappear because no code reads them anymore.**

---

## 7. What stays deferred (P4 — PostGIS)

`lib/location.ts` is explicitly the PostGIS swap point. When P4 lands (out of scope for v1.0):
- Add `location_point geography(Point, 4326)` computed or stored alongside `location_lat/lng`.
- Update only the body of `readPoint` and `writePoint` — signatures stay identical.
- All app code is insulated; no fan-out refactor needed.

The `ColumnMapping` type and overloads in `lib/location.ts` may be removed in Deploy 2 cleanup (Phase B step 5) — they served their purpose during the convergence window. PostGIS will use the default-arg form only.

---

## Next step

Owner (Nacho) reviews and signs off on this plan → Claude Code executes Phase A (audit) + Phase B (code rotation) as a normal autonomous block, then stops. Phase C (migration 0102) runs only with explicit go-ahead after Phase B is merged to production.
