> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# Plan: Dashboards vNext — ejecutable por paquete (foco admin)

> **Para Claude Code.** Plan ejecutable derivado del roadmap
> [`specs/2026-06-23-dashboards-vnext-roadmap.md`](../specs/2026-06-23-dashboards-vnext-roadmap.md). Cierra la
> brecha: las proyecciones cubren vigilancia sanitaria pero **no el ciclo de población/custodia** (la North Star),
> casi todo "schema-ready, UI deferred" (`db/schema.ts:315`). **Sin schema nuevo** salvo aviso — todos los
> event-types/tablas ya existen; el grueso es **proyección (`lib/metrics`) + UI**. SDD test-first, docs en el PR.
> Reusa `OpKpi` (deltaV2/sparkline/info/drillHref), `TimeSeriesChart`/`DashboardChart`, `CaseQueue`, k-anon + period
> del paquete metrics-IA. Orden: **Fase 0 (incrementales) → E → G → F → H.** Cada paquete = 1+ sesión/PR.

---

## Fase 0 — Incrementales sobre KPIs existentes (🟢 alto ROI, hacer primero)
Sube la calidad percibida de TODOS los dashboards sin paquetes nuevos. Sin rutas nuevas.
1. **Deltas + sparklines** en cada `OpKpi`: poblar `deltaV2` (vs período anterior) y `sparkline` (serie del período) — ya soportados, hoy subutilizados. Proyección: `fetchKpiTrend(metric, ctx)` en `lib/metrics`.
2. **Targets/benchmarks**: pasar `target` (meta legal o programática) a cada KPI con barra/anillo de avance y color divergente (rojo bajo meta, verde sobre). Centralizar metas en `lib/metrics/targets.ts`.
3. **Frescura del dato**: footer "calculado al {now} · último evento {maxOccurredAt}" en cada dashboard (un helper `lastIngestAt(ctx)`).
4. **Drill consistente**: cablear `drillHref` de cada KPI → su breakdown/lista (hoy disparejo).
5. **Empty-state que distingue** "sin datos" vs "verdadero cero".
- **Tests:** snapshot de un KPI con delta+sparkline+target; `lastIngestAt` devuelve el max real.

## Paquete E — Censo poblacional & salud del registro (🔵 lo que un admin nacional pide primero)
**Ruta:** `/admin/censo` (universal) + `/gob/censo` (jurisdicción). **Pregunta:** ¿crece y está sano el registro?
- **KPIs:** total registradas · **activas vs dormant** (sin eventos en N meses) · perfiles incompletos (sin chip/sexo/localidad) · **altas nuevas (serie temporal)** · embudo identificación (registrada→con chip→ISO-válido→credencial escaneada).
- **Proyección:** `lib/metrics/census.ts` — `registryCounts(ctx, level)`, `registrationTrend(ctx)`, `identificationFunnel(ctx)`. Estados derivados de `pet_events` (último evento por pet) + `pet_identifications` (active/replaced/removed/unreadable).
- **Charts:** curva de altas (TimeSeriesChart), embudo, coropleta por jurisdicción (reusa el rollup `level`), cohortes especie/edad/sexo.
- **Tests:** dormant = pets sin eventos en N meses; el embudo es monotónico decreciente; k-anon en localidad.

## Paquete G — Control poblacional (⭐ North Star)
**Ruta:** `/gob/poblacion` (+ capa/preset en Panorama). **Pregunta:** ¿estamos conteniendo la población?
- **KPIs:** cobertura de **esterilización** por jurisdicción vs meta · **eventos reproductivos / preñez activa** (`pregnancy_status`) · **tasa neta de crecimiento** (altas+nacimientos − muertes) · ratio esterilización/natalidad.
- **Proyección:** `lib/metrics/population-control.ts` — usa `sterilization_performed`, eventos de preñez, `death_recorded`, altas. Serie temporal + por jurisdicción.
- **Charts:** balance esterilización vs natalidad (barras divergentes en el tiempo), coropleta de tasa de crecimiento, impacto de campañas (anotar lanzamientos en la serie).
- **Datos:** depende de que el seed emita `sterilization_performed` + preñez (ver `dim-interno:docs/superpowers-private/plans/archive/2026-06-22-panorama-data-coverage.md` U4).
- **Tests:** la tasa de crecimiento reconcilia (altas+nac − muertes); cobertura esterilización varía por provincia.

## Paquete F — Pipeline de custodia & adopción (🔵 desbloquea el "UI deferred")
**Ruta:** `/admin/adopciones` (vista nacional) + capa Panorama. **Pregunta:** ¿funciona el ciclo de colocación?
- **KPIs/embudo:** intake → `shelter_custody` → `foster` → `adoption_finalized` → devolución, con **tiempo-en-estado** y **tasa de retorno** · utilización del pool de foster · ocupación de refugios vs cupo (`shelter_census_capacity`).
- **Proyección:** `lib/metrics/custody.ts` — censo de custodia (ownerships por rol), embudo de adopción (eventos), tiempos-en-estado. Ranking de colocación por org.
- **Charts:** funnel, distribución de tiempo-en-estado (box/bars), ranking de orgs, coropleta de ocupación.
- **Tests:** los conteos del embudo no exceden el universo en custodia; tiempo-en-estado ≥ 0.

## Paquete H — Salud operativa del programa (🔵 admin-specific, madurez)
**Ruta:** extiende `/admin/sistema` + nuevo `/admin/programa` (resumen ejecutivo).
- **SLA:** aging de colas, ENO-notification SLA (A7), drain del outbox, salud de crons (ya hay base en sistema).
- **Comparación cross-jurisdicción + outliers** como vista de primera clase (quién está muy abajo de meta).
- **Calidad de datos:** completitud por campo, tasa de supresión k-anon, registros huérfanos.
- **Oversight auditoría/PII:** dashboard sobre el audit log (quién buscó qué) — el logging ya existe.
- **Resumen ejecutivo `/admin/programa`:** una página con las KPI North-Star + **alertas activas** + outliers.
- **Alertas/suscripciones:** reglas de umbral sobre `OpBreach` → notificación ("zoonosis activas > X en cualquier jurisdicción"). *(Esto sí puede tocar schema para guardar suscripciones — marcar.)*
- **Tests:** las alertas disparan al cruzar umbral; el oversight respeta scope.

---

## Cross-cutting (aplica a todos los paquetes)
- **Reuso del rollup `level: province|locality`** (del backlog U5) en cada proyección → consistencia de números entre dashboards y Panorama.
- **k-anon** en localidad; **denominador transparente** (mostrar n + completitud + celdas suprimidas).
- **Cada estado nuevo entra como capa/preset del Panorama v2** (`2026-06-23-panorama-v2-design.md`) — mismo rollup, doble salida (dashboard + mapa).
- **Glosario de métricas** navegable (índice de los ⓘ con fórmula + ancla legal).
- **Reportes programados** (CSV ya existe → sumar digest por mail + export PDF para el ejecutivo).

## Secuencia & dependencias
**Fase 0** (ya, barato) → **E** (registro/crecimiento) → **⭐G** (misión, alto impacto narrativo) → **F** (custodia/adopción) → **H** (operativa + alertas). Depende de: `lib/metrics` (primitives + k-anon + period), el rollup `level` (U5), y para G/F el enriquecimiento de datos (U4). Sin schema salvo el item de suscripciones de alertas (H, marcado).

> Al cerrar cada fase/paquete, marcar acá y en `docs/superpowers/README.md`. Visión: `specs/2026-06-23-dashboards-vnext-roadmap.md`.
