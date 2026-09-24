# Bugfix spec — Catálogo de localidades canónico (govt assignments + unificación de direcciones)

> Spec chiquito. Cierra el bug de que el admin puede tipear texto libre como localidad/provincia al asignar cobertura a una cuenta govt, y aprovecha para unificar el resto de los surfaces de dirección bajo el patrón de catálogo canónico que AGENTS.md ya implica.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC — auto-contenido, sin plan separado (el cambio es chico)
> **Versión:** 1.0

## 1. El bug

En `app/admin/govts/new/CreateGovtForm.tsx` y `app/admin/govts/_components/AssignLocalityForm.tsx` la provincia y la localidad se capturan como `<input type="text">`. Consecuencias:

- Un admin puede tipear `caba`, `CABA`, `C.A.B.A.`, `Capital Federal`, `bsas`, etc. y todas crean rows distintas en `govt_assignments` con strings distintos.
- El scope-match en `lib/approval-scope.ts` y `lib/approval-routing.ts` compara strings exactos. Una solicitud que dice `province="CABA"` no matcheará a un assignment que dice `"Capital Federal"`. **La cola no muestra solicitudes legítimas** y los cron downstream rompen silencioso.
- Las rollups de privacidad (AGENTS.md → Aggregation & privacy) agregan por `jurisdiction_locality`; localidades duplicadas violan k-anonimato sin alarma.

El catálogo de provincias ya existe (`lib/ar-provincias.ts` con ISO 3166-2:AR codes + `provinceByName()` para normalizar). El equivalente para localidades **no existe** todavía. Este spec lo crea y conecta el catálogo a los forms que deberían usarlo.

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| D1 | **El catálogo es hardcoded en `lib/ar-localidades.ts`**, no DB-driven. Misma forma que `ar-provincias.ts` | No hay tabla, no hay seed, no hay sync runtime. Cambios al catálogo son PRs trazables. Para v1 con un puñado de govts en barrios concretos de CABA + GBA, hardcoded alcanza. Migrar a tabla con import desde INDEC queda registrado como ticket futuro |
| D2 | **Cobertura curada, no exhaustiva**. v1 incluye: los 48 barrios de CABA (Ley 1.777/2005) + los 24 partidos del Gran Buenos Aires + las capitales provinciales del resto del país | Es el footprint donde DIM efectivamente opera/operará primero. Expandir a 4500+ localidades INDEC requiere typeahead con índice — fuera de scope acá. La curación cubre >95% de los casos esperados |
| D3 | **La identidad canónica es `(province_code, locality_slug)`**. El `name` es derivado para display | Mismo patrón que provinces. Slug es estable, robusto a tildes/mayúsculas, y URL-safe (útil más adelante para rutas de dashboard regional `/gob/vigilancia/caba/palermo`) |
| D4 | **Persistimos `jurisdiction_locality` como TEXT (`name` legible)** en `govt_assignments`, `approval_requests`, `pet_events.payload`, `service_offerings`, etc. No introducimos columna `_code` en cada tabla | Migrar todos los call sites a códigos es un proyecto aparte. Lo importante ya está: la validación de input garantiza que el TEXT escrito venga del catálogo, así que ya hay normalización en escritura. Los reads siguen comparando strings idénticos correctamente |
| D5 | **Server-side validation** en server actions usa `localityByName(province, locality)` para confirmar que `(province, locality)` existe en el catálogo. Si no existe → error claro al admin | Defense-in-depth: el form puede usar dropdown/select pero el server no confía en el cliente |
| D6 | **El form del admin (govts) usa dos selects encadenados** — primero province (full catalog), luego locality (filtered al partido). No typeahead | Catálogo curado es chico (CABA 48 + GBA 24 + 22 capitales ≈ 94 entradas). Select directo es UX simple y no requiere fetch dinámico |
| D7 | **`LocationFields.tsx` reemplaza el `<input>` de barrio/localidad por un `<select>` cuando hay province seleccionada**, con fallback "otra (texto libre)" para casos donde el catálogo no cubre | Coherencia entre admin y resto del app. El fallback "otra" es la válvula de escape mientras el catálogo madura — esos rows quedan marcados con un flag interno para revisar después |
| D8 | **Para localidades fuera del catálogo el form muestra `Sugerí esta localidad`** que abre un mailto/issue link a Nacho | Cierra el loop de growth del catálogo sin permitir contaminación silenciosa |
| D9 | **`provinceByName` ya normaliza** alias (CABA, Capital Federal, etc.). Igual exportamos `localityByName(provinceCode, name)` que tolera mayúsculas/tildes/espacios extra y devuelve el canonical entry | Patrón consistente con provinces |

## 3. Domain model — `lib/ar-localidades.ts`

```ts
import { type ProvinceCode, provinceByCode } from "./ar-provincias";

export type Locality = {
  /** Code of the parent province. Foreign key into PROVINCES. */
  readonly provinceCode: ProvinceCode;
  /** Display name in Spanish (Rioplatense), e.g. "Palermo", "La Plata". */
  readonly name: string;
  /** URL-safe slug derived from name, e.g. "palermo", "la-plata". Unique within province. */
  readonly slug: string;
  /** Optional grouping label for UX, e.g. "Comuna 14" for CABA barrios. */
  readonly group?: string;
};

export const LOCALITIES: readonly Locality[] = [
  // CABA — 48 barrios (Ley 1.777/2005)
  { provinceCode: "AR-C", name: "Agronomía",      slug: "agronomia",      group: "Comuna 15" },
  { provinceCode: "AR-C", name: "Almagro",         slug: "almagro",        group: "Comuna 5"  },
  { provinceCode: "AR-C", name: "Balvanera",       slug: "balvanera",      group: "Comuna 3"  },
  // ... (los 48 barrios enumerados; lista canónica en INDEC + Wikipedia "Anexo: Barrios de la Ciudad de Buenos Aires")
  { provinceCode: "AR-C", name: "Villa Urquiza",   slug: "villa-urquiza",  group: "Comuna 12" },

  // Provincia de Buenos Aires — 24 partidos del Gran Buenos Aires (GBA 24)
  { provinceCode: "AR-B", name: "Almirante Brown", slug: "almirante-brown" },
  { provinceCode: "AR-B", name: "Avellaneda",      slug: "avellaneda"      },
  { provinceCode: "AR-B", name: "Berazategui",     slug: "berazategui"     },
  // ... el resto de los 24
  { provinceCode: "AR-B", name: "Vicente López",   slug: "vicente-lopez"   },

  // Otras provincias: capitales (1 por provincia)
  { provinceCode: "AR-X", name: "Córdoba",                slug: "cordoba"                },
  { provinceCode: "AR-S", name: "Santa Fe",               slug: "santa-fe"               },
  { provinceCode: "AR-M", name: "Mendoza",                slug: "mendoza"                },
  // ... resto de capitales
  { provinceCode: "AR-V", name: "Ushuaia",                slug: "ushuaia"                },
] as const;

export function localitiesByProvince(provinceCode: ProvinceCode): Locality[] {
  return LOCALITIES.filter((l) => l.provinceCode === provinceCode);
}

export function localityBySlug(provinceCode: ProvinceCode, slug: string): Locality | null {
  return LOCALITIES.find((l) => l.provinceCode === provinceCode && l.slug === slug) ?? null;
}

/**
 * Tolerant lookup by display name. Normaliza igual que provinceByName
 * (lowercase, NFD-decompose, strip marks, collapse whitespace, drop dots).
 * Returns the canonical Locality or null.
 *
 * Examples:
 *   localityByName("AR-C", "Palermo")              → Palermo
 *   localityByName("AR-C", "PALERMO")              → Palermo
 *   localityByName("AR-B", "la plata")             → La Plata
 *   localityByName("AR-X", "Río Cuarto")           → null (no está en el catálogo curado v1)
 */
export function localityByName(
  provinceCode: ProvinceCode,
  name: string | null | undefined,
): Locality | null {
  if (!name) return null;
  const normalized = normalize(name);
  for (const l of LOCALITIES) {
    if (l.provinceCode !== provinceCode) continue;
    if (normalize(l.name) === normalized) return l;
    if (l.slug === normalized) return l;
  }
  return null;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Validates that (provinceCode, localityName) refers to a canonical catalog entry. */
export function isCanonicalLocality(provinceCode: string, localityName: string): boolean {
  const province = provinceByCode(provinceCode);
  if (!province) return false;
  return localityByName(province.code, localityName) !== null;
}
```

**Tests** (`__tests__/ar-localidades.test.ts`):
- `localitiesByProvince("AR-C")` retorna 48 entradas.
- `localitiesByProvince("AR-B")` retorna 24 entradas.
- `localityByName("AR-C", "Palermo")` → match.
- `localityByName("AR-C", "PALERMO ")` → match (tolerancia).
- `localityByName("AR-C", "Patagonia")` → null.
- `localityByName("AR-B", "La Plata")` → match (capital de la provincia BA — se incluye junto con los GBA 24).
- `isCanonicalLocality("AR-C", "Palermo")` → true.
- `isCanonicalLocality("AR-Z", "Palermo")` → false (Santa Cruz no tiene Palermo en el catálogo).

## 4. Cambios concretos

### 4.1 Server-side validation

En **`app/actions/admin-institutional.ts`**:

```ts
// createInstitutionalAccountForAuthority — antes del insert de govt_assignments,
// para CADA locality en initialLocalities:
for (const loc of input.initialLocalities) {
  const province = provinceByName(loc.province) ?? provinceByCode(loc.province);
  if (!province) {
    throw new Error(`Provincia '${loc.province}' no es válida.`);
  }
  const locality = localityByName(province.code, loc.locality);
  if (!locality) {
    throw new Error(
      `Localidad '${loc.locality}' no figura en el catálogo para ${province.name}. ` +
      `Si la localidad debería existir, abrí un issue para agregarla.`,
    );
  }
  // Normaliza al canonical: persistimos province.name y locality.name (TEXT)
  loc.province = province.name;
  loc.locality = locality.name;
}
```

Idéntico patrón en **`assignGovtLocalityForAuthority`**.

Esto sirve aunque el form se rompa o el admin use el server action directo (test, script, dev tooling) — la única manera de meter un assignment es contra catálogo.

### 4.2 Form changes — `CreateGovtForm.tsx`

Reemplazar los dos `<input type="text">` por:
- `<select name="provinceCode">` con opciones de `PROVINCES`.
- `<select name="localitySlug">` con opciones de `localitiesByProvince(provinceCode)`. Cuando se cambia province, resetea locality.
- Last option en localitySlug: `"otra"` con label `"Sugerí una localidad nueva →"` que abre `mailto:<maintainer-email>?subject=DIM — Agregar localidad al catálogo&body=Provincia: %0AClocalidad sugerida: %0AContexto: "`.

Al submit, el form mapea `provinceCode → province.name` y `localitySlug → locality.name` y envía los strings legibles al server action (que igual valida).

### 4.3 Form changes — `AssignLocalityForm.tsx`

Mismo pattern: dos selects encadenados. Cuando se confirma, ya sabe que el (province, locality) es canónico porque vino del catálogo.

### 4.4 Form changes — `components/LocationFields.tsx`

Reemplazar el `<input type="text">` de localidad por un `<select>` filtrado por el `provinceCode` seleccionado. Cuando el catálogo no cubre la provincia (ej. una provincia donde sólo está la capital) o el usuario quiere una localidad fuera del catálogo, mostrar opción `"Otra (especificar)"` que abre un input de texto libre como fallback. El form que consume `LocationFields` decide si acepta el fallback — en el caso del admin govts, **no acepta**; en otros forms (PetForm, WelfareReportForm), sí, mientras el catálogo no esté completo.

**API change**: `LocationFields` ya recibe `includesJurisdiction?: boolean`. Agregar prop `strictLocalityCatalog?: boolean` que cuando es `true` desactiva el fallback "Otra (especificar)". Default `false` para preservar comportamiento de forms no-admin.

### 4.5 Otros call-sites a revisar

Inventario de lugares donde se captura jurisdiction (province + locality). Para cada uno, el spec define la acción esperada:

| Surface | Hoy | Acción |
|---|---|---|
| `app/admin/govts/new/CreateGovtForm.tsx` | Free text province + locality | **Bug — fix obligatorio en este PR**: dos selects encadenados, sin fallback |
| `app/admin/govts/_components/AssignLocalityForm.tsx` | Free text province + locality | **Bug — fix obligatorio**: dos selects encadenados, sin fallback |
| `components/LocationFields.tsx` | Select province + free text locality | **Mejora oportunista en mismo PR**: select locality con fallback "Otra" |
| `app/(app)/cuenta/upgrade/OrgCreateForm.tsx` | Usa LocationFields | Hereda mejora de LocationFields. Sin cambios en el form |
| `app/pro/servicios/nuevo/VetServiceOfferingForm.tsx` | Usa LocationFields (verificar) | Idem |
| `app/denuncias/nueva/WelfareReportForm.tsx` | Usa LocationFields | Idem |
| `components/PetForm.tsx` | Usa LocationFields | Idem |
| Server actions que persisten `jurisdiction_*` en approval_requests | Reciben strings del form | Agregar validación contra catálogo al pasada de `validateApprovalPayload` o en el server action que crea la row (`requestVetUpgradeForUser`, `createOrganizationForUser`) — **fuera de scope de este PR**, registrar como follow-up en `docs/superpowers/README.md` |
| Server actions que emiten events con `jurisdiction_*` en payload | Idem | Follow-up |

**Importante**: el fix _crítico_ es 4.1 + 4.2 + 4.3. La mejora de LocationFields (4.4) entra al mismo PR para que la coherencia exista cross-surface desde el día uno. Validar approval_requests / events server-side queda como follow-up porque hoy ya no llega input directo del admin a esas rutas (el admin no crea approval_requests; los crea el aplicante via forms self-service que se nutren de LocationFields).

## 5. Migration concern — data existente

Si ya hay rows en `govt_assignments` con strings no-canónicos (ej. "Capital Federal" en vez de "CABA"), el server action de assign nuevo va a fallar al validar pero los rows existentes siguen ahí. **Migration script único** (idempotente, run-once):

```ts
// scripts/normalize-existing-jurisdictions.ts (nuevo)
// Run: pnpm tsx scripts/normalize-existing-jurisdictions.ts
//
// Lee govt_assignments y approval_requests, para cada row:
//   - Resuelve province con provinceByName
//   - Resuelve locality con localityByName(province, locality)
//   - Si ambos resuelven: UPDATE jurisdiction_province + jurisdiction_locality a los canónicos
//   - Si alguno no resuelve: PRINT row id + valor original. NO mutar. Acción manual.
//
// Output:
//   "Normalized 17 rows. 2 rows need manual review:"
//   "  govt_assignments[abc123]: province='Provincia BA' (matched 'Buenos Aires'), locality='Caballito' (NO MATCH for AR-B)"
```

Las rows que no normalizan se imprimen y Nacho decide caso por caso (puede ser un error de data antiguo o una locality genuinamente fuera del catálogo curado).

El script **no es parte del flow normal** — corre una vez, post-merge. Documentar en el commit.

## 6. RLS y security

Sin cambios. El catálogo es código (no DB), las server actions ya validaban capability y ahora también validan domain. RLS sigue igual.

## 7. Verificación post-deploy

Después del merge:

1. `pnpm test` — los nuevos tests del catálogo + tests existentes pasan.
2. `pnpm typecheck` — sin errores.
3. `pnpm build` — sin errores.
4. Manual smoke en `/admin/govts/new`: ver que provincia es dropdown, localidad es dropdown filtrado por provincia, submit funciona.
5. Manual smoke en `/admin/govts/[userId]`: ver que "Asignar nueva localidad" es dropdown encadenado.
6. Manual smoke en `/cuenta/upgrade` (org creation): ver que LocationFields ofrece select de localidad con fallback "Otra".
7. Correr `scripts/normalize-existing-jurisdictions.ts` en staging primero, luego production. Revisar output.

## 8. Out-of-scope explícito

- **Catálogo INDEC completo (~4500 localidades)** — requiere tabla DB + typeahead client + import periódico. Registrar como ticket futuro en `docs/superpowers/README.md`.
- **Códigos en columnas DB** (D4) — persistencia sigue siendo TEXT del display name. Migrar a columnas `_code` es un proyecto aparte.
- **Internacionalización del catálogo** — sólo AR. Registrado bajo "Multi-country" (Fase 22 del admin spec v3.0).
- **Server-side validation en approval_requests y events** — follow-up, no este PR (sección 4.5).
- **Migración masiva de rows existentes que no normalizan automáticamente** — caso por caso, no automatizado.
- **UI para que admin agregue localidades al catálogo desde el browser** — el catálogo se modifica via PR. El "Sugerí una localidad" usa mailto, no escribe nada en DB.

## 9. Open questions

- **¿Locality "Sin especificar" como entrada explícita del catálogo?** Cuando una solicitud llega con jurisdicción incompleta, el fallback histórico fue `province="Buenos Aires", locality="Sin especificar"`. Decisión: **no**, no la agregamos. Si una solicitud no tiene locality clara, el aplicante elige la más cercana y agrega contexto en el campo notes/payload. Mejor data forzando elección que falsa precisión por "Sin especificar".
- **¿Qué pasa con localidades de provincias donde el catálogo sólo tiene la capital?** El admin asignando un govt para "Bariloche" (provincia AR-R, Río Negro) no puede hoy porque sólo está "Viedma" en el catálogo. Mitigación: el mailto-suggest abre la vía rápida para agregar Bariloche en un PR de 30 segundos. Registrar como expected behavior en el commit message.

---

## Próximo paso

Si el spec tiene OK final, CC implementa todo en un PR. No requiere plan separado por el alcance chico. Estructura del PR sugerida:

```
1. lib/ar-localidades.ts (catálogo + helpers + tests)
2. app/actions/admin-institutional.ts (validación)
3. app/admin/govts/new/CreateGovtForm.tsx (dropdowns)
4. app/admin/govts/_components/AssignLocalityForm.tsx (dropdowns)
5. components/LocationFields.tsx (locality select con fallback)
6. scripts/normalize-existing-jurisdictions.ts (run-once)
7. docs/superpowers/README.md (registrar follow-up de validation en approval_requests / events)

Commit: "fix(admin/locations): canonical locality catalog + govt assignment validation"
```

ETA estimado: ~½ día.
