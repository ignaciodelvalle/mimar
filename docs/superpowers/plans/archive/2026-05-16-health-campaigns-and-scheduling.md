# Health campaigns and scheduling — implementation plan

> Plan ejecutable para Claude Code. Diez fases que implementan el sistema completo de scheduling veterinario: orgs y vets independientes solicitan permiso → govt/admin aprueba (por scope) → orgs y vets publican agenda recurrente → cron materializa slots → owners buscan y reservan → asistencia emite el evento médico que cae en la libreta sanitaria. La opción de "agendar como recordatorio personal" se preserva en paralelo. Las fases son secuencialmente dependientes; Fase 10 (polish) es opcional.
>
> **Fecha:** 2026-05-17 (rewrite del plan, alineado al spec v2.1)
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~8 PRs chicos, ~25 archivos nuevos, ~5 archivos tocados, 1 migración SQL
> **Estimación total:** 2 semanas

---

## 0. Antes de tocar nada

Lectura obligatoria:

1. **`docs/superpowers/specs/2026-05-16-health-campaigns-and-scheduling-design.md`** (v2.1) — el spec del feature. Toda decisión de producto está justificada ahí
2. **`AGENTS.md → Libreta sanitaria`** — los eventos médicos emitidos en `markAppointmentAttendedAction` son libreta-sanitaria events (vaccination_administered, sterilization_performed, etc.), ya en `LIBRETA_SANITARIA_EVENT_TYPES`
3. **`AGENTS.md → Organizations`** — orgs con `verified=true`, capability system, memberships. Vas a agregar dos capabilities nuevas (`service_offering.create`, `appointment.manage`)
4. **`lib/event-schemas.ts`** — patrón Zod estricto con `payload_version`. Los events de asistencia (vaccination_administered, etc.) ya tienen schema; el payload del form de atención debe pasar por `validateEventPayload` antes del insert
5. **`lib/capabilities.ts`** — sistema actual de capabilities. Extender con las nuevas
6. **`app/actions/intake.ts`** y **`app/actions/transfer.ts`** — patterns existentes de server actions con `requireCapability` + transacciones atómicas. Seguir mismo estilo
7. **`app/org/[orgToken]/page.tsx`** — el portal org actual. Vas a agregar links de "Servicios" y "Agenda" en el dashboard
8. **`app/(app)/mis-mascotas/[publicToken]/vacunas/programar/page.tsx`** — el flujo actual de "Programar vacuna". En Fase 7 se modifica mínimamente para agregar link al search
9. **`db/schema.ts`** — Drizzle models. Vas a agregar 4 tablas + extender `reminders` con FK
10. **`db/migrations/0000_orgs_foundation.sql`** — patrón de migración (idempotent, comments, etc.)

**Una decisión locked importante (D8 del spec):** este feature NO depende de admin page Fase 0. Usa su propio status field en `service_offerings`. Cuando admin page Fase 0 mergee, hay una migración trivial para unificar; pero hoy no bloqueamos en eso.

## 1. Qué construye este plan

Ocho fases secuenciales:

**Fase 0 — Schema foundation.** Migración SQL con 4 tablas (`service_offerings` polymorphic + `service_schedule_rules`, `time_slots`, `appointments`) + extensión de `reminders` con FK. Drizzle models. RLS básica. Capability registry extendido.

**Fase 1 — Approval workflow (org side).** Server actions: `createServiceOfferingAction`, `approveServiceOfferingAction`, `rejectServiceOfferingAction`. Routes en `/org/[orgToken]/servicios` para gestión org.

**Fase 1.5 — Approval routing: govt + admin fallback.** El `createServiceOfferingAction` lookupa govts cuya scope cubre la `jurisdiction_locality` del offering. Notifica al govt cubriente vía `/gob/servicios`; fallback a admins vía `/admin/servicios` si no hay govt covering. Reemplaza el "notify all admins" del v2.0.

**Fase 2 — Schedule rules.** CRUD de `service_schedule_rules` desde `/org/[orgToken]/servicios/{token}/agenda`. Server actions atómicas.

**Fase 2.5 — sub-rutas `/pro/servicios` + `/pro/agenda` para vet independientes con capability `professional.provider`.** Mirror reducido de la org-side: `/pro/servicios`, `/pro/servicios/nuevo`, `/pro/servicios/{token}`, `/pro/servicios/{token}/agenda`, `/pro/agenda`. Mismo form que org-side, ownership `provider_user_id` en lugar de `organization_id`. Estas sub-rutas se agregan al portal `/pro` existente — no son un portal separado.

**Fase 3 — Slot materialization.** Script `scripts/materialize-slots.ts` + cron route `/api/cron/materialize-slots`. Botón "Materializar ahora" para preview inmediato.

**Fase 4 — Owner search + book.** Rutas `/turnos/buscar`, `/mis-turnos`, `/mis-turnos/{token}`. `bookSlotAction` con advisory lock + constraint DB para race conditions. Search results distinguen entre offering de org (muestra org name + logo) y offering de vet independiente (muestra "Dr/a. {first name}" + matrícula).

**Fase 5 — Org booking + attendance.** Dashboard `/org/[orgToken]/agenda` con bookings del día. `markAppointmentAttendedAction` con form específico por service_kind. `markAppointmentNoShowAction`, `cancelAppointmentByOrgAction`.

**Fase 6 — Owner cancellation.** `cancelAppointmentByOwnerAction` con liberación de slot capacity.

**Fase 7 — Integration con form existente.** Link en `/mis-mascotas/{token}/vacunas/programar` apuntando a `/turnos/buscar?service_kind=...`. Sección "Próximas vacunas" del pet profile muestra reminders puros + con appointment mezclados.

**Fase 8 — Vet independiente attendance.** `/pro/agenda` con bookings del día del vet. `markAppointmentAttendedAction` vía `/pro/agenda/turnos/{token}`.

**Fase 9 — Govt / admin approval UI.** Pages de review en `/gob/servicios` y `/admin/servicios`. Fallback queue visible al admin.

**Fase 10 — Polish (opcional).** 24h reminder cron, logos en search, filtros extra.

## 2. Decisiones cerradas (resumen del spec)

| # | Decisión | Sección spec |
|---|---|---|
| D1 | Provider polymorphic: `organization` verified OR vet personal con `professional.provider` capability. XOR enforced via constraint | §2 D1 |
| D2 | Un service offering = un service_kind. Aprobación granular por servicio | §2 D2 |
| D3 | Confirmación de reserva = instantánea. Sin manual approval mode | §2 D3 |
| D4 | Schedule = reglas semanales recurrentes con campos discretos. NO RRULE | §2 D4 |
| D5 | Slots materializados en ventana móvil de 60 días vía cron | §2 D5 |
| D6 | Appointment es planning artifact mutable, separado del pet_event inmutable | §2 D6 |
| D7 | Ambos flujos coexisten (Reminder solo / Reminder + Appointment) | §2 D7 |
| D8 | Approval state en columna `service_offerings.status`, NO en `approval_requests` | §2 D8 |
| D9 | Owner busca por service_kind + jurisdicción del pet. Sin paginación compleja | §2 D9 |
| D10 | Race resolution: advisory lock + constraint `bookings_count <= capacity` | §2 D10 |
| D11 | Evento médico se emite con el payload del form de atención (vaccine_name, brand, batch, etc.) | §2 D11 |

## 3. Scope

**Dentro:**
- 1 migración SQL agregando 4 tablas + extensión de `reminders`
- ~6 nuevos Zod schemas para validación de forms (NO event payloads — esos ya están en `lib/event-schemas.ts`)
- ~12 server actions nuevas
- ~10 rutas nuevas
- Capability registry extendido con `service_offering.create` y `appointment.manage`
- 1 cron route (materialización)
- 1 script Node (materialización runner)
- Modificación mínima de `/mis-mascotas/{token}/vacunas/programar` (un link)
- Modificación del pet profile para sección "Próximas vacunas" mezclada
- Tests por fase

**Fuera (deferred per spec §13):**
- Tabla `campaigns` separada (price=null + display_name explicativo es suficiente para v1)
- Confirmation modes manual
- Multi-pet booking en un solo slot
- Email transaccional
- Pagos online
- No-show penalty / rate-limit
- Lista de espera
- Cross-org search coordinada
- Bulk attendance
- Appointment rescheduling directo (cancelar + reservar otro)
- RRULE
- Multi-locality coverage en search
- `appointment_attended` event type separado (los events existentes alcanzan)

## 4. Plan paso a paso

### Fase 0 — Schema foundation

#### Paso 0.1 — Migración SQL

Crear `db/migrations/NNNN_scheduling_foundation.sql` (NNNN según orden actual):

```sql
-- Health campaigns and scheduling — foundation
-- Adds service_offerings (with approval status workflow), service_schedule_rules,
-- time_slots, appointments tables. Extends reminders with appointment_id FK.

-- service_offerings: a specific service an org wants to offer
create table if not exists public.service_offerings (
  id                          uuid primary key default gen_random_uuid(),
  public_token                text not null unique,
  organization_id             uuid not null references public.organizations(id) on delete cascade,
  service_kind                text not null,
  display_name                text not null,
  description                 text,
  duration_minutes            int not null default 15,
  slot_capacity               int not null default 1,
  price_ars                   numeric(10, 2),
  eligibility_species         text[],
  eligibility_age_min_months  int,
  eligibility_age_max_months  int,
  status                      text not null default 'pending_approval',
  submitted_at                timestamptz not null default now(),
  reviewed_at                 timestamptz,
  reviewed_by_user_id         uuid references public.profiles(id),
  rejection_reason            text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint service_status_valid
    check (status in ('pending_approval', 'approved', 'rejected', 'paused', 'archived')),
  constraint service_capacity_positive check (slot_capacity > 0),
  constraint service_duration_positive check (duration_minutes > 0)
);

create index if not exists service_offerings_org_idx
  on public.service_offerings (organization_id);
create index if not exists service_offerings_pending_idx
  on public.service_offerings (status, submitted_at) where status = 'pending_approval';
create index if not exists service_offerings_active_search_idx
  on public.service_offerings (service_kind, status) where status = 'approved';

-- service_schedule_rules: weekly recurring availability
create table if not exists public.service_schedule_rules (
  id                  uuid primary key default gen_random_uuid(),
  service_offering_id uuid not null references public.service_offerings(id) on delete cascade,
  days_of_week        smallint[] not null,
  start_time_local    time not null,
  end_time_local      time not null,
  effective_from      date not null,
  effective_until     date,
  timezone            text not null default 'America/Argentina/Buenos_Aires',
  status              text not null default 'active',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint rule_time_window_sane check (end_time_local > start_time_local),
  constraint rule_dates_sane
    check (effective_until is null or effective_until >= effective_from),
  constraint rule_days_nonempty check (array_length(days_of_week, 1) > 0),
  constraint rule_status_valid check (status in ('active', 'paused', 'archived'))
);

create index if not exists schedule_rules_offering_active_idx
  on public.service_schedule_rules (service_offering_id) where status = 'active';

-- time_slots: discrete bookable slots materialized from rules
create table if not exists public.time_slots (
  id                  uuid primary key default gen_random_uuid(),
  service_offering_id uuid not null references public.service_offerings(id) on delete cascade,
  rule_id             uuid references public.service_schedule_rules(id) on delete set null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  capacity            int not null,
  bookings_count      int not null default 0,
  status              text not null default 'open',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint slot_window_sane check (ends_at > starts_at),
  constraint slot_capacity_positive check (capacity > 0),
  constraint slot_bookings_non_negative check (bookings_count >= 0),
  constraint slot_bookings_within_capacity check (bookings_count <= capacity),
  constraint slot_status_valid check (status in ('open', 'full', 'cancelled'))
);

create unique index if not exists time_slots_unique_starts
  on public.time_slots (service_offering_id, starts_at);
create index if not exists time_slots_offering_window_idx
  on public.time_slots (service_offering_id, starts_at) where status = 'open';
create index if not exists time_slots_search_idx
  on public.time_slots (service_offering_id, starts_at) where status in ('open', 'full');

-- appointments: owner bookings
create table if not exists public.appointments (
  id                       uuid primary key default gen_random_uuid(),
  public_token             text not null unique,
  slot_id                  uuid not null references public.time_slots(id) on delete restrict,
  pet_id                   uuid not null references public.pets(id) on delete cascade,
  owner_user_id            uuid not null references public.profiles(id) on delete cascade,
  service_offering_id      uuid not null references public.service_offerings(id),
  organization_id          uuid not null references public.organizations(id),
  status                   text not null default 'confirmed',
  attended_at              timestamptz,
  attended_by_user_id      uuid references public.profiles(id),
  cancelled_at             timestamptz,
  cancelled_by_user_id     uuid references public.profiles(id),
  cancellation_reason      text,
  no_show_marked_at        timestamptz,
  outcome_event_id         uuid references public.pet_events(id),
  reminder_id              uuid references public.reminders(id),
  notes_from_owner         text,
  notes_from_org           text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint appointment_status_valid check (status in (
    'confirmed', 'attended', 'no_show', 'cancelled_by_owner', 'cancelled_by_org'
  )),
  constraint appointment_outcome_only_when_attended
    check ((outcome_event_id is null) or (status = 'attended'))
);

create index if not exists appointments_pet_idx
  on public.appointments (pet_id, created_at desc);
create index if not exists appointments_owner_idx
  on public.appointments (owner_user_id, status);
create index if not exists appointments_org_idx
  on public.appointments (organization_id, status);
create index if not exists appointments_slot_idx
  on public.appointments (slot_id) where status = 'confirmed';

-- reminders extension: appointment_id FK
alter table public.reminders
  add column if not exists appointment_id uuid
  references public.appointments(id) on delete set null;

create index if not exists reminders_appointment_idx
  on public.reminders (appointment_id) where appointment_id is not null;

-- Documentation
comment on table public.service_offerings is
  'Org-submitted service offering. Admin approves via status workflow before org can create slots.';
comment on column public.service_offerings.status is
  'Lifecycle: pending_approval → approved | rejected. After approved: paused / archived by org.';
comment on column public.time_slots.capacity is
  'Snapshot from service_offerings.slot_capacity at materialization. Future re-materialization can change it for slots without bookings.';
comment on column public.appointments.outcome_event_id is
  'Set when status=attended. Links to the emitted pet_event (vaccination_administered, etc.).';

-- Reverse rollback (documented, not executed):
-- alter table public.reminders drop column appointment_id;
-- drop table public.appointments;
-- drop table public.time_slots;
-- drop table public.service_schedule_rules;
-- drop table public.service_offerings;
```

Aplicar vía Supabase Studio (NO `pnpm db:push`).

#### Paso 0.2 — Drizzle models en `db/schema.ts`

Agregar models para las 4 tablas siguiendo el patrón de los existentes (camelCase TS, snake_case SQL). Exportar desde `db/index.ts`.

Tipo de cada uno con `$inferSelect` / `$inferInsert` para uso en server actions.

#### Paso 0.3 — Catálogo de service_kind

Crear `lib/service-kinds.ts`:

```ts
// Catalog of service kinds supported by the scheduling system. Each entry
// maps to the pet_event type emitted on attendance. New kinds added here;
// the emitted_event_type binds the lifecycle to the libreta sanitaria
// constants.

import type { EventType } from "@/db/schema";

export type ServiceKindDef = {
  code: string;
  label: string;                          // es-AR display label
  emitted_event_type: EventType;          // pet_event type emitted on attendance
  default_duration_minutes: number;
  default_eligibility_species?: ("dog" | "cat")[];
};

export const SERVICE_KINDS: readonly ServiceKindDef[] = [
  { code: "vaccination_rabies",        label: "Vacunación antirrábica",       emitted_event_type: "vaccination_administered", default_duration_minutes: 15, default_eligibility_species: ["dog", "cat"] },
  { code: "vaccination_triple_canina", label: "Vacuna triple canina",         emitted_event_type: "vaccination_administered", default_duration_minutes: 15, default_eligibility_species: ["dog"] },
  { code: "vaccination_triple_felina", label: "Vacuna triple felina",         emitted_event_type: "vaccination_administered", default_duration_minutes: 15, default_eligibility_species: ["cat"] },
  { code: "sterilization_dog_male",    label: "Castración perro macho",       emitted_event_type: "sterilization_performed",  default_duration_minutes: 60, default_eligibility_species: ["dog"] },
  { code: "sterilization_dog_female",  label: "Ovariectomía perra",           emitted_event_type: "sterilization_performed",  default_duration_minutes: 90, default_eligibility_species: ["dog"] },
  { code: "sterilization_cat_male",    label: "Castración gato macho",        emitted_event_type: "sterilization_performed",  default_duration_minutes: 45, default_eligibility_species: ["cat"] },
  { code: "sterilization_cat_female",  label: "Ovariectomía gata",            emitted_event_type: "sterilization_performed",  default_duration_minutes: 60, default_eligibility_species: ["cat"] },
  { code: "deworming",                 label: "Desparasitación",               emitted_event_type: "deworming_administered",  default_duration_minutes: 10, default_eligibility_species: ["dog", "cat"] },
  { code: "general_checkup",           label: "Consulta general",              emitted_event_type: "vet_visit_logged",         default_duration_minutes: 30, default_eligibility_species: ["dog", "cat"] },
  { code: "microchip_implantation",    label: "Colocación de microchip",       emitted_event_type: "microchip_implanted",      default_duration_minutes: 15, default_eligibility_species: ["dog", "cat"] },
] as const;

export function findServiceKind(code: string): ServiceKindDef | null {
  return SERVICE_KINDS.find((s) => s.code === code) ?? null;
}
```

#### Paso 0.4 — Form Zod schemas

Crear `lib/scheduling-schemas.ts` con schemas Zod para validar los forms (NO event payloads — esos viven en `lib/event-schemas.ts`):

```ts
import { z } from "zod";

export const CreateServiceOfferingInput = z.object({
  serviceKind: z.string().min(1),
  displayName: z.string().min(3).max(120),
  description: z.string().max(500).nullable(),
  durationMinutes: z.number().int().min(5).max(480),
  slotCapacity: z.number().int().min(1).max(100),
  priceArs: z.number().nonnegative().nullable(),
  eligibilitySpecies: z.array(z.enum(["dog", "cat"])).nullable(),
  eligibilityAgeMinMonths: z.number().int().min(0).max(360).nullable(),
  eligibilityAgeMaxMonths: z.number().int().min(0).max(360).nullable(),
});

export const CreateScheduleRuleInput = z.object({
  serviceOfferingId: z.string().uuid(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1),
  startTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
  endTimeLocal: z.string().regex(/^\d{2}:\d{2}$/),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
}).refine(
  (d) => d.endTimeLocal > d.startTimeLocal,
  { message: "endTimeLocal must be after startTimeLocal" },
);

export const BookSlotInput = z.object({
  slotId: z.string().uuid(),
  petPublicToken: z.string().min(1),
  notesFromOwner: z.string().max(500).nullable(),
});

export const MarkAttendedInput = z.object({
  appointmentPublicToken: z.string().min(1),
  // Service-kind-specific fields validated separately at action time
});
```

#### Paso 0.5 — Capability registry

Extender `lib/capabilities.ts` con las nuevas capabilities:

```ts
// Add to the capability enum / catalog
"service_offering.create"
"appointment.manage"   // org-side: view bookings, mark attendance, cancel
```

Y agregar mapping de membership role → granted capabilities (probablemente `admin` y `coordinator` reciben ambas; `volunteer` no).

#### Paso 0.6 — RLS

Crear `db/scheduling_rls.sql` siguiendo el patrón de `db/welfare_rls.sql`:

```sql
-- service_offerings
alter table public.service_offerings enable row level security;

create policy "service_offerings read approved publicly"
  on public.service_offerings for select
  using (status = 'approved');

create policy "service_offerings read by org members"
  on public.service_offerings for select
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and left_at is null
    )
  );

-- INSERT/UPDATE/DELETE: server actions only (RLS deny by default for PostgREST)

-- service_schedule_rules
alter table public.service_schedule_rules enable row level security;

create policy "schedule_rules read by org members"
  on public.service_schedule_rules for select
  using (
    service_offering_id in (
      select id from public.service_offerings
      where organization_id in (
        select organization_id from public.organization_memberships
        where user_id = auth.uid() and left_at is null
      )
    )
  );

-- time_slots: public read (it's availability)
alter table public.time_slots enable row level security;

create policy "time_slots read publicly"
  on public.time_slots for select
  using (true);

-- appointments
alter table public.appointments enable row level security;

create policy "appointments read by owner"
  on public.appointments for select
  using (owner_user_id = auth.uid());

create policy "appointments read by org members"
  on public.appointments for select
  using (
    organization_id in (
      select organization_id from public.organization_memberships
      where user_id = auth.uid() and left_at is null
    )
  );
```

Aplicar via Studio.

#### Paso 0.7 — Tests del schema

Crear `__tests__/scheduling-schema.test.ts`:

- Insert service_offering con status='pending_approval' → OK
- Insert service_offering con status inválido → error
- Insert schedule_rule con end_time <= start_time → error
- Insert time_slot con capacity=0 → error
- Insert time_slot con bookings_count > capacity → error
- Update time_slot incrementando bookings_count más allá de capacity → error
- Constraint `appointment_outcome_only_when_attended` rechaza outcome_event_id sin status=attended

#### Acceptance Fase 0

- `pnpm typecheck` cero errores
- `pnpm lint` cero errores nuevos
- `pnpm test` todos verdes
- En Studio: las 4 tablas existen con sus constraints
- `SELECT appointment_id FROM reminders LIMIT 1` no falla (columna agregada)

#### Commit Fase 0

```
feat(scheduling): schema foundation — 4 new tables + reminders FK

Migration adds service_offerings (with approval status workflow),
service_schedule_rules (weekly recurring with discrete fields, no RRULE),
time_slots (discrete bookable slots, materialized from rules), and
appointments (owner bookings with org info denormalized).

Adds reminders.appointment_id FK so reminders backed by real bookings
link to their appointment (existing Reminder-only flow stays intact).

Adds lib/service-kinds.ts with 10 initial service kinds, each mapping to
its emitted pet_event type. Adds lib/scheduling-schemas.ts with Zod
validators for the new server actions.

Extends capability registry with service_offering.create and
appointment.manage.

RLS in db/scheduling_rls.sql: approved service_offerings publicly readable,
time_slots publicly readable (availability is open data), appointments
scoped to owner + org members.

See docs/superpowers/specs/2026-05-16-health-campaigns-and-scheduling-design.md.
```

---

### Fase 1 — Approval workflow

#### Paso 1.1 — Server action `createServiceOfferingAction`

Crear `app/actions/service-offerings.ts`:

```ts
"use server";

import { db, notifications, organizations, organizationMemberships, profiles, serviceOfferings } from "@/db";
import { requireCapability } from "@/lib/capabilities";
import { generatePrefixedToken } from "@/lib/publicToken";  // SVO-XXXX-XXXX
import { CreateServiceOfferingInput } from "@/lib/scheduling-schemas";
import { findServiceKind } from "@/lib/service-kinds";
import { eq, and, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";

export type ServiceOfferingFormState = { error: string | null };

export async function createServiceOfferingAction(
  _prev: ServiceOfferingFormState,
  formData: FormData,
): Promise<ServiceOfferingFormState> {
  const auth = await requireCapability("service_offering.create");
  if (auth.error) return { error: auth.error };
  const { user, organization } = auth;

  // Parse + validate
  const input = parseForm(formData);
  const parsed = CreateServiceOfferingInput.safeParse(input);
  if (!parsed.success) {
    return { error: "Datos inválidos: " + parsed.error.errors[0]?.message };
  }

  // Validate service_kind exists in catalog
  if (!findServiceKind(parsed.data.serviceKind)) {
    return { error: "Tipo de servicio no reconocido." };
  }

  const now = new Date();
  const publicToken = generatePrefixedToken("SVO");

  try {
    await db.transaction(async (tx) => {
      // Insert offering
      const [offering] = await tx.insert(serviceOfferings).values({
        publicToken,
        organizationId: organization.id,
        serviceKind: parsed.data.serviceKind,
        displayName: parsed.data.displayName,
        description: parsed.data.description,
        durationMinutes: parsed.data.durationMinutes,
        slotCapacity: parsed.data.slotCapacity,
        priceArs: parsed.data.priceArs?.toString() ?? null,
        eligibilitySpecies: parsed.data.eligibilitySpecies,
        eligibilityAgeMinMonths: parsed.data.eligibilityAgeMinMonths,
        eligibilityAgeMaxMonths: parsed.data.eligibilityAgeMaxMonths,
        status: "pending_approval",
        submittedAt: now,
      }).returning();

      // Notify all admins
      const admins = await tx.select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.role, "admin"));

      for (const admin of admins) {
        await tx.insert(notifications).values({
          userId: admin.id,
          notificationType: "service_offering_submitted",
          severity: "info",
          title: `Nueva solicitud: ${organization.displayName}`,
          body: `Solicita aprobar "${parsed.data.displayName}" (${findServiceKind(parsed.data.serviceKind)?.label}).`,
          ctaLabel: "Revisar",
          ctaUrl: `/admin/servicios/${publicToken}`,
        });
      }
    });
  } catch (err) {
    return { error: `No se pudo crear la solicitud: ${err instanceof Error ? err.message : "error desconocido"}` };
  }

  redirect(`/org/[orgToken]/servicios/${publicToken}`);
}

function parseForm(formData: FormData) {
  // Translate FormData → input shape. Boolean checkboxes → arrays, nullable
  // number fields with empty string handling, etc.
  // ...
}
```

#### Paso 1.2 — Server actions `approveServiceOfferingAction` y `rejectServiceOfferingAction`

```ts
// app/actions/service-offerings.ts (continuación)

export async function approveServiceOfferingAction(
  publicToken: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  const [profile] = await db.select({ role: profiles.role })
    .from(profiles).where(eq(profiles.id, user.id)).limit(1);
  if (profile?.role !== "admin") return { error: "Solo admins pueden aprobar." };

  const [offering] = await db.select()
    .from(serviceOfferings)
    .where(eq(serviceOfferings.publicToken, publicToken))
    .limit(1);
  if (!offering) return { error: "Solicitud no encontrada." };
  if (offering.status !== "pending_approval") {
    return { error: "Solo se pueden aprobar solicitudes pendientes." };
  }

  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      await tx.update(serviceOfferings)
        .set({
          status: "approved",
          reviewedAt: now,
          reviewedByUserId: user.id,
          updatedAt: now,
        })
        .where(eq(serviceOfferings.id, offering.id));

      // Notify org admins (members with service_offering.create capability)
      const orgAdmins = await tx.select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.organizationId, offering.organizationId),
          isNull(organizationMemberships.leftAt),
        ));

      for (const admin of orgAdmins) {
        await tx.insert(notifications).values({
          userId: admin.userId,
          notificationType: "service_offering_approved",
          severity: "success",
          title: `Servicio aprobado: ${offering.displayName}`,
          body: "Ya podés crear la agenda y empezar a recibir reservas.",
          ctaLabel: "Gestionar agenda",
          ctaUrl: `/org/[orgToken]/servicios/${publicToken}/agenda`,
        });
      }
    });
  } catch (err) {
    return { error: `No se pudo aprobar: ${err instanceof Error ? err.message : ""}` };
  }

  return { error: null };
}

export async function rejectServiceOfferingAction(
  publicToken: string,
  rejectionReason: string,
): Promise<{ error: string | null }> {
  if (rejectionReason.trim().length < 30) {
    return { error: "El motivo del rechazo debe tener al menos 30 caracteres." };
  }

  // Similar pattern: validate admin, validate status, update + notify
  // ...
}
```

#### Paso 1.3 — Routes org-side

**`/org/[orgToken]/servicios/page.tsx`** — lista de servicios de la org:

```tsx
import { db, serviceOfferings } from "@/db";
import { requireActiveOrgOrRedirect } from "@/lib/auth-guards";
import { getGrantedCapabilities } from "@/lib/capabilities";
import { findServiceKind } from "@/lib/service-kinds";
import { eq, desc } from "drizzle-orm";
import Link from "next/link";

export default async function ServicesListPage() {
  const { active } = await requireActiveOrgOrRedirect();
  const granted = await getGrantedCapabilities(active.membership);
  const canCreate = granted.has("service_offering.create");

  const offerings = await db.select()
    .from(serviceOfferings)
    .where(eq(serviceOfferings.organizationId, active.organization.id))
    .orderBy(desc(serviceOfferings.submittedAt));

  return (
    <main className="...">
      <header>
        <h1>Mis servicios</h1>
        {canCreate && (
          <Link href="/org/[orgToken]/servicios/nuevo" className="...">
            + Crear servicio nuevo
          </Link>
        )}
      </header>
      <ul>
        {offerings.map((o) => (
          <li key={o.id}>
            <Link href={`/org/[orgToken]/servicios/${o.publicToken}`}>
              {o.displayName}
              <span>{findServiceKind(o.serviceKind)?.label}</span>
              <Badge status={o.status} />
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

**`/org/[orgToken]/servicios/nuevo/page.tsx`** + `ServiceOfferingForm.tsx` — form para crear nuevo offering. Render select de `SERVICE_KINDS`, defaults a `default_duration_minutes` y `default_eligibility_species` al seleccionar service_kind. Submit a `createServiceOfferingAction`.

**`/org/[orgToken]/servicios/[publicToken]/page.tsx`** — detalle del offering. Mostrar status, datos, motivo de rechazo si aplica. Acciones según status (editar campos editables, pausar, archivar, link a agenda si approved).

#### Paso 1.4 — Routes admin-side

**`/admin/servicios/page.tsx`** — lista de pendientes:

```tsx
import { db, organizations, serviceOfferings } from "@/db";
import { createClient } from "@/lib/supabase/server";
import { findServiceKind } from "@/lib/service-kinds";
import { and, eq, desc } from "drizzle-orm";
import { redirect } from "next/navigation";

export default async function AdminServicesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [profile] = await db.select({ role: profiles.role })
    .from(profiles).where(eq(profiles.id, user.id)).limit(1);
  if (profile?.role !== "admin") redirect("/admin/sin-acceso");

  const pending = await db.select({
    offering: serviceOfferings,
    org: organizations,
  })
    .from(serviceOfferings)
    .innerJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
    .where(eq(serviceOfferings.status, "pending_approval"))
    .orderBy(desc(serviceOfferings.submittedAt));

  // Render list
  // ...
}
```

**`/admin/servicios/[publicToken]/page.tsx`** — detalle con botones Aprobar/Rechazar. El rechazo abre modal con textarea de motivo (min 30 chars).

#### Paso 1.5 — Tests

`__tests__/service-offering-approval.test.ts`:

- Org member con capability crea offering → status='pending_approval', notification a admin
- Admin aprueba → status='approved', notification a org admin
- Admin rechaza sin motivo → error
- Admin rechaza con motivo válido → status='rejected', rejection_reason set, notification
- Non-admin intenta aprobar → error
- Aprobar offering ya aprobado → error
- Org admin cancela su propia solicitud pending → delete

#### Acceptance Fase 1

- `pnpm test` todos verdes
- Smoke manual: org admin crea offering, admin aprueba, org admin recibe notification, status cambió a approved en Studio

#### Commit Fase 1

```
feat(scheduling): approval workflow for service offerings

Org admins with service_offering.create capability submit offerings via
/org/[orgToken]/servicios/nuevo. System validates input against SERVICE_KINDS
catalog and inserts with status='pending_approval' + notifies all
admins.

Admins review at /admin/servicios (list) and /admin/servicios/{token}
(detail). Approve → status='approved' + notification to org. Reject
requires 30+ char reason → status='rejected' + notification with motive.

Each service_offering = one service_kind. To offer different kind, org
submits new offering. Approval state lives on the offering row; when
admin page Fase 0 lands, migrates to centralized approval_requests
table (small refactor).
```

---

### Fase 2 — Schedule rules

#### Paso 2.1 — Server actions

Crear `app/actions/schedule-rules.ts` con:

- `createScheduleRuleAction(serviceOfferingToken, formData)` — verifica que el offering esté aprobado, valida con `CreateScheduleRuleInput`, inserta rule status='active'
- `pauseScheduleRuleAction(ruleId)` — status='paused'
- `reactivateScheduleRuleAction(ruleId)` — status='active'
- `archiveScheduleRuleAction(ruleId)` — status='archived'
- `deleteScheduleRuleAction(ruleId)` — hard delete (solo si la rule no tiene slots con bookings activos)

Cada uno con `requireCapability('service_offering.create')` + verificación de ownership de la org.

#### Paso 2.2 — Route `/org/[orgToken]/servicios/[publicToken]/agenda`

```tsx
import { db, serviceOfferings, serviceScheduleRules } from "@/db";
import { requireActiveOrgOrRedirect } from "@/lib/auth-guards";
// ... loading, auth, capability checks

// Render:
// - Header con nombre del offering
// - Si status !== 'approved': mensaje "Necesitás aprobación antes de armar agenda"
// - Lista de schedule_rules activas con descripción legible ("Lunes y miércoles 09:00-12:00, desde 2026-06-01")
// - Botón "Agregar regla" → modal/form
// - Por cada rule: botones Pausar / Reactivar / Archivar / Eliminar (si sin bookings activos)
// - Botón "Materializar ahora" → server action que dispara el job para este offering
```

#### Paso 2.3 — Tests

```ts
describe("schedule rule CRUD", () => {
  it("rejects rule creation on non-approved offering", () => {});
  it("accepts rule with valid days + time window", () => {});
  it("rejects rule with end_time <= start_time", () => {});
  it("rejects rule with empty days_of_week", () => {});
  it("rejects delete when rule has slots with active appointments", () => {});
});
```

#### Commit Fase 2

```
feat(scheduling): schedule rule CRUD for approved offerings

Approved offerings can have N schedule rules. Each rule defines
days_of_week + start/end local time + effective dates. Validated
against CreateScheduleRuleInput Zod schema. Materialization (Fase 3)
generates slots from active rules.

Rules can be paused (existing slots stay, no new materialization),
reactivated, archived (existing slots cancelled if no booking),
or deleted (only if no slots with active appointments).
```

---

### Fase 3 — Slot materialization

#### Paso 3.1 — Script `scripts/materialize-slots.ts`

```ts
/**
 * Materializes time_slots from active service_schedule_rules in a rolling
 * 60-day window. Idempotent — re-runs are no-ops for existing slots
 * (ON CONFLICT DO NOTHING). Called by the daily cron route, also
 * triggerable per-offering from the org UI.
 *
 * Edge handling:
 * - Offering paused/archived: existing future slots without bookings
 *   are cancelled. With bookings: stay open.
 * - Schedule rule paused/archived: same as above.
 * - Offering capacity changed: future slots without bookings get
 *   the new capacity. With bookings: keep old.
 *
 * Usage:
 *   pnpm materialize-slots                  # all offerings
 *   pnpm materialize-slots --offering <token>  # one offering
 */

import { db, serviceOfferings, serviceScheduleRules, timeSlots } from "@/db";
import { and, eq, gte, isNull, or, sql } from "drizzle-orm";

const HORIZON_DAYS = 60;

async function main(args: { offeringToken?: string }) {
  const now = new Date();
  const horizon = new Date(Date.now() + HORIZON_DAYS * 24 * 60 * 60 * 1000);

  // Get applicable offerings
  const offerings = await db.select()
    .from(serviceOfferings)
    .where(
      args.offeringToken
        ? eq(serviceOfferings.publicToken, args.offeringToken)
        : eq(serviceOfferings.status, "approved"),
    );

  for (const offering of offerings) {
    if (offering.status !== "approved") {
      // Mark future slots without bookings as cancelled
      await cancelFutureUnbookedSlots(offering.id, now);
      continue;
    }

    const rules = await db.select()
      .from(serviceScheduleRules)
      .where(and(
        eq(serviceScheduleRules.serviceOfferingId, offering.id),
        eq(serviceScheduleRules.status, "active"),
      ));

    for (const rule of rules) {
      // Generate slots in window
      const startDate = new Date(Math.max(now.getTime(), new Date(rule.effectiveFrom).getTime()));
      const endDate = rule.effectiveUntil
        ? new Date(Math.min(horizon.getTime(), new Date(rule.effectiveUntil).getTime()))
        : horizon;

      for (let d = startDate; d <= endDate; d.setDate(d.getDate() + 1)) {
        const isoDayOfWeek = d.getDay() === 0 ? 7 : d.getDay();  // Mon=1..Sun=7
        if (!rule.daysOfWeek.includes(isoDayOfWeek)) continue;

        // Generate slots within [start_time_local, end_time_local) chunked by duration
        const slots = generateSlotsForDate(d, rule, offering.durationMinutes);

        for (const slot of slots) {
          await db.insert(timeSlots).values({
            serviceOfferingId: offering.id,
            ruleId: rule.id,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            capacity: offering.slotCapacity,
            status: "open",
          }).onConflictDoNothing();
        }
      }
    }
  }

  console.log(`Materialized for ${offerings.length} offerings.`);
}

async function cancelFutureUnbookedSlots(offeringId: string, asOf: Date) {
  await db.update(timeSlots)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(timeSlots.serviceOfferingId, offeringId),
      gte(timeSlots.startsAt, asOf),
      eq(timeSlots.status, "open"),
      eq(timeSlots.bookingsCount, 0),  // only unbooked
    ));
}

function generateSlotsForDate(
  date: Date,
  rule: typeof serviceScheduleRules.$inferSelect,
  durationMinutes: number,
): Array<{ startsAt: Date; endsAt: Date }> {
  // Parse start/end times in the rule's timezone, combine with date,
  // chunk into duration_minutes intervals.
  // Use a timezone library (date-fns-tz or Luxon) for correctness.
  // ...
}

// CLI entry
const args = parseArgs(process.argv.slice(2));
main(args).then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Agregar `"materialize-slots": "tsx scripts/materialize-slots.ts"` al `package.json` scripts.

#### Paso 3.2 — Cron route

Crear `app/api/cron/materialize-slots/route.ts`:

```ts
import { NextResponse } from "next/server";
// Verify cron secret header to prevent unauthorized calls
// Invoke the materialization function (extract from script or import)

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  await materializeAllOfferings();
  return NextResponse.json({ ok: true });
}
```

Configurar en Vercel cron (`vercel.json`) o equivalente:

```json
{
  "crons": [{
    "path": "/api/cron/materialize-slots",
    "schedule": "0 3 * * *"
  }]
}
```

#### Paso 3.3 — Botón "Materializar ahora"

En `/org/[orgToken]/servicios/[publicToken]/agenda`, server action `materializeOfferingNowAction(publicToken)` que ejecuta `main({ offeringToken: publicToken })`. Útil para preview inmediato después de crear rules nuevas.

#### Paso 3.4 — Tests

```ts
describe("slot materialization", () => {
  it("generates slots in 60-day window for active rule on approved offering", () => {});
  it("is idempotent — re-run is no-op for existing slots", () => {});
  it("cancels future unbooked slots when offering becomes paused", () => {});
  it("does not cancel slots with active appointments", () => {});
  it("respects effective_from and effective_until dates", () => {});
  it("respects days_of_week filter", () => {});
  it("chunks correctly by duration_minutes", () => {});
});
```

#### Commit Fase 3

```
feat(scheduling): slot materialization cron + manual trigger

scripts/materialize-slots.ts runs daily via /api/cron/materialize-slots
and materializes time_slots from active service_schedule_rules in a
rolling 60-day window. Idempotent (ON CONFLICT DO NOTHING).

Edge handling:
- Paused/archived offerings or rules: cancel future unbooked slots
- Capacity change: future unbooked slots get new value
- Bookings stay open until resolved

Org admins can trigger immediate re-materialization per offering via
"Materializar ahora" button in the schedule UI.
```

---

### Fase 4 — Owner search + book

#### Paso 4.1 — Route `/turnos/buscar`

```tsx
// app/(app)/turnos/buscar/page.tsx
import { db, organizations, serviceOfferings, timeSlots, pets, ownerships } from "@/db";
import { createClient } from "@/lib/supabase/server";
import { SERVICE_KINDS } from "@/lib/service-kinds";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";

export default async function SearchTurnosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const serviceKind = sp.service_kind ?? null;
  const province = sp.province ?? null;
  const locality = sp.locality ?? null;
  const petToken = sp.pet ?? null;
  // dateFrom, dateUntil...

  // Load owner's pets for selector
  const myPets = await db.select()
    .from(pets)
    .innerJoin(ownerships, and(
      eq(ownerships.petId, pets.id),
      eq(ownerships.ownerUserId, user.id),
      eq(ownerships.role, "owner"),
      isNull(ownerships.endedAt),
    ));

  // Search slots only when serviceKind is set
  let results: Array<{ slot: any; offering: any; org: any }> = [];
  if (serviceKind) {
    results = await db.select({
      slot: timeSlots,
      offering: serviceOfferings,
      org: organizations,
    })
      .from(timeSlots)
      .innerJoin(serviceOfferings, eq(serviceOfferings.id, timeSlots.serviceOfferingId))
      .innerJoin(organizations, eq(organizations.id, serviceOfferings.organizationId))
      .where(and(
        eq(timeSlots.status, "open"),
        sql`${timeSlots.bookingsCount} < ${timeSlots.capacity}`,
        gte(timeSlots.startsAt, new Date()),
        // ... dateUntil filter
        eq(serviceOfferings.status, "approved"),
        eq(serviceOfferings.serviceKind, serviceKind),
        eq(organizations.verified, true),
        eq(organizations.status, "active"),
        province ? eq(organizations.jurisdictionProvince, province) : sql`true`,
        locality ? eq(organizations.jurisdictionLocality, locality) : sql`true`,
      ))
      .orderBy(timeSlots.startsAt)
      .limit(100);
  }

  // Render: filters form, pet selector, results list with [Reservar] per row
  // Each result respects eligibility — show disabled with tooltip if pet's
  // species/age doesn't match offering's eligibility constraints
  // ...
}
```

#### Paso 4.2 — Server action `bookSlotAction`

```ts
// app/actions/scheduling.ts

"use server";

import { db, appointments, notifications, organizationMemberships, ownerships, pets, reminders, serviceOfferings, timeSlots } from "@/db";
import { findServiceKind } from "@/lib/service-kinds";
import { BookSlotInput } from "@/lib/scheduling-schemas";
import { generatePrefixedToken } from "@/lib/publicToken";
import { createClient } from "@/lib/supabase/server";
import { and, eq, isNull, sql } from "drizzle-orm";

export type BookSlotResult = { error: string } | { ok: true; appointmentPublicToken: string };

export async function bookSlotAction(input: unknown): Promise<BookSlotResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  const parsed = BookSlotInput.safeParse(input);
  if (!parsed.success) return { error: "Datos inválidos." };

  // Verify pet ownership
  const [petRow] = await db.select({ pet: pets })
    .from(pets)
    .innerJoin(ownerships, and(
      eq(ownerships.petId, pets.id),
      eq(ownerships.ownerUserId, user.id),
      eq(ownerships.role, "owner"),
      isNull(ownerships.endedAt),
    ))
    .where(eq(pets.publicToken, parsed.data.petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada." };

  const now = new Date();
  const appointmentPublicToken = generatePrefixedToken("APT");

  try {
    const result = await db.transaction(async (tx) => {
      // Advisory lock on slot
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${parsed.data.slotId}::text, 0))
      `);

      // Read slot under lock
      const [slot] = await tx.select()
        .from(timeSlots)
        .where(eq(timeSlots.id, parsed.data.slotId))
        .limit(1);
      if (!slot) throw new Error("Slot no encontrado.");
      if (slot.status !== "open") throw new Error("Este turno ya no está disponible.");
      if (slot.bookingsCount >= slot.capacity) throw new Error("Este turno está lleno.");
      if (slot.startsAt <= now) throw new Error("Este turno ya pasó.");

      // Read offering for eligibility check
      const [offering] = await tx.select()
        .from(serviceOfferings)
        .where(eq(serviceOfferings.id, slot.serviceOfferingId))
        .limit(1);
      if (!offering || offering.status !== "approved") {
        throw new Error("Este servicio ya no está disponible.");
      }

      // Eligibility check
      if (offering.eligibilitySpecies && offering.eligibilitySpecies.length > 0) {
        if (!offering.eligibilitySpecies.includes(petRow.pet.species)) {
          throw new Error(`Este servicio es solo para ${offering.eligibilitySpecies.join(", ")}.`);
        }
      }
      if (offering.eligibilityAgeMinMonths !== null || offering.eligibilityAgeMaxMonths !== null) {
        const petAgeMonths = calculateAgeMonths(petRow.pet.dateOfBirth);
        if (offering.eligibilityAgeMinMonths !== null && petAgeMonths < offering.eligibilityAgeMinMonths) {
          throw new Error(`Tu mascota es muy joven para este servicio (mínimo ${offering.eligibilityAgeMinMonths} meses).`);
        }
        if (offering.eligibilityAgeMaxMonths !== null && petAgeMonths > offering.eligibilityAgeMaxMonths) {
          throw new Error(`Tu mascota es muy grande para este servicio (máximo ${offering.eligibilityAgeMaxMonths} meses).`);
        }
      }

      // Anti-double-booking same pet same slot
      const [existing] = await tx.select({ id: appointments.id })
        .from(appointments)
        .where(and(
          eq(appointments.petId, petRow.pet.id),
          eq(appointments.slotId, parsed.data.slotId),
          eq(appointments.status, "confirmed"),
        )).limit(1);
      if (existing) throw new Error("Ya reservaste este turno para esta mascota.");

      // Insert appointment first (reminder_id null for now)
      const [appointment] = await tx.insert(appointments).values({
        publicToken: appointmentPublicToken,
        slotId: parsed.data.slotId,
        petId: petRow.pet.id,
        ownerUserId: user.id,
        serviceOfferingId: offering.id,
        organizationId: offering.organizationId,
        status: "confirmed",
        notesFromOwner: parsed.data.notesFromOwner,
      }).returning();

      // Increment bookings_count; mark full if at capacity
      const newCount = slot.bookingsCount + 1;
      await tx.update(timeSlots).set({
        bookingsCount: newCount,
        status: newCount >= slot.capacity ? "full" : "open",
        updatedAt: now,
      }).where(eq(timeSlots.id, parsed.data.slotId));

      // Create parallel reminder
      const serviceKindDef = findServiceKind(offering.serviceKind);
      const reminderType = serviceKindDef?.emitted_event_type === "vaccination_administered"
        ? "vaccine"
        : "appointment";

      const [reminder] = await tx.insert(reminders).values({
        petId: petRow.pet.id,
        userId: user.id,
        reminderType,
        dueAt: slot.startsAt,
        title: `${offering.displayName}`,
        description: `Reservado en ${offering.displayName} para el ${slot.startsAt.toLocaleString("es-AR")}`,
        appointmentId: appointment.id,
      }).returning();

      // Link reminder back to appointment
      await tx.update(appointments).set({ reminderId: reminder.id })
        .where(eq(appointments.id, appointment.id));

      // Notify owner
      await tx.insert(notifications).values({
        userId: user.id,
        notificationType: "appointment_booked_owner",
        severity: "success",
        title: `Turno confirmado`,
        body: `${offering.displayName} el ${slot.startsAt.toLocaleString("es-AR")}.`,
        relatedPetId: petRow.pet.id,
        ctaLabel: "Ver turno",
        ctaUrl: `/mis-turnos/${appointmentPublicToken}`,
      });

      // Notify org admins
      const orgMembers = await tx.select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.organizationId, offering.organizationId),
          isNull(organizationMemberships.leftAt),
        ));

      for (const member of orgMembers) {
        await tx.insert(notifications).values({
          userId: member.userId,
          notificationType: "appointment_booked_org",
          severity: "info",
          title: `Nueva reserva: ${petRow.pet.name}`,
          body: `${offering.displayName} el ${slot.startsAt.toLocaleString("es-AR")}.`,
          ctaLabel: "Ver turno",
          ctaUrl: `/org/[orgToken]/agenda/turnos/${appointmentPublicToken}`,
        });
      }

      return appointmentPublicToken;
    });

    return { ok: true, appointmentPublicToken: result };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Error al reservar." };
  }
}

function calculateAgeMonths(dateOfBirth: string | null): number {
  if (!dateOfBirth) return 0;
  const dob = new Date(dateOfBirth);
  const now = new Date();
  return (now.getFullYear() - dob.getFullYear()) * 12 + (now.getMonth() - dob.getMonth());
}
```

#### Paso 4.3 — Routes `/mis-turnos` y `/mis-turnos/[publicToken]`

Lista del owner de sus appointments + detalle individual con org info, datos del slot, status. Botón "Cancelar" si futuro + confirmed.

#### Paso 4.4 — Tests

```ts
describe("bookSlotAction", () => {
  it("books a slot successfully", () => {});
  it("rejects booking if slot is full", () => {});
  it("rejects booking if slot is in past", () => {});
  it("rejects booking if species doesn't match eligibility", () => {});
  it("rejects booking if age out of eligibility range", () => {});
  it("rejects double-booking same pet same slot", () => {});
  it("creates parallel reminder linked to appointment", () => {});
  it("notifies owner and org admins", () => {});
  it("marks slot 'full' when last cupo taken", () => {});

  // Race condition test
  it("two concurrent bookings on last cupo — only one succeeds", () => {});
});
```

#### Commit Fase 4

```
feat(scheduling): owner search and booking with advisory locks

Owners search /turnos/buscar with filters (service_kind, province,
locality, pet, date range). Results show approved offerings of verified
orgs ordered by slot start time. Eligibility (species, age) filtering
displays disabled rows with tooltip explanation.

bookSlotAction uses pg_advisory_xact_lock to serialize access to the
slot, then verifies preconditions (status='open', bookings < capacity,
slot in future, eligibility match) before inserting appointment.

Booking atomically:
1. Inserts appointment row with status='confirmed'
2. Increments slot.bookings_count (DB constraint guards against overshoot)
3. Marks slot 'full' when at capacity
4. Creates parallel reminder linked via appointment_id
5. Notifies owner + org admins

/mis-turnos and /mis-turnos/{token} surface bookings to the owner.
```

---

### Fase 5 — Org booking management + attendance

#### Paso 5.1 — Route `/org/[orgToken]/agenda` (dashboard del día)

```tsx
// app/org/[orgToken]/agenda/page.tsx
// Default: today's slots + appointments
// Each slot card shows: time, service, capacity (e.g. "2/5"), list of bookings
// Click into a booking → /org/[orgToken]/agenda/turnos/{token}
```

#### Paso 5.2 — Route `/org/[orgToken]/agenda/turnos/[publicToken]`

```tsx
// Show appointment details:
// - Pet info (name, photo, species, breed, age)
// - Owner info (first name, phone if disclosed by owner — read pet's disclosure prefs)
// - Service offering
// - Slot time
// - Notes from owner
// - Buttons (per status):
//   confirmed → [Marcar atendido] [Marcar no_show] [Cancelar este turno]
//   attended → [Ver evento en libreta de pet]
//   no_show → read-only with mark date
//   cancelled → read-only with reason
```

#### Paso 5.3 — `markAppointmentAttendedAction`

Esta es la action más crítica — emite el `pet_event` real. El form que la dispara es específico al `service_kind`. Para v1, dos forms suficiente:

**Form para vacunaciones** (`service_kind in ['vaccination_rabies', 'vaccination_triple_canina', 'vaccination_triple_felina']`):

```
Vacuna aplicada: {auto-prefill from service_kind, editable}
Marca: [text]
Lote: [text]
Aplicado por: [text, default org name]
Próxima dosis: [date, opcional]
```

**Form para esterilizaciones / general** (resto):

```
Procedimiento: {auto-prefill from service_kind, editable}
Realizado por: [text, default org name]
Notas: [textarea]
```

```ts
// app/actions/scheduling.ts (continuación)

export async function markAppointmentAttendedAction(
  publicToken: string,
  formData: FormData,
): Promise<{ error: string | null }> {
  const auth = await requireCapability("appointment.manage");
  if (auth.error) return { error: auth.error };
  const { user, organization } = auth;

  const [appointment] = await db.select({
    appointment: appointments,
    offering: serviceOfferings,
    pet: pets,
  })
    .from(appointments)
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    .innerJoin(pets, eq(pets.id, appointments.petId))
    .where(eq(appointments.publicToken, publicToken))
    .limit(1);

  if (!appointment) return { error: "Turno no encontrado." };
  if (appointment.appointment.organizationId !== organization.id) {
    return { error: "Este turno no pertenece a tu organización." };
  }
  if (appointment.appointment.status !== "confirmed") {
    return { error: "Solo se pueden marcar como atendidos los turnos confirmados." };
  }

  const serviceKind = findServiceKind(appointment.offering.serviceKind);
  if (!serviceKind) return { error: "Tipo de servicio no soportado." };

  // Build payload by service_kind
  let payload: unknown;
  if (serviceKind.emitted_event_type === "vaccination_administered") {
    payload = {
      vaccine_name: String(formData.get("vaccineName") ?? "").trim(),
      brand: String(formData.get("brand") ?? "").trim() || null,
      batch: String(formData.get("batch") ?? "").trim() || null,
      administered_by: String(formData.get("administeredBy") ?? "").trim() || null,
      next_due_at: String(formData.get("nextDueAt") ?? "").trim() || null,
    };
  } else if (serviceKind.emitted_event_type === "sterilization_performed") {
    payload = {
      procedure: serviceKind.code.includes("female") ? "spay" : "castration",
      performed_by: String(formData.get("performedBy") ?? "").trim() || null,
      clinic: organization.displayName,
    };
  } else if (serviceKind.emitted_event_type === "deworming_administered") {
    payload = {
      product: String(formData.get("product") ?? "").trim(),
      type: String(formData.get("type") ?? "internal") as "internal" | "external" | "both",
      next_due_at: String(formData.get("nextDueAt") ?? "").trim() || null,
    };
  } else if (serviceKind.emitted_event_type === "vet_visit_logged") {
    payload = {
      reason: String(formData.get("reason") ?? "Consulta general").trim(),
      diagnosis: String(formData.get("diagnosis") ?? "").trim() || null,
      vet_name: String(formData.get("vetName") ?? "").trim() || null,
      clinic: organization.displayName,
    };
  } else if (serviceKind.emitted_event_type === "microchip_implanted") {
    payload = {
      chip_number: String(formData.get("chipNumber") ?? "").trim(),
      country_code: "858",
      implanted_by: String(formData.get("implantedBy") ?? "").trim() || null,
      location_on_body: String(formData.get("locationOnBody") ?? "").trim() || null,
      implant_date_known: true,
    };
  }

  // Validate payload via Zod
  let validatedPayload: unknown;
  try {
    validatedPayload = validateEventPayload(serviceKind.emitted_event_type, payload);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Payload inválido." };
  }

  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      // Read slot for occurred_at
      const [slot] = await tx.select()
        .from(timeSlots)
        .where(eq(timeSlots.id, appointment.appointment.slotId))
        .limit(1);

      // Insert pet_event
      const [petEvent] = await tx.insert(petEvents).values({
        petId: appointment.pet.id,
        eventType: serviceKind.emitted_event_type,
        occurredAt: slot.startsAt,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "vet",
        authorOrganizationId: organization.id,
        authorVerified: organization.verified,
        payload: validatedPayload,
      }).returning();

      // Update appointment
      await tx.update(appointments).set({
        status: "attended",
        attendedAt: now,
        attendedByUserId: user.id,
        outcomeEventId: petEvent.id,
        updatedAt: now,
      }).where(eq(appointments.id, appointment.appointment.id));

      // Complete reminder if linked
      if (appointment.appointment.reminderId) {
        await tx.update(reminders).set({ completedAt: now })
          .where(eq(reminders.id, appointment.appointment.reminderId));
      }

      // Notify owner
      await tx.insert(notifications).values({
        userId: appointment.appointment.ownerUserId,
        notificationType: "appointment_attended",
        severity: "success",
        title: `Listo. Quedó en la libreta de ${appointment.pet.name}.`,
        body: `${appointment.offering.displayName} registrado en la libreta sanitaria.`,
        relatedPetId: appointment.pet.id,
        relatedEventId: petEvent.id,
        ctaLabel: "Ver libreta",
        ctaUrl: `/mis-mascotas/${appointment.pet.publicToken}/libreta`,
      });
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Error al marcar atendido." };
  }

  return { error: null };
}
```

#### Paso 5.4 — `markAppointmentNoShowAction` y `cancelAppointmentByOrgAction`

Patrones simples sin emit de evento. Cancel libera el slot (decrementa `bookings_count` + cambia status a 'open' si era 'full').

#### Paso 5.5 — Tests

```ts
describe("markAppointmentAttendedAction", () => {
  it("emits vaccination_administered event for vaccination service", () => {});
  it("emits sterilization_performed event for sterilization service", () => {});
  it("validates payload via Zod (rejects missing required fields)", () => {});
  it("links outcome_event_id and completes reminder", () => {});
  it("notifies owner with CTA to libreta", () => {});
  it("rejects if appointment not confirmed", () => {});
  it("rejects if org doesn't own this appointment", () => {});
});

describe("markAppointmentNoShowAction", () => {
  it("sets status=no_show and notifies owner", () => {});
  it("does NOT emit any pet_event", () => {});
});

describe("cancelAppointmentByOrgAction", () => {
  it("releases slot capacity (bookings_count -- and status open if was full)", () => {});
  it("notifies owner with reason", () => {});
});
```

#### Commit Fase 5

```
feat(scheduling): org booking management and attendance flow

/org/[orgToken]/agenda: dashboard with today's slots and bookings.
/org/[orgToken]/agenda/turnos/{token}: appointment detail with actions.

markAppointmentAttendedAction is the critical path — service_kind-
specific forms (vaccination has vaccine_name/brand/batch; sterilization
has procedure derived; general checkup has reason/diagnosis; etc.)
build the payload, validated via the existing event-schemas Zod, then
atomically:

1. Insert the pet_event with author_role='vet',
   author_organization_id, author_verified mirroring org status
2. Update appointment status='attended' + outcome_event_id link
3. Complete the linked reminder
4. Notify owner "Quedó en la libreta de {pet}."

markAppointmentNoShowAction: status update + notification only, no
event emitted. cancelAppointmentByOrgAction: releases slot capacity
and notifies owner with reason.
```

---

### Fase 6 — Owner cancellation

#### Paso 6.1 — `cancelAppointmentByOwnerAction`

```ts
export async function cancelAppointmentByOwnerAction(
  publicToken: string,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  try {
    await db.transaction(async (tx) => {
      const [appointment] = await tx.select()
        .from(appointments)
        .where(eq(appointments.publicToken, publicToken))
        .limit(1);
      if (!appointment) throw new Error("Turno no encontrado.");
      if (appointment.ownerUserId !== user.id) throw new Error("No es tu turno.");
      if (appointment.status !== "confirmed") throw new Error("Solo se pueden cancelar turnos confirmados.");

      const [slot] = await tx.select().from(timeSlots)
        .where(eq(timeSlots.id, appointment.slotId)).limit(1);
      if (slot.startsAt <= new Date()) throw new Error("No se puede cancelar un turno que ya pasó.");

      const now = new Date();

      // Update appointment
      await tx.update(appointments).set({
        status: "cancelled_by_owner",
        cancelledAt: now,
        cancelledByUserId: user.id,
        updatedAt: now,
      }).where(eq(appointments.id, appointment.id));

      // Decrement slot bookings_count; reopen if was full
      const newCount = Math.max(0, slot.bookingsCount - 1);
      await tx.update(timeSlots).set({
        bookingsCount: newCount,
        status: slot.status === "full" ? "open" : slot.status,
        updatedAt: now,
      }).where(eq(timeSlots.id, slot.id));

      // Complete linked reminder
      if (appointment.reminderId) {
        await tx.update(reminders).set({ completedAt: now })
          .where(eq(reminders.id, appointment.reminderId));
      }

      // Notify org admins
      const orgMembers = await tx.select({ userId: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.organizationId, appointment.organizationId),
          isNull(organizationMemberships.leftAt),
        ));

      for (const member of orgMembers) {
        await tx.insert(notifications).values({
          userId: member.userId,
          notificationType: "appointment_cancelled_by_owner",
          severity: "info",
          title: `Turno cancelado`,
          body: `El dueño canceló el turno del ${slot.startsAt.toLocaleString("es-AR")}.`,
          ctaLabel: "Ver agenda",
          ctaUrl: "/org/[orgToken]/agenda",
        });
      }
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Error al cancelar." };
  }

  return { error: null };
}
```

#### Paso 6.2 — UI en `/mis-turnos/[publicToken]`

Botón "Cancelar turno" condicional a status=confirmed y starts_at > now. Modal de confirmación ("¿Seguro? Esta acción no se puede deshacer y libera el cupo para otros."). Después de confirm, llama a la action.

#### Commit Fase 6

```
feat(scheduling): owner-side appointment cancellation

cancelAppointmentByOwnerAction validates ownership and timing (slot
must be in future), then atomically:

1. Sets appointment.status='cancelled_by_owner'
2. Decrements slot.bookings_count; reopens slot status if was 'full'
3. Completes the linked reminder
4. Notifies org admins

No penalty for cancellation in v1. If no-show pattern abuse emerges,
rate-limit or tracking comes later.
```

---

### Fase 7 — Integration con form existente

#### Paso 7.1 — Link en `/mis-mascotas/[publicToken]/vacunas/programar`

Mínimo cambio. En `ScheduleVaccineForm.tsx`, después del botón submit, agregar:

```tsx
<div className="pt-4 border-t border-neutral-200 dark:border-neutral-800 text-center">
  <p className="text-xs text-neutral-500 dark:text-neutral-500 mb-2">
    ¿Preferís reservar un turno real en una clínica?
  </p>
  <Link
    href={`/turnos/buscar?service_kind=${mapVaccineNameToServiceKind(vaccineName)}&pet=${publicToken}`}
    className="text-sm text-blue-600 dark:text-blue-400 underline"
  >
    Buscar turnos disponibles →
  </Link>
</div>
```

Donde `mapVaccineNameToServiceKind` traduce "Antirrábica" → "vaccination_rabies", "Triple canina" → "vaccination_triple_canina", etc.

#### Paso 7.2 — Sección "Próximas vacunas" en pet profile

En `/mis-mascotas/[publicToken]/page.tsx`, la sección que lista reminders cambia para:

- Query: reminders incluyendo el LEFT JOIN con appointments (via `reminders.appointment_id`)
- Cada item muestra distinto según si tiene appointment o no:

```
Sin appointment:
  Antirrábica · 2026-08-15 · Programado por vos
  [Buscar turno]                              [Editar]

Con appointment (status=confirmed):
  Antirrábica · 2026-05-25 09:30 · Clínica San Telmo · Confirmado
  [Ver turno]                                 [Cancelar]

Con appointment (status=attended):
  (no aparece — el reminder está completado, el evento está en la libreta)
```

#### Paso 7.3 — Tests

```ts
describe("reminder + appointment integration", () => {
  it("displays reminder without appointment as plain anotación", () => {});
  it("displays reminder with confirmed appointment with org info", () => {});
  it("removes reminder from list when appointment is attended (reminder completed)", () => {});
  it("removes reminder from list when appointment is cancelled (reminder completed)", () => {});
});
```

#### Commit Fase 7

```
feat(scheduling): integration with existing reminder flow

The /mis-mascotas/{token}/vacunas/programar form gains a link below
submit pointing to /turnos/buscar pre-filtered by inferred service_kind.
Users who fill the existing form get plain reminders (no-change behavior).
Users who click the link land on the new booking search.

Pet profile "Próximas vacunas" section now mixes plain reminders and
reminder+appointment pairs in one list, with badges/actions per case.
Reminders linked to attended or cancelled appointments are auto-
completed and drop from the list naturally.
```

---

### Fase 8 — Polish (opcional)

#### Paso 8.1 — 24h reminder

Cron nuevo `/api/cron/appointment-reminders` que corre diariamente y notifica owners cuyos appointments son al día siguiente:

```ts
// For each confirmed appointment where slot.starts_at is in [now+23h, now+25h]
// AND no 'appointment_reminder_24h' notification already exists for it
// Insert Notification severity='info' with the reminder
```

#### Paso 8.2 — Logos en search

Agregar `organizations.avatarUrl` al render de cada result en `/turnos/buscar`.

#### Paso 8.3 — Filtros extra

`/turnos/buscar` agrega filtros:
- Precio (gratis / hasta $X)
- Próximos N días (7/14/30)
- Solo orgs verificadas (default true, toggle para sandbox/testing)

#### Commit Fase 8

```
chore(scheduling): polish — 24h reminders, logos in search, extra filters
```

---

## 5. Verificación final

Después de las 8 fases (Fase 8 opcional):

1. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — todo verde
2. Smoke end-to-end manual:
   - Org member crea offering → admin lo aprueba → org member agrega schedule rule → corre materialización manual → slots aparecen
   - Otro user (owner de un pet) busca turnos en `/turnos/buscar` con service_kind matching → ve los slots
   - Owner reserva un slot → confirmation, reminder creado, notifications a ambas partes
   - Org member abre `/org/[orgToken]/agenda` → ve la reserva
   - Org member marca atendido con form → pet_event emitido, owner recibe notification "Quedó en la libreta"
   - Owner abre `/mis-mascotas/{token}/libreta` → el evento está visible
3. Existing flows no rotos:
   - `/mis-mascotas/{token}/vacunas/programar` con submit normal sigue creando solo Reminder
   - Welfare reports, intake, transfer, adoption flows existentes intactos

## 6. Edge cases recordatorio (del spec §11/§13)

- Schedule rule editada después de materializar slots: rule cambia → slots futuros sin bookings se regeneran, con bookings quedan con parámetros viejos
- Capacity cambia: idem
- Offering paused mientras hay slots futuros con bookings: bookings respetadas, slots futuros sin bookings cancelados
- Race de booking sobre último cupo: advisory lock + constraint DB
- Owner cancela slot full: vuelve a `open` (capacity decremented)
- Owner intenta book pet ineligible (species/age): rechazado con error claro
- Offering rechazado: org puede crear nuevo con cambios, no editar el rechazado
- Reminder pre-existente del owner sin appointment + booking nuevo: dos rows separados; sin colisión

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos
2. Reportá a Nacho:
   - Fases ejecutadas y tests passing
   - URLs de prueba (`/org/[orgToken]/servicios/nuevo`, `/admin/servicios`, `/turnos/buscar?service_kind=vaccination_rabies`, `/mis-turnos`)
   - Si Fase 8 quedó pendiente: clarificar (no es bloqueante para v1 funcional)
   - Cualquier cambio respecto al spec (defaults distintos, edge cases descubiertos) anotado
