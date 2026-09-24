# Govt dashboards — plan ejecutable (Chunk E)

> **Fecha:** 2026-05-21
> **Owner:** Ignacio Del Valle
> **Audiencia:** Claude Code (input directo)
> **Estimación:** ~6–7 días (E0 incluido en este doc)
> **Origen:** `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` §Chunk E
> **Design spec:** `dim-interno:docs/design/04-govt-dashboards.md`
> **Decisiones cerradas:** `docs/superpowers/plans/2026-05-21-pending-decisions-resolved.md` §Chunk E + §CX-1

---

## Resumen ejecutivo

Chunk E construye los dashboards gubernamentales sobre el esqueleto existente de `/gob`. Entrega cinco componentes compartidos (`<MetricCard>`, `<MapChoropleth>`, `<TimeSeriesChart>`, `<JurisdictionSwitcher>`, `<PeriodPicker>`), enriquece tres dashboards existentes (`/gob/vigilancia`, `/gob/perdidas`, `/gob/maltrato`) con métricas, mapa coroplético y controles de período, crea `/gob/analytics` como superficie nueva para public-health analysts, y agrega un endpoint de export async con anonimización Ley 25.326 (spec §B.7). Todo el acceso es scope-bound por `govt_assignments` del usuario; admin ve alcance universal. El chunk depende de las primitivas de PR #93 (Chunk A.5) ya mergeadas: `<Badge>`, `<Panel>`, `<EmptyState>`, `<Tabs>`, `<Alert>`, `<DateRangePicker>`.

---

## Decisiones cerradas (copia verbatim del owner)

### E-D1. Map tiles — defer ARSAT, use the easiest path

**Q:** ARSAT (per spec) o OpenStreetMap fallback para `<MapChoropleth>` tiles?
**A:** Defer ARSAT; owner will add it to the research document. Use the easiest available option for v1.
**Implications:**
- v1 uses **OpenStreetMap** raster tiles via the default MapLibre demo style (`https://demotiles.maplibre.org/style.json`) OR a public OSM tile provider with attribution. CC picks the lowest-friction option that doesn't require an API key.
- Required attribution: `"© OpenStreetMap contributors"` shown in the map's lower-right corner per OSM tile usage policy.
- Add a comment in `components/poncho/MapChoropleth.tsx` flagging the tile source as a v1 placeholder, with a TODO pointing at the (forthcoming) research doc.
- **Owner follow-up:** create / update the research doc where ARSAT specifics live. Not a CC blocker.

### E-D2. Recharts — keep current pinned version

**Q:** Keep current pinned version or upgrade before E1?
**A:** Keep current pinned version.
**Implications:**
- CC must NOT run `pnpm up recharts` during Chunk E.
- If the pinned version lacks a feature the spec needs, CC documents the limitation in the plan and either works around it OR raises it as a follow-up — does not upgrade unilaterally.

> **Verificación E0:** `recharts` NO está instalado en `package.json`. Se instala como nueva dependencia en el pre-flight de E1 (ver §Dependencias técnicas). La decisión de no-upgrade aplica a futuras actualizaciones, no al install inicial.

### E-D3. Anonymization library for `/gob/analytics/export` — library OK if secure & fast

**Q:** Roll-our-own field-drop or use a library?
**A:** Use a library, provided it's secure and fast.
**Implications:**
- **Preferred:** define a Zod schema per export slice (`pets`, `events`, `cases`, `organizations`) listing ONLY the fields that ship. El pipeline parsea cada fila a través del schema, descartando todo lo que no está en la whitelist. Esto es "library-backed" via Zod (ya en el árbol de dependencias) sin agregar una dependencia nueva.
- **If a dedicated library is preferred:** considerar `@faker-js/faker` para surrogate generation y `nanoid` para identificadores opacos. Evitar librerías de PII-detection — apuntan a texto no estructurado, fuera de scope.
- La decisión debe documentarse en el plan ejecutable con rationale.
- Audit log row per export records which schema version was used.

### E-D4. `<Badge>` shape confirmed

**Q:** Confirm "pill with optional icon + variant prop" (variants: `info | success | warning | danger | neutral`)?
**A:** Confirmed.
**Implications:**
- `components/poncho/Badge.tsx` API: `variant`, `icon`, `children`, `aria-label`. Visual: `rounded-full px-2.5 py-0.5 text-xs font-medium`. Pulse animation vive SOLO en el consumer.
- Built in Chunk C per C-D1; Chunk E reuses without modification.

✅ Shippeada en PR #93 (Chunk A.5). No se re-implementa — se importa.

### Primitivas de PR #93 (Chunk A.5) consumidas por Chunk E

| Primitiva | Usado en |
|---|---|
| `<Badge>` | E1 `<MetricCard>` variant indicator; E2 "Lab-confirmado" pill en signals |
| `<Panel>` / `<PanelHeader>` / `<PanelBody>` | E1-E5 todos los paneles de dashboard |
| `<EmptyState>` | E2 sin signals, E3 sin episodios, E4 queue vacía, E5 sin permisos |
| `<Alert>` | E6 aviso de anonimización Ley 25.326 en la export form |
| `<Tabs>` | E4 `/gob/maltrato` queues (urgent / mine / all / overdue) |
| `<DateRangePicker>` | E6 `/gob/analytics/export` form campo "Período" |

---

## Hallazgos de implementación

### Estado actual de /gob

| Ruta existente | Estado actual | Enriquecimiento en Chunk E | Fase |
|---|---|---|---|
| `/gob` | Muestra pending approvals + recent decisions + 2 cards de preview | Refactor router: redirige por capability; `<DefaultGobHome>` con links a todas las secciones | E2 (touch mínimo dentro del E2 PR) |
| `/gob/vigilancia` | Lista plana de `outbreak_signal` con filtros de días y enfermedad; `<DiseaseSummaryTable>` + `<SurveillanceFiltersBar>` | Agregar `<MetricCard>` row, `<MapChoropleth>`, `<TimeSeriesChart>` de enfermedades, `<JurisdictionSwitcher>`, `<PeriodPicker>`, drill-down brotes/zoonosis (spec §B.2) | E2 |
| `/gob/perdidas` | Lista plana de lost pets con filtros días/especie | Agregar 3× `<MetricCard>`, `<MapChoropleth metric="lost_episodes">`, mejorar lista con foto+token (spec §B.3) | E3 |
| `/gob/maltrato` | Queue con filtros status/kind/severity + chips de estado | Agregar 4× `<MetricCard>`, `<Tabs>` (urgent/mine/all/overdue), `<WelfareDenunciaRow>` reemplazando `<li>` plano (spec §B.4) | E4 |
| `/gob/maltrato/[id]` | Ya existe (258 líneas): auth guard, attachments + signed URLs, `<LocationMap>` dynamic, `<TriageActions>`, status tone map | Enriquecer: breadcrumb, MetricCards de resumen, `<Timeline>` de eventos del caso, sección de normativa (spec §B.5). Preservar `<TriageActions>` intacto | E4 |
| `/gob/dashboard-v2` | Preview parkeado del design-refresh stream | Ver decisión abajo | — |
| `/gob/analytics` | No existe | Crear completo: 4× MetricCard, TimeSeriesChart, MapChoropleth, tabla brotes históricos (spec §B.6) | E5 |
| `/gob/analytics/export` | No existe | Crear form + async export endpoint (spec §B.7) | E6 |

### Relación con dashboard-v2 (design-refresh stream)

`/gob/dashboard-v2` (`app/gob/dashboard-v2/page.tsx`) es una preview aislada con datos hardcodeados y componentes propios (`<GobDashboardShell>`, `<KpiTile>`, `<JurisdictionFilterBar>`). Tiene el mapa marcado como "pendiente Fase 2 (MapLibre)" y las "Denuncias ciudadanas" hardcodeadas con datos de muestra. El archivo mismo documenta en el encabezado que debe "retirarse en favor de editar `app/gob/page.tsx` directamente" cuando se conecten queries reales.

**Decisión: mantener dashboard-v2 intacto durante Chunk E, sin migrar ni eliminar.** Justificación: (a) está explícitamente parkeado como preview-only en el commit `ec91354` ("park 2026-05-20 design-refresh stream as preview routes"); (b) sus componentes propios (`<GobDashboardShell>`, `<KpiTile>`) no se solapan funcionalmente con los nuevos primitivos de E1 — están en el diseño visual del "Fase 1 redesign", que puede activarse en una fase separada; (c) E5 (`/gob/analytics`) es una ruta nueva sin overlap con `dashboard-v2` (que remplazaría `/gob`, no `/gob/analytics`). La migración de dashboard-v2 → `/gob` pertenece a un futuro Chunk visual; está fuera del scope de Chunk E.

### Schema gaps

1. **Fetchers para métricas nuevas no existen en `lib/govt-dashboards.ts`.** El archivo actual tiene `fetchSurveillanceSignals`, `fetchDiseaseSummary` y `fetchLostPets`. Chunk E necesita agregar: `fetchVigilanciaMetrics` (MetricCards), `fetchPerdidasMetrics`, `fetchWelfareMetrics`, `fetchAnalyticsMetrics`, `fetchAcquisitionTrend`, `fetchDeathCauses`, `fetchOutbreakHistory`.

2. **`cases` tabla existe** (schema.ts línea 2414) con `jurisdictionProvince` y `jurisdictionLocality`. El scope-bound por `govt_assignments` puede replicar el mismo patrón de `fetchLostPets` (filtro post-fetch por locality).

3. **No hay columna de choropleth en ninguna tabla.** `<MapChoropleth>` recibe datos como prop; el fetcher computa el conteo por locality y lo pasa. No se necesita columna nueva — solo un nuevo fetcher que agrupe por `(jurisdictionProvince, jurisdictionLocality)`.

4. **`welfare_reports` no tiene `assignedToUserId`.** La spec (§B.4) muestra `assignedTo` avatar. La columna no existe en el schema actual. El E4 puede sortear esto con un evento de tipo `assignment_changed` en `cases` (linked via `welfareReportId`). **Decisión: TBD durante E4** — verificar si hay evento de asignación o si se necesita una migración. Flag como ambigüedad abajo.

5. **GeoJSON de INDEC para choropleth.** El mapa necesita un GeoJSON de localidades/provincias para colorear regiones. No existe en el repo. La estrategia v1: usar un GeoJSON estático público de Argentina (provincias INDEC) bundleado en `public/geo/ar-provinces.geojson`. Las localidades son demasiado granulares para v1 — el choropleth opera a nivel provincia inicialmente.

### Dependencias técnicas

| Paquete | Estado | Acción en E1 |
|---|---|---|
| `maplibre-gl` | ✅ instalado — `^5.24.0` en `package.json` | Ninguna |
| `recharts` | ❌ NO instalado | `pnpm add recharts` en pre-flight E1. Pinear la versión instalada; no upgradear. |

---

## Pre-work (E0) — completado al escribir este doc

- [x] Design spec (`dim-interno:docs/design/04-govt-dashboards.md`) leída y resumida.
- [x] Decisiones E-D1..E-D4 copiadas verbatim del owner.
- [x] Primitivas PR #93 confirmadas disponibles (8 componentes en `components/poncho/`).
- [x] Estado de /gob mapeado (6 rutas existentes analizadas).
- [x] `dashboard-v2` investigado — decisión: mantener parkeado, NO migrar en Chunk E.
- [x] Schema gaps identificados (5 ítems).
- [x] `maplibre-gl@^5.24.0` ya instalado; `recharts` ausente → instalar en E1 pre-flight.
- [ ] Próximo paso: ejecutar E1.

---

## E1 — Shared components (~1.5d)

### Pre-flight E1

```bash
pnpm add recharts
# Verificar versión instalada; anotar en este doc. No correr `pnpm up recharts`.
```

Agregar GeoJSON estático: descargar `ar-provinces.geojson` de fuente INDEC pública y colocar en `public/geo/ar-provinces.geojson`.

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `components/poncho/MetricCard.tsx` | NEW | KPI tile — spec §A.1 |
| `components/poncho/MapChoropleth.tsx` | NEW | Mapa coroplético OSM via MapLibre — spec §A.2, E-D1 |
| `components/poncho/TimeSeriesChart.tsx` | NEW | Recharts line/area/bar wrapper — spec §A.4 |
| `components/poncho/JurisdictionSwitcher.tsx` | NEW | Selector de jurisdicción del usuario — spec §A.5 |
| `components/poncho/PeriodPicker.tsx` | NEW | Selector de período 7d/30d/90d/custom — spec §C.2 |
| `components/poncho/CaseListItem.tsx` | NEW | Item en feeds de casos — spec §A.3 |
| `components/poncho/index.ts` | MODIFY | Exportar los 6 componentes nuevos |
| `app/(app)/design/dashboards/page.tsx` | NEW | Showcase visual de todos los componentes E1 |
| `public/geo/ar-provinces.geojson` | NEW | GeoJSON estático de provincias INDEC |

### Per-component briefs

#### `<MetricCard>` — spec §A.1

Props según spec §A.1: `label`, `value`, `delta`, `deltaIntent`, `sparkline`, `variant`, `href`.

| Variant | Uso | Color principal |
|---|---|---|
| `default` | Métrica normal | Gris neutro |
| `success` | Trending positivo | `--color-gob-success` |
| `warning` | Requiere atención | `--color-gob-warning` |
| `danger` | Crítico | `--color-gob-danger` |

Layout: `<a>` cuando `href` existe, `<article>` cuando no. Label conectado al valor via `aria-describedby`. Sparkline tiene `role="img"` con `<title>` describiendo la tendencia. Estado loading: skeleton 60×24 + 100×40 + 100×16. Estado error: "—" con tooltip. Estado empty (value 0): "0" + helper text "Nada que reportar — buen signo" (spec §A.1).

Sparkline: mini `<svg>` de 100×24px con 7 puntos. Si `recharts` no tiene una variante micro adecuada, implementar como SVG path inline (el wrapper recharts puede ser excesivo para 7 puntos).

#### `<MapChoropleth>` — spec §A.2, E-D1

Props: `level: 'province' | 'locality'`, `parent?: string`, `metric`, `period`, `onSelect?`.

Tile source v1: `https://demotiles.maplibre.org/style.json` (sin API key). Atribución OSM en lower-right — OBLIGATORIO per E-D1.

```ts
// v1 placeholder — tile source is OSM via MapLibre demo style.
// TODO: swap for ARSAT tiles per OF-1 (owner follow-up, research doc TBD).
const TILE_STYLE = "https://demotiles.maplibre.org/style.json";
```

GeoJSON cargado desde `public/geo/ar-provinces.geojson`. Layer de choropleth: `fill` con expresión de color por `feature.properties.id → metricValue → color scale` (spec §A.2 color scale table).

Accesibilidad: `role="img"` + `<title>` + `<desc>` con hotspots. Alternativa textual: `<details><summary>Ver datos en tabla</summary><table>` (spec §E).

Estado loading: skeleton container con spinner. Sin datos: color neutro + tooltip "Sin datos".

Client component obligatorio (MapLibre requiere DOM).

#### `<TimeSeriesChart>` — spec §A.4

Wrapper de Recharts. Props: `data`, `series` (max 4), `type: 'line' | 'area' | 'bar'`, `xAxisFormat`, `yAxisLabel?`, `height` (280 default).

Colors: mapear `'primary' | 'celeste' | 'danger' | 'success'` a los tokens `--color-gob-*` existentes.

Accesibilidad: `<details><summary>Ver datos</summary><table>` con los datos numéricos (spec §A.4 + §E). `prefers-reduced-motion`: desactivar animaciones via `isAnimationActive={false}` cuando `window.matchMedia('(prefers-reduced-motion: reduce)').matches`.

Client component (Recharts requiere DOM).

#### `<JurisdictionSwitcher>` — spec §A.5

Combobox que cambia `?jurisdiction=` en los searchParams. Muestra las `govt_assignments` activas del usuario. Si `role === 'admin'`, agrega opción "Vista universal".

Props: `assignments: Array<{ province: string; locality: string }>`, `currentJurisdiction?: string`.

Implementar como Server Action que hace `router.replace()` con el nuevo jurisdiction param. El componente es Client component (interactivo).

#### `<PeriodPicker>` — spec §C.2

Presets: 7d / 30d / 90d / 12m / custom. Default 30d. Persiste en searchParams (`?period=7d|30d|90d|12m|custom&from=YYYY-MM-DD&to=YYYY-MM-DD`).

Custom option: abre `<DateRangePicker>` de PR #93 en un popover.

`aria-label` por opción (spec §E). Client component.

#### `<CaseListItem>` — spec §A.3

Layout per spec §A.3: `<CaseBadge>` + subject line + meta line (jurisdicción, fechas) + severity pill + chevron + N eventos. Reutiliza el `<CaseBadge>` existente.

### Tests — E1

No hay jsdom ni `@testing-library` en el repo (misma restricción que Chunk C). Los tests de E1 cubren helpers puros:

- `__tests__/choropleth-color-scale.test.ts` — función `getColorForMetricValue(metric, value, max)` retorna el hex correcto per escala (spec §A.2).
- Verificación visual manual: showcase en `/design/dashboards` cubre todas las variantes de los 5 componentes principales.

### DoD — E1

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` scoped a `components/poncho/` clean.
- [ ] Showcase `/design/dashboards` renderiza `<MetricCard>` (4 variantes), `<MapChoropleth>` (skeleton + cargado), `<TimeSeriesChart>` (line, area, bar), `<JurisdictionSwitcher>`, `<PeriodPicker>`.
- [ ] Atribución OSM visible en `<MapChoropleth>`.
- [ ] `prefers-reduced-motion: reduce` desactiva animaciones en `<TimeSeriesChart>`.
- [ ] `<MetricCard>` con `href` renderiza como `<a>` con cursor pointer; sin `href` como `<article>`.
- [ ] `recharts` instalado y pinned en `package.json`.
- [ ] `public/geo/ar-provinces.geojson` presente.

---

## E2 — `/gob/vigilancia` enriched (~1d)

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `app/gob/vigilancia/page.tsx` | MODIFY | Reemplazar layout plano con spec §B.2 completo |
| `app/gob/vigilancia/_components/DiseaseSummaryTable.tsx` | KEEP | Mantener — integrar en `<Panel>` |
| `app/gob/vigilancia/_components/SurveillanceFiltersBar.tsx` | MODIFY | Reemplazar con `<JurisdictionSwitcher>` + `<PeriodPicker>` |
| `app/gob/vigilancia/_components/OutbreakSignalRow.tsx` | NEW | Row para el panel de signals recientes |
| `app/gob/vigilancia/brotes/page.tsx` | NEW | Drill-down outbreak signals — spec §B.2 sub + sitemap |
| `app/gob/vigilancia/zoonosis/page.tsx` | NEW | Surveillance reportable diseases — spec sitemap |
| `lib/govt-dashboards.ts` | MODIFY | Agregar `fetchVigilanciaMetrics()` |
| `app/gob/page.tsx` | MODIFY | Tocar mínimo: agregar link a `/gob/vigilancia` con capability guard |

### Spec mapping — E2

| Spec §B.2 elemento | Implementación |
|---|---|
| 4× `<MetricCard>` row (brotes, rábicas, pets hoy, vacunaciones semana) | `fetchVigilanciaMetrics()` en `lib/govt-dashboards.ts` |
| `<MapChoropleth metric="cases_open">` | Nuevo fetcher `fetchCasesPerLocality()` agrupando `cases` por `(jurisdictionProvince, jurisdictionLocality)` |
| Panel outbreak signals recientes (top 5) | `fetchSurveillanceSignals` existente + nuevo `<OutbreakSignalRow>` |
| `<EmptyState>` sin signals | `<EmptyState icon="shield-check" title="Sin signals activos">` de PR #93 |
| `<TimeSeriesChart>` enfermedades reportables | `fetchZoonosisTrend()` nuevo: agrupa signals por `(disease_code, date)` |
| Tabla observaciones rábicas en curso | Query sobre `cases WHERE caseKind='rabies_observation' AND status='open'` |
| Drill-down `/gob/vigilancia/brotes` | Lista paginada de signals con filtros avanzados |
| Drill-down `/gob/vigilancia/zoonosis` | Resumen por enfermedad (usa `fetchDiseaseSummary` existente) |

### Tests — E2

- `__tests__/govt-dashboards.test.ts` (extender archivo si existe, o crear):
  - `fetchVigilanciaMetrics`: retorna `{ outbreakActiveCount, rabiesActiveCount, petsRegisteredToday, vaccinationsThisWeek }`.
  - Scope de govt: usuario con asignación CABA/Palermo no ve signals de La Plata.
  - `fetchZoonosisTrend`: agrupa correctamente por disease_code y fecha.

### DoD — E2

- [ ] `pnpm typecheck` + `pnpm lint` clean.
- [ ] `/gob/vigilancia` muestra 4× MetricCard + mapa + panel signals + chart.
- [ ] `<EmptyState>` correcto cuando no hay signals en el período.
- [ ] `/gob/vigilancia/brotes` y `/gob/vigilancia/zoonosis` cargan sin error 404.
- [ ] Govt user con asignación CABA no ve signals de otras provincias (RLS smoke).
- [ ] Tests de `fetchVigilanciaMetrics` y `fetchZoonosisTrend` pasan.

---

## E3 — `/gob/perdidas` enriched (~0.75d)

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `app/gob/perdidas/page.tsx` | MODIFY | Agregar MetricCards + MapChoropleth; mejorar lista |
| `app/gob/perdidas/_components/LostFiltersBar.tsx` | MODIFY | Extender con `<JurisdictionSwitcher>` |
| `app/gob/perdidas/_components/LostPetRow.tsx` | NEW | Row mejorado con foto + chip de especie + "Ver caso" |
| `lib/govt-dashboards.ts` | MODIFY | Agregar `fetchPerdidasMetrics()` |

### Spec mapping — E3

| Spec §B.3 elemento | Implementación |
|---|---|
| 3× `<MetricCard>` (activos, recuperados mes, antigüedad promedio) | `fetchPerdidasMetrics()` nuevo |
| `<MapChoropleth metric="lost_episodes">` | `fetchLostPets` existente + agrupar por locality |
| Listado con filtros species / status / search | Extender `fetchLostPets` con `status` y `search` params |
| `<EmptyState>` sin episodios | "No hay episodios activos..." (spec §C.1) |

`fetchPerdidasMetrics()` computa sobre `fetchLostPets` existente:
- `activeCount`: total de pets en status='lost' en scope.
- `recoveredMonth`: pets que pasaron de 'lost' a otro status en los últimos 30d (query sobre `status_changed` events).
- `avgDays`: promedio de `now - markedLostAt` para activos.

### Tests — E3

- `fetchPerdidasMetrics`: `recoveredMonth` no incluye pets que siguen perdidos.
- `fetchPerdidasMetrics`: scope correcto (govt no ve otras jurisdicciones).

### DoD — E3

- [ ] `pnpm typecheck` clean.
- [ ] 3× MetricCard visible en `/gob/perdidas`.
- [ ] `<MapChoropleth>` carga sin error (puede estar en skeleton si no hay geo data).
- [ ] Lista mejorada con `<LostPetRow>` componente.
- [ ] `<EmptyState>` correcto.
- [ ] Tests de `fetchPerdidasMetrics` pasan.

---

## E4 — `/gob/maltrato` enriched (~1d)

E4 toca tanto la lista (`/gob/maltrato`) como el detalle (`/gob/maltrato/[id]`, que ya existe con triage + attachments + LocationMap). La ruta usa UUID como segmento (`/gob/maltrato/${r.id}`) — **no cambiar la ruta sin migrar los links existentes**; usar `referenceCode` como display label dentro del detalle si conviene más legible.

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `app/gob/maltrato/page.tsx` | MODIFY | Agregar 4× MetricCard + `<Tabs>` de PR #93 |
| `app/gob/maltrato/_components/WelfareDenunciaRow.tsx` | NEW | Row rico: CaseBadge + severity pill + locality + chevron (spec §B.4) |
| `app/gob/maltrato/[id]/page.tsx` | MODIFY | Enriquecer detalle existente: breadcrumb, MetricCards de resumen, sección normativa, integrar `<Timeline>`. Preservar `<TriageActions>` + `<LocationMap>` |
| `app/gob/maltrato/[id]/Timeline.tsx` | NEW | Timeline de eventos del caso (spec §B.5) |
| `lib/govt-dashboards.ts` | MODIFY | Agregar `fetchWelfareMetrics()` |
| `lib/welfare-actions.ts` | NEW (o extender existente) | Server actions: registrar visita, asignarse caso, cerrar caso |

### Spec mapping — E4

| Spec §B.4/B.5 elemento | Implementación |
|---|---|
| 4× MetricCard (sin asignar, mías, en investigación, cerradas mes) | `fetchWelfareMetrics()` sobre `welfare_reports` |
| `<Tabs>` (urgent/mine/all/overdue) | `<Tabs>` de PR #93 + `?queue=` searchParam |
| `<WelfareDenunciaRow>` con severity pill | Usa `<Badge>` de PR #93 para severity |
| `[id]` — resumen, eventos, acciones, asignación, mascota, normativa | Query `welfare_reports` + `cases` linked via `welfareReportId` |
| `<Timeline>` de eventos | Query `cases` events por `caseId` |

**Ambigüedad E4 — `assignedToUserId`:** La tabla `welfare_reports` no tiene columna de asignación en el schema. El panel "Asignación" de spec §B.5 muestra un avatar del `assignedTo` user. Resolución temporal: derivar asignación del último evento `assignment_changed` en `cases` (linked via `cases.welfareReportId`). Si `cases` no tiene ese event type, agregar migración en E4 con columna `assigned_to_user_id` en `welfare_reports`. TBD al inicio de E4.

### Tests — E4

- `fetchWelfareMetrics`: `unassignedCount` correcto para scope de govt.
- `fetchWelfareMetrics`: `closedMonth` cuenta solo casos cerrados en los últimos 30d.
- Scope: govt user ve solo welfare_reports de su jurisdicción.

### DoD — E4

- [ ] `pnpm typecheck` clean.
- [ ] 4× MetricCard visible en `/gob/maltrato`.
- [ ] `<Tabs>` persiste `?queue=` en URL.
- [ ] `/gob/maltrato/[uuid]` carga sin 404 para un `id` válido.
- [ ] `<Timeline>` renderiza eventos vacíos sin crash.
- [ ] Server actions de "Asignármela" y "Cerrar caso" tienen typecheck clean.
- [ ] Tests de `fetchWelfareMetrics` pasan.

---

## E5 — `/gob/analytics` net-new (~1d)

### Relación con dashboard-v2

Ver §Hallazgos: `dashboard-v2` queda parkeado. E5 crea `/gob/analytics` como ruta nueva completamente independiente.

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `app/gob/analytics/page.tsx` | NEW | Dashboard analyst: 4× MetricCard + acquisition chart + mapa población + death causes + brotes históricos (spec §B.6) |
| `app/gob/analytics/_components/AcquisitionChart.tsx` | NEW | `<TimeSeriesChart>` wrapper para acquisition method (spec §B.6) |
| `app/gob/analytics/_components/OutbreakHistoryTable.tsx` | NEW | Tabla de brotes históricos (spec §B.6) |
| `lib/govt-dashboards.ts` | MODIFY | Agregar `fetchAnalyticsMetrics()`, `fetchAcquisitionTrend()`, `fetchDeathCauses()`, `fetchOutbreakHistory()` |
| `middleware.ts` (o guard en page) | MODIFY | Guard de `analytics.read` capability |

### Spec mapping — E5

| Spec §B.6 elemento | Implementación |
|---|---|
| 4× MetricCard (pets totales, tasa adopción, vacunación antirrábica %, custody disputes) | `fetchAnalyticsMetrics()` |
| Acquisition method `<TimeSeriesChart type="area">` | `fetchAcquisitionTrend()`: agrupa `pet_events WHERE eventType='pet_acquired'` por `(acquisition_method, month)` |
| `<MapChoropleth metric="pets_per_capita">` | TBD durante E5 — requiere datos de población; usar pets por locality como proxy si no hay población |
| Top causas de muerte bar chart | `fetchDeathCauses()`: agrupa `pet_events WHERE eventType='death_recorded'` por `cause` |
| Tabla brotes históricos | `fetchOutbreakHistory()`: agrupa signals por `(disease_code, locality, peak_date)` |

**Anonymization per E-D3:** El botón "Exportar CSV" en el panel de acquisition method (spec §B.6) linkea a `/gob/analytics/export` (E6). La page E5 NO maneja el export directamente.

Capability guard: verificar `hasCapability('analytics.read')` en el server component. Si no tiene la capability: `<EmptyState icon="lock" title="Sin acceso" description="Tu rol no tiene acceso a analytics. Pedile al admin que te asigne la capability.">` (spec §C.1).

### Tests — E5

- `fetchAnalyticsMetrics`: `rabiesVaccinationRate` calculado como `(pets con rabia en libreta / pets totales) * 100`.
- `fetchAcquisitionTrend`: agrupa por mes correctamente; no incluye rows sin `acquisition_method`.
- `fetchDeathCauses`: scope-bound por jurisdicción del actor.
- `fetchOutbreakHistory`: `peakDate` es el día de mayor cantidad de signals.

### DoD — E5

- [ ] `pnpm typecheck` clean.
- [ ] `/gob/analytics` sin `analytics.read` muestra `<EmptyState>` con CTA correcto.
- [ ] Con `analytics.read`: 4× MetricCard + chart + mapa + death causes + tabla brotes.
- [ ] `<PeriodPicker>` persiste en searchParams.
- [ ] Tests de los 4 fetchers pasan.

---

## E6 — Async export endpoint (~0.75d)

### Diseño del endpoint

Spec §B.7: form en `/gob/analytics/export` → server action → genera CSV → guarda en Supabase Storage privado → dispara email con signed URL (24h TTL).

**Decisión sobre queue mechanism:** usar **fire-and-forget via server action con Supabase Storage + Resend email**. Justificación: el volumen esperado (un export por sesión de analyst) no justifica una job table con worker. El server action genera el archivo síncronamente en el request (con timeout generoso de Edge Function o Route Handler). Si supera el timeout, se puede migrar a Postgres job table en v2. Esta decisión se documenta en el código con un comentario `// v1: sync generation. v2: add job table if timeout is hit at scale.`

**Anonymization (E-D3 — Zod schema per export slice):**

```ts
// lib/govt-exports.ts
export const petsExportSchema = z.object({
  publicToken: z.string(),   // opaque identifier (no name)
  species: z.string(),
  acquisitionMethod: z.string().optional(),
  jurisdictionProvince: z.string().optional(),
  jurisdictionLocality: z.string().optional(),
  // INTENTIONALLY OMITTED: name, ownerId, ownerDisplayName, microchipNumber, DNI
});

export const eventsExportSchema = z.object({
  petPublicToken: z.string(),
  eventType: z.string(),
  occurredAt: z.string(), // ISO date
  // OMITTED: performedByUserId, locationLat, locationLng (privacy)
});

// Idem para casesExportSchema, organizationsExportSchema
```

Cada row del export pasa por `schema.parse(rawRow)` — Zod descarta silenciosamente los campos no declarados. El audit log registra `{ schema_version: "2026-05-21", includes: [...] }`.

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `app/gob/analytics/export/page.tsx` | NEW | Form: período, jurisdicción, datos (checkboxes), formato, aviso Ley 25.326 (spec §B.7) |
| `app/gob/analytics/export/actions.ts` | NEW | `generateExportAction()`: genera CSV/JSON, sube a Storage, envía email, inserta audit log |
| `lib/govt-exports.ts` | NEW | Zod schemas por slice (pets, events, cases, organizations) + `anonymizeRows()` helper |
| `db/schema.ts` | MODIFY (si se necesita) | Columna `export_job_id` en `audit_log` — TBD durante E6 |

### Formato de formatos soportados v1

Spec §B.7 menciona CSV / JSON / Parquet. **Decisión: v1 soporta CSV y JSON únicamente.** Parquet requiere una librería adicional (e.g. `parquetjs`) que agrega complejidad. Diferir Parquet a v2. Documentar en la UI: "Parquet — próximamente".

### Tests — E6

- `__tests__/govt-exports.test.ts`:
  - `petsExportSchema.parse(rawPetRow)` descarta `name`, `ownerDisplayName` correctamente.
  - `petsExportSchema.parse(rawPetRow)` mantiene `publicToken`, `species`, `jurisdictionProvince`.
  - `eventsExportSchema.parse(rawEvent)` descarta `performedByUserId`.
  - Schema con campo extra no definido no throws — solo omite.
- Integration test para `generateExportAction`: mock del Storage upload y del email; verifica que el audit log row se inserta con `schema_version`.

### DoD — E6

- [ ] `pnpm typecheck` clean.
- [ ] `petsExportSchema` descarta name/ownerDisplayName/DNI — test pasa.
- [ ] `generateExportAction` inserta audit log row con `schema_version` y `includes[]`.
- [ ] Form muestra `<Alert variant="info">` con texto de Ley 25.326 (usando `<Alert>` de PR #93).
- [ ] Parquet marcado "próximamente" en el RadioGroup.
- [ ] Tests de anonymization pasan.
- [ ] Signed URL tiene 24h TTL en el email generado.

---

## Definition of Done — Chunk E completo

- [ ] RLS scope-bound por `govt_assignments` verificado: govt CABA ve solo datos CABA — ejecutar `pnpm rls:smoke` con usuario de test CABA.
- [ ] Todos los charts tienen `<details><summary>Ver datos</summary><table>` accesible.
- [ ] Export emite signed URL via email, 24h TTL.
- [ ] `<PeriodPicker>` persiste en searchParams en todos los dashboards.
- [ ] Atribución OSM visible en todos los `<MapChoropleth>`.
- [ ] `prefers-reduced-motion` respetado en animaciones de chart y MetricCard.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm rls:smoke` green.
- [ ] Coverage no regresa.
- [ ] `docs/feature-inventory-2026-05-20.md` entradas 11.7, 11.13 + nuevas entradas → ✅.
- [ ] Plan movido a `docs/superpowers/plans/archive/`.

---

## Diferidos (fuera de scope de Chunk E)

| Item | Justificación |
|---|---|
| Tiles ARSAT | Per E-D1 OF-1 — owner add al research doc antes de agendar |
| Real-time updates (websocket / SSE) en dashboards | Requiere infraestructura separada; bajo impacto operacional v1 |
| `/gob/vigilancia/brotes` — detalle de brote individual | Spec §sitemap lo lista, pero §B.2 no define el layout del detalle; diferir a Chunk E follow-up |
| Parquet export | v1 shipping CSV + JSON; Parquet en v2 |
| `/admin/vigilancia` y `/admin/analytics` (universal scope) | Spec §sitemap los lista; no tienen diseño de layout en el spec. Diferir. |
| `<MapChoropleth level="locality">` con GeoJSON granular | v1 opera a nivel provincia; localidades requieren GeoJSON más pesado de INDEC |
| Multi-tenant cross-jurisdiction analytics | Scope siempre acotado a `govt_assignments` del user; vista cross no entra en v1 |
| Migración `dashboard-v2` → `/gob` | Design-refresh stream parkeado; out of scope Chunk E |

---

## Ambigüedades del spec flaggeadas

1. **Spec §A.5 `<JurisdictionSwitcher>` vs spec §C.2 `<PeriodPicker>`:** El spec nombra A.5 como `<JurisdictionSwitcher>` pero el sumario de archivos F lista A.5 como "JurisdictionSwitcher" y §C.2 como un componente separado llamado simplemente "period picker". **Interpretación adoptada:** son dos componentes independientes — `<JurisdictionSwitcher>` (A.5) y `<PeriodPicker>` (C.2). Ambos en `components/poncho/`.

2. **Spec §B.2 "Pets registrados hoy" MetricCard:** no hay evento `pet_registered` explícito en el schema. Los pets se crean via INSERT en la tabla `pets` sin un event en `pet_events`. **Interpretación:** usar `COUNT(*) FROM pets WHERE created_at >= today` para este KPI. Si el team decide que el registro debe emitir un evento, documentar en E2.

3. **Spec §B.6 MapChoropleth `metric="pets_per_capita"`:** el spec no define de dónde viene la "capita" — no hay tabla de población en el schema. **Interpretación v1:** usar simplemente `pets_per_locality` (conteo crudo, no per-capita), renombrar el label en UI a "Distribución de mascotas" hasta tener datos de población. Marcar con TODO en el código.

4. **Spec §B.4 tab "Vencidos >90d":** el spec muestra `queue=overdue` con `>90d`. No hay columna de deadline en `welfare_reports`. **Interpretación:** "vencidos" = casos cuyo `createdAt < now - 90d` con `status != 'closed'`. No requiere migración.

5. **Spec §D capabilities:** el spec menciona `surveillance.read`, `welfare.investigate`, `analytics.read`, etc., pero el schema de `profiles` no tiene una columna `capabilities[]`. **Interpretación:** las capabilities se derivan del `role` + `govt_assignments` como hace `requireAdminOrGovtOrRedirect` hoy. TBD durante E5: si se necesita granularidad fina de capabilities, agregar columna `capabilities text[]` en `profiles` en una migración de E5.

---

## Referencias

- `dim-interno:docs/design/04-govt-dashboards.md` — design spec completa (fuente de verdad).
- `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` — sequencing parent §Chunk E.
- `docs/superpowers/plans/2026-05-21-pending-decisions-resolved.md` — decisiones cerradas §Chunk E + §CX-1.
- PR #93 — `feat(poncho): design-system primitives (Chunk A.5)` — primitivas que E1 compone.
- `lib/govt-dashboards.ts` — data layer existente a extender en E2–E5.
- `db/schema.ts` — tablas `govt_assignments`, `cases`, `welfare_reports`, `pet_events`.
- `app/gob/dashboard-v2/page.tsx` — preview parkeado; mantener intacto.
- `dim-interno:docs/design/04-govt-dashboards.md` §D — tabla de capabilities y scope.
