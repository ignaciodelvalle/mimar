# Local Dev + Testing Runbook

How to bring a fresh checkout up to a working local stack, seed it, and run the
test suite — plus the sharp edges that have bitten us before. Ops-facing, so
English (matches the other `docs/ops/*-runbook.md` files).

For the deeper schema bring-up (`pnpm db:bootstrap`), see
[`db-bootstrap-runbook.md`](./db-bootstrap-runbook.md). This doc is the everyday
path: Supabase → seed → tests.

---

## 1. Bring up Supabase (Docker)

Local dev runs against the Supabase CLI stack in Docker. Docker Desktop must be
running first.

```sh
pnpm db:start      # supabase start — boots Postgres + Auth + Studio in Docker
pnpm db:status     # supabase status — prints local URLs + keys
```

- Postgres: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- Supabase API: `http://127.0.0.1:54321`
- Studio: `http://127.0.0.1:54323`

Stop it with `pnpm db:stop`. To wipe and re-apply all migrations from scratch:

```sh
pnpm db:reset      # supabase db reset — drops, recreates, re-runs every migration
```

`.env.local` must carry the local keys. If `pnpm db:status` shows different
keys than your `.env.local`, sync them — the test harness force-corrects URLs
(see §4) but the dev server does not.

## 2. Seed data

Seed scripts live in `scripts/seed-*.ts` and are wired as `pnpm seed:*`. Most
run through a `server-only` stub loader; a few need the `react-server`
condition. Pick by what you're doing:

| Command | What it seeds |
|---|---|
| `pnpm seed:test` | Seed accounts (owner/vet/govt/admin) used by the suite + manual QA login |
| `pnpm seed:demo` | Demo dataset for funcionario outreach |
| `pnpm seed:demo:scenario` | Full demo scenario (uses `--conditions=react-server`) |
| `pnpm seed:flagship` | Flagship pet `DIM-PAMP-0001` (uses `--conditions=react-server`) |
| `pnpm seed:panorama` | Panorama/analytics dataset |
| `pnpm seed:coverage` | Compliance-coverage dataset for dashboards |

For a one-command QA environment (checks containers, build freshness vs HEAD,
starts the prod server on :3000, smoke-tests routes, verifies seed accounts):

```sh
pwsh scripts/qa-up.ps1            # optional: -Port 3000
```

`qa-up.ps1` starts Supabase for you if it isn't running, but does **not** seed —
run the seed command your task needs first.

## 3. Run the tests

```sh
pnpm test:verified # vitest run — the whole suite (not `pnpm test`: its exit code lies when a worker dies mid-file)
pnpm test:watch    # vitest — watch mode
```

**Reality as of 2026-07-29 (measured, not estimated).** The project split landed,
so `vitest.config.ts` runs two projects:

| project | files | tests | wall clock | how it runs |
|---|---|---|---|---|
| `unit` | 485 | 6.796 | **~40 s** | parallel workers, no DB |
| `db` | 581 | 5.730 | **~13 min** | `fileParallelism: false`, shared local Postgres |

Run just the fast half while iterating — it is the whole suite's coverage of
anything that does not touch the database:

```sh
pnpm exec vitest run --project unit
```

### `pnpm test:verified` exits 1 even when nothing fails — known, being worked

The run ends with `Worker exited unexpectedly` and a non-zero exit while
reporting **zero failing tests**. Read the test counts, not the exit code, until
this is closed.

Two things this page used to claim, both now disproved by measurement:

- ~~`globalSetup` closes the postgres.js pool at the end.~~ It never did — its
  `teardown` was an explicit no-op, and it cannot reach the worker's pool from
  the main process anyway. Pools are now drained per file by `closeDbPools()`
  in `__tests__/setup.ts`. That change alone recovered 5 tests that were being
  lost with the sockets (the reported total now reconciles exactly).
- ~~The error is postgres.js socket teardown.~~ Pools are not the cause; see
  above.
- ~~Run alone, each project is clean, so the crash is an interaction between the
  parallel unit workers and the serial db worker.~~ **DISPROVED 2026-08-12.**
  That was true when measured and is not true now. Measured the same day, same
  machine, same DB, five runs:

  | project | runs | result |
  |---|---|---|
  | `--project unit` | 2 | exit 0 both times, 7860 tests, no worker error |
  | `--project db`   | 4 | exit 0 **once**, exit 1 three times with `Worker exited unexpectedly` |

  So `--project db` crashes ON ITS OWN, and the one clean run was luck. A
  control run at an earlier commit crashed the same way, which rules out any
  particular recent change. The "only when run together" framing sent one
  investigation down a bisect that could not have found anything — the treatment
  and the control both fail.

  Two symptoms worth recognising: the TEST COUNT moves between runs (7003 /
  6997 / 6982) while the file count barely does — tests disappear rather than
  fail, which is a worker dying mid-file, not an assertion breaking. And
  `app/org/[orgToken]/mascotas/[publicToken]/adoption/FinalizeAdoptionForm.interaction.test.tsx`
  failed in exactly one of the five runs and passed in the other four.

Do not spend time on the pool when chasing this; that ground is covered. And do
not use "`--project db` alone is clean" as a green light — it is not a reliable
signal any more. Read the counts.

  Medición del 2026-08-13, suite completa, cuatro corridas seguidas, mismo
  commit y misma máquina:

  | corrida | archivos | tests | exit |
  |---|---|---|---|
  | 1 | 1240 | 14927 | 0 |
  | 2 | 1239 | 14922 | 1 · `Worker exited unexpectedly` |
  | 3 | 1239 | 14922 | 1 · idéntica a la 2 |
  | 4 | 5028 suites | 14927 | 0 (`--reporter=json`, `success: true`) |

  Dos de cuatro. Y una trampa que costó una hora: **las corridas 2 y 3 dieron
  números IDÉNTICOS**, y de ahí se infirió "determinista, entonces lo rompió un
  cambio reciente". No se sigue. Un crash con disparador consistente puede
  repetir el mismo recuento sin ser reproducible siempre — la corrida 4, con
  exactamente los mismos cambios, pasó entera. Antes de bisectar por un exit 1,
  correr de nuevo: dos resultados iguales no son una prueba, son dos muestras.

Run a single file (e.g. a new fence) without the full 12-minute suite:

```sh
pnpm exec vitest run __tests__/event-catalog-count.test.ts
```

## 4. The URL force-correct (read this before debugging a weird test failure)

`__tests__/setup.ts` loads `.env.local` for keys, then **forces the Postgres +
Supabase URLs back to the local stack** regardless of what `.env.local` says.
This is deliberate, not a bug.

The failure it prevents is a **split-brain**: the suite's server actions call
`auth.admin.createUser` / `deleteUser` against whatever Supabase URL is
configured, while Drizzle queries hit local Postgres. If the Supabase URL points
at a **remote** project but Drizzle is local, a test creates an auth user
remotely, then the local profile lookup can't find it and you get:

```
PROFILE_UPDATE_FAILED: profile row not found
```

If you ever see that error in tests, the cause is almost always a URL/key
mismatch that slipped past the force-correct (e.g. a legacy JWT service key vs
the local `sb_secret_*`). Check `__tests__/setup.ts` and `pnpm db:status`.

Corollary: the harness issues **real** `auth.admin` create/delete calls, so
**never** point the test env at a remote project. That is a production incident,
not a failing test.

## 5. Never run two vitest instances at once

The suite serializes on purpose (§3) because it shares one local Postgres. A
second concurrent `vitest` run (e.g. `pnpm test:verified` in one terminal while a watch
run or an agent's run is live in another) writes to the same DB and produces
flaky, non-reproducible failures — rows appear/disappear mid-test. One vitest
process at a time, full stop. This also applies to parallel-writer worktrees:
local Supabase is shared across worktrees, so only one may run integration tests
at a time.

## 6. Worktree gotcha: missing `next-env.d.ts` → jpg import type errors

`next-env.d.ts` references `./.next/types/routes.d.ts`, which Next.js generates
during `next dev` / `next build`. A **fresh git worktree** has no `.next/`, so
that generated file is absent and `tsc` reports type errors on image imports
(`Cannot find module '*.jpg'` and friends).

This is **known noise**, not a real break. Resolve it by generating the Next.js
types once in the worktree:

```sh
pnpm build         # or start `pnpm dev` briefly — either generates .next/types
```

Do not "fix" it by editing `next-env.d.ts` (the file says not to edit it) or by
adding ad-hoc image type shims.
