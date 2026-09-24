# SDD: Portal gov — reuso/adaptación de dashboards admin para visibilidad del rol govt

> **Auditoría + diseño (no toca código todavía).** Objetivo: dar al rol **govt** visibilidad sobre la data de SU
> jurisdicción reusando o adaptando los dashboards que hoy solo ve el admin (global). Audita TODOS los
> `app/admin/*` y los clasifica **R** (reusable tal cual) · **A** (adaptable) · **M** (admin-meta, no portar) ·
> **D** (duplicado — gob ya lo tiene). Evidencia verificada contra el working tree.

## El primitivo que habilita todo
- `requireAdminOrGovtOrRedirect()` (`lib/auth-guards.ts:78`) devuelve `jurisdictions` desde `govt_assignments`
  (vacío = admin universal). Es la primitiva de scoping de gov.
- Patrón probado (gob/censo, gob/analytics, gob/page): resolver jurisdictions → `filteredJurisdictions`
  (intersectado con las asignaciones reales, un govt no puede ampliar scope) → `buildProjectionContext(actor,
  filteredJurisdictions, period)` → fetchers. Los fetchers cortocircuitan admin (universal) y aplican
  `petsScopeClause(ctx)` para govt.
- **La mayoría de los fetchers de `lib/metrics/*` ya son `ProjectionContext`-scoped** → por eso tantos dashboards
  admin son reusables: el admin los llama con ctx universal, gob los llama con ctx scopeado.
- **Excepción — fetchers global-only** (`lib/admin-metrics.ts`, sin scope): `fetchUserMetrics`, `fetchQueueHealth`,
  `fetchDecisionsMetrics`, `fetchGovtActivity`, `fetchCronRuns`. Son counts de plataforma; no scopeables sin params nuevos.

## Matriz de clasificación

| Ruta admin | Clase | Justificación + nota de scoping |
|---|---|---|
| `/admin/censo` | **D** | gob/censo ya existe, scopeado. El extra admin (ranking cross-provincia) es universal-only. |
| `/admin/poblacion` | **D** | gob/poblacion existe, scopeado. |
| `/admin/adopciones` | **D** | gob/adopciones existe, scopeado. |
| `/admin/panorama` | **D** | gob/panorama existe; mismos fetchers, `requireAdminOrGovtOrRedirect`. |
| `/admin/cola` | **D** | gob/cola existe (`fetchVisiblePendingRequests`). |
| `/admin/casos` | **D** | gob/casos existe; el admin incluso redirige al govt allí. |
| `/admin/usuarios` | **D** | gob/usuarios existe; `searchUsers` ya soporta scope govt. |
| `/admin/organizaciones` | **D** | gob/organizaciones existe; `searchOrganizations` ya scopeado. |
| `/admin/servicios` | **D** | gob/servicios existe. |
| `/admin/historial` | **D** | gob/historial existe; ambos self-scoped (`actorUserId = user.id`). |
| `/admin/observaciones` | **D** | Mismo archivo ya sirve a ambos roles (`requireAdminOrGovtOrRedirect`, filtra por jurisdictions). Ya es compartido. |
| **`/admin/programa`** | **A** | **Mayor valor para gov.** Resumen ejecutivo scopeado. Casi todos los fetchers ya son ctx. **Bloqueante:** `fetchPiiOversight` NO scopea → fuga cross-tenant (ver gaps). Sacar/gated los cards global-only (`fetchQueueHealth`/`fetchCronRuns`). Outliers cross-provincia → reframe a "tus provincias" o ocultar. |
| **`/admin/sistema`** | **A** | Salud operativa de la cola/SLA propios. `fetchEnoSla(ctx)` ya es scope-aware. Necesita variante scopeada de queue-health; dropear cron health + roster per-govt (admin-meta). |
| **`/admin/outbox`** | **A** | La tabla tiene `targetJurisdictionProvince/Locality` + ya hay filtro por provincia. Variante gov agrega `WHERE target_jurisdiction IN (assignments)`. Riesgo bajo (metadata de notificación, sin PII). |
| `/admin/auditoria` | **A (privacy-gated, diferir)** | Oversight de operadores propios es legítimo, PERO `audit_log` **no tiene columna de jurisdicción** — solo `actorUserId`. Scope seguro = "acciones de actores asignados a mi jurisdicción" (join derivado) — no existe hoy. No portar hasta tener ese modelo. |
| `/admin/moderacion` | **A/M (diferir)** | Reportes anónimos flaggeados. Portable si `welfare_reports` lleva jurisdicción (verificar); la moderación anti-abuso es arguablemente función de plataforma. Lean M salvo decisión de producto. |
| `/admin/govts` | **M** | Gestión de cuentas govt = administración de plataforma. Nunca portar. |
| `/admin/admins` | **M** | Gestión de cuentas admin. Nunca portar. |
| `/admin/jurisdicciones` | **M** | Editor de business rules = autoridad nacional; gob tiene read-only `/gob/reglas`. |
| `/admin` (home) | **M/D** | Home de gestión + KPIs de plataforma; gob ya tiene su home scopeado. |

## Plan de visibilidad gov (orden recomendado)
1. **`/gob/programa`** (esfuerzo M) — resumen ejecutivo scopeado. ~80% copia de `/admin/programa` con swap a ctx scopeado + 3 cards sacados/scopeados. **Gated** en arreglar/omitir `fetchPiiOversight`.
2. **`/gob/outbox`** (S) — el más barato; las columnas ya existen, solo agregar el WHERE de jurisdicción.
3. **`/gob/sistema`** (M) — ENO SLA (ya scopeado) + cola/aging scopeado; necesita un `fetchQueueHealthScoped(jurisdictions)`.
4. **`/gob/auditoria`** (L) — solo después de un modelo de scope de auditoría (gap 3).

**NO exponer a gov (límites de autoridad/privacidad):** `/admin/govts`, `/admin/admins`, el editor de `/admin/jurisdicciones`, el PII-oversight sin scopear, el roster per-govt, internals de cron, métricas de usuarios de plataforma, el audit log global.

## Gaps / ajustes ("ajustá si falta algo")
1. **Scopear `fetchPiiOversight(ctx)`** (`lib/metrics/program-health.ts:372`) — hoy filtra solo por período, devuelve TODOS los actores → **fuga cross-tenant si se porta tal cual**. Para gov: restringir a actores dentro de la jurisdicción (join `actorUserId → govt_assignments`) o, para v1, omitir el card. **Bloqueante de la Slice 1.**
2. **Agregar `fetchQueueHealth(jurisdictions)` scopeado** para los buckets de aging de `/gob/sistema`. `fetchDecisionsMetrics`/`fetchUserMetrics` solo si gov quiere esos tiles (recomendado: dropear, admin-meta).
3. **`audit_log` sin dimensión de jurisdicción** → bloqueante de `/gob/auditoria`. Introducir un scope-helper (actores-en-mi-jurisdicción y/o registro-objetivo-en-mi-jurisdicción).
4. **Verificar columnas de jurisdicción en `welfare_reports`** antes de decidir si `/admin/moderacion` es portable.
5. **Reusar el patrón de capability** (`hasAnalyticsRead = admin || (govt && jurisdictions.length>0)`) en cada página gov nueva → empty state "Sin acceso/localidades" para govts sin asignaciones.
6. **Extraer `resolveScopedJurisdictions(searchParams, jurisdictions, role)`** — el bloque de narrowing está duplicado en gob/censo, gob/analytics, gob/home; antes de agregar 3 páginas gov más, extraerlo para evitar drift.

> Sin schema (salvo, eventualmente, una columna/derivación de jurisdicción para auditoría). El grueso es route + guard + ctx scopeado + reuso de fetchers existentes.
