# Catálogo de localidades INDEC — design spec

> Catálogo completo de las ~4500 localidades de la República Argentina importado desde la base oficial INDEC, persistido en DB con índice de búsqueda, expuesto vía typeahead a todos los forms que capturan jurisdicción. Resuelve el bug del admin govt (texto libre) y unifica el patrón de direcciones en todo el app según AGENTS.md.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC — el plan ejecutable es `plans/2026-05-18-localities-catalog-indec.md`
> **Versión:** 2.0 — **supersede** de `2026-05-18-localities-catalog-design.md` v1.0 (catálogo curado), que queda como referencia histórica. La diferencia: v1.0 hardcodeaba 94 entradas en TS; v2.0 importa la totalidad de INDEC (~4500) a tabla DB con typeahead.

### Changelog

| Versión | Fecha | Cambios |
|---|---|---|
| **v2.0** | 2026-05-18 | Reemplaza el catálogo curado por la base completa INDEC. Tabla `ar_localities` en DB, script de import idempotente, typeahead UX. Supersede v1.0 antes de implementación. |
| v1.0 | 2026-05-18 | Versión inicial — catálogo curado de 94 entradas hardcoded. Superseded sin haberse implementado. |

---

## 1. Por qué este documento existe

Mismo bug que v1.0 (admin asigna localidades como texto libre, scope-match rompe con strings divergentes), pero la solución correcta a largo plazo:

- **El catálogo curado v1.0 era una mitigación, no la solución.** 94 entradas cubren ~90% de los casos esperados en v1 pero rompen apenas DIM tenga adopción fuera de AMBA (un govt en Bariloche, Mendoza capital, Salta, etc.).
- **INDEC publica el catálogo oficial** vía datos.gob.ar como CSV abierto y actualizado (post-CNPHV 2022). Es el único catálogo que el resto del estado argentino reconoce, lo que importa para integraciones futuras (Mascotas CABA, SENASA, Mi Argentina).
- **El esfuerzo extra es modesto**: 1 script de import + 1 tabla + 1 componente typeahead. A cambio: cobertura nacional, alineamiento con el estándar oficial, soporte para integraciones futuras sin re-trabajo.

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| D1 | **Catálogo persiste en tabla DB `ar_localities`**, no en módulo TS | 4500 entradas en TS son ~200KB que cargan en cada bundle. DB con índice es la respuesta correcta. Además habilita query server-side eficiente para typeahead |
| D2 | **Fuente: INDEC "Códigos de provincias, departamentos y localidades de la República Argentina"** vía datos.gob.ar | Dataset oficial, actualizado post-censo 2022, CSV estable. ID del dataset: registrar exacto en el plan; el slug típico es `codigos-indec-provincias-departamentos-localidades`. Mirror en datos.ign.gob.ar (BAHRA) opcional para enriquecer con coordenadas |
| D3 | **El identificador canónico es el `indec_id` (8-11 dígitos)** + redundancia `(province_code, locality_slug)` única | INDEC ID es estable nacional; `(province_code, locality_slug)` es human-readable y permite scope-match cuando el indec_id no se persiste (caso de `govt_assignments` que sigue siendo TEXT names) |
| D4 | **Persistencia operativa sigue siendo TEXT del display name** (province + locality) en `govt_assignments`, `approval_requests`, `pet_events.payload`, `service_offerings`, `organizations.jurisdiction_*`, etc. **No** migramos esas columnas a FK contra `ar_localities` en este PR | Migrar 8+ tablas + denormalizaciones + payload introspections es un proyecto enorme. El catálogo garantiza que el TEXT escrito **vino del catálogo** (validation en write); reads siguen funcionando con string compare. Migrar a códigos es una iteración futura cuando duela |
| D5 | **Filtramos a categorías relevantes en el import**: incluimos `localidad`, `ciudad`, `pueblo`, `comuna`, `componente de localidad compuesta`. Excluimos `paraje`, `caserío`, `entidad`, asentamientos < 50 habitantes | El catálogo INDEC tiene ~17K entries si se incluye todo; filtrando bajamos a ~4500 que son los lugares operacionalmente relevantes para programas sanitarios |
| D6 | **CABA recibe tratamiento especial: barrios (Ley 1.777/2005), no comunas** | Las 15 comunas no son las unidades operativas; los 48 barrios sí. INDEC lista ambos — el import script preserva los barrios (categoría `barrio` o `componente de localidad`) y excluye las 15 entradas de comuna a nivel CABA. Mismo pattern que v1.0 |
| D7 | **El import es idempotente y trazable**: corre vía script `pnpm tsx scripts/import-indec-localities.ts`. Cada corrida loguea inserts/updates/no-ops. Re-correr no duplica | Operativamente: corre 1 vez post-merge para poblar la tabla; corre cada N meses si INDEC publica versión nueva. Tabla `ar_localities_import_runs` traquea la historia |
| D8 | **UX cliente es typeahead con debounce 200ms, min 2 chars**. Server action retorna top 20 ordenado por exact prefix > prefix > contains | Dropdown con 4500 opciones es inutilizable. Typeahead es el patrón estándar para catalogs grandes. Server action evita exponer toda la tabla al client |
| D9 | **Componente único `<LocalityCombobox>`** reemplaza el actual input/select de localidad en todos los forms. `LocationFields.tsx` lo embebe | Single source of UX truth. El día que cambiemos el typeahead (ej. agregar coordinates rendering), un solo lugar |
| D10 | **Validación server-side** confirma que el (province_code, locality_name) existe en `ar_localities` antes de persistir. Implementado en `lib/ar-localidades.ts` (mismo file de helpers v1.0, expandido) | Defense-in-depth: ningún path que escriba `jurisdiction_*` puede saltarse el catálogo |
| D11 | **No exponemos el catálogo como API pública**. Las consultas son server-side dentro de server actions de DIM | No tenemos rate limits; no necesitamos que terceros nos peguen. Si más adelante hay demanda, se diseña con auth + cache |
| D12 | **Las "rows fuera de catálogo" detectadas por el script de migración se reportan en consola** y Nacho decide caso por caso. No auto-corregimos | Si una row dice "El Bolsón, Río Negro" y existe en INDEC como "El Bolsón", el script lo matchea por nombre normalizado. Si dice "Barrio Norte, CABA" y INDEC tiene "Recoleta" (que es el barrio oficial que contiene la zona conocida como Barrio Norte), no hay match automático correcto — requiere decisión humana |

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **`indec_id`** | Código numérico oficial INDEC de 8-11 dígitos. 2 dígitos provincia + 3 departamento + 3 localidad (+ 3 entidad opcional). Estable, ej. `06028030` = Avellaneda (partido) de Buenos Aires | `ar_localities.indec_id` |
| **Categoría** | Tipo INDEC: `localidad`, `ciudad`, `pueblo`, `comuna`, `barrio`, `paraje`, `caserío`. Filtramos a las primeras 5 | `ar_localities.category` |
| **Departamento / Partido / Comuna** | Nivel intermedio. "Departamento" nacional; "Partido" en provincia BA; "Comuna" en CABA | `ar_localities.department_name` (libre, contextual; sin tabla separada en v2.0) |
| **Slug** | Nombre normalizado: lowercase + NFD + strip-marks + strip-dots + collapse-spaces. Único dentro de provincia | `ar_localities.locality_slug` |
| **Import run** | Una ejecución del script de import. Cada una crea row en `ar_localities_import_runs` | Tabla nueva |

## 4. Domain model

### 4.1 Tabla `ar_localities`

```sql
create table ar_localities (
  id                uuid primary key default gen_random_uuid(),

  -- Province
  province_code     text not null,                                 -- ISO 3166-2:AR ("AR-C", "AR-B", etc.)

  -- Department / Partido / Comuna context
  department_name   text,                                          -- "Avellaneda", "La Capital", "Comuna 14"
  department_code   text,                                          -- INDEC department code, 5-7 digits

  -- Locality
  locality_name     text not null,                                 -- "Palermo", "La Plata", "Bariloche"
  locality_slug     text not null,                                 -- "palermo", "la-plata", "bariloche"
  indec_id          text unique,                                   -- canonical INDEC ID, e.g. "02014010"
  category          text not null,                                 -- 'localidad' | 'ciudad' | 'pueblo' | 'comuna' | 'barrio' | 'componente'

  -- Optional enrichment from BAHRA (separate import pass)
  latitude          numeric(10, 7),
  longitude         numeric(10, 7),

  -- Provenance
  source            text not null,                                 -- 'indec_cppdyl' | 'bahra' | 'manual'
  source_version    text,                                          -- "2024-12" or commit hash from datos.gob.ar
  last_imported_at  timestamptz not null default now(),

  -- Soft-delete (in case INDEC removes a locality between versions)
  removed_at        timestamptz,

  constraint ar_localities_province_valid check (province_code ~ '^AR-[A-Z]$'),
  constraint ar_localities_category_valid check (category in (
    'localidad','ciudad','pueblo','comuna','barrio','componente'
  )),
  constraint ar_localities_source_valid check (source in ('indec_cppdyl','bahra','manual'))
);

create unique index ar_localities_province_slug_uniq
  on ar_localities (province_code, locality_slug)
  where removed_at is null;

create index ar_localities_province_idx
  on ar_localities (province_code)
  where removed_at is null;

-- Full-text search index for typeahead (Spanish text search config)
create index ar_localities_name_search
  on ar_localities using gin (to_tsvector('spanish', locality_name));

-- Trigram index for partial matches (e.g. typing "barilo" matches "Bariloche")
-- Requires pg_trgm extension: create extension if not exists pg_trgm;
create extension if not exists pg_trgm;
create index ar_localities_name_trgm
  on ar_localities using gin (locality_name gin_trgm_ops)
  where removed_at is null;
```

### 4.2 Tabla `ar_localities_import_runs`

```sql
create table ar_localities_import_runs (
  id                uuid primary key default gen_random_uuid(),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  source            text not null,                  -- 'indec_cppdyl' | 'bahra'
  source_url        text not null,                  -- URL del CSV descargado
  source_version    text,                           -- date/commit del dataset
  status            text not null default 'running',  -- 'running' | 'ok' | 'failed'
  inserted_count    integer not null default 0,
  updated_count     integer not null default 0,
  noop_count        integer not null default 0,
  removed_count     integer not null default 0,
  details           jsonb not null default '{}'::jsonb,

  constraint ar_imports_status_valid check (status in ('running','ok','failed'))
);

create index ar_localities_import_runs_idx on ar_localities_import_runs (started_at desc);
```

### 4.3 Helpers en `lib/ar-localidades.ts` (server-side)

```ts
// Server-only (queries DB)
export async function searchLocalities(input: {
  provinceCode?: ProvinceCode;
  query: string;
  limit?: number;
}): Promise<LocalitySearchResult[]>;

export async function localityByIndecId(indecId: string): Promise<Locality | null>;

export async function isCanonicalLocality(
  provinceCode: string,
  localityName: string,
): Promise<boolean>;

export async function localityByName(
  provinceCode: ProvinceCode,
  name: string,
): Promise<Locality | null>;
```

Tipos:

```ts
export type LocalitySearchResult = {
  indecId: string;
  provinceCode: ProvinceCode;
  provinceName: string;
  departmentName: string | null;
  localityName: string;
  localitySlug: string;
  category: "localidad" | "ciudad" | "pueblo" | "comuna" | "barrio" | "componente";
  matchKind: "exact" | "prefix" | "contains";  // for ranking display
};
```

### 4.4 Ordenamiento de resultados de `searchLocalities`

Devuelve top N (default 20) ordenado por:

1. **Exact slug match** del query normalizado (peso 1000)
2. **Prefix match** del query normalizado (peso 100, normalized)
3. **Contains match** del query normalizado (peso 10)
4. Dentro de cada categoría, prioridad por `category`: ciudad > localidad > pueblo > barrio > comuna > componente
5. Dentro de cada categoría, alfabético por `locality_name`

Implementación: query con `CASE WHEN locality_slug = $1 THEN 1000 WHEN locality_slug LIKE $1 || '%' THEN 100 WHEN locality_name ILIKE '%' || $1 || '%' THEN 10 END as score`, ORDER BY score DESC, category, locality_name. Trigram index acelera el `ILIKE %query%`.

## 5. Source data — INDEC CPPDyL

INDEC publica el catálogo en datos.gob.ar bajo "Códigos de provincias, departamentos y localidades de la República Argentina" (CPPDyL). El dataset tiene CSVs separados por nivel:

- `provincias.csv` — 24 entries
- `departamentos.csv` — ~530 entries (departamentos / partidos / comunas)
- `localidades.csv` — ~4500 entries (con FK a departamento)
- `entidades.csv` — ~17K entries (parajes, caseríos, sub-localidades) — **no se usa**

**Columnas relevantes del `localidades.csv`** (los nombres exactos pueden variar entre versiones del dataset; el script debe ser tolerante):

| Columna esperada | Mapea a |
|---|---|
| `cod_loc` o `id` | `indec_id` |
| `nombre` o `nombre_loc` | `locality_name` |
| `cod_depto` o `departamento_id` | `department_code` |
| `nombre_depto` o `departamento_nombre` | `department_name` |
| `cod_prov` o `provincia_id` | mapeable a `province_code` via tabla local |
| `nombre_prov` o `provincia_nombre` | mapeable a `province_code` via `provinceByName` |
| `categoria` o `tipo` | `category` |

**URL canónica** (verificar en el plan; típicamente):
`https://infra.datos.gob.ar/catalog/modernizacion/dataset/7/distribution/7.1/download/localidades.csv`

(El plan documenta el flujo exacto: fetch del catálogo metadata → resolver distribución actual → descargar CSV.)

## 6. UX changes

### 6.1 Server action `app/actions/localities.ts` (nuevo)

```ts
"use server";

export async function searchLocalitiesAction(input: {
  provinceCode?: string;
  query: string;
}): Promise<{ results: LocalitySearchResult[] } | { error: string }> {
  // No requireAdminOrRedirect — anyone authenticated can use the combobox.
  // Rate limit: 60 reqs/min per session (in-memory map keyed by session id;
  //   simple, suficiente para v1).
  // Returns max 20 results.
}
```

### 6.2 Client component `components/LocalityCombobox.tsx` (nuevo)

```tsx
type Props = {
  provinceCode: ProvinceCode | null;       // disabled if null
  defaultValue?: { localityName: string };
  name: string;                             // form field name
  required?: boolean;
  onSelect?: (selected: LocalitySearchResult | null) => void;
};
```

UX:
- `<input>` con label "Localidad o barrio"
- Si `provinceCode` es null → input deshabilitado con placeholder "Primero elegí provincia"
- Si user tipea → debounced (200ms) llamada a `searchLocalitiesAction` con `{ provinceCode, query }`
- Dropdown de resultados con keyboard navigation (↑↓ Enter Esc)
- Cada resultado muestra: `{locality_name} · {department_name}` (segundo grayed)
- Al seleccionar: setea valor del input + hidden field `name="localityIndecId"` con el indec_id + dispatch `onSelect`
- Form recibe ambos: `localityName` (display) + `localityIndecId` (canonical reference)

**Sin opción "Otra (especificar)"**. Si el catálogo no cubre, el usuario reporta vía mailto-suggest (mismo pattern v1.0).

### 6.3 Forms a refactorear

| Surface | Hoy | Cambio |
|---|---|---|
| `app/admin/govts/new/CreateGovtForm.tsx` | Free text province + locality | Province `<select>` (catálogo `PROVINCES`) + `<LocalityCombobox provinceCode={...}>` |
| `app/admin/govts/_components/AssignLocalityForm.tsx` | Free text province + locality | Idem |
| `components/LocationFields.tsx` | Province select + free text locality | Mantiene province select + reemplaza locality input por `<LocalityCombobox>`. Prop `strictLocalityCatalog?: boolean` desaparece — todo es estricto post-v2.0 |
| `app/(app)/cuenta/upgrade/OrgCreateForm.tsx` | Usa LocationFields | Hereda |
| `app/pro/servicios/nuevo/VetServiceOfferingForm.tsx` | Usa LocationFields | Hereda |
| `app/denuncias/nueva/WelfareReportForm.tsx` | Usa LocationFields | Hereda |
| `components/PetForm.tsx` | Usa LocationFields | Hereda |

## 7. Server-side validation

Cualquier server action que persista `jurisdiction_province` + `jurisdiction_locality` (o equivalent campos) DEBE validar contra catálogo antes de write:

```ts
import { provinceByName, provinceByCode } from "@/lib/ar-provincias";
import { localityByName } from "@/lib/ar-localidades";

const province = provinceByName(rawProvince) ?? provinceByCode(rawProvince);
if (!province) throw new Error(`Provincia '${rawProvince}' no es válida.`);

const locality = await localityByName(province.code, rawLocality);
if (!locality) {
  throw new Error(
    `Localidad '${rawLocality}' no figura en el catálogo INDEC para ${province.name}.`,
  );
}

// Persist canonical names
const jurisdictionProvince = province.name;
const jurisdictionLocality = locality.localityName;
```

**Lista de server actions que requieren agregar este patrón** (auditoría completa, no solo govt):

| Server action | Archivo | Persistencia |
|---|---|---|
| `assignGovtLocalityForAuthority` | `app/actions/admin-institutional.ts` | `govt_assignments` |
| `createInstitutionalAccountForAuthority` | `app/actions/admin-institutional.ts` | `govt_assignments` (initial) |
| `requestVetUpgradeForUser` | `app/actions/upgrade.ts` | `approval_requests.jurisdiction_*` |
| `createOrganizationForUser` | `app/actions/upgrade.ts` | `organizations.jurisdiction_*` + `approval_requests.jurisdiction_*` |
| Acción que crea `service_offerings` | `app/actions/service-offerings.ts` | `service_offerings.jurisdiction_*` |
| Acción que crea welfare reports | `app/actions/welfare.ts` | `welfare_reports.jurisdiction_*` |
| Acción que crea pet events con jurisdiction en payload | `app/actions/events.ts` | `pet_events.payload.locality_context.*` |

El plan especifica el cambio exacto en cada uno.

## 8. Migration de rows existentes

Mismo script que v1.0, pero con cobertura nacional mucho mejor:

```ts
// scripts/normalize-existing-jurisdictions.ts
//
// 1. Para cada tabla con jurisdiction_province + jurisdiction_locality:
//    - govt_assignments
//    - approval_requests
//    - organizations
//    - service_offerings
//    - welfare_reports
//    - pet_events (payload->>'locality_context')  ← read-only, no se muta porque
//      pet_events es append-only; en su lugar emitir un audit log o reporte
// 2. Para cada row:
//    a. Resuelve province con provinceByName(raw)
//    b. Resuelve locality con localityByName(provinceCode, raw)
//    c. Si ambos resuelven y los nombres canónicos difieren del raw:
//       UPDATE ambos campos a los canónicos
//    d. Si alguno no resuelve: print row identifier + raw values
// 3. Imprime resumen: N normalizadas, M sin match.
//
// Idempotente: re-correr es no-op si ya están canónicas.
```

Para `pet_events` (append-only):
- Genera reporte CSV con event_id + raw values + sugerencia (puede ser auto-resoluble o requerir input humano)
- No muta. La verdad histórica queda como está. El catálogo es fuente de truth para writes nuevos
- Reads que necesitan agregar (rollups) usan `localityByName` para normalizar on-the-fly si el valor crudo no matchea

## 9. Phasing — 5 PRs independientes

| Fase | PR | Resumen |
|---|---|---|
| **A** | 1 | Schema: tablas `ar_localities` + `ar_localities_import_runs`. Migración 0019. Drizzle models. Sin código de import todavía |
| **B** | 1 | Script `scripts/import-indec-localities.ts`. Fetch CSV, parse, upsert. Tests con CSV fixture. **No corre en producción todavía** — solo se mergea el código |
| **C** | 1 | Helpers en `lib/ar-localidades.ts` (server-side, DB-backed). Tests con tabla seeded. Server action `searchLocalitiesAction` + rate limit |
| **D** | 1 | Componente `<LocalityCombobox>` + refactor de `LocationFields.tsx` + admin govt forms (`CreateGovtForm`, `AssignLocalityForm`) |
| **E** | 1 | Validación server-side en los 7 server actions de §7. Script `normalize-existing-jurisdictions.ts`. Smoke test post-deploy |
| **OP** | — | Operación: post-Fase B merge, correr `pnpm tsx scripts/import-indec-localities.ts` en staging y luego production. Verificar count ≈ 4500. Post-Fase E, correr el normalize script |

PRs A-C pueden mergerse en paralelo si CC trabaja en sub-branches; D depende de C; E depende de C+D. Estimado total: ~2 días de CC.

## 10. Out-of-scope explícito

- **Migrar columnas DB de TEXT a FK contra `ar_localities`** — proyecto aparte cuando duela (aggregación, etc.).
- **Coordenadas (lat/lng) por locality** — la tabla las soporta pero el import inicial es solo INDEC (sin coordinates). Segundo pass desde BAHRA queda como Fase F futura.
- **Multi-country** — solo AR. La tabla se llama `ar_localities` precisamente para no contaminar el namespace cuando expandamos.
- **UI admin para editar el catálogo manualmente** — el catálogo se modifica via re-import (INDEC actualiza) o via INSERT manual con `source='manual'` por DBA (raro).
- **API pública del catálogo** — solo internal server actions.
- **Versionado del catálogo** — `source_version` documenta qué versión INDEC trajo cada row. No mantenemos historia row-by-row.
- **Sinónimos / alias de localidades** ("Barrio Norte" → "Recoleta") — el typeahead resuelve por prefijo/contains sobre el nombre oficial. Alias se tratan caso por caso si emerge demanda.

## 11. Open questions

- **¿Cuánto rate limiting aplicar al typeahead?** Default propuesto: 60 reqs/min por sesión. Si emerge abuso (script kiddie probando), se baja. Si emerge fricción legítima (forms grandes con muchos cambios), se sube.
- **¿Cómo manejamos el caso CABA donde "barrio" no es jerárquicamente igual a "localidad" en otras provincias?** INDEC mete los barrios CABA bajo categoría especial. Decisión: tratarlos como localidades de primer nivel en el catálogo nuestro. UX en `<LocalityCombobox>` no distingue — el usuario CABA tipea "Palermo" y elige. Department_name de Palermo será "Comuna 14" para contexto.
- **¿Importamos `entidades.csv` (~17K parajes)?** No en v2.0. Si emerge demanda real (un govt rural reportando un paraje específico), agregamos como toggle del import script (`--include-entidades`).
- **¿Qué pasa si INDEC remueve una locality entre versiones?** El script set `removed_at=now()` en la row. Read queries filtran `where removed_at is null`. Si quedan FKs (en futuro, no hoy) las preservamos. Lossy: si un govt tenía assignment a esa locality, la row sigue ahí (TEXT no rompe), aparece "Sin coverage canónica" en surfaces analytics.

---

## Próximo paso

CC ejecuta el plan `plans/2026-05-18-localities-catalog-indec.md` en sus 5 fases. Cada fase es un PR. Si algo del plan se desvía (URL del CSV cambió, columnas distintas, etc.), CC pausa y pregunta. No improvisa.
