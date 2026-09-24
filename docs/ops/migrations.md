# Production Migration Contract

## Rule: prod uses `db:migrate`, never `db:push`

| Command | What it does | When to use |
|---|---|---|
| `pnpm db:generate` | Generates a new versioned `.sql` file from schema diff | After editing `db/schema.ts` |
| `pnpm db:migrate` | Applies pending versioned migrations in order, tracked | Deploy time — prod and staging |
| `pnpm db:migrate:status` | Prints applied vs pending migrations | Anytime — to inspect state |
| `pnpm db:migrate:baseline` | Marks migrations applied **without running them** | First adoption on an existing DB |
| `pnpm db:push` | Diffs schema and applies directly — **can DROP columns** | CI ephemeral DB only |

`db:push` is for throwaway databases only. It will infer destructive changes
(column drops, type changes) without asking. It must never run against a
database that holds real data.

> **History — why this section was rewritten.** `db:migrate` used to be
> `drizzle-kit migrate`. But these migrations were hand-authored, not produced
> by `drizzle-kit generate`, so `db/migrations/meta/_journal.json` was
> `{ ..., "entries": [] }` — EMPTY. `drizzle-kit migrate` reads that journal,
> found nothing to do, and applied **zero** migrations — a silent no-op. Every
> environment actually got its schema from the **untracked** ordered replay in
> `scripts/db-bootstrap.ts`. That made the old "prod runs db:migrate" contract
> dangerously false. `db:migrate` now points at `scripts/migrate.ts`, a real
> forward-only runner with its own tracking table (below). Drizzle's
> `drizzle.__drizzle_migrations` table is **not** used by this runner.

## How the runner works (`scripts/migrate.ts`)

- **Tracking table** — `public._dim_migrations (filename text primary key,
  checksum text, applied_at timestamptz default now())`. Deliberately separate
  from drizzle's `drizzle.__drizzle_migrations` so the two can never collide.
- **Discovery + order** — every `db/migrations/*.sql`, sorted lexically. The
  `NNNN_` prefix makes lexical order equal numeric order. Gaps in the numbering
  (a couple of numbers are unused) are fine — the runner works off the files
  that exist, not a contiguous range.
- **Apply** — for each file not yet in the tracking table, the whole file is
  executed (multi-statement, via postgres-js simple protocol), then its row is
  inserted. Stops on the first failure (fail fast, reports the file).
- **Per-file transaction wrapping (default).** Each migration file is wrapped in
  `BEGIN … COMMIT` by default. A failure on any statement rolls the whole file
  back — the DB is left unchanged and no tracking row is inserted, so a retry
  after fixing the file is always safe.
- **`-- dim:no-transaction` directive.** Some statements cannot run inside a
  transaction block (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`). Add
  this comment to the file's first five lines to opt out of wrapping:
  ```sql
  -- dim:no-transaction
  ```
  The runner then executes the file unwrapped. Because a partial failure cannot
  be rolled back, **no-transaction migrations MUST be idempotent** — every
  statement must use `IF NOT EXISTS` / `IF EXISTS` guards so re-running is safe.
  The runner does NOT auto-detect CONCURRENTLY or ADD VALUE by scanning SQL text
  (fragile; keywords can appear in comments or strings); use the explicit
  directive instead.
- **Schema-populated guard.** Before a forward apply (not baseline, not status,
  not dry-run), if `_dim_migrations` is empty AND `public.pets` already exists,
  the runner exits with code 5 and instructs you to run `pnpm db:migrate:baseline`
  first. This converts the unbaselined-prod path from a confusing partial failure
  into a clear, actionable abort.
- **Checksum drift** — each file's sha256 is stored on apply. If a file is
  edited after being applied, later runs **refuse with exit 3** (the DB no
  longer matches the committed SQL). `--status` alone still reports and exits
  0; `--strict` makes even that refuse, and `deploy:staging` passes it.
  `--allow-drift` downgrades drift to a warning and is only for an exception
  recorded in the errata below.
  Consequence: an applied file is immutable, **comments included**. When one of
  them says something false, correct it in
  [`docs/db/migration-errata.md`](../db/migration-errata.md) — never in the file.
- **Forward-only** — the runner never reverts. There is no down-migration path.

CLI surface:

```bash
pnpm db:migrate                       # apply all pending
pnpm db:migrate:status                # applied vs pending
pnpm db:migrate:baseline              # mark ALL applied, run no SQL
tsx scripts/migrate.ts --baseline 0042_foo.sql   # baseline up to (incl.) 0042
tsx scripts/migrate.ts --dry-run      # show what WOULD apply, apply nothing
tsx scripts/migrate.ts --strict       # drift fatal in every mode, --status too
tsx scripts/migrate.ts --allow-drift  # drift only warns (recorded exception)
```

## First adoption on an existing database (CRITICAL)

Prod and any already-provisioned DB **already have every migration applied**
(via the historical untracked bootstrap replay), but `_dim_migrations` starts
empty. The runner now detects this automatically (the schema-populated guard)
and refuses to proceed, printing a clear message. Without the guard, applying
from scratch would fail partway through `0000` — e.g. on a non-guarded
`ADD CONSTRAINT` that follows a statement already committed without a transaction
wrapper — and leave the DB in a broken intermediate state.

**The first step on such a DB is always baseline, never apply:**

```bash
DATABASE_URL=<existing-db-url> pnpm db:migrate:baseline   # records all as applied, runs NO SQL
DATABASE_URL=<existing-db-url> pnpm db:migrate:status     # confirm: 0 pending
```

After baseline, `pnpm db:migrate` is a correct no-op and every future
migration applies normally. **Skipping baseline on an existing DB is the one
way to break this — do not run a bare `db:migrate` first.**

Fresh environments do **not** need a manual baseline: `pnpm db:bootstrap`
replays the migrations and then runs `db:migrate:baseline` itself (step 2.5),
so a `db:migrate` immediately after a fresh bootstrap is already a no-op.

## Versioned migration files

Migrations live in `db/migrations/` and are numbered sequentially
(`0000_`, `0001_`, …). The runner applies them in lexical (= numeric) order and
tracks applied migrations in `public._dim_migrations`.

Generating a migration:

```bash
pnpm db:generate
# Review the generated .sql file before committing.
# Destructive statements (DROP COLUMN, DROP TABLE) require manual sign-off.
```

The CI `migration-presence` job will fail if `db/schema.ts` is modified in a
PR without a corresponding new migration file. See the escape hatch in that
job if the change is comment-only.

## Deploy contract (current: Vercel + Supabase)

Vercel has no built-in pre-deploy hook that can run arbitrary shell commands
with production credentials. Until a dedicated deploy pipeline exists, the
process is:

### Gated manual migration (current approved process)

0. **One-time, the very first time this runner is adopted against prod:**
   baseline so the existing schema is recorded as applied (see "First adoption"
   above). Skip this only if you are certain `_dim_migrations` is already
   populated.

   ```bash
   DATABASE_URL=<prod-url> pnpm db:migrate:status     # if Applied=0 on a live DB, baseline first
   DATABASE_URL=<prod-url> pnpm db:migrate:baseline   # records all as applied, runs NO SQL
   ```

1. PR is merged to `main`.
2. Before the Vercel deploy finishes (or immediately after, for additive-only
   migrations), a team member with production `DATABASE_URL` access runs:

   ```bash
   DATABASE_URL=<prod-url> pnpm db:migrate
   ```

   The prod `DATABASE_URL` is available as a Vercel environment variable and
   in the shared secrets store — never commit it.

3. Verify the new migration rows landed by inspecting the tracking table
   directly (note: `pnpm db:status` shows the local Supabase stack, NOT
   migration history — use `pnpm db:migrate:status` for that):

   ```bash
   DATABASE_URL=<prod-url> pnpm db:migrate:status
   # or, raw:
   psql "$DATABASE_URL" -c \
     'select filename, applied_at from public._dim_migrations order by applied_at desc limit 5;'
   ```

4. Mark the deploy as complete in the release checklist.

### Recommended next step: GitHub Actions deploy job

Add a `deploy` job to a separate `deploy.yml` workflow triggered on push to
`main` after CI passes. The job should:

```yaml
- name: Apply migrations
  run: pnpm db:migrate
  env:
    DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}
```

This makes migrations atomic with the deploy, auditable via GitHub Actions
logs, and requires `PROD_DATABASE_URL` to be set as a repository secret —
which doubles as an access-control gate (only repo admins can trigger it).

Add `PROD_DATABASE_URL` to GitHub → Settings → Secrets → Actions before
wiring the job.

## Advisory allowlist pattern (dep-audit job)

`pnpm audit` has no native per-advisory ignore. If a HIGH advisory cannot be
patched immediately:

1. Run `pnpm audit --json` and capture the advisory ID and title.
2. Document it in this file under the table below with a patch deadline.
3. Add the `ci:skip-audit` label to the PR **or** include `[skip-audit]` in
   the HEAD commit message to unblock CI temporarily.
4. Create a follow-up issue and link it here.

| Advisory ID | Package | Severity | Patched in | Deadline | Issue |
|---|---|---|---|---|---|
| *(none)* | | | | | |

Triage one-liner (shows all HIGH/CRITICAL advisory details as JSON):

```bash
pnpm audit --json | jq '.advisories | to_entries[] | select(.value.severity == "high" or .value.severity == "critical") | .value | {id: .id, title: .title, module_name: .module_name, patched_versions: .patched_versions}'
```

---

## Un entorno nuevo no está listo hasta que se compara contra el repo

Lo escribo acá porque el 2026-08-13 costó caro: **el repo describía una base que
no existía.** Staging tenía 23 diferencias estructurales que ninguna lectura del
código podía encontrar — objetos que migraciones habían borrado y ese entorno
nunca ejecutó, cinco reglas con dos nombres distintos, y dos columnas muertas.

Una de esas diferencias rompía un flujo legal: `approval_type_valid` aceptaba
`service_dog_credential_verification` en staging y **no** en una base construida
desde las migraciones, mientras el código inserta ese valor. La solicitud de
credencial de perro de asistencia (Ley 26.858) andaba sólo porque alguien había
parcheado la constraint a mano.

### El comando

```bash
# La REFERENCIA es un local recién bootstrapeado: la única base que sí
# representa lo que el repo dice. El DESTINO es el entorno del que se sospecha.
DATABASE_URL="<url-del-entorno>" pnpm db:drift --allow-remote
```

Compara **columnas**, CHECK constraints, índices y constraints de unicidad, por
nombre y por definición. Sale 0 si no hay deriva, 7 si hay.

La categoría que hay que mirar primero es **MISMO NOMBRE, DEFINICIÓN DISTINTA**:
las dos bases creen tener la misma regla y no la tienen. Es la que rompió el
flujo de arriba, y es la misma trampa que hizo que la migración 0172 dijera "ok"
sin hacer nada — `DROP ... IF EXISTS` por un nombre que ese entorno no usa.

### Cuándo correrlo

- **Al levantar un entorno nuevo**, antes de darlo por bueno. Un `db:bootstrap`
  que termina sin error no prueba que el resultado sea el que el repo declara.
- **Después de aplicar migraciones a un entorno remoto.** Verificar el efecto,
  no el `ok`. Un `DROP ... IF EXISTS` que no encuentra el nombre reporta éxito.
- **Cuando algo anda en un entorno y no en otro.** Es el primer comando, no el
  último: responde en segundos una pregunta que a mano lleva horas.

### Y los catálogos

```bash
DATABASE_URL="<url-del-entorno>" pnpm db:catalogs --allow-remote
```

Verifica que todo valor guardado de raza y especie esté en su catálogo. Corre
además dentro de `pnpm verify` y en CI (`lint:catalogs`). Existe porque la raza
era texto libre y **dos perros que la ley alcanza estaban sin marcar** por cómo
se escribieron: `"Pit Bull Terrier Americano"` y `"Ovejero alemán"`.

### Lo que estos dos comandos NO hacen

No miran datos más allá de esos catálogos, ni RLS (eso es `pnpm lint:rls`), ni
funciones, triggers o vistas. Un `✓` de `db:drift` dice que la estructura
coincide — no que el entorno esté sano. Es un piso, no un veredicto.
