# Plan: Centro de Situación Nacional — consola geoespacial por capas (admin/govt)

> **Plan ejecutable para CC.** Implementa el spec
> [`specs/2026-06-21-national-situational-console-design.md`](../specs/2026-06-21-national-situational-console-design.md).
> **Depende de:** metrics-IA **Item 0** (`lib/metrics/`: `ProjectionContext`, denominador único,
> `suppressSmallCells` k-anon, period, `React.cache` dedup) — **hard dependency** para capas de rollup + KPIs.
> SDD test-first por fase, docs en el mismo PR. **Sin schema nuevo, sin migrations** (PostGIS diferido).
> Todas las decisiones están cerradas en el spec §13 — no abrir nuevas; si aparece una, anotarla y seguir el default del spec.
> Arquitectura: Hexagonal-lite (`src/modules/panorama/`), auth en el **edge** (action/route), nunca solo en cliente.

---

## Componentes y archivos (mapa de cambios)

**Nuevos — backend (módulo `src/modules/panorama/`)**
- `domain/layers.ts` — registro **puro** de capas: `id`, `geomType` (`point|choropleth`), `color`, `source`, `scopeFilterable`, `privacy` (`none|coarse|gated`). Sin `@/db`, sin `next`.
- `domain/types.ts` — `LayerId`, `PanoramaFilters` (scope, period, species?, severity?, caseStatus?), `FeatureCollection` (GeoJSON tipado).
- `application/get-layer-features.ts` — use-case por capa: arma `ProjectionContext` (Item 0), aplica scope+period+bbox, devuelve `FeatureCollection`. Capas de rollup usan `lib/metrics` (`suppressSmallCells`).
- `application/get-panorama-kpis.ts` — KPIs viewport-aware desde `lib/metrics` (mismo denominador que los dashboards).
- `infrastructure/repository.ts` — **único** lugar con Drizzle: bbox queries sobre `pet_events_location_idx` / `welfare_reports_location_idx` / `organizations`; rollups por localidad.
- `actions.ts` — controllers `"use server"`: parse + **AUTH (boundary)** + scope intersection + return GeoJSON. Para admin: universal; para gob: intersecta SIEMPRE con `govt_assignments`.

**Nuevos — frontend (`components/panorama/`)**
- `SituationalMap.tsx` (client) — MapLibre GL (`maplibre-gl`, ya dep). Basemap GeoJSON local; sources/layers por capa; clustering nativo; modos puntos/heat/coropleta.
- `LayerPanel.tsx` — toggles + swatches + conteos (es la leyenda).
- `DetailDrawer.tsx` — feature seleccionado → drill a `cases` ("abrir expediente", "ver cadena de eventos").
- `TimeScrubber.tsx` — filtra `occurred_at ≤ t` dentro del period.
- `PanoramaShell.tsx` — compone topbar (scope chips) + `OpKpi` strip + LayerPanel + Map + Drawer + Scrubber.

**Nuevos — rutas / assets**
- `app/admin/panorama/page.tsx`, `app/gob/panorama/page.tsx` (server: resuelven scope, pasan al shell client).
- `app/api/panorama/[layer]/route.ts` — endpoint read-only que delega en `actions.ts` (scope server-side).
- `public/geo/ar-provincias.geojson` — basemap (provincias AR). Localidades: centroides desde la tabla existente.

**Edits**
- `components/layout/nav-presets.ts` — `GOB_NAV` + `ADMIN_NAV`: **primer ítem** "Panorama" (ícono `map-2`). Coordinar con Item 1 (`NavSection[]`).
- `app/gob/analytics/*` → redirect 308 a `/gob/panorama`.
- `app/gob/perdidas`, `app/gob/mortalidad`, `app/gob/vigilancia` — link cruzado "ver en Panorama (capa X)".
- `app/admin/page.tsx` — tarjeta "Analítica nacional" apunta a `/admin/panorama`.

---

## Fase F1 — Shell + mapa + capa "perdidas" + nav
**Meta:** una superficie viva por rol con el mapa y una capa real.
- Crear `domain/{layers,types}.ts` (solo `perdidas`), `infrastructure/repository.ts` (bbox query lost/sighting), `application/get-layer-features.ts`, `actions.ts` (scope guard), `app/api/panorama/[layer]/route.ts`.
- `SituationalMap.tsx` con basemap GeoJSON local (canvas oscuro) + capa de puntos/clúster `perdidas`. `PanoramaShell.tsx` mínimo. Rutas `app/{admin,gob}/panorama/page.tsx`. Nav item.
- **Tests:** e2e — `/admin/panorama` (admin) y `/gob/panorama` (govt) renderizan 200 sin error boundary; un govt **no** ve features fuera de su jurisdicción (scope intersection). Unit — registro de capas.

## Fase F2 — Registro de capas + filtros + modos
- Completar capas v1: mordeduras, denuncias (coarse), zoonosis, refugios, decomisos (punto) + cobertura, mortalidad (coropleta vía `lib/metrics`). Cada una declarativa en `domain/layers.ts`.
- `LayerPanel.tsx` (toggles). Unificar filtros: **un solo** `JurisdictionFilterBar` + `PeriodPicker` (retirar el doble sistema). Modos: puntos/clúster, densidad (heatmap), región (coropleta).
- **Tests:** cada capa respeta scope+period; coropletas aplican `suppressSmallCells` (k=5); cap por capa (2.000) con aviso "refiná los filtros".

## Fase F3 — KPIs viewport-aware + drawer + drill a cases
- `get-panorama-kpis.ts` desde `lib/metrics`; tira `OpKpi` con `info={{definition,formula,caveat}}` que recomputa al viewport+filtros.
- `DetailDrawer.tsx`: click en clúster/feature → detalle → "abrir expediente" (`cases`) + "ver cadena de eventos".
- **Tests:** denominador de KPIs **idéntico** al del dashboard de detalle equivalente (consistencia); drill abre el `case` correcto.

## Fase F4 — Reproducción temporal
- `TimeScrubber.tsx`: filtra eventos `occurred_at ≤ t` dentro del period (scrub estático). Playback animado = v1.1 (fuera de alcance).
- **Tests:** al mover el scrubber, el set de features ≤ t es subconjunto correcto del period.

## Fase F5 — Privacidad + promoción en nav + absorción de analytics
- Endurecer privacidad: capa denuncias en **centroide de localidad**; coordenada exacta SOLO al abrir el reporte y **emitiendo `welfare_location_viewed`** (Ley 14.346/25.326). Garantizar que el GeoJSON de capa **nunca** lleva PII/coords exactas. k-anon en todo conteo por celda.
- Redirect `/gob/analytics` → `/gob/panorama`; links cruzados con dashboards de detalle; tarjeta admin repunteada.
- **Tests:** revelar coord exacta emite `welfare_location_viewed`; snapshot del GeoJSON de denuncias no contiene lat/lng exacta; redirect 308 verificado; axe sobre el shell (mapa con `aria-label`, panel operable por teclado).

---

## Definición de hecho
- Las 5 fases verdes en CI (vitest + e2e). Sin PII en payloads de capa. k-anon en coropletas. Scope intersection probado por rol. `/gob/analytics` redirige. Nav muestra "Panorama" primero en admin y gob. Docs actualizadas en el mismo PR.

## Dependencias / orden
1. **Item 0 metrics-IA** primero (las capas de rollup + KPIs lo consumen). 2. Reusa `maplibre-gl`, `MapChoropleth`, `OpKpi`, `JurisdictionFilterBar`, `PeriodPicker`, `cases`, `lib/metrics`. 3. Coordina nav con Item 1 (`NavSection[]`).

## Fuera de alcance (diferido)
PostGIS/`geography`; capa de escaneos; playback animado continuo; analítica predictiva/anomalías; alertas automáticas por clúster; export del mapa.

> Al cerrar cada fase, marcar y mover el ítem en `docs/superpowers/README.md`.
