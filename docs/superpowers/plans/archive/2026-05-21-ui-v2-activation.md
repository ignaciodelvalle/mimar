# UI v2 design-refresh — plan ejecutable de activación (Chunks H-N)

> **Fecha:** 2026-05-21
> **Owner:** Ignacio Del Valle
> **Audiencia:** Claude Code (input directo)
> **Estimación:** ~11–13d (suma H-N; ver desglose por chunk)
> **Origen:** `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` §sequencing "backend A-G then v2 H-N"
> **Source plans:** 7 docs en `docs/*-plan-2026-05-20.md` (parked en `ec91354`)
> **Decisiones cerradas:** ninguna pre-existente; ver §Decisiones a tomar

---

## Resumen ejecutivo

El stream v2 design-refresh fue parkeado el 2026-05-21 en commit `ec91354` (5,782 insertions, 33 archivos) mientras el backend consolidado A-G tomaba prioridad. El stream consiste en: cinco preview routes (`/inicio-v2`, `/mis-mascotas/[token]/v2`, `/mis-mascotas/[token]/perdida-v2`, `/p/[token]/v2`, `/gob/dashboard-v2`) más 14 componentes bajo `components/pet-profile/` y 5 primitivos compartidos (`EventCatcher`, `CasesWidget`, `GobDashboardShell`, `JurisdictionFilterBar`, `KpiTile`). La activación significa: reemplazar los `SAMPLE_PETS` / `SAMPLE_KPIS` / `SAMPLE_CASES` placeholders con queries reales ya existentes en `lib/owner-dashboard.ts` y `lib/govt-dashboards.ts`, activar cada surface via routes y navbar, y retirar las páginas v1 según la decisión de rollout (ver V2-D1). El Chunk L (gob dashboard-v2) superpone con el Chunk E ya shipped: ver §L Overlap para la recomendación de qué hacer con esa preview. El Chunk N (iconic dataset) es el de mayor scope aparente (893 líneas de plan) pero una parte relevante de sus fases ya fue ejecutada por A.5 y sprints posteriores; se recomienda auditar antes de estimar.

---

## Mapping H → N (chunks ↔ source plans)

| Chunk | Source plan | Surface principal | Effort estimado |
|---|---|---|---|
| **H** | `docs/eventcatcher-fixes-plan-2026-05-20.md` (solo PR2 + PR3 — PR1 ya shippeado como A6 en PR #89) | `components/EventCatcher.tsx` polish + a11y | ~1.5d |
| **I** | `docs/owner-home-plan-2026-05-20.md` | `/inicio-v2` → swap a `/inicio` | ~1.5d |
| **J** | `docs/pet-profile-owner-plan-2026-05-20.md` | `/mis-mascotas/[token]/v2` → swap a `/mis-mascotas/[token]` | ~2d |
| **K** | `docs/lost-mode-plan-2026-05-20.md` | `/mis-mascotas/[token]/perdida-v2` + `/p/[token]/v2` lost cockpit | ~1.5d |
| **L** | `docs/gob-dashboard-plan-2026-05-20.md` | `/gob/dashboard-v2` → ver §L Overlap; recomendación: **Option A** (swap a `/gob`) | ~1.5d |
| **M** | `docs/denuncia-anonima-plan-2026-05-20.md` | Wizard `/denuncias/nueva` + refresh `/denuncias/codigo/[code]` | ~2.5d |
| **N** | `docs/iconic-dataset-cleanup-plan-2026-05-20.md` | Seed + spec cleanup (auditar scope post-A.5 antes de arrancar) | ~1.5d ó ❎ parcial |

**Total estimado:** ~12d netos (optimista si N se reduce por A.5; hasta 14d si N requiere todas sus fases).

---

## L Overlap con Chunk E (ya shipped)

### Qué es `dashboard-v2` realmente

Al leer `app/gob/dashboard-v2/page.tsx` (267 líneas): la preview es el **home rebuild del portal organismo** — KPI strip de jurisdicción (cobertura antirrábica, esterilizaciones, mordeduras/10k, zoonosis activos), mapa coroplético placeholder, casos cross-org kanban, agenda de hoy, denuncias ciudadanas, y mini-resumen de organizaciones. Es decir, un **reemplazo del `/gob` home**, no un duplicado de `/gob/analytics`.

Chunk E5 (ya shipped) creó `/gob/analytics` como superficie nueva de public-health analytics con `fetchAnalyticsMetrics`. El `/gob` home actual sigue siendo la cola de aprobaciones simple.

### Opciones

- **Option A (recomendada):** L = `/gob` HOME rebuild. Swap de `app/gob/page.tsx` al layout de `dashboard-v2` (tres zonas: header + KPI strip + main/aside). La cola de aprobaciones queda como un `DashboardCard` en el aside. Wireado a `fetchSurveillanceSignals`, `fetchWelfareMetrics`, `fetchLostPets`, `fetchDiseaseSummary` — todos ya existentes en `lib/govt-dashboards.ts` post-E. Aprovecha `GobDashboardShell`, `KpiTile`, `JurisdictionFilterBar` — ya compilando. Las queries de KPI real (cobertura antirrábica real, mordeduras reales) requieren que `lib/govt-dashboards.ts` ya tenga esas funciones, lo cual es cierto post-E5+E6.
- **Option B:** L = ❎ folded — `/gob/analytics` (E5) ya cubre el intent de analytics; deletear la preview. **Descartada:** el intent no es el mismo. `dashboard-v2` es el home supervisorio de jurisdicción; `/gob/analytics` es análisis temporal deep. Son superficies complementarias.
- **Option C:** L = adapter — refactorizar `dashboard-v2` para ser el nuevo `/gob` home mientras `/gob/analytics` queda como sub-ruta. Básicamente igual a Option A, sin diferencia práctica.

**Recomendación: Option A.** El dashboard-v2 es el `/gob` home rebuild que el plan de gob-dashboard-2026-05-20 siempre describió como "Phase 1 — Dashboard shell". Chunk E no lo cubrió porque E parkeó el dashboard-v2 explícitamente. Ahora es el momento de activarlo.

---

## Decisiones a tomar (owner input)

### V2-D1. Rollout strategy

- **A. Direct swap (recomendado):** cada chunk reemplaza la página v1 sin gate. Una vez mergeado, todos ven la v2. Sin código extra, sin flag infra, review más fácil.
- **B. Feature flag** (`profiles.ui_version = 'v1' | 'v2'`): gradual rollout, control fino. Costo: ~0.5d de infra extra por flag, migration de la tabla, settings page para el flip.
- **C. Per-surface progressive:** cada chunk swap independiente, sin flag. Owner controla el orden de merge. Similar a A pero sin gate global.

**Recomendación:** A — Direct swap. El app tiene un solo propietario principal como usuario real hoy; el riesgo de un swap sin flag es mínimo y la deuda de infra de un feature flag no se justifica todavía.

### V2-D2. Cleanup de las páginas v1

Cuando la v2 se activa en `/inicio`, ¿qué pasa con los routes v2-preview (`/inicio-v2`, `/mis-mascotas/[token]/v2`, etc.)?

- **A (recomendada):** Eliminar el route preview (`/inicio-v2`, etc.) en el mismo PR del swap. Una PR = wire + swap + delete preview.
- **B.** Mantener el preview como `/[ruta]-legacy` por N días con redirect.
- **C.** Mantener ambas y agregar setting per-user.

**Recomendación:** A — eliminar el preview en el mismo PR. Los previews existen únicamente como sandboxes de desarrollo. Una vez que la página productiva tiene la v2, la preview es dead code.

### V2-D3. SAMPLE_PETS / SAMPLE_KPIS — orden de wire

- **A. Per-chunk (recomendado):** cada chunk hace wire + swap atómico. I wire `SAMPLE_PETS → fetchPetsForOwner` y activa `/inicio` en un solo PR.
- **B. Batch:** I+J+K+M wire en bulk primero, swap todos juntos al final.

**Recomendación:** A — per-chunk. Cada chunk es atómico: wire los datos, activa el route, borra la preview. Review más enfocado, rollback más limpio.

### V2-D4. iconic-dataset (Chunk N)

El plan de Chunk N tiene 893 líneas porque fue escrito el 2026-05-20 cuando la repo tenía corrupciones serias (git recovery en Phase 0). Varias fases de ese plan ya se aplicaron:

- **Phase 0 (git recovery):** ✅ completado antes de los primeros PRs del stream A-G.
- **Phase 1 (seed loader bugs):** estado desconocido — auditar antes de estimar.
- **Phase 6 (migrate `owner_of_record → owner: UserKey`):** probablemente aplicado.
- **Phase 7–9 (storyline tests, auto-matrix, housekeeping):** probablemente pendientes.

El plan N también predataba el componente `<Icon>` de A.5. Las referencias a "iconic dataset" son del seed de datos de prueba (`scripts/seed-storylines-iconic.ts`), **no del sistema de íconos UI**. Son independientes.

**Recomendación:** antes de arrancar N, auditar qué fases del plan ya están completadas. Si Phase 1 está green y Phase 6 también, el scope real puede ser ~3 PRs (Phase 2–3 sync, Phase 4 canon fixes, Phase 5 coverage gaps). Si Phase 1 sigue roto, arrancar por ahí.

### V2-D5. Componentes pet-profile/* — auditar uso actual

Los 14 componentes bajo `components/pet-profile/` fueron lint-fixed en PR #100 (biome baseline cleanup). Algunos tienen dependencias de schema que pueden estar ahora limpias post-A3:

- `PetProfileHero`, `PetEmergencyCard`, `PetHealthTimeline`, `PetWeightChart`, `PetVaccineReminders`, `PetTrackingPlaceholder`, `PetCredentialCard`, `PetTravelDocs` — usados por `mis-mascotas/[token]/v2/page.tsx`.
- `LostModeBanner`, `LostShareCard`, `LostLastSeenCard`, `LostDisclosureCard`, `LostScanFeed`, `LostPublicCredential` — usados por `perdida-v2/page.tsx` y `p/[token]/v2/page.tsx`.

**Audit recomendado antes de Chunk J:** correr `pnpm typecheck` desde develop con foco en estos 14 archivos. Si typerr hay — corregir en J-PR0 antes del wire.

---

## Hallazgos de implementación

### Estado actual del stream v2 en develop

| Preview page | Líneas | Placeholders | Query helper necesario |
|---|---|---|---|
| `app/(app)/inicio-v2/page.tsx` | 171 | `SAMPLE_PETS`, `SAMPLE_CASES` | `fetchPetsForOwner(userId)` → `EventCatcherPet[]`; `fetchOpenWorkflows(userId)` → `CaseRow[]` |
| `app/(app)/mis-mascotas/[publicToken]/v2/page.tsx` | 178 | todas las secciones hardcoded | `requirePetAccess` ya aplicado; queries: `fetchPetEvents`, `fetchActiveRemindersForPet`, `fetchVaccinationHistory` |
| `app/(app)/mis-mascotas/[publicToken]/perdida-v2/page.tsx` | 146 | `petName`, `lostSince`, `feed` hardcoded | `cases` table — open `lost_pet_episode` row; `petEvents.filter(credential_scanned)` |
| `app/p/[publicToken]/v2/page.tsx` | 39 | todo hardcoded | `pets.disclose_*_when_lost`; `cases.openedAt`; disclosure-filtered fields |
| `app/gob/dashboard-v2/page.tsx` | 267 | `SAMPLE_KPIS` hardcoded | `fetchSurveillanceSignals`, `fetchWelfareMetrics`, `fetchLostPets`, `fetchDiseaseSummary` de `lib/govt-dashboards.ts` |

### Cambios desde el parking (post-ec91354)

- **PR #100 (biome baseline):** lint-fixed los 14 componentes bajo `components/pet-profile/` y los 5 primitivos. No cambia la lógica; los componentes deberían typecheck limpio.
- **PR #93 (A.5):** introdujo `<Panel>`, `<EmptyState>`, `<Badge>`, `<Tabs>` en `components/poncho/`. Las preview pages de I y J pueden (y deben) usar estos en el swap en lugar de divs ad-hoc.
- **E1–E6 (govt dashboards):** expandió `lib/govt-dashboards.ts` con `fetchAnalyticsMetrics`, `fetchPerdidasMetrics`, `fetchVigilanciaMetrics`, `fetchWelfareMetrics`, `fetchWelfareTimeline`, y funciones de export. El Chunk L puede componer estas directamente.

### Query helpers disponibles

| Query | Módulo | Usada por chunk |
|---|---|---|
| `fetchPetsForOwner(userId)` | `lib/owner-dashboard.ts:68` | I — reemplaza `SAMPLE_PETS` |
| `fetchOpenWorkflows(userId)` | `lib/owner-dashboard.ts:487` | I — reemplaza `SAMPLE_CASES` (mapear `WorkflowItem[]` → `CaseRow[]`) |
| `fetchUpcomingAppointments(userId)` | `lib/owner-dashboard.ts:108` | I — "Próximos turnos" |
| `fetchActiveRemindersForPet(petId)` | `lib/owner-dashboard.ts:768` | J — `PetVaccineReminders` |
| `fetchVaccinationHistory(petId)` | `lib/owner-dashboard.ts:796` | J — `PetHealthTimeline` weight filter |
| `fetchSurveillanceSignals(scope)` | `lib/govt-dashboards.ts:92` | L |
| `fetchDiseaseSummary(scope)` | `lib/govt-dashboards.ts:143` | L |
| `fetchLostPets(scope)` | `lib/govt-dashboards.ts:183` | L |
| `fetchWelfareMetrics(scope)` | `lib/govt-dashboards.ts:673` | L |
| `lib/case-queries.ts` | varios | K — open `lost_pet_episode` case |

### Dependencias técnicas

Sin nuevas deps necesarias. `maplibre-gl` (para el mapa coroplético en L), `recharts` (para sparklines en J si se usa chart lib, aunque `PetWeightChart` es SVG puro), y `resend` ya están en el stack. La preview de `gob/dashboard-v2` tiene un placeholder para el mapa ("Mapa coroplético — pendiente Fase 2") — el Chunk L activa ese placeholder o lo mantiene si `<MapChoropleth>` de E1 ya existe. Verificar antes de estimar L.

---

## Pre-work (este doc) — completado al escribir

- [x] 7 source plans leídos y sintetizados.
- [x] 5 preview pages mapeadas a chunks.
- [x] 14 pet-profile + 5 shared components inventariados.
- [x] Chunk L overlap con E5 explicitly addressed.
- [x] 5 decisiones owner-side surfaced (V2-D1..V2-D5).
- [ ] Owner: resolver V2-D1..V2-D5 antes de lanzar cada chunk.

---

## H — EventCatcher polish (PR2 + PR3) (~1.5d)

H-PR1 ya shippeado como A6 en PR #89 — wired EventCatcher → CaptureBox handoff, query-param forwarding, `?text=` + `?kind=` pasados desde el catcher a `CaptureBox`. **H-PR2 y H-PR3 son el scope restante.**

### H-PR2 — Active-pet visibility + chip semantic differentiation

Source: `docs/eventcatcher-fixes-plan-2026-05-20.md` §PR 2.

Cambios en `components/EventCatcher.tsx`:
1. Línea persistente "Anotando para {name}" entre el chip row y el textarea.
2. Diferenciar chips de mascota (mantener `rounded-full`) vs. chips de acción rápida (cambiar a `rounded-md`, text más claro).
3. Reemplazar `opacity-50` en el botón Anotar deshabilitado por estilo unambiguous (`disabled:bg-neutral-200 disabled:text-neutral-500`). Razón WCAG: `opacity-50` sobre `blue-700` baja a ~2.1:1, fail AA.

Tests: snapshot / DOM assertion que la línea "Anotando para {name}" se actualiza al cambiar la mascota activa.

### H-PR3 — Accessibility: touch targets, keyboard nav, mobile-aware tip

Source: `docs/eventcatcher-fixes-plan-2026-05-20.md` §PR 3.

Cambios en `components/EventCatcher.tsx`:
1. Touch targets: quick chips `px-3 py-1 text-xs` → `px-3 py-2 text-sm`; Anotar `py-1.5` → `py-2`.
2. Roving tabindex + arrow-key navigation en el `radiogroup` de mascotas (`ArrowRight` / `ArrowLeft`, wrapping). Ref map para focus programático.
3. Tip "Ctrl + Enter" con `[@media(hover:hover)]:block` — invisible en touch devices.

Tests: `@testing-library/user-event` — focus primer chip, `{ArrowRight}`, assert segunda mascota selected y focused.

### Archivos a crear / modificar — H

| Archivo | Acción |
|---|---|
| `components/EventCatcher.tsx` | modificar (PR2 + PR3) |
| `__tests__/event-catcher.test.tsx` | crear/extender |

### DoD — H

- [ ] Línea "Anotando para {name}" visible y actualizada al cambiar mascota.
- [ ] Chips de mascota y acción rápida visualmente distintos.
- [ ] Botón Anotar deshabilitado pasa WCAG AA (≥ 4.5:1 ratio).
- [ ] Touch targets ≥ 38px alto en quick chips y Anotar.
- [ ] Keyboard: Tab entra al radiogroup, Arrow navega, Tab sale al textarea.
- [ ] Tip Ctrl+Enter invisible en mobile (DevTools emulation confirm).
- [ ] `pnpm test` green; ningún test previo regresa.

---

## I — Owner home rebuild (`/inicio-v2` → `/inicio`) (~1.5d)

Source: `docs/owner-home-plan-2026-05-20.md` (incluyendo v3 revision post-critique).

La preview `/inicio-v2/page.tsx` ya compone `EventCatcher` + `CasesWidget` + "Próximos turnos". El swap consiste en:

1. Reemplazar `SAMPLE_PETS` con `fetchPetsForOwner(session.user.id)` — retorna `DashboardPet[]`; mapear a `EventCatcherPet[]` (campos compatibles: `id`, `name`, `publicToken`, `photoUrl`, `status`; `state` y `stateLabel` se derivan del `derivePetState` helper — ver ambigüedad I-A1).
2. Reemplazar `SAMPLE_CASES` con `fetchOpenWorkflows(session.user.id)` — retorna `WorkflowItem[]`; mapear a `CaseRow[]` (campos: `id`, `title`, `subtitle`, `ctaUrl`, `since`, `severity`, `icon`).
3. Reemplazar los turnos hardcoded con `fetchUpcomingAppointments(session.user.id)`.
4. Hacer el swap de routes: el body de `app/(app)/inicio/page.tsx` se reemplaza con el de `inicio-v2/page.tsx` (ya con datos reales).
5. Eliminar `app/(app)/inicio-v2/` (route preview).

Widgets desplazados del v1 home (ya decidido en el source plan):
- `NotificationsWidget` → top-bar bell + `/notificaciones` (ya existe). La bell en `(app)/layout.tsx` puede agregarse en este chunk o en un follow-up.
- `OpenWorkflowsWidget` + `PreviousWorkflowsWidget` → `CasesWidget` (ya en la v2).
- `MedicationsWidget` → per-pet profile (J).
- `PetsGridWidget` → retirado; pet picker en EventCatcher + dual-tap para abrir perfil.
- `QuickCaptureWidget` → retirado; reemplazado por `EventCatcher`.
- Placeholders News + Regulations → eliminados.

Componentes A.5 a componer: el header section puede usar `<Panel>` de Poncho; "Próximos turnos" puede usar `<EmptyState>` si no hay turnos.

### Archivos a crear / modificar — I

| Archivo | Acción |
|---|---|
| `app/(app)/inicio/page.tsx` | modificar — reemplazar body con layout v2 + queries reales |
| `app/(app)/inicio-v2/` | eliminar (folder entero) |
| `lib/owner-dashboard.ts` | posiblemente extender: `mapWorkflowItemToCaseRow()` helper (o inline en la page) |
| `components/EventCatcher.tsx` | posible ajuste: agregar top-bar bell CTA si se decide en este chunk |

### DoD — I

- [ ] `/inicio` renderiza `EventCatcher` con mascotas reales del usuario.
- [ ] "Mis casos" muestra `fetchOpenWorkflows` reales, mapeados a `CaseRow`.
- [ ] "Próximos turnos" muestra `fetchUpcomingAppointments` reales.
- [ ] Zero `SAMPLE_*` en la página activada.
- [ ] `/inicio-v2` ya no existe (404).
- [ ] `pnpm typecheck && pnpm test` green.
- [ ] Widgets v1 desplazados no dan error 404 (sus rutas destino existen).

---

## J — Pet profile owner v2 (`/mis-mascotas/[token]/v2` → `/mis-mascotas/[token]`) (~2d)

Source: `docs/pet-profile-owner-plan-2026-05-20.md`.

Los 14 componentes bajo `components/pet-profile/` son todos Server Components (excepto `PetHealthTimeline` que tiene filter state client-side). El swap:

1. Auditar typecheck de los 14 componentes post-PR #100. Resolver si hay typerr antes del wire (J-PR0).
2. Resolver las open decisions del source plan que bloquean el wire:
   - **Open Decision #1:** contactos vet + emergencia en schema → si `profiles` ya tiene columnas `preferredVetContactName/Phone + emergencyContactName/Phone` post-A, usarlas; si no, `PetEmergencyCard` renderiza "No configurado" con edit link.
   - **Open Decision #3:** Tracking placeholder — usar opción (a) neutral sin vendor. Ya en `PetTrackingPlaceholder.tsx` implementado así.
   - **Open Decision #4:** URL pública `/p/{token}` mantiene el mismo URL; branch server-side en `pets.status === "lost"` para mostrar `LostPublicCredential` o credencial normal.
3. Wire sección por sección:
   - **Hero:** `requirePetAccess` (ya en la preview) + `pets` row + `derivePetState(events, status)` helper — helper a crear en `lib/pet-state.ts`.
   - **Emergencias:** columnas de `profiles` si existen, o empty state + edit link.
   - **Salud (timeline):** `fetchPetEvents(petId, limit=5)` — helper ya existe.
   - **Vacunas:** `fetchActiveRemindersForPet(petId)` — ya en `lib/owner-dashboard.ts:768`.
   - **Credencial:** `pets.publicToken` (ya disponible desde `requirePetAccess`).
   - **Travel docs:** `attachments` filtrado por kind `in ('passport', 'intl_cert')` — si no hay tabla dedicada, usar `attachments` con el filtro de kind.
   - **Weight chart:** `petEvents.filter(type === 'weight_recorded')` últimos 12 meses.
4. Swap: `app/(app)/mis-mascotas/[publicToken]/page.tsx` body → layout v2. Eliminar `mis-mascotas/[publicToken]/v2/`.

Componentes A.5 a componer: `<Panel>` como wrapper de cada sección; `<EmptyState>` en Vacunas vacías, Emergencias sin datos, etc.

### Archivos a crear / modificar — J

| Archivo | Acción |
|---|---|
| `app/(app)/mis-mascotas/[publicToken]/page.tsx` | modificar — reemplazar body con layout v2 + queries |
| `app/(app)/mis-mascotas/[publicToken]/v2/` | eliminar |
| `lib/pet-state.ts` | crear — `derivePetState(events, pets.status) → PetState` + `PET_STATE_RING` map |
| `components/pet-profile/*.tsx` (14 archivos) | typecheck + posibles fixes (J-PR0) |

### DoD — J

- [ ] `/mis-mascotas/[token]` renderiza el layout v2 owner con datos reales.
- [ ] `PetProfileHero` muestra estado derivado correcto (ok / info / attention / urgent).
- [ ] `PetEmergencyCard` muestra datos reales o empty state con edit link — sin errores.
- [ ] `PetHealthTimeline` renderiza los últimos eventos reales.
- [ ] `PetWeightChart` renderiza sparkline de últimos 12 meses (o empty state).
- [ ] `PetVaccineReminders` muestra reminders reales de `fetchActiveRemindersForPet`.
- [ ] `/mis-mascotas/[token]/v2` ya no existe (404).
- [ ] Zero `SAMPLE_*` en la página activada.
- [ ] `pnpm typecheck && pnpm test` green.

---

## K — Lost mode v2 (~1.5d)

Source: `docs/lost-mode-plan-2026-05-20.md`.

Dos superficies:

**K-1: Owner cockpit** (`/mis-mascotas/[token]/perdida-v2` → fold en `/mis-mascotas/[token]`):
- Ya no es un route separado: cuando `pets.status === "lost"`, la página del perfil muestra el layout de cockpit en lugar de las secciones normales (branch server-side en `/mis-mascotas/[token]/page.tsx` post-J).
- Wire real:
  - `lostSince`: `cases.openedAt` del open `lost_pet_episode` via `lib/case-queries.ts`.
  - `casePublicCode`: `cases.publicCode`.
  - `feed.scans`: `petEvents.filter(type='credential_scanned', since=cases.openedAt)`.
  - `feed.finder`: TBD per open decision #1 del source plan (tipo de evento para finder messages). Usar `incident_reported` con `incident_type='finder_message'` como v1 hasta que se decida.
  - Disclosure prefs: `pets.disclose_*_when_lost` columns.
- Server actions ya existen: `setPetFoundAction` (cierra el case atomicamente), `setPetDisclosurePrefsAction`.

**K-2: Public lost view** (`/p/[token]/v2` → fold en `/p/[token]`):
- La preview es `LostPublicCredential` standalone. En la página real, branch server-side: si `pets.status === "lost"`, renderizar `LostPublicCredential`; si no, el perfil público normal.
- Wire: `pets.disclose_*_when_lost` filtra qué campos se pasan.

Eliminar: `app/(app)/mis-mascotas/[publicToken]/perdida-v2/` y `app/p/[publicToken]/v2/`.

### Archivos a crear / modificar — K

| Archivo | Acción |
|---|---|
| `app/(app)/mis-mascotas/[publicToken]/page.tsx` | modificar — agregar branch `status === "lost"` → cockpit layout |
| `app/(app)/mis-mascotas/[publicToken]/perdida-v2/` | eliminar |
| `app/p/[publicToken]/page.tsx` | modificar — agregar branch `status === "lost"` → `LostPublicCredential` |
| `app/p/[publicToken]/v2/` | eliminar |

### DoD — K

- [ ] Dueño con mascota perdida ve el cockpit `LostModeBanner` + `LostShareCard` + `LostLastSeenCard` + `LostDisclosureCard` + `LostScanFeed` en `/mis-mascotas/[token]`.
- [ ] Extraño que escanea el QR ve `LostPublicCredential` en `/p/[token]`.
- [ ] Campos filtrados según `pets.disclose_*_when_lost` (test: toggle phone off → `ownerPhoneE164` no pasa al componente).
- [ ] "Marcar encontrada" llama `setPetFoundAction` y cierra el `lost_pet_episode` case.
- [ ] Previews `/perdida-v2` y `/v2` ya no existen (404).
- [ ] `pnpm typecheck && pnpm test` green.

---

## L — Gob dashboard v2 (Option A: `/gob` HOME rebuild) (~1.5d)

Source: `docs/gob-dashboard-plan-2026-05-20.md` (Phase 1 — Dashboard shell).

Ver §L Overlap: recomendación Option A. El `dashboard-v2/page.tsx` ya tiene el layout correcto (tres zonas via `GobDashboardShell`). El swap:

1. Wire `SAMPLE_KPIS` con queries reales:
   - Cobertura antirrábica: calcular desde `petEvents` con `type='vaccination_administered'` × localidad — puede requerir un nuevo helper en `lib/govt-dashboards.ts` si no existe. Fallback: mostrar tile con `value="–"` y un comment TODO en código.
   - Esterilizaciones/mes: similar, `type='sterilization_performed'` count por mes.
   - Mordeduras/10k: `fetchVigilanciaMetrics` de E ya incluye bite counts. El divisor de población (tabla `localityPopulation`) es del plan original Phase 3 — si no existe, mostrar count absoluto con label "mordeduras reportadas".
   - Zoonosis activos: `fetchDiseaseSummary` ya existe.
2. Wire right-column cards con queries reales: `fetchWelfareMetrics` (denuncias), `fetchVisiblePendingRequests` (cola), `fetchLostPets` (perdidas en jurisdicción).
3. El mapa coroplético en `main` — si `<MapChoropleth>` de E1 ya existe, embeberlo; si no, mantener el placeholder "pendiente Fase 2" que ya tiene la preview.
4. Swap: `app/gob/page.tsx` → layout del dashboard-v2. Eliminar `app/gob/dashboard-v2/`.

### Archivos a crear / modificar — L

| Archivo | Acción |
|---|---|
| `app/gob/page.tsx` | modificar — reemplazar body de cola con layout tres zonas |
| `app/gob/dashboard-v2/` | eliminar |
| `lib/govt-dashboards.ts` | posiblemente extender con queries de KPI de cobertura |

### DoD — L

- [ ] `/gob` renderiza el dashboard de tres zonas (KPI strip + main + aside).
- [ ] `KpiTile`s muestran valores reales o placeholder `"–"` con TODO donde faltan datos.
- [ ] La cola de aprobaciones aparece como `DashboardCard` en el aside.
- [ ] Denuncias ciudadanas, organizaciones, y agenda de hoy aparecen en el aside.
- [ ] `JurisdictionFilterBar` funciona (URL search params).
- [ ] RLS scope-bound: govt ve solo su jurisdicción, admin ve universal.
- [ ] `/gob/dashboard-v2` ya no existe (404).
- [ ] `pnpm typecheck && pnpm test` green.

---

## M — Denuncia anónima rediseñada (~2.5d)

Source: `docs/denuncia-anonima-plan-2026-05-20.md`.

**Sin schema change** — todos los campos del wizard mapean a columnas existentes de `welfareReports`. El wizardes un rewrite del `WelfareReportForm.tsx` con una máquina de estado cliente (7 steps).

Componentes nuevos bajo `components/denuncia/`:

| Componente | Role |
|---|---|
| `DenunciaWizardShell.tsx` | Layout wrapper, step indicator (1 de 6), back button, sticky bottom CTA |
| `DenunciaStepKind.tsx` | Step 1 — kind cards desde `WELFARE_REPORT_KINDS` |
| `DenunciaStepSeverity.tsx` | Step 2 — 3 severity cards con ejemplos en lenguaje plain |
| `DenunciaStepWhere.tsx` | Step 3 — `LocationFields` + occurredAt radio + description textarea |
| `DenunciaStepSubject.tsx` | Step 4 — subject kind cards + optional chip-ID lookup |
| `DenunciaStepEvidence.tsx` | Step 5 — drop zone + camera capture (levanta de `WelfareReportForm.tsx`) |
| `DenunciaStepClose.tsx` | Step 6 — anónima vs anónima + contacto |
| `DenunciaSuccessScreen.tsx` | Step 7 — DEN-XXXX-XXXX grande + save-to-photos + follow-up link |
| `DenunciaFollowUpStatus.tsx` | `/denuncias/codigo/[code]` body — 3 states (open / triaged / closed) |

Server action: el wizard usa el `createWelfareReportAction` existente en `app/actions/welfare.ts` — solo en step 6→7, con el payload completo ensamblado en el cliente.

Honeypot + dwell-time anti-spam client-side (no tocan el server action).

El wizard reemplaza `app/denuncias/nueva/WelfareReportForm.tsx`. Una vez en parity (steps 1-5), retirar el `WelfareReportForm` original.

Decisión abierta de referencia (V2-D-M1): subject lookup (step 4) — si preocupa privacidad del chip lookup anónimo, el server-side lookup retorna solo boolean "matched / no matched" sin exponer el pet record. Implementar así en v1.

### Archivos a crear / modificar — M

| Archivo | Acción |
|---|---|
| `components/denuncia/DenunciaWizardShell.tsx` | crear |
| `components/denuncia/DenunciaStep*.tsx` (6 archivos) | crear |
| `components/denuncia/DenunciaSuccessScreen.tsx` | crear |
| `components/denuncia/DenunciaFollowUpStatus.tsx` | crear |
| `app/denuncias/nueva/page.tsx` | modificar — wiring al wizard shell |
| `app/denuncias/nueva/WelfareReportForm.tsx` | retirar una vez wizard en parity |
| `app/denuncias/codigo/[code]/page.tsx` | modificar — usar `DenunciaFollowUpStatus` |

### DoD — M

- [ ] 7-step wizard renderiza sin errores en mobile (DevTools emulation).
- [ ] Submit en step 6→7 crea un `welfareReport` real via `createWelfareReportAction`.
- [ ] Step 7 muestra el `DEN-XXXX-XXXX` generado, copiable con tap.
- [ ] `/denuncias/codigo/[code]` muestra los 3 estados correctamente.
- [ ] `WelfareReportForm.tsx` original retirado.
- [ ] Rate limit no roto — submit sin honeypot activado.
- [ ] `pnpm typecheck && pnpm test` green.

---

## N — Iconic dataset cleanup (~1.5d ó parcialmente ❎ diferido)

Source: `docs/iconic-dataset-cleanup-plan-2026-05-20.md` (893 líneas, 10 phases).

**Investigar scope antes de estimar.** El plan fue escrito el 2026-05-20 y varias fases pueden estar completadas:

| Phase del source plan | Status probable | Acción |
|---|---|---|
| Phase 0 — git recovery | ✅ completado (repo funcionando desde entonces) | skip |
| Phase 1 — seed loader bugs (3 bugs) | ❓ auditar con `pnpm tsx scripts/seed-demo.ts --dry-run` | ejecutar si falla |
| Phase 2 — sync doc a event catalog | ❓ auditar: buscar `adoption_application_approved` en `dim-interno:docs/test-storylines-iconic.md` | ejecutar si hay hits |
| Phase 3 — libreta share burst stressor | ❓ auditar: buscar `share_burst` en `seed-storylines-iconic.ts` | ejecutar si no existe |
| Phase 4 — canon fixes (4 small) | ❓ buscar `Tora Andō`, `858 not used`, `parvovirus 1924`, `Rin Tin Tin"` | ejecutar si hay hits |
| Phase 5 — fill coverage gaps | ❓ buscar `sterilization_performed` en seed | ejecutar si no existe |
| Phase 6 — migrate `owner_of_record → owner: UserKey` | ❓ buscar `Legacy fallback for the iconic` en `seed-demo.ts` | ejecutar si existe |
| Phase 7 — storyline-driven test (Hachikō) | ❓ buscar `hachiko-recurring-lost.test.ts` | crear si no existe |
| Phase 8 — auto-generate coverage matrix | posiblemente diferido | diferir si costo > 1d |
| Phase 9 — repo housekeeping | ❓ buscar `claim-wip.patch` en `.git/` | ejecutar si existe |

**Nota crítica:** el plan N habla de "iconic dataset" como los 7 storylines de seed (`Laika`, `Hachikō`, `Pal`, etc.) — **no tiene nada que ver con el sistema de íconos UI** que introdujo A.5 con `<Icon>`. Son independientes. El scope del plan N es 100% de dev-tooling y data quality, no UI.

**Recomendación:** ejecutar el audit N-pre-work primero (30 min). Si Phases 1-6 ya están limpias, el scope real de N se reduce a Phase 7 (test) + Phase 8-9 (opcional). Si Phase 1 sigue roto, arrancar por ahí.

### Archivos a crear / modificar — N (scope condicional)

| Archivo | Acción condicional |
|---|---|
| `scripts/seed-demo.ts` | modificar si Phase 1 o Phase 6 tienen bugs |
| `scripts/seed-storylines-iconic.ts` | modificar si Phase 2-6 necesitan fixes |
| `dim-interno:docs/test-storylines-iconic.md` | modificar si Phase 2 y 4 tienen outdated refs |
| `__tests__/storylines/hachiko-recurring-lost.test.ts` | crear (Phase 7) |
| `scripts/generate-coverage-matrix.ts` | crear (Phase 8 — diferible) |

### DoD — N

- [ ] `pnpm tsx scripts/seed-demo.ts --dry-run` corre sin errores.
- [ ] `pnpm tsx scripts/seed-demo.ts` popula las 7 mascotas icónicas sin enum errors.
- [ ] `dim-interno:docs/test-storylines-iconic.md` solo referencia event_types que existen en `EVENT_TYPES`.
- [ ] `__tests__/storylines/hachiko-recurring-lost.test.ts` pasa en CI.
- [ ] `grep -n "Legacy fallback for the iconic" scripts/seed-demo.ts` → zero hits.
- [ ] `pnpm test` green.

---

## Definition of Done — UI v2 stream completo

- [ ] **H** — EventCatcher polish completo (PR2 + PR3). WCAG AA verified.
- [ ] **I** — `/inicio` usa layout v2 con datos reales. `SAMPLE_*` eliminados. Preview `/inicio-v2` borrada.
- [ ] **J** — `/mis-mascotas/[token]` usa layout v2 con queries reales. 14 pet-profile components activos. Preview `/v2` borrada.
- [ ] **K** — Branch "lost mode" activo en `/mis-mascotas/[token]` y `/p/[token]`. Previews `/perdida-v2` y `/v2` borradas.
- [ ] **L** — `/gob` muestra dashboard de tres zonas con datos reales (o placeholders documentados). Preview `/dashboard-v2` borrada.
- [ ] **M** — Wizard `/denuncias/nueva` de 7 steps activo. `WelfareReportForm.tsx` retirado.
- [ ] **N** — Seed iconic limpio. Coverage test Hachikō corriendo en CI.
- [ ] Zero `SAMPLE_*` / `SAMPLE_KPIS` / `SAMPLE_CASES` / `SAMPLE_PETS` en routes activos.
- [ ] Navbar links actualizados si cualquier chunk cambia una URL.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green en develop post-merge de cada chunk.
- [ ] Visual QA + a11y por surface (usar DevTools a11y tree + mobile emulation).
- [ ] Planes de los 7 source docs referenciados aquí movidos a `archive/` post-activación.

---

## Diferidos (fuera de scope de la activación)

Ítems que los source plans mencionan pero caen fuera del scope de activación H-N:

| Ítem | Source plan | Razón |
|---|---|---|
| Top-bar notification bell (`/notificaciones`) | `owner-home-plan` | Follow-up: `/notificaciones` ya existe pero el bell en layout no. Separar en Chunk I-follow-up. |
| `derivePetState` + `derivePetAlerts` helpers completos | `pet-profile-owner-plan` | El helper `derivePetState` mínimo se crea en J; `derivePetAlerts` requiere spec propia. |
| Schema `preferredVetContactName/Phone` + `emergencyContactName/Phone` | `pet-profile-owner-plan` open decision #1 | Decisión de schema pendiente; `PetEmergencyCard` renderiza empty state + edit link como v1. |
| GPS tracker real integration | `pet-profile-owner-plan` | v1 es placeholder en `PetTrackingPlaceholder`. |
| QR-image generation route `/p/{token}.png` | `pet-profile-owner-plan` | `PetCredentialCard` toma un URL; la route de generación es TBD. |
| Poster generator (`/casos/{code}/afiche.pdf`) | `lost-mode-plan` | `LostShareCard` acepta cualquier URL. El route PDF es Chunk F (ya diferido). |
| Denuncia vinculante (con DNI verification) | `denuncia-anonima-plan` | Depende de A-plan Phase 2.1 (gate `claimStubProfileAction`). Post-A. |
| ChoroplethMap en `/gob` (completo con data real) | `gob-dashboard-plan` Phase 2 | `<MapChoropleth>` de E1 puede incrustarse si existe; si no, el placeholder se mantiene. Fase 2 del plan original. |
| Habilitaciones (`organizationPermits` table) | `gob-dashboard-plan` Phase 4 | Schema new — propio chunk post-L. |
| Inspecciones + sanciones como case kinds | `gob-dashboard-plan` Phase 5 | Propio chunk post-L. |
| Phase 8 coverage matrix auto-generator | `iconic-dataset-cleanup-plan` | Diferido si costo > 1d; Phase 7 (test) es suficiente como proof of concept. |

---

## Ambigüedades flaggeadas

1. **`derivePetState` helper** — el source plan dice "cuando v3 ships, extraemos a `lib/pet-state.ts`". `PetProfileHero` duplica los maps inline. Chunk J necesita decidir: ¿crear el helper en J o dejarlo inline? Recomendación: crear `lib/pet-state.ts` en J para que `EventCatcher` (I) y `PetProfileHero` (J) compartan el mismo map.

2. **Finder messages in the lost case** — `LostScanFeed` necesita `feed.finder` pero el tipo de evento para "finder messages" no está definido en el source plan. Open decision #1 del lost-mode plan. V1: usar `incident_reported` con `incident_type='finder_message'` como placeholder hasta que se especifique el tipo.

3. **Cobertura antirrábica KPI (Chunk L)** — el gob-dashboard plan dice "Calculable de `petEvents` vacuna entries × locality. No projection yet." Si post-E no hay una función lista, el KpiTile muestra `"–"` con un TODO en código. No bloquea el swap.

4. **CasesWidget icon mapping** — el source plan dice "map case kinds to emoji in v1, swap for lucide icons in v2". La preview `inicio-v2/page.tsx` ya usa emoji. Chunk I decide si mantener emoji o usar `<Icon>` de A.5 para los case kinds. Recomendación: usar `<Icon>` de A.5 para consistencia con el design system.

5. **N scope real** — el plan N fue escrito antes de que el repo funcionara normalmente. No hay certeza de qué phases se ejecutaron post-git-recovery. Auditar con `pnpm tsx scripts/seed-demo.ts --dry-run` y el grep de cada phase antes de arrancar N.

---

## Referencias

- `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` — sequencing parent (A-G backend first, H-N v2 second)
- `docs/eventcatcher-fixes-plan-2026-05-20.md` — Chunk H source plan
- `docs/owner-home-plan-2026-05-20.md` — Chunk I source plan
- `docs/pet-profile-owner-plan-2026-05-20.md` — Chunk J source plan
- `docs/lost-mode-plan-2026-05-20.md` — Chunk K source plan
- `docs/gob-dashboard-plan-2026-05-20.md` — Chunk L source plan
- `docs/denuncia-anonima-plan-2026-05-20.md` — Chunk M source plan
- `docs/iconic-dataset-cleanup-plan-2026-05-20.md` — Chunk N source plan
- `ec91354` — parking commit (5,782 insertions, 33 archivos)
- PR #89 (A6) — ya shippeó H-PR1 (EventCatcher silent-input bug + query-param handoff)
- PR #100 — biome baseline cleanup que lint-fixed los 14 pet-profile components
- PR #93 (A.5) — primitivos Poncho (`<Panel>`, `<EmptyState>`, `<Badge>`, `<Tabs>`) que I y J deben componer
- `docs/superpowers/plans/archive/2026-05-21-govt-dashboards.md` — Chunk E plan (referencia para L overlap)
