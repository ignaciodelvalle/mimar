# Spec: Panorama v2 — del "mapa de burbujas" a una consola de inteligencia geo-epidemiológica

> **Status:** 🟢 Ready for CC (plan a derivar). Rediseño del Centro de Situación (`/admin/panorama` +
> `/gob/panorama`) tras crítica en vivo 2026-06-23 (branch `review/all-session-prs`, seed ~46k). El v1 funciona
> end-to-end (mapa, 8 capas, replay, toggle agregación) pero **la representación es pobre**: clustering genérico
> que pierde la información y la georreferencia. Este spec eleva la calidad. **Sin schema nuevo.** Reusa el
> basemap GeoJSON de provincias, `ar_localities` (centroides), `jurisdictions_census`, `lib/metrics`.

## 1. Qué falla hoy (evidencia en vivo)
1. **Clustering genérico de maplibre.** 105 pérdidas → **~7 burbujas flotantes** que **se reagrupan con cada zoom**, sin etiqueta de a qué localidad/provincia pertenecen y **sin número** adentro. Pérdida masiva de información de un historial que está georreferenciado y catalogado.
2. **Coropleta invisible al zoom nacional.** La capa de superficie (cobertura) recién se ve coloreada al hacer zoom-in; a nivel país todas las provincias se leen gris uniforme. **Sin leyenda** de escala en ningún zoom.
3. **Apilado incompatible.** Los puntos de incidente se **lavan** sobre la coropleta (rojo sobre azul claro → casi invisible). El panel de capas deja prender cualquier combinación → mezcla ilegible.
4. **Sopa de capas, no preguntas.** El operador enfrenta 8 checkboxes, no "¿qué quiero saber?".

## 2. Principios del rediseño
1. **La unidad administrativa es el átomo, no el píxel.** Toda capa se agrega a **provincia** (vista nacional) o **localidad** (drill), **etiquetada y estable al zoom**. Se elimina el re-clustering libre. El toggle Provincia/Localidad (ya existe) maneja **todas** las capas, no solo las de superficie.
2. **Una pregunta a la vez → vistas curadas, no checkboxes.** Presets por defecto (§4).
3. **Modelo de compatibilidad** entre capas: solo combinaciones coherentes (§3).
4. **Detalle on-demand:** clic en una unidad → panel lateral con su **historial catalogado** (lista de eventos + mini-tendencia), para que el mapa quede limpio y la profundidad esté a un clic.

## 3. Taxonomía de capas y compatibilidad (el criterio que pediste)
Cada capa tiene un **tipo de dato** que define cómo se representa y con qué es comparable:

| Tipo | Capas | Representación | Rol |
|---|---|---|---|
| **Tasa / cumplimiento** (tiene denominador → %) | cobertura antirrábica, microchip, PPP, esterilización, trazabilidad disposición | **coropleta divergente** anclada a la meta legal | **base** (exactamente 1) |
| **Densidad / incidencia** (conteo de eventos) | pérdidas, mordeduras, denuncias, muertes | coropleta (conteo o **por-10k**) **o** símbolo proporcional | base **o** overlay |
| **Señal / alerta** (derivado, urgente) | brotes/zoonosis, observaciones rábicas, ENO | **símbolo proporcional** encima (tamaño=conteo, color=severidad) | **overlay** (≤1) |
| **Referencia** (puntos estáticos) | refugios, decomisos | símbolo/pin | overlay de referencia |

**Regla de compatibilidad:** **1 base** (tasa o densidad-coropleta) **+ ≤1 overlay de señal + referencia opcional.**
Dos coropletas a la vez, o N capas de punto encimadas → **se bloquea con un hint** ("elegí una base; las señales van encima"). Esto vuelve concreto el "compatible o no": no se comparan peras con manzanas, y el sistema guía al operador.

## 4. Vistas por defecto (presets — reemplazan la sopa de capas)
Cada preset fija base + overlay + agregación + período + leyenda correcta, para arrancar de una **pregunta**:

1. **"Brotes activos"** *(landing de vigilancia):* `outbreak_signals` como símbolo proporcional (tamaño=conteo, color=severidad) **sobre** coropleta de **cobertura antirrábica** → *brotes vs. huecos de vacunación*. Período 30/90 d.
2. **"Reportes de síntomas / vigilancia sindrómica":* densidad de eventos clínicos/síntomas (coropleta por-10k) + overlay de enfermedades reportables → *alerta temprana*.
3. **"% de cumplimiento"** *(selector):* elegí una métrica (antirrábica / microchip / PPP / esterilización) como **coropleta divergente anclada a la meta** (rojo bajo meta, verde sobre), con el **gap por unidad** etiquetado.
4. **"Bienestar y fiscalización":* densidad de denuncias + decomisos como referencia, por jurisdicción.

Los 8 toggles quedan como **modo avanzado** ("capas") debajo de los presets.

## 5. Arreglo de atribución de localidad (tu reclamo explícito)
- Reemplazar el auto-cluster de maplibre por **agregación determinística a la unidad administrativa**: un símbolo por unidad en su centroide (o relleno coropleta), **etiquetado con nombre + conteo**, **estable a través del zoom**.
- Zoom nacional → agrega por **provincia**; con scope en una provincia → agrega por **localidad** (lo maneja el toggle Provincia/Localidad + el filtro de alcance).
- **Hover:** "Quilmes · 12 pérdidas (3 recuperadas)". **Clic:** panel lateral (§6).
- **Leyenda siempre visible** (escala de color + qué significa el tamaño del símbolo). Cierra el hallazgo recurrente "coropletas sin leyenda".

## 6. Detalle on-demand (el "mucho más nivel de detalle" que esperabas)
Clic en una unidad → **panel lateral** con: la **lista de eventos catalogados** de esa localidad/provincia en el período, un **sparkline** de la métrica en el tiempo, breakdown por tipo de evento, y "abrir en el dashboard de detalle / expediente". El mapa queda limpio; la profundidad está a un clic. Acá vive el historial que hoy se pierde en las burbujas.

## 7. Transversales
- **Coropleta legible a todo zoom:** rampa de color más fuerte + leyenda fija (no depender del zoom-in).
- **k-anon:** en localidad se mantiene supresión `<5`; en provincia no hace falta.
- **Replay temporal:** ya está bien; al reproducir, los símbolos de señal "crecen" por unidad (estable), no re-clusterizan.
- **Reuso:** una sola función de rollup en `lib/metrics` por `level` + por `metric`, consumida por el mapa **y** los widgets de distribución de los dashboards (consistencia de números).

## 8. Fases (SDD)
- **F1 — Agregación determinística por unidad** (mata el re-cluster): símbolos por provincia/localidad, etiquetados, con conteo, estables al zoom + leyenda. Toggle maneja todas las capas.
- **F2 — Modelo de compatibilidad + panel de capas guiado** (1 base + 1 señal + referencia; bloquear combos incoherentes).
- **F3 — Presets** ("Brotes activos", "Síntomas", "% cumplimiento", "Bienestar") como entrada por defecto.
- **F4 — Panel de detalle on-demand** (historial de la unidad + sparkline + link a expediente).
- **F5 — Coropleta divergente anclada a meta** + leyendas fijas a todo zoom.
- **Tests:** agregación por unidad da conteos estables entre zooms; combos incompatibles bloqueados; cada preset rinde base+overlay correctos; k-anon en localidad; leyenda presente.

---

## Apéndice A — Reconciliación README ↔ realidad (lo que pediste comparar)
El README quedó **atrás** de lo construido esta sesión:
- **Falta el Panorama** (el feature insignia) en la tabla "Portal surfaces" y en el modelo de roles → agregar `/admin/panorama` (universal) y `/gob/panorama` (jurisdicción).
- **`/gob/analytics`**: el README lo marca "deferred-by-design, no cableado en nav". Hoy **está en el nav y es página propia** (el redirect 308 a Panorama es decisión de producto pendiente, no ejecutada) → actualizar la nota.
- **Campañas** (`/gob/campanas`): el README no la lista; ahora está **construida** → agregar.
- **Dashboards de métricas** (mortalidad/vigilancia/analytics con tendencias + el paquete metrics-IA) no están reflejados como surfaces → refrescar.
- **Modo demo:** el banner "Datos de demostración" se muestra **siempre** (flag #20 pendiente) → documentarlo en el README/"acerca de" hasta que exista el flag.
**Recomendación:** un PR chico de **refresh del README** (tablas de surfaces + roles) para que no mienta ante un revisor; es parte de la credibilidad gov.

## Apéndice B — Admin e2e: residual a verificar (U3, sin cerrar)
Pendiente de pasada en vivo (yo la hago): **magic-link primer login**, **páginas de detalle/drill** (`[token]`/`[publicCode]`/`[userId]`), **sub-dashboards** (zoonosis/investigaciones/decomisos/disputas), **descarga real del CSV** (`/gob/analytics/export`), **mobile en dispositivo**, y **1 workflow de aprobación end-to-end** (cola → aprobar/rechazar). Gate en `dim-interno:docs/superpowers-private/plans/2026-06-22-executive-e2e-readiness.md`.

> Depende del rollup de `lib/metrics` (level+metric) y del basemap ya presente. Sin schema. Importar polígonos de localidad (coropleta rellena a nivel localidad) queda diferido — por ahora localidad = símbolos por centroide.
