# Plan: Admin portal — remediación de la revisión ejecutiva

> **Para Claude Code — ejecución 100% autónoma.** Remediación de la auditoría ejecutiva del perfil **admin**
> (scope universal) del 2026-06-22. Fuente de hallazgos: [`docs/admin-design-critique-2026-06-22.md`](../../admin-design-critique-2026-06-22.md).
> No requiere decisiones de producto pendientes: las dos que existían ya se resolvieron (ver "Decisiones tomadas").
> Severidad: 🔴 correctitud/seguridad · 🟡 fricción/UX · 🟢 polish. **SDD test-first** (AGENTS.md), docs en el mismo PR.
>
> **Antes de tocar código, leer:** (1) el slim index de [`AGENTS.md`](../../../AGENTS.md) (~1.5k tokens) y, para cualquier
> ítem que toque una ruta pública / token / campo PII, la sección [§ Privacidad y manejo de datos](../../../AGENTS.md#privacidad-y-manejo-de-datos);
> (2) el doc de critique linkeado arriba; (3) este plan entero antes de abrir el primer PR.

## Decisiones tomadas (no relitigar)
1. **IA / contradicción del landing (C25):** admin **y** gob operan las colas/usuarios/orgs compartidas. Las rutas
   `/admin/cola`, `/admin/usuarios`, `/admin/organizaciones` **existen y se quedan**. El fix es **corregir el copy stale**
   del landing y el callout — **no** remover funcionalidad del nav ni los KPIs.
2. **Alcance:** se remedia **todo** (🔴 + 🟡 + 🟢). Lo que ya está planificado en otro doc se **cross-referencia**, no se duplica.

## Cross-ref — no rehacer (ya cubierto por otro plan)
Estos hallazgos del critique **se solapan** con [`2026-06-22-admin-fresh-sweep-fixes.md`](./2026-06-22-admin-fresh-sweep-fixes.md).
Ejecutar allá; acá solo se listan para trazabilidad:
- **Acentos / inglés residual en UI es-AR** (critique §4 "Acentos / idioma", "flagged") ↔ fresh-sweep **A3**.
- **Action-code crudo en `/admin/auditoria`** (parte de C12) ↔ fresh-sweep **A5** (el mapa label ya existe en `historial`).
- **Cuentas `system:` mezcladas con humanas** (parte de C21) ↔ fresh-sweep **A7**.
Si el fresh-sweep ya se ejecutó, verificar que cerró y seguir; si no, ejecutarlo **antes** de PR-7 y PR-9 de este plan.

## Cómo verificar las ubicaciones
**Verificado en vivo el 2026-06-22:** los 40 hallazgos (C1–C40) fueron confirmados contra el working tree; los
anclas (símbolo + quote) son exactos a esa fecha. Aun así el código se mueve: **anclar por símbolo + quote**, no
solo por número de línea (los `:NN` son pistas). Confirmar con `grep`/`Read` antes de editar. Para probar pantallas
con volumen real (cola, casos, observaciones, moderación, outbox) correr `pnpm seed:panorama`
([`2026-06-21-panorama-demo-dataset.md`](./2026-06-21-panorama-demo-dataset.md)) — con seed limpio las colas están
vacías y no se ve el comportamiento a escala.

---

## Hallazgos completos

| # | Hallazgo | Sev | Ubicación / evidencia | Fix |
|---|---|---|---|---|
| **C1** | **`/admin/cola` sin `LIMIT` ni paginación.** Selecciona *todas* las filas `status='pending'` y `BulkApprovalQueueList` las renderiza con checkbox + "Seleccionar todo". Única cola universal de todas las jurisdicciones → la más propensa a crecer sin techo (casos=500, outbox=200 sí limitan). | 🔴 | `app/admin/cola/page.tsx` (query `where status='pending'`, sin `.limit()`) | Paginación keyset + `count(*)` separado del fetch. Reusar el patrón de `listOpenCasesForAdminPreview` (`lib/case-queries.ts`, separa agregado de filas). |
| **C2** | **Banner de breach del Outbox cuenta solo la página visible.** `breachCount` se deriva de `rows` (≤200); la pantalla que vigila el SLA A7 **sub-reporta** cuando hay breaches más allá de la página 1. El badge del nav (`layout.tsx`) sí hace `count(*)` global → **los dos números no coinciden**. | 🔴 | `app/admin/outbox/page.tsx` (`const breachCount = rows.filter(...)`, banner "en incumplimiento de SLA") vs `app/admin/layout.tsx:26-35` | `count(*)` agregado para el banner (mismo predicado que el badge del nav: `status='pending' AND sla_due_at < now()`). |
| **C3** | **Logging de consultas PII fire-and-forget.** `void logPiiQueryForAuthority(...)` sin `await` → la promesa puede perderse si la función retorna antes. Debilita la garantía de auditoría (Ley 25.326). | 🔴 | `app/admin/usuarios/page.tsx` (`void logPiiQueryForAuthority`), `app/admin/organizaciones/page.tsx` (ídem) | `await` el log **antes** de devolver resultados. Verificar que no rompa el render (mover el await arriba del fetch si hace falta). |
| **C4** | **"Resetear credentials" dispara en 1 clic, sin confirmación ni motivo.** Rota las credenciales del operador vivo (lo desloguea). Toda desactivación exige motivo+evidencia → fricción invertida. | 🔴 | `app/admin/_components/ResetCredentialsButton.tsx` (`handleReset` → `resetInstitutionalCredentialsAction`) | Modal de confirmación + campo motivo (alinear con los flujos de desactivación). Loguear el motivo al audit. |
| **C5** | **Aprobación masiva sobre tipos heterogéneos.** "Seleccionar todo" aprueba matrículas vet, verificación de orgs y credenciales RUPGA juntas, pese a que el detalle dice que RUPGA requiere verificación CUD out-of-band. | 🟡 | `BulkApprovalQueueList` (usado en `app/admin/cola/page.tsx`); detalle `app/admin/cola/[publicToken]/page.tsx` (nota RUPGA) | Confirmar por tipo, o excluir del bulk los tipos de alto riesgo (RUPGA), o exigir confirmación con desglose por tipo. |
| **C6** | **Cierre `positive_rabies` sin confirmación.** Declara rabia positiva desde un `<select>` plano y dispara notificaciones al submit. Menos fricción que el flujo de fraude de chip (que sí tiene bloque rojo). | 🟡 | `app/admin/observaciones/[publicToken]/CloseObservationForm.tsx` (option "POSITIVO — rabia confirmada") | Confirmación tipada (escribir/confirmar) para el resultado positivo, dado el impacto de salud pública. |
| **C7** | **"Confirmar como spam": dos pasos pero sin confirmación de irreversibilidad.** Click revela textarea (exige ≥10 chars) y submit-ea `confirmWelfareAsSpamAction` → marca la denuncia `status='invalid'` y navega al instante. No advierte que deja history inválido permanente. (Verificado: `setMode("spam")` → panel con `notes.trim().length < 10` gate.) | 🟡 | `app/admin/moderacion/[id]/ModerationActions.tsx` (líneas ~56, 65-92) | Sumar advertencia de irreversibilidad explícita antes del submit (no solo el gate de nota). |
| **C8** | **Borrar regla de jurisdicción sin captura de motivo.** Inline confirm de 2 clics sin razón; des-flaggea mascotas. El resto de acciones auditadas exige motivo. | 🟡 | `app/admin/jurisdicciones/[country]/[province]/[locality]/reglas/DeleteRuleButton.tsx` | Capturar motivo + confirmar; loguear al audit. |
| **C9** | **Guardar lista de razas PPP notifica masivamente a dueños sin gate de impacto.** El `RuleImpactBanner` es informativo; nada obliga a reconocer el blast radius antes de disparar evaluación + notificaciones. (Depende de fresh-sweep **A2**: el banner hoy no calcula.) | 🟡 | `app/admin/jurisdicciones/.../reglas/nueva/PppBreedListForm.tsx` | Confirmación que muestre "N mascotas / N dueños afectados" antes de guardar. Requiere A2 cerrado (banner calculando). |
| **C10** | **Borrar suscripción de alerta sin confirmación.** Botón "Eliminar" en un `<form>` directo. | 🟢 | `app/admin/programa/page.tsx` (form `deleteAlertSubscriptionAction`) | Confirmación inline de 2 pasos. |
| **C11** | **Detalle de auditoría vacía el audit trail.** `admins/[userId]` y `govts/[userId]` **seleccionan** `payload` (y `revocationReason`) pero renderizan **solo** el código de acción + fecha. Se pierde quién/por qué/evidencia. | 🔴 | `app/admin/admins/[userId]/page.tsx` (select payload, render solo `action`), `app/admin/govts/[userId]/page.tsx` (ídem + `revocationReason` no mostrado en localidades revocadas) | Renderizar motivo, actor (`actor_user_id`) y evidencia en el detalle. |
| **C12** | **Filas de auditoría sin contexto de target/objeto.** `targetUserId` se selecciona pero no se muestra; solo un `approvalRequestId` truncado sin link. El auditor ve "Aprobó solicitud" pero no a quién/qué. (Action-code crudo ↔ fresh-sweep **A5**.) | 🟡 | `app/admin/auditoria/page.tsx` (render de filas) | Mostrar target + link a la entidad afectada (reusar la resolución de token de `historial`). |
| **C13** | **`JSON.stringify(payload)` como única vista de aprobaciones vet/org.** El reviewer lee matrícula/jurisdicción desde JSON crudo en un `<pre>`. | 🟡 | `app/admin/cola/[publicToken]/page.tsx` (`<pre>{JSON.stringify(request.payload)}</pre>`) | Tarjetas estructuradas por tipo de request (matrícula, colegio, jurisdicción, estado de verificación), con link para verificar contra el colegio provincial. |
| **C14** | **UUIDs crudos como identificador en UI de operador.** Pet sujeto en moderación, actor PII en programa, `user.id` en búsqueda de usuarios — todos `font-mono` sin link ni utilidad. | 🟡 | `app/admin/moderacion/[id]/page.tsx` (`subjectPetId`), `app/admin/programa/page.tsx` (actor PII), `app/admin/usuarios/page.tsx` (`user.id`) | Convertir en links a la entidad cuando aplique; si no, esconder. Moderación: link a una vista de pet de operador (ver C17). |
| **C15** | **SQL crudo y action-codes en inglés en una UI en español.** Fórmulas SQL en footnotes/KPIs de `adopciones`; `row.action` crudo (`pii_queried`) en el panel de oversight de `programa`. | 🟢 | `app/admin/adopciones/page.tsx` (footnotes `COUNT(...) WHERE ...`), `app/admin/programa/page.tsx` (oversight PII, `{row.action}`) | Mover el SQL a los tooltips `info.formula` (no al cuerpo visible); traducir los action-codes con el mapa de `historial`. |
| **C16** | **Source-event del Outbox: UUID truncado sin link (TODO auto-documentado).** Comentario en código: "historial integration can be added when the detail page exposes the event context". | 🟢 | `app/admin/outbox/page.tsx` (columna source-event + comentario TODO) | Linkear a `/admin/historial` (o al detalle del evento) una vez expuesto el `petId`/contexto; cerrar el TODO. |
| **C17** | **`/admin/casos` linkea la mascota a `/mis-mascotas/[token]`** — la superficie **privada del dueño**. O 404ea para el admin (dead-end) o expone la vista del owner. Cruza el límite de superficie (AGENTS.md §Design rules, §Aggregation). | 🟡 | `app/admin/casos/page.tsx` (`href={\`/mis-mascotas/${c.primaryPetPublicToken}\`}`) | Linkear a una vista de pet de **operador** (la pública `/p/[token]` o una vista operador), no a `/mis-mascotas`. |
| **C18** | **Copy promete "Buscar por nombre o DNI" pero el DNI no se busca.** `admin-search.ts` solo busca por `display_name` (DNI removido en Item 25a). Tipear un DNI → "Sin resultados" sin explicación. | 🟡 | `app/admin/usuarios/page.tsx` (placeholder + header "por nombre o DNI"); `lib/admin-search.ts` (`searchUsers` solo `display_name`) | Corregir el copy a "por nombre". (No reintroducir DNI en texto plano — invariante de AGENTS.md.) |
| **C19** | **Eyebrow "Admin · Vigilancia" hardcodeado en 3 lugares, en un componente compartido admin/govt.** La página usa `requireAdminOrGovtOrRedirect` (línea 43) pero el eyebrow dice "Admin · Vigilancia" en las líneas 65, 102 y 158 → el viewer **govt** ve "Admin". | 🟢 | `app/admin/observaciones/page.tsx` (eyebrow estático ×3) | Derivar el eyebrow de `profile.role`, no hardcodear "Admin". |
| **C20** | **Magic link en texto plano, copiable, con TTL hardcodeado.** Credencial de aprovisionamiento renderizada en el DOM (sobrevive a screenshots/screenshare); "expira en 24h" string fijo no derivado del TTL real; `catch{}` de clipboard sin feedback; título "Cuenta institucional creada" aun cuando se reusa para reset. | 🟡 | `app/admin/_components/MagicLinkResultPanel.tsx` | Ocultar tras "Revelar"; derivar el TTL real del token; feedback en fallo de copia; título contextual (creación vs reset). |
| **C21** | **`listUsers({ perPage: 200 })` como techo en rosters.** Más allá de 200, emails en blanco y rompe la heurística `email.startsWith("system:")` que alimenta el filtro del roster **y** (indirecto) el guard de "último admin". (Separar cuentas system ↔ fresh-sweep **A7**.) | 🟡 | `app/admin/admins/page.tsx` (`listUsers({ perPage: 200 })`), `app/admin/govts/page.tsx` (ídem) | Paginar la enumeración de auth users; reemplazar la heurística `system:` por un flag en DB (`profiles.is_system` o equivalente). |
| **C22** | **Guard de "último admin" cuenta cuentas `system:`.** Verificado: `activeCount` filtra `role='admin' AND account_type='institutional' AND deactivated_at IS NULL` (líneas 53-62) **sin excluir service accounts** → podría permitir desactivar al **último admin humano** mientras un `system:` mantiene el count ≥ 2. Contradice AGENTS.md:194 ("siempre ≥1 admin activo" = humano). | 🔴 | `app/admin/admins/[userId]/page.tsx` (`activeCount`, líneas 53-62) | Excluir cuentas de sistema del conteo del guard (usar el flag de C21). Test: no se puede desactivar al último admin humano aunque exista un `system:`. |
| **C23** | **Evidencia subida a Storage al elegir archivo, huérfana al cancelar.** Los 3 flujos con evidencia suben al bucket `revocations` **antes** del submit, sin limpieza en cancelar; namespaceadas por actor, no por target. | 🟡 | `app/admin/admins/_components/DeactivateAdminForm.tsx` (`handleFilesChange` → upload), `app/admin/govts/_components/DeactivateGovtForm.tsx`, `app/admin/govts/_components/RevokeLocalityRowActions.tsx` | Subir en el submit (o limpiar en cancelar/expirar). Namespacear por target. |
| **C24** | **Govt activo con 0 localidades no se marca.** Un govt activo sin `govt_assignments` activos no puede entrar a `/gob` (AGENTS.md:203) pero el roster lo muestra "Activo · 0 localidades" — cuenta muerta no señalada. | 🟢 | `app/admin/govts/page.tsx` (`activeLocalityCount`) | Badge "sin localidades — no puede operar" cuando count=0. |
| **C25** | **Landing contradice el nav (decisión tomada: corregir copy).** El copy dice que cola/usuarios/orgs "viven en el portal de Gobierno" mientras los KPIs linkean a `/admin/*` y el nav los lista. | 🔴 | `app/admin/page.tsx` (header `:43-44` + callout "Ir a Gobierno") | Reescribir el copy: el admin opera sus propias colas/usuarios/orgs (compartidas con gob). Mantener el link a `/gob` como cambio de contexto, no como "ahí vive la cola". |
| **C26** | **Tres tiras de KPI solapadas, exec-summary enterrado.** `/admin`, `/admin/sistema` y `/admin/programa` repiten Usuarios/Cola/Decisiones/SLA. El "Resumen ejecutivo" (`programa`) — el más rico — está debajo de Censo en *Confiabilidad*. | 🟡 | `app/admin/page.tsx`, `app/admin/sistema/page.tsx`, `app/admin/programa/page.tsx`; `components/layout/nav-presets.ts` | Promover `programa` al frente (portada o primer ítem de nav). Definir una sola "home". Extraer la tira KPI a un componente compartido para evitar drift. |
| **C27** | **Taxonomía del nav mezcla analítica con fiabilidad.** *Confiabilidad* contiene Programa/Censo/Adopciones/Población (analítica) junto a Sistema/Outbox/Auditoría (ops). | 🟢 | `components/layout/nav-presets.ts` (`ADMIN_NAV_SECTIONS`) | Separar "Analítica / Programa" de "Operación / Confiabilidad". Mantener invariante: ningún `href` perdido (test del Item 1 de nav). |
| **C28** | **`decisionsDelta` (aproximación "prior7d ≈ prior23d/23*7") duplicado literal.** | 🟢 | `app/admin/page.tsx`, `app/admin/sistema/page.tsx` | Extraer a un helper en `lib/metrics` (o `lib/admin-metrics`). Test de value-pinning. |
| **C29** | **`casos` y `moderacion` sin filtros, cap 500.** Abiertas + cerradas viejas mezcladas. La vista org de casos sí soporta filtros kind+status. | 🟡 | `app/admin/casos/page.tsx`, `app/admin/moderacion/page.tsx` | Filtros status/kind/jurisdicción + búsqueda. Reusar los filtros de `listCasesForOrg` (`lib/case-queries.ts`). |
| **C30** | **Filtro `actor` de Auditoría sin input en la UI** (se lee de `searchParams` pero el form solo expone "acción"); el filtro de acción exige el **código enum inglés** mientras la fila muestra la etiqueta traducida. | 🟡 | `app/admin/auditoria/page.tsx` (`actorFilter` sin control; form solo "acción") | Cablear un input/selector de actor; filtrar acciones por dropdown de etiquetas conocidas (no texto libre en inglés). |
| **C31** | **Tablas provinciales no drilleables.** Rankings de `censo`/`poblacion` y la tabla de outliers de `programa` invitan a drill-down pero no son clickeables. | 🟡 | `app/admin/censo/page.tsx`, `app/admin/poblacion/page.tsx`, `app/admin/programa/page.tsx` (tablas) | Hacer cada fila de provincia un link a la vista filtrada (Panorama o la página con `?province=`). |
| **C32** | **`PeriodPicker defaultPreset="ytd"` vs server default `windows.trailing12m()`.** En la primera carga el chip dice "Año en curso" y los datos son de 12 meses móviles. | 🟡 | `app/admin/censo/page.tsx`, `poblacion`, `programa`, `adopciones` (mismo patrón `sp.period || sp.from ? ... : trailing12m()` + `<PeriodPicker defaultPreset="ytd"/>`) | Alinear: o el server defaultea a ytd, o el picker a trailing-12m. Una sola fuente de verdad para el período por defecto. |
| **C33** | **Meta SLA ENO: número mágico `95` vs constante.** `programa` usa `toneForTarget(onTimePct, 95)`; `sistema` usa `TARGETS.ENO_SLA_PCT`. | 🟢 | `app/admin/programa/page.tsx` vs `app/admin/sistema/page.tsx` | Usar `TARGETS.ENO_SLA_PCT` en ambos. |
| **C34** | **Estados de éxito client-only sin `router.refresh()`.** Tras desactivar/asignar/revocar, la fila vieja sigue "Activo" con botones vivos hasta recargar a mano. | 🟢 | `DeactivateAdminForm.tsx`, `DeactivateGovtForm.tsx`, `AssignLocalityForm.tsx`, `RevokeLocalityRowActions.tsx` | `router.refresh()` tras la mutación. |
| **C35** | **Señalización de severidad inconsistente.** Revocar localidad usa amarillo; desactivar admin/govt usa rojo — las tres son destructivas con evidencia. | 🟢 | `app/admin/govts/_components/RevokeLocalityRowActions.tsx` (`bg-ln-op-warn`) | Unificar el color de "destructivo auditado" (rojo). Respetar tokens de design-system. |
| **C36** | **% provincial puede sumar <100% por supresión k-anon sin nota.** En `censo`/`poblacion`, si hay provincias suprimidas, los shares no cierran sin explicación. | 🟢 | `app/admin/censo/page.tsx`, `app/admin/poblacion/page.tsx` (tablas `% del total`) | Footnote "X% suprimido por privacidad (celdas <k)". |
| **C37** | **"Tasa de retorno" de adopciones puede pasar 100%.** Numerador y denominador son conteos de períodos independientes (un reverso puede ser de una adopción de otro período). Está disclaimer-eado pero engaña en el titular. | 🟢 | `app/admin/adopciones/page.tsx` (KPI tasa de retorno) | Hacer el caveat prominente en el KPI, o cap visual a 100% con asterisco, o renombrar a "reversos / adopciones (período)". |
| **C38** | **Registries de atestación PPP serializados como 3 arrays paralelos index-aligned.** `registryId`/`registryLabel`/`registryRequired` parseados por índice → frágil ante reordenamiento. | 🟢 | `app/admin/jurisdicciones/.../reglas/nueva/PppAttestationRegistriesForm.tsx`; parser en `lib/.../business-rules.ts` | Serializar como objetos (JSON) en vez de arrays paralelos. |
| **C39** | **`jurisdicciones` index solo lista provincias; el conteo mezcla reglas de localidad.** No hay forma desde la UI de crear/ver overrides a nivel localidad (el cascade localidad>provincia>país de AGENTS.md:229); y "N reglas activas" por provincia suma reglas de barrio sin distinguir → no reconcilia con la página de reglas. | 🟡 | `app/admin/jurisdicciones/page.tsx` (itera solo `PROVINCES`; agregación por `jurisdictionProvince`) | Listar localidades con reglas; separar el conteo provincia-wide vs localidad. |
| **C40** | **`physical_credential_channels`: tipo de regla con dead-end "próximamente".** Card configurable con link "Configurar →" que termina en placeholder. | 🟢 | `app/admin/jurisdicciones/.../reglas/page.tsx`, `.../nueva/page.tsx` ("Configuracion disponible proximamente") | Ocultar el tipo del listado hasta que exista el form, o marcarlo claramente como "no disponible" (no como acción). |

---

## Secuenciación en PRs (orden de dependencia)

> Branch desde `develop`. Naming: `fix/sec-*` para 🔴 de seguridad, `fix/*` para bugs, `chore/*` para refactor/polish.
> Scope de commit: `admin` (o `metrics`, `cases`, `nav` según el área). Conventional Commits. Sin `Co-Authored-By` ni atribución AI.

### PR-1 — `fix/sec-admin-queue-counts` 🔴 (correctitud de colas y auditoría PII)
**C1, C2, C3, C22.** Lo más urgente: números que mienten + garantía de auditoría + guard de seguridad.
- C1: keyset + `count(*)` en `/admin/cola`.
- C2: `count(*)` global para el banner de Outbox.
- C3: `await` los logs PII.
- C22: excluir cuentas system del guard de último admin (puede necesitar el flag de C21 — si no está, usar exclusión por prefijo como stopgap **con** TODO apuntando a C21).
- **Tests:** integración cola con >N pendientes → pagina y el total es correcto; outbox con breaches en pág. 2 → banner = total global = badge del nav; unit guard último-admin con 1 humano + 1 system → bloquea; test que el log PII se await-ea (spy resuelto antes del return).

### PR-2 — `fix/admin-destructive-confirmations` 🔴/🟡 (fricción proporcional al impacto)
**C4, C5, C6, C7, C8, C10.** Confirmación + motivo en acciones destructivas.
- **Tests:** e2e por acción — sin confirmar no muta; con confirmar muta y (donde aplique) loguea motivo. C9 queda para PR-7 (depende de A2).

### PR-3 — `fix/admin-audit-trail-body` 🔴 (devolver cuerpo al audit trail)
**C11, C12.** Renderizar payload/motivo/actor/target. C12 comparte formatter con `historial` (coordinar con fresh-sweep A5).
- **Tests:** unit — el detalle de admin/govt renderiza motivo+actor; auditoría muestra target + link.

### PR-4 — `chore/admin-operator-data-cards` 🟡 (datos crudos → estructurados)
**C13, C14, C15, C16.** Tarjetas estructuradas, traducir codes, linkear UUIDs, cerrar TODO de outbox.
- **Tests:** unit — el detalle de aprobación vet/org no renderiza `JSON.stringify`; los action-codes salen traducidos.

### PR-5 — `fix/admin-surface-boundaries` 🟡 (límites de superficie / PII / copy)
**C17, C18, C19.** Link operador (no `/mis-mascotas`), copy "por nombre", eyebrow por rol.
- **Tests:** e2e — el link de casos no apunta a `/mis-mascotas`; buscar por DNI muestra el copy correcto.

### PR-6 — `fix/sec-magic-link-handling` 🟡 (credenciales)
**C20.** Ocultar/revelar, TTL real, feedback de copia, título contextual.
- **Tests:** unit — el TTL mostrado deriva del token; el panel arranca oculto.

### PR-7 — `fix/admin-rosters-evidence-scale` 🟡 (escala de rosters + evidencia + impacto PPP)
**C21, C23, C24, C9.** Paginar auth users + flag system en DB (cierra A7), subir evidencia en submit, badge 0-localidades, gate de impacto PPP (requiere A2 cerrado).
- **Migración:** si se agrega `profiles.is_system` (o equivalente) → spec-first no requerido (no es event type), pero **sí** seguir el flujo de migración Drizzle + actualizar `RLS_REQUIRED` si aplica + `__tests__/rls/coverage.test.ts`.
- **Tests:** integración — roster pagina >200; cancelar la desactivación no deja archivos huérfanos; PPP save muestra conteo de afectados.

### PR-8 — `fix/admin-ia-landing-nav` 🔴/🟡 (arquitectura de información)
**C25, C26, C27, C28.** Corregir copy del landing, promover `programa`, regroup del nav, helper de delta.
- **Tests:** invariante de nav (ningún `href` perdido — patrón del Item 1); unit del helper de delta (value-pinning); smoke del landing (copy no menciona "vive en Gobierno" para la cola).

### PR-9 — `fix/admin-filters-tables` 🟡 (filtros + drill-down + período)
**C29, C30, C31, C32.** Filtros en casos/moderación, cablear filtro actor en auditoría, tablas drilleables, alinear período.
- **Tests:** e2e — filtrar casos por status reduce filas; el chip de período coincide con los datos en la primera carga.

### PR-10 — `chore/admin-consistency-polish` 🟢 (consistencia / es-AR / tokens)
**C33, C34, C35, C36, C37, C38, C39, C40.** Constante SLA, `router.refresh()`, color de severidad, footnotes k-anon, KPI tasa de retorno, serialización de registries, jurisdicciones localidad-aware, dead-end physical-credential.
- Coordinar acentos/inglés con fresh-sweep **A3**.
- **Tests:** unit donde aplique; smoke visual; `pnpm verify` (incluye `lint:tokens`).

---

## Pre-PR checklist (por cada PR — no outsourcear a CI)
```bash
pnpm verify   # tsc + Biome + lint:tokens + next build  (next build es no-negociable)
pnpm test     # Vitest — requiere pnpm db:start corriendo
```
- Branch desde `develop`; nunca push directo a `main`/`develop`.
- Spec-first **solo** si un ítem agrega un event type o modifica schema (C21 si suma columna → migración Drizzle + actualizar `__tests__/rls/coverage.test.ts`; **no** es event type, no requiere spec en `specs/`).
- Cada PR self-contained y testeado antes de abrir. Si `pnpm verify` falla en la branch pero pasa en `develop`, la branch es la fuente.

## Al cerrar
- Marcar progreso en [`docs/superpowers/README.md`](../README.md) (nueva fila o bajo "Admin fresh-sweep").
- Actualizar el estado de los hallazgos en [`docs/admin-design-critique-2026-06-22.md`](../../admin-design-critique-2026-06-22.md) (tachar lo cerrado).
- Confirmar que no se duplicó trabajo del fresh-sweep (A2, A3, A5, A7).
