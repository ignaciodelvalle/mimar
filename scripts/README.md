# scripts/

Runnable scripts invoked via `pnpm` commands. All TypeScript unless noted.

---

## DB / Seed

| File | Description |
|---|---|
| `_load-env.ts` | Side-effect env loader — import first in any script that touches `@/db` so `DATABASE_URL` is set before drizzle evaluates. |
| `db-bootstrap.ts` | Bootstraps a brand-new Postgres instance to the state the test suite expects (schema + baseline data). |
| `migrate.ts` | Forward-only SQL migration runner for `db/migrations/*.sql`; supports `--status`, `--check`, `--baseline` flags. |
| `migrate-vets-to-clinics.ts` | One-time idempotent codemod: migrated vet orgs to clinic orgs (applied 2026-05-20, kept for test coverage). |
| `rebuild-projections.ts` | Replays `pet_events` log and compares derived projection state against live `pets` rows; reports drift. |
| `rls-smoke.ts` | RLS smoke test — verifies row-level security policies hold for owner-facing tables. |
| `register-server-only-stub.mjs` | ESM loader stub that satisfies `server-only` imports when scripts run outside Next.js. |

## Seed — Demo / Perf / Coverage

| File | Description |
|---|---|
| `seed-test-users.ts` | Realistic test-data seed: drives signups and elevated grants through the real writer functions. |
| `seed-demo.ts` | Entry point for the full institutional demo dataset. |
| `seed-demo-spine.ts` | Additional demo assets layered on top of `seed-demo.ts` for mid-demo flows. |
| `seed-demo-scenario.ts` | Deterministic focal CABA scenario seed for the executive demo; layers on top of `seed-panorama`. |
| `seed-panorama.ts` | Synthetic national dataset for government dashboards and the situational console. |
| `seed-coverage.ts` | Feature-coverage seed — ensures every feature branch has representative data. |
| `seed-perf.ts` | Volume seed (~2 000 synthetic pets) for pagination and performance testing. |
| `seed-storylines-original10.ts` | Original 10 pet storylines, relocated to CABA Comunas 1/2/14. |
| `seed-storylines-iconic.ts` | Iconic-pet workflow-test storylines (bite incidents, welfare, adoptions). |
| `seed-storylines-dangerous.ts` | Dangerous-breed storylines covering rabies/PCR/euthanasia workflows. |
| `seed-storylines-legends.ts` | Three historically iconic dogs as workflow stressors for 5 previously-missing event types. |
| `seed-storylines-supporting.ts` | 15 ordinary supporting-cast pets distributed across CABA for dashboard population. |
| `seed-history-utils.ts` | Shared utilities for history/timeline seeding (imported by storyline scripts). |
| `reset-demo-pets.ts` | Deletes the curated demo pets (`DIM-DEMO-*`, `DIM-ARGO-DEMO`, `DIM-BRUNO-DEMO`) so the seeds recreate them through the real intake circuit. Local-only, requires `--yes`, audit-logged. |

## Cron / Scheduled Operations

| File | Description |
|---|---|
| `close-followup-expired-adoptions.ts` | Daily: closes `adoption_listing` cases whose follow-up window has expired. |
| `close-rabies-observations.ts` | Daily: closes 10-day rabies observations whose period has elapsed. |
| `close-stale-lost-episodes.ts` | Daily: closes `lost_pet_episode` cases inactive for more than 180 days. |
| `escalate-stale-disputes.ts` | Daily: escalates `custody_dispute` cases open for more than 365 days. |
| `escalate-stale-welfare-cases.ts` | Daily: escalates `welfare_denuncia` cases inactive for more than 90 days. |
| `expire-cross-org-transfers.ts` | Daily: closes cross-org transfer handshakes open for more than 30 days. |
| `materialize-slots.ts` | Runs `materializeAllActiveSlots()` for slot-based scheduling surfaces. |
| `backfill-eno-trigger.ts` | One-time backfill: replays missed ENO notifications for historical events (post PR #137 fix). |
| `close-rabies-observations.ts` | See above (also runnable as a cron via `pnpm close:rabies-observations`). |

## Data Import

| File | Description |
|---|---|
| `import-indec-localities.ts` | Imports INDEC CPPDyL locality dataset into `ar_localities`. |
| `import-caba-barrios.ts` | Imports the 48 CABA barrios (Ley 1.777 / Comunas 2005) into `ar_localities`. |

## QA / Verification

| File | Description |
|---|---|
| `qa-routes.ts` | Click-through QA runner — exercises all routes against a running app. |
| `qa-session.ts` | Auth harness — derives valid Supabase SSR cookie headers for a test user. |
| `qa-timing.ts` | Page latency sweep against `localhost:3001`; reports p50/p95 per route. |
| `qa-query-census.ts` | Per-page DB query census; resets `pg_stat_statements` and counts queries per role/route. |
| `verify-history-coverage.ts` | Asserts the full "no panel without data" history coverage matrix. |
| `demo-verify.ts` | Demo readiness verifier — checks all demo invariants after `seed:demo:scenario`. |
| `detect-pet-cache-drift.ts` | Production drift detector for the `pets` dual-write cache columns (ARCH-I). |
| `seed-history-utils.test.ts` | Vitest unit tests for `seed-history-utils.ts` idempotency contract. |

## Codemods (one-time, archived in-tree)

| File | Description |
|---|---|
| `codemod-poncho-tokens.ts` | Replaces raw Tailwind palette classes with `gob-*` Poncho semantic tokens. |
| `codemod-purge-dark.ts` | Removes all `dark:` Tailwind prefix classes from JSX `className` attributes. |
| `codemod-status-tints.cjs` | Migrates legacy status tint classes to the `st-*` design-token layer (CommonJS). |
