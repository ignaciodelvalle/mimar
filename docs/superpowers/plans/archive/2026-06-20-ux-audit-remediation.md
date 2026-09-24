# Plan: UX Audit Remediation (all roles) — de la auditoría de UX 2026-06-20

> **Para Claude Code.** Plan ejecutable derivado de la auditoría de UX/usabilidad de toda la app
> (owner, org, gob, admin, público), estática **y en vivo** contra el deploy. Las fuentes (el *qué* y el
> *porqué*) son:
> - [`docs/ux-usability-audit.md`](../../ux-usability-audit.md) — auditoría estática del código, todos los roles.
> - [`docs/ux-usability-audit-live.md`](../../ux-usability-audit-live.md) — pasada en vivo (incluye 5 crashes de producción y la corrección de causa-raíz del crash de credencial).
>
> **Cómo ejecutar:** SDD test-first por ítem, docs en el mismo PR (igual que el paquete metrics-IA). Cada
> fase es 1+ sesión de CC → 1+ PR. **Fase 0 primero, siempre** (son crashes de producción en la cara del
> usuario). Salvo que se indique, **sin cambios de schema ni de rutas**. Reusar primitives existentes
> (`components/ui/*`, `components/ui/dashboard/*`, `LnField`, `OpField`, `OpKpi`, `CaseQueue`, `OpOmnibox`).
>
> **Convención de severidad:** 🔴 crash/bloqueante · 🟡 fricción importante · 🟢 polish.
> Cada ítem cita archivo(s) reales y, donde aplica, el `digest` a buscar en los logs de Vercel.

---

> **Estado (2026-06-20):** **Fase 0 ✅** y **Fase 1 ✅** completas. Fase 0: 0.1 verificado en vivo · 0.2 portal de org (schema-drift, migración 0102-0106) · 0.3 `/cuenta` era crash de **escala** (agregación sin bound, no schema-drift; #680) · 0.4 404 branded (#678) · 0.5 login org-aware (#679). Fase 1: 1.1 omnibox org + descope mascotas operador (#682) · 1.2 breadcrumbs gob/admin (#683) · 1.3 adopciones+casos `CaseQueue` bulk/SLA (#684/#685) · 1.4 retiro `MetricCard` + label "Mi actividad" (#687; 2 "duplicados" resultaron NO serlo y quedaron) · 1.5 field kit aria auto (#686). **Fase 2 ✅** (2.1+2.2 touch targets 44px + estado no-solo-color #689 · 2.3 dataviz interpretabilidad #691 · 2.4 a11y estructural #690). **Fase 3** en curso: 3.1 dead-ends password-reset/transferencias #692 · 3.2 flujo denuncia #693 · 3.3 stubs footer + claim a11y honesto #694 · 3.4 localización es-AR #695 · **3.5 owner polish (este PR)**. **Resta solo Fase 3.6 (org/admin polish).**

## Fase 0 — Crashes de producción (🔴 P0, hacer primero)

Cinco surfaces tiran `Error: An error occurred in the Server Components render` (digest oculto en prod),
atrapado por el `ErrorBoundary` (que está bien hecho — branded, español, retry + home + código). El defecto
es lo que el boundary atrapa. Patrón de fix para los tres SC-render crashes: **(1)** reproducir y trazar el
`digest` en los logs de Vercel, **(2)** arreglar la causa raíz, **(3)** agregar un guard defensivo en el
render path para que un solo campo/row malo no tumbe la página entera, **(4)** test de regresión.

### 0.1 🔴 Credencial pública crashea en modo `lost` — *la más grave*
- **Síntoma (en vivo):** una mascota recién creada renderiza su credencial **activa** perfecto
  (`/p/DIM-4AZ2-4GN6`); al marcarla perdida, **la misma URL** tira `Algo salió mal` (digest `752082971`).
  Reproducible en mascota nueva y válida → **no es data de seed**, es el **lost render path**.
- **Por qué importa:** es *el* momento héroe — un extraño escaneando el QR de una mascota perdida. Hoy
  **toda** mascota en `lost` (seed o real) devuelve error en vez de la credencial con contacto + avistaje.
  El directorio público `/perdidas` linkea a páginas que crashean.
- **Ubicación probable:** `app/(public)/p/[publicToken]/page.tsx` (rama lost) + `components/pet-profile/LostPublicCredential.tsx` y la resolución de disclosure (`disclose_*_when_lost`).
- **Fix:** trazar `752082971`; arreglar el throw (sospechar null/shape en la resolución de disclosure o en `LostLastSeenCard`/`LostScanFeed`); envolver el render lost en un guard que degrade campo-a-campo en vez de 500.
- **Test:** e2e `e2e/public-smoke.spec.ts` — agregar caso: marcar pet lost vía acción → `GET /p/[token]` 200 + assert headline lost + botón de contacto. Unit para el resolver de disclosure con inputs null.

### 0.2 🔴 Portal de organización: todo el portal crashea
- **Síntoma (en vivo):** logueado como miembro de org, **todas** las páginas tiran error. `/org/[t]` (panel)
  → `513381940`; `/org/[t]/mascotas` y `/org/[t]/miembros` → **mismo** digest `2283491539`. Mismo digest en
  dos sub-páginas distintas ⇒ falla en el **layout compartido**.
- **Ubicación:** `app/org/[orgToken]/layout.tsx` — carga org + membership del viewer + `getGrantedCapabilities` + `buildOrgNav` (`components/layout/nav-presets.ts`).
- **Conexión:** ligado a la **anomalía de login de org** reportada por el usuario (ver 0.5). La fila de membership/capability parece estar en mal estado y rompe el layout.
- **Fix:** trazar `2283491539`; guard en el layout para membership/capabilities null o inconsistente (degradar a "sin acceso" con mensaje en vez de throw); revisar las filas `org_memberships` / capability-grant del user+org afectado.
- **Test:** integración del loader del layout con membership malformada; e2e operator-auth para que `/org/[t]` cargue el panel.

### 0.3 🔴 `/cuenta` (cuenta del owner) crashea
- **Síntoma (en vivo):** `/cuenta` → `Algo salió mal` (digest `3058248096`) en una cuenta de alto volumen
  (~2025 mascotas). El resto de surfaces del owner renderiza bien.
- **Ubicación:** `app/(app)/cuenta/page.tsx` — probable agregación sin bound de pets/memberships.
- **Fix:** trazar `3058248096`; paginar/limitar la agregación; guard defensivo. Verificar que escala a cuentas con miles de pets/memberships.
- **Test:** integración con cuenta de N pets grande; e2e owner-shell para `/cuenta` 200.

### 0.4 🔴 Token de credencial inválido → 404 negro en inglés
- **Síntoma (en vivo):** `/p/TOKEN-MALO` → 404 default de Next (pantalla negra, "This page could not be found"), sin marca, sin español, sin salida. Peor primera impresión justo para el extraño que el producto quiere convertir.
- **Fix:** agregar `app/(public)/not-found.tsx` en español, branded, explicando que la credencial puede haber expirado/estar mal tipeada, con links a `/perdidas` y al inicio. Confirmar que el `notFound()` de `app/(public)/p/[publicToken]/page.tsx` cae acá.
- **Test:** e2e `GET /p/INVALID` → contiene copy español + link a `/perdidas`.

### 0.5 🟡 Anomalía de login de org (reportada por el usuario)
- **Síntoma:** la cuenta de org loguea pero **aterriza en el home personal del owner** (`/inicio`, "No tenés
  mascotas registradas", 0 pets) en vez de su workspace de org. Hay un switcher "Portales ▾" para llegar
  manual, pero por defecto cae en la experiencia personal vacía.
- **Hipótesis:** mismo origen que 0.2 — membership/provisioning en mal estado ⇒ ruteo post-login no detecta
  la org. (Ojo: el spec `2026-06-18-unified-app-shell-design.md` Item 7 ya menciona arreglar el "varado del
  usuario logueado en surfaces públicas" vía `lib/shell-nav.ts` auth-aware — alinear este fix con ese.)
- **Fix:** ruteo post-login auth-aware que mande a un miembro de org a su portal (o a un selector si tiene
  varias orgs) en vez del home de owner por defecto; arreglar la membership subyacente.

---

## Fase 1 — Universalizar el design system (🟡 P1)

Tema transversal de la auditoría: **los mejores componentes existen pero no están aplicados en todos lados.**
Elegir uno de cada duplicado, migrar, borrar el gemelo (sube calidad y baja mantenimiento).

### 1.1 🔴/🟡 Montar `OpOmnibox` en el portal de org + arreglar el link de resultados
- **Hallazgo:** el portal más denso (org) **no tiene búsqueda global**, aunque gob y admin sí. Además, en
  gob/admin el resultado de una **mascota** del omnibox linkea a `/mis-mascotas/{token}` (ruta **solo-owner**),
  así que un operador que clickea una mascota **rebota al dashboard** sin explicación.
- **Fix:** montar `OpOmnibox` (`components/ui/dashboard/OpOmnibox.tsx`, ya es un combobox APG completo) en el
  topbar de `app/org/[orgToken]/layout.tsx`, scoped a la jurisdicción de la org. Cambiar el href de
  resultados de mascota a una vista visible-por-operador (`/admin/observaciones/{token}` o equivalente gob),
  no a la ruta de owner. Agregar el hint "las búsquedas quedan registradas" (PII logging) en el dropdown.
- **Tests:** unit del builder de href por rol; e2e: `/` enfoca el omnibox en org y navega a una vista válida.

### 1.2 🔴 Breadcrumb del topbar gob/admin (hoy stub "Panel")
- **Hallazgo (en vivo):** el crumb del topbar dice siempre "Panel" en todas las rutas de gob y admin; las
  páginas de detalle arman `OpCrumbs` a mano de forma inconsistente. (El portal de **org** sí deriva el crumb
  de la ruta — "Panel › Operaciones" — usar ese patrón como referencia.)
- **Fix:** derivar `OpCrumbs` del segmento de ruta en `app/gob/layout.tsx` y `app/admin/layout.tsx`.
- **Test:** unit de mapeo ruta→crumbs; visual smoke de 3 rutas por portal.

### 1.3 🟡 Adoption review + casos de org como queue real (bulk + filtros + SLA)
- **Hallazgo:** `/org/[t]/adopciones` y `/org/[t]/casos` son listas/`<ul>` sin bulk, filtros ni aging; cada
  decisión exige entrar al detalle ("Entrá a cada postulación…"). Ya existen `CaseQueue` + `OpBulkBar` +
  `BulkApprovalQueueList` (con partial-failure + `bulkActionId`).
- **Fix:** migrar ambas a `CaseQueue` con config `bulk` (aprobar/rechazar con razón) y badges de edad/SLA
  (`OpBreach`/`OpPill`). Agregar selección por rango (shift-click) en los list bulk.
- **Test:** unit de `CaseQueue` con bulk para adopciones; e2e de selección múltiple + acción.

### 1.4 🟡 Consolidar componentes duplicados (gemelos muertos = los mejores)
- **KPI:** estandarizar en `OpKpi`; retirar `components/gob/MetricCard.tsx` (solo usado en demo). 
- **Charts:** usar `components/charts/DashboardChart.tsx` (tiene empty states, method notes, export CSV) en
  los dashboards; retirar las barras CSS hand-rolled y el camino paralelo.
- **Auditoría admin:** unificar/diferenciar `/admin/auditoria` y `/admin/historial` (hoy casi duplicados);
  renombrar el "Histórico" self-only de gob a "Mi actividad".
- **Filtro de jurisdicción:** un solo componente (`JurisdictionFilterBar`) en dashboards hermanos de gob (hoy
  conviven con `JurisdictionSwitcher`+`PeriodPicker`).
- **Test:** invariante "ningún href/data perdido" al migrar; visual smoke.

### 1.5 🟡 Rutear todos los forms por los field primitives accesibles
- **Hallazgo:** `LnField`/`OpField` cablean label + required `*` + error inline, pero varios forms los
  bypassean y pierden el `*` y el error por campo: signup (vs login que sí marca), vet-upgrade
  (`cuenta/upgrade/VetUpgradeForm.tsx`), bite (`mordedura/BiteForm.tsx`, `OrgBiteForm.tsx`), wizards de org.
- **Fix:** (a) hacer que `OpField`/`LnField` generen y propaguen `aria-describedby`/`aria-invalid`
  automáticamente; (b) migrar los forms díscolos; (c) marcar required consistente en signup.
- **Test:** unit de linkage aria en el field kit; axe sobre 5 forms clave.

---

## Fase 2 — Accesibilidad e interpretabilidad (🟡 P1 / 🟢 P2)

### 2.1 🟡 Touch targets a 44px (regla propia del sistema, violada por el propio sistema)
- `Field.tsx` documenta y enforcea 44px, pero `components/pet-profile/PetQuickActions.tsx`, `components/ui/WizardShell.tsx` (botón atrás) y `components/ui/dashboard/OpRailNav.tsx` shippean 36px (`min-h-9`).
- **Fix:** subir a `min-h-11`. **Test:** test de tamaño mínimo / visual.

### 2.2 🟡 Estado semántico solo-por-color
- `OpKpi` transmite ok/warn/danger solo por color (sin icono/label); ej. en vivo: cobertura antirrábica
  **9% vs meta 80%** se ve en tinta neutra, no en danger, mientras zoonosis sí en rojo. Filas danger en
  `cuenta`/`PetActionsMenu` son texto rojo sin icono.
- **Fix:** agregar pista no-cromática (icono/label) en `OpKpi` y en filas danger; reusar el patrón de glyph de `OpStateBadge`. **Test:** axe + visual.

### 2.3 🟡 Interpretabilidad de data-viz (dashboards de salud pública)
- Choropleths sin leyenda de escala visible (`components/charts/MapChoropleth.tsx`); barras de mortalidad sin
  eje/escala/valor/aria (`/gob/mortalidad`); `OpKpi info={{definition,formula,caveat}}` sin usar en KPIs
  epidemiológicos/compliance; KPIs con códigos crudos (B3/B4/B9) sin explicación.
- **Fix:** leyenda de gradiente + swatch "sin datos/suprimido" en choropleths; componente de barra con escala
  + valor + aria; poblar `info` en los KPIs de `/gob`, `/gob/mortalidad`, `/gob/vigilancia`, `/admin`.

### 2.4 🟢 A11y estructural
- Radio groups sin `fieldset/legend`/`aria-required` (bite victim-kind, denuncia, adoption `ApplicationForm`).
- `components/AdoptionListingCard.tsx`: `<a>` anidado en `<a>` (HTML inválido, rompe teclado/SR) → linkear solo imagen/nombre.
- `<main id="main-content">` inconsistente (credencial, `adoptar/*`, `perdidas`) → estandarizar para que el skip-link funcione.
- Modal de privacidad de adopción es `<dialog open>` no-modal (sin focus trap/Esc) → usar `showModal()`.

---

## Fase 3 — Copy, dead-ends y polish (🟢 P2)

### 3.1 🟡 Dead-ends
- **Password reset:** login no tiene "¿Olvidaste tu contraseña?" → agregar flujo de recuperación (`(auth)/login/LoginForm.tsx`). *(Confirmado en vivo.)*
- **Transferencias salientes invisibles:** `/transferencias` muestra solo recibidas → agregar tab "enviadas" con estado pendiente/aceptada. *(Confirmado en vivo.)*

### 3.2 🟡 Flujo de denuncia (público, sensible)
- Sin off-ramp de emergencia en severidad **grave/urgente** → callout con línea/recurso cuando severidad = grave (`denuncias/nueva/_components/Step2Severity.tsx`). *(Confirmado en vivo: pasa directo a reporte async.)*
- Código de referencia (única llave del denunciante anónimo) no copiable → copy-to-clipboard + "descargar comprobante" en cada visita (`DenunciaWizard.tsx`, `denuncias/codigo/[code]/page.tsx`).
- Pasos 1–2 auto-avanzan en un tap (riesgo de mis-tap) → patrón "Continuar" consistente + autosave/`beforeunload`. *(Confirmado en vivo.)*

### 3.3 🟡 Páginas stub / claim de accesibilidad
- `/acerca`, `/ayuda`, `/accesibilidad`, `/cookies`, `/sugerencias` son "Sección en preparación" (linkeadas desde el footer) → construir al menos Acerca/Ayuda/aviso de cookies o esconder los links muertos.
- `/accesibilidad` **afirma** "construido siguiendo las pautas WCAG 2.1" siendo un stub → publicar una declaración real (con los gaps de Fase 2) o suavizar el claim. *(Confirmado en vivo — riesgo legal/confianza.)*

### 3.4 🟢 Localización y copy
- Enums en inglés en dashboards de gob: causas de muerte "Euthanasia/Accident/Natural/Disease" → localizar a es-AR. *(Confirmado en vivo en `/gob/mortalidad`.)*
- Notificaciones muestran códigos crudos de event-type ("LOST_EPISODE_RESOLVED_OWNER", "PPP_BREED_LIST_UPDATED_NOW_APPLIES") → mapear a label humano/chip. *(Confirmado en vivo.)*
- Acentos es-AR en copy de admin ("Ultimas", "notificacion", "pais", "evaluan/duenos") → normalizar.
- Filtro "Provincia (exacta)" free-text en `/admin/outbox` → reemplazar por `<select>` (typo → vacío silencioso).

### 3.5 🟢 Owner — polish (de la pasada en vivo)
- Dashboard enmarca métricas de escala-operador como carga personal: "264 casos abiertos que requieren atención", "1459 PENDIENTES" → resumir/capear para owners de alto volumen; suavizar el framing.
- "Registrar tu primera mascota" / "Paso 1 de 1" se muestra a un owner con miles de pets → copy first-pet solo si tiene 0.
- Campo Localidad renderiza el label dos veces ("LOCALIDAD *" + "Localidad") en `mis-mascotas/nueva`.
- Título del hero se solapa con la banda con patrón en el perfil de mascota (legibilidad).
- Texto de seed/debug filtra a la UI ("PERF-STATE status (active)" en `/mis-turnos`; lista/captura lidera con el token `PERF-XXXX` antes del nombre) → liderar con el nombre, no el token/estado.
- Empty state de `/adoptar` dice "con esos filtros" sin filtros aplicados → mensaje true-empty.
- Revert de lost ("Marcar encontrada/o") sin confirmación → confirm liviano (opcional, es reversible).
- Contacto del finder es un solo campo "Teléfono o email" sin `inputMode`; contacto de credencial activa detrás de un `<details>` de un tap → optimizar/expandir.

### 3.6 ✅ Org / Admin — polish (de las pasadas en vivo + estática)
> **Implementado (este PR).** (a) hint "pedir acceso" en el panel apoyándose en la tabla de permisos existente · (b) módulos por `org_type` (clínica → agenda/servicios; autoridad sanitaria → casos/mordeduras), capability-gated para no crear dead-ends · (c) `CopyButton` reusable en los 5 tokens de `org/.../mascotas` · (d) señal de truncado en adopciones (casos ya tenía hint vía `CaseQueue`; miembros muestra count, sin cap real) · (e) "Guardar y cargar otro" en intake preservando los campos compartidos del lote · (f) `RuleImpactBanner` ya estaba cableado en el create+edit path — se agregó fallback en error (no más render `null`).
- Items de nav gated por capability desaparecen en silencio (sin "pedir acceso") → mostrar entry lockeable o hint en el panel.
- Panel de org gatea los módulos accionables a `shelter` → módulos por tipo de org (clínica → agenda; autoridad sanitaria → casos/mordeduras).
- Tokens generados mostrados como `<code>` sin copiar (`org/.../mascotas`) → botón copiar (igual que InviteForm).
- Sin paginación en listas de adopción/casos/miembros (LIMIT 200) → cursor o "mostrando N de M".
- Intake es de a un animal → "Guardar y cargar otro" preservando campos compartidos (camada/decomiso).
- KPI dashboard de rule-creation (PPP) sin preview de impacto antes de una acción que notifica owners province-wide → cablear el `RuleImpactBanner` en el create path (hoy puede renderizar null en error — mostrar fallback, nunca nada).

---

## No verificado todavía — auditorías recomendadas de follow-up

1. **Mobile / responsive (alta prioridad).** Toda la pasada en vivo fue a ~1220px (el viewport de screenshot
   de la herramienta es fijo). El producto es PWA mobile-first (hay `OpMobileDrawer`, `event-forms-mobile.test`,
   Tailwind responsive) — pero el render mobile real (credencial QR, dashboard owner, drawers operador, forms)
   necesita **testing en dispositivo**. Es el contexto primario del momento héroe (escanear QR).
2. **Teclado / lector de pantalla end-to-end.** La auditoría cubrió a11y estructural; falta una pasada real de
   navegación por teclado y anuncios de SR (axe + recorrido manual) por surface.
3. **Sub-páginas profundas no recorridas en vivo** (cubiertas estáticamente): `cuenta/*` (privacidad,
   memberships, transitos, verificar-dni, desactivar), org `agenda/censo/servicios/cobertura/configuracion/checkins/maltrato`,
   gob `vigilancia/{brotes,zoonosis,investigaciones}/decomisos/disputas/campañas/outreach`, admin
   `moderacion/observaciones/casos/sistema/govts/admins`, público `refugios/[orgToken]`, `casos/[publicCode]`,
   `libreta/compartir/[shareToken]`, `r/invite/[token]`.

---

## Mapa de trazabilidad (ítem → hallazgo fuente)

| Ítem | Fuente | ID/sección |
|------|--------|------------|
| 0.1 | live | Headline (lost-mode crash, `752082971`) |
| 0.2 | live | Org portal down (`2283491539`/`513381940`) |
| 0.3 | live | O1 (`/cuenta` `3058248096`) |
| 0.4 | live + static | bad-token 404 |
| 0.5 | live | Org login anomaly |
| 1.1 | static + live | Org "no global search" (#1) + L3 (omnibox owner-route bounce) |
| 1.2 | live | Breadcrumb stub gob/admin (#8) |
| 1.3 | static | Org adoption review sin bulk/SLA (#2, #4) |
| 1.4 | static | Dup KPI/chart/audit/filter (#2 govt-admin) |
| 1.5 | static + live | Forms sin field primitives / signup required markers |
| 2.x | static | Touch targets, color-only state, data-viz, a11y estructural |
| 3.x | static + live | Dead-ends, denuncia, stubs, localización, owner/org polish |

> Al cerrar cada fase, marcar el ítem y mover a "Implementado" en `docs/superpowers/README.md`.
