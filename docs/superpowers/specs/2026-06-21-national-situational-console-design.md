# Spec: Centro de Situación Nacional — consola geoespacial por capas (admin/govt)

> **Status:** 🟢 Ready for CC · **Depende de:** paquete metrics-IA **Item 0** (`lib/metrics/`: `ProjectionContext`,
> denominador único, `suppressSmallCells` k-anon, period unificado). Este spec es **la cara integradora** de
> todo ese trabajo de proyecciones: una sola superficie que las pone juntas sobre un mapa.
> **Tipo:** design doc (el *qué* y el *porqué*). Plan ejecutable: a escribir post-OK (`plans/`).
> **Sin schema nuevo, sin migrations** en v1 (ver §3). **Sin rutas nuevas de dominio** — solo 2 superficies.
> Origen: crítica de diseño 2026-06-20/21 (mapas en silos, `/gob/analytics` construido-pero-sin-cablear,
> coropletas sin leyenda). Fuentes: `docs/ux-usability-audit.md`, `docs/ux-usability-audit-live.md`.

---

## 1. Qué y por qué

Hoy la inteligencia agregada vive **en silos**: `/gob/perdidas` (mapa de puntos), `/gob/mortalidad` (coropleta
+ barras), `/gob/vigilancia` (señales), `/gob` (KPIs), y una "Analítica nacional" (`/gob/analytics`) **construida
pero no cableada a la nav**. Ninguna correlaciona dominios, que es justo donde está el valor para un operador
nacional.

El **Centro de Situación Nacional** es una única consola geoespacial **por capas** sobre el event log: un mapa
grande con capas toggleables (perdidas, denuncias, mordeduras, zoonosis, mortalidad, cobertura, refugios,
decomisos), KPIs que recomputan al viewport/filtros, drill a expediente, y **reproducción temporal** (porque es
event-sourced — ver §5.3, es el diferenciador). Subsume los mapas sueltos como **capas**, no los reemplaza como
páginas de detalle.

**Por qué ahora:** las projection primitives (Item 0) dan el denominador único + k-anon + period. Este console
es la superficie que las **expone y justifica** — el "porqué construimos las proyecciones".

## 2. Dónde vive — IA y exposición (decidido)

| Surface | Ruta | Scope | Nav |
|---|---|---|---|
| Admin | **`/admin/panorama`** | universal | **Primer ítem del riel**, sección nueva "Panorama" arriba de "Operaciones" |
| Govt | **`/gob/panorama`** | por jurisdicción (reusa scope guards de `/gob/*`) | **Primer ítem del riel**, arriba de "Vigilancia sanitaria" |

Decisiones de exposición:

- **Es la landing operativa por defecto.** En `/admin` y `/gob`, el panel actual queda, pero el ítem
  "Panorama" es el primero del riel y la tarjeta "Analítica nacional" del panel admin pasa a apuntar acá.
- **`/gob/analytics` se absorbe** → redirect 308 a `/gob/panorama`. Su "mapa nacional + ranking cross-region"
  son capas/paneles de este console.
- **Los dashboards de detalle se conservan** (`/gob/perdidas`, `/gob/mortalidad`, `/gob/vigilancia`): tienen
  tablas y cortes que el mapa no reemplaza. Cada uno gana un link "ver en Panorama (capa X)" y, al revés, cada
  capa del console tiene "abrir dashboard de detalle". El console es el **overview**; los dashboards, el **drill**.
- Nav: agregar el ítem en `components/layout/nav-presets.ts` (`GOB_NAV`, `ADMIN_NAV`) como primera entrada,
  ícono `map-2`. (Coordina con el refactor a `NavSection[]` del metrics-IA Item 1: es una sección nueva.)

## 3. Contrato de datos — qué ya guardamos (sin schema nuevo)

El sustrato geoespacial **ya existe y está indexado**. Cada capa es el **mismo event log filtrado distinto**:

| Capa | Fuente | Geo | Índice / nota |
|---|---|---|---|
| Perdidas / avistajes | `pet_events` (lost/sighting kinds) | `location_lat/lng` | `pet_events_location_idx` |
| Mordeduras / antirrábica | `pet_events` (bite) + `bite_rabies_observation` | `location_lat/lng` | mismo índice |
| Mortalidad | `pet_events` (death) + `disposition_method` | lat/lng + localidad | coropleta por localidad |
| Escaneos (v2) | `scan_events` | geo del scan | alto volumen → diferido |
| Denuncias | `welfare_reports` | `location_lat/lng` + `location_address` | `welfare_reports_location_idx` · **PII, ver §8** |
| Zoonosis / señales | `outbreak_signals` + `eno_processing_queue` | localidad / lat/lng del origen | clúster por proximidad |
| Refugios + cobertura | `organizations.location_lat/lng` + coverage zones | punto + jurisdicción | — |
| Decomisos | `cases` (custody/decomiso) + eventos | subject `location` | Ley 14.346 |
| Cobertura vacunación / microchip / PPP | proyección sobre `pet_events` | rollup por localidad | coropleta (vía `lib/metrics`) |

- **No se toca el schema en v1.** lat/lng son `numeric(10,7)` con índice; el bbox-query alcanza. La migración a
  `PostGIS geography(Point,4326)` ya está anotada en `db/schema.ts` como futura — **diferida**, no bloquea.
- Las capas de **rollup** (cobertura, mortalidad, registro) salen de las projection primitives del Item 0
  (denominador único + `suppressSmallCells`), no de queries ad-hoc.

## 4. Catálogo de capas (v1)

Capas de **punto/clúster**: perdidas, mordeduras, denuncias, zoonosis, refugios, decomisos.
Capas de **coropleta** (rollup por localidad): cobertura antirrábica, mortalidad/disposición.
Color por **categoría** (la lista de capas ES la leyenda). Cada capa declara: `id`, `source` (loader), `geomType`
(point|choropleth), `color`, `scopeFilterable`, `privacy` (none|coarse|gated). Registro en
`lib/panorama/layers.ts` (nuevo, puro) para que agregar una capa sea declarativo.

## 5. Visualización

### 5.1 Mapa
MapLibre GL (**ya es dependencia**: `maplibre-gl`). **Sin proveedor de tiles externo en v1** (decisión de
privacidad gov: no filtrar la navegación del operador a un CDN de mapas): el basemap se dibuja desde **GeoJSON
local de provincias/localidades AR** (los centroides ya están en la tabla de localidades; los polígonos de
provincia se incluyen como asset estático en `public/geo/ar-provincias.geojson`). Canvas oscuro; chrome claro (§9).

### 5.2 Modos
`puntos` (clúster nativo de MapLibre / supercluster — sin trabajo server), `densidad` (heatmap layer de MapLibre),
`región` (coropleta por localidad). Los tres en v1.

### 5.3 Reproducción temporal (el diferenciador)
Como es event-sourced, el scrubber filtra `occurred_at ≤ t` dentro del period → se **reconstruye** cómo se formó
un brote o un clúster de perdidas. v1: scrub estático sobre la ventana del period (mostrar hasta el día elegido).
Animación de playback continuo = polish (v1.1).

## 6. Filtros
Reusar lo existente: **un solo** `JurisdictionFilterBar` (país/provincia/localidad) + `PeriodPicker`
(consolidar el doble sistema de filtros que la auditoría marcó). Filtros adicionales: especie, severidad,
estado de caso. Todos recomputan capas + KPIs.

## 7. Agregados / KPIs
Tira superior de `OpKpi` que **recomputa al viewport + filtros activos**, alimentada por `lib/metrics`
(mismo denominador que los dashboards → números consistentes). Cada KPI usa `info={{definition,formula,caveat}}`
(cierra el hallazgo "KPIs sin definición"). Clic en un clúster/feature → drawer de detalle → "abrir expediente"
(integra `cases`) y "ver cadena de eventos".

## 8. Privacidad y seguridad (decidido)
- **Scope:** `/admin/panorama` universal; `/gob/panorama` intersecta SIEMPRE con la jurisdicción asignada del
  viewer (mismos guards que el resto de `/gob/*`). La autorización vive en el **action/route edge** (Drizzle
  bypassa RLS — patrón del repo), nunca solo en el cliente.
- **k-anonimato:** coropletas y conteos por celda usan `suppressSmallCells` (k=5) del Item 0. Celdas <5 se
  muestran "suprimido (privacidad)", como ya hace `/gob/mortalidad`.
- **Denuncias (PII):** la capa de denuncias se dibuja por defecto en el **centroide de localidad (coarse)**. La
  **coordenada exacta** solo se revela al abrir el reporte y **emite `welfare_location_viewed`** (Ley 14.346 /
  25.326) — el modelo de auditoría ya existe. Nunca se exponen coords exactas en el GeoJSON de la capa.
- **Perdidas:** last-seen es público por opt-in del dueño (`disclose_last_location_when_lost`) → se muestra tal
  cual respetando ese flag.
- **Escaneos:** diferidos a v2 por volumen + sensibilidad de movimiento; cuando entren, solo agregados.
- **Sin PII en URL/query params.** GeoJSON de capas se sirve por endpoints read-only con scope server-side.

## 9. Estética
Híbrido deliberado: **mapa oscuro** (los mapas operativos se leen mejor; es la parte "Gotham") + **chrome claro
on-brand** (riel/topbar/KPIs con el Op kit y tokens `ln-op-*`). No se introduce un design language nuevo: el
console reusa `OpKpi`, `OpRail`, `OpCrumbs`, `MapChoropleth`, badges/glyphs existentes. El estilo del mapa
(canvas oscuro + provincias) vive aislado en el componente de mapa.

## 10. Performance
- Capas de punto: query por **bbox + period + scope** sobre el índice geo; cap por capa (p. ej. 2.000 features)
  con aviso "refiná los filtros" (consistente con los caps actuales). Clustering en cliente (MapLibre).
- Coropletas: pre-agregadas a localidad por `lib/metrics` (con `React.cache` dedup del Item 0).
- Entrega: endpoints read-only que devuelven `FeatureCollection` por capa; el componente `<SituationalMap>`
  (cliente) los pide on-demand al togglear/mover.

## 11. Dependencias y orden
1. **metrics-IA Item 0** (projection primitives + k-anon) — **hard dependency** (las capas de rollup y los KPIs
   lo consumen). 2. Reusa `maplibre-gl`, `MapChoropleth`/`MapChoroplethDynamic`, `OpKpi`, `JurisdictionFilterBar`,
   `PeriodPicker`, `cases`. 3. Coordina con Item 1 (nav `NavSection[]`) para meter el ítem "Panorama".

## 12. Fases (SDD, test-first; docs en el mismo PR)
- **F1 — Shell + mapa + 1 capa.** `/admin/panorama` + `/gob/panorama` (scope), `<SituationalMap>` con basemap
  GeoJSON local + capa "perdidas" (puntos/clúster). Nav item. Tests: scope intersection, render 200 por rol.
- **F2 — Registro de capas + filtros + modos.** `lib/panorama/layers.ts`, toggles, `JurisdictionFilterBar` +
  `PeriodPicker` unificados, modos puntos/densidad/región. Tests: cada capa respeta scope+period.
- **F3 — KPIs viewport-aware + drawer de detalle + drill a `cases`.** `OpKpi` con `info`. Tests: consistencia de
  denominador vs dashboards de detalle.
- **F4 — Reproducción temporal** (scrub estático sobre el period).
- **F5 — Endurecimiento de privacidad + promoción en nav + absorción de `/gob/analytics`** (redirect) + links
  cruzados con dashboards de detalle. Tests: `welfare_location_viewed` se emite al revelar coord exacta;
  k-anon en coropletas; no-PII en GeoJSON.

## 13. Decisiones tomadas (sin pendientes)
1. Rutas: `/admin/panorama` (universal) + `/gob/panorama` (jurisdicción). **Cerrado.**
2. Nav: primer ítem del riel en ambos portales, ícono `map-2`. **Cerrado.**
3. `/gob/analytics` → redirect a `/gob/panorama`; dashboards de detalle se conservan con links cruzados. **Cerrado.**
4. Basemap: GeoJSON local de AR, **sin tile provider externo** (privacidad gov). **Cerrado.**
5. Capas v1: perdidas, mordeduras, denuncias, zoonosis, refugios, decomisos, cobertura, mortalidad. Escaneos = v2. **Cerrado.**
6. Modos v1: puntos/clúster, densidad, región. Playback animado = v1.1. **Cerrado.**
7. Clustering en cliente (MapLibre). **Cerrado.**
8. Denuncias: coarse por defecto, exacta solo al abrir (audit `welfare_location_viewed`). **Cerrado.**
9. k-anon k=5 vía Item 0 en todo conteo por celda. **Cerrado.**
10. Sin schema nuevo; PostGIS diferido. **Cerrado.**
11. Estética: mapa oscuro + chrome claro Op kit. **Cerrado.**

## 14. Fuera de alcance (diferido)
PostGIS/`geography`; capa de escaneos; analítica predictiva/anomalías; export del mapa; alertas automáticas por
clúster (se apoyarían en esto después); playback animado continuo.

## 15. Trazabilidad
Cierra hallazgos de auditoría: mapas en silos, `/gob/analytics` sin cablear, coropletas sin leyenda, doble
sistema de filtros, KPIs sin definición. Maqueta de referencia: ver la conversación de diseño (consola con riel
de capas, mapa oscuro, KPIs viewport-aware, drawer de detalle, scrubber temporal).
