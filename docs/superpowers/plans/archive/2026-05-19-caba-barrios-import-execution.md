# CABA barrios — operational execution

> **Estado (2026-06-04):** ✅ COMPLETO — enviado (commits 225aadd, 9412f6b; PR #372). Tests en __tests__/caba-barrios.test.ts.

> Plan operativo corto. El script `scripts/import-caba-barrios.ts` ya existe y está listo (hardcoded de los 48 barrios per Ley CABA 1.777). Falta ejecutarlo en producción y verificar que el typeahead `LocalityCombobox` los rankee bien para usuarios CABA.
>
> Sin nada que escribir en lib/ ni schema — todo está. Es solo run + verify + minor UX tweak.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for execution
> **Tamaño:** 1 script run + ~20 LOC de combobox tweak + tests
> **Estimación:** ½ día

---

## 0. Antes de tocar nada

1. **`scripts/import-caba-barrios.ts`** — leer y entender qué hace (UPSERT idempotente por slug, sin lat/lng, source `caba_open_data`, category `barrio`, provinceCode `AR-C`).
2. **`docs/superpowers/specs/2026-05-18-localities-catalog-indec-design.md` D6** — confirma que INDEC dejó CABA como una sola entry; los 48 barrios vienen de este script.
3. **`components/LocalityCombobox` + `lib/ar-localidades.ts`** — typeahead actual. Posiblemente rankea por `(provinceCode, localityName ILIKE %query%)` plano; necesita boost a barrios cuando `provinceCode='AR-C'`.

## 1. Steps

### Paso 1 — Ejecutar el import

```bash
# Dry run primero (no modifica DB)
pnpm tsx scripts/import-caba-barrios.ts --dry-run

# Confirmar output: 48 inserts esperados, 0 ya existentes (primera ejecución)
# o 0 inserts + 48 updates de last_imported_at (re-ejecución)

# Live run
pnpm tsx scripts/import-caba-barrios.ts
```

### Paso 2 — Verificación SQL

Desde Supabase Studio:

```sql
-- Conteo: tienen que ser 48 (Ley CABA 1.777)
select count(*) from ar_localities
  where province_code = 'AR-C' and source = 'caba_open_data' and removed_at is null;

-- Sampling: verificar que los nombres tienen acentos correctos
select locality_name, locality_slug from ar_localities
  where province_code = 'AR-C' and source = 'caba_open_data'
  order by locality_name
  limit 10;
-- Esperado: Agronomía, Almagro, Balvanera, Barracas, Belgrano, Boedo, ...

-- Sanity: CABA como localidad única de INDEC sigue ahí (no debe haberse borrado)
select count(*) from ar_localities
  where province_code = 'AR-C' and source = 'indec_cppdyl' and removed_at is null;
-- Esperado: 1 (la entry catch-all "Ciudad Autónoma de Buenos Aires" de INDEC)
```

### Paso 3 — UX tweak en LocalityCombobox

**Comportamiento actual** (asumir, validar leyendo): cuando el usuario CABA tipea "Pal" → devuelve resultados ordenados alfabético/match-rank, pero "Palermo" (barrio CABA) puede quedar por debajo de otras coincidencias provinciales.

**Comportamiento deseado**: si el usuario tiene `pet.jurisdiction_province='Ciudad Autónoma de Buenos Aires'` (o el form contextualmente pre-selectó CABA), los barrios CABA deben aparecer ARRIBA. Sino, ranking normal.

**Cambio sugerido en `lib/ar-localidades.ts`** (ajustar al nombre real del helper):

```ts
// Helper: search localities con boost contextual
export async function searchLocalities({
  query,
  contextProvinceCode,
}: {
  query: string;
  contextProvinceCode?: string;  // si está, boost matches de esa provincia
}): Promise<ArgentineLocality[]> {
  const rows = await db
    .select()
    .from(arLocalities)
    .where(and(
      isNull(arLocalities.removedAt),
      ilike(arLocalities.localityName, `%${query}%`),
    ))
    .orderBy(
      // Boost matches de la provincia contextual
      sql`case when ${arLocalities.provinceCode} = ${contextProvinceCode ?? ''} then 0 else 1 end`,
      // Después por similitud al query (start-match > middle-match)
      sql`case when ${arLocalities.localityName} ilike ${query + '%'} then 0 else 1 end`,
      arLocalities.localityName,
    )
    .limit(20);
  return rows;
}
```

Si el helper ya tiene parámetro de provincia/contexto, validar que ahora con barrios CABA en la tabla el resultado es razonable; si no, agregar.

### Paso 4 — Tests

`__tests__/caba-barrios-imported.test.ts` (smoke, opcional):

```ts
it('CABA tiene los 48 barrios oficiales', async () => {
  const count = await db.select({ c: sql<number>`count(*)` }).from(arLocalities)
    .where(and(
      eq(arLocalities.provinceCode, 'AR-C'),
      eq(arLocalities.source, 'caba_open_data'),
      isNull(arLocalities.removedAt),
    ));
  expect(count[0].c).toBe(48);
});

it('Palermo y Boedo y La Boca aparecen', async () => {
  const rows = await db.select().from(arLocalities)
    .where(and(
      eq(arLocalities.provinceCode, 'AR-C'),
      inArray(arLocalities.localityName, ['Palermo', 'Boedo', 'La Boca']),
    ));
  expect(rows.length).toBe(3);
});
```

`__tests__/locality-combobox-ranking.test.ts` (si aplica el tweak del Paso 3):

```ts
it('búsqueda "Pal" con context CABA: Palermo arriba', async () => {
  const results = await searchLocalities({ query: 'Pal', contextProvinceCode: 'AR-C' });
  expect(results[0].localityName).toBe('Palermo');
});

it('búsqueda "Pal" sin context: orden alfabético', async () => {
  const results = await searchLocalities({ query: 'Pal' });
  // No assertion sobre orden específico (sin context, orden natural)
  expect(results.find(r => r.localityName === 'Palermo')).toBeDefined();
});
```

### Paso 5 — Verificación manual

- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes
- [x] Smoke en `PetForm`: como usuario CABA, en el campo locality tipear "Palermo" → aparece como primer resultado (no como uno cualquiera detrás de otros)
- [x] Confirmar: pets existentes con `jurisdiction_locality='Ciudad Autónoma de Buenos Aires'` (sin barrio) siguen funcionando (no break retroactivo)
- [x] Confirmar: nuevas pets registradas en CABA pueden elegir barrio específico, y la columna `jurisdiction_locality` recibe el barrio (e.g., "Palermo"), no "Ciudad Autónoma de Buenos Aires"

## 2. Out of scope

- **Backfill retroactivo** de pets existentes con `jurisdiction_locality='Ciudad Autónoma de Buenos Aires'` para asignarlas a barrios — fuera de scope. No tenemos data del barrio en histórico. Quedan con CABA-genérico hasta que el dueño edite.
- **Centroides lat/lng** de los barrios — el script no los importa por diseño (`null`). Si en algún feature futuro hace falta heatmap por barrio, se agrega como follow-up importando del portal de la ciudad.
- **15 comunas** como nivel intermedio — el spec INDEC D6 ya cerró: usamos barrios directo, no comunas. La comuna aparece como contexto displayable en `department_name` (info-only).

---

**Listo para ejecución.** Sin PR de código necesario salvo el tweak menor del combobox (opcional, validar primero).
