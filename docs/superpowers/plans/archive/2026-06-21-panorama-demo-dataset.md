# Plan: Dataset demo realista para el Panorama (ponderado por población)

> **Plan ejecutable para CC.** Genera un set de datos sintético pero **realista** para que el
> [Centro de Situación Nacional](./2026-06-21-national-situational-console.md) (y los dashboards de gob) se
> vean con densidad parecida a la real. Idempotente, **local-only**, determinístico.
> **Sin schema nuevo** — usa tablas/columnas que ya existen. Maqueta de referencia: "Panorama — modo densidad"
> (vista nacional ponderada por población, replay temporal) en la conversación de diseño.

## Insumos que YA existen (no inventar distribución)
- `jurisdictions_census.population` — **población provincial real, Censo 2022** (`integer` por provincia). Es el peso.
- `ar_localities` (~4.027 filas) — `provinceCode`, `latitude`, `longitude`, `category`. Son los puntos de anclaje.
- Tablas destino con geo + índice: `pet_events` (`location_lat/lng`, `pet_events_location_idx`), `welfare_reports`
  (`location_lat/lng`), `organizations`, `cases`, `outbreak_signals`/`eno_processing_queue`.
- Patrón de seed existente a reusar: `scripts/seed-test-users.ts` (INSERT directo porque las actions son `use server`),
  `scripts/db-bootstrap.ts` (guard local + idempotencia), `seed:perf`/`seed:coverage`/`seed:demo`.

## Modelo de generación

**1. Población de mascotas por provincia (real).**
`pets_provincia = census.population × PETS_PER_CAPITA × SCALE`.
- `PETS_PER_CAPITA` default `0.5` (AR tiene altísima tenencia; ~8 de cada 10 hogares).
- `SCALE` default `0.002` (≈1:500) → ~46k mascotas nacionales, dominadas por AMBA, como en la realidad. **Env-tunable.**
- Resultado: conteos por provincia **proporcionales a la población real** sin hardcodear shares (Buenos Aires ~38%, CABA ~7%, Córdoba/Santa Fe ~8% c/u, … Tierra del Fuego <0,5%).

**2. Distribución intra-provincia (concentración urbana).**
Las localidades no tienen población → usar **anclas metro curadas** (~30: capitales provinciales + grandes metros:
La Plata, Mar del Plata, Bahía Blanca, conurbano; Rosario; Córdoba capital; Mendoza capital + San Rafael; San
Miguel de Tucumán; Salta; Resistencia; Posadas; etc.). Reparto **Zipf/Pareto**: las anclas absorben ~70% de las
mascotas de su provincia; el resto se esparce fino sobre las demás localidades. Así las ciudades "prenden" y el
campo queda ralo. (Futuro opcional: importar población de localidad INDEC y reemplazar la heurística por pesos exactos.)

**3. Geo.** Cada mascota/evento = centroide de su localidad (`ar_localities.lat/lng`) + **jitter gaussiano**
(radio chico urbano, más grande rural). Se escribe en `pet_events.location_lat/lng` (y `welfare_reports`, etc.),
respetando el `location_pair_check`.

**4. Eventos (tasas realistas sobre ventana configurable, default últimos 90 días).**
- **Vacunación:** asignar estado antirrábico por **cobertura provincial objetivo** entre ~8% y ~45% (baja y variada)
  → la coropleta de cobertura muestra spread y la historia "muy por debajo del 80% meta". Microchip ~1–15%.
- **Perdidas:** ~0,4% de las mascotas en estado *lost* activo al snapshot (≈180–250 nacional, coherente con lo real)
  + históricas resueltas. Hotspot deliberado en conurbano (AMBA).
- **Mordeduras / obs. antirrábica:** ~pocas por 10k/año → algunos cientos en la ventana, concentradas por población.
- **Denuncias (welfare):** cientos en la ventana; mezcla de severidad (mayoría moderada, pocas graves).
- **Mortalidad + disposición:** muertes sobre la ventana con mezcla de disposición (sepultura/cremación/desconocida)
  → coropleta de mortalidad + tasa de trazabilidad variada (Ley 5470).
- **Zoonosis/señales:** base rala + **clusters deliberados** (abajo).

**5. Set-pieces (para que la consola cuente una historia).**
- **Clúster de rabia (NOA/NEA):** 4–6 señales bite+ENO en una localidad (p. ej. Salta/Chaco) dentro de 12 días.
- **Clúster zoonosis La Plata** (consistente con la maqueta del spec).
- **Hotspot de perdidas AMBA** (densidad elevada en conurbano sur).
- **Cadena de decomiso (Ley 14.346):** 1–2 `cases` con handoff govt→refugio para la capa decomisos + su drawer.
- **3–4 localidades chicas con <5 incidentes** para demostrar la **supresión k-anon** en vivo.

## Mecánica
- Nuevo `scripts/seed-panorama.ts` + script `pnpm seed:panorama`.
- **Determinístico:** RNG con semilla fija (reproducible). **Idempotente:** taggear filas creadas (marca de origen)
  y limpiar/upsert al re-correr. **Local-only:** abortar si `DATABASE_URL` no es local (igual que `db-bootstrap`).
- **Orden:** corre DESPUÉS de `db:bootstrap` (necesita `ar_localities` + `jurisdictions_census` + usuarios/orgs de test).
  Crea mascotas vía INSERT directo (patrón de `seed-test-users.ts`), atribuidas a un pool de owners sintéticos.
- **Batching:** inserts por lotes (p. ej. 1.000) para mantener el runtime acotado.
- **Tuning de performance:** ~46k mascotas / ~80–120k eventos. El mapa usa clustering + cap 2.000/capa, así que escala.

## Tests / aceptación
- **Correlación con población:** ranking de mascotas por provincia ≈ ranking de `census.population` (Spearman alto);
  Buenos Aires #1, CABA top-3, Tierra del Fuego última.
- **k-anon demostrable:** las localidades-set-piece chicas devuelven "suprimido" en coropleta; los metros no.
- **Set-pieces presentes:** el clúster de rabia y la cadena de decomiso existen y son consultables por las capas.
- **Idempotencia + guard:** re-correr no duplica; abortar contra DB no-local.
- **Cobertura variada:** la coropleta de cobertura antirrábica tiene rango (no todo igual) y queda por debajo de 80%.
- **Runtime** bajo presupuesto (objetivo < ~2 min en local).

## Dependencias / orden
1. `db:bootstrap` (tablas de referencia + usuarios). 2. Este seed. 3. Alimenta el Panorama console
   (`2026-06-21-national-situational-console.md`) y mejora los dashboards de gob existentes. Independiente del
   Item 0 de metrics-IA (este genera **datos**; el Item 0 los **agrega**), pero juntos completan la demo.

## Fuera de alcance (diferido)
Población de localidad INDEC exacta (hoy heurística de anclas); escaneos masivos (capa v2); series temporales
multi-año; datos de otros países.

> Al cerrar, marcar y mover el ítem en `docs/superpowers/README.md`. Default de tuning vive en el header del script.
