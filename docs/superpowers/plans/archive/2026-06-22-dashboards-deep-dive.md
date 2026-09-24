> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# Plan: Dashboards admin/gob — deep dive (completitud, faltantes, mejoras)

> **Para Claude Code — ejecución autónoma.** Análisis profundo de los dashboards del perfil admin (y los de gob
> que el admin consume con scope universal), en vivo, **con el dataset realista cargado** (`seed:panorama` →
> ~45.7k mascotas). Severidad: 🔴 · 🟡 · 🟢. SDD test-first. Extiende la remediación (Fase 3.6) + el paquete
> metrics-IA (trends). Reusar `OpKpi`, `DashboardChart`, `TimeSeriesChart`, `MapChoropleth`, `lib/metrics`.

## Lo que ya está MUY bien (no rehacer)
- **KPIs con ⓘ definición + ⚠ estado** (no-solo-color) en `/gob`, `/gob/mortalidad`, `/gob/analytics` (#689/#691). ✅
- **Mortalidad**: banner de alerta derivada (umbral de trazabilidad), y la "Distribución por localidad" ahora tiene **escala (0–N) + disclosure k-anon** ("N localidades ocultas (privacidad)"). ✅
- **Vigilancia**: **mapa coroplético real** ("Casos abiertos por jurisdicción") + k-anon en los paneles. ✅
- **Analytics**: **export CSV** (se adoptó `DashboardChart`), **ranking cross-region** (mayor/menor cobertura por provincia). ✅
- **Dataset realista**: el ranking (Buenos Aires 44% → Formosa 8%) y la distribución AMBA-dominante son creíbles; k-anon suprime localidades chicas. ✅

## Hallazgos del deep dive

| # | Hallazgo | Sev | Ubicación / evidencia | Fix |
|---|---|---|---|---|
| D1 | **No hay ninguna serie temporal / tendencia.** Todos los dashboards son snapshots (KPIs + tablas/barras). El event log es inherentemente temporal. "Causas por semana" es incluso una **tabla plana** de ISO-week×causa que pide ser un stacked chart. No hay cobertura-en-el-tiempo, mordeduras/semana, ni timeline de señales. **Es el gap de completitud más grande**: el operador ve el valor actual, no la dirección. | 🟡 | `/gob/mortalidad` (Causas por semana = tabla), `/gob` y `/gob/analytics` (KPIs sin trend) | Agregar trend charts (cobertura/mordeduras/muertes/señales por período) con `TimeSeriesChart`/`DashboardChart`; convertir "Causas por semana" → stacked time-series. Proyección bucketed por período desde `lib/metrics`. |
| D2 | **La vigilancia epidemiológica (el core) no muestra señales** pese a 189 mordeduras + 122 muertes + el clúster de rabia que el dataset debía sembrar: **Brotes 0 · Rábicas 0 · Signals 0 · "Sin enfermedades reportables"**. El pipeline mordedura→observación rábica→`outbreak_signal` no produce nada del seed. La superficie insignia queda vacía. | 🟡 | `/gob/vigilancia`; `scripts/seed-panorama.ts`; lógica bite→observation→signal | Que el `seed:panorama` genere observaciones rábicas + `outbreak_signals` (los set-pieces del dataset plan); y/o verificar que la detección se dispara con mordeduras sembradas. Sin esto no se puede testear ni demostrar la vigilancia. |
| D3 | **Enums en inglés en las superficies analíticas.** Causas de muerte: "illness/Illness", "Euthanasia" en `/gob/mortalidad` (Causas por semana) **y** `/gob/analytics` (Top 10 causas), mezcladas con traducidas (Eutanasia/Accidente/Muerte natural). Además: H1 **"Analytics"** (vs "Analítica"); copy "Mascotas en status `lost`"; action-codes crudos en el feed del panel `/gob`. | 🟡 | `/gob/mortalidad`, `/gob/analytics`, `/gob` panel | Completar el mapa de enum de causa (illness→Enfermedad, etc.); H1 "Analítica"; aplicar el formatter de acción de `/admin/historial` al feed de `/gob`; "status lost"→"perdidas". + el **lint de copy es-AR / no-enum-crudo** (design-system hardening Fase A) para que no recurra. |
| D4 | **Las métricas de disposición no reconcilian a la vista.** `/gob/mortalidad`: **Trazabilidad 0%** junto a **Disposición desconocida 34%** y **Notificables 2%** — los códigos B3/B4/B9 no componen un 100% obvio; 0% trazable al lado de 34% desconocido se lee contradictorio. | 🟡 | `/gob/mortalidad` (tira de KPIs B3/B4/B9) | Una sola viz de **descomposición 100%** (stacked bar: método+instalación / solo-método / desconocida) que haga legible la relación; revisar el cálculo de trazabilidad (0% con 66% que tienen método es sospechoso). |
| D5 | **Faltan deltas y sparklines por KPI.** `OpKpi` los soporta (y el deploy viejo mostraba "↑145% vs mes ant."), pero en este build los KPIs son valor-único sin tendencia ni delta. Tampoco drill: clic en "Cobertura 32%" no abre el ranking. | 🟢 | `/gob`, `/gob/analytics`, `/admin` | Poblar `deltaV2` + `sparkline` + `drillHref` en los KPIs (lib/metrics ya tiene period). |
| D6 | **El admin no tiene profundidad analítica propia.** `/admin` y `/admin/sistema` son conteos + feed de actividad (con action-codes crudos); ningún chart ni tendencia. El admin depende de saltar a gob. | 🟢 | `/admin`, `/admin/sistema` | El **Centro de Situación** (`/admin/panorama`, ya specced — `2026-06-21-national-situational-console-design.md`, hoy WIP/404) es la superficie analítica integradora del admin. Priorizarlo; mientras, cross-link explícito admin→gob. |
| D7 | **`not-found.tsx` branded sigue sin cubrir `/admin`** (residuo A1 del sweep): `/admin/zzz-no-existe` → 404 negro en inglés. | 🟡 | falta `app/admin/not-found.tsx` (y gob/app) | (= A1 de `2026-06-22-admin-fresh-sweep-fixes.md`) — agregar not-found por route-group. |

## Cobertura del deep dive
En vivo con dataset cargado: `/admin` (panel), `/admin/sistema`, `/gob` (panel), `/gob/mortalidad`,
`/gob/vigilancia`, `/gob/analytics`. **No** recorridos este pase (data-dependent o WIP): `/admin/panorama`
(404, en construcción por CC), `/gob/campañas`, `/gob/outreach`, `/gob/decomisos`, `/gob/disputas`.

## Ejecución (orden sugerido)
1. **D2** (señales de vigilancia desde el seed) — desbloquea testear/mostrar el core epidemiológico.
2. **D1** (trends/series temporales) — el gap de completitud más grande; reusa `lib/metrics` + `TimeSeriesChart`.
3. **D3** (enums/localización analítica + lint) y **D4** (descomposición de disposición) — legibilidad.
4. **D5, D6, D7** — deltas/drill, profundidad admin (panorama), not-found.

## Tests
- D1: snapshot de un trend chart; "Causas por semana" rinde como serie temporal, no tabla.
- D2: integración — tras `seed:panorama`, `/gob/vigilancia` muestra ≥1 señal/brote y el clúster de rabia set-piece aparece.
- D3: el lint de copy es-AR/no-enum-crudo pasa; no quedan literales de enum de causa en inglés en `/gob/*`.
- D4: la descomposición de disposición suma 100%; unit del cálculo de trazabilidad con muertes con/sin instalación.
- D5: KPIs con `deltaV2`/`drillHref` testeados.

> Al cerrar, marcar en `docs/superpowers/README.md` (extiende Fase 3.6 + metrics-IA). Depende de `seed:panorama` para data.
