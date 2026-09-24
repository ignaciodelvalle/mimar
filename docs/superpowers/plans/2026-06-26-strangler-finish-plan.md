# Strangler Finish Plan — `app/actions/` migration backlog

> Created: 2026-06-26  
> Status: **🟡 PARCIAL — verificado 2026-08-04.** El encabezado decía "not
> started" y el grueso está hecho: `app/actions/` bajó a ~70 archivos / ~5.900
> líneas (el plan hablaba de ~20.000). **Residual real**: los dos flujos que el
> propio plan marcaba como críticos siguen gordos y no son shims —
> `app/actions/decomiso.ts` (506 líneas) y `return-to-owner.ts` (263). Ese es
> el alcance que queda; el resto del documento es historia.  
> Owner: TBD (multi-session program)  
> CI guard: `pnpm lint:actions` (baseline: `scripts/action-line-budget-baseline.json`)

---

## Context

The hexagonal-lite architecture (`docs/architecture/hexagonal-lite.md`) requires all
business logic to live in `src/modules/<domain>/application/` use-cases, not in fat
`app/actions/*.ts` files. The `events` domain is the only fully completed migration:
the old `app/actions/events.ts` (≈2,920 lines) is now a thin shim; all logic lives in
`src/modules/events/`.

The remaining **~61 files in `app/actions/`** total ≈20,000 lines and are pending migration.
A CI line-budget ratchet prevents any existing file from growing, and caps new action
files at 150 lines. This plan provides the ordered backlog and per-file checklist for
completing the migration.

---

## Per-file recipe (applies to every file in the backlog)

Follow `hexagonal-lite.md §Strangler cut` exactly:

1. **Scaffold** `src/modules/<domain>/{domain,application,infrastructure}/` if not present.
2. **Domain first (test-first):** extract pure rules; reuse existing projections/lifecycles.
3. **Repository:** wrap Drizzle queries, transaction-threaded, returning domain types.
   Integration-test against Postgres.
4. **Use-cases:** one per operation; inject repo + authorized context; orchestrate;
   collect post-tx notifications; return `Result`.
5. **Thin action:** parse → auth guard → call use-case → flush notifications → redirect.
   No business rules in this layer.
6. **Parity tests:** verify the new path produces identical side-effects, audit rows,
   idempotency keys, and cascade closes as the original fat action.
7. **Strangler cut:** replace the fat body of `app/actions/<file>.ts` with a thin
   re-export shim (if the path is widely imported) or delete it if `src/modules/` is
   the sole entry point.
8. **CI check:** `pnpm lint:actions` must still pass after the cut (file shrinks → within
   budget). Run `pnpm verify` full.

> **Critical flows** (`return-to-owner.ts`, `decomiso.ts`): require extra parity coverage
> (idempotency keys, cross-org auth boundaries, audit trail completeness) AND a manual
> browser QA pass before declaring the migration complete.

---

## Migration backlog (ordered by blast-radius then size)

Ordering rationale: tackle highest-risk / largest files first so they stop accumulating
drift. Small files at the end are quick wins that clean up the tail.

### Tier 1 — Critical flows (highest blast-radius, manual QA required)

- [x] **`return-to-owner.ts`** — 1,929 lines → 382-line shim (strangler 2/61, commit 6923c612)
  - Domain: `pets` / `transfers` / `cases` (multi-domain orchestration)
  - Risk: ownership transfer, cross-org auth boundaries, audit trail, idempotency
  - Extra: parity tests must cover the full ownership-change state machine; browser QA
    of the return-to-owner form end-to-end before merging
  - Target: `src/modules/transfers/application/return-to-owner.ts`

- [x] **`decomiso.ts`** — 1,574 lines → 581-line shim/controllers (strangler 1/61, commit 1761f055)
  - Domain: `cases` / `welfare` / `pets`
  - Risk: legal seizure flow, custody transitions, audit trail, notification cascade
  - Extra: same parity + browser QA requirements as above
  - Target: `src/modules/welfare/application/` (or new `decomiso` sub-module TBD)

### Tier 2 — Large institutional/admin flows

- [x] **`admin-institutional.ts`** — 915 lines → 143-line shim (strangler 5/61, 2026-06-29)
  - Domain: `organizations`
  - Target: `src/modules/organizations/application/admin-institutional/`

- [x] **`service-offerings.ts`** — 782 lines → 338-line shim (strangler 3/61, commit 1c73b899)
  - Domain: `organizations` / new `services` sub-module TBD
  - Target: `src/modules/organizations/application/service-offerings/`

- [x] **`bulk-pet-events.ts`** — 752 lines → 191-line shim (strangler 6/61, 2026-06-29)
  - Domain: `events` (bulk vaccination) + `adoption` (bulk eligibility + bulk listing)
  - Target: `src/modules/events/application/bulk/` + `src/modules/adoption/application/`

- [x] **`custody-disputes.ts`** — 729 lines → 149-line shim (strangler 4/61, commit fcd6fe94)
  - Domain: `cases` / `welfare`
  - Target: `src/modules/welfare/application/custody-disputes/`

- [x] **`upgrade.ts`** — 667 lines → 178-line shim (strangler 7/61, 2026-06-29)
  - Domain: `organizations` (tier upgrade flows)
  - Target: `src/modules/organizations/application/upgrade/`

- [x] **`admin-revocations.ts`** — 606 lines → 130-line shim (strangler 8/61, 2026-06-29)
  - Domain: `organizations`
  - Target: `src/modules/organizations/application/revocations/`

### Tier 3 — Medium-sized domain flows

- [x] **`profile-self-service.ts`** — 510 lines → 106-line shim (strangler 9/61, 2026-06-30)
  - Domain: `pets` / `organizations`
  - Target: `src/modules/pets/application/profile/`

- [x] **`pet-claim.ts`** — 495 lines → 91-line shim (strangler 10/61, 2026-06-30)
  - Domain: `pets` / `cases`
  - Target: `src/modules/pets/application/claim/`

- [x] **`intake.ts`** — 483 lines → 37-line shim (strangler 11/61, 2026-06-30)
  - Domain: `pets` / `organizations`
  - Target: `src/modules/pets/application/intake/`

- [x] **`attendance.ts`** — 481 lines → 187-line shim (strangler 12/61, 2026-06-30)
  - Domain: `events` / `pets`
  - Target: `src/modules/events/application/attendance/`

- [x] **`microchip.ts`** — 460 lines → 50-line shim (strangler 13/61, 2026-06-30)
  - Domain: `pets`
  - Target: `src/modules/pets/application/microchip/`

- [x] **`service-dog.ts`** — 445 lines → 79-line shim (strangler 14/61, 2026-06-30)
  - Domain: `pets` / `organizations`
  - Target: `src/modules/pets/application/service-dog/`

- [x] **`business-rules.ts`** — 431 lines → 190-line shim (strangler 15/61, 2026-06-30)
  - Domain: `organizations` (PPP business rules)
  - Target: `src/modules/organizations/application/business-rules/`

### Remaining files (ordered by size — execute after Tier 3)

- [x] `alert-firings.ts` — 430 lines → 135-line shim (strangler 16/61, 2026-06-30)
- [x] `admin-decisions.ts` — 401 lines → 91-line shim (strangler 17/61, 2026-06-30)
- [x] `pregnancy.ts` — 383 lines → 144-line shim (strangler 18/61, 2026-06-30)
- [x] `profile.ts` — 354 lines → 75-line shim (strangler 19/61, 2026-06-30)
- [x] `admin-proposals.ts` — 353 lines → 114-line shim (strangler 20/61, 2026-06-30)
- [x] `chip-match.ts` — 339 lines → 86-line shim (strangler 21/61, 2026-06-30)
- [x] `admin-org-verification.ts` — 328 lines → 72-line shim (strangler 22/61, 2026-06-30)
- [x] `booking.ts` — 301 lines → 87-line shim (strangler 23/61, 2026-06-30)
- [x] `schedule-rules.ts` — 289 lines → 180-line shim (strangler 24/61, 2026-06-30)
- [x] `pet-tab-data.ts` — 278 lines → 76-line shim (strangler 25/61, 2026-06-30)
- [x] `auth.ts` — 266 lines → 18-line shim (strangler 26/61, 2026-06-30)
- [x] `amendment.ts` — 265 lines → 58-line shim (strangler 27/61, 2026-06-30)
- [x] `slot-materialization.ts` — 263 lines → 77-line shim (strangler 28/61, 2026-06-30)
- [x] `pet-sighting.ts` — 254 lines → 35-line shim (strangler 29/61, 2026-06-30)
- [x] `claim.ts` — 251 lines → 24-line shim (strangler 30/61, 2026-06-30)
- [x] `alert-subscriptions.ts` — 228 lines → 112-line shim (strangler 31/61, 2026-06-30)
- [x] `libreta-share.ts` — 218 lines → 118-line shim (strangler 32/61, 2026-06-30)
- [x] `checkin.ts` — 218 lines → 42-line shim (strangler 33/61, 2026-06-30)
- [x] `tattoo.ts` — 199 lines → 133-line shim (strangler 34/61, 2026-06-30)
- [x] `bulk-actions.ts` — 191 lines → 58-line shim (strangler 35/61, 2026-06-30)
- [x] `ppp-export-caba.ts` — 187 lines → 23-line shim (strangler 36/61, 2026-06-30)
- [x] `return-to-owner-form.ts` — 166 lines → 21-line shim (strangler 37/61, 2026-06-30)
- [x] `dni-verification.ts` — 151 lines → 56-line shim (strangler 38/61, 2026-06-30)
- [x] `apply-intent.ts` — 141 lines → 36-line shim (strangler 39/61, 2026-06-30)
- [x] `decomiso-pet-lookup.ts` — 123 lines → 21-line shim (strangler 40/61, 2026-06-30)
- [x] `bulk-adoption-actions.ts` — 120 lines → 42-line shim (strangler 41/61, 2026-06-30)
- [x] `reminders.ts` — 119 lines → 47-line shim (strangler 42/61, 2026-06-30)
- [x] `sign-timeline-attachments.ts` — 111 lines → 47-line shim (strangler 43/61, 2026-06-30)
- [x] `public.ts` — 109 lines → 35-line shim (strangler 44/61, 2026-06-30)
- [x] `pet-lookup-public.ts` — 105 lines → 21-line shim (strangler 45/61, 2026-06-30)
- [x] `localities.ts` — 105 lines → 46-line shim (strangler 46/61, 2026-06-30)
- [x] `geocoding.ts` — 105 lines → 53-line shim (strangler 47/61, 2026-06-30)
- [x] `password-reset.ts` — 94 lines → 16-line shim (strangler 48/61, 2026-06-30)
- [x] `approval-requests.ts` — 89 lines → 51-line shim (strangler 49/61, 2026-06-30)
- [x] `tier2-public.ts` — 82 lines → 23-line shim (strangler 50/61, 2026-06-30)
- [x] `achievement-views.ts` — 72 lines → 15-line shim (strangler 51/61, 2026-06-30)
- [x] `omnibox-search.ts` — 69 lines → 23-line shim (strangler 52/61, 2026-06-30)
- [x] `physical-tag-interest.ts` — 67 lines → 28-line shim (strangler 53/61, 2026-06-30)
- [x] `bulk-vaccinate-types.ts` — 65 lines → 19-line re-export shim (strangler 54/61, 2026-06-30)
- [x] `revocation-evidence.ts` — 63 lines → 16-line shim (strangler 55/61, 2026-06-30)
- [x] `quick-capture.ts` — 63 lines → 24-line shim (strangler 56/61, 2026-06-30)
- [x] `subject-rights.ts` — 59 lines → 16-line shim (strangler 57/61, 2026-06-30)
- [x] `scans.ts` — 59 lines → 18-line shim (strangler 58/61, 2026-06-30)
- [x] `notifications.ts` — 50 lines → 30-line shim (strangler 59/61, 2026-06-30)
- [x] `performed-by.ts` — 49 lines → 39-line shim (strangler 60/61, 2026-06-30)
- [x] `lost-mode.ts` — 37 lines → 20-line shim (strangler 61/61, 2026-06-30)
- [x] `rule-impact-preview.ts` — 24 lines. Verified 2026-07-01: already a thin
  "use server" shim (auth guard + delegate to `lib/rule-impact.ts` /
  `countDogsAffectedByRule`); no logic to migrate. Strangler complete (61/61).

> Test files (`*.test.ts`) in `app/actions/` are excluded from the migration — move
> them alongside their target module when the corresponding action is migrated.

---

## After each file is migrated

1. Update the checkbox above in this plan.
2. Remove the file's entry from `scripts/action-line-budget-baseline.json` (or set its
   baseline to the new thin shim size).
3. Run `pnpm lint:actions` to confirm the ratchet still passes.
4. Run `pnpm verify` full (typecheck + lint + build).
5. Open a PR referencing this plan.

---

## Definition of done (full program)

- All checkboxes above are checked.
- `app/actions/` contains only thin shims (≤150 lines each) or is empty.
- `scripts/action-line-budget-baseline.json` reflects only the shim sizes.
- `pnpm verify` passes.
- `pnpm test` passes with no regressions.
