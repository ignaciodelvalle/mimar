# Location domain — P1 + P2 + P3.5 (sin-DB) — implementation plan

> Plan ejecutable para Claude Code. Las **tres fases sin migración** del epic de Location (#31 / #41):
> P1 `LocationValue` + capture contract, P2 normalization/validation gate, P3.5 fix del `LocalityPickerAcross`.
> Refactor puro: convergen ~14 bloques `formData.get` duplicados en 10 archivos sobre un solo value object
> y un solo gate de normalización, y se arregla en la raíz el bug RadioNodeList. **Cero DB, cero RLS.**
>
> **Fecha:** 2026-06-18
> **Owner:** Ignacio Del Valle
> **Spec/proposal:** `docs/planning/location-domain-proposal-2026-06.md` (§2 target design, §4 fases, §5 non-goals)
> **Tamaño:** ~3 archivos nuevos, ~12 archivos tocados, 0 migraciones, 0 RLS
> **Estimación:** 2–3 días, 3 PRs chicos (uno por fase; P3.5 puede viajar con P1)
> **NO incluye:** P3 (convergencia de columnas, DB-risky) ni P4 (PostGIS). Ambos quedan gated en sign-off del dueño — ver §8.

---

## 0. Antes de tocar nada

Lectura obligatoria:

1. **`docs/planning/location-domain-proposal-2026-06.md`** — el design proposal. Toda decisión está justificada ahí. Si este plan contradice el proposal, gana el proposal.
2. **`lib/jurisdiction-canonical.ts`** y **`lib/jurisdiction-validation.ts`** — los helpers existentes de canonicalización (province name ↔ ISO) y validación. El gate de P2 los **envuelve**, no los reemplaza.
3. **`lib/location.ts`** — hoy hardcodea `location_lat/lng`; lo usan solo `pet_events` y `welfare_reports`. En estas 3 fases NO se toca el esquema; sí se documenta que es el único swap point (P3/P4 futuros).
4. **`components/LocationFields.tsx`** — el componente de captura (modes `jurisdiction` / `point`). Es el productor del shape que `LocationValue` formaliza.
5. **`components/LocalityPickerAcross.tsx`** (líneas ~145–174) — el bug de colisión `id`/`name` (RadioNodeList). Es P3.5.
6. **`app/admin/govts/_components/AssignLocalityForm.tsx`** — el caso divergente: usa keys `province`/`locality` en vez del shape estándar. Converge en P1.

**Baseline:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes en `develop`. Si hay rojos pre-existentes, parar y avisar a Nacho.

**Paso 0 obligatorio — inventario real del fan-out.** El proposal estima "~14 bloques en 10 archivos": upgrade, pet-sighting, intake, checkin, auth, encontre, welfare, surveillance, events, pet-form. Antes de codear, correr el grep y **fijar la lista exacta** (los nombres de campo varían por sitio):

```bash
rg -n "formData\.get\(['\"](province|provincia|locality|localidad|location_?lat|location_?lng|lat|lng|latitude|longitude|address|direccion)" app components
```

Pegá la lista resultante en el PR de P1 como checklist; cada sitio migrado se tilda. Si aparece un sitio no listado en el proposal, agregalo (no lo dejes sin migrar — el objetivo es que NO quede ningún `formData.get` de location fuera del parser).

## 1. Qué construye este plan

- **P1:** `LocationValue` (value object) + `parseLocationFromFormData` / `parseLocationFromObject` — un solo punto de lectura para los ~14 sitios. Convergencia de `AssignLocalityForm`.
- **P2:** `normalizeLocationForWrite(value, { strict })` — un solo gate de normalización/validación, envolviendo los helpers existentes; centraliza el chequeo de rango de coordenadas (hoy duplicado en sighting/finder, **ausente en MarkLost**) y la regla "siempre dentro de una localidad".
- **P3.5:** fix del `id`/`name` en `LocalityPickerAcross` (raíz del bug RadioNodeList). Independiente; puede viajar con P1.

## 2. Decisiones cerradas (del proposal — NO relitigar)

- **`LocationValue`** = `{ province (nombre canónico), provinceCode (ISO), locality, localityIndecId, lat, lng, address }`. La doble representación de provincia es **intencional** (storage = nombre por CHECK 0055; catálogo/wire = ISO), bridgeada por `lib/jurisdiction-canonical.ts`.
- **PostGIS DIFERIDO (Option B)** para v1.0: las coords son display-only; el broadcast de perdidas matchea por **string de jurisdicción**, no por coordenadas. No se introduce PostGIS.
- **Province queda display-name** (CHECK 0055; los dashboards dependen de eso). `ar_localities` no se toca. Sin cambio de proveedor de geocoding. Sin re-tocar los parches ya fixeados (accent search, check-in canon).

## 3. Scope

**Incluido:** P1, P2, P3.5 — todo refactor sin-DB.
**Excluido (gated, §8):** P3 (convergencia de columnas `location_lat/lng` numeric(10,7) + widen de `organizations` 9,6→10,7 + `readPoint/writePoint` universal con column mapping) y P4 (PostGIS). El FK nullable opcional a `ar_localities(indec_id)` viaja con P3, no acá.

## 4. Plan paso a paso

### Fase P1 — `LocationValue` + capture contract (1 PR, sin DB)

**Paso 1.1 — Definir el value object.** Nuevo `lib/location-value.ts`:
- `export type LocationValue = { province: string | null; provinceCode: string | null; locality: string | null; localityIndecId: string | null; lat: number | null; lng: number | null; address: string | null }`.
- Helpers puros: `emptyLocationValue()`, `isLocationEmpty(v)`, y un normalizador de tipos (coerción de `lat/lng` string→number con guard de `NaN`).

**Paso 1.2 — El parser.** En el mismo archivo (o `lib/location-parse.ts`):
- `parseLocationFromFormData(fd: FormData, opts?: { prefix?: string }): LocationValue` — lee los campos del form y arma el value object. Soporta el alias de keys divergentes (`provincia`/`province`, `localidad`/`locality`) vía un mapa interno, para absorber `AssignLocalityForm` sin romperlo.
- `parseLocationFromObject(obj): LocationValue` — misma lógica para inputs ya parseados (server actions que reciben objetos).

**Paso 1.3 — Migrar los ~14 sitios** (lista del Paso 0). Por cada uno: reemplazar el bloque manual de `formData.get(...)` por `parseLocationFromFormData(fd)`. **No cambiar** todavía la lógica de escritura (eso es P2) — solo la lectura. `AssignLocalityForm` pasa a emitir/leer el mismo shape.

**Paso 1.4 — Tests (test-first).** `__tests__/location-value.test.ts`:
- `parseLocationFromFormData` arma el value object correcto desde un FormData representativo de cada familia de sitio (jurisdiction-only vs point).
- Alias de keys (`provincia`↔`province`) resuelve al mismo shape.
- Coerción `lat/lng` string→number; `""`/ausente → `null` (no `0`, no `NaN`).
- **Snapshot por sitio:** para cada uno de los 14, un test que pinea el `LocationValue` resultante contra el FormData real, para garantizar que el refactor no cambió la lectura.

### Fase P2 — normalization/validation gate (1 PR, sin DB)

**Paso 2.1 — El gate.** Nuevo `normalizeLocationForWrite(value: LocationValue, opts: { strict: boolean }): NormalizedLocation` en `lib/location-value.ts` (o `lib/location-normalize.ts`):
- Envuelve `jurisdiction-canonical` (resolver province name ↔ ISO, localidad canónica) y `jurisdiction-validation` (la regla "siempre dentro de una localidad").
- **Centraliza el chequeo de rango de coordenadas** (lat ∈ [-90,90], lng ∈ [-180,180], y el bounding box AR si el proposal/validation ya lo define) — hoy duplicado en sighting/finder y **ausente en MarkLost**.
- Mantiene el split **strict/soft**: `strict:true` rechaza (throw/typed error) input no canonicalizable; `strict:false` tolera y canonicaliza best-effort (igual que hoy).

**Paso 2.2 — Cablear el gate en cada write.** En los server actions que escriben location (events, welfare, intake, checkin, sighting, finder/encontre, upgrade, surveillance, AssignLocality): pasar el `LocationValue` de P1 por `normalizeLocationForWrite` antes de persistir. **Cerrar explícitamente el gap de MarkLost** (hoy no valida rango de coords).

**Paso 2.3 — Tests (test-first).** `__tests__/location-normalize.test.ts`:
- strict rechaza province no canonicalizable; soft canonicaliza best-effort.
- coord fuera de rango se rechaza/normaliza igual en sighting, finder **y MarkLost** (el caso que antes pasaba sin validar).
- regla "siempre dentro de una localidad" se aplica uniformemente.
- Cuidado con **over-tight validation**: agregá un caso que confirme que input previamente tolerado (p. ej. localidad con tilde, coords válidas al borde) NO se rechaza ahora.

### Fase P3.5 — fix `LocalityPickerAcross` id/name (1 PR, sin DB; puede viajar con P1)

**Paso 3.5.1** — En `components/LocalityPickerAcross.tsx` (~145–174): desacoplar el `id` del input visible del `name` del hidden input. Darle al input visible `id={`${name}-input`}` (o equivalente) para que no colisione con el hidden que comparte `name` → elimina la `RadioNodeList` que rompía el `.value`.

**Paso 3.5.2 — Test:** test de componente que renderiza el picker, simula selección, y asegura que `form.elements[name].value` es el valor único esperado (no una `RadioNodeList`). Si ya existe un repro del bug, convertilo en regresión.

## 5. Verificación final

- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes.
- Grep de control: `rg -n "formData\.get\(['\"](province|locality|lat|lng|address)" app components` → **cero** resultados de location fuera de `lib/location-parse.ts` (o los justificados que documentes).
- Smoke manual de 3 flujos que escriben location: marcar perdida (coords), denuncia (L2), alta de pet (jurisdiction) — confirmar que guardan igual que antes.

## 6. Casos borde

- Sitios jurisdiction-only (sin lat/lng): el parser devuelve `lat/lng = null`, el gate no exige coords.
- `AssignLocalityForm`: keys `province`/`locality` → el alias del parser las mapea; snapshot lo pinea.
- Input legacy tolerado: P2 no debe endurecer de más (test explícito).
- Self-scan / eventos sin location: no pasan por el gate (no tienen `LocationValue`).

## 7. Cuando termines (docs en el mismo PR)

- **`docs/planning/location-domain-proposal-2026-06.md`** — marcar P1/P2/P3.5 como ✅ implementadas; dejar P3/P4 como pendientes con su gate.
- **`AGENTS.md → Design rules §1 (L1/L2)`** — referenciar `LocationValue` + `parseLocationFromFormData` como el contrato único de captura.
- **`docs/superpowers/README.md`** — si corresponde, fila de seguimiento del epic de Location.
- Header de cada archivo nuevo (`lib/location-value.ts`, etc.) con el comentario estándar "qué hace este archivo".

## 8. Lo que viene después (NO en estas fases — gated en sign-off)

- **P3 — convergencia de columnas + `readPoint`/`writePoint` universal** (DB: rename aditivo + backfill + swap backward-compatible; widen `organizations` 9,6→10,7; nunca drop in-place en el mismo deploy). Es el **"deploy 2/3" (#41)**. Requiere tu OK al plan por fases. Recién entonces escribo el plan ejecutable de P3.
- **P4 — PostGIS:** NO-OP para v1.0 (Option B). Documentar el swap contract en `lib/location.ts`.
- **FK nullable a `ar_localities(indec_id)`** — viaja con P3.

---

## Próximo paso
Ejecutar P1 (con P3.5 adentro o aparte) → P2. Cuando quieras avanzar el "deploy 2/3", confirmás el plan por fases de P3 y el PostGIS-Option-B, y escribo ese plan con el detalle de migración aditiva.
