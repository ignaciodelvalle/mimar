# Pet profile v2.1 — reorder + action-hub consolidation — design spec

> **Status:** 🟢 Ready for Claude Code — decisiones cerradas (§9 resuelto 2026-06-18) · **Date:** 2026-06-18 · **Item 6 of the metrics-IA handoff**
> · Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` · Antecesor: `2026-05-19-pet-profile-v2-design.md`

## 1. Por qué este documento existe

Una crítica de diseño (2026-06-18) sobre `/mis-mascotas/[publicToken]` encontró que el perfil acumuló deuda del "hybrid swap" v2/pre-v2 (documentado en el propio header del `page.tsx`) y hoy compite consigo mismo en tres frentes: **jerarquía de información**, **rutas de acción solapadas** y **un v2 a medio terminar**. Ninguno es un bug funcional — todo "anda" — pero el resultado es que la identidad de la mascota queda enterrada y el usuario tiene 3 formas de llegar a la misma acción. Este spec corrige ordenamiento + consolidación, sin tocar el modelo de datos ni el event log.

Hallazgos (con evidencia de código):

1. **Hasta 5 banners/cards condicionales renderizan ANTES del hero** (en `page.tsx`, entre ~L1023 y ~L1077, todos antes de `data-section="hero"`): `TransitBanner`, `RabiesObservationBanner`, `PetOpenCasesSection`, `PregnancyInProgressCard`, `PpPCard`, `ServiceDogCredentialCard`. Una mascota en tránsito + PPP + con caso abierto empuja la identidad debajo de una pared de alertas.
2. **Achievements (gamificación) es el primer bloque dentro de la tab Resumen** (~L1143), arriba de "01 Estado de salud" (~L1148) — al revés de lo que su propio plan v2 ordena ("logros abajo de las siete secciones, solo cuando aplique").
3. **Conflicto spec vs implementación**: el v2 spec dice "sacar el timeline del perfil → vive en `/libreta` y `/historial`"; la implementación lo trajo de vuelta como **tab**. Las rutas `/libreta`, `/historial`, `/vacunas` ahora son redirects permanentes a `?tab=…` (bien resuelto), pero el v2 quedó conceptualmente a mitad.
4. **Dos componentes para "recordatorios de vacuna"** (`PetReminders` vs `PetVaccineReminders`) coexisten; se usa uno por tener el wiring de server action.
5. **Tres hubs solapados para "actuar sobre la mascota"**: `PetActionsMenu` (`Anotar algo` / `Editar mascota` / `Transferir` / `Confirmar devolución`), el hub `/anotar` (`Marcar perdida/encontrada`, `Compartir libreta`, `Transferir`, `Editar`, `Buscar hogar`), y `/eventos/nuevo` (grid de 17+ formularios, incluido `Cambio de estado → Perdida/encontrada`). "Marcar perdida" se alcanza por dos caminos; "Transferir" y "Editar" por dos menús.
6. **`/eventos/nuevo` mezcla 17+ formularios** rutinarios (vacuna, peso) con raros/graves (fallecimiento, mordedura, reemplazo de chip, embarazo) en un grid plano.
7. **`Anotar algo`** como label viola la regla #2 (4 verbos): vago, sin objeto.

## 2. Decisiones cerradas

- **D1 — Sin cambios de datos.** Pura reorganización de UI + rutas de acción. No toca schema, event types, ni proyecciones. (Convive con el paquete de métricas; no comparte código con `lib/metrics/`.)
- **D2 — Identidad primero, siempre.** El hero (foto, nombre, especie/raza, chip, jurisdicción) es el primer bloque visible en **todos** los estados no-terminales. Ningún banner condicional lo precede.
- **D3 — Avisos en una sola franja priorizada.** Los condicionales se agrupan en un `<PetAlertStrip>` único, ordenado por urgencia, ubicado **debajo** del hero (no arriba). Ver §3.2 para la jerarquía de urgencia.
- **D4 — Informativos no son banners.** PPP y perro de servicio dejan de ser banners full-width arriba; se vuelven *credential cards* dentro de la tab "Resumen" (alineado con el v2 spec §4.7/§4.8, que ya los modela como cards de credencial).
- **D5 — Achievements abajo.** Se mueve al final de "Resumen", "solo cuando aplique" — cumpliendo el v2 plan original.
- **D6 — Un componente de recordatorios.** Consolidar en `PetReminders` (el que tiene el wiring `deleteVaccineReminderAction`); portar lo que falte de `PetVaccineReminders` y borrarlo.
- **D7 — `/anotar` es el hub canónico único (resuelto).** El `EventCatcher` ya cae en `/anotar` como fallback y `/anotar` ya agrupa las opciones por categoría — es el catálogo. `/eventos/nuevo` es el catálogo **duplicado** y pasa a ser **redirect permanente a `/anotar`** (mismo patrón ya usado por `/libreta`, `/historial`, `/vacunas`). El perfil expone **una sola** forma de anotar (§3.3). Ver §3.3 para el detalle de logging vs gestión.
- **D8 — Tabs es el modelo final del timeline (resuelto).** El timeline vive como pestañas dentro del perfil (Resumen/Libreta/Vacunas/Historial). Las rutas viejas ya redirigen a `?tab=`. Se cierra el v2 spec marcando "timeline = tab" y se elimina la redacción "sacar timeline a rutas".
- **D9 — Lost cockpit no es un callejón (resuelto).** En estado `lost`, el cockpit de búsqueda es lo primero, pero el dueño conserva acceso al perfil normal: puede seguir registrando eventos y ver la libreta vía un link "ver perfil completo". El cockpit no oculta las acciones, las desprioriza.
- **D10 — `/inicio` agrega, el perfil detalla (resuelto).** Los nudges de Item 5 viven en `/inicio` como resumen multi-mascota (una línea por mascota con su peor pendiente, link al perfil); el perfil es el detalle. Ambos leen la misma derivación (`fetchPetHealthStatus`, Item 5) — una sola definición de "vencido".

## 3. El rediseño

### 3.1 Orden de la pantalla (estado normal)

```
[ back-link ]
HERO  (identidad: foto, nombre, especie·raza, chip ✓, jurisdicción, tags)   ← SIEMPRE primero
PetAlertStrip  (franja compacta de avisos críticos, ordenada por urgencia; colapsable)
PetQuickActions  (2–3 acciones más usadas)
Tabs:  Resumen · Libreta · Vacunas · Historial(n)
  └ Resumen:
       01 Estado de salud (current-state)
       02 Cuidados próximos (recordatorios + turnos + dosis pendientes)
       03 Credenciales (PPP card, Perro de servicio card — solo si aplica)
       04 Casos (resumen de casos abiertos, link al detalle)
       Logros (al final, solo si hay)
```

### 3.2 `<PetAlertStrip>` — jerarquía de urgencia

Un solo contenedor que ordena los condicionales por severidad (reusa los tonos `urgent | warning | info` ya definidos en el patrón `*_signal` de AGENTS.md):

| Orden | Aviso | Tono | Por qué |
|---|---|---|---|
| 1 | Observación antirrábica activa (`RabiesObservationBanner`) | urgent | Período legal de 10 días; máxima prioridad sanitaria |
| 2 | En tránsito / custodia (`TransitBanner`) | warning | Estado de tenencia anómalo |
| 3 | Caso(s) abierto(s) (`PetOpenCasesSection` → resumen) | warning | Acción pendiente del dueño/autoridad |
| 4 | Embarazo en curso (`PregnancyInProgressCard` → resumen) | info | Estado clínico temporal |

PPP y perro de servicio **salen** de la franja (son credenciales permanentes, no avisos) → §3.1 sección 03.

### 3.3 Consolidación de hubs de acción (D7 resuelto)

Modelo: **`/anotar` es el único catálogo; el perfil tiene una sola entrada para anotar; logging y gestión quedan separados.**

- **`/anotar` = hub canónico único.** Ya agrupa por categoría (`ALL_CAPTURE_OPTIONS` + registry) y ya es el destino del fallback del `EventCatcher` (`/anotar?text=…`) y de los chips (`buildAnotarUrl → /anotar?kind=…`). Se mantiene como el catálogo, agrupado por familia: *Rutina* (vacuna, antiparasitario, peso) · *Clínico* (consulta, clínico, medicación inicio/fin, esterilización) · *Identidad/legal* (microchip, reemplazo de chip, tatuaje, atestar raza) · *Eventos graves* (fallecimiento, mordedura, embarazo) · *Gestión* (editar, transferir, devolución, buscar hogar, marcar perdida).
- **`/eventos/nuevo` → redirect permanente a `/anotar`.** Elimina el segundo catálogo agrupado (mismo patrón que `/libreta`, `/historial`, `/vacunas`). Bookmarks y links viejos siguen andando.
- **El perfil tiene UNA sola forma de anotar:** el `EventCatcher` del hero (quick-capture de texto libre + chips). Su acceso "ver todas las opciones" lleva a `/anotar`. Se elimina el duplicado `"Anotar algo"` de `PetActionsMenu` como vía de logging.
- **Logging vs gestión separados.** El logging de eventos (médico/observable) entra por el `EventCatcher`/`/anotar`. Las acciones de **gestión/lifecycle** (editar, transferir, devolución, marcar perdida, buscar hogar) siguen disponibles, pero como un grupo "Gestión" claramente distinto — sourced del **mismo** `PetActionsMenu.helpers.ts` para que no haya labels/hrefs reimplementados. "Cambio de estado → Perdida/encontrada" tiene un único camino: la acción "Marcar como perdida" (flujo `/perdida`), no un ítem suelto en un catálogo de eventos.
- **Renombrar `Anotar algo`** → un verbo con objeto que cumpla la regla #2 (p. ej. "Registrar evento" / "Agregar a la libreta"). "Registrar X" sigue reservado para el evento concreto.

## 4. Relación con Item 5 (owner nudges) — D10 resuelto
Item 5 propone nudges de "vacuna vencida / falta chip" en `/inicio`, que se solapan con la sección "02 Cuidados próximos" de este perfil. **Decisión cerrada (D10):** `/inicio` = **agregador multi-mascota** (una línea por mascota con su peor pendiente, link al perfil); el perfil = **detalle**. Ambos leen la misma derivación (`fetchPetHealthStatus` de Item 5) para que no haya dos definiciones de "vencido". Item 5 y este spec se referencian mutuamente; cuando se planee Item 5, su `/inicio` debe linkear al perfil para el detalle.

## 5. Implementation

- **`components/pet-profile/PetAlertStrip.tsx`** (nuevo): recibe el estado de la mascota + eventos tipados y renderiza los avisos ordenados por urgencia; colapsable; vacío → no renderiza nada.
- **`app/(app)/mis-mascotas/[publicToken]/page.tsx`**: reordenar el JSX (hero → strip → quick actions → tabs); mover PPP/service-dog/achievements adentro de Resumen; quitar los banners sueltos de arriba.
- **`components/PetActionsMenu.helpers.ts`**: única fuente de labels/hrefs; tanto el grupo "Gestión" del perfil como `/anotar` lo consumen.
- **`app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx`**: convertir en **redirect permanente a `/anotar`** (mismo patrón que `/libreta`, `/historial`, `/vacunas`). Mover su agrupación-por-familia a `/anotar` si falta.
- **`app/(app)/mis-mascotas/[publicToken]/anotar/page.tsx`**: confirmar el agrupado por familia (Rutina / Clínico / Identidad-legal / Eventos graves / Gestión); "Cambio de estado" sale del catálogo y queda solo como acción "Marcar como perdida".
- **Recordatorios**: portar wiring faltante a `PetReminders`, borrar `PetVaccineReminders`.
- Reusar tonos/`Op*`/poncho existentes; sin componentes de chrome nuevos salvo `PetAlertStrip`.

## 6. Test plan (test-first)

- **Orden del perfil** (`__tests__` o test de componente): con una mascota en tránsito + PPP + caso abierto, el primer bloque visible es el hero; `PetAlertStrip` aparece después; PPP/servicio/logros caen dentro de Resumen, no arriba.
- **PetAlertStrip**: orden por urgencia correcto (rabia antes que tránsito antes que caso); strip vacío no renderiza.
- **Hub único**: existe exactamente una ruta para "Marcar como perdida" (assert que `/eventos/nuevo` ya no la ofrece y que `/anotar`/acción canónica sí); `/anotar` y `PetActionsMenu` derivan del mismo helper (snapshot de items idéntico).
- **Recordatorios**: un solo componente referenciado; el wiring de borrar recordatorio sigue funcionando.
- **Estados**: memorial sigue con su early return; el lost cockpit conserva acceso al perfil normal (D9) — assert que desde el cockpit hay un link "ver perfil completo" y que registrar evento / ver libreta siguen accesibles mientras está perdida.

## 7. Docs to update (same PR)

- `AGENTS.md` → **Design rules (UI conventions)**: agregar una 5ª convención "Orden del perfil de mascota: identidad → avisos (strip priorizado) → acciones → tabs; credenciales y logros dentro de Resumen".
- `docs/superpowers/specs/2026-05-19-pet-profile-v2-design.md`: cerrar el conflicto — anotar "timeline = tab (v2.1)" y que PPP/servicio son cards en Resumen.
- `docs/superpowers/README.md`: fila ✅ + SHA.
- Header de `page.tsx`: actualizar el comentario "hybrid swap" para reflejar el orden v2.1.

## 8. Lo que NO está acá

- Sin cambios de datos / event types / proyecciones.
- Sin rediseño visual de tokens ni del hero (solo posición/orden).
- Sin tocar el memorial/deceased ni la lógica del lost cockpit más allá de lo que decida §9 Q4.
- Sin construir Item 5 — solo se acuerda la división agregador/detalle.

## 9. Decisiones (cerradas 2026-06-18)

Las cinco preguntas abiertas se resolvieron con el dueño del producto:

1. **Banners arriba del hero** → **Hero primero + `PetAlertStrip` priorizado** debajo (D2/D3). PPP/servicio pasan a credential cards en Resumen (D4).
2. **Modelo del timeline** → **Tabs es el modelo final** (D8). Se cierra el v2 spec con esta decisión.
3. **Hub canónico de acción** → **`/anotar` es el hub único** (D7). El `EventCatcher` ya cae ahí; `/eventos/nuevo` redirige a `/anotar`; el perfil tiene una sola forma de anotar; logging y gestión quedan separados.
4. **Lost cockpit** → **Cockpit + acceso al perfil normal** (D9). No es un callejón; el dueño sigue registrando eventos y viendo la libreta.
5. **Item 5 vs perfil** → **`/inicio` agrega, el perfil detalla** (D10), lectura compartida.

---

## Próximo paso
Decisiones cerradas → listo para plan ejecutable. Sugerencia de fases: **Fase 1** reorder hero + `PetAlertStrip` (sin dependencias); **Fase 2** redirect `/eventos/nuevo → /anotar` + entrada única de anotar en el perfil + agrupar `/anotar`; **Fase 3** consolidar recordatorios + mover credenciales/logros dentro de Resumen + cerrar el v2 spec; **Fase 4** docs (5ª regla en AGENTS.md, header del `page.tsx`). Cuando quieras, escribo el `plans/` con este desglose.
