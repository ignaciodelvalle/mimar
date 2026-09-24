> **▶ ARCHIVADO 2026-08-04** — triage de planes: el trabajo que describe está shippeado (verificado contra el árbol). Se conserva por su método y su evidencia; como plan de trabajo, está cerrado.

# Plan: Admin portal — fresh sweep fixes (post Fases 0-2)

> **Para Claude Code — ejecución autónoma.** Barrido en vivo de **todas** las pantallas admin sobre el branch
> actual (local), después de que CC cerrara Fases 0-2 y parte de la 3. Verifica qué quedó arreglado y deja los
> **residuos + hallazgos nuevos** como ítems ejecutables. Extiende la
> [`2026-06-20-ux-audit-remediation.md`](./2026-06-20-ux-audit-remediation.md) (sobre todo Fase 0.4, 3.4 y 3.6).
> Severidad: 🔴 bloqueante · 🟡 fricción · 🟢 polish. SDD test-first, docs en el mismo PR.

## Verificado FIXED (no rehacer)
- **Breadcrumbs route-driven** (#683): el topbar ya no es el stub "Panel" — muestra "Dashboard › Cola", etc. ✅
- **Outbox**: filtro de provincia ahora es `<select>` (era free-text) + copy con acentos. ✅
- **Dos páginas de auditoría diferenciadas**: `/admin/auditoria` = "Auditoría global"; `/admin/historial` = "Mi historial" (self-scope). ✅ (#687)
- **KPIs con dot de estado** (no-solo-color) en panel/sistema/usuarios. ✅ (#689)
- **Omnibox** descopeado a "Buscar persona o caso" (mascotas fuera de la búsqueda operador). ✅ (#682)
- **Warning de regla PPP** con acentos ("evalúan… dueños… notificación"). ✅
- **RuleImpactBanner** ya no falla en silencio (muestra fallback). ✅ *(pero ver A2 — no calcula)*

## Hallazgos (residuos + nuevos)

| # | Hallazgo | Sev | Ubicación / evidencia | Fix |
|---|---|---|---|---|
| A1 | **`not-found.tsx` branded solo cubre `(public)`.** `/admin/*` (y probablemente `/gob`, `(app)`) caen en el **404 negro en inglés** de Next. Confirmado: `/admin/zzz-no-existe` → "404 · This page could not be found". | 🟡 | falta `app/admin/not-found.tsx` (y gob/app); existe solo `app/(public)/not-found.tsx` | Agregar `not-found.tsx` por route-group (admin, gob, `(app)`) reusando el componente branded de `(public)`. Extiende el fix 0.4. |
| A2 | **RuleImpactBanner no calcula el impacto.** Muestra "No se pudo calcular el impacto estimado. Podés continuar igual." aun con mascotas de seed en Buenos Aires → debería contar. El operador crea una regla PPP **province-wide que notifica dueños** sin ver el blast radius. | 🟡 | `components/admin/RuleImpactBanner.tsx` + la action de preview de impacto; `/admin/jurisdicciones/.../reglas/nueva?ruleType=ppp_breed_list` | Trazar el throw del cálculo (query de pets que matchean razas × jurisdicción); que muestre el número real (≥0). El fallback queda como red de seguridad. |
| A3 | **Pasada de localización es-AR (#695) incompleta.** Faltan acentos en varias pantallas admin/gob de gestión. | 🟡 | `/admin/sistema` ("Metricas", "Mas vieja (dias)"); `/gob/organizaciones` ("Busca", "razon social", "Revocar verificacion", "desde aca"); `/admin/servicios` ("revision", "aca"); `/admin/govts/new` ("recibira", "unico", "mas", "pagina"); `/admin/auditoria` título "Auditoria"; rule form ("raza no estandar", "Cimarron") | Completar acentos en esas pantallas. **Y** sumar el lint de copy es-AR de [`2026-06-21-design-system-hardening.md`](./2026-06-21-design-system-hardening.md) Fase A para que no recurra. |
| A4 | **Breadcrumb usa segmentos crudos/en inglés.** El crumb route-driven muestra "Govts", "New", "Detalle", "Admins" en vez de labels localizados. | 🟢 | topbar `OpCrumbs` (`components/ui/dashboard/*`) / la derivación de crumbs de gob/admin layout | Mapa segmento→label localizado ("govts"→"Gobiernos", "new"→"Nueva cuenta", "admins"→"Administradores", evitar "Detalle" genérico). |
| A5 | **`/admin/auditoria` muestra el action-code crudo** ("pet_events_mutation_override") mientras `/admin/historial` lo renderiza humano ("Mutación forzada de evento de mascota (override)"). El mapa label **ya existe** (lo usa historial). | 🟢 | `app/admin/auditoria/*` vs `app/admin/historial/*` | Aplicar el mismo mapa action→label de historial a las filas de auditoría (raw code en hover/tooltip si se quiere conservar). |
| A6 | **Forms de creación de cuenta sin marcador `*` requerido.** `/admin/govts/new` (Email, Nombre de display) y probablemente `/admin/admins/new`. | 🟢 | `app/admin/govts/new/*`, `app/admin/admins/new/*` | Rutear por el field kit (`LnField`/`OpField`) — required `*` + aria (cierra el residuo de 1.5 en estas forms). |
| A7 | **Cuentas de sistema mezcladas con humanas.** `system:backfill-*` aparecen en la lista de `/admin/admins` sin distinción. | 🟢 | `app/admin/admins/*` | Agrupar/filtrar "Cuentas de sistema" en una sección o toggle, separadas de los admins humanos. |

## Cobertura del barrido (para que no quede ninguna afuera)
Recorridas en vivo: `/admin` (panel), `cola` (→`/gob/cola`), `casos`, `moderacion`, `observaciones`, `sistema`,
`outbox`, `auditoria`, `historial`, `usuarios` (→`/gob/usuarios`), `organizaciones` (→`/gob/organizaciones`),
`jurisdicciones/.../reglas/nueva`, `govts/new`, `admins`, `servicios`. Las colas estaban **vacías** (seed limpio)
→ correr `seed:panorama` ([`2026-06-21-panorama-demo-dataset.md`](./2026-06-21-panorama-demo-dataset.md)) para
testear las pantallas con volumen real (cola, casos, observaciones, moderación, outbox).
**WIP:** `/admin/panorama` hoy da 404 (CC lo está construyendo) — no se critica.
Sub-páginas de detalle (`[id]`/`[token]`/`[userId]`) no se abrieron una por una (las listas/forms padre sí);
revisarlas cuando haya datos sembrados.

## Ejecución (orden sugerido, autónomo)
1. **A1** (not-found por group) y **A2** (impact banner) — los dos 🟡, mayor impacto.
2. **A3** (localización + lint que lo previene) — junto con Fase A del plan de design-system.
3. **A4, A5** (crumbs + action labels) — baratos, mejoran legibilidad operador.
4. **A6, A7** (forms required + cuentas de sistema) — polish.

## Tests
- A1: e2e `GET /admin/zzz-no-existe` → 200/404 con copy español branded + link de salida (no "This page could not be found").
- A2: integración — con seed de pets en una provincia, el preview de impacto de `ppp_breed_list` devuelve un entero ≥0 (no el fallback de error).
- A3: el lint de copy es-AR pasa en verde sobre admin/gob; smoke visual de las 6 pantallas.
- A4: unit — el mapa de crumbs devuelve labels localizados; e2e snapshot del crumb en `/admin/govts/new`.
- A5: unit — auditoría usa el mismo formatter que historial.
- A6: axe sobre las forms de creación (required + label asociado).

> Al cerrar, marcar en `docs/superpowers/README.md` (extiende Fase 3.6 de la remediación).
