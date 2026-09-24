# Plan ejecutable — Catálogo INDEC de localidades

> Implementación del spec `docs/superpowers/specs/2026-05-18-localities-catalog-indec-design.md` v2.0. Cinco fases (A-E), cada una un PR. Plus una operación post-merge (OP) que **no** es PR — es correr el import script en staging y prod.
>
> **Fecha:** 2026-05-18
> **Owner del plan:** Claude Code
> **Pre-lectura obligatoria:**
> - `AGENTS.md` end-to-end
> - `docs/superpowers/specs/2026-05-18-localities-catalog-indec-design.md` v2.0
> - `lib/ar-provincias.ts` (patrón canonical + tolerancia)
> - `components/LocationFields.tsx` (el componente compartido a evolucionar)
> - `app/actions/admin-institutional.ts` (los dos server actions críticos)

## 0. Antes de tocar nada

```bash
cd <repo>
git status                 # debe estar limpio
git checkout main
git pull
pnpm install
pnpm test
pnpm typecheck
```

**Decisión operativa**: si encontrás que el spec v1.0 (`2026-05-18-localities-catalog-design.md`) ya está parcialmente implementado por error humano, **pausá y reportá** antes de continuar. v2.0 supersede v1.0 — no querés mezclar.

---

## Fase A — Schema (`db/migrations/0019_ar_localities.sql` + Drizzle models)

### Fase A — Archivos

**Nuevos:**
- `db/migrations/0019_ar_localities.sql`
- `__tests__/ar-localities-schema.test.ts`

**Modificados:**
- `db/schema.ts` — agregar `arLocalities` y `arLocalitiesImportRuns` models + types

### Fase A — Paso 1: Migration SQL

`db/migrations/0019_ar_localities.sql`:

```sql
-- Catalog of Argentine localities, populated from INDEC CPPDyL (Códigos de
-- provincias, departamentos y localidades) via scripts/import-indec-localities.ts.
--
-- See docs/superpowers/specs/2026-05-18-localities-catalog-indec-design.md §4.
--
-- Idempotent: every CREATE uses IF NOT EXISTS / IF NOT EXISTS guards. The
-- extension and indexes are safe to re-apply.

-- ============================================================================
-- 1. pg_trgm extension (for typeahead partial matching)
-- ============================================================================
create extension if not exists pg_trgm;

-- ============================================================================
-- 2. ar_localities — the canonical locality catalog
-- ============================================================================
create table if not exists "public"."ar_localities" (
  "id"               uuid primary key default gen_random_uuid(),

  "province_code"    text not null,
  "department_name"  text,
  "department_code"  text,

  "locality_name"    text not null,
  "locality_slug"    text not null,
  "indec_id"         text unique,
  "category"         text not null,

  "latitude"         numeric(10, 7),
  "longitude"        numeric(10, 7),

  "source"           text not null,
  "source_version"   text,
  "last_imported_at" timestamptz not null default now(),

  "removed_at"       timestamptz,

  constraint "ar_localities_province_valid"
    check (province_code ~ '^AR-[A-Z]$'),
  constraint "ar_localities_category_valid"
    check (category in ('localidad','ciudad','pueblo','comuna','barrio','componente')),
  constraint "ar_localities_source_valid"
    check (source in ('indec_cppdyl','bahra','manual'))
);

create unique index if not exists "ar_localities_province_slug_uniq"
  on "public"."ar_localities" ("province_code", "locality_slug")
  where "removed_at" is null;

create index if not exists "ar_localities_province_idx"
  on "public"."ar_localities" ("province_code")
  where "removed_at" is null;

create index if not exists "ar_localities_name_search"
  on "public"."ar_localities"
  using gin (to_tsvector('spanish', locality_name));

create index if not exists "ar_localities_name_trgm"
  on "public"."ar_localities"
  using gin (locality_name gin_trgm_ops)
  where "removed_at" is null;

-- ============================================================================
-- 3. ar_localities_import_runs — trace of every import script execution
-- ============================================================================
create table if not exists "public"."ar_localities_import_runs" (
  "id"              uuid primary key default gen_random_uuid(),
  "started_at"      timestamptz not null default now(),
  "finished_at"     timestamptz,
  "source"          text not null,
  "source_url"      text not null,
  "source_version"  text,
  "status"          text not null default 'running',
  "inserted_count"  integer not null default 0,
  "updated_count"   integer not null default 0,
  "noop_count"      integer not null default 0,
  "removed_count"   integer not null default 0,
  "details"         jsonb not null default '{}'::jsonb,

  constraint "ar_imports_status_valid" check (status in ('running','ok','failed'))
);

create index if not exists "ar_localities_import_runs_idx"
  on "public"."ar_localities_import_runs" ("started_at" desc);

-- ============================================================================
-- 4. RLS — anyone authenticated can SELECT (the catalog is reference data,
--    not user data). INSERT/UPDATE/DELETE only via server (the import script
--    uses the service role; no public write path).
-- ============================================================================
alter table "public"."ar_localities" enable row level security;
alter table "public"."ar_localities_import_runs" enable row level security;

drop policy if exists "ar_localities select authenticated" on "public"."ar_localities";
create policy "ar_localities select authenticated"
  on "public"."ar_localities" for select
  using (auth.uid() is not null);

drop policy if exists "ar_localities_import_runs select admin" on "public"."ar_localities_import_runs";
create policy "ar_localities_import_runs select admin"
  on "public"."ar_localities_import_runs" for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );
```

### Fase A — Paso 2: Drizzle models

Agregar al final de `db/schema.ts`:

```ts
export const ARGENTINE_LOCALITY_CATEGORIES = [
  "localidad", "ciudad", "pueblo", "comuna", "barrio", "componente",
] as const;
export type ArgentineLocalityCategory = (typeof ARGENTINE_LOCALITY_CATEGORIES)[number];

export const ARGENTINE_LOCALITY_SOURCES = ["indec_cppdyl", "bahra", "manual"] as const;
export type ArgentineLocalitySource = (typeof ARGENTINE_LOCALITY_SOURCES)[number];

export const arLocalities = pgTable(
  "ar_localities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provinceCode: text("province_code").notNull(),
    departmentName: text("department_name"),
    departmentCode: text("department_code"),
    localityName: text("locality_name").notNull(),
    localitySlug: text("locality_slug").notNull(),
    indecId: text("indec_id").unique(),
    category: text("category").notNull().$type<ArgentineLocalityCategory>(),
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    source: text("source").notNull().$type<ArgentineLocalitySource>(),
    sourceVersion: text("source_version"),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => ({
    provinceSlugUniq: uniqueIndex("ar_localities_province_slug_uniq")
      .on(table.provinceCode, table.localitySlug)
      .where(sql`removed_at is null`),
  }),
);
export type ArgentineLocality = InferSelectModel<typeof arLocalities>;

export const arLocalitiesImportRuns = pgTable("ar_localities_import_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  source: text("source").notNull(),
  sourceUrl: text("source_url").notNull(),
  sourceVersion: text("source_version"),
  status: text("status").notNull().default("running"),
  insertedCount: integer("inserted_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  noopCount: integer("noop_count").notNull().default(0),
  removedCount: integer("removed_count").notNull().default(0),
  details: jsonb("details").notNull().default({}),
});
export type ArLocalitiesImportRun = InferSelectModel<typeof arLocalitiesImportRuns>;
```

Y exportar en barrel.

### Fase A — Paso 3: Test del schema

`__tests__/ar-localities-schema.test.ts`:

```ts
// Verifica que la migración aplicó correctamente: que existen las tablas, que
// los CHECK constraints rechazan valores inválidos, que el unique constraint
// dispara con duplicados.

import { db, arLocalities } from "@/db";
import { describe, it, expect, afterAll } from "vitest";

describe("ar_localities schema", () => {
  it("rejects invalid province_code", async () => {
    await expect(
      db.insert(arLocalities).values({
        provinceCode: "INVALID",
        localityName: "Test",
        localitySlug: "test",
        category: "localidad",
        source: "manual",
      }),
    ).rejects.toThrow(/ar_localities_province_valid/);
  });

  it("rejects invalid category", async () => {
    await expect(
      db.insert(arLocalities).values({
        provinceCode: "AR-C",
        localityName: "Test",
        localitySlug: "test-cat",
        category: "invalid_cat" as any,
        source: "manual",
      }),
    ).rejects.toThrow(/ar_localities_category_valid/);
  });

  it("enforces (province_code, locality_slug) uniqueness", async () => {
    const base = {
      provinceCode: "AR-C", localityName: "Duplicado", localitySlug: "duplicado",
      category: "localidad" as const, source: "manual" as const,
    };
    const [first] = await db.insert(arLocalities).values(base).returning();
    await expect(db.insert(arLocalities).values(base)).rejects.toThrow();
    // Cleanup
    await db.delete(arLocalities).where(eq(arLocalities.id, first.id));
  });
});
```

### Fase A — Paso 4: Aplicar migración

```bash
cat db/migrations/0019_ar_localities.sql | docker exec -i supabase_db_DIM psql -U postgres -d postgres -v ON_ERROR_STOP=1
```

Si falla, leer error y corregir. NO continúes a Fase B sin la migración aplicada.

### Fase A — Verificación

```bash
pnpm test __tests__/ar-localities-schema.test.ts
pnpm typecheck
```

### Fase A — Commit

```
feat(db): ar_localities catalog + import_runs schema

Adds tables for the INDEC locality catalog (~4500 entries to be
populated by Fase B import script) and tracking of import runs.
pg_trgm extension enabled for typeahead. RLS: SELECT for any
authenticated user; mutations only via service role.

Drizzle models exported. Schema test verifies CHECK constraints
and unique index.

Migration 0019. Spec v2.0 §4.
```

---

## Fase B — Import script

### Fase B — Archivos

**Nuevos:**
- `scripts/import-indec-localities.ts`
- `scripts/__fixtures__/indec-localidades-sample.csv` (10-row sample for tests)
- `__tests__/import-indec-localities.test.ts`

### Fase B — Paso 1: Investigar el dataset actual

**Antes de codear**: ir a https://www.datos.gob.ar/dataset/modernizacion-codigos-provincias-departamentos-localidades-republica-argentina (o el slug que esté vigente; INDEC y la oficina de datos abiertos a veces re-publican bajo IDs distintos).

Identificar:
- URL del CSV de `localidades.csv` actual (suele ser una URL de `infra.datos.gob.ar/catalog/.../localidades.csv`)
- Encoding (típicamente UTF-8, pero verificar — algunos CSVs INDEC son Latin-1)
- Delimitador (típicamente coma; verificar)
- Nombres exactos de columnas (la spec lista nombres tentativos pero la versión actual puede tener variaciones)
- Versión / fecha del dataset

**Registrar todo esto** en un block comment al tope del script. Si el dataset no es accesible o cambió de formato, **pausá y reportá a Nacho**.

### Fase B — Paso 2: Script

`scripts/import-indec-localities.ts`:

```ts
#!/usr/bin/env tsx
/**
 * INDEC CPPDyL locality importer.
 *
 * Source: https://www.datos.gob.ar/dataset/modernizacion-codigos-provincias-departamentos-localidades-republica-argentina
 * Dataset distribution to use: <verified URL here, e.g.
 *   https://infra.datos.gob.ar/catalog/modernizacion/dataset/7/distribution/7.1/download/localidades.csv>
 * Source version: <date string, e.g. "2024-12" or commit hash from datos.gob.ar>
 * Encoding: UTF-8 (verified 2026-05)
 * Delimiter: comma
 *
 * Columns expected (verify against current dataset):
 *   - cod_loc (or 'id') → indec_id
 *   - nombre_loc (or 'nombre') → locality_name
 *   - cod_depto → department_code
 *   - nombre_depto → department_name
 *   - cod_prov → mapped to province_code via PROVINCE_BY_INDEC_CODE
 *   - nombre_prov → province name (fallback to provinceByName)
 *   - categoria (or 'tipo') → category
 *
 * Run:
 *   pnpm tsx scripts/import-indec-localities.ts
 *   pnpm tsx scripts/import-indec-localities.ts --dry-run
 *   pnpm tsx scripts/import-indec-localities.ts --source-url=<override>
 */

import { parse } from "csv-parse/sync";
import { eq } from "drizzle-orm";

import { db, arLocalities, arLocalitiesImportRuns } from "@/db";
import { provinceByName, type ProvinceCode } from "@/lib/ar-provincias";

// INDEC provincia codes (2 digits) → ISO 3166-2:AR
// (INDEC uses its own 2-digit numeric codes; we map to ISO codes for consistency.)
const PROVINCE_BY_INDEC_CODE: Record<string, ProvinceCode> = {
  "02": "AR-C", // CABA
  "06": "AR-B", // Buenos Aires
  "10": "AR-K", // Catamarca
  "14": "AR-X", // Córdoba
  "18": "AR-W", // Corrientes
  "22": "AR-H", // Chaco
  "26": "AR-U", // Chubut
  "30": "AR-E", // Entre Ríos
  "34": "AR-P", // Formosa
  "38": "AR-Y", // Jujuy
  "42": "AR-L", // La Pampa
  "46": "AR-F", // La Rioja
  "50": "AR-M", // Mendoza
  "54": "AR-N", // Misiones
  "58": "AR-Q", // Neuquén
  "62": "AR-R", // Río Negro
  "66": "AR-A", // Salta
  "70": "AR-J", // San Juan
  "74": "AR-D", // San Luis
  "78": "AR-Z", // Santa Cruz
  "82": "AR-S", // Santa Fe
  "86": "AR-G", // Santiago del Estero
  "90": "AR-T", // Tucumán
  "94": "AR-V", // Tierra del Fuego
};

const ALLOWED_CATEGORIES = new Set(["localidad", "ciudad", "pueblo", "comuna", "barrio", "componente"]);

// Map INDEC raw category strings → our canonical category enum.
// INDEC uses Spanish labels with variations.
function normalizeCategory(raw: string): "localidad" | "ciudad" | "pueblo" | "comuna" | "barrio" | "componente" | null {
  const n = raw.toLowerCase().trim();
  if (n.includes("componente")) return "componente";
  if (n.includes("ciudad")) return "ciudad";
  if (n.includes("pueblo")) return "pueblo";
  if (n.includes("comuna")) return "comuna";
  if (n.includes("barrio")) return "barrio";
  if (n.includes("localidad simple") || n === "localidad") return "localidad";
  // Skip parajes, caseríos, entidades — too granular
  return null;
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const urlOverride = process.argv.find((a) => a.startsWith("--source-url="))?.split("=")[1];
  const sourceUrl =
    urlOverride ??
    "https://infra.datos.gob.ar/catalog/modernizacion/dataset/7/distribution/7.1/download/localidades.csv";
  // ↑ UPDATE this URL if datos.gob.ar reorganized the distribution. Verified <date>.

  // 1. Create import run row
  const [run] = await db
    .insert(arLocalitiesImportRuns)
    .values({ source: "indec_cppdyl", sourceUrl, status: "running" })
    .returning();

  console.log(`Started import run ${run.id} (dryRun=${dryRun})`);

  try {
    // 2. Download CSV
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`Failed to fetch CSV: ${res.status} ${res.statusText}`);
    const csvText = await res.text();
    const sourceVersion = res.headers.get("last-modified") ?? new Date().toISOString().slice(0, 10);

    // 3. Parse CSV
    const records: Record<string, string>[] = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
    console.log(`Parsed ${records.length} CSV rows`);

    // 4. Transform + filter
    let inserted = 0, updated = 0, noop = 0, skipped = 0;
    const errors: { row: number; reason: string; raw: Record<string, string> }[] = [];

    for (const [idx, row] of records.entries()) {
      // Column names may vary; tolerate both 'cod_loc'/'id' and 'nombre'/'nombre_loc' etc.
      const indecId = row.cod_loc ?? row.id ?? row.codigo;
      const localityName = row.nombre_loc ?? row.nombre;
      const codProv = row.cod_prov ?? row.provincia_id;
      const nombreDepto = row.nombre_depto ?? row.departamento_nombre ?? null;
      const codDepto = row.cod_depto ?? row.departamento_id ?? null;
      const rawCategory = row.categoria ?? row.tipo ?? "localidad";

      if (!indecId || !localityName || !codProv) {
        errors.push({ row: idx + 1, reason: "missing required field", raw: row });
        continue;
      }

      const provinceCode = PROVINCE_BY_INDEC_CODE[codProv.padStart(2, "0")];
      if (!provinceCode) {
        errors.push({ row: idx + 1, reason: `unknown province code ${codProv}`, raw: row });
        continue;
      }

      const category = normalizeCategory(rawCategory);
      if (!category) {
        skipped += 1; // intentional skip (paraje, caserío, entidad)
        continue;
      }

      const slug = slugify(localityName);

      // Upsert by indec_id
      const [existing] = await db
        .select()
        .from(arLocalities)
        .where(eq(arLocalities.indecId, indecId));

      if (existing) {
        const isDifferent =
          existing.localityName !== localityName ||
          existing.departmentName !== nombreDepto ||
          existing.category !== category ||
          existing.localitySlug !== slug;
        if (isDifferent) {
          if (!dryRun) {
            await db
              .update(arLocalities)
              .set({
                localityName, localitySlug: slug, departmentName: nombreDepto,
                departmentCode: codDepto, category, sourceVersion, lastImportedAt: new Date(),
                removedAt: null, // un-remove if it was removed in a previous run
              })
              .where(eq(arLocalities.id, existing.id));
          }
          updated += 1;
        } else {
          noop += 1;
        }
      } else {
        if (!dryRun) {
          await db.insert(arLocalities).values({
            provinceCode, departmentName: nombreDepto, departmentCode: codDepto,
            localityName, localitySlug: slug, indecId, category,
            source: "indec_cppdyl", sourceVersion,
          });
        }
        inserted += 1;
      }
    }

    // 5. Soft-delete rows that no longer appear in the CSV (only if source='indec_cppdyl')
    const importedIndecIds = new Set(records.map((r) => r.cod_loc ?? r.id ?? r.codigo).filter(Boolean));
    const existingFromSource = await db
      .select()
      .from(arLocalities)
      .where(eq(arLocalities.source, "indec_cppdyl"));
    let removed = 0;
    for (const e of existingFromSource) {
      if (e.indecId && !importedIndecIds.has(e.indecId) && !e.removedAt) {
        if (!dryRun) {
          await db.update(arLocalities).set({ removedAt: new Date() }).where(eq(arLocalities.id, e.id));
        }
        removed += 1;
      }
    }

    // 6. Finalize import run row
    await db
      .update(arLocalitiesImportRuns)
      .set({
        status: "ok", finishedAt: new Date(), sourceVersion,
        insertedCount: inserted, updatedCount: updated, noopCount: noop, removedCount: removed,
        details: { errors: errors.slice(0, 50), skippedNonRelevant: skipped },
      })
      .where(eq(arLocalitiesImportRuns.id, run.id));

    console.log(`Done. inserted=${inserted} updated=${updated} noop=${noop} removed=${removed} skipped=${skipped} errors=${errors.length}`);
    if (errors.length > 0) {
      console.warn(`First few errors:`, errors.slice(0, 5));
    }
  } catch (err) {
    await db
      .update(arLocalitiesImportRuns)
      .set({
        status: "failed", finishedAt: new Date(),
        details: { error: err instanceof Error ? err.message : String(err) },
      })
      .where(eq(arLocalitiesImportRuns.id, run.id));
    console.error("Import failed:", err);
    process.exit(1);
  }
}

main().then(() => process.exit(0));
```

### Fase B — Paso 3: Test del script

`__tests__/import-indec-localities.test.ts`:

```ts
// Test con un CSV fixture chiquito (10 rows) que cubre:
// - 2 localidades CABA (Palermo, Recoleta)
// - 2 localidades GBA (Avellaneda, La Plata)
// - 1 localidad Mendoza capital
// - 1 paraje (debe ser skipped)
// - 1 row con província desconocida (error reported)
// - 1 row con campo faltante (error reported)
//
// Mockea `fetch` para devolver el CSV fixture en lugar de pegarle a datos.gob.ar.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db, arLocalities, arLocalitiesImportRuns } from "@/db";

describe("import-indec-localities", () => {
  beforeEach(async () => {
    await db.delete(arLocalities);
    await db.delete(arLocalitiesImportRuns);
  });

  it("imports a fixture CSV with expected outcomes", async () => {
    const csvFixture = readFileSync(
      join(__dirname, "..", "scripts", "__fixtures__", "indec-localidades-sample.csv"),
      "utf-8",
    );
    global.fetch = vi.fn(async () =>
      new Response(csvFixture, { status: 200, headers: { "Last-Modified": "Wed, 01 Dec 2024 00:00:00 GMT" } }),
    );

    // Import the script and call its main
    const { main } = await import("../scripts/import-indec-localities");
    await main();

    const rows = await db.select().from(arLocalities);
    expect(rows.length).toBe(5); // 2 CABA + 2 GBA + 1 Mendoza, paraje skipped, errors not inserted

    const palermo = rows.find((r) => r.localitySlug === "palermo");
    expect(palermo).toBeDefined();
    expect(palermo!.provinceCode).toBe("AR-C");
    expect(palermo!.category).toBe("componente"); // CABA barrios are "componente de localidad compuesta" in INDEC

    const runs = await db.select().from(arLocalitiesImportRuns);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("ok");
    expect(runs[0].insertedCount).toBe(5);
  });

  it("re-running is idempotent (no-op when no changes)", async () => {
    // ... corre import dos veces, segunda corrida tiene noopCount == 5 e insertedCount == 0
  });

  it("soft-deletes rows missing from the new CSV", async () => {
    // ... primer import con 5 rows, segundo import con 4 (Recoleta removida del CSV)
    //     → Recoleta tiene removedAt != null en DB
  });
});
```

**Refactor menor del script**: exportar `main` para que el test pueda llamarla. Cambiar la última línea de `main().then(...)` a `if (require.main === module) main().then(...)`.

Fixture CSV en `scripts/__fixtures__/indec-localidades-sample.csv`:

```csv
cod_loc,nombre_loc,cod_depto,nombre_depto,cod_prov,nombre_prov,categoria
02001010,Palermo,02001,Comuna 14,02,Ciudad Autónoma de Buenos Aires,Componente de localidad compuesta
02001020,Recoleta,02001,Comuna 2,02,Ciudad Autónoma de Buenos Aires,Componente de localidad compuesta
06028010,Avellaneda,06028,Avellaneda,06,Buenos Aires,Localidad simple
06441020,La Plata,06441,La Plata,06,Buenos Aires,Localidad simple
50028010,Mendoza,50028,Capital,50,Mendoza,Ciudad
50007999,Algún Paraje,50007,Las Heras,50,Mendoza,Paraje
99001010,Inexistente,99001,Depto X,99,Inventada,Localidad simple
06028020,,06028,Avellaneda,06,Buenos Aires,Localidad simple
```

### Fase B — Verificación

```bash
pnpm test __tests__/import-indec-localities.test.ts
pnpm typecheck

# NO correr el import real en producción todavía. Solo verificar que el script
# corre con --dry-run contra el CSV real:
pnpm tsx scripts/import-indec-localities.ts --dry-run
# Debe imprimir counts sin tocar la DB. Si falla, revisar el log.
```

### Fase B — Commit

```
feat(scripts): INDEC locality catalog importer

Adds scripts/import-indec-localities.ts which fetches the official
INDEC CPPDyL localidades CSV from datos.gob.ar, parses it, and
upserts into ar_localities. Idempotent: re-running is a no-op when
the CSV hasn't changed. Soft-deletes rows that disappear from the
source between runs.

Filters to operationally relevant categories (localidad, ciudad,
pueblo, comuna, barrio, componente). Skips parajes, caseríos,
entidades sub-locality.

Test exercises the full pipeline with a fixture CSV. The script
exports `main` so the test can invoke it; running via CLI uses
`require.main === module` guard.

Does NOT run against production in this PR. Operation is post-merge
manual: pnpm tsx scripts/import-indec-localities.ts.
```

---

## Fase C — Helpers + server action de search

### Fase C — Archivos

**Nuevos:**
- `lib/ar-localidades.ts`
- `__tests__/ar-localidades.test.ts`
- `app/actions/localities.ts`
- `__tests__/localities-search-action.test.ts`

### Fase C — Paso 1: `lib/ar-localidades.ts`

```ts
import { and, eq, isNull, sql } from "drizzle-orm";

import { db, arLocalities, type ArgentineLocality } from "@/db";
import { type ProvinceCode, provinceByCode, provinceByName } from "@/lib/ar-provincias";

export type Locality = {
  indecId: string | null;
  provinceCode: ProvinceCode;
  departmentName: string | null;
  localityName: string;
  localitySlug: string;
  category: ArgentineLocality["category"];
};

export type LocalitySearchResult = Locality & {
  provinceName: string;
  matchKind: "exact" | "prefix" | "contains";
};

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function rowToLocality(row: ArgentineLocality): Locality {
  return {
    indecId: row.indecId,
    provinceCode: row.provinceCode as ProvinceCode,
    departmentName: row.departmentName,
    localityName: row.localityName,
    localitySlug: row.localitySlug,
    category: row.category as ArgentineLocality["category"],
  };
}

export async function localityByIndecId(indecId: string): Promise<Locality | null> {
  const [row] = await db
    .select()
    .from(arLocalities)
    .where(and(eq(arLocalities.indecId, indecId), isNull(arLocalities.removedAt)));
  return row ? rowToLocality(row) : null;
}

export async function localityByName(
  provinceCode: ProvinceCode,
  name: string | null | undefined,
): Promise<Locality | null> {
  if (!name) return null;
  const normalized = normalize(name);
  const slugCandidate = normalized.replace(/\s+/g, "-");

  // Try exact slug first (cheap)
  const [bySlug] = await db
    .select()
    .from(arLocalities)
    .where(
      and(
        eq(arLocalities.provinceCode, provinceCode),
        eq(arLocalities.localitySlug, slugCandidate),
        isNull(arLocalities.removedAt),
      ),
    );
  if (bySlug) return rowToLocality(bySlug);

  // Fallback: normalize against locality_name with the same normalize fn applied via SQL.
  // We use lower(unaccent(...)) for a server-side comparable form. Requires unaccent
  // extension; if not enabled, fallback to fetching all in-province rows and JS-comparing.
  // Simpler: try ILIKE exact match (case insensitive, but doesn't strip accents).
  const [byNameCi] = await db
    .select()
    .from(arLocalities)
    .where(
      and(
        eq(arLocalities.provinceCode, provinceCode),
        sql`lower(${arLocalities.localityName}) = lower(${name})`,
        isNull(arLocalities.removedAt),
      ),
    );
  if (byNameCi) return rowToLocality(byNameCi);

  return null;
}

export async function isCanonicalLocality(
  provinceCodeOrName: string,
  localityName: string,
): Promise<boolean> {
  const province = provinceByCode(provinceCodeOrName) ?? provinceByName(provinceCodeOrName);
  if (!province) return false;
  return (await localityByName(province.code, localityName)) !== null;
}

export async function searchLocalities(input: {
  provinceCode?: ProvinceCode;
  query: string;
  limit?: number;
}): Promise<LocalitySearchResult[]> {
  const limit = Math.min(input.limit ?? 20, 50);
  const q = normalize(input.query);
  if (q.length < 2) return [];
  const qSlug = q.replace(/\s+/g, "-");

  // Build the score expression
  const scoreExpr = sql<number>`(
    case when ${arLocalities.localitySlug} = ${qSlug} then 1000
         when ${arLocalities.localitySlug} like ${qSlug + "%"} then 100
         when ${arLocalities.localityName} ilike ${"%" + input.query + "%"} then 10
         else 0
    end
  )`;

  const conditions = [isNull(arLocalities.removedAt), sql`${scoreExpr} > 0`];
  if (input.provinceCode) conditions.push(eq(arLocalities.provinceCode, input.provinceCode));

  // Category priority: ciudad > localidad > pueblo > barrio > comuna > componente
  const categoryPriorityExpr = sql<number>`(
    case ${arLocalities.category}
      when 'ciudad' then 6
      when 'localidad' then 5
      when 'pueblo' then 4
      when 'barrio' then 3
      when 'comuna' then 2
      when 'componente' then 1
    end
  )`;

  const rows = await db
    .select({
      indecId: arLocalities.indecId,
      provinceCode: arLocalities.provinceCode,
      departmentName: arLocalities.departmentName,
      localityName: arLocalities.localityName,
      localitySlug: arLocalities.localitySlug,
      category: arLocalities.category,
      score: scoreExpr,
    })
    .from(arLocalities)
    .where(and(...conditions))
    .orderBy(sql`${scoreExpr} desc, ${categoryPriorityExpr} desc, ${arLocalities.localityName} asc`)
    .limit(limit);

  return rows.map((r): LocalitySearchResult => ({
    indecId: r.indecId,
    provinceCode: r.provinceCode as ProvinceCode,
    provinceName: provinceByCode(r.provinceCode)?.name ?? r.provinceCode,
    departmentName: r.departmentName,
    localityName: r.localityName,
    localitySlug: r.localitySlug,
    category: r.category as Locality["category"],
    matchKind:
      r.score >= 1000 ? "exact" :
      r.score >= 100 ? "prefix" : "contains",
  }));
}
```

### Fase C — Paso 2: Tests del lib

`__tests__/ar-localidades.test.ts`: con tabla seeded con 5-10 entries representativas:
- `localityByName("AR-C", "Palermo")` → match
- `localityByName("AR-C", "palermo")` → match (case insensitive)
- `localityByName("AR-C", "PaLeRmO")` → match
- `localityByName("AR-B", "Palermo")` → null (no existe en BA)
- `searchLocalities({ query: "pal" })` → Palermo aparece con matchKind=prefix
- `searchLocalities({ query: "barilo", provinceCode: "AR-R" })` → Bariloche con matchKind=prefix
- `searchLocalities({ query: "x" })` → [] (min 2 chars)
- `searchLocalities({ query: "Bahía Blanca" })` → match exact
- `isCanonicalLocality("AR-C", "Palermo")` → true
- `isCanonicalLocality("AR-Z", "Palermo")` → false

### Fase C — Paso 3: Server action `app/actions/localities.ts`

```ts
"use server";

import { searchLocalities, type LocalitySearchResult } from "@/lib/ar-localidades";
import { requireUserOrRedirect } from "@/lib/auth-guards";
import { provinceByCode } from "@/lib/ar-provincias";

// Simple in-memory rate limit: 60 req/min per session.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(sessionId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(sessionId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

export async function searchLocalitiesAction(input: {
  provinceCode?: string;
  query: string;
}): Promise<{ results: LocalitySearchResult[] } | { error: string }> {
  const { user } = await requireUserOrRedirect();

  if (!checkRateLimit(user.id)) {
    return { error: "rate_limited" };
  }

  if (input.query.length < 2) return { results: [] };

  // Validate province code if provided
  const provinceCode = input.provinceCode
    ? provinceByCode(input.provinceCode)?.code
    : undefined;

  const results = await searchLocalities({
    provinceCode,
    query: input.query,
    limit: 20,
  });

  return { results };
}
```

### Fase C — Paso 4: Test del server action

`__tests__/localities-search-action.test.ts`: con tabla seeded + fake auth user. Verifica rate limit, mínimo 2 chars, province filter, sin auth → redirect.

### Fase C — Verificación

```bash
pnpm test __tests__/ar-localidades.test.ts __tests__/localities-search-action.test.ts
pnpm typecheck
```

### Fase C — Commit

```
feat(lib/actions): locality search helpers + server action

Adds lib/ar-localidades.ts with DB-backed helpers (localityByName,
localityByIndecId, searchLocalities, isCanonicalLocality). Adds
app/actions/localities.ts with searchLocalitiesAction wrapping the
search with auth + per-session rate limit (60 req/min).

Search ranking: exact slug > prefix > contains, breaking ties by
category priority (ciudad > localidad > pueblo > barrio > comuna >
componente), then alphabetical.

Tests with seeded fixtures cover tolerance to case/accents, scope
filtering, rate limiting.
```

---

## Fase D — UI: `<LocalityCombobox>` + form refactor

### Fase D — Archivos

**Nuevos:**
- `components/LocalityCombobox.tsx`
- `__tests__/locality-combobox.test.tsx` (RTL — render tests, not full integration)

**Modificados:**
- `components/LocationFields.tsx` — reemplazar input locality por LocalityCombobox
- `app/admin/govts/new/CreateGovtForm.tsx` — usar `<select>` para province + `<LocalityCombobox>` para locality
- `app/admin/govts/_components/AssignLocalityForm.tsx` — idem

### Fase D — Paso 1: `LocalityCombobox.tsx`

Client component con `useState` para query/selected, `useTransition` para fetch, debounce con `setTimeout` clearable. Keyboard nav con `onKeyDown` (ArrowUp/ArrowDown/Enter/Escape).

```tsx
"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { searchLocalitiesAction } from "@/app/actions/localities";
import type { LocalitySearchResult } from "@/lib/ar-localidades";
import type { ProvinceCode } from "@/lib/ar-provincias";

type Props = {
  provinceCode: ProvinceCode | null;
  defaultValue?: { localityName: string; indecId?: string };
  name: string;                // base name for the form; we register two hidden inputs
  required?: boolean;
  onSelect?: (selected: LocalitySearchResult | null) => void;
};

export function LocalityCombobox({ provinceCode, defaultValue, name, required, onSelect }: Props) {
  const [query, setQuery] = useState(defaultValue?.localityName ?? "");
  const [selected, setSelected] = useState<LocalitySearchResult | null>(null);
  const [results, setResults] = useState<LocalitySearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [pending, startTransition] = useTransition();
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!provinceCode) {
      setResults([]);
      setOpen(false);
      return;
    }
    if (query.length < 2) {
      setResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        const res = await searchLocalitiesAction({ provinceCode, query });
        if ("results" in res) {
          setResults(res.results);
          setOpen(res.results.length > 0);
          setActiveIdx(0);
        }
      });
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, provinceCode]);

  function handleSelect(r: LocalitySearchResult) {
    setSelected(r);
    setQuery(r.localityName);
    setOpen(false);
    onSelect?.(r);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      handleSelect(results[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const disabled = provinceCode === null;

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setSelected(null); }}
        onKeyDown={handleKey}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        onBlur={() => { setTimeout(() => setOpen(false), 150); }}
        placeholder={disabled ? "Primero elegí provincia" : "Empezá a tipear..."}
        disabled={disabled}
        required={required}
        className="w-full text-sm rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 disabled:opacity-50"
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {/* Hidden fields for form submission */}
      <input type="hidden" name={name} value={selected?.localityName ?? query} />
      <input type="hidden" name={`${name}IndecId`} value={selected?.indecId ?? ""} />
      {open && results.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg">
          {results.map((r, i) => (
            <li
              key={r.indecId ?? `${r.provinceCode}-${r.localitySlug}`}
              className={
                "px-3 py-2 cursor-pointer " +
                (i === activeIdx ? "bg-neutral-100 dark:bg-neutral-800" : "hover:bg-neutral-50 dark:hover:bg-neutral-900")
              }
              onMouseDown={(e) => { e.preventDefault(); handleSelect(r); }}
            >
              <p className="text-sm">{r.localityName}</p>
              {r.departmentName && (
                <p className="text-xs text-neutral-500">{r.departmentName}, {r.provinceName}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {pending && <p className="absolute right-2 top-2 text-xs text-neutral-500">…</p>}
      {!disabled && query.length >= 2 && !pending && results.length === 0 && (
        <p className="absolute -bottom-5 left-0 text-xs text-neutral-500">
          Sin resultados. <a
            href={`mailto:<maintainer-email>?subject=DIM%20—%20Agregar%20localidad&body=Provincia:%20${provinceCode}%0ALocalidad:%20${encodeURIComponent(query)}`}
            className="underline"
          >Sugerí esta localidad</a>
        </p>
      )}
    </div>
  );
}
```

### Fase D — Paso 2: Refactor `LocationFields.tsx`

Reemplazar el bloque `<input id="localityName">` por `<LocalityCombobox provinceCode={selectedProvince}>`. Esto requiere subir el estado de provinceCode a un client wrapper o hacer LocationFields client component (probablemente ya lo es; verificar).

Si LocationFields era server component, convertir a client. Si la prop `defaultValue?.provinceCode` existía, mantener; el `selectedProvince` se inicia desde ahí.

### Fase D — Paso 3: Refactor `CreateGovtForm.tsx` + `AssignLocalityForm.tsx`

`CreateGovtForm`: cambiar los dos `<input>` de cada `LocalityEntry` por:
- `<select>` con `<option value={p.code}>{p.name}</option>` para cada `p` en `PROVINCES`
- `<LocalityCombobox provinceCode={l.province as ProvinceCode | null}>` para locality

Al submit, convertir `provinceCode` (ej. `"AR-C"`) a `province.name` (ej. `"CABA"`) y `localityName` ya viene del combobox. Enviar al server action.

`AssignLocalityForm`: idem con un solo provincia/locality (no lista).

### Fase D — Paso 4: Tests

`__tests__/locality-combobox.test.tsx`: render test verifica que se deshabilita sin provinceCode, que mostrar sin resultados invita a sugerir, que keyboard nav funciona (Arrow + Enter selecciona).

### Fase D — Verificación

```bash
pnpm test
pnpm typecheck
pnpm dev
# Smoke manual:
#   - /admin/govts/new → escribir provincia, después locality, ver typeahead.
#   - /admin/govts/<id> → "Asignar nueva localidad" → typeahead funciona.
#   - /cuenta/upgrade (org creation) → LocationFields ahora tiene combobox.
#   - /pro/servicios/nuevo → idem.
```

### Fase D — Commit

```
feat(ui): LocalityCombobox + form refactors for canonical localities

Adds components/LocalityCombobox.tsx with typeahead (200ms debounce,
min 2 chars, keyboard nav). Sends two hidden form fields per use:
the locality display name and the INDEC ID.

Refactors LocationFields.tsx, CreateGovtForm.tsx, AssignLocalityForm
.tsx to use the combobox. Free-text locality input is gone — every
locality persisted now comes from the catalog.

The "no results" state offers a mailto-suggest link to Nacho with
the province + locality prefilled.
```

---

## Fase E — Server-side validation + migration de rows existentes

### Fase E — Archivos

**Nuevos:**
- `scripts/normalize-existing-jurisdictions.ts`
- `__tests__/normalize-existing-jurisdictions.test.ts`
- `lib/jurisdiction-validation.ts` (helper compartido)

**Modificados (7 server actions):**
- `app/actions/admin-institutional.ts` — `assignGovtLocalityForAuthority`, `createInstitutionalAccountForAuthority`
- `app/actions/upgrade.ts` — `requestVetUpgradeForUser`, `createOrganizationForUser`
- `app/actions/service-offerings.ts` — el action que crea offerings
- `app/actions/welfare.ts` — el action que crea welfare reports
- `app/actions/events.ts` — los actions que pasan locality_context en payload

### Fase E — Paso 1: Helper compartido `lib/jurisdiction-validation.ts`

```ts
import { provinceByCode, provinceByName, type Province } from "@/lib/ar-provincias";
import { localityByName, type Locality } from "@/lib/ar-localidades";

export type CanonicalJurisdiction = {
  province: Province;
  locality: Locality;
};

export async function resolveCanonicalJurisdiction(input: {
  rawProvince: string;
  rawLocality: string;
}): Promise<CanonicalJurisdiction> {
  const province = provinceByCode(input.rawProvince) ?? provinceByName(input.rawProvince);
  if (!province) {
    throw new Error(`Provincia '${input.rawProvince}' no es válida.`);
  }
  const locality = await localityByName(province.code, input.rawLocality);
  if (!locality) {
    throw new Error(
      `Localidad '${input.rawLocality}' no figura en el catálogo INDEC para ${province.name}.`,
    );
  }
  return { province, locality };
}
```

### Fase E — Paso 2: Patch 7 server actions

Para cada uno, antes del INSERT:

```ts
const { province, locality } = await resolveCanonicalJurisdiction({
  rawProvince: input.province,
  rawLocality: input.locality,
});
// Use province.name and locality.localityName when persisting TEXT.
```

Si el server action ya recibe `localityIndecId` del form (Fase D), preferir `localityByIndecId(localityIndecId)` para skip el name lookup. Si es null, fallback a `localityByName`.

### Fase E — Paso 3: Script `scripts/normalize-existing-jurisdictions.ts`

```ts
#!/usr/bin/env tsx
/**
 * Normalize existing rows that have non-canonical jurisdiction strings to
 * match the INDEC catalog. Run once after Fase B import has populated
 * ar_localities.
 *
 * Tables touched (UPDATE):
 *   - govt_assignments
 *   - approval_requests
 *   - organizations
 *   - service_offerings
 *   - welfare_reports  (if column names match)
 *
 * Tables NOT touched (append-only or out of scope):
 *   - pet_events  (append-only; emits a CSV report instead)
 *
 * Strategy per row:
 *   1. provinceByName(raw_province) → canonical Province
 *   2. localityByName(province.code, raw_locality) → canonical Locality
 *   3. If both resolve and differ from raw → UPDATE
 *   4. Otherwise → print row identifier + raw values to stderr
 *
 * Run:
 *   pnpm tsx scripts/normalize-existing-jurisdictions.ts          # apply
 *   pnpm tsx scripts/normalize-existing-jurisdictions.ts --dry-run
 */

import { eq } from "drizzle-orm";

import {
  approvalRequests, db, govtAssignments, organizations, serviceOfferings,
} from "@/db";
import { provinceByName } from "@/lib/ar-provincias";
import { localityByName } from "@/lib/ar-localidades";

const dryRun = process.argv.includes("--dry-run");

type Stats = { normalized: number; unchanged: number; failed: { id: string; province: string; locality: string }[] };

async function processTable<T extends { id: string; jurisdictionProvince: string; jurisdictionLocality: string }>(
  tableName: string,
  rows: T[],
  updater: (id: string, province: string, locality: string) => Promise<void>,
): Promise<Stats> {
  const stats: Stats = { normalized: 0, unchanged: 0, failed: [] };
  for (const r of rows) {
    const province = provinceByName(r.jurisdictionProvince);
    if (!province) {
      stats.failed.push({ id: r.id, province: r.jurisdictionProvince, locality: r.jurisdictionLocality });
      continue;
    }
    const locality = await localityByName(province.code, r.jurisdictionLocality);
    if (!locality) {
      stats.failed.push({ id: r.id, province: r.jurisdictionProvince, locality: r.jurisdictionLocality });
      continue;
    }
    if (province.name === r.jurisdictionProvince && locality.localityName === r.jurisdictionLocality) {
      stats.unchanged += 1;
      continue;
    }
    if (!dryRun) {
      await updater(r.id, province.name, locality.localityName);
    }
    stats.normalized += 1;
  }
  console.log(`${tableName}: normalized=${stats.normalized} unchanged=${stats.unchanged} failed=${stats.failed.length}`);
  if (stats.failed.length > 0) {
    console.warn(`${tableName} rows needing manual review:`);
    for (const f of stats.failed) console.warn(`  [${f.id}] ${f.province} / ${f.locality}`);
  }
  return stats;
}

async function main() {
  // govt_assignments
  const ga = await db.select().from(govtAssignments);
  await processTable(
    "govt_assignments", ga,
    (id, p, l) => db.update(govtAssignments).set({ jurisdictionProvince: p, jurisdictionLocality: l }).where(eq(govtAssignments.id, id)).then(() => {}),
  );

  // approval_requests
  const ar = await db.select().from(approvalRequests);
  await processTable(
    "approval_requests", ar,
    (id, p, l) => db.update(approvalRequests).set({ jurisdictionProvince: p, jurisdictionLocality: l }).where(eq(approvalRequests.id, id)).then(() => {}),
  );

  // organizations (verify columns exist; some orgs may not have jurisdiction set)
  // ... similar pattern

  // service_offerings — similar pattern

  console.log("Done.");
}

main().then(() => process.exit(0));
```

### Fase E — Paso 4: Test del script

`__tests__/normalize-existing-jurisdictions.test.ts`: fixture con 5 rows non-canónicas + 2 canónicas + 1 con localidad inexistente. Verifica que normalize las 5, deja 2 unchanged, reporta 1 failed.

### Fase E — Verificación

```bash
pnpm test
pnpm typecheck
pnpm tsx scripts/normalize-existing-jurisdictions.ts --dry-run
# Revisar output. Si hay failed entries, decidir caso por caso.
```

### Fase E — Commit

```
feat(actions/scripts): canonical jurisdiction validation + migration

All seven server actions that persist (province, locality) now
resolve them through resolveCanonicalJurisdiction() before write.
Provinces flow through provinceByName/provinceByCode; localities
flow through localityByName backed by ar_localities.

scripts/normalize-existing-jurisdictions.ts normalizes pre-existing
rows in govt_assignments, approval_requests, organizations, and
service_offerings. Rows where the locality can't be auto-resolved
are reported on stderr for manual review.

pet_events stays append-only — emits a CSV report of mismatches
instead of mutating.
```

---

## Operación post-merge (OP) — no es un PR, son comandos

Después de mergear Fase B y antes de Fase D (para que el catálogo exista cuando los forms lo usen):

```bash
# 1. Staging
pnpm tsx scripts/import-indec-localities.ts --dry-run
# Revisar el output. Esperado: ~4500 inserted, 0 errors graves.

pnpm tsx scripts/import-indec-localities.ts
# Aplica. Verificar en DB: select count(*) from ar_localities where removed_at is null;
# → debe dar ~4500.

# 2. Production (después de validar staging)
# Misma secuencia.
```

Después de Fase E:

```bash
# 3. Staging
pnpm tsx scripts/normalize-existing-jurisdictions.ts --dry-run
# Revisar failed entries. Decidir.

pnpm tsx scripts/normalize-existing-jurisdictions.ts
# Aplica.

# 4. Production
# Misma secuencia.
```

---

## README updates después de todas las fases

Editar `docs/superpowers/README.md`:

1. Marcar el spec v1.0 (`2026-05-18-localities-catalog-design.md`) como **🚫 Superseded por v2.0**. Mover fuera de "Ready for CC".
2. Mover el spec v2.0 a **✅ Implementado** una vez todas las fases mergearon.
3. Marcar el plan correspondiente a **✅ Implementado**.

---

## Notas finales para Claude Code

- **Cada fase = 1 PR independiente**. NO mezcles fases.
- **Pre-fase D, el catálogo debe estar en la DB** (Fase B mergeada + script corrido en staging/prod). Si no, el combobox devuelve vacío y los forms quedan rotos.
- **El script de import (Fase B) NO se corre en producción como parte del PR merge**. Es operación manual aparte. El PR solo mergea el código del script.
- **Si datos.gob.ar cambió la URL o el formato del CSV** entre cuando escribí este plan y cuando lo ejecutás, **pausá y reportá a Nacho**. No intentes auto-resolver — un dataset mal parseado es peor que un script que falla loud.
- **Para CABA**, INDEC clasifica los barrios como "Componente de localidad compuesta" (porque CABA es una única "localidad" compuesta de 48 barrios). El `normalizeCategory` los mapea a `componente`. UX-wise, en el typeahead aparecen como localidades normales — la categoría no se muestra al usuario.
- **El catálogo INCLUYE La Plata** (capital de Buenos Aires) además de los partidos del GBA. La búsqueda "La Plata" desde un govt de provincia BA debe matchear.
- **No agregar localidades al catálogo a mano** (`source='manual'`) mientras estés ejecutando este plan. El catálogo es INDEC; las manuales son una válvula de escape para casos excepcionales que aparecen post-launch.
- **Reportá a Nacho al final de cada fase** con un resumen corto en español: qué quedó implementado, qué quedó como follow-up (si algo se desvió del plan).

Si algo de este plan no se puede ejecutar (función que no existe, schema mismatch, dataset rota), **pausá y preguntá**. Coherencia con AGENTS.md y los specs previos es lo más importante.
