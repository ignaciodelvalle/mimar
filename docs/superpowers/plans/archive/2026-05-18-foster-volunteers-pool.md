# Foster volunteers pool — implementation plan

> **Estado (2026-06-04):** ✅ COMPLETO — enviado (commits 7069d72 → a92366e). Pendiente OPS (no código): aplicar db/foster_rls.sql en Supabase Studio.

> Plan ejecutable para Claude Code. Cuatro fases que implementan el feature completo del pool voluntario de fosters definido en el spec v1.4. Las fases son **estrictamente secuenciales** — A es foundation, B depende de A (extiende schema con eligibility), C necesita A+B (server actions tocan ambos), D necesita C (UI llama actions). Cada fase es 1 PR.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~4 PRs, ~22 archivos nuevos, ~14 archivos tocados, 3 migraciones SQL
> **Estimación total:** ~4 días de CC
>
> **Decisiones de review (post-spec, 2026-05-18):**
> 1. **Cron:** reusar infra existente. Patrón = `app/api/cron/close-rabies-observations` + `materialize-slots` (CRON_SECRET + thin route + helper en `lib/`). Cuando admin page Fase 14 lande `/api/cron/auto-expire-approvals`, ese handler puede absorber este — el helper queda intacto.
> 2. **Authorship del `foster_assigned` post-accept:** `authorRole='shelter'` + `authorOrganizationId=org.id`. La decisión institucional es del refugio; el accept del voluntario es trigger, no autoría.
> 3. **Reason `'adoption'` en `foster_ended`:** está en el enum del Zod schema (canon por `docs/org-portal-plan.md:738`) **pero NO se ofrece en el UI dropdown** del `endFosterAction`. Solo lo emite programáticamente `finalizeAdoptionAction` desde dentro de Flow 7 (composite transaction). Esto matchea `dim-interno:docs/archive/org-portal-prompt.md:178` (prompt histórico archivado: "`adoption` is not selectable here because it only happens via Flow 7").
> 4. **Re-enroll prompt al volunteer post-termination:** prompt-first (vive en la notificación, requiere click explícito del voluntario para incrementar +1 slot). NO auto-restore.
> 5. **`searchFosterVolunteers` ordering:** `availableSlots DESC, matchScore DESC, acceptedCount DESC`. Slots-first.

---

## 0. Antes de tocar nada

Lectura obligatoria en este orden. El spec define el porqué; este plan define el qué y el cómo. Si encontrás contradicción, **gana el spec**:

1. **`docs/superpowers/specs/2026-05-18-foster-volunteers-pool-design.md`** (v1.4 completo). Todas las decisiones D1-D18 están justificadas ahí. El plan asume lectura entera.
2. **`AGENTS.md → User roles & account types`** — para entender el modelo personal/institutional y los account constraints.
3. **`AGENTS.md → Organizations`** y **`AGENTS.md → Data model → Ownership`** — `role='foster'` y polimorfismo `owner_user_id | owner_organization_id`.
4. **`AGENTS.md → Event catalog`** — confirma que `foster_assigned`, `foster_ended`, `adoption_finalized`, `custody_transferred` ya están en `EVENT_TYPES`.
5. **`docs/org-portal-event-flows.md`** Flow 4 (foster assign), Flow 5 (foster end), Flow 7 (adoption finalized). Vas a **extender** estos flows, no a reemplazarlos.
6. **`docs/org-portal-permissions.md`** — capability matrix. Usás `foster.assign` existente; NO se crea capability nueva.
7. **`db/schema.ts`** — confirmá `EVENT_TYPES` const + Drizzle models de `pets`, `ownerships`, `organization_memberships`, `pet_events`.
8. **`lib/event-schemas.ts`** — patrón de Zod schemas estrictos con `withVersion`. Vas a agregar 6 schemas nuevos.
9. **`app/actions/foster.ts`** — `assignFosterAction` y `endFosterAction` existentes. NO se tocan en Fase A/B, se **extienden** en Fase C (catálogo de reasons + slots prompt).
10. **`app/actions/intake.ts`** — el `createIntakeAction` actual. Fase B le agrega un input opcional de eligibility inicial.
11. **`app/actions/adoption.ts`** — `finalizeAdoptionAction` existente. Fase C le agrega parámetro opcional `adopterUserId` (§15 del spec) y check de eligibility (§17.8).
12. **`app/actions/events.ts`** — `recordDeathAction` actual. Fase C lo extiende para auto-cerrar foster activo al recordar muerte (§6.9 caso C).
13. **`docs/patterns/petition-prerequisites.md`** — patrón de pre-condiciones a la D13 (DNI verificado + display_name + phone). Reuso conceptual del mismo patrón aplicado a esta capability.
14. **`db/welfare_rls.sql` y `db/organizations_rls.sql`** — convenciones de RLS: enable + policies + aplicación vía Supabase Studio (NO `pnpm db:push`).
15. **`lib/org-permissions.ts`** — `requireCapability` y la `OrgContext` type. Mismo patrón en los nuevos actions.

**Convención general del repo (ya documentada en AGENTS.md):**

- Spanish UI, English code.
- Eventos append-only — corrección = nuevo evento.
- Migraciones via Supabase Studio + `pnpm db:push` SOLO si la migración es schema-puro sin RLS/triggers. Para este plan: las 3 migraciones se aplican via Studio (cualquier mezcla con policies / constraints justifica el approach manual).
- Tests con Vitest. Cada server action nueva = test de unidad + integration test que cubra happy path + 2 fallos típicos.

## 1. Qué construye este plan

Cuatro fases estrictamente secuenciales:

**Fase A — Schema voluntarios + propuestas.** Migración SQL crea `foster_volunteers` + `foster_proposals` + agrega `ownerships.allow_co_foster`. Drizzle models. `EVENT_TYPES` suma 6 valores (`foster_proposed`, `foster_proposal_accepted`, `foster_proposal_rejected`, `foster_proposal_cancelled`, `foster_proposal_expired`, `foster_co_foster_allowed`). Zod schemas para los 6. CI coverage test refresh.

**Fase B — Adoption eligibility on pets.** Migración SQL agrega 5 columnas `adoption_*_*` a `pets` + 4 CHECK constraints + 2 indexes. `EVENT_TYPES` suma `adoption_eligibility_set`. Zod schema. `setAdoptionEligibilityAction` (server action nueva). `createIntakeAction` recibe input opcional de eligibility inicial. `finalizeAdoptionAction` bloquea si `adoption_eligible !== true`.

**Fase C — Server actions del pool + extensiones.** `app/actions/foster-volunteers.ts` (3 actions: upsert/withdraw/setCoFosterAllowed) + `app/actions/foster-proposals.ts` (5 actions: propose/accept/reject/cancel + search). `lib/foster-matching.ts` (helper de match scoring + warnings). Extensión de `endFosterAction` con catálogo de `reason` + slots prompt post-termination. Extensión de `recordDeathAction` para auto-cerrar foster activo (§6.9-C). Extensión de `finalizeAdoptionAction` con `adopterUserId?` opcional. RLS policies para las 2 tablas nuevas. Cron `/api/cron/expire-foster-proposals` (7-day sweep). Tests por action.

**Fase D — UI surfaces.** Entry-point card en `/cuenta`. `/cuenta/ofrecerme-como-tránsito` (form inscripción con pre-check D13). `/cuenta/transitos/propuestas` (volunteer recibe). `/cuenta/transitos/activos` (volunteer cuida). `/cuenta/transitos/historial`. `/org/[orgToken]/voluntarios` (browse pool). `/org/[orgToken]/voluntarios/propuestas` (propuestas emitidas). `/org/[orgToken]/transitos` (surface unificado §6.3). `/org/[orgToken]/pets/no-aptas` (eligibility surface §17.6). UI de eligibility card en pet detail. Shortcut adopción a foster actual (§15.1). E2E mínimo.

## 2. Decisiones cerradas (resumen — NO relitigar)

Ver §2 del spec para razones. Lista corta para referencia rápida durante implementación:

| # | Decisión |
|---|---|
| D1 | Pool global, no por-org |
| D2 | Volunteer NO es organization_member |
| D3 | Org-initiated solamente en v1 (volunteer no browse) |
| D4 | Multi-propuesta paralela permitida sin auto-cancel (cuando otro voluntario acepta) |
| D5 | Match constraints son guidelines, no validaciones duras (warning, no error) |
| D6 | Pet siempre concreto en la propuesta |
| D7 | PPP excluidas por default (opt-in con disclaimer) |
| D8 | Locality opcional |
| D9 | Estados volunteer: active / paused / withdrawn |
| D10 | Proposals expiran a 7d sin respuesta (cron) |
| D11 | Materialize post-aceptación NO requiere foster.assign capability |
| D12 | Aceptación = notification obligatoria; rechazo = idem (settings simplificadas en v1.4) |
| D13 | Pre-condiciones: dniVerified + display_name + phone + role=owner |
| D14 | Adoption eligibility flag per pet (medical/behavioral/quarantine/legal/etc.) |
| D15 | Foster tiene capacidades plenas como owner durante el tránsito |
| D16 | **Slots single-use**: cada inscripción +1, cada accept -1, prompt re-enroll post-termination |
| D17 | **Co-foster opt-in** del primer foster (checkbox al aceptar) |
| D18 | **Cascade auto-cancel** de otras propuestas pending al volunteer cuando sus slots llegan a 0 |

## 3. Scope

**Dentro:**
- 3 migraciones SQL (Fase A: foster_volunteers + foster_proposals + ownerships.allow_co_foster; Fase B: pets.adoption_*).
- 6 nuevos `EVENT_TYPES` + 1 más en Fase B + sus Zod schemas.
- 9 server actions nuevas (3 volunteers, 5 proposals, 1 eligibility).
- 3 server actions extendidas (`createIntakeAction`, `endFosterAction`, `recordDeathAction`, `finalizeAdoptionAction`).
- 1 lib nueva (`lib/foster-matching.ts`).
- 1 cron handler (`app/api/cron/expire-foster-proposals/route.ts`).
- ~10 rutas/pages nuevas (mix de `/cuenta/*`, `/org/[orgToken]/*`).
- ~12 componentes nuevos (forms, cards, modales).
- RLS para las 2 tablas nuevas.
- Tests por action + un E2E mínimo del flow end-to-end.

**Fuera:**
- Volunteer-initiated browse de pets disponibles (out-of-scope §12 del spec).
- Tariff / compensación económica.
- Score reputacional bidireccional.
- Verificación domiciliaria automática.
- Multi-pet por propuesta.
- Visibility a govts.
- Integración formal con vecino-en-tránsito (paths separados).
- Email transaccional para volunteers (futuro).
- Cron de auto-cancel time-bomb adicional.
- `org_proposal_settings` table (settings hardcoded en v1.4).

## 4. Plan paso a paso

### Fase A — Schema voluntarios + propuestas

**Output**: schema base que las fases B-D usan. 1 PR.

#### Paso A.1 — Migración SQL `foster_volunteers` + `foster_proposals` + `ownerships.allow_co_foster`

Crear `db/migrations/NNNN_foster_volunteers_pool.sql` (NNNN según orden actual). Idempotente:

```sql
-- Foster volunteers pool — foundation
-- Implements §4.1, §4.2, §4.4 of the foster volunteers pool spec v1.4.

-- 1) foster_volunteers — pool de owners voluntarios
create table if not exists public.foster_volunteers (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null unique
                                  references public.profiles(id) on delete cascade,

  status                        text not null default 'active',
  available_slots               integer not null default 0,

  jurisdiction_province         text,
  jurisdiction_locality         text,

  accepts_dogs                  boolean not null default false,
  accepts_cats                  boolean not null default false,
  accepts_other_species         boolean not null default false,

  accepts_size_small            boolean not null default true,
  accepts_size_medium           boolean not null default true,
  accepts_size_large            boolean not null default false,

  accepts_puppies               boolean not null default false,
  accepts_seniors               boolean not null default true,

  accepts_chronic_conditions    boolean not null default false,
  accepts_dangerous_breeds      boolean not null default false,

  max_duration_weeks            integer,
  household_other_pets          boolean,
  household_kids                boolean,

  notes                         text,

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint foster_volunteers_status_valid check (
    status in ('active','paused','withdrawn')
  ),
  constraint foster_volunteers_slots_non_negative check (available_slots >= 0),
  constraint foster_volunteers_at_least_one_species check (
    status != 'active'
    or (accepts_dogs or accepts_cats or accepts_other_species)
  )
);

create index if not exists foster_volunteers_pool_idx
  on public.foster_volunteers (status)
  where status = 'active' and available_slots > 0;

create index if not exists foster_volunteers_locality_idx
  on public.foster_volunteers (jurisdiction_province, jurisdiction_locality)
  where status = 'active' and available_slots > 0;

create index if not exists foster_volunteers_user_idx
  on public.foster_volunteers (user_id);

-- 2) foster_proposals — propuestas concretas org→voluntario
create table if not exists public.foster_proposals (
  id                            uuid primary key default gen_random_uuid(),
  public_token                  text not null unique,

  organization_id               uuid not null
                                  references public.organizations(id) on delete cascade,
  volunteer_user_id             uuid not null
                                  references public.profiles(id) on delete cascade,
  pet_id                        uuid not null
                                  references public.pets(id) on delete cascade,
  proposed_by_user_id           uuid not null references public.profiles(id),

  proposed_at                   timestamptz not null default now(),
  proposed_duration_weeks       integer,
  proposed_notes                text,
  match_warnings                jsonb not null default '[]'::jsonb,
  expires_at                    timestamptz not null,

  status                        text not null default 'pending',

  responded_at                  timestamptz,
  response_notes                text,
  rejection_reason              text,

  cancelled_at                  timestamptz,
  cancelled_by_user_id          uuid references public.profiles(id),
  cancellation_reason           text,

  resolved_ownership_id         uuid references public.ownerships(id),

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint foster_proposals_status_valid check (status in (
    'pending','accepted','rejected','expired','cancelled'
  )),
  constraint foster_proposals_rejection_reason_valid check (
    rejection_reason is null
    or rejection_reason in (
      'capacity','health_mismatch','timing','distance','household','other'
    )
  ),
  -- response_consistent: each terminal status requires the matching marker fields.
  -- Cannot rely on a function so we inline the check.
  constraint foster_proposals_response_consistent check (
    (status = 'pending'   and responded_at is null and cancelled_at is null)
    or (status = 'accepted'  and responded_at is not null and resolved_ownership_id is not null)
    or (status = 'rejected'  and responded_at is not null)
    or (status = 'expired'   and (responded_at is null or expires_at <= responded_at))
    or (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null)
  )
);

create index if not exists foster_proposals_volunteer_idx
  on public.foster_proposals (volunteer_user_id, status, proposed_at desc);
create index if not exists foster_proposals_org_idx
  on public.foster_proposals (organization_id, status, proposed_at desc);
create index if not exists foster_proposals_pet_idx
  on public.foster_proposals (pet_id)
  where status in ('pending','accepted');
create index if not exists foster_proposals_status_idx
  on public.foster_proposals (status, expires_at);

-- 3) ownerships.allow_co_foster — D17
alter table public.ownerships
  add column if not exists allow_co_foster boolean not null default false;

comment on column public.ownerships.allow_co_foster is
  'Foster-only flag (D17): when role=foster and true, the org can assign additional co-fosters to the same pet. Ignored for other roles.';

-- 4) Comments for documentation
comment on table public.foster_volunteers is
  'Pool of pet-owners voluntarily offering temporary foster care to shelter pets (spec v1.4 §4.1).';
comment on column public.foster_volunteers.available_slots is
  'D16 single-use slot model: +1 per enrollment, -1 per accept, prompt to re-enroll post-termination.';
comment on table public.foster_proposals is
  'Concrete org→volunteer foster proposals for a specific pet (spec v1.4 §4.2). Two-phase: propose then accept/reject/cancel.';

-- Reverse (documented, not executed):
-- alter table public.ownerships drop column allow_co_foster;
-- drop table if exists public.foster_proposals;
-- drop table if exists public.foster_volunteers;
```

Aplicar via **Supabase Studio**. Después correr `pnpm db:smoke` para asegurar que no se rompió RLS de tablas existentes.

#### Paso A.2 — Drizzle models en `db/schema.ts`

Agregar al final del archivo (junto a otros tables):

```ts
export const fosterVolunteers = pgTable("foster_volunteers", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().unique().references(() => profiles.id, { onDelete: "cascade" }),

  status: text("status").notNull().default("active"),
  availableSlots: integer("available_slots").notNull().default(0),

  jurisdictionProvince: text("jurisdiction_province"),
  jurisdictionLocality: text("jurisdiction_locality"),

  acceptsDogs: boolean("accepts_dogs").notNull().default(false),
  acceptsCats: boolean("accepts_cats").notNull().default(false),
  acceptsOtherSpecies: boolean("accepts_other_species").notNull().default(false),

  acceptsSizeSmall: boolean("accepts_size_small").notNull().default(true),
  acceptsSizeMedium: boolean("accepts_size_medium").notNull().default(true),
  acceptsSizeLarge: boolean("accepts_size_large").notNull().default(false),

  acceptsPuppies: boolean("accepts_puppies").notNull().default(false),
  acceptsSeniors: boolean("accepts_seniors").notNull().default(true),

  acceptsChronicConditions: boolean("accepts_chronic_conditions").notNull().default(false),
  acceptsDangerousBreeds: boolean("accepts_dangerous_breeds").notNull().default(false),

  maxDurationWeeks: integer("max_duration_weeks"),
  householdOtherPets: boolean("household_other_pets"),
  householdKids: boolean("household_kids"),

  notes: text("notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const fosterProposals = pgTable("foster_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicToken: text("public_token").notNull().unique(),

  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  volunteerUserId: uuid("volunteer_user_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  petId: uuid("pet_id").notNull().references(() => pets.id, { onDelete: "cascade" }),
  proposedByUserId: uuid("proposed_by_user_id").notNull().references(() => profiles.id),

  proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
  proposedDurationWeeks: integer("proposed_duration_weeks"),
  proposedNotes: text("proposed_notes"),
  matchWarnings: jsonb("match_warnings").notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  status: text("status").notNull().default("pending"),

  respondedAt: timestamp("responded_at", { withTimezone: true }),
  responseNotes: text("response_notes"),
  rejectionReason: text("rejection_reason"),

  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByUserId: uuid("cancelled_by_user_id").references(() => profiles.id),
  cancellationReason: text("cancellation_reason"),

  resolvedOwnershipId: uuid("resolved_ownership_id").references(() => ownerships.id),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Y agregar a `ownerships`:

```ts
allowCoFoster: boolean("allow_co_foster").notNull().default(false),
```

Agregar a `EVENT_TYPES` (en `db/schema.ts`):

```ts
"foster_proposed",
"foster_proposal_accepted",
"foster_proposal_rejected",
"foster_proposal_cancelled",
"foster_proposal_expired",
"foster_co_foster_allowed",
```

#### Paso A.3 — Zod schemas en `lib/event-schemas.ts`

Agregar 6 schemas nuevos:

```ts
const fosterProposed = z.object(
  withVersion({
    proposal_public_token: z.string(),
    volunteer_user_id: z.string().uuid(),
    proposed_duration_weeks: z.number().int().positive().nullable().optional(),
    match_warnings: z.array(z.string()).default([]),
  }),
).strict();

const fosterProposalAccepted = z.object(
  withVersion({
    proposal_public_token: z.string(),
    response_notes: z.string().nullable().optional(),
  }),
).strict();

const fosterProposalRejected = z.object(
  withVersion({
    proposal_public_token: z.string(),
    rejection_reason: z.enum(["capacity","health_mismatch","timing","distance","household","other"]),
    response_notes: z.string().nullable().optional(),
  }),
).strict();

const fosterProposalCancelled = z.object(
  withVersion({
    proposal_public_token: z.string(),
    cancellation_reason: z.string().nullable().optional(),
    auto_cancelled: z.boolean().default(false),       // D18: true cuando viene del cascade
  }),
).strict();

const fosterProposalExpired = z.object(
  withVersion({
    proposal_public_token: z.string(),
  }),
).strict();

const fosterCoFosterAllowed = z.object(
  withVersion({
    allow_co_foster: z.boolean(),
    foster_ownership_id: z.string().uuid(),
  }),
).strict();
```

Y registrarlos en el map `PayloadSchemas` (mismo archivo) bajo sus respectivas keys.

#### Paso A.4 — CI coverage test refresh

Verificar `lib/event-schemas.test.ts` (test que asegura que cada `EVENT_TYPES` value tiene un schema correspondiente). Debe pasar con los 6 nuevos. Si no, agregar los 6 a la lista de tipos esperados en el test.

#### Paso A.5 — Tests Fase A

- `lib/event-schemas.test.ts` — extender para los 6 schemas: validan happy + falla por unknown key (strict) + falla por missing required.
- `db/schema.test.ts` (si existe) — verificar que las 2 tablas nuevas y la columna `ownerships.allow_co_foster` se reflejan en Drizzle.

**Criterio de PR para Fase A**: schema aplicado en Studio, Drizzle compila, los 6 Zod schemas se importan sin crashear, tests verdes.

---

### Fase B — Adoption eligibility on pets

**Output**: pets pueden ser marcadas no aptas con motivo estructurado. 1 PR.

#### Paso B.1 — Migración SQL `pets.adoption_eligible` + columnas relacionadas

Crear `db/migrations/NNNN_pets_adoption_eligibility.sql`:

```sql
-- Pets adoption eligibility — §17 del spec foster volunteers pool v1.4
-- Implementa el flag y razones estructuradas que controlan listing público
-- (cuando /adoptar lande) y el surface "no aptas" de la org.

alter table public.pets
  add column if not exists adoption_eligible              boolean,
  add column if not exists adoption_ineligible_reason     text,
  add column if not exists adoption_ineligible_reason_notes text,
  add column if not exists adoption_ineligible_until      timestamptz,
  add column if not exists adoption_eligibility_set_at    timestamptz,
  add column if not exists adoption_eligibility_set_by_user_id uuid
    references public.profiles(id);

-- CHECK constraints
do $$ begin
  alter table public.pets
    add constraint pets_adoption_ineligible_reason_valid check (
      adoption_ineligible_reason is null
      or adoption_ineligible_reason in (
        'medical_treatment','behavioral_evaluation','recovery','quarantine',
        'legal_hold','age','pending_intake_eval','other'
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pets
    add constraint pets_adoption_eligibility_consistent check (
      (adoption_eligible is not null and adoption_eligibility_set_at is not null)
      or (adoption_eligible is null and adoption_eligibility_set_at is null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pets
    add constraint pets_adoption_ineligible_reason_required check (
      adoption_eligible is null
      or adoption_eligible = true
      or (adoption_eligible = false and adoption_ineligible_reason is not null)
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pets
    add constraint pets_adoption_ineligible_other_needs_notes check (
      adoption_ineligible_reason is null
      or adoption_ineligible_reason != 'other'
      or (adoption_ineligible_reason_notes is not null
          and length(trim(adoption_ineligible_reason_notes)) > 0)
    );
exception when duplicate_object then null; end $$;

create index if not exists pets_adoption_eligibility_idx
  on public.pets (adoption_eligible)
  where adoption_eligible is not null;

create index if not exists pets_adoption_ineligible_until_idx
  on public.pets (adoption_ineligible_until)
  where adoption_eligible = false and adoption_ineligible_until is not null;
```

Aplicar via Supabase Studio.

#### Paso B.2 — Drizzle model update

Agregar a `pets` table en `db/schema.ts`:

```ts
adoptionEligible: boolean("adoption_eligible"),
adoptionIneligibleReason: text("adoption_ineligible_reason"),
adoptionIneligibleReasonNotes: text("adoption_ineligible_reason_notes"),
adoptionIneligibleUntil: timestamp("adoption_ineligible_until", { withTimezone: true }),
adoptionEligibilitySetAt: timestamp("adoption_eligibility_set_at", { withTimezone: true }),
adoptionEligibilitySetByUserId: uuid("adoption_eligibility_set_by_user_id").references(() => profiles.id),
```

Agregar a `EVENT_TYPES`:

```ts
"adoption_eligibility_set",
```

#### Paso B.3 — Zod schema `adoption_eligibility_set`

En `lib/event-schemas.ts`:

```ts
const adoptionEligibilitySet = z.object(
  withVersion({
    eligible: z.boolean(),
    ineligible_reason: z.enum([
      "medical_treatment","behavioral_evaluation","recovery","quarantine",
      "legal_hold","age","pending_intake_eval","other"
    ]).nullable().optional(),
    ineligible_reason_notes: z.string().nullable().optional(),
    ineligible_until: z.string().datetime().nullable().optional(),
    previous_state: z.object({
      eligible: z.boolean().nullable(),
      reason: z.string().nullable(),
    }).nullable().optional(),
  }),
).strict().refine(
  (data) =>
    data.eligible === true ||
    data.ineligible_reason != null,
  { message: "ineligible_reason required when eligible=false" }
).refine(
  (data) =>
    data.ineligible_reason !== "other" ||
    (data.ineligible_reason_notes != null && data.ineligible_reason_notes.trim().length > 0),
  { message: "ineligible_reason_notes required when reason='other'" }
);
```

Registrar en `PayloadSchemas` map.

#### Paso B.4 — `setAdoptionEligibilityAction`

Crear `app/actions/adoption-eligibility.ts`:

```ts
"use server";

import { db } from "@/db/client";
import { pets, petEvents, notifications, ownerships, organizationMemberships } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { requireCapability } from "@/lib/org-permissions";
import { resolveAuthorship } from "@/lib/event-authorship";
import { validateEventPayload } from "@/lib/event-schemas";
import { getSession } from "@/lib/auth";

export async function setAdoptionEligibilityAction(input: {
  orgToken: string;
  petPublicToken: string;
  eligible: boolean;
  ineligibleReason?:
    | "medical_treatment" | "behavioral_evaluation" | "recovery"
    | "quarantine" | "legal_hold" | "age" | "pending_intake_eval" | "other";
  ineligibleReasonNotes?: string;
  ineligibleUntil?: string;
}): Promise<{ ok: true } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "No autenticado" };

  return await db.transaction(async (tx) => {
    // 1. Resolve org + pet + capability
    const org = await resolveOrg(tx, input.orgToken);
    if (!org) return { error: "Organización no encontrada" };

    const orgCtx = await getOrgContext(tx, session.user.id, org.id);
    requireCapability("pets.intake", orgCtx);

    const pet = await tx.query.pets.findFirst({
      where: eq(pets.publicToken, input.petPublicToken),
    });
    if (!pet) return { error: "Mascota no encontrada" };

    // 2. Validate pet is in shelter_custody of this org
    const activeOwnership = await tx.query.ownerships.findFirst({
      where: and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.role, "shelter_custody"),
        eq(ownerships.ownerOrganizationId, org.id),
        isNull(ownerships.endedAt),
      ),
    });
    if (!activeOwnership) {
      return { error: "Esta mascota no está en custodia de tu organización" };
    }

    // 3. Validate input shape (D14 + §17.3)
    if (!input.eligible && !input.ineligibleReason) {
      return { error: "Razón requerida cuando la mascota no es apta" };
    }
    if (input.ineligibleReason === "other" && !input.ineligibleReasonNotes?.trim()) {
      return { error: "Notas requeridas cuando la razón es 'other'" };
    }

    // 4. Snapshot previous state
    const previousState = {
      eligible: pet.adoptionEligible,
      reason: pet.adoptionIneligibleReason,
    };

    // 5. UPDATE pets
    const now = new Date();
    await tx.update(pets).set({
      adoptionEligible: input.eligible,
      adoptionIneligibleReason: input.eligible ? null : input.ineligibleReason!,
      adoptionIneligibleReasonNotes: input.eligible ? null : (input.ineligibleReasonNotes ?? null),
      adoptionIneligibleUntil: input.eligible ? null : (input.ineligibleUntil ? new Date(input.ineligibleUntil) : null),
      adoptionEligibilitySetAt: now,
      adoptionEligibilitySetByUserId: session.user.id,
      updatedAt: now,
    }).where(eq(pets.id, pet.id));

    // 6. Insert pet_events
    const payload = validateEventPayload("adoption_eligibility_set", {
      payload_version: 1,
      eligible: input.eligible,
      ineligible_reason: input.eligible ? null : input.ineligibleReason,
      ineligible_reason_notes: input.eligible ? null : (input.ineligibleReasonNotes ?? null),
      ineligible_until: input.eligible ? null : (input.ineligibleUntil ?? null),
      previous_state: previousState,
    });

    const authorship = await resolveAuthorship(orgCtx, session.user);
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "adoption_eligibility_set",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: session.user.id,
      authorRole: authorship.authorRole,
      authorOrganizationId: org.id,
      authorVerified: authorship.authorVerified,
      payload,
    });

    // 7. Notify org admins if marking ineligible (§17.3 step 3)
    if (!input.eligible) {
      await notifyOrgAdmins(tx, org.id, {
        notificationType: "pet_marked_ineligible",
        title: `${pet.name} marcada como no apta para adopción`,
        body: `Motivo: ${ineligibleReasonLabel(input.ineligibleReason!)}`,
        relatedPetId: pet.id,
      });
    }

    return { ok: true };
  });
}
```

Helpers (`resolveOrg`, `getOrgContext`, `notifyOrgAdmins`, `ineligibleReasonLabel`) ya existen o son patrones triviales — reusar / copiar de actions existentes.

#### Paso B.5 — Extender `createIntakeAction`

En `app/actions/intake.ts`, agregar input opcional:

```ts
type IntakeInput = {
  // ... existing fields
  initialAdoptionEligibility?: {
    eligible: boolean;
    ineligibleReason?: ...;
    ineligibleReasonNotes?: string;
    ineligibleUntil?: string;
  };
};
```

Dentro del transaction del intake, **después** del `pets` INSERT y **antes** del commit, si `initialAdoptionEligibility` viene:

- Llamar a la lógica de `setAdoptionEligibilityAction` reusada (extraer a helper `applyAdoptionEligibilityInTx` para no duplicar).
- Emite el `adoption_eligibility_set` event junto al `pet_registered` y `shelter_intake_recorded`.

Si no viene, `pets.adoption_eligible` queda NULL (default — "sin determinar todavía").

#### Paso B.6 — Extender `finalizeAdoptionAction` con check de eligibility

En `app/actions/adoption.ts → finalizeAdoptionAction`:

Agregar antes de los pre-condition checks existentes:

```ts
const pet = /* ... existing lookup ... */;

if (pet.adoptionEligible !== true) {
  return {
    error: pet.adoptionEligible === false
      ? `Esta mascota no está apta para adopción (motivo: ${ineligibleReasonLabel(pet.adoptionIneligibleReason!)}). Resolvé el motivo antes de finalizar.`
      : "Esta mascota no fue evaluada para adopción todavía. Marcá su estado antes de finalizar.",
  };
}
```

Esto cierra §17.8 del spec — el block.

#### Paso B.7 — Tests Fase B

- `app/actions/adoption-eligibility.test.ts` — happy path (mark ineligible, mark eligible, edit reason). Fallos: pet not in custody, missing reason, "other" sin notes.
- `app/actions/intake.test.ts` extendido — intake con initialAdoptionEligibility set.
- `app/actions/adoption.test.ts` extendido — finalize falla con `adoption_eligible !== true`.

**Criterio de PR para Fase B**: migración aplicada, action verde, intake y adoption respetan el flag.

---

### Fase C — Server actions del pool + extensiones

**Output**: backend completo del feature. 1 PR (grande pero auto-contenido). Tests por action.

#### Paso C.1 — `app/actions/foster-volunteers.ts`

Crear con las 3 actions del spec §10:

**`upsertFosterVolunteerAction`** — maneja inscripción (D16: cada `mode='enroll'` incrementa slots).

```ts
"use server";

export async function upsertFosterVolunteerAction(input: {
  mode: "enroll" | "update_preferences_only";
  status: "active" | "paused";
  acceptsDogs: boolean;
  // ... resto de preferences
  notes?: string;
}): Promise<{ volunteerId: string; availableSlots: number } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "No autenticado" };

  return await db.transaction(async (tx) => {
    // 1. D13 pre-condition checks
    const profile = await tx.query.profiles.findFirst({
      where: eq(profiles.id, session.user.id),
    });
    if (!profile) return { error: "Perfil no encontrado" };
    if (profile.accountType !== "personal" || profile.role !== "owner") {
      return { error: "Solo cuentas personales con rol owner pueden inscribirse" };
    }
    if (!profile.dniVerified) {
      return { error: "Verificá tu DNI antes de inscribirte como voluntario" };
    }
    if (!profile.displayName?.trim()) {
      return { error: "Completá tu nombre antes de inscribirte" };
    }
    if (!profile.phone?.trim()) {
      return { error: "Agregá tu teléfono antes de inscribirte" };
    }

    // 2. Validate at least one species when active
    if (input.status === "active") {
      if (!input.acceptsDogs && !input.acceptsCats && !input.acceptsOtherSpecies) {
        return { error: "Elegí al menos una especie que aceptás" };
      }
    }

    // 3. Upsert
    const existing = await tx.query.fosterVolunteers.findFirst({
      where: eq(fosterVolunteers.userId, session.user.id),
    });

    const now = new Date();
    let row;
    if (!existing) {
      // First enrollment — always +1 slot
      row = await tx.insert(fosterVolunteers).values({
        userId: session.user.id,
        status: input.status,
        availableSlots: input.mode === "enroll" ? 1 : 0,
        acceptsDogs: input.acceptsDogs,
        // ... rest
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      }).returning();
    } else {
      // Existing — only enroll mode increments slots
      const newSlots = input.mode === "enroll"
        ? existing.availableSlots + 1
        : existing.availableSlots;

      row = await tx.update(fosterVolunteers).set({
        status: input.status,
        availableSlots: newSlots,
        acceptsDogs: input.acceptsDogs,
        // ... rest
        notes: input.notes ?? null,
        updatedAt: now,
      }).where(eq(fosterVolunteers.id, existing.id)).returning();
    }

    return {
      volunteerId: row[0].id,
      availableSlots: row[0].availableSlots,
    };
  });
}
```

**`withdrawFosterVolunteerAction`** — set `status='withdrawn'`, NO toca slots históricamente; voluntario sale del pool pero la row queda.

```ts
export async function withdrawFosterVolunteerAction(): Promise<{ ok: true } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "No autenticado" };

  return await db.transaction(async (tx) => {
    const existing = await tx.query.fosterVolunteers.findFirst({
      where: eq(fosterVolunteers.userId, session.user.id),
    });
    if (!existing) return { error: "No estás inscripto" };

    await tx.update(fosterVolunteers).set({
      status: "withdrawn",
      availableSlots: 0,  // explicit: no propuestas nuevas
      updatedAt: new Date(),
    }).where(eq(fosterVolunteers.id, existing.id));

    // Cancel cualquier pending proposals dirigidas a este voluntario
    await tx.update(fosterProposals).set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledByUserId: session.user.id,
      cancellationReason: "volunteer_withdrew",
      updatedAt: new Date(),
    }).where(and(
      eq(fosterProposals.volunteerUserId, session.user.id),
      eq(fosterProposals.status, "pending"),
    ));

    return { ok: true };
  });
}
```

**`setCoFosterAllowedAction`** — D17 toggle posterior a la aceptación.

```ts
export async function setCoFosterAllowedAction(input: {
  fosterOwnershipId: string;
  allowCoFoster: boolean;
}): Promise<{ ok: true } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "No autenticado" };

  return await db.transaction(async (tx) => {
    const ownership = await tx.query.ownerships.findFirst({
      where: and(
        eq(ownerships.id, input.fosterOwnershipId),
        eq(ownerships.role, "foster"),
        eq(ownerships.ownerUserId, session.user.id),
        isNull(ownerships.endedAt),
      ),
    });
    if (!ownership) return { error: "Tránsito no encontrado o no es tuyo" };

    await tx.update(ownerships).set({
      allowCoFoster: input.allowCoFoster,
    }).where(eq(ownerships.id, input.fosterOwnershipId));

    // Emit pet_events.foster_co_foster_allowed
    await tx.insert(petEvents).values({
      petId: ownership.petId,
      eventType: "foster_co_foster_allowed",
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: session.user.id,
      authorRole: "owner",
      authorOrganizationId: null,
      authorVerified: false,
      payload: validateEventPayload("foster_co_foster_allowed", {
        payload_version: 1,
        allow_co_foster: input.allowCoFoster,
        foster_ownership_id: input.fosterOwnershipId,
      }),
    });

    return { ok: true };
  });
}
```

#### Paso C.2 — `app/actions/foster-proposals.ts`

Las 5 actions del spec §10.

**`proposeFosterAction`** — entry-point del refugio. Validaciones críticas: pet en shelter_custody, foster activo con `allow_co_foster=true` (si lo hay), volunteer con slot > 0.

```ts
export async function proposeFosterAction(input: {
  orgToken: string;
  volunteerUserId: string;
  petPublicToken: string;
  proposedDurationWeeks?: number;
  proposedNotes?: string;
}): Promise<{ proposalPublicToken: string } | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "No autenticado" };

  return await db.transaction(async (tx) => {
    const org = await resolveOrg(tx, input.orgToken);
    if (!org) return { error: "Org no encontrada" };

    const orgCtx = await getOrgContext(tx, session.user.id, org.id);
    requireCapability("foster.assign", orgCtx);

    // 1. Pet en shelter_custody de la org
    const pet = await tx.query.pets.findFirst({
      where: eq(pets.publicToken, input.petPublicToken),
    });
    if (!pet) return { error: "Mascota no encontrada" };

    const orgCustody = await tx.query.ownerships.findFirst({
      where: and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerOrganizationId, org.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    });
    if (!orgCustody) return { error: "Tu org no tiene custodia activa de esta mascota" };

    // 2. Co-foster check (D17)
    const activeFosterRows = await tx.query.ownerships.findMany({
      where: and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.role, "foster"),
        isNull(ownerships.endedAt),
      ),
    });
    const anyDisallowsCoFoster = activeFosterRows.some(r => !r.allowCoFoster);
    if (activeFosterRows.length > 0 && anyDisallowsCoFoster) {
      return { error: "Esta mascota ya tiene foster activo y no admite co-foster" };
    }

    // 3. Volunteer disponible (D16)
    const volunteer = await tx.query.fosterVolunteers.findFirst({
      where: eq(fosterVolunteers.userId, input.volunteerUserId),
    });
    if (!volunteer) return { error: "Este usuario no está en el pool" };
    if (volunteer.status !== "active") return { error: "El voluntario no está activo" };
    if (volunteer.availableSlots <= 0) {
      return { error: "Este voluntario no tiene slots disponibles" };
    }

    // 4. Compute match warnings (snapshot)
    const matchWarnings = computeMatch(
      { species: pet.species, /* ... */ },
      volunteer,
      input.proposedDurationWeeks,
    ).warnings;

    // 5. Insert foster_proposals
    const publicToken = generateProposalToken(); // helper: "FP-XXXX-XXXX"
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const [proposal] = await tx.insert(fosterProposals).values({
      publicToken,
      organizationId: org.id,
      volunteerUserId: input.volunteerUserId,
      petId: pet.id,
      proposedByUserId: session.user.id,
      proposedAt: now,
      proposedDurationWeeks: input.proposedDurationWeeks ?? null,
      proposedNotes: input.proposedNotes ?? null,
      matchWarnings: matchWarnings.map(w => w.message),
      expiresAt,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }).returning();

    // 6. Emit pet_event
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "foster_proposed",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: session.user.id,
      authorRole: "shelter",
      authorOrganizationId: org.id,
      authorVerified: true,
      payload: validateEventPayload("foster_proposed", {
        payload_version: 1,
        proposal_public_token: publicToken,
        volunteer_user_id: input.volunteerUserId,
        proposed_duration_weeks: input.proposedDurationWeeks ?? null,
        match_warnings: matchWarnings.map(w => w.message),
      }),
    });

    // 7. Notify volunteer
    await tx.insert(notifications).values({
      userId: input.volunteerUserId,
      notificationType: "foster_proposal_received",
      severity: "info",
      title: `${org.displayName} te propuso un tránsito`,
      body: `Mascota: ${pet.name} (${pet.species}). Click para ver detalles y aceptar/rechazar.`,
      ctaLabel: "Ver propuesta",
      ctaUrl: `/cuenta/transitos/propuestas/${publicToken}`,
      relatedPetId: pet.id,
      createdAt: now,
    });

    return { proposalPublicToken: publicToken };
  });
}
```

**`acceptFosterProposalAction`** — el grande. Transacción atómica con D17 + D16 + D18.

```ts
export async function acceptFosterProposalAction(input: {
  proposalPublicToken: string;
  allowCoFoster: boolean;
  responseNotes?: string;
}): Promise<{
  fosterOwnershipId: string;
  remainingSlots: number;
  cascadeCancelledProposals: string[];
} | { error: string }> {
  const session = await getSession();
  if (!session) return { error: "No autenticado" };

  return await db.transaction(async (tx) => {
    // 1. Lock proposal row (advisory or SELECT FOR UPDATE)
    const proposal = await tx.query.fosterProposals.findFirst({
      where: eq(fosterProposals.publicToken, input.proposalPublicToken),
    });
    if (!proposal) return { error: "Propuesta no encontrada" };
    if (proposal.volunteerUserId !== session.user.id) return { error: "Esta propuesta no es para vos" };
    if (proposal.status !== "pending") return { error: "Esta propuesta ya no está activa" };

    // 2. Re-validate pet state (defense-in-depth)
    const pet = await tx.query.pets.findFirst({ where: eq(pets.id, proposal.petId) });
    if (!pet) return { error: "Mascota no encontrada" };

    const orgCustody = await tx.query.ownerships.findFirst({
      where: and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.ownerOrganizationId, proposal.organizationId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    });
    if (!orgCustody) {
      return { error: "La organización ya no tiene custodia de esta mascota" };
    }

    const activeFosterRows = await tx.query.ownerships.findMany({
      where: and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.role, "foster"),
        isNull(ownerships.endedAt),
      ),
    });
    const anyDisallows = activeFosterRows.some(r => !r.allowCoFoster);
    if (activeFosterRows.length > 0 && anyDisallows) {
      return { error: "El estado del pet cambió: ahora tiene foster activo que no admite co-foster" };
    }

    // 3. Re-validate volunteer slots (anti-race)
    const volunteer = await tx.query.fosterVolunteers.findFirst({
      where: eq(fosterVolunteers.userId, session.user.id),
    });
    if (!volunteer || volunteer.status !== "active" || volunteer.availableSlots <= 0) {
      return { error: "Ya no tenés slots disponibles" };
    }

    // 4. UPDATE proposal status=accepted
    const now = new Date();
    await tx.update(fosterProposals).set({
      status: "accepted",
      respondedAt: now,
      responseNotes: input.responseNotes ?? null,
      updatedAt: now,
    }).where(eq(fosterProposals.id, proposal.id));

    // 5. CREATE foster ownership row
    const [fosterOwnership] = await tx.insert(ownerships).values({
      petId: pet.id,
      ownerUserId: session.user.id,
      role: "foster",
      startedAt: now,
      allowCoFoster: input.allowCoFoster,
    }).returning();

    // 6. Link back
    await tx.update(fosterProposals).set({
      resolvedOwnershipId: fosterOwnership.id,
    }).where(eq(fosterProposals.id, proposal.id));

    // 7. Emit foster_proposal_accepted + foster_assigned events
    const authorOwner = { authorRole: "owner" as const, authorOrganizationId: null, authorVerified: false };
    const authorOrg = { authorRole: "shelter" as const, authorOrganizationId: proposal.organizationId, authorVerified: true };

    await tx.insert(petEvents).values([
      {
        petId: pet.id,
        eventType: "foster_proposal_accepted",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: session.user.id,
        ...authorOwner,
        payload: validateEventPayload("foster_proposal_accepted", {
          payload_version: 1,
          proposal_public_token: proposal.publicToken,
          response_notes: input.responseNotes ?? null,
        }),
      },
      {
        petId: pet.id,
        eventType: "foster_assigned",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: session.user.id,
        ...authorOrg, // attribution to the org because the assignment is institutional
        payload: validateEventPayload("foster_assigned", {
          payload_version: 1,
          foster_user_id: session.user.id,
          via: "volunteer_pool_proposal",
          proposal_public_token: proposal.publicToken,
        }),
      },
    ]);

    if (input.allowCoFoster) {
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "foster_co_foster_allowed",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: session.user.id,
        ...authorOwner,
        payload: validateEventPayload("foster_co_foster_allowed", {
          payload_version: 1,
          allow_co_foster: true,
          foster_ownership_id: fosterOwnership.id,
        }),
      });
    }

    // 8. DECREMENT volunteer slots (D16)
    const newSlots = volunteer.availableSlots - 1;
    await tx.update(fosterVolunteers).set({
      availableSlots: newSlots,
      updatedAt: now,
    }).where(eq(fosterVolunteers.id, volunteer.id));

    // 9. D18 cascade auto-cancel si newSlots === 0
    const cascadeCancelled: string[] = [];
    if (newSlots === 0) {
      const toCancel = await tx.query.fosterProposals.findMany({
        where: and(
          eq(fosterProposals.volunteerUserId, session.user.id),
          eq(fosterProposals.status, "pending"),
          ne(fosterProposals.id, proposal.id),
        ),
      });
      for (const p of toCancel) {
        await tx.update(fosterProposals).set({
          status: "cancelled",
          cancelledAt: now,
          cancelledByUserId: session.user.id,
          cancellationReason: "volunteer_accepted_another",
          updatedAt: now,
        }).where(eq(fosterProposals.id, p.id));

        await tx.insert(petEvents).values({
          petId: p.petId,
          eventType: "foster_proposal_cancelled",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: session.user.id,
          ...authorOwner,
          payload: validateEventPayload("foster_proposal_cancelled", {
            payload_version: 1,
            proposal_public_token: p.publicToken,
            cancellation_reason: "volunteer_accepted_another",
            auto_cancelled: true,
          }),
        });

        // Notify the affected org
        await notifyOrgWithCapability(tx, p.organizationId, "foster.assign", {
          notificationType: "foster_proposal_auto_cancelled_org",
          severity: "info",
          title: `Tu propuesta de tránsito a ${pet.name} fue auto-cancelada`,
          body: `El voluntario aceptó otra propuesta y ya no tiene slots disponibles.`,
          ctaUrl: `/org/${p.organizationId}/voluntarios/propuestas`,
        });

        cascadeCancelled.push(p.publicToken);
      }
    }

    // 10. Notify org of acceptance
    await notifyOrgWithCapability(tx, proposal.organizationId, "foster.assign", {
      notificationType: "foster_proposal_accepted_org",
      severity: "success",
      title: `${session.user.displayName} aceptó tu propuesta de tránsito`,
      body: `Mascota: ${pet.name}. Coordiná el handoff directamente.`,
      ctaUrl: `/org/${proposal.organizationId}/voluntarios/propuestas/${proposal.publicToken}`,
    });

    return {
      fosterOwnershipId: fosterOwnership.id,
      remainingSlots: newSlots,
      cascadeCancelledProposals: cascadeCancelled,
    };
  });
}
```

**`rejectFosterProposalAction`** — más simple. Validar ownership, UPDATE status, emit event, notify org.

**`cancelFosterProposalAction`** — org cancela su propia propuesta pending.

**`searchFosterVolunteers`** — read action. Filtros + ordenamiento por matchScore + slots > 0 + acceptedCount DESC + LIMIT 50.

#### Paso C.3 — `lib/foster-matching.ts`

```ts
export type MatchScoreResult = {
  score: number;
  warnings: MatchWarning[];
};

export type MatchWarning = {
  kind: "species_mismatch" | "size_mismatch" | "age_mismatch" | "health_mismatch" | "ppp_mismatch" | "duration_mismatch";
  message: string;
};

export function computeMatch(
  pet: {
    species: "dog" | "cat" | "other";
    estimatedWeightKg?: number;
    ageMonths?: number;
    isPpp: boolean;
    hasChronic?: boolean;
  },
  volunteer: FosterVolunteer,
  proposedDurationWeeks?: number,
): MatchScoreResult {
  const warnings: MatchWarning[] = [];
  let score = 100;

  // Species
  if (pet.species === "dog" && !volunteer.acceptsDogs) {
    warnings.push({ kind: "species_mismatch", message: "El voluntario no acepta perros." });
    score -= 30;
  }
  if (pet.species === "cat" && !volunteer.acceptsCats) {
    warnings.push({ kind: "species_mismatch", message: "El voluntario no acepta gatos." });
    score -= 30;
  }
  if (pet.species === "other" && !volunteer.acceptsOtherSpecies) {
    warnings.push({ kind: "species_mismatch", message: "El voluntario no acepta otras especies." });
    score -= 30;
  }

  // Size (solo aplica si especie es perro)
  if (pet.species === "dog" && pet.estimatedWeightKg) {
    const isLarge = pet.estimatedWeightKg > 25;
    const isMedium = pet.estimatedWeightKg >= 10 && pet.estimatedWeightKg <= 25;
    const isSmall = pet.estimatedWeightKg < 10;
    if (isLarge && !volunteer.acceptsSizeLarge) {
      warnings.push({ kind: "size_mismatch", message: `El voluntario no acepta tamaño grande (${pet.estimatedWeightKg}kg).` });
      score -= 15;
    }
    if (isMedium && !volunteer.acceptsSizeMedium) {
      warnings.push({ kind: "size_mismatch", message: `El voluntario no acepta tamaño medio (${pet.estimatedWeightKg}kg).` });
      score -= 15;
    }
    if (isSmall && !volunteer.acceptsSizeSmall) {
      warnings.push({ kind: "size_mismatch", message: `El voluntario no acepta tamaño chico (${pet.estimatedWeightKg}kg).` });
      score -= 15;
    }
  }

  // Age
  if (pet.ageMonths !== undefined) {
    if (pet.ageMonths < 4 && !volunteer.acceptsPuppies) {
      warnings.push({ kind: "age_mismatch", message: "El voluntario no acepta cachorros (<4 meses)." });
      score -= 15;
    }
    if (pet.ageMonths > 84 /* 7 años */ && !volunteer.acceptsSeniors) {
      warnings.push({ kind: "age_mismatch", message: "El voluntario no acepta seniors (>7 años)." });
      score -= 10;
    }
  }

  // Health
  if (pet.hasChronic && !volunteer.acceptsChronicConditions) {
    warnings.push({ kind: "health_mismatch", message: "El voluntario no acepta condiciones crónicas." });
    score -= 15;
  }

  // PPP
  if (pet.isPpp && !volunteer.acceptsDangerousBreeds) {
    warnings.push({ kind: "ppp_mismatch", message: "El voluntario no marcó aceptar razas PPP." });
    score -= 20;
  }

  // Duration
  if (proposedDurationWeeks && volunteer.maxDurationWeeks
      && proposedDurationWeeks > volunteer.maxDurationWeeks) {
    warnings.push({
      kind: "duration_mismatch",
      message: `Duración propuesta (${proposedDurationWeeks}w) excede el máximo del voluntario (${volunteer.maxDurationWeeks}w).`,
    });
    score -= 10;
  }

  return { score: Math.max(0, score), warnings };
}
```

#### Paso C.4 — Extender `endFosterAction`

En `app/actions/foster.ts`:

1. Extender el Zod schema de `foster_ended.payload.reason` con el catálogo del spec §6.9:

```ts
const fosterEnded = z.object(
  withVersion({
    foster_user_id: z.string().uuid(),
    reason: z.enum([
      "returned",                   // A — devolución normal (selectable UI)
      "early_return_by_foster",     // B — el foster pide cortar antes (selectable UI)
      "pet_died",                   // C — auto-cerrado al recordar muerte (programmatic)
      "lost_unrecovered",           // D.2 — perdido sin recuperación >30d (selectable UI)
      "adoption",                   // Flow 7 — programmatic ONLY (NO selectable UI)
      "other",                      // selectable UI (catch-all)
    ]),
    notes: z.string().nullable().optional(),
    death_event_id: z.string().uuid().nullable().optional(),  // solo para reason='pet_died'
  }),
).strict();
```

**Patrón canónico — `'adoption'` reason NO es UI-selectable.** Confirmado por:
- `docs/org-portal-plan.md:738` — "If a foster ownership row is active for the pet, update its `ended_at` and insert a `foster_ended` event with `reason='adoption'`."
- `dim-interno:docs/archive/org-portal-prompt.md:178` (prompt histórico archivado) — "A 'Cerrar tránsito' action on each active foster row opens a modal asking for `reason` (radio: `returned | escalated | other`; `adoption` is not selectable here because it only happens via Flow 7)."

**Implicación operativa para este plan:**
- El **dropdown UI del endFosterAction** ofrece sólo: `returned`, `early_return_by_foster`, `lost_unrecovered`, `other`. **Omite** `adoption` y `pet_died`.
- `adoption` se emite SOLAMENTE desde `finalizeAdoptionAction` (Flow 7 composite, dentro de la transacción atómica que también crea el `adoption_finalized` event y flippea el ownership).
- `pet_died` se emite SOLAMENTE desde `recordDeathAction` (extensión de Paso C.5).
- El Zod schema acepta los 6 valores; el guardrail UI vive en el dropdown del componente.

2. Después del commit del `endFosterAction`, agregar slots prompt:

```ts
// Post-commit: si el volunteer quedó con availableSlots=0, ofrecer re-enroll
const volunteer = await db.query.fosterVolunteers.findFirst({
  where: eq(fosterVolunteers.userId, fosterUserId),
});
if (volunteer && volunteer.availableSlots === 0) {
  await db.insert(notifications).values({
    userId: fosterUserId,
    notificationType: "foster_volunteer_reenroll_prompt",
    severity: "info",
    title: `Tu tránsito con ${pet.name} terminó`,
    body: "¿Querés volver al pool y recibir nuevas propuestas?",
    ctaLabel: "Inscribirme de nuevo",
    ctaUrl: "/cuenta/ofrecerme-como-tránsito",
    relatedPetId: pet.id,
    createdAt: new Date(),
  });
}
```

#### Paso C.5 — Extender `recordDeathAction`

En `app/actions/events.ts` (o donde viva el death recording), dentro del transaction:

```ts
// Después del INSERT death_recorded event:
const activeFosters = await tx.query.ownerships.findMany({
  where: and(
    eq(ownerships.petId, pet.id),
    eq(ownerships.role, "foster"),
    isNull(ownerships.endedAt),
  ),
});

for (const fosterRow of activeFosters) {
  // Auto-close
  await tx.update(ownerships).set({
    endedAt: now,
  }).where(eq(ownerships.id, fosterRow.id));

  // Emit foster_ended
  await tx.insert(petEvents).values({
    petId: pet.id,
    eventType: "foster_ended",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: session.user.id,
    authorRole: "owner",  // or shelter if action came from org
    authorOrganizationId: null,
    payload: validateEventPayload("foster_ended", {
      payload_version: 1,
      foster_user_id: fosterRow.ownerUserId!,
      reason: "pet_died",
      death_event_id: deathEventId,
    }),
  });

  // Notify org
  // Notify foster (cuidado: lenguaje no judgmental)
}
```

#### Paso C.6 — Extender `finalizeAdoptionAction`

En `app/actions/adoption.ts`, agregar parámetro opcional `adopterUserId?: string`:

```ts
export async function finalizeAdoptionAction(input: {
  orgToken: string;
  petPublicToken: string;
  postAdoptionFollowupMonths: number;
  // existing fields for the manual flow
  adopterDni?: string;
  adopterFullName?: string;
  adopterPhone?: string;
  // NEW: shortcut from foster (§15.1)
  adopterUserId?: string;
}) {
  // ...
  if (input.adopterUserId) {
    // Skip DNI lookup, skip stub creation. Validate user is owner + dniVerified.
    const adopter = await tx.query.profiles.findFirst({
      where: eq(profiles.id, input.adopterUserId),
    });
    if (!adopter || adopter.role !== "owner" || adopter.accountType !== "personal"
        || !adopter.dniVerified) {
      return { error: "El usuario foster no cumple las condiciones para adopción directa" };
    }
    // Use adopter.id como adopterUserId final
  } else {
    // Existing DNI lookup path
  }
  // resto del flow idéntico
}
```

#### Paso C.7 — Cron de expiración (reuso del patrón existente)

**Patrón canónico**: copiar la forma de `app/api/cron/close-rabies-observations/route.ts` y `app/api/cron/materialize-slots/route.ts`. Thin route que valida `CRON_SECRET` y delega a un helper en `lib/`. La lógica transaccional vive 100% en el helper.

##### C.7.a — Helper transaccional en `lib/foster-proposal-expirer.ts`

```ts
// lib/foster-proposal-expirer.ts
// Expires foster_proposals with status='pending' AND expires_at < now.
// Patrón mirror de lib/rabies-observation-closer.ts.

import { db } from "@/db/client";
import { fosterProposals, petEvents, notifications, organizationMemberships, organizationCapabilityGrants } from "@/db/schema";
import { and, eq, lt, isNull, ne } from "drizzle-orm";
import { validateEventPayload } from "@/lib/event-schemas";

export type ExpireFosterProposalsStats = {
  candidates: number;
  expired: number;
  errors: number;
};

export async function expireFosterProposals(): Promise<ExpireFosterProposalsStats> {
  const now = new Date();
  const candidates = await db.query.fosterProposals.findMany({
    where: and(
      eq(fosterProposals.status, "pending"),
      lt(fosterProposals.expiresAt, now),
    ),
  });

  let expired = 0;
  let errors = 0;

  for (const p of candidates) {
    try {
      await db.transaction(async (tx) => {
        // Defense-in-depth: re-check status inside the tx (anti-race con accept)
        const fresh = await tx.query.fosterProposals.findFirst({
          where: eq(fosterProposals.id, p.id),
        });
        if (!fresh || fresh.status !== "pending") return;

        await tx.update(fosterProposals).set({
          status: "expired",
          updatedAt: now,
        }).where(eq(fosterProposals.id, p.id));

        await tx.insert(petEvents).values({
          petId: p.petId,
          eventType: "foster_proposal_expired",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: p.proposedByUserId, // attribution to the proposer
          authorRole: "system",
          authorOrganizationId: p.organizationId,
          authorVerified: false,
          payload: validateEventPayload("foster_proposal_expired", {
            payload_version: 1,
            proposal_public_token: p.publicToken,
          }),
        });

        // Notify volunteer
        await tx.insert(notifications).values({
          userId: p.volunteerUserId,
          notificationType: "foster_proposal_expired",
          severity: "info",
          title: "Una propuesta de tránsito expiró",
          body: "La propuesta que recibiste expiró sin respuesta. Si te interesa, pedile al refugio que vuelva a proponer.",
          relatedPetId: p.petId,
          createdAt: now,
        });

        // Notify org members with foster.assign capability
        await notifyOrgMembersWithCapability(tx, p.organizationId, "foster.assign", {
          notificationType: "foster_proposal_expired",
          severity: "info",
          title: "Tu propuesta de tránsito expiró",
          body: "El voluntario no respondió en 7 días. Probá con otro candidato del pool.",
          relatedPetId: p.petId,
          createdAt: now,
        });
      });
      expired += 1;
    } catch (err) {
      console.error("[expireFosterProposals] failed for", p.id, err);
      errors += 1;
    }
  }

  return { candidates: candidates.length, expired, errors };
}
```

##### C.7.b — Thin route `app/api/cron/expire-foster-proposals/route.ts`

**Copy literal del shape de `close-rabies-observations/route.ts`**, ajustando el import:

```ts
import { type NextRequest, NextResponse } from "next/server";

import { expireFosterProposals } from "@/lib/foster-proposal-expirer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;
  const incoming = req.headers.get("x-cron-secret");

  if (cronSecret) {
    if (incoming !== cronSecret) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured in production" },
      { status: 401 },
    );
  } else {
    console.warn("[cron/expire-foster-proposals] CRON_SECRET not set — allowing request in non-production");
  }

  const start = Date.now();
  try {
    const stats = await expireFosterProposals();
    return NextResponse.json({
      ok: true,
      ...stats,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    console.error("[cron/expire-foster-proposals] failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
```

##### C.7.c — Vercel cron config en `vercel.json`

Agregar entrada al array existente de `crons`:

```json
{ "path": "/api/cron/expire-foster-proposals", "schedule": "0 3 * * *" }
```

Schedule diario a las 3 AM UTC (paralelo a otros crons existentes; conviene staggear si crecen, en v1 alcanza con `0 3 * * *`).

##### C.7.d — Integración futura con admin page Fase 14

El plan `docs/superpowers/plans/2026-05-18-admin-page-fases-10-14.md` introduce `/api/cron/auto-expire-approvals` (Fase 14) con tabla `cron_runs` para auditar runs.

**Cuando esa Fase 14 lande**, el handler unificado puede llamar a `expireFosterProposals()` del helper en la misma ejecución, y la route `/api/cron/expire-foster-proposals` puede deprecarse (delete o redirect 301). El helper queda intacto — la separación helper-vs-route es justo para esto.

**No bloquea este plan**. Buildeamos el cron ahora con el patrón existente; la unificación es refactor trivial cuando admin page Fase 14 esté disponible.

##### C.7.e — Tests del cron

`lib/foster-proposal-expirer.test.ts`:
- Happy: 3 propuestas con `expires_at < now AND status='pending'` → todas marked `expired`, 3 events emitidos, 6 notifs (volunteer + org member).
- Idempotency: correr 2x con un solo candidate → 2do run no hace nada (la 2da query no encuentra `status='pending'`).
- Race resistance: setup con 1 proposal pending; mockear que entre el SELECT inicial y el UPDATE del tx, el status cambió a 'accepted' → el defense-in-depth check skipea esa fila.
- Empty: 0 candidates → returns `{ candidates: 0, expired: 0, errors: 0 }`.

`app/api/cron/expire-foster-proposals/route.test.ts`:
- 401 sin header.
- 401 con header incorrecto.
- 200 con header correcto.
- Mockear el helper para test del happy/error path del route.

#### Paso C.8 — RLS policies

Crear `db/foster_rls.sql` (o agregar al RLS existente):

```sql
alter table public.foster_volunteers enable row level security;
alter table public.foster_proposals enable row level security;

-- foster_volunteers SELECT policies (spec §8)
create policy "fv select own" on public.foster_volunteers for select
  using (user_id = auth.uid());

create policy "fv select active pool by org" on public.foster_volunteers for select
  using (
    status = 'active' and available_slots > 0
    and exists (
      select 1 from public.organization_memberships om
      join public.organization_capability_grants ocg
        on ocg.organization_id = om.organization_id
      where om.user_id = auth.uid()
        and om.left_at is null
        and ocg.capability = 'foster.assign'
        and ocg.revoked_at is null
    )
  );

create policy "fv select admin" on public.foster_volunteers for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );

-- foster_proposals SELECT policies
create policy "fp select volunteer" on public.foster_proposals for select
  using (volunteer_user_id = auth.uid());

create policy "fp select org members" on public.foster_proposals for select
  using (
    exists (
      select 1 from public.organization_memberships om
      where om.user_id = auth.uid()
        and om.organization_id = foster_proposals.organization_id
        and om.left_at is null
    )
  );

create policy "fp select admin" on public.foster_proposals for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );

-- NO INSERT/UPDATE policies. All writes go through server actions
-- (which use service_role bypassing RLS for the controlled mutations).
```

Aplicar via Supabase Studio.

#### Paso C.9 — Tests Fase C

Por action:
- `foster-volunteers.test.ts`: enroll happy path, enroll 2x suma slots, withdraw + cancel pending, D13 pre-condition fails.
- `foster-proposals.test.ts`:
  - propose happy
  - propose con co-foster check OK / con co-foster check FAIL
  - propose con volunteer sin slots → error
  - accept happy + slots decrement + cascade D18 (con setup: 3 propuestas pending al mismo volunteer con slots=1)
  - accept con allowCoFoster=true emite el extra event
  - reject + notification
  - cancel
- `foster-matching.test.ts`: scoring cases (perfect, all mismatches, partial).
- Test extendido de `recordDeathAction`: muere con foster activo → foster_ended auto + correct payload.
- Test extendido de `finalizeAdoptionAction`: con `adopterUserId` set → skip DNI lookup; con eligibility=false → block.
- Test del cron: propuesta con expires_at < now → expired + events emitted.

**Criterio de PR para Fase C**: todos los actions verdes, cron testeado en local con header secret. RLS aplicada. Tests integración del flow propose→accept→cascade pasan.

---

### Fase D — UI surfaces

**Output**: feature usable end-to-end. 1 PR (grande pero todos archivos UI).

Lista de pages/components a crear con archivo + objetivo. Detalles de layout están en §6 del spec — usar como referencia.

#### Paso D.1 — Entry-point card en `/cuenta`

Editar `app/(app)/cuenta/page.tsx`. Agregar component `<FosterVolunteerCard />` que:

- Lee `foster_volunteers` del session user (server component).
- Renderiza uno de los 3 estados del spec §6.1:
  - **No inscripto**: card "¿Querés ofrecerte como hogar de tránsito?" + CTA "Ofrecerme como voluntario".
  - **Inscripto, slots > 0**: "Sos voluntario · X propuestas activas · Y slot(s)".
  - **Inscripto, slots = 0**: 2 variants según hay foster activo o no.

Archivo nuevo: `app/(app)/cuenta/components/FosterVolunteerCard.tsx`.

#### Paso D.2 — Inscripción `/cuenta/ofrecerme-como-tránsito`

Crear `app/(app)/cuenta/ofrecerme-como-tránsito/page.tsx`.

Server component que primero corre el **pre-check D13**:

```tsx
const profile = await getProfile(session.user.id);
const checks = {
  hasAccount: true,
  dniVerified: profile.dniVerified,
  hasDisplayName: !!profile.displayName?.trim(),
  hasPhone: !!profile.phone?.trim(),
  isOwnerRole: profile.role === "owner" && profile.accountType === "personal",
};

if (!Object.values(checks).every(Boolean)) {
  return <PreCheckChecklist checks={checks} />;
}

const existing = await db.query.fosterVolunteers.findFirst(...);
return <FosterVolunteerForm initial={existing} />;
```

Components:
- `PreCheckChecklist.tsx` — render checklist + CTAs específicos (verificar DNI, agregar nombre, agregar teléfono).
- `FosterVolunteerForm.tsx` — form completo del spec §6.1, con PPP disclaimer condicional al check + "Guardar y activar" / "Guardar y pausar" actions.

#### Paso D.3 — `/cuenta/transitos/propuestas`

Lista de propuestas dirigidas al volunteer, separadas en "Activas" y "Historial".

Files:
- `app/(app)/cuenta/transitos/propuestas/page.tsx` — server component, queries.
- `app/(app)/cuenta/transitos/propuestas/[proposalToken]/page.tsx` — detail con `[Aceptar] [Rechazar]` y el modal de aceptación con checkbox D17.
- `components/ProposalCard.tsx`, `components/AcceptProposalModal.tsx`, `components/RejectProposalModal.tsx`.

El modal de Accept tiene el checkbox D17:

```tsx
<Checkbox
  checked={allowCoFoster}
  onCheckedChange={setAllowCoFoster}
  label="Permito que la org asigne otro co-foster a este pet mientras yo lo cuide"
/>
```

Submit llama `acceptFosterProposalAction({ proposalPublicToken, allowCoFoster, responseNotes })`. UI mensaje tras éxito incluye `remainingSlots` y `cascadeCancelledProposals` (si hubo) — "Aceptaste el tránsito de X. Te quedan N slots. Y propuestas pendientes se cancelaron porque ya no tenías capacity."

#### Paso D.4 — `/cuenta/transitos/activos`

Lista de fosters activos del volunteer.

Files:
- `app/(app)/cuenta/transitos/activos/page.tsx`.
- `app/(app)/cuenta/transitos/activos/[petToken]/page.tsx` — detail con shortcut a libreta sanitaria, weight, etc. **Reusa** las cards/components existentes de `/mis-mascotas/[token]` porque las capacidades del foster son las mismas (D15). Toggle co-foster (`setCoFosterAllowedAction`) + botón "Pedir devolución anticipada" (abre form §6.9-B).

#### Paso D.5 — `/cuenta/transitos/historial`

Lista de fosters terminados + propuestas rechazadas/expiradas. Sólo lectura.

File: `app/(app)/cuenta/transitos/historial/page.tsx`.

#### Paso D.6 — `/org/[orgToken]/voluntarios` (browse pool)

Pool listing con filtros + search.

Files:
- `app/(app)/org/[orgToken]/voluntarios/page.tsx`.
- `components/VolunteersFilterBar.tsx`.
- `components/VolunteerRow.tsx` (con notes visible + count aceptadas + slots badge + botón "Proponer tránsito").
- `components/ProposeFosterModal.tsx` — pet selector (dropdown de pets en shelter_custody) + duración + notes + match warnings calculados en tiempo real.

Server component para la query; client component para los filters (URL-driven, mismo patrón que `/adoptar`).

#### Paso D.7 — `/org/[orgToken]/voluntarios/propuestas`

Tabla de propuestas que la org emitió, con filtros por status.

Files:
- `app/(app)/org/[orgToken]/voluntarios/propuestas/page.tsx`.
- `app/(app)/org/[orgToken]/voluntarios/propuestas/[proposalToken]/page.tsx` — detail con botón "Cancelar" si pending.

#### Paso D.8 — `/org/[orgToken]/transitos` (surface unificado §6.3)

Tabla de pets en foster activo de la org (independiente del path: pool, member-based, vecino).

Files:
- `app/(app)/org/[orgToken]/transitos/page.tsx`.
- Calcular "tipo" de foster server-side: presencia de `foster_proposals.resolved_ownership_id` linkando → "Voluntario pool"; foster es member → "Member"; ninguno → "Vecino-tránsito".

**UI guardrail del "Finalizar tránsito"** (per decisión 3 del review): el modal de cerrar tránsito tiene dropdown de `reason` con **solo 4 opciones**: `returned` ("Devolución normal"), `early_return_by_foster` ("Devolución anticipada por el foster"), `lost_unrecovered` ("Perdido sin recuperación"), `other` ("Otro"). **NO incluir `adoption` ni `pet_died`** en el dropdown — son programmatic-only:

```tsx
const SELECTABLE_END_REASONS = [
  { value: "returned", label: "Devolución normal" },
  { value: "early_return_by_foster", label: "Devolución anticipada por el foster" },
  { value: "lost_unrecovered", label: "Perdido sin recuperación" },
  { value: "other", label: "Otro (especificar en notas)" },
] as const;
// 'adoption' → emitted by finalizeAdoptionAction (Flow 7)
// 'pet_died' → emitted by recordDeathAction
```

#### Paso D.9 — `/org/[orgToken]/pets/no-aptas`

Listado especial §17.6.

Files:
- `app/(app)/org/[orgToken]/pets/no-aptas/page.tsx` — agrupado por `ineligible_reason`.
- Component que muestra "Re-evaluación vencida" cuando `ineligible_until < now`.

#### Paso D.10 — UI eligibility card en pet detail

En `app/(app)/org/[orgToken]/mascotas/[petToken]/page.tsx`, agregar `<AdoptionEligibilityCard pet={pet} />`:

- Muestra estado actual (apta/no apta/sin determinar).
- Botón "Cambiar a no apta" / "Marcar como apta" / "Editar motivo".
- Modal con form (dropdown razón + textarea + date picker para `ineligible_until`).
- Submit llama `setAdoptionEligibilityAction`.

#### Paso D.11 — Shortcut adopción a foster actual (§15.1)

En el pet detail de la org, cuando el pet tiene foster activo del pool:

```tsx
{hasActiveFosterFromPool && (
  <Button onClick={() => finalizeAdoptionToFoster(fosterUserId)}>
    Finalizar adopción al foster actual ({fosterDisplayName})
  </Button>
)}
```

Llama `finalizeAdoptionAction({ ..., adopterUserId: fosterUserId })`. Modal de confirmación + post-success redirect a `/mis-mascotas`.

#### Paso D.12 — E2E mínimo

Test Playwright (o equivalente) del flow completo:

1. User A se inscribe como voluntario (pool).
2. User B (org coordinator) ve a User A en `/org/[orgToken]/voluntarios`.
3. User B propone foster de Pet X a User A.
4. User A acepta en `/cuenta/transitos/propuestas/[token]`.
5. Verifica que Pet X aparece en `/cuenta/transitos/activos` de A y `/org/[orgToken]/transitos` de B.
6. User B finaliza adopción usando shortcut → Pet X aparece en `/mis-mascotas` de A.

**Criterio de PR para Fase D**: todas las páginas accesibles desde la UI principal, E2E verde, manual smoke pass.

---

## 5. Tests de integración cross-fase

Después de cada fase, correr la suite completa:

```bash
pnpm test
pnpm rls:smoke
pnpm typecheck
pnpm lint
```

Específicamente importante después de Fase C:

- Test "cascade D18": setup con volunteer `availableSlots=1` y 3 propuestas pending de 3 orgs distintas. Volunteer acepta una. Verificar:
  - La aceptada está `status='accepted'` con `resolved_ownership_id` set.
  - Las otras 2 están `status='cancelled'` con `cancellation_reason='volunteer_accepted_another'`.
  - 2 events `foster_proposal_cancelled` con `auto_cancelled=true`.
  - 2 notifications a las orgs afectadas.
  - `available_slots` final = 0.

- Test "co-foster": setup con foster activo `allow_co_foster=false`. Intentar propose → error claro. Cambiar a `allow_co_foster=true` (via `setCoFosterAllowedAction`). Propose → OK.

- Test "death cascade": setup con foster activo. Emit `death_recorded`. Verificar que el `foster_ended` se emitió con `reason='pet_died'` y `death_event_id` set.

## 6. Notas de implementación

- **Token generation** (`FP-XXXX-XXXX`): patrón existente en `lib/tokens.ts` (mismo que `pets.public_token = DIM-...`). Reusar el generador.
- **Advisory lock en accept**: usar `pg_advisory_xact_lock(hashtext(proposal.id))` al inicio del transaction para serializar accept del mismo proposal (anti double-click race). Patrón ya usado en scheduling.
- **`notifyOrgWithCapability` helper**: probablemente ya existe en `lib/notifications.ts`. Si no, crearlo — busca `organization_capability_grants` con la capability + JOIN `organization_memberships` activos.
- **`resolveAuthorship`** ya existe en `lib/event-authorship.ts`. Usar siempre.
- **No emitir `pet_events` por cambios en `foster_volunteers`** (D2/D16): la tabla cambia, los notifications se mandan, pero NO genera pet event (no hay pet involucrado en la inscripción al pool).
- **Snapshot de `match_warnings`** al propose-time: el voluntario puede cambiar sus preferences entre propose y response, pero la propuesta refleja el match al momento de proponer (snapshot en `foster_proposals.match_warnings` jsonb).
- **Unlock de contact info** post-accept: a nivel UI, en `/cuenta/transitos/activos/[petToken]/page.tsx` y `/org/[orgToken]/voluntarios/propuestas/[token]/page.tsx`, mostrar email + phone de la otra parte. Server queries leen explícitamente esos campos solo cuando proposal.status='accepted'.
- **Naming**: rutas en español (`/cuenta/transitos/`, `/voluntarios/`, `/no-aptas/`). Código en inglés (`fosterVolunteers`, `proposalToken`, etc.).
- **Migrations applied via Studio**, NO via `pnpm db:push` (el repo tiene la convención por RLS no modeladas en Drizzle).

## 7. Out-of-scope reminder

Si durante implementación emerge algo de la lista §12 del spec, NO agregar al PR. Crear issue/follow-up. Esto incluye:

- Volunteer-initiated browse.
- Volunteer-requested proposals.
- Auto-matching.
- Tariff / fosters pagos.
- Score reputacional bidireccional.
- Visita domiciliaria.
- Multi-pet por propuesta.
- Visibility a govts.
- Email transaccional.
- Cron de auto-cancel time-bomb adicional.

## 8. Done criteria

PR final tiene:
- [x] 3 migraciones SQL aplicadas y documentadas.
- [x] 9 server actions nuevas + 4 extendidas con tests.
- [x] `lib/foster-matching.ts` con tests unitarios.
- [x] RLS policies aplicadas.
- [x] Cron `/api/cron/expire-foster-proposals` registrado.
- [x] 10 páginas/rutas nuevas, navegables desde `/cuenta` y `/org/[orgToken]`.
- [x] E2E test del happy path completo verde.
- [x] `pnpm test && pnpm rls:smoke && pnpm typecheck && pnpm lint` todo verde.
- [x] README de superpowers actualizado marcando este plan como ✅ Implementado.
- [x] `AGENTS.md` actualizado en sección Event catalog si aplica (los 7 nuevos event types).

---

## Próximo paso

Ejecución en 4 PRs secuenciales (A → B → C → D). Si el alcance de D resulta demasiado grande, partirlo en D-volunteer (D.1-D.5) y D-org (D.6-D.11) sin que rompa el contrato.
