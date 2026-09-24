# DB Bootstrap Runbook

Operational reference for `pnpm db:bootstrap` — the script that brings a fresh
Postgres instance to the full DIM schema + seed state.

For standing up a **remote Supabase environment** (staging / prod) see
`remote-supabase-bootstrap-runbook.md` (dim-interno:docs/ops/remote-supabase-bootstrap-runbook.md),
which documents the gotchas specific to Supabase Cloud (pooler URL, local stack
interference, psql path on Windows, etc.).

---

## Bootstrap steps overview

| Step | What it does |
|------|-------------|
| 1 | `pnpm db:push` — drizzle-kit syncs `db/schema.ts` → DB (tables, enums, indexes, FKs) |
| 2 | Replay `db/migrations/*.sql` best-effort (CHECK constraints, functions, triggers) |
| 2.5 | Baseline `_dim_migrations` tracking table so `db:migrate` is a no-op after bootstrap |
| 3 | Apply `db/triggers.sql`, `db/storage.sql`, `db/welfare_storage.sql` STRICT |
| 4 | Seed reference data: INDEC localities, CABA barrios, test users |

```
pnpm db:bootstrap              # full (steps 1-4)
pnpm db:bootstrap --no-seeds  # schema only (steps 1-3), skip step 4
pnpm db:bootstrap --bare      # schema only (step 1), fastest
pnpm db:bootstrap --allow-remote  # opt out of localhost-only guard (staging)
```

---

## INDEC localities catalog

### What it is

`ar_localities` holds ~4 000 Argentine localities from INDEC's CPPDyL census
dataset (Georef service). It backs the province/locality picker on every filter
surface and is the authority for locality validation.

Relevant files:

- `db/schema.ts` — `arLocalities` + `arLocalitiesImportRuns` table definitions
- `scripts/import-indec-localities.ts` — the importer (idempotent, upsert-based)
- `scripts/__fixtures__/indec-localidades-sample.csv` — 8-row sample (tests + fallback)

### Data source resolution (checked in order)

1. **`INDEC_LOCALITIES_CSV` env var** — absolute or repo-relative path to a local
   vendored CSV. No network required. Fastest option for reproducible envs.

   ```
   INDEC_LOCALITIES_CSV=/data/localidades_censales.csv pnpm db:bootstrap
   ```

2. **`--source-url=<url>` CLI flag** — fetch from an explicit URL.

   ```
   node --env-file=.env.local --import tsx scripts/import-indec-localities.ts \
     --source-url=https://my-mirror.example/localidades_censales.csv
   ```

3. **Default live URL** (`https://infra.datos.gob.ar/georef/localidades_censales.csv`).
   If the fetch fails (network down, INDEC unreachable), the script **falls back**
   to the bundled sample fixture with a warning, so bootstrap never hard-fails.
   The catalog will only contain the sample rows in that case — re-run the import
   when the source is reachable.

### Idempotency

The importer is fully idempotent:

- Each row is upserted by `indec_id`. Re-running with the same CSV produces
  `noop=N, inserted=0, updated=0`.
- Rows that disappear from the CSV are **soft-deleted** (`removed_at` stamped).
  They are restored on the next run if the CSV includes them again.
- `ar_localities_import_runs` logs every run (status `ok` / `failed`, counts,
  `source_version` from the `Last-Modified` header).

### Running against prod / staging

**Do NOT run `pnpm db:bootstrap` against prod** — it is destructive. For a fresh
remote environment follow
`remote-supabase-bootstrap-runbook.md` (dim-interno:docs/ops/remote-supabase-bootstrap-runbook.md).

To update the catalog on an existing remote environment (without touching schema):

```powershell
# Session pooler DATABASE_URL required; see remote runbook §Prerequisites.
node --env-file=.env.local --import tsx scripts/import-indec-localities.ts
```

Or, with a vendored CSV:

```powershell
$env:INDEC_LOCALITIES_CSV = "C:\path\to\localidades_censales.csv"
node --env-file=.env.local --import tsx scripts/import-indec-localities.ts
```

Plain `pnpm tsx` fails with `DATABASE_URL is not set` because `db/index.ts` does
not load `.env.local`. Always use `node --env-file=.env.local --import tsx`.

### Verification

```sql
-- Expect ~4 075 rows after a full import (INDEC + CABA barrios).
select count(*) from ar_localities where removed_at is null;

-- Break down by source.
select source, count(*) from ar_localities where removed_at is null group by source;

-- Last successful import run.
select source_url, status, inserted_count, updated_count, noop_count, source_version, finished_at
from ar_localities_import_runs
order by finished_at desc
limit 5;
```

### Obtaining the full vendored CSV

The live source is the Argentine government's Georef API:

- Dataset page: <https://www.datos.gob.ar/dataset/jgm_8/archivo/jgm_8.12>
- Direct download: <https://infra.datos.gob.ar/georef/localidades_censales.csv>

Download once and commit to `scripts/__fixtures__/` (or store out of repo) to
make bootstrap network-independent:

```powershell
Invoke-WebRequest `
  -Uri "https://infra.datos.gob.ar/georef/localidades_censales.csv" `
  -OutFile "scripts/__fixtures__/indec-localidades-full.csv"
```

Then set `INDEC_LOCALITIES_CSV=scripts/__fixtures__/indec-localidades-full.csv`
in `.env.local` (or CI secrets) so bootstrap always uses the vendored copy.

> The full CSV is ~625 KB. Committing it in-tree is a team decision — it keeps
> bootstrap fully offline but adds ~625 KB to the repository history.
