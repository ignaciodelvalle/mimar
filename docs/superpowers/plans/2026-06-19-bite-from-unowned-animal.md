# Bite from unowned animal — implementation plan

> Plan ejecutable para Claude Code. Reporte de mordedura por animal **no registrado**: pet temporal +
> caso `bite_incident(unowned_animal)` + observación rábica de 10 días + reasignación govt + reconciliación
> por DNI al signup. **Backlog — gated a Wave 5** (necesita `dni_hash`; ver §0).
>
> **Fecha:** 2026-06-19 · **Owner:** Ignacio Del Valle
> **Spec:** `docs/superpowers/specs/2026-05-19-bite-from-unowned-animal-design.md` **v2.0** (gana el spec ante cualquier duda; **leer la §0 Revisión v2.0 primero**)
> **Tamaño:** 1 tabla nueva (`temporary_pet_descriptions`) + 2 alters (`cases.temporary_pet_description_id`, `pet_events.pet_id` nullable) + ~3 server actions + 2 UI flows (wizard + reconciliación) + 1 branch de cron. **0 event types nuevos.**
> **Estimación:** ~8 días, 7 PRs (Fases A→G)
> **Prioridad:** backlog. **No arrancar antes de que Wave 5 (Items 25–28, `dni_hash`) esté en `main`.**

## 0. Antes de tocar nada

1. **Gate:** confirmá que Wave 5 landeó — `profiles.dni_hash` existe, `dni_number` fue dropeado, y hay un helper de HMAC con el pepper (env/KMS). Si `dni_number` todavía existe, **PARÁ**: el plan asume el mundo post-Wave 5. Grep `dni_number` debe dar 0 hits en código vivo.
2. Leé, en orden:
   - El spec **v2.0 §0** (las decisiones R1–R8 mandan sobre el cuerpo v1.0).
   - `dim-interno:docs/superpowers-private/specs/2026-06-19-wave5-launch-hardening-handoff.md` §"Flujos que dependían de DNI en claro" (cómo se hashea + dónde está el pepper).
   - `specs/2026-05-18-bite-rabies-observation-design.md` v1.1 (el flujo de observación que extendés).
   - `AGENTS.md` end-to-end (principles, event catalog, privacy tiers, user roles).
3. **Hechos verificados del código (NO re-descubrir):**

   **Casos (ya en código):**
   - `cases` en `db/schema.ts` (~L3058): `primarySubjectKind ('registered_pet'|'unowned_animal'|'location'|'general')`, `primaryPetId` nullable, CHECK `cases_subject_pet_consistency` = `(primary_subject_kind='registered_pet') = (primary_pet_id IS NOT NULL)`. **NO** tiene `temporary_pet_description_id` (lo agregás).
   - `src/modules/cases/infrastructure/cases-repository.ts`: `openCase(input: OpenCaseInput, executor = db): Promise<Case>` — genera `CAS-XXXX-XXXX` atómico. `OpenCaseInput` incluye `kind, primarySubjectKind, primaryPetId?, jurisdiction*, openedByUserId?, openedReason (≥10 chars), ...`.
   - `src/modules/cases/domain/case-kinds.ts`: `CASE_KINDS` (incluye `'bite_incident'`), `CASE_SUBJECT_KINDS` (incluye `'unowned_animal'`), tipos `CaseKind`/`CaseSubjectKind`.
   - `pet_events.caseId` (`db/schema.ts` ~L1079): FK nullable a `cases`, append-only, índice parcial `pet_events_case_id_idx`. **Ya existe — no agregar.**
   - Tabla `case_events` (`db/schema.ts` ~L3232, migración 0069) existe pero usa `entryType` propio — **NO se usa acá** (ver R6: los eventos de rabia van a `pet_events`).
   - Precedente de reasignación: `app/actions/decomiso.ts` (inserta `petEvents` con `eventType:'note_added'` + `caseId` dentro de TX) y `app/gob/decomisos/_components/ReasignarButton.tsx` (UX a espejar).

   **Bite / rabia (ya en código):**
   - Event types `incident_reported`, `rabies_observation_started`, `rabies_observation_ended` en el catálogo.
   - **`lib/event-schemas.ts` — `incident_reported` ya tiene** (`~L709`): `incident_type` con `'bite_inflicted'` **y `'bite_suffered'`**; campos `victim_kind ('human'|'animal'|'unknown')`, `victim_pet_id (uuid)`, `victim_contact_name/phone`, `reporter_role ('owner'|'vet'|'shelter'|'govt'|'witness')`, `severity`, `injuries_summary`, `vet_involved`, `location_description`, `jurisdiction_*`. **No se agregan campos al schema.**
   - `rabies_observation_started` schema (`~L653`): `bite_event_id (uuid)`, `observation_until (ISO)`, `location ('in_situ'|'official_site')`, `official_site_organization_id`.
   - `note_added` schema (`~L592`): `category` incluye `'system'`; `text`. Para la nota de reasignación.
   - `validateEventPayload(eventType, payload)` en `lib/event-schemas.ts`. `insertEventIdempotent(values, executor=db)` en `lib/event-idempotency.ts`.
   - `pets.rabies_observation_status` (`db/schema.ts` ~L589): `'in_progress'|'completed_*'`, enforced app-layer. **Solo aplica a pets registradas.**
   - Cron: `app/api/cron/close-rabies-observations/route.ts` → `src/modules/surveillance/application/close-eligible-observations.ts`. Cierra vía `repo.findPetsInProgress()` (query sobre `pets.rabies_observation_status='in_progress'`) → emite `rabies_observation_ended` + `setObservationStatus(...,'completed')`. Repo en `src/modules/surveillance/infrastructure/surveillance-repository.ts`.

   **Notificaciones / routing:**
   - `lib/notifications.ts`: insert a `notifications` con `{ userId, notificationType (texto libre), category, title, body, severity ('info'|'warning'|'urgent'), relatedPetId?, relatedCaseId?, ctaLabel, ctaUrl }`.
   - `lib/approval-routing.ts`: `findAuthoritiesForJurisdiction({ province, locality }): Promise<string[]>` — IDs de govts con assignment matching, fallback a admins. Fan-out manual (ver patrón en `close-eligible-observations.ts`).

   **Identidad / signup (post-Wave 5):**
   - `db/triggers.sql` `handle_new_user()` — Wave 5 lo extiende para setear `miarg_sub`, `dni_verified`, `dni_hash` desde claims OIDC.
   - `app/actions/auth.ts` — flujo de identidad. La reconciliación se engancha **después** de que el profile queda con `dni_hash` (post-Wave 5, callback OIDC).
   - `profiles.dni_hash`, `profiles.dni_last4`, `profiles.dni_verified` (post-Wave 5). Índice único en `dni_hash`.

   **Gates / welfare / entry:**
   - `lib/auth-guards.ts`: `requireAdminOrGovtOrRedirect()` → `{ user, profile:{id, role:'admin'|'govt'}, jurisdictions }`; `requireAdminOrRedirect()`; `requirePetAccess(token)` en `lib/pet-access.ts` → `{ ok, user:{id}, pet, accessPath:'owner'|'org' }`.
   - `welfare_reports.subjectKind` (`welfareReportSubjectKindEnum`, incluye `'unowned_animal'`) en `app/denuncias/nueva` — para el CTA del escenario A.
   - Quick-capture: `lib/event-capture-matcher.ts` + `lib/event-capture-registry.ts` + `/mis-mascotas/[publicToken]/anotar` — para el escenario B.

   **Tooling:**
   - Scripts: `pnpm typecheck` (`tsc --noEmit`), `pnpm lint` (`biome check .`), `pnpm test` (`vitest run`), `pnpm build`. `pnpm db:generate`, `pnpm db:migrate` (`tsx scripts/migrate.ts`).
   - Migraciones `db/migrations/NNNN_*.sql`. **Verificá la última y usá la siguiente** (`ls -1 db/migrations/*.sql | tail`). Tests en `__tests__/*.test.ts` (Vitest); patrón transaccional en `__tests__/business-rules-resolver.test.ts` o los del módulo cases.

4. Baseline verde: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Rojos pre-existentes → parar y avisar.

## 1. Qué construye este plan

El camino completo de "me/mi-mascota mordió un animal ajeno": captura → pet temporal + caso unowned + observación rábica → reasignación manual govt → reconciliación automática cuando el dueño se registra (por `dni_hash`). Reusa casos, el flujo de rabia y los event types existentes; agrega una sola tabla y dos alters.

## 2. Decisiones cerradas (del spec v2.0 §0 — no relitigar)

R1 casos ya existen · R2 reconciliación por `dni_hash` (gated a Wave 5) · R3 sin embargo de DNI · R4 modelo de víctima (A humano / B mi mascota) · R5 sin event types nuevos · R6 eventos del mordedor en `pet_events` con `pet_id` nullable · R7 govt force-escalate · R8 entry points: `/anotar` + `/denuncias`.

## 3. Scope

**Incluido:** todo lo de §1. **Excluido (v1):** reporte anónimo, bulk reconciliation queue, notif a DNIs sin cuenta por canales externos, dedup cross-incident, decomiso vía caso temporal. (Ver §11 del spec.)

## 4. Plan paso a paso

### Fase A — Schema (1 PR)

`db/migrations/NNNN_bite_from_unowned.sql` + reflejo en `db/schema.ts`:
- **Tabla `temporary_pet_descriptions`** según spec §4.1, **con la corrección R2**: en vez de `owner_dni_claimed` (texto) usar **`owner_dni_hash text`** + **`owner_dni_last4 text`**. Resto igual: `id, caseId (FK cases), species, breed, sex, estimatedAgeYears, size, color, distinguishingFeatures, ownerNameClaimed, ownerContactClaimed, microchipNumberClaimed, publicTokenClaimed, biteLocation{Lat,Lng,Address}, replacedAt, replacedByPetId, replacedByUserId, createdAt`. CHECK `(replaced_at IS NULL) = (replaced_by_pet_id IS NULL AND replaced_by_user_id IS NULL)`.
- Índices parciales (R2): por `owner_dni_hash` (no `owner_dni_claimed`) y por `microchip_number_claimed`, ambos `WHERE ... IS NOT NULL AND replaced_at IS NULL`.
- **`cases.temporary_pet_description_id uuid`** FK nullable a `temporary_pet_descriptions` (backlink, spec §4.2).
- **`pet_events.pet_id` → nullable + CHECK `pet_events_subject_consistency`** (spec §4.3 / R6): `pet_id IS NOT NULL OR (case_id IS NOT NULL AND EXISTS(SELECT 1 FROM cases c WHERE c.id=pet_events.case_id AND c.primary_subject_kind <> 'registered_pet'))`.
- **Paso de verificación crítico (R6):** `grep -rn "pet_id\|petId" src lib app db` y auditar todo consumidor que asuma `pet_id` presente — proyecciones (`lib/projections/*`), RLS (`db/*_rls.sql`), queries que joinean `pet_events`→`pets`. Documentar en el PR los que se revisaron y por qué siguen seguros (los eventos con `pet_id=NULL` solo existen para casos unowned; los consumidores de pet-timeline filtran por `pet_id`). Tests de constraint en `__tests__`.

### Fase B — `reportBiteFromUnownedAction` + wizard (2 PRs)

UI `/incidentes/mordedura-recibida` (wizard 3 pasos, spec §5.2) + action (spec §5.3) con la corrección de víctima R4:
- **Paso 1 — identificación:** microchip / DIM-token → si resuelve a pet real, derivar al flujo de bite registrado existente (subject=registered_pet) y terminar. (DNI **no** se usa para match inmediato; solo se captura para reconciliación.)
- **Paso 2 — descripción** del animal ajeno.
- **Paso 3 — incidente** + **víctima (R4):** si el entry es `/anotar` sobre mi mascota → `victim_kind='animal'`, `victim_pet_id=<mi pet>`; si es `/denuncias` → `victim_kind='human'` + contacto. Captura de DNI del dueño: input opcional que se persiste **hasheado** (`owner_dni_hash = hmac(input, pepper)`, helper de Wave 5) + `owner_dni_last4`. Nunca el número.
- **Action (TX atómica):** INSERT `temporary_pet_descriptions` → `casesRepository.openCase({ kind:'bite_incident', primarySubjectKind:'unowned_animal', primaryPetId:null, jurisdiction derivada del bite_location, openedByUserId:victim, openedReason })` + set `cases.temporary_pet_description_id` → INSERT `pet_events` `incident_reported` (`pet_id=NULL, case_id`, payload con `incident_type='bite_inflicted'`*, `victim_kind`, `victim_pet_id`, `reporter_role`, snapshot del temp) → INSERT `pet_events` `rabies_observation_started` (`pet_id=NULL, case_id`) → si escenario B, INSERT `incident_reported(incident_type='bite_suffered', victim_pet_id)` en `pet_events` de **mi mascota** (con `pet_id`) → notif a govt (`findAuthoritiesForJurisdiction`) severity `warning` → notif al reportante con el `CAS-XXXX`. Redirect a `/casos/[publicCode]`.

  \* el `incident_type` del evento del mordedor describe la mordedura desde el animal ajeno; usar la convención del schema (probablemente `bite_inflicted` con `victim_*`). Confirmar contra el uso existente en el flujo registrado para no divergir.

Entry points (R8): registrar patrón en `lib/event-capture-matcher.ts` ("me mordió un perro", "perro callejero") → `/incidentes/mordedura-recibida`; CTA en `app/denuncias/nueva` cuando `subjectKind='unowned_animal'` + mordedura.

### Fase C — Render del caso unowned (1 PR)

`/casos/[publicCode]`: card del subject `unowned_animal` con la descripción del temp pet (spec §5.4). Botón "Reasignar a pet real" y "Escalar a urgente" **solo** para govt scope-matching/admin.

### Fase D — `reassignBiteCaseAction` + UI (1 PR)

Espejar `ReasignarButton` de decomisos. Action (spec §6.3): gate `requireAdminOrGovtOrRedirect` + scope; TX: UPDATE `cases` (`primary_subject_kind='registered_pet'`, `primary_pet_id=<new>`, preserva `temporary_pet_description_id`) + UPDATE `temporary_pet_descriptions` (`replaced_at`, `replaced_by_pet_id`, `replaced_by_user_id`) + INSERT `note_added(category='system', case_id, pet_id=<new>)` con quién/cuándo/motivo + sync `pets.rabies_observation_status='in_progress'` si la observación sigue abierta + notif urgent al owner de la pet real + audit. **+ Botón "Escalar a urgente" (R7):** action que marca el caso escalado + notif govt; sin auto-escalation.

### Fase E — Reconciliación on signup (1 PR, **depende de Wave 5**)

Hook post-signup (spec §7, corregido R2): tras setear `profiles.dni_hash` (callback OIDC de Wave 5), buscar `temporary_pet_descriptions WHERE owner_dni_hash = NEW.dni_hash AND replaced_at IS NULL` → 1 notif `bite_case_reconciliation_proposal` con N matches → CTA `/cuenta/reconciliacion-bites`. UI lista casos + selector de pets propias. `confirmBiteReconciliationAction`: si elige pet propia → mismo flujo que `reassignBiteCaseAction` con `actor.role='owner'` en la nota; si "no es mía" → archiva + flag `owner_disputed_at` (opcional). (Edge cases spec §7.4.)

### Fase F — Branch del cron para unowned (1 PR)

`close-eligible-observations`: además de `findPetsInProgress()` (registradas), agregar `findUnownedObservationsInProgress()` que busca casos `bite_incident(unowned_animal)` con `rabies_observation_started` sin `_ended` y abiertos. Branch de cierre: emitir `rabies_observation_ended` con `pet_id=NULL, case_id`, outcome `negative`, **sin** tocar `pets.rabies_observation_status` (no hay pet). Reusar `validateEventPayload` + `insertEventIdempotent`.

### Fase G — Tests + docs (1 PR)

Tests del spec §9 (constraints, actions, reconciliación por hash, E2E de los dos escenarios). Docs: cerrar el cross-ref en `2026-05-18-bite-rabies-observation-design.md` + `cases-lifecycles` (lifecycle del `bite_incident(unowned)`); README → ✅ + SHA.

## 5. Orden / dependencias

A → B → C → D → (E depende de Wave 5) ; F en paralelo a C/D ; G al final. **E no puede empezar antes de Wave 5.** A–D + F + G entregan el core (reporte + observación + reasignación) y son técnicamente independientes de Wave 5 — pero como el feature entero es backlog y la temp table nace con `owner_dni_hash`, conviene ejecutar todo junto **después** de Wave 5 para no introducir el campo de hash sin el pepper disponible.

## 6. Verificación final (checklist)

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verde.
- [ ] `grep dni_number` = 0 hits (Wave 5 confirmada) y el temp table guarda solo `owner_dni_hash`/`last4`.
- [ ] Reportar por `/anotar` (escenario B) linkea `victim_pet_id` + crea `bite_suffered` en la libreta de mi mascota.
- [ ] Reportar por `/denuncias` (escenario A) crea el caso con `victim_kind='human'`.
- [ ] Caso unowned crea temp + caso + 2 eventos (`pet_id=NULL`) atómico; observación de 10 días arranca.
- [ ] `pet_events.pet_id` nullable + CHECK; **audit de consumidores documentado en el PR**.
- [ ] Reasignación govt: case→registered_pet, temp.replaced, note_added(system), notif urgent al owner.
- [ ] Botón "Escalar a urgente" visible solo para govt/admin.
- [ ] Reconciliación: signup con `dni_hash` matching → notif → confirmar vincula el caso a la pet propia.
- [ ] Cron cierra observaciones unowned sin tocar `pets.rabies_observation_status`.
- [ ] Sin event types nuevos en el catálogo (solo reuso).

## 7. Riesgos / notas

- **`pet_events.pet_id` nullable es el cambio de mayor blast radius** (tabla central). El audit de consumidores de Fase A es obligatorio, no opcional. Si aparece un consumidor que rompe con `pet_id=NULL`, evaluar la alternativa `case_events` (R6) antes de forzar.
- **Pepper/HMAC:** usar el helper de Wave 5; no reimplementar. Tests con pepper de test determinístico.
- **`incident_type` del mordedor:** confirmar la convención exacta contra el flujo de bite registrado existente para no divergir (`bite_inflicted` + `victim_*` vs otra). El spec asume reutilización directa.
- **Idempotencia:** `insertEventIdempotent` usa índice parcial sobre `(pet_id, event_type, client_idempotency_key)`; con `pet_id=NULL` verificá que la idempotencia siga funcionando (puede requerir incluir `case_id` en la key para eventos unowned).
