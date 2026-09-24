# Adopción end-to-end: handshake en dos fases + formulario estructurado + contrato per-adopción

> Plan **unificado y ejecutable**. Reemplaza tanto a `2026-05-19-adoption-handshake.md` como a `2026-05-20-adoption-templates-alignment.md` (ambos quedan como historial; este es el plan que se ejecuta).
>
> **Fecha:** 2026-05-20
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~45 archivos nuevos/modificados, **1 migración consolidada**, 1 bucket nuevo, 1 cron route, 1 lifecycle file, PDF render pipeline nuevo
> **Estimación:** ~7 días en 8 fases shippeables independientes
>
> **Cambio mental respecto a los planes previos:** la adopción en DIM deja de ser "la org clickea Finalizar" y pasa a ser **un ciclo de consentimiento documentado** con tres artefactos: postulación estructurada (firmada digitalmente con declaración jurada), aprobación de la org, y contrato per-adopción generado con merge fields que el adoptante acepta tras leer.

---

## 0. Contexto — por qué este plan existe

### 0.1 Estado actual (lo que rompemos)

`finalizeAdoptionAction` (`app/actions/adoption.ts`) ejecuta la adopción en una sola transacción del lado de la org. Tres problemas:

1. **Identidad del adoptante por DNI tipeado o foster-shortcut**, que puede crear stub profiles sin link a `auth.users`. El claim por DNI es brute-forceable (review 2026-05-19 §2.1) y el usuario decidió esperar a Mi Argentina; `STUB_CLAIM_ENABLED = false` deja la rama DNI rota para usuarios no-DIM.
2. **El adoptante nunca da consentimiento explícito en plataforma**. La org clickea "Finalizar" y la mascota cambia de owner sin acción del adoptante. La firma del contrato vive off-platform.
3. **`lib/uploads.ts:23` rechaza cualquier mime que no sea `image/*`**, pero `FinalizeAdoptionForm.tsx` declara `accept="application/pdf,image/*"`. Bug latente.

Y además: la postulación (`ApplicationForm.tsx`) captura solo 4 campos (`housing_type`, `other_pets`, `daily_routine`, `notes`). Las orgs reales en CABA (Catpuccino, Proyecto 4 Patas, El Campito) usan formularios de **~28 preguntas** estructuradas que cubren vivienda con protección, otros animales con detalle, previsiones ante mudanza/embarazo/vacaciones, etc. La org actualmente no tiene info suficiente para aprobar responsablemente.

Y además: el plan original (2026-05-19) modelaba un **"PDF policy genérico por org"** que el adoptante leía y aceptaba. Pero el contrato real de adopción en CABA (modelo de la Dirección Municipal de Veterinaria y Zoonosis + standard de orgs CABA) tiene **merge fields per-adopción**: datos del animal, datos del adoptante, datos del representante de la org, anexo sanitario. No es policy genérico — es un contrato firmado entre dos partes concretas.

### 0.2 Outcome esperado

Toda adopción en DIM queda registrada como **un ciclo documentado**:

1. Postulación estructurada (28 preguntas, declaración jurada al final).
2. Aprobación de la org → handshake propuesto con contrato pre-generado en preview.
3. Adoptante autenticado descarga el contrato PDF (con sus datos y los del animal), marca "lo leí", acepta.
4. Ownership transfer atómico + cascade de auto-rejection + check-ins agendados + case cerrado.
5. PDF firmado archivado inmutable, accesible por adoptante y org para siempre.

Trazabilidad: cada paso genera un `pet_event` + `audit_log` row. Si en 2030 el adoptante pierde a la mascota, el contrato sigue siendo recuperable.

---

## 1. Decisiones cerradas (heredadas)

| # | Decisión | Razón |
|---|---|---|
| D1 | **Adoptante: siempre desde una `adoption_application` aprobada**. No hay búsqueda libre de usuarios. | El applicant ya es un usuario DIM autenticado (requisito de `submitAdoptionApplicationAction`). Cero stubs. |
| D2 | **Reemplaza** `finalizeAdoptionAction` por completo. Incluso el foster-shortcut va por el handshake. | Un solo flow para todas las adopciones. El foster ve el contrato como cualquier otro adoptante y firma. |
| D3 | Expiración del handshake: **14 días** desde propose. | Punto medio entre foster (7d) y cross-org-transfer (30d). Mid-stakes. |
| D4 | Admin de plataforma (`role='admin'`) puede configurar la plantilla en nombre de cualquier org. | Cubre orgs que se atrasaron con el setup. |
| D5 | Si la org aprueba una application sin plantilla configurada → **error con deep-link al config de la org**, no auto-prompt silencioso. | Aprobar adopciones es un evento raro; un error explícito es mejor que un flow ambiguo. |
| D6 | `approveAdoptionApplicationAction` y `proposeAdoptionHandshakeAction` quedan **fusionados** en una sola transacción del lado de la org. | Elimina la clase de bugs "aprobada pero no propuesta". |
| D7 | El contrato PDF se sirve via **signed URL + link `target=_blank`**, no embed. Checkbox "Lo leí" gatea el botón Aceptar. | Renderizar PDF cross-platform (en especial mobile) es inestable. |
| D8 | El handshake guarda **snapshot del path del contrato generado** (no la plantilla). | Mutabilidad de plantillas hace el snapshot load-bearing: un handshake propuesto hoy debe mostrar el contrato como era hoy. |
| D9 | **Postulación estructurada con 4 pasos (wizard)**, declaración jurada al final. Schema v2 retrocompatible. | Long forms tienen drop-off alto; wizard es el patrón estándar (Typeform, Catpuccino). |
| D10 | **El contrato se genera per-adopción server-side** con `@react-pdf/renderer`. Cláusulas estándar en código (`lib/adoption-contract-clauses.ts`), datos institucionales en `organization_documents`. | Necesidad de merge fields (pet + adopter + org + anexo sanitario). Cláusulas en código permiten code review; datos institucionales en DB permiten edición por la org. |
| D11 | **Firma electrónica simple**: timestamp + user_id + IP + user-agent en `adoption_handshakes.accepted_metadata`. No firma digital AFIP. | Suficiente para contrato civil privado en CABA. La firma con certificado oficial es otro plan. |
| D12 | **`current_pets_detail` se guarda como JSONB** array de objetos. | Permite analytics futuros sin migración a tabla. |
| D13 | **Anexo sanitario auto-poblado desde `pet_events`**. Si faltan eventos, muestra "Pendiente" — no bloquea el accept. | La org se compromete a completar; queda documentado en el PDF. |
| D14 | Org puede subir **PDF custom override** como escape hatch ("avanzado"). El render automático es el default. | Cubre orgs con contratos legacy o particulares. |

### Cuándo NO ejecutar

- Si hay >10 stubs en producción y un plan de migración pendiente. Este plan no migra stubs existentes. Antes del deploy de la Fase 6, correr:
  ```sql
  select count(*) from profiles
  where id not in (select id from auth.users) and dni_verified = false;
  ```
- Si `pnpm typecheck && pnpm lint && pnpm test` no están verdes en main.

---

## 2. Cambio conceptual

```
ANTES                                          DESPUÉS
─────                                          ───────

[Usuario] postula (4 free-text)                [Usuario] postula (wizard 4 pasos, 28 campos,
   ↓                                            declaración jurada al final)
[Org] aprueba off-platform (llamado)              ↓
   ↓                                           [Org] aprueba → en una sola tx:
[Org] finalizeAdoptionAction:                       1. emite adoption_application_resolved(approved)
       - resuelve identidad por DNI                 2. inserta adoption_handshake row
         (crea stub si no matchea)                  3. NO genera contrato todavía
       - cambia owner inmediatamente                 4. notifica al adopter con CTA
       - sin firma del adoptante                  ↓
   ↓                                           [Adoptante] recibe notif, abre /cuenta/adopciones/[token]
[Mascota] cambia de owner sin acción              ↓
       del adoptante                           [Sistema] renderea contrato preview con sus datos
                                                  ↓
                                               [Adoptante] descarga contrato (signed URL),
                                                marca "lo leí", clickea Aceptar
                                                  ↓
                                               [Sistema] en una sola tx:
                                                  1. genera PDF final con metadata de firma
                                                  2. sube a storage org-documents/contracts/
                                                  3. snapshot del path en handshake row
                                                  4. cierra shelter_custody / foster ownership
                                                  5. inserta nueva ownership 'owner'
                                                  6. emite adoption_handshake_resolved(accepted)
                                                     + adoption_finalized
                                                  7. cascade auto-reject de otras applications
                                                  8. agenda check-ins (1/3/6/12 meses)
                                                  9. cierra el case
                                                  ↓
                                               [Adoptante] recibe PDF firmado, accesible siempre
```

### Lo que NO construye

- Búsqueda libre de usuarios para que la org "elija" un adoptante (cerrado por D1).
- PDF viewer embebido (cerrado por D7).
- Migración de stubs existentes (sigue dependiendo de Mi Argentina).
- Notificaciones por email / push (sigue siendo solo notifications inbox).
- Firma digital con certificado AFIP (cerrado por D11).

---

## 3. Lecturas obligatorias antes de tocar nada

1. **`AGENTS.md` → Adopción** completo.
2. **`app/actions/adoption.ts:finalizeAdoptionAction` (líneas 60–420)** — el monolito a desarmar. Bloques: identity resolution (76–186), ownership transfer (217–301), cascade auto-rejection (303–351), attachment insert (354–364), reminders backfill (366–415).
3. **`app/actions/foster-proposals.ts:acceptFosterProposalAction` (326–610)** — template estructural para `acceptAdoptionHandshakeAction`.
4. **`app/(app)/cuenta/transitos/propuestas/[proposalToken]/page.tsx` + `ProposalActions.tsx`** — UX template adopter-side.
5. **`lib/case-helpers.ts`** (`openCase`, `closeCase`, `findOpenCaseForPetAndKind`, `cascadeTriggerPayload`). **Reusar**, no replicar.
6. **`lib/case-cron.ts:runCaseCron` + `lib/case-closers/expire-cross-org-transfers.ts`** — pattern del cron expirer.
7. **`lib/uploads.ts:uploadAttachmentIfPresent`** — sigue siendo image-only para event-attachments; introducimos un sibling para PDF.
8. **`db/migrations/0033_cases.sql` líneas 128–138** — confirmar que `adoption_handshake` cae bajo el partial unique index genérico.
9. **`lib/event-schemas.ts:971`** — `adoptionApplicationSubmitted` actual (v1).
10. **`app/adoptar/[petToken]/postular/ApplicationForm.tsx`** — el form a reemplazar por wizard.
11. **Templates de referencia** (en la raíz del repo):
    - `Formulario_Pre-Adopcion_CABA.docx`
    - `Contrato_Adopcion_CABA.docx`

---

## 4. Schema consolidado

### 4.1 Migración única: `db/migrations/0038_adoption_handshake_full.sql`

**Tabla `organization_documents`** — guarda plantillas de contrato + (opcional) PDF override.

```sql
create table public.organization_documents (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  document_type            text not null check (document_type in (
    'adoption_contract_template',     -- plantilla per-org (default)
    'adoption_policy_override'        -- escape hatch: PDF custom (D14)
  )),

  -- Para templates (document_type = 'adoption_contract_template'):
  representative_full_name text,
  representative_id_number text,         -- DNI / CUIT del firmante
  org_legal_address        text,
  jurisdiction             text default 'Ciudad Autónoma de Buenos Aires',
  extra_clauses_md         text,         -- markdown opcional, cláusulas adicionales
  clauses_version          text not null default 'v1',

  -- Para overrides (document_type = 'adoption_policy_override'):
  storage_path             text,
  mime_type                text check (mime_type is null or mime_type = 'application/pdf'),
  file_size                integer,

  -- Audit
  uploaded_by_user_id      uuid not null references public.profiles(id) on delete restrict,
  uploaded_at              timestamptz not null default now(),
  deleted_at               timestamptz,

  constraint org_docs_template_or_override check (
    (document_type = 'adoption_contract_template' and representative_full_name is not null
       and representative_id_number is not null and org_legal_address is not null)
    or
    (document_type = 'adoption_policy_override' and storage_path is not null
       and mime_type = 'application/pdf')
  )
);

create unique index organization_documents_unique_active
  on public.organization_documents (organization_id, document_type)
  where deleted_at is null;
```

**Tabla `adoption_handshakes`** — la state machine.

```sql
create table public.adoption_handshakes (
  id                          uuid primary key default gen_random_uuid(),
  public_token                text not null unique,                  -- ADH-XXXX-XXXX
  case_id                     uuid not null references public.cases(id) on delete restrict,
  pet_id                      uuid not null references public.pets(id) on delete restrict,
  organization_id             uuid not null references public.organizations(id) on delete restrict,
  adopter_user_id             uuid not null references public.profiles(id) on delete restrict,
  application_event_id        uuid references public.pet_events(id) on delete set null,

  -- Plantilla snapshot
  contract_template_id        uuid references public.organization_documents(id) on delete set null,
  contract_clauses_version    text not null default 'v1',

  -- PDF generado (poblado en accept)
  generated_contract_path     text,                                  -- snapshot inmutable

  status                      text not null default 'pending'
    check (status in ('pending','accepted','rejected','cancelled','expired')),
  expires_at                  timestamptz not null,

  accepted_at                 timestamptz,
  accepted_notes              text,
  accepted_metadata           jsonb,                                 -- {ip, user_agent, ...} para firma electrónica (D11)
  resolved_ownership_id       uuid references public.ownerships(id) on delete set null,

  rejected_at                 timestamptz,
  rejection_reason            text,

  cancelled_at                timestamptz,
  cancelled_by_user_id        uuid references public.profiles(id) on delete set null,
  cancellation_reason         text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint handshakes_accept_consistent check (
    (status = 'accepted'
      and accepted_at is not null
      and resolved_ownership_id is not null
      and generated_contract_path is not null
      and accepted_metadata is not null)
    or (status <> 'accepted')
  ),
  constraint handshakes_reject_consistent check (
    (status = 'rejected' and rejected_at is not null) or (status <> 'rejected')
  ),
  constraint handshakes_cancel_consistent check (
    (status = 'cancelled' and cancelled_at is not null) or (status <> 'cancelled')
  )
);

create index adoption_handshakes_status_expires_idx
  on public.adoption_handshakes (status, expires_at);
create index adoption_handshakes_adopter_pending_idx
  on public.adoption_handshakes (adopter_user_id, status)
  where status = 'pending';
create index adoption_handshakes_pet_pending_idx
  on public.adoption_handshakes (pet_id)
  where status = 'pending';
```

### 4.2 Storage bucket nuevo

- Bucket: `org-documents`
- Privado (sin acceso público)
- RLS:
  - INSERT: usuarios con membership en la org + admins (para overrides).
  - INSERT: server-side service role (para contratos generados).
  - SELECT: usuarios con membership en la org + admins + signed URL para terceros.
- Path conventions:
  - Override: `{organization_id}/policy/{uuid}.pdf`
  - Contrato generado: `{organization_id}/contracts/{handshake_id}.pdf`
- Bucket policy: no UPDATE en path `/contracts/*` (inmutabilidad de contratos firmados).

### 4.3 Espejo en `db/schema.ts`

- `organizationDocuments` table builder con CHECK constraints.
- `adoptionHandshakes` table builder.
- Re-export desde `db/index.ts`.
- `AUDIT_LOG_ACTIONS` extendido con:
  - `adoption_handshake_proposed`
  - `adoption_handshake_accepted`
  - `adoption_handshake_rejected`
  - `adoption_handshake_cancelled`
  - `adoption_handshake_expired`
  - `org_contract_template_configured`
  - `org_contract_template_replaced`
  - `org_policy_override_uploaded`

### 4.4 Catálogos

- **`lib/case-kinds.ts`** — agregar `"adoption_handshake"` a `CASE_KINDS` y `V1_CASE_KINDS`. Label: "Adopción en curso".
- **`lib/case-lifecycles/adoption-handshake.ts`** — nuevo. Mirror de `lib/case-lifecycles/foster-placement.ts`.
- **`lib/case-attachment.ts` y `lib/case-normatives.ts`** — registrar el nuevo case kind.
- **`lib/event-schemas.ts`**:
  - `adoptionApplicationSubmitted_v2` (schema_version: 2) — ver §5.
  - `adoption_handshake_proposed`: `{ handshake_id, adopter_user_id, contract_template_id, expires_at }`.
  - `adoption_handshake_resolved`: `{ handshake_id, outcome: 'accepted'|'rejected'|'cancelled'|'expired', auto_generated?, notes?, reason? }`.
  - Extender `adoption_finalized` con `contract_storage_path` opcional (back-compat preservado).
- **`lib/adoption-contract-clauses.ts`** — nuevo. Fuente de verdad de las 12 cláusulas:
  ```ts
  export const CONTRACT_CLAUSES_V1 = [
    { id: 'primera',    title: 'Compromiso de adopción',          body: '...' },
    { id: 'segunda',    title: 'Finalidad',                       body: '...' },
    { id: 'tercera',    title: 'Condiciones de tenencia',         body: '...' },
    { id: 'cuarta',     title: 'Salud y bienestar',               body: '...' },
    { id: 'quinta',     title: 'Castración obligatoria',          body: '...' },
    { id: 'sexta',      title: 'Prohibición de cesión y abandono',body: '...' },
    { id: 'septima',    title: 'Maltrato (Ley 14.346)',           body: '...' },
    { id: 'octava',     title: 'Seguimiento post-adopción',       body: '...' },
    { id: 'novena',     title: 'Estado de salud al momento de la entrega', body: '...' },
    { id: 'decima',     title: 'Responsabilidad civil',           body: '...' },
    { id: 'undecima',   title: 'Incumplimiento',                  body: '...' },
    { id: 'duodecima',  title: 'Jurisdicción',                    body: '...' },
  ];
  export const CLAUSES_VERSION = 'v1';
  ```
  Texto exacto: copiar de `Contrato_Adopcion_CABA.docx`. La org puede agregar texto custom via `extra_clauses_md` (markdown renderizado).

### 4.5 Capabilities

- **`adoption.review`**: cubre `approveAdoptionApplicationAction`, `proposeAdoptionHandshakeAction`, `cancelAdoptionHandshakeAction`, `upsertAdoptionContractTemplateAction`.
- **`adoption.finalize`**: queda **vestigial**. Retirar al final de la Fase 7 si nadie más lo importa.
- **`acceptAdoptionHandshakeAction` / `rejectAdoptionHandshakeAction`**: self-service, verifica `user.id === adopter_user_id`.

---

## 5. Esquema de postulación v2

### 5.1 Shape del evento

`lib/event-schemas.ts` — discriminar por `schema_version`:

```ts
// v1 — legacy, ya en producción. NO TOCAR.
const adoptionApplicationSubmittedV1 = z.object(withVersion({
  applicant_user_id: z.string().uuid(),
  related_organization_id: z.string().uuid(),
  housing_type: z.enum(['casa_con_patio','casa_sin_patio','departamento','otro']),
  other_pets: z.string().nullable(),
  daily_routine: z.string().nullable(),
  notes: z.string().nullable(),
})).strict();

// v2 — nuevo. Refleja el template Formulario_Pre-Adopcion_CABA.docx.
const adoptionApplicationSubmittedV2 = z.object(withVersion({
  applicant_user_id: z.string().uuid(),
  related_organization_id: z.string().uuid(),

  // Sección 3 — Sobre el hogar
  housing_type: z.enum(['casa_con_patio','casa_sin_patio','departamento','otro']),
  rental_pets_allowed: z.boolean().nullable(),         // null = vivienda propia
  has_balcony_or_yard: z.boolean(),
  home_has_protection: z.boolean().nullable(),         // null si no aplica
  household_size: z.number().int().min(1),
  household_ages: z.string().nullable(),
  household_unanimous: z.boolean(),
  household_allergies: z.boolean().nullable(),
  sleep_arrangement: z.string().nullable(),

  // Sección 4 — Experiencia con animales
  has_previous_pets: z.boolean(),
  previous_pets_outcome: z.string().nullable(),
  has_current_pets: z.boolean(),
  current_pets_detail: z.array(z.object({
    species: z.enum(['perro','gato','otro']),
    sex: z.enum(['m','f']),
    age_years: z.number().nullable(),
    castrated: z.boolean(),
    vaccinated: z.boolean(),
    dewormed: z.boolean(),
  })).nullable(),                                       // JSONB array
  current_pets_food_brand: z.string().nullable(),

  // Sección 5 — Compromiso y previsiones
  can_cover_costs: z.boolean(),
  will_castrate_if_needed: z.boolean(),
  plan_if_move: z.string().nullable(),
  plan_if_new_place_disallows: z.string().nullable(),
  plan_if_pregnancy: z.string().nullable(),
  plan_if_vacation: z.string().nullable(),
  return_reasons: z.string().nullable(),
  accepts_post_adoption_followup: z.boolean(),

  // Legacy preservados (para que el org review siga pudiendo leerlos uniformemente)
  other_pets: z.string().nullable(),
  daily_routine: z.string().nullable(),
  notes: z.string().nullable(),

  // Sección 6 — Declaración jurada
  declared_truthful_at: z.string().datetime(),
})).strict();

// Discriminated union por schema_version
const adoptionApplicationSubmitted = z.discriminatedUnion('schema_version', [
  adoptionApplicationSubmittedV1.extend({ schema_version: z.literal(1) }),
  adoptionApplicationSubmittedV2.extend({ schema_version: z.literal(2) }),
]);
```

### 5.2 Reader helper

`lib/adoption-application-reader.ts` — nuevo. Expone `readApplication(event)` que devuelve un shape unificado (v2 shape, con valores derivados de v1 cuando aplica). El org review page consume solo este helper.

---

## 6. Generación del contrato PDF

### 6.1 Pipeline

`lib/adoption-contract/render.tsx` — usa `@react-pdf/renderer`. Expone:

```ts
export async function renderAdoptionContract(input: {
  pet:        { name, species, breed, sex, age_months, color, castrated, chip_id };
  adopter:    { full_name, dni, address, city, phone, email };
  org:        { display_name, representative_full_name, representative_id_number, legal_address, jurisdiction };
  application:{ event_id, submitted_at };
  health:     ReturnType<typeof buildPetHealthRecord>;
  clauses:    typeof CONTRACT_CLAUSES_V1;
  extra:      string | null;
  signature:  { accepted_at, ip, user_agent };
}): Promise<Buffer>
```

Layout: portrait A4, Arial 11pt, márgenes 2.5 cm, replica visual del template. Tabla de anexo con bordes sutiles. Bloque de firma al pie de la última página.

### 6.2 Anexo sanitario auto-poblado

`lib/adoption-contract/health-record.ts`:

```ts
export async function buildPetHealthRecord(petId: string) {
  // Query pet_events filtered by kind in (vaccination_administered,
  // deworming_administered, sterilization_completed), order by occurred_at desc.
  // Returns:
  //   {
  //     antirabies:        { date, next_due, status: 'present'|'pending' },
  //     sextuple_octuple:  { date, next_due, status },
  //     deworm_internal:   { date, next_due, status },
  //     deworm_external:   { date, next_due, status },
  //     sterilization:     { date, status },
  //     other:             Array<{ label, date }>,
  //   }
}
```

Si un slot no tiene evento, `status: 'pending'` y el PDF renderea **"Pendiente"** en esa fila — no bloquea el accept (D13).

### 6.3 Firma electrónica simple

`accepted_metadata` jsonb captura al accept:

```ts
{
  ip: req.ip,
  user_agent: req.headers['user-agent'],
  timestamp: now().toISOString(),
  application_event_id: handshake.application_event_id,
  clauses_version: handshake.contract_clauses_version,
  template_id: handshake.contract_template_id,
}
```

El PDF renderea al pie:

```
Firma electrónica del adoptante: {full_name}, DNI {dni}
Aceptado el {date} desde IP {ip}.
Firma electrónica de la org: {representative_full_name}, DNI {representative_id_number}
Configurada al subir la plantilla de contrato.
```

Documentar en `AGENTS.md` que esto es firma electrónica simple, no firma digital con certificado AFIP.

---

## 7. Implementación por fases

Cada fase es shippeable. Después de cada una, `pnpm typecheck && pnpm lint && pnpm test` deben quedar verdes.

### Fase 1 — Fundación (sin UI, sin behavior change) — ~1 día

**Goal:** schema y tipos disponibles, código gated detrás de paths que nadie llama todavía.

Archivos:
- `db/migrations/0038_adoption_handshake_full.sql` — bucket, RLS, tablas, índices, todos los AUDIT_LOG_ACTIONS.
- `db/schema.ts` — `organizationDocuments`, `adoptionHandshakes`, 8 nuevas acciones en `AUDIT_LOG_ACTIONS`. Extender `adoption_finalized` con `contract_storage_path` opcional.
- `db/index.ts` — re-exports.
- `lib/case-kinds.ts` — agregar `adoption_handshake`.
- `lib/case-lifecycles/adoption-handshake.ts` — open/close transitions y labels.
- `lib/case-attachment.ts`, `lib/case-normatives.ts` — registrar el nuevo kind.
- `lib/event-schemas.ts` — agregar `adoption_handshake_proposed`, `adoption_handshake_resolved`, y `adoptionApplicationSubmittedV2` (discriminated union).
- `lib/uploads.ts` — agregar `uploadDocumentIfPresent(supabase, file, bucket, { allowedMimes, maxSizeBytes })`. **No tocar** `uploadAttachmentIfPresent`.
- `lib/storage.ts` — agregar `orgDocumentSignedUrl(supabase, storagePath, expiresIn)`.
- `lib/publicToken.ts` — agregar `generateAdoptionHandshakeToken()` con prefix `"ADH"`.
- `lib/adoption-contract-clauses.ts` — las 12 cláusulas v1 (texto exacto del template).
- `lib/adoption-application-reader.ts` — reader unificado v1+v2.

Tests:
- Coverage test que valida `lib/case-lifecycles/<kind>.ts` exists para `adoption_handshake`.
- Schema integration test que inserta filas en ambas tablas y verifica los CHECK constraints.
- Test del discriminated union: eventos v1 y v2 validan, mezclas rechazan.

**Sin cambios visibles para el usuario. Safe to ship.**

### Fase 2 — Plantilla de contrato (org config) — ~1 día

**Goal:** las orgs pueden configurar su plantilla. Nada más la usa todavía.

Archivos nuevos:
- `app/actions/organization-documents.ts`:
  - `upsertAdoptionContractTemplateAction(orgToken, formData)` — gate por `adoption.review` OR `role='admin'`. Valida representante, DNI, dirección. Soft-delete del template anterior, insert del nuevo, audit row.
  - `uploadAdoptionPolicyOverrideAction(orgToken, file)` — opcional (escape hatch D14). PDF only via `uploadDocumentIfPresent` (cap 10 MB).
  - `removeAdoptionPolicyOverrideAction(orgToken)` — soft-delete idempotente.
- `app/org/[orgToken]/configuracion/adopciones/page.tsx` — server component. Carga plantilla activa (si existe), renderiza form + preview.
- `app/org/[orgToken]/configuracion/adopciones/TemplateForm.tsx` — client component. Form de datos institucionales + textarea para `extra_clauses_md` + checkboxes (read-only) de las 12 cláusulas estándar.
- `app/org/[orgToken]/configuracion/adopciones/PolicyOverrideForm.tsx` — collapsable "Avanzado: subir PDF custom".
- `app/api/preview/adoption-contract/route.ts` — render con datos dummy para el botón "Vista previa".

Tests:
- `__tests__/organization-contract-template.test.ts`: upsert, soft-delete + insert, gate, validación de campos requeridos.
- `__tests__/contract-preview.test.ts`: preview endpoint devuelve PDF válido.

**Shippeable.** Las orgs empiezan a configurar. El finalize viejo sigue funcionando.

### Fase 3 — Postulación v2 (wizard) — ~1.5 días

**Goal:** la postulación nueva está live; orgs ven el nuevo shape en review.

Archivos:
- `app/adoptar/[petToken]/postular/wizard/`:
  - `ApplicationWizard.tsx` — orquestador con `useReducer`.
  - `Step1Housing.tsx`
  - `Step2OtherPets.tsx` — incluye lista repeat-able para `current_pets_detail`.
  - `Step3Commitment.tsx`
  - `Step4Declaration.tsx` — checkbox declaración jurada, disabled hasta marcado.
- `app/adoptar/[petToken]/postular/page.tsx` — renderea `ApplicationWizard` en lugar del form viejo.
- `app/actions/adoption-applications.ts:submitAdoptionApplicationAction` — acepta v2 payload, emite event con `schema_version: 2`. Mantiene compat con calls v1 (legacy).
- `app/adoptar/[petToken]/postular/ApplicationForm.tsx` — **mover** a `legacy/ApplicationForm.tsx`, mantener como fallback feature-flagged.
- `app/org/[orgToken]/adopciones/[applicationEventId]/page.tsx` — consume `readApplication()` y renderea todos los campos en secciones colapsables.

Tests:
- E2E: cada step valida, navegación atrás preserva datos, submit final emite event v2 válido.
- Org review: todos los campos del v2 se renderean sin error; campos v1 también.
- `__tests__/application-reader.test.ts` — reader devuelve shape unificado para v1 y v2.

### Fase 4 — Handshake server actions (sin swap de UI) — ~1.5 días

**Goal:** flow nuevo corre end-to-end via testing, UI sigue mostrando el flow viejo.

Archivos:
- `app/actions/adoption-handshakes.ts`:
  - `proposeAdoptionHandshakeAction({ orgToken, applicationEventId })` — exportado pero solo llamado internamente desde `approveAdoptionApplicationAction`.
    - Validar pet+org match (load del application event).
    - Validar `organization_documents` activo (`document_type='adoption_contract_template'`) existe — error con `missingTemplate: true` si no, deep-link al config.
    - Validar no hay handshake `status='pending'` para esta mascota.
    - `openCase({ kind: 'adoption_handshake', primaryPetId, applicantUserId: adopter, openedByOrganizationId, ... })`.
    - Insert `adoption_handshakes` row (publicToken, expires_at = now + 14d, contract_template_id snapshot, contract_clauses_version).
    - Emit `adoption_handshake_proposed` event linked al case.
    - Push notification al adopter en `pendingNotifications[]` con `ctaUrl: /cuenta/adopciones/[publicToken]`.
    - audit_log row.
  - `acceptAdoptionHandshakeAction({ handshakeToken, notes, requestMetadata })` — self-service:
    - Verificar `user.id === handshake.adopterUserId`, status=pending, expires_at > now.
    - **Pre-tx (puede fallar sin daño):** generar contrato PDF con `renderAdoptionContract()`, subir a `org-documents/{org_id}/contracts/{handshake_id}.pdf`. Si falla, abort con error visible.
    - **Atomically:**
      - Close shelter_custody ownership de la org.
      - Close active foster ownership row + close foster_placement case si existe.
      - Insert owner ownership row (rol `owner`).
      - Update handshake row (status=accepted, accepted_at, accepted_notes, accepted_metadata={ip, user_agent, ...}, generated_contract_path, resolved_ownership_id).
      - Emit `adoption_handshake_resolved(outcome=accepted)` event.
      - Emit `adoption_finalized` event con `contract_storage_path` poblado.
      - Cascade auto-rejection de otras applications pending (SQL scan portado verbatim de `adoption.ts:303-351`).
      - Schedule post-adoption check-in reminders (1/3/6/12 meses).
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
- `app/actions/adoption-applications.ts:approveAdoptionApplicationAction` — modificar:
  - Pre-flight (fuera del tx): lookup de `organization_documents` activo. Si no existe, return error con copy "Configurá la plantilla de contrato antes de aprobar esta postulación" + URL `/org/[orgToken]/configuracion/adopciones`.
  - Inline la lógica de `proposeAdoptionHandshakeAction` en el mismo tx (no recursión).
  - La notification al applicant cambia: CTA apunta a `/cuenta/adopciones/[handshakeToken]` con label "Ver contrato y aceptar".
- `lib/adoption-contract/render.tsx` — nuevo, ver §6.1.
- `lib/adoption-contract/health-record.ts` — nuevo, ver §6.2.
- `lib/adoption-handshake-expirer.ts` — nuevo. Mirror de `lib/foster-proposal-expirer.ts`:
  - `findExpiredAdoptionHandshakes()` — scan `WHERE status='pending' AND expires_at < now()`.
  - `expireAdoptionHandshake(handshake)` — per-row: update a expired, emit `adoption_handshake_resolved(expired)` + `adoption_application_resolved(rejected, reason='expired')`, `closeCase(reason='auto_expired')`, notify ambos lados.
- `app/api/cron/expire-adoption-handshakes/route.ts` — nuevo. Mirror de `app/api/cron/expire-foster-proposals/route.ts`. Usa `runCaseCron`.
- `vercel.json` — agregar `0 */6 * * *` para el cron.

Tests:
- `__tests__/adoption-handshake-propose.test.ts` — happy + missing template + duplicate pending + capability gate.
- `__tests__/adoption-handshake-accept.test.ts` — happy + cascade auto-rejection + check-in reminders + foster-end cascade + expired handshake rejected + PDF generation failure rollback.
- `__tests__/adoption-handshake-reject.test.ts` — happy + notif a org + emite `adoption_application_resolved`.
- `__tests__/adoption-handshake-cancel.test.ts` — org-side, gate, idempotencia.
- `__tests__/adoption-handshake-expirer.test.ts` — cron behavior, idempotencia, audit row.
- `__tests__/adoption-contract-render.test.ts` — snapshot del PDF rendereado con datos fijos. Valida que el buffer es un PDF válido (magic bytes %PDF-) y contiene "DNI" en el texto extraído.
- `__tests__/adoption-contract-health-record.test.ts` — con eventos mockeados, ensambla el shape correcto. Sin eventos, devuelve "pending".

**Backend completo, sin UI de adopter todavía.** Fase **más riesgosa** — desplegar con observabilidad encendida.

### Fase 5 — UI adopter-side — ~1 día

**Goal:** el adopter ve y actúa sobre los handshakes propuestos.

Archivos nuevos:
- `app/(app)/cuenta/adopciones/page.tsx` — server component. Lista handshakes para `user.id`, status=pending OR finalized recientemente. Cards con pet info + org info + state badge + CTA.
- `app/(app)/cuenta/adopciones/[handshakeToken]/page.tsx` — server component. Loads handshake by `publicToken`, verifica `adopter_user_id === user.id`. Renders:
  - Pet info (name, species, breed, photo via `petPhotoUrl`).
  - Org info (displayName, link a `/refugios/[orgToken]`).
  - **Si status=pending:** "Contrato de adopción (vista previa)" link al PDF preview (generado on-the-fly desde el template + datos del adopter+pet, **sin** firma electrónica todavía). Más componente `AdoptionHandshakeActions`.
  - **Si status=accepted:** link al PDF final firmado (vía `generated_contract_path` signed URL).
  - **Si rejected/cancelled/expired:** read-only summary con timestamp.
- `app/(app)/cuenta/adopciones/[handshakeToken]/AdoptionHandshakeActions.tsx` — client component:
  - Mode toggle ("ninguno" / "aceptar" / "rechazar").
  - En modo "aceptar": checkbox **required** "Descargué y leí el contrato de adopción que contiene mis datos y los del animal" + textarea opcional para notas + botón "Aceptar adopción" (disabled hasta checkbox=true).
  - En modo "rechazar": textarea opcional para motivo + botón "Rechazar".
  - useActionState wrapping de `acceptAdoptionHandshakeAction` / `rejectAdoptionHandshakeAction`.
  - Error display + success redirect a `/cuenta/adopciones`.
- `app/api/preview/adoption-handshake-contract/[handshakeToken]/route.ts` — render preview con datos del handshake, **sin** la metadata de firma (status=pending todavía).

Tests:
- E2E del flow completo: adopter recibe notif → abre URL → descarga preview → marca checkbox → acepta → ownership transferida + PDF final archivado.

### Fase 6 — Swap de UI org-side + deprecación del flow viejo — ~0.5 día

**Goal:** las orgs dejan de ver "Finalizar adopción"; código viejo desaparece.

Archivos a modificar:
- `app/org/[orgToken]/adopciones/[applicationEventId]/page.tsx` — botón "Finalizar" se reemplaza por "Aprobar postulación" que llama `approveAdoptionApplicationAction`. Si no hay template configurada, warning banner con CTA al config. Si ya hay handshake pending: read-only "Cancelar handshake" + "Ver detalle".
- `app/org/[orgToken]/mascotas/[publicToken]/page.tsx` — quitar CTA "Finalizar adopción"; reemplazar por "Ver handshake activo" si aplica.
- `app/org/[orgToken]/mascotas/page.tsx` — actualizar badges/state indicators.

Archivos a **eliminar**:
- `app/org/[orgToken]/mascotas/[publicToken]/adoption/page.tsx`
- `app/org/[orgToken]/mascotas/[publicToken]/adoption/FinalizeAdoptionForm.tsx`
- `app/actions/adoption.ts` — eliminar si nadie más lo importa; stub que tira error "use handshake flow" si hay tests legacy.

Tests a actualizar:
- `__tests__/foster-e2e-flow.test.ts` — step de finalize se reemplaza por propose+accept del handshake.
- `__tests__/adoption-cascade.test.ts` — re-target a `acceptAdoptionHandshakeAction`.
- Cualquier test que invoque `finalizeAdoptionAction` directamente — re-target.
- Eliminar o reescribir tests específicos de stub-claim.

### Fase 7 — Polish + observabilidad — ~0.5 día

- Audit log writes confirmados para los 8 actions nuevos.
- Notification badges en el navbar del adopter mostrando handshakes pending.
- RLS audit:
  - `organization_documents`: org members + admins (R/W); terceros sin acceso directo (signed URL only).
  - `adoption_handshakes`: org members del org_id (R), adopter_user_id (R), admins (R), nadie escribe directamente.
  - `org-documents/contracts/*`: read-only via signed URL para adopter + org members.
- Doc updates en `AGENTS.md`:
  - Sección "Adopción" reescrita con el nuevo flow (state diagram + actores).
  - Sección "Capacidades" actualizada — `adoption.finalize` retirado, `adoption.review` cubre todo.
  - Nota sobre firma electrónica simple vs. firma digital.
- `README.md` update.

### Fase 8 — Migración de stubs legacy (opcional, condicional) — N/A o ~1 día

Si la query de stubs devuelve >10, ejecutar plan separado de cleanup. Si <10, ignorar.

---

## 8. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **Stubs existentes en producción** | Plan no los migra. Antes del deploy de Fase 6, correr query de count. Si >10, plan separado. |
| **Race condition: dos org members aprueban simultáneamente** | El partial unique index sobre `(primary_pet_id, case_kind='adoption_handshake') WHERE status in ('open','escalated')` agarra el segundo intento con error DB. En `approveAdoptionApplicationAction`, traducir el error específico ("ya hay una adopción en curso para esta mascota") en vez de bubblear el SQL crudo. Patrón: review 2026-05-19 §2.8. |
| **Generación del PDF falla en runtime serverless** | `@react-pdf/renderer` funciona en Node runtime de Vercel (no Edge). Pre-tx, si la generación falla, error visible y handshake queda pending. Sin daño en ownership. Tests cubren este path. |
| **Cold start del PDF render** | Primera generación tarda ~2-3s. Aceptable porque corre solo en accept (no hot path). Si se vuelve un issue: warm-up cron cada hora con render dummy. |
| **`@react-pdf/renderer` deploy size** | +25-30 MB. Aceptable en Vercel (límite 50 MB para Node functions). Tree-shake imports. |
| **Cláusulas legales requieren ajuste por jurisdicción** | Texto inicial cubre CABA. Si se expande, agregar `clauses_version` v2 con texto para otra jurisdicción. El handshake row snapshotea la versión, así contratos viejos siguen renderando correctamente. |
| **Adopter accepts after template was edited** | Resuelto por D8 — el handshake snapshotea `contract_template_id` y `clauses_version`. El PDF se rendereó con los datos vigentes al accept. La edición posterior de la plantilla no afecta contratos firmados. |
| **PDF >10 MB del override** | Cap actual. Si una org tiene contratos legales largos, subir a 15 MB. No bajar de 10. |
| **Free-tier Supabase storage** | 100 orgs × 1 MB template override + 1000 contratos × 200 KB = ~300 MB. Dentro de free tier por buen tiempo. Monitorear. |
| **`current_pets_detail` JSONB no queryable eficientemente** | Aceptado. Si emerge necesidad de filtros server-side, agregar índice GIN sobre el campo. |
| **Wizard drop-off** | Progress bar + navegación atrás sin pérdida. Si métricas muestran >40% drop-off entre steps, simplificar campos opcionales. |

---

## 9. Verificación end-to-end

Después de la Fase 6, smoke test manual completo:

1. **Setup:** como admin, crear org tipo `shelter`, marcarla `verified=true`. Crear usuario `owner` ("Adopter").
2. **Configurar plantilla:** como org admin, navegar a `/org/[orgToken]/configuracion/adopciones`, llenar form de plantilla (representante, DNI, dirección, jurisdicción CABA), guardar. Verificar que aparece como "Plantilla activa".
3. **Intake:** intake de mascota → queda en `shelter_custody` de la org.
4. **Listar para adopción:** marcar `adoption_eligible=true`, publicar en `/adoptar`.
5. **Postulación:** como Adopter, abrir la mascota, completar el **wizard de 4 pasos**. Verificar:
   - Cada step valida.
   - Navegación atrás preserva datos.
   - Submit final emite `adoption_application_submitted` con `schema_version: 2`.
6. **Aprobar postulación:** como org admin, ver la postulación con todos los campos del wizard, clickear "Aprobar". Verificar:
   - Se emite `adoption_application_resolved(approved)`.
   - Se crea `adoption_handshakes` row con status=pending.
   - Se abre case `adoption_handshake`.
   - Se emite `adoption_handshake_proposed`.
   - Adopter recibe notification.
7. **Adopter ve preview:** abrir `/cuenta/adopciones/[token]`. Verificar:
   - PDF preview abre en nueva pestaña, contiene **sus datos** y los del **animal específico**.
   - Anexo sanitario muestra fechas reales o "Pendiente" donde aplica.
   - Botón "Aceptar" disabled.
   - Marcar checkbox → botón se habilita.
   - Clickear Aceptar.
8. **Verificar transferencia:**
   - `ownerships` table: shelter_custody con `ended_at`, nueva fila con `role='owner'`.
   - `pet_events`: `adoption_handshake_resolved(accepted)` + `adoption_finalized` con `contract_storage_path`.
   - `cases`: handshake case closed con `reason='resolved'`.
   - `reminders`: 4 filas nuevas (1/3/6/12 meses).
   - `adoption_handshakes.generated_contract_path` poblado y archivo accesible.
   - Adopter recibe notif "Adopción finalizada".
   - Si foster activo distinto del adopter: recibe notif de cierre.
9. **PDF firmado:** desde `/cuenta/adopciones/[token]` (status=accepted), descargar PDF. Verificar que contiene metadata de firma (timestamp, IP).
10. **Listing:** la mascota desaparece de `/adoptar`.

### Cron smoke

11. Crear handshake con `expires_at = now() - 1d` vía SQL. Correr `/api/cron/expire-adoption-handshakes` manual. Verificar:
    - Status flip a `expired`.
    - Emite `adoption_handshake_resolved(expired)`.
    - Cierra case con `reason='auto_expired'`.
    - Audit row.
    - Ambos lados notificados.

### Regresión

12. `pnpm typecheck` — baseline (61 errores en seed-storylines, no más).
13. `pnpm test` — todos verdes.
14. `pnpm lint` — clean.

---

## 10. Archivos críticos (orden de implementación para Claude Code)

1. **`db/migrations/0038_adoption_handshake_full.sql`** — load-bearing para todo.
2. **`lib/adoption-contract-clauses.ts`** — fuente de verdad legal.
3. **`lib/event-schemas.ts`** — `adoptionApplicationSubmittedV2` + nuevos eventos del handshake.
4. **`lib/adoption-contract/render.tsx`** — render del PDF.
5. **`lib/adoption-contract/health-record.ts`** — anexo sanitario.
6. **`app/actions/adoption-handshakes.ts`** — corazón del flow.
7. **`app/actions/adoption-applications.ts`** — modificación de `approveAdoptionApplicationAction` que ata todo.
8. **`app/adoptar/[petToken]/postular/wizard/*`** — nueva postulación.
9. **`app/org/[orgToken]/configuracion/adopciones/page.tsx`** — config de plantilla.
10. **`app/(app)/cuenta/adopciones/[handshakeToken]/AdoptionHandshakeActions.tsx`** — UX clave del consentimiento.
11. **`lib/adoption-handshake-expirer.ts`** + **`app/api/cron/expire-adoption-handshakes/route.ts`** — safety net.

### Patrones a clonar literalmente (no reescribir)

- `lib/foster-proposal-expirer.ts` → `lib/adoption-handshake-expirer.ts`.
- `app/api/cron/expire-foster-proposals/route.ts` → `app/api/cron/expire-adoption-handshakes/route.ts`.
- `app/actions/foster-proposals.ts:acceptFosterProposalAction` → estructura de `acceptAdoptionHandshakeAction`.
- `app/(app)/cuenta/transitos/propuestas/[proposalToken]/ProposalActions.tsx` → estructura de `AdoptionHandshakeActions.tsx`.
- `lib/case-closers/expire-cross-org-transfers.ts` → alternativa al pattern del expirer.

### Dependencias nuevas

- `@react-pdf/renderer` (~25 MB en deploy, aceptable).

### Templates de referencia

Ambos `.docx` están en la raíz del repo y deben quedar como anchors de diseño:
- `Formulario_Pre-Adopcion_CABA.docx` — el wizard de postulación debe replicar fielmente las preguntas.
- `Contrato_Adopcion_CABA.docx` — el `renderAdoptionContract()` debe producir un PDF visualmente equivalente.

---

**Fin del plan. Ejecutar Fase 1 → 7 en orden. Cada fase es shippeable independiente; no avanzar si los tests no están verdes.**
