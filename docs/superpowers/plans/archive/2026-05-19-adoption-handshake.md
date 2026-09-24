# Adoption handshake: two-phase con PDF de política de adopción

> Plan ejecutable para Claude Code. Reemplaza el actual `finalizeAdoptionAction` (one-shot, con path DNI-stub y foster-shortcut) por un **handshake en dos fases** donde la org propone la adopción a un usuario autenticado existente y el usuario debe aceptar explícitamente tras leer el PDF de política de adopción que la org subió previamente. Nada de stubs, nada de DNI a ciegas, nada de finalización sin consentimiento del adoptante.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~30 archivos nuevos/modificados, 1 migración, 1 storage bucket nuevo, 1 cron route, 1 lifecycle file
> **Estimación:** 1.5–2 días en 6 fases shippeables independientes

---

## Context — por qué este cambio

Hoy, `finalizeAdoptionAction` ejecuta la adopción en una sola transacción del lado de la org. Tiene dos caminos para identificar al adoptante:

1. **DNI tipeado**: si la `profiles` table tiene una fila con ese DNI, se usa ese perfil; si no, se crea un stub profile (sin link a `auth.users`). El adoptante real, cuando se registre en DIM, recupera la stub vía `claimStubProfileAction`.
2. **Foster-shortcut**: la org pasa el `profiles.id` del foster activo en el form; sin DNI, sin stub.

Tres problemas:

- **El claim por DNI es brute-forceable** (review 2026-05-19 §2.1). El usuario decidió esperar a Mi Argentina y `STUB_CLAIM_ENABLED` está en `false`. Eso deja a la rama DNI **rota** para usuarios no-DIM: la org crea un stub que nadie puede reclamar.
- **El adoptante nunca da consentimiento explícito en plataforma.** La org clickea "Finalizar" y la mascota cambia de owner sin ninguna acción del adoptante. La firma del contrato vive off-platform (papel, email).
- **El PDF de contrato no funciona.** `lib/uploads.ts:23` rechaza cualquier mime que no sea `image/*`. `FinalizeAdoptionForm.tsx` declara `accept="application/pdf,image/*"` pero el server tira 422 — bug latente.

Este plan resuelve los tres en un movimiento: introduce un handshake con expiración auto-cancelable, fuerza la selección del adoptante desde una `adoption_application` ya aprobada (= ya es usuario DIM autenticado), y materializa en una tabla nueva la política de adopción que la org sube una sola vez.

**Outcome esperado**: toda adopción en DIM queda registrada como un consentimiento explícito del adoptante autenticado tras leer el PDF de la org, con trazabilidad completa (handshake row + case + audit_log + dos pet_events).

---

## 0. CUÁNDO EJECUTAR ESTE PLAN

### Prerequisitos (hard-blocking)

1. **Review 2026-05-19 §2.1 mergeado** — `STUB_CLAIM_ENABLED = false`. Es el punto de partida conceptual de este plan. Si no está, la rama DNI sigue creando stubs que después nadie puede reclamar.
2. **Review 2026-05-19 §2.5 tier 1 mergeado** — el patrón `pendingNotifications[]` post-commit ya está aplicado en `cross-org-transfer.ts`, `foster-proposals.ts`, `adoption.ts`, `transfer.ts`, `claim.ts`. Este plan asume ese patrón y lo replica.
3. **`pnpm typecheck && pnpm lint && pnpm test` verdes en main** al momento de arrancar.

### Decisiones cerradas (heredadas del prompt del usuario, 2026-05-19)

| # | Decisión | Razón |
|---|---|---|
| D1 | PDF: **org template only**, no per-adoption. Una org, un PDF reemplazable. | Mínima fricción para la org. El "contrato firmado" sigue siendo off-platform — el PDF en plataforma es la política/términos. |
| D2 | Adoptante: **siempre desde una `adoption_application` aprobada**. No hay búsqueda libre. | El applicant ya es un usuario DIM autenticado (requisito de `submitAdoptionApplicationAction`). Cero stubs. |
| D3 | **Reemplaza** `finalizeAdoptionAction` por completo. Incluso el foster-shortcut va por el handshake. | Un solo flow para todas las adopciones. El foster ve el PDF como cualquier otro adoptante y firma. |
| D4 | Expiración: **14 días** desde propose. | Punto medio entre foster (7d) y cross-org-transfer (30d). Mid-stakes, requiere leer un contrato pero no debe dejar mascotas en limbo. |
| D5 | Admin de plataforma (`role='admin'`) puede subir la política en nombre de cualquier org. | Cubre orgs que se atrasaron con el setup. No es el path principal. |
| D6 | Si la org aprueba una application sin política subida → **error con deep-link al config de la org**, no auto-prompt silencioso. | Aprobar adopciones es un evento raro; un error explícito es mejor que un flow ambiguo. |
| D7 | `approveAdoptionApplicationAction` y `proposeAdoptionHandshakeAction` quedan **fusionados** en una sola transacción del lado de la org. | Elimina la clase de bugs "aprobada pero no propuesta". |
| D8 | El PDF se sirve via **signed URL + link `target=_blank`**, no embed. Checkbox "Lo leí" gatea el botón Aceptar en el cliente. | Renderizar PDF cross-platform (en especial mobile) es inestable; signed URL + checkbox es accesible y simple. |
| D9 | El handshake guarda **snapshot** del `policy_document_id` (FK) **+ `policy_storage_path` denormalizado**. | Un handshake propuesto hoy debe mostrar la política como era hoy, no la que la org subió mañana. Belt-and-suspenders ante borrado del org_documents row. |

### Cuándo NO ejecutar

- Si hay stubs en producción y un plan de migración masiva para ellos pendiente. Este plan **no migra stubs existentes**; los deja como están (dead ownership records esperando Mi Argentina). Si hay >50 stubs activos y operaciones reales detrás, hacer primero un sweep de cleanup.

---

## 1. Antes de tocar nada

Lectura obligatoria, en este orden:

1. **`AGENTS.md` → Adopción** completo. El modelo conceptual del flow actual.
2. **`app/actions/adoption.ts:finalizeAdoptionAction` (líneas 60–420)** — el monolito a desarmar. Identificar bien los bloques: identity resolution (76–186), ownership transfer (217–301), cascade auto-rejection (303–351), attachment insert (354–364), reminders backfill (366–415).
3. **`app/actions/foster-proposals.ts:acceptFosterProposalAction` (líneas 326–610)** — el template estructural para `acceptAdoptionHandshakeAction`. Mismo shape: validar recipient = `user.id`, status=pending, atomically transfer state, emit pair of events, cascade, notify post-commit.
4. **`app/(app)/cuenta/transitos/propuestas/[proposalToken]/page.tsx` + `ProposalActions.tsx`** — UX template adopter-side.
5. **`lib/case-helpers.ts` (`openCase`, `closeCase`, `findOpenCaseForPetAndKind`, `cascadeTriggerPayload`)** — utilities core del case system. **Reusar**, no replicar.
6. **`lib/case-cron.ts:runCaseCron` + `lib/case-closers/expire-cross-org-transfers.ts`** — pattern de cron expirer que vamos a clonar.
7. **`lib/uploads.ts:uploadAttachmentIfPresent`** — entender por qué NO se modifica (sigue siendo image-only para event-attachments), sino que se introduce un sibling.
8. **`db/migrations/0033_cases.sql` líneas 128–138** — confirmar que `adoption_handshake` cae bajo el partial unique index genérico (`primary_pet_id, case_kind WHERE status in ('open','escalated')`). Esto da gratis el invariante de "una sola adopción abierta por mascota".

---

## 2. Qué construye este plan

### 2.1 Cambio conceptual

```
ANTES                                          DESPUÉS
─────                                          ───────

[Usuario] postula                              [Usuario] postula
   ↓                                              ↓
[Org] aprueba (off-platform: llamado)          [Org] aprueba → propone handshake atómicamente
   ↓                                              ↓
[Org] finalizeAdoptionAction (one-shot,        [Adoptante] recibe notif, abre /cuenta/adopciones/[token]
       crea stub si DNI no matchea)               ↓
   ↓                                           [Adoptante] descarga PDF, marca "lo leí", clickea Aceptar
[Mascota] cambia de owner sin acción              ↓
       del adoptante                           [Sistema] transfiere ownership atomically
                                                  + emite adoption_finalized + cascade auto-reject
                                                  + agenda check-ins
                                                  + cierra el case
```

### 2.2 Lo que NO construye

- Búsqueda libre de usuarios para que la org "elija" un adoptante. Cerrado por D2: siempre desde application.
- Per-adoption signed-contract upload. Cerrado por D1: solo template org.
- PDF viewer embebido. Cerrado por D8: link `target=_blank`.
- Migración de stubs existentes a usuarios reales (sigue dependiendo de Mi Argentina, fuera de scope).
- Notificaciones por email / push (sigue siendo solo notifications inbox; el envelope multi-canal es otro plan).

---

## 3. Schema y catálogos

### 3.1 Tablas nuevas (1 migración: `db/migrations/0038_adoption_handshake_foundation.sql`)

**`organization_documents`** — guarda el PDF de política directamente, sin pasar por `attachments`. Mirror estructural de `welfare_report_attachments`.

```sql
create table public.organization_documents (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  document_type         text not null check (document_type in ('adoption_policy')),
  storage_path          text not null,
  mime_type             text not null check (mime_type = 'application/pdf'),
  file_size             integer,
  uploaded_by_user_id   uuid not null references public.profiles(id) on delete restrict,
  uploaded_at           timestamptz not null default now(),
  deleted_at            timestamptz
);

create unique index organization_documents_unique_active
  on public.organization_documents (organization_id, document_type)
  where deleted_at is null;
```

Soft-delete sobre reemplazo (preserva el `policy_storage_path` snapshot de handshakes viejos via la FK). `document_type` enum-via-CHECK para futura extensión (`'intake_policy'`, `'tos'`).

**`adoption_handshakes`** — la state machine. Foster-proposals style.

```sql
create table public.adoption_handshakes (
  id                       uuid primary key default gen_random_uuid(),
  public_token             text not null unique,                   -- ADH-XXXX-XXXX
  case_id                  uuid not null references public.cases(id) on delete restrict,
  pet_id                   uuid not null references public.pets(id) on delete restrict,
  organization_id          uuid not null references public.organizations(id) on delete restrict,
  adopter_user_id          uuid not null references public.profiles(id) on delete restrict,
  application_event_id     uuid references public.pet_events(id) on delete set null,
  policy_document_id       uuid references public.organization_documents(id) on delete set null,
  policy_storage_path      text not null,                          -- snapshot
  status                   text not null default 'pending'
    check (status in ('pending','accepted','rejected','cancelled','expired')),
  expires_at               timestamptz not null,
  accepted_at              timestamptz,
  accepted_notes           text,
  resolved_ownership_id    uuid references public.ownerships(id) on delete set null,
  rejected_at              timestamptz,
  rejection_reason         text,
  cancelled_at             timestamptz,
  cancelled_by_user_id     uuid references public.profiles(id) on delete set null,
  cancellation_reason      text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint adoption_handshakes_accept_consistent check (
    (status = 'accepted' and accepted_at is not null and resolved_ownership_id is not null)
    or (status <> 'accepted')
  ),
  constraint adoption_handshakes_reject_consistent check (
    (status = 'rejected' and rejected_at is not null) or (status <> 'rejected')
  ),
  constraint adoption_handshakes_cancel_consistent check (
    (status = 'cancelled' and cancelled_at is not null) or (status <> 'cancelled')
  )
);

create index adoption_handshakes_status_expires_idx
  on public.adoption_handshakes (status, expires_at);   -- cron scan
create index adoption_handshakes_adopter_pending_idx
  on public.adoption_handshakes (adopter_user_id, status)
  where status = 'pending';                              -- adopter inbox
create index adoption_handshakes_pet_pending_idx
  on public.adoption_handshakes (pet_id)
  where status = 'pending';                              -- one-pending-per-pet guard
```

### 3.2 Storage bucket nuevo

- Bucket: `org-documents`
- Privado (sin acceso público)
- RLS:
  - INSERT: usuarios con membership en la org + admins
  - SELECT: usuarios con membership en la org + admins + lectura via signed URL para terceros (signed URL bypasses RLS)
- Path convention: `{organization_id}/adoption_policy/{uuid}.pdf`

### 3.3 Espejo en `db/schema.ts`

- `organizationDocuments` table builder
- `adoptionHandshakes` table builder
- Re-export desde `db/index.ts`
- CHECK constraints mirroreadas via `check()` (review 2026-05-19 §3.3 ya marca el patrón)

### 3.4 Catálogos a actualizar

- **`lib/case-kinds.ts`** — agregar `"adoption_handshake"` a `CASE_KINDS` y `V1_CASE_KINDS`. Label: "Adopción en curso".
- **`lib/case-lifecycles/adoption-handshake.ts`** — archivo nuevo. Mirror de `lib/case-lifecycles/foster-placement.ts`.
- **`lib/case-attachment.ts`** y **`lib/case-normatives.ts`** — registrar el nuevo case kind (review esta dependencia comentada en `lib/case-kinds.ts:10`).
- **`lib/event-schemas.ts`** — agregar:
  - `adoption_handshake_proposed`: `{ handshake_id, adopter_user_id, policy_document_id, policy_storage_path, expires_at }`
  - `adoption_handshake_resolved`: `{ handshake_id, outcome: 'accepted'|'rejected'|'cancelled'|'expired', auto_generated?, notes?, reason? }`
  - **Extender `adoption_finalized`** con `policy_document_id` opcional (back-compat preservado; eventos viejos siguen validando con `contract_attachment_id: null`).
- **`db/schema.ts:AUDIT_LOG_ACTIONS`** — agregar:
  - `adoption_handshake_proposed`
  - `adoption_handshake_accepted`
  - `adoption_handshake_rejected`
  - `adoption_handshake_cancelled`
  - `adoption_handshake_expired`
  - `org_document_uploaded`
  - `org_document_replaced`

### 3.5 Capabilities

- Reusar `adoption.review` para `proposeAdoptionHandshakeAction` y `cancelAdoptionHandshakeAction` (la misma persona que aprueba debería poder cancelar).
- `adoption.finalize` queda **vestigial** — evaluar retirar al final del plan o dejar para auditoría retroactiva.
- `uploadAdoptionPolicyAction` gatea por `adoption.review` OR `role='admin'`.
- `acceptAdoptionHandshakeAction` / `rejectAdoptionHandshakeAction`: self-service, sin capability check (verifica `user.id === adopter_user_id`).

---

## 4. Implementación por fases

Cada fase es shippeable independiente. Después de cada una, `pnpm typecheck && pnpm lint && pnpm test` deben quedar verdes.

### Fase 1 — Fundación (sin UI, sin behavior change)

**Goal**: schema y tipos disponibles, código gated detrás de paths que nadie llama todavía.

Archivos:
- `db/migrations/0038_adoption_handshake_foundation.sql` — nuevo. Crea bucket, RLS, tablas, índices.
- `db/schema.ts` — agregar `organizationDocuments`, `adoptionHandshakes`. Agregar las 7 nuevas acciones a `AUDIT_LOG_ACTIONS`. Extender el zod de `adoption_finalized` con `policy_document_id` opcional.
- `db/index.ts` — re-exports.
- `lib/case-kinds.ts` — agregar `adoption_handshake` a `CASE_KINDS` y `V1_CASE_KINDS`.
- `lib/case-lifecycles/adoption-handshake.ts` — nuevo. Define open/close transitions y labels en español.
- `lib/case-attachment.ts`, `lib/case-normatives.ts` — registrar el nuevo kind.
- `lib/event-schemas.ts` — registrar `adoption_handshake_proposed` y `adoption_handshake_resolved`.
- `lib/uploads.ts` — agregar `uploadDocumentIfPresent(supabase, file, bucket, { allowedMimes, maxSizeBytes })`. **No tocar** `uploadAttachmentIfPresent` (su image-only es correcto para event-attachments).
- `lib/storage.ts` — agregar `orgDocumentSignedUrl(supabase, storagePath, expiresIn)` (mirror del welfare-attachment signed URL).
- `lib/publicToken.ts` — agregar `generateAdoptionHandshakeToken()` con prefix `"ADH"`.

Tests (Fase 1):
- Coverage test que ya valida `lib/case-lifecycles/<kind>.ts` exists debe pasar para `adoption_handshake`.
- Schema integration test que inserta filas en ambas tablas nuevas y verifica los CHECK constraints.

**Sin cambios visibles para el usuario. Safe to ship.**

### Fase 2 — Upload de política (org-side)

**Goal**: las orgs pueden subir y reemplazar su PDF. Nada más lo usa todavía.

Archivos nuevos:
- `app/actions/organization-documents.ts`:
  - `uploadAdoptionPolicyAction(orgToken, formData)` — gate por `adoption.review` OR `role='admin'`. PDF only via `uploadDocumentIfPresent` (cap 10 MB). Soft-delete del row anterior, insert del nuevo, audit_log row.
  - `deleteAdoptionPolicyAction(orgToken)` — soft-delete idempotente, audit_log row.
- `app/org/[orgToken]/configuracion/adopciones/page.tsx` — server component. Carga `organization_documents` activo (si existe), renderiza upload form + preview link.
- `app/org/[orgToken]/configuracion/adopciones/PolicyUploadForm.tsx` — client component, useActionState, `accept="application/pdf"`, max 10 MB indicator.

Tests:
- `__tests__/organization-documents.test.ts`: upload, replace (soft-delete + insert atómico), delete, gate por capability, mime guard.

**Shippeable independiente.** Las orgs empiezan a subir templates. El finalize viejo sigue funcionando intacto.

### Fase 3 — Handshake server actions (sin swap de UI)

**Goal**: el flow nuevo corre end-to-end via testing, pero la UI sigue mostrando el flow viejo.

Archivos:
- `app/actions/adoption-handshakes.ts` — **nuevo, núcleo del plan**:
  - `proposeAdoptionHandshakeAction({ orgToken, applicationEventId })` — exportado pero solo llamado internamente desde `approveAdoptionApplicationAction` (ver abajo).
    - Validar pet+org match (load del application event).
    - Validar `organization_documents` activo `(org.id, 'adoption_policy')` existe — error con `missingPolicy: true` si no.
    - Validar no hay handshake `status='pending'` para esta mascota.
    - `openCase({ kind: 'adoption_handshake', primaryPetId, applicantUserId: adopter, openedByOrganizationId, ... })`.
    - Insert `adoption_handshakes` row (publicToken, expires_at = now + 14d, snapshot del policy_document_id + policy_storage_path).
    - Emit `adoption_handshake_proposed` event linked al case.
    - Push notification al adopter en `pendingNotifications[]` con `ctaUrl: /cuenta/adopciones/[publicToken]`.
    - audit_log row.
  - `acceptAdoptionHandshakeAction({ handshakeToken, notes })` — self-service:
    - Verificar `user.id === handshake.adopterUserId`, status=pending, expires_at > now.
    - **Atomically (lift de `finalizeAdoptionAction:217-419` menos las ramas DNI/stub)**:
      - Close shelter_custody ownership de la org.
      - Close active foster ownership row + close foster_placement case si existe.
      - Insert owner ownership row (rol `owner`).
      - Update handshake row (status=accepted, accepted_at, accepted_notes, resolved_ownership_id).
      - Emit `adoption_handshake_resolved(outcome=accepted)` event.
      - Emit `adoption_finalized` event con `policy_document_id` poblado.
      - Cascade auto-rejection de otras applications pending (SQL scan portado verbatim de `adoption.ts:303-351`).
      - Schedule post-adoption check-in reminders (1/3/6/12 months) — pattern actual de `adoption.ts:366-415`.
      - `closeCase(reason='resolved')` para el handshake case.
      - Push notifications a org coordinators + ex-foster (si distinto del adopter) en `pendingNotifications[]`.
    - Post-tx: insert batched de `pendingNotifications`.
    - audit_log row.
  - `rejectAdoptionHandshakeAction({ handshakeToken, reason })` — self-service:
    - Verificar `user.id === adopterUserId`, status=pending.
    - Update handshake (status=rejected, rejected_at, rejection_reason).
    - Emit `adoption_handshake_resolved(outcome=rejected)` + `adoption_application_resolved(rejected, reason='adopter_declined', auto_generated=true)`.
    - `closeCase(reason='cancelled')`.
    - Push notifications a org coordinators.
    - audit_log row.
  - `cancelAdoptionHandshakeAction({ orgToken, handshakeToken, reason })` — org-side:
    - Gate por `adoption.review`, verificar org match.
    - Update handshake (status=cancelled, cancelled_at, cancelled_by_user_id, cancellation_reason).
    - Emit `adoption_handshake_resolved(outcome=cancelled)`.
    - `closeCase(reason='cancelled')`.
    - Push notification al adopter.
    - audit_log row.
- `app/actions/adoption-applications.ts` — **modificar**:
  - `approveAdoptionApplicationAction`: en la misma transacción que emite `adoption_application_resolved(approved)`, ahora también:
    - Pre-flight (fuera del tx) lookup de `organization_documents` activo `(org.id, 'adoption_policy')`. Si no existe, return error con copy "Subí la política de adopción antes de aprobar esta postulación" + URL `/org/[orgToken]/configuracion/adopciones`.
    - Inline la lógica de `proposeAdoptionHandshakeAction` (no recursión entre actions — directo en el mismo tx).
    - La notification al applicant cambia: el CTA ahora apunta a `/cuenta/adopciones/[handshakeToken]` con label "Ver contrato y aceptar".
- `lib/adoption-handshake-expirer.ts` — **nuevo**. Mirror de `lib/foster-proposal-expirer.ts`:
  - `findExpiredAdoptionHandshakes()` — scan `adoption_handshakes WHERE status='pending' AND expires_at < now()`.
  - `expireAdoptionHandshake(handshake)` — per-row: re-check status=pending dentro del tx, update a expired, emit `adoption_handshake_resolved(outcome=expired, auto_generated=true)` + `adoption_application_resolved(rejected, reason='expired', auto_generated=true)`, `closeCase(reason='auto_expired')`, notify ambos lados.
- `app/api/cron/expire-adoption-handshakes/route.ts` — **nuevo**. Mirror de `app/api/cron/expire-foster-proposals/route.ts`. Uses `runCaseCron` harness.
- `vercel.json` — agregar el cron schedule (sugerido: `0 */6 * * *`, cada 6 horas).

Tests:
- `__tests__/adoption-handshake-propose.test.ts` — happy + missing policy + duplicate pending + capability gate.
- `__tests__/adoption-handshake-accept.test.ts` — happy + cascade auto-rejection + check-in reminders agendados + foster-end cascade + expired handshake rejected.
- `__tests__/adoption-handshake-reject.test.ts` — happy + notif a org + emite `adoption_application_resolved`.
- `__tests__/adoption-handshake-cancel.test.ts` — org-side, gate, idempotencia.
- `__tests__/adoption-handshake-expirer.test.ts` — cron behavior, idempotencia, audit row.

**Backend completo, sin UI nueva todavía.** El finalize viejo sigue existiendo y sigue siendo el path activo. Esta fase es la **más riesgosa** — desplegar con observabilidad encendida.

### Fase 4 — UI adopter-side

**Goal**: el adopter ve y actúa sobre los handshakes propuestos.

Archivos nuevos:
- `app/(app)/cuenta/adopciones/page.tsx` — server component. Lista handshakes pending para `user.id`, status=pending OR finalized recientemente. Cards con pet info + org info + state badge + CTA.
- `app/(app)/cuenta/adopciones/[handshakeToken]/page.tsx` — server component. Loads handshake by `publicToken`, verifica `adopter_user_id === user.id`. Renders:
  - Pet info (name, species, breed, photo via `petPhotoUrl`)
  - Org info (displayName, link a `/refugios/[orgToken]`)
  - "Contrato de adopción" link al PDF via `orgDocumentSignedUrl(handshake.policy_storage_path)`, `target="_blank"`, `rel="noopener"`, `download` attribute opcional
  - Si status=pending: client component `AdoptionHandshakeActions`
  - Si status=accepted/rejected/cancelled/expired: read-only summary con timestamp
- `app/(app)/cuenta/adopciones/[handshakeToken]/AdoptionHandshakeActions.tsx` — client component. Mirror de `ProposalActions.tsx`:
  - Mode toggle ("ninguno" / "aceptar" / "rechazar")
  - En modo "aceptar": checkbox **required** "Descargué y leí el contrato de adopción" + textarea opcional para notas + botón "Aceptar adopción" (disabled hasta que checkbox=true)
  - En modo "rechazar": textarea opcional para motivo + botón "Rechazar"
  - useActionState wrapping de `acceptAdoptionHandshakeAction` / `rejectAdoptionHandshakeAction`
  - Error display + success redirect a `/cuenta/adopciones`

Tests:
- E2E (Playwright si existe; si no, integration test del action): adopter recibe notif → abre URL → ve PDF link → marca checkbox → acepta → ownership transferida.

### Fase 5 — Swap de UI org-side + deprecación del flow viejo

**Goal**: las orgs dejan de ver el botón "Finalizar adopción". El código viejo desaparece.

Archivos a modificar:
- `app/org/[orgToken]/adopciones/[applicationEventId]/page.tsx` (o equivalente) — el botón "Finalizar" se reemplaza por "Aprobar postulación" que llama `approveAdoptionApplicationAction` (que ya hace el propose). Si la org no tiene política subida, mostrar warning banner con CTA al config.
  - Si ya existe un handshake pending para esta application: mostrar estado read-only con "Cancelar handshake" + "Ver detalle" en lugar del botón aprobar.
- `app/org/[orgToken]/mascotas/[publicToken]/page.tsx` — quitar el CTA "Finalizar adopción" (si existe). Reemplazar por "Ver handshake activo" si está en curso.
- `app/org/[orgToken]/mascotas/page.tsx` — actualizar badges/state indicators que apunten al flow viejo.

Archivos a **eliminar**:
- `app/org/[orgToken]/mascotas/[publicToken]/adoption/page.tsx`
- `app/org/[orgToken]/mascotas/[publicToken]/adoption/FinalizeAdoptionForm.tsx`
- `app/actions/adoption.ts` (o reducir a stub que retorna error "use handshake flow"). Decisión: **eliminar** si nadie más lo importa; **stub** si hay tests legacy que tarden en migrar.

Tests a actualizar:
- `__tests__/foster-e2e-flow.test.ts` — el step de finalize se reemplaza por propose+accept del handshake.
- `__tests__/adoption-cascade.test.ts` — re-target a `acceptAdoptionHandshakeAction`.
- Cualquier test que invoque `finalizeAdoptionAction` directamente — re-target.
- Eliminar o reescribir tests específicos de stub-claim si existen (probablemente ya estén medio rotos por §2.1).

### Fase 6 — Polish + observabilidad

- Audit log writes confirmados para los 7 actions nuevos.
- Notification badges en el navbar del adopter mostrando handshakes pending.
- RLS audit: confirmar policies en `organization_documents` y `adoption_handshakes`:
  - `organization_documents`: org members + admins (R/W), terceros sin acceso (lectura siempre via signed URL).
  - `adoption_handshakes`: org members del organization_id (R), adopter_user_id (R), admins (R), nadie escribe directamente — solo server actions.
- Doc updates en `AGENTS.md`:
  - Sección "Adopción" reescrita con el nuevo flow (state diagram + actores).
  - Sección "Capacidades" actualizada — `adoption.finalize` vestigial, `adoption.review` cubre propose+cancel.
- README.md update: si hay sección sobre adopción, alinear.

---

## 5. Riesgos y decisiones abiertas

| Riesgo | Mitigación |
|---|---|
| **Stubs existentes en producción** | Plan no los migra. Antes del deploy de Fase 5, correr query: `SELECT count(*) FROM profiles WHERE id NOT IN (SELECT id FROM auth.users) AND dni_verified=false`. Si >10, considerar plan separado de cleanup o mensajes proactivos a las orgs afectadas. |
| **Race condition: dos org members aprueban simultáneamente** | El partial unique index sobre `(primary_pet_id, case_kind='adoption_handshake') WHERE status in ('open','escalated')` agarra el segundo intento con error DB. **Action item**: en `approveAdoptionApplicationAction`, traducir ese error específico ("ya hay una adopción en curso para esta mascota") en vez de bubblear el SQL crudo. Patrón: review 2026-05-19 §2.8. |
| **`adoption.finalize` capability queda huérfana** | Decisión abierta: retirar al final de Fase 6 o dejar para handshake-cancel. Recomendación: dejar para cancel y `adoption.review` para propose, así no se pierde el principio de menor privilegio. |
| **PDF >10 MB** | Cap actual en `uploadDocumentIfPresent`. Si una org real tiene contratos legales largos, subir a 15 MB. No bajar de 10. |
| **Free-tier Supabase storage** | `org-documents` bucket: con 100 orgs × 5 MB promedio = 500 MB. Está dentro de free tier por un buen tiempo. Monitorear en `/admin`. |
| **Adopter accepts after policy was replaced** | Resuelto por D9 — el handshake tiene snapshot del `policy_storage_path`. El borrado del row de `organization_documents` no rompe el signed URL del path snapshotted (el archivo en storage sigue ahí). Si la org borra el archivo manualmente vía Studio, el signed URL devuelve 404 — riesgo aceptado, no bloqueante. |
| **Tests del cascade auto-rejection** | El SQL scan en `adoption.ts:303-351` depende solo de `pet.id`, `organization`, `adopterUserId`, `user.id`, `now`. Todos disponibles en el nuevo call site. Pero re-correr tests específicos del cascade en Fase 3 antes de proceder. |

### Decisiones abiertas (resolver durante implementación)

- **Cron schedule frequency**: cada 6 horas vs. cada hora. Foster-proposals usa cada hora (7d expiry, más fino). Adoption-handshake con 14d puede tolerar cada 6h sin problema. **Default**: cada 6 horas, ajustable.
- **Reminder pre-expiry**: ¿enviar notificación al adopter 24h antes de que el handshake expire? Foster-proposals no lo hace. Recomendación: **fuera de scope** para este plan; iterar después si la métrica de expiraciones es alta.
- **Eliminar o stub `finalizeAdoptionAction`**: revisar grep de imports al inicio de Fase 5 y decidir entonces.

---

## 6. Verificación end-to-end

Después de Fase 5, el smoke test manual completo:

1. **Setup**: como admin, crear una org tipo `shelter`, marcarla `verified=true`. Crear un usuario `owner` regular ("Adopter").
2. **Subir política**: como org admin, navegar a `/org/[orgToken]/configuracion/adopciones`, subir un PDF de prueba. Verificar que aparece como "Política activa".
3. **Intake**: como org admin, intake de una mascota nueva. Asegurar que la mascota queda en `shelter_custody` de la org.
4. **Listar para adopción**: marcar la mascota como `adoption_eligible=true` y publicar el listing en `/adoptar`.
5. **Postulación**: como Adopter, navegar a `/adoptar`, abrir la mascota, postularse (`/adoptar/[petToken]/postular`).
6. **Aprobar postulación**: como org admin, navegar a `/org/[orgToken]/adopciones`, ver la postulación, clickear "Aprobar". Verificar que:
   - Se emite `adoption_application_resolved(approved)` event
   - Se crea un `adoption_handshakes` row con status=pending
   - Se abre un case `adoption_handshake`
   - Se emite `adoption_handshake_proposed` event
   - Adopter recibe una notification con CTA "Ver contrato"
7. **Adopter acepta**: como Adopter, abrir la notification, llegar a `/cuenta/adopciones/[token]`. Verificar que:
   - El PDF link funciona (signed URL, abre en nueva pestaña)
   - El botón "Aceptar" está disabled
   - Marcar el checkbox "Descargué y leí el contrato"
   - El botón "Aceptar" se habilita
   - Clickear Aceptar
8. **Verificar transferencia**:
   - `ownerships` table: la fila de `shelter_custody` de la org tiene `ended_at` poblado, hay nueva fila con `role='owner'` y `owner_user_id = Adopter.id`
   - `pet_events`: emisión de `adoption_handshake_resolved(accepted)` + `adoption_finalized` con `policy_document_id` poblado
   - `cases`: el handshake case está closed con `reason='resolved'`
   - `reminders`: 4 filas nuevas (1/3/6/12 meses) con `reminder_type='post_adoption_checkin'`
   - El adopter recibe notif "Adopción finalizada"
   - Si había foster activo distinto del adopter: recibe notif de cierre
9. **Listing**: la mascota desaparece de `/adoptar` (status ya no eligible o foster ended).

### Cron smoke

10. Crear handshake con `expires_at = now() - 1d` (hack vía SQL), correr `/api/cron/expire-adoption-handshakes` manual. Verificar:
    - Status flip a `expired`
    - Emite `adoption_handshake_resolved(expired)`
    - Cierra el case con `reason='auto_expired'`
    - Audit row escrita
    - Ambos lados notificados

### Tests de regresión

11. `pnpm typecheck` — baseline 61 errores (todos en seed-storylines).
12. `pnpm test` — todos los tests existentes verdes + los nuevos de Fases 2–5 verdes.
13. `pnpm lint` — clean.

---

## Critical files for implementation

Para el agente que ejecute este plan, los archivos que MÁS importan están en este orden:

1. **`db/migrations/0038_adoption_handshake_foundation.sql`** (Fase 1) — el shape del schema es load-bearing para todo.
2. **`app/actions/adoption-handshakes.ts`** (Fase 3) — el corazón del flow nuevo.
3. **`app/actions/adoption-applications.ts`** (Fase 3) — la modificación de `approveAdoptionApplicationAction` que ata todo.
4. **`app/(app)/cuenta/adopciones/[handshakeToken]/AdoptionHandshakeActions.tsx`** (Fase 4) — la UX clave del consentimiento.
5. **`lib/adoption-handshake-expirer.ts`** + **`app/api/cron/expire-adoption-handshakes/route.ts`** (Fase 3) — el safety net.

Patrones a clonar literalmente (no reescribir):

- `lib/foster-proposal-expirer.ts` → `lib/adoption-handshake-expirer.ts`
- `app/api/cron/expire-foster-proposals/route.ts` → `app/api/cron/expire-adoption-handshakes/route.ts`
- `app/actions/foster-proposals.ts:acceptFosterProposalAction` → estructura de `acceptAdoptionHandshakeAction`
- `app/(app)/cuenta/transitos/propuestas/[proposalToken]/ProposalActions.tsx` → estructura de `AdoptionHandshakeActions.tsx`
- `lib/case-closers/expire-cross-org-transfers.ts` → estructura del expirer (alternativa al foster-proposal pattern)
