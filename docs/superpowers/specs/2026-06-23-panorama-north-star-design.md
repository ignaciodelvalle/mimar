# Panorama North-Star — control poblacional

**Fecha:** 2026-06-23
**Rama:** feat/panorama-north-star
**Worktree:** C:/dim-pano-ns

---

## Norte estelar

El norte del proyecto (§G del roadmap) es **control poblacional**: ¿estamos conteniendo la
población? La métrica misión es la cobertura de esterilización vs natalidad.

El mapa flagship (`/admin/panorama`, `/gob/panorama`) no tenía ninguna capa que lo
representara. Esta spec cierra esa brecha.

---

## Diseño implementado

### Capa `esterilizacion` (nueva)

| Campo             | Valor                                                  |
|-------------------|--------------------------------------------------------|
| `id`              | `"esterilizacion"`                                     |
| `label`           | Cobertura de esterilización                            |
| `geomType`        | `choropleth`                                           |
| `source`          | `metrics:sterilization-coverage`                       |
| `dataType`        | `rate`                                                 |
| `complianceTarget`| `70` (`TARGETS.STERILIZATION_COVERAGE_PCT`)            |
| `temporal`        | `false` (snapshot de estado actual)                    |
| `color`           | `#af7aa1`                                              |

A nivel provincia renderiza una escala **divergente anclada en 70%** (debajo = zona de alerta,
arriba = zona verde). A nivel localidad renderiza count-density (limitación v1, ver abajo).

### Preset `control-poblacional` (nuevo)

```
id: "control-poblacional"
label: "Control poblacional"
description: "¿Estamos conteniendo la población? Cobertura de esterilización vs meta."
base: "esterilizacion"
level: "province"
periodPreset: "90d"
```

Un solo base layer → compatible con el modelo F2 sin restricciones adicionales.

### KPI `esterilizacion` (nuevo, en `get-panorama-kpis.ts`)

Usa `fetchSterilizationCoverage(ctx)` de `lib/metrics/population-control` — el mismo
fetcher que `/gob/poblacion`. **Paridad garantizada**: el número del mapa y el del dashboard
son idénticos por construcción (mismo fetcher, mismo scope).

```
value: `${rate}%`
sub:   "meta 70%"
bar:   rate
tone:  rate >= 70 ? "ok" : "warn"
href:  "/gob/poblacion"
```

---

## GAP encontrado y corregido: parity bug en los denominadores

### El problema original (rate-as-count)

La capa `cobertura` (antirrábica) existente tenía `dataType: "rate"` y `complianceTarget: 80`,
pero su loader de provincia (`loadRabiesCoverageByProvince`) emitía **conteo bruto de mascotas
vacunadas** (via `rollupPetsPerProvince → countDistinct(pets.id)`).

Esto hacía que la escala divergente anclara los conteos (ej: 500 mascotas) contra el target 80
— semánticamente incorrecto: una provincia con 500 mascotas vacunadas NO está "por encima del
80%" a menos que tengamos el denominador.

### El segundo problema: denominadores incorrectos

Una primera corrección agregó `rollupRatePerProvince` con denominador `COUNT(*) = TODAS las
mascotas`. Eso es semánticamente mejor que conteo bruto, pero **diverge de las métricas
canónicas del dashboard**:

- `fetchSterilizationCoverage` (lib/metrics/population-control.ts) usa `activePetsCondition`
  como denominador (solo mascotas activas, excluyendo fallecidas). El rollup local incluía las
  fallecidas → tasa sistémicamente más baja que el dashboard.
- `fetchRabiesCoverage` (lib/govt-home-kpis.ts) usa `species='dog'` como denominador (solo
  perros). El rollup local incluía todas las especies → tasa sistémicamente más baja para
  jurisdicciones con muchos gatos/otros.

El KPI de `cobertura` en el Panorama enlaza a `/gob/poblacion` — los números del mapa y del
dashboard deben ser idénticos por definición.

### La corrección final: reuso de los fetchers canónicos

Se rechazó el enfoque de rollup local genérico. Los loaders de provincia para métricas RATE
delegan ahora a los fetchers canónicos del dashboard:

- `loadSterilizationCoverageByProvince` → `fetchSterilizationCoverage(ctx).byProvince`
  - Denominador: `activePetsCondition` (mascotas activas, igual que `/gob/poblacion`).
  - Numerador: EXISTS `sterilization_performed` en mascotas activas.
- `loadRabiesCoverageByProvince` → nueva `fetchRabiesCoverageByProvince(ctx)`
  - Denominador: `species='dog'` (solo perros, igual que el KPI nacional antirrábico).
  - Numerador: perros distintos con evento de vacunación antirrábica (regex `antirr[áa]bica|rabies`).
  - Adicionada en `lib/govt-home-kpis.ts` como espejo por-provincia de `fetchRabiesCoverage`.

**Antes:** `value = ratePct(mascotasVacunadas, TODAS_LAS_MASCOTAS)` → difiere del dashboard.
**Después:** `value = ratePct` calculado por el mismo fetcher que el dashboard → paridad garantizada por reuso.

El helper local `rollupRatePerProvince`, el tipo `ProvinceRateRollupRow`, la función pura
`ratePct` y `toProvinceRateChoroplethCells` fueron eliminados de `repository.ts`. El test
`rate-pct.test.ts` fue eliminado: la paridad ya no depende de un helper local sino de reuso
directo, que es trivialmente correcto.

---

## Semántica de métricas: RATE vs DENSITY

| Métrica                 | Tipo      | Loader provincia                          | Denominador         | `value`   |
|-------------------------|-----------|-------------------------------------------|---------------------|-----------|
| `rabies-coverage`       | RATE      | `fetchRabiesCoverageByProvince(ctx)`      | perros (species=dog)| `ratePct` |
| `sterilization-coverage`| RATE      | `fetchSterilizationCoverage(ctx).byProvince` | mascotas activas | `ratePct` |
| `mortality`             | DENSITY   | `rollupPetsPerProvince`                   | N/A (count raw)     | count     |

---

## Limitación v1: locality level para métricas RATE

A nivel **localidad**, las métricas RATE (`cobertura`, `esterilizacion`) siguen emitiendo
**count-density** (count de mascotas que cumplen el predicado), NO un ratePct.

**Razón**: emitir num y den por separado a nivel localidad expone información privada cuando
una o ambas ramas están suprimidas por k-anon (k=5). Calcular ratePct con cells suprimidas
rompería la garantía de privacidad. La solución correcta requiere k-anonimizar num+den juntos,
lo cual está diferido a v2.

La escala divergente vs meta (complianceTarget) aplica **solo a nivel provincia** en v1.
A nivel localidad, ambas capas rate muestran count-density como las capas density.

Esto está documentado con comentarios en `repository.ts`.

---

## Natalidad: por qué NO es una señal de mapa

`registeredBirths` en `fetchReproductiveOutcomes` solo cuenta partos **rastreados** en el
sistema (eventos `clinical_info_logged` con `pregnancy_phase=ended` + `outcome=live_birth`).
Las crías callejeras y partos no registrados son invisibles → subestima sistemáticamente
la natalidad real.

Una capa de mapa de natalidad sería **direccional, no exacta**, y sin denominador poblacional
no es un ratio significativo a nivel territorial. La señal vive en `/gob/poblacion` como
indicador con caveat explícito. No se añade como capa del mapa.

---

## Paridad `sterilization_performed`

El loader de localidad `loadSterilizationCoverage` (count-density, nivel localidad v1) usa
el mismo predicado EXISTS que `fetchSterilizationCoverage`:

```sql
EXISTS (SELECT 1 FROM pet_events pe WHERE pe.pet_id = pets.id AND pe.event_type = 'sterilization_performed')
```

A nivel provincia, `loadSterilizationCoverageByProvince` llama directamente a
`fetchSterilizationCoverage(ctx)` — la paridad es trivial porque es el mismo código.
El tipo de evento `sterilization_performed` fue confirmado en `db/schema.ts` y
`app/actions/pregnancy.ts` durante la implementación del Paquete G.

## Paridad `rabies-coverage` a nivel provincia

`loadRabiesCoverageByProvince` llama a `fetchRabiesCoverageByProvince(ctx)` (nueva función
en `lib/govt-home-kpis.ts`), que espeja `fetchRabiesCoverage` exactamente:
- Mismo `dogsCondition` (species='dog' + scope via `dogsInScopeCondition`).
- Mismo `rabiesVaccConditions` (regex `antirr[áa]bica|rabies`, no ILIKE, para capturar las
  formas acentuadas del nombre canónico del biológico).
- Mismo período `since12m = ctx.period.since` (trailing 12m).
La única diferencia es el GROUP BY `pets.jurisdiction_province` en lugar del agregado nacional.

---

## Scope de v1

- [x] Capa `esterilizacion` (choropleth, rate, complianceTarget=70)
- [x] Preset `control-poblacional` (base=esterilizacion, province, 90d)
- [x] KPI esterilizacion en Panorama (paridad con /gob/poblacion)
- [x] Fix paridad cobertura: `loadRabiesCoverageByProvince` → `fetchRabiesCoverageByProvince` (dogs-based)
- [x] Fix paridad esterilizacion: `loadSterilizationCoverageByProvince` → `fetchSterilizationCoverage.byProvince` (active-pets)
- [x] Nueva `fetchRabiesCoverageByProvince` en `lib/govt-home-kpis.ts`
- [x] Eliminados: `rollupRatePerProvince`, `ProvinceRateRollupRow`, `ratePct`, `toProvinceRateChoroplethCells`, `rate-pct.test.ts`
- [ ] Rate-by-locality con k-anon'd num/den (deferred v2)
- [ ] Capa natalidad (no viable — datos incompletos)
