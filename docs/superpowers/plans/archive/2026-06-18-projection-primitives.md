# Projection primitives (`lib/metrics/`) — implementation plan

> Plan ejecutable para Claude Code. Item 0 del paquete metrics-IA. Crea la fundación `lib/metrics/`
> (ProjectionContext, scope/denominador único, **boundary k-anon que hoy NO existe**, period unificado,
> dedup) y migra los fetchers de dashboard existentes a consumirla. Refactor + un fix de privacidad.
>
> **Fecha:** 2026-06-18 · **Owner:** Ignacio Del Valle
> **Spec:** `docs/superpowers/specs/2026-06-18-projection-primitives-design.md` (gana el spec ante cualquier duda)
> **Tamaño:** ~6 archivos nuevos en `lib/metrics/`, ~3 archivos de fetchers tocados, 0 migraciones, 0 RLS
> **Estimación:** 2–3 días, 4 PRs (Fases 0.1→0.4)
> **Decisiones cerradas:** enforcement = branded `MetricResult` type (§4.4 del spec); period = se acepta el valor corregido. **Nada pendiente del dueño.**

## 0. Antes de tocar nada
1. Leé el spec (arriba) y `AGENTS.md → Aggregation & privacy policy` (la política k=5 que vas a implementar) + `AGENTS.md → Dashboards & projections`.
2. Leé los tres archivos que vas a migrar y sus tests:
   - `lib/govt-home-kpis.ts` (fetchers del panel `/gob`) + `__tests__/govt-home-kpis.test.ts`.
   - `lib/govt-dashboards.ts` (fetchers de `/gob/analytics`, perdidas, casos, etc.) + `__tests__/govt-dashboards.test.ts` + `__tests__/govt-dashboards-percapita.test.ts`.
   - `lib/admin-metrics.ts` (no agrupa por localidad; migración opcional de firma, sin suppression).
3. **Hechos verificados (no re-descubrir):**
   - `petsScopeClause` / `petEventsScopeClause` están **duplicados**: definidos en `lib/govt-dashboards.ts:598,609` **y** `lib/govt-home-kpis.ts:24,37`.
   - `DashboardActor` / `DashboardJurisdiction` también duplicados: `govt-dashboards.ts:48,50` **y** `govt-home-kpis.ts:14,15`.
   - Constantes de period hardcodeadas en `govt-home-kpis.ts`: `since12m`/`since30d`/`since60d`/`since7d`/`since24m` (líneas ~81,176,276,357…). `/gob/analytics` ya usa `resolveAnalyticsPeriod` (`lib/analytics-period.ts`).
   - **No existe** ningún `suppressSmallCells` ni código de k-anon (solo comentarios). Lo creás vos.
   - Los fetchers leen columnas **denormalizadas** (`pets.status`, `pets.species`) — eso es correcto y se documenta como invariante (D7 del spec), no se cambia.
4. Baseline verde: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Rojos pre-existentes → parar y avisar.

## 1. Qué construye este plan
La carpeta `lib/metrics/` como home del **Pattern B** (aggregate projections), y la migración incremental de los fetchers existentes a esa fundación, cerrando de paso el gap de k-anonimato.

## 2. Decisiones cerradas (del spec — no relitigar)
- Un solo `ProjectionContext { actor, scope, period }` por fetcher.
- Denominadores definidos una vez (`population.ts`).
- Supresión = **boundary obligatorio** vía branded type (no convención).
- Period unificado (home adopta `resolveAnalyticsPeriod`).
- Sin tabla materializada, sin cache cross-request, sin columna nueva, sin event types.

## 3. Scope
**Incluido:** `lib/metrics/*` + migración de `govt-home-kpis.ts` y los fetchers locality-grouped de `govt-dashboards.ts`. **Excluido:** nuevas métricas (son Items 2–4), `admin-metrics.ts` salvo alinear firma si es trivial.

## 4. Plan paso a paso

### Fase 0.1 — Construir `lib/metrics/` (1 PR, sin tocar fetchers)

**`lib/metrics/types.ts`** — el branded type que hace imposible olvidar la supresión:
```ts
declare const SUPPRESSED: unique symbol;
export type Cell = { key: string; count: number; [k: string]: unknown };
/** Solo construible por suppressSmallCells. Un Cell[] crudo NO es asignable. */
export type SuppressedCells = readonly Cell[] & { readonly [SUPPRESSED]: true };
export type MetricResult<T> = { value: T; suppressedCount: number };
```

**`lib/metrics/context.ts`** — mover acá (y borrar de los otros 2 archivos) `DashboardActor`, `DashboardJurisdiction`; agregar:
```ts
export type ProjectionScope =
  | { kind: "global" }
  | { kind: "jurisdictions"; jurisdictions: DashboardJurisdiction[] };
export type ProjectionContext = { actor: DashboardActor; scope: ProjectionScope; period: ResolvedPeriod };
export function buildProjectionContext(actor, jurisdictions, period): ProjectionContext;
/** clave estable para React.cache (serializa scope+period) */
export function ctxKey(ctx: ProjectionContext): string;
```

**`lib/metrics/scope.ts`** — la versión **única** de `petsScopeClause(ctx)` / `petEventsScopeClause(ctx)` (lee `ctx.scope`; arma el predicado de jurisdicción **una sola vez**). Mantené el comportamiento idéntico al actual (govt sin jurisdicciones → clause que no matchea nada / early-return en el fetcher).

**`lib/metrics/population.ts`** — denominadores únicos como fragmentos SQL componibles:
```ts
export function activePets(ctx): SQL;          // status IN ('active','lost') + scope
export function dogsInScope(ctx): SQL;         // activePets + species='dog'
export function petEventsInScope(ctx, eventType?, window?): SQL;
```

**`lib/metrics/anonymity.ts`** — el boundary:
```ts
export function suppressSmallCells(rows, opts: {
  count:(r)=>number; key:(r)=>string; k?:number; rollup?:(suppressed)=>Cell|null;
}): { visible: SuppressedCells; suppressed: Cell[]; suppressedCount: number };
```
Default `k=5`: dropea celdas `< k`; con `rollup`, las pliega a la jurisdicción más gruesa.

**`lib/metrics/period.ts`** — re-exporta `resolveAnalyticsPeriod` + ventanas nombradas (`TRAILING_12M`, `TRAILING_30D`, `TRAILING_7D`, …). Las ventanas clínicas legales (p. ej. 10 días de observación) son constantes de dominio aparte, NO ventanas de reporte.

**`lib/metrics/index.ts`** — barrel.

**`lib/metrics/cache.ts`** (o dentro de population) — wrappers `React.cache` para `activePets`/`dogsInScope` con `ctxKey` como surrogate, para dedup intra-request.

**Tests de Fase 0.1** (`lib/metrics/anonymity.test.ts`, `period.test.ts`, `__tests__/metrics-scope.test.ts`): celdas `<k`/`≥k`, rollup, ventanas, scope (excluye fallecidos y fuera-de-jurisdicción; global incluye todo). Ver §5 del spec.

### Fase 0.2 — Migrar `govt-home-kpis.ts` (1 PR)
Por cada fetcher (`fetchRabiesCoverage`, `fetchSterilizationMetrics`, `fetchBitesPer10k`, `fetchActiveZoonosis`, `fetchOpenWelfareReportsCount`):
1. **Pin primero:** agregá/confirmá en `govt-home-kpis.test.ts` un test que fija el valor con seed actual.
2. Cambiá la firma a `(ctx: ProjectionContext)`; reemplazá el `petsScopeClause`/`petEventsScopeClause` local y el predicado inline de jurisdicción por los de `scope.ts`; reemplazá el denominador inline por `activePets(ctx)`/`dogsInScope(ctx)`.
3. Reemplazá las constantes `sinceNNN` por `ctx.period` (o la ventana nombrada si el panel muestra a propósito una ventana fija trailing — documentá el caso).
4. Si el fetcher agrupa por localidad, pasá el resultado por `suppressSmallCells`.
5. Verde + pin sin cambios para celdas `≥k`; agregá un test de que una localidad `<5` ahora se suprime (fix intencional).
6. Actualizá los callers (`app/gob/page.tsx`) para construir `ctx` una vez con `buildProjectionContext(actor, jurisdictions, period)` y pasarlo a todos los KPIs (habilita el dedup).

### Fase 0.3 — Migrar los locality-grouped de `govt-dashboards.ts` (1 PR)
Foco en los que pueden filtrar celdas chicas: `fetchCasesPerLocality`, `fetchCasesPerCapita`, `fetchPerdidasMetrics`, `fetchAnalyticsMetrics`, `fetchDeathCauses`, `fetchZoonosisTrend` (los que devuelven filas por localidad). Mismo loop: pin → ctx + scope/denominador compartido → `suppressSmallCells` → verde. **Borrá** las definiciones duplicadas de `petsScopeClause`/`petEventsScopeClause` y de `DashboardActor`/`DashboardJurisdiction` de este archivo (ya viven en `lib/metrics/`).

### Fase 0.4 — Docs + enforcement (1 PR)
- `docs/architecture/hexagonal-lite.md`: sección nueva bendiciendo **Pattern B** (`lib/metrics/`, el contrato `ProjectionContext`, el boundary obligatorio, e invariante D7 columnas denormalizadas = autoritativas para agregados).
- `AGENTS.md → Aggregation & privacy policy`: "k-anonymity ... **enforced by `lib/metrics/anonymity.ts`**; todo fetcher agrupado por localidad pasa por `suppressSmallCells`."
- `AGENTS.md → Dashboards & projections`: nota "todos los fetchers consumen `ProjectionContext`".
- Confirmá el enforcement branded-type: que un fetcher locality-grouped que devuelva `Cell[]` crudo **no typechequee** (test de tipo o ejemplo comentado).
- Flippeá la fila de Item 0 en `docs/superpowers/README.md` (✅ + SHA).

## 5. Verificación final
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes.
- Grep: `petsScopeClause`/`petEventsScopeClause`/`DashboardActor` definidos **una sola vez** (en `lib/metrics/`).
- Un PR de prueba que intente devolver `Cell[]` sin suprimir **rompe el typecheck** (evidencia del boundary).

## 6. Casos borde
- Govt sin jurisdicciones asignadas: mismo early-return/empty que hoy (no romper).
- Fetchers no-locality (totales): no pasan por `suppressSmallCells`, pero sí por `ctx`/denominador compartido.
- `admin-metrics.ts`: si alinear la firma a `ctx` es trivial, hacelo; si no, dejalo (no agrupa por localidad, sin riesgo de privacidad).

## 7. Cuando termines
Item 0 desbloquea Items 2/3/4 (construyen sobre `lib/metrics/`). Avisá que la fundación está lista; ellos NO deben reintroducir helpers de anonimato/scope ad-hoc.

## 8. Lo que viene después (no en este plan)
Sin cache cross-request ni rollups materializados (deferred hasta que el volumen real lo justifique, umbrella §6).
