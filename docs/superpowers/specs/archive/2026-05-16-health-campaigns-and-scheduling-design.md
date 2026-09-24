# Health campaigns and scheduling — design spec

> Sistema completo de agendamiento veterinario. Orgs verificadas solicitan permiso para ofrecer un servicio específico, admin aprueba, la org crea su agenda recurrente, el sistema materializa slots, los dueños buscan y reservan. La asistencia emite el `pet_event` correspondiente que queda en la libreta sanitaria. La opción de "agendar como recordatorio personal" se mantiene en paralelo — ambos flujos coexisten.
>
> **Fecha:** 2026-05-16 (rewrite 2026-05-17)
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 2.1 — polymorphic provider (org o vet independiente), paths actualizados (`/org/[orgToken]`, `/pro`, `/gob`, `/admin`), routing de approvals via govt. Reemplaza v2.0.

---

## 1. Por qué este documento existe

DIM hoy tiene "Agendar vacuna" implementado como un `Reminder` privado del dueño — útil como anotación, pero un dead-end si el North Star es *"que las vacunas lleguen a los animales que las necesitan"*. Para eso los proveedores reales (clínicas, autoridades sanitarias) tienen que publicar disponibilidad y los dueños tienen que poder reservar.

`AGENTS.md` reserva `vaccination_administered.payload.campaign_id?` y `sterilization_performed.payload.campaign_id?` como hooks para esta capa, pero no existe ni el modelo de slots ni el approval flow. Este doc cierra ese hueco con scope acotado: orgs piden aprobación por servicio, admin aprueba, slots se generan, dueños reservan, atención emite evento. Sin campaigns como entidad separada, sin polimorfismo de provider, sin modos de confirmación configurables — todo eso queda para iteraciones cuando los datos lo justifiquen.

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | **Provider polymorphic: `organization` verified OR vet personal con `professional.provider` capability**. La org es la unidad de approval para clínicas / autoridades sanitarias / refugios. El vet independiente (sin clínica, e.g., vet de campo) es la unidad de approval para casos personales. Mismo XOR pattern que `Ownership.owner_user_id | owner_organization_id` | Captura los dos casos legítimos del mercado argentino: clínicas con scheduling, y vets independientes con consultorio móvil o atención a domicilio. Schema-level XOR mantiene integridad |
| D2 | **Un service offering = un service_kind**. La org pide aprobación para "antirrábica perro adulto"; el admin aprueba ese servicio específico. Si la org quiere ofrecer también triple felina, es otra solicitud | Aprobación granular por servicio. El admin no aprueba "todo lo que la clínica X quiera hacer" — aprueba un servicio concreto con sus detalles |
| D3 | **Confirmación de reserva = instantánea**. Sin modo "manual approval por la org". El owner reserva, el slot queda tomado, queda confirmada | Friction mínima. Si una org necesita aprobar manualmente, la solución es definir slots más selectivamente, no agregar un workflow de aprobación |
| D4 | **Schedule = reglas semanales recurrentes con campos discretos** (días de la semana + ventana horaria + vigencia). NO RRULE | Cubre el 100% de patrones argentinos típicos ("lunes y miércoles 9-12"). RRULE es overkill |
| D5 | **Slots materializados en una ventana móvil de 60 días vía cron**. Job nocturno regenera. Idempotent | Mismo patrón que Calendly/Cal.com. Queries simples sobre `time_slots` indexada, intent declarativo preservado en las rules |
| D6 | **Appointment es planning artifact mutable**, separado del `pet_event` inmutable. Al marcar asistencia se emite el evento (`vaccination_administered`, etc.) | Misma disciplina que `Reminder` vs `pet_event` — un appointment puede cancelarse o reagendarse sin tocar el log inmutable |
| D7 | **Reminder integration: ambos flujos coexisten**. "Agendar vacuna" existente sigue funcionando (crea Reminder privado, sin appointment). El flujo nuevo de reservar crea Reminder + Appointment linkeados. La página "Próximas vacunas" muestra los dos casos mezclados | El dueño que se acuerda solo, sin reservar, sigue teniendo su libreta de papel digital. El que reserva queda mejor servido |
| D8 | **Approval state en columna `service_offerings.status`** (pending_approval, approved, rejected, paused, archived). El routing del request va a govt cuya scope cubre la `jurisdiction_locality` declarada en el offering (sea de org o de vet independiente); fallback a admin si no hay govt covering. Govt ve requests en `/gob/servicios`; admin ve el fallback queue en `/admin/servicios` | Refleja la separación `/gob` (locality-scoped) vs `/admin` (universal). El offering declara su jurisdicción independiente de quién sea el provider |
| D9 | **Owner busca via filtro por service_kind + jurisdicción** del pet. La búsqueda muestra slots de orgs verified con offering aprobado. No hay paginación compleja, no hay search por nombre de org | Simple. El día que haya cientos de orgs por barrio, paginamos. Hoy alcanza |
| D10 | **Race conditions sobre el último cupo** se manejan con advisory lock + DB constraint (`bookings_count <= capacity`). Ambos guardarrieles | Estándar para booking systems. Sin esto, dos owners agarran el último slot al mismo tiempo y termina overbooked |
| D11 | **El evento médico se emite con el payload del form de atención** (vaccine_name, brand, batch para vacunación, etc.). El `service_offering.service_kind` no es suficiente — la org necesita confirmar detalles reales al momento de marcar asistencia | El `service_kind` define qué tipo de evento es; el payload concreto se llena al momento del acto médico real |

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **Service offering** | Un servicio específico que una org pide aprobación para ofrecer (e.g., "Antirrábica gratis perros adultos"). Una org puede tener múltiples offerings | `service_offerings` table |
| **Schedule rule** | Regla semanal recurrente para un offering. Define días + ventana horaria + vigencia | `service_schedule_rules` table |
| **Time slot** | Slot discreto bookeable materializado a partir de schedule rules | `time_slots` table |
| **Appointment** | Reserva de un dueño en un slot para una mascota específica | `appointments` table |
| **Outcome event** | El `pet_event` emitido cuando el appointment se marca como atendido (`vaccination_administered`, `sterilization_performed`, etc.) | Existing `pet_events`, linked via `appointments.outcome_event_id` |

## 4. Domain model

### 4.1 `service_offerings`

```sql
create table service_offerings (
  id                       uuid primary key default gen_random_uuid(),
  public_token             text not null unique,        -- e.g. SVO-XXXX-XXXX

  -- Polymorphic provider: exactly one of organization_id / provider_user_id is set (XOR)
  organization_id          uuid references organizations(id) on delete cascade,
  provider_user_id         uuid references profiles(id) on delete cascade,
  -- Jurisdiction denormalized from provider for routing approvals independently of who the provider is
  jurisdiction_country     text not null default 'AR',
  jurisdiction_province    text,
  jurisdiction_locality    text,

  service_kind             text not null,                -- 'vaccination_rabies' | 'vaccination_triple_felina' | 'sterilization_dog_male' | 'sterilization_dog_female' | 'sterilization_cat' | 'deworming' | 'general_checkup' | 'microchip_implantation'
  display_name             text not null,                -- "Antirrábica perro adulto"
  description              text,
  duration_minutes         int not null default 15,
  slot_capacity            int not null default 1,       -- pets per slot
  price_ars                numeric(10, 2),               -- null = free
  eligibility_species      text[],                       -- e.g. ['dog'], ['dog','cat'], null = any
  eligibility_age_min_months int,
  eligibility_age_max_months int,

  -- Approval workflow
  status                   text not null default 'pending_approval',
  -- 'pending_approval' | 'approved' | 'rejected' | 'paused' | 'archived'
  submitted_at             timestamptz not null default now(),
  reviewed_at              timestamptz,
  reviewed_by_user_id      uuid references profiles(id),
  rejection_reason         text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint provider_xor check (
    (organization_id is not null and provider_user_id is null)
    or (organization_id is null and provider_user_id is not null)
  ),
  constraint service_status_valid check (status in ('pending_approval', 'approved', 'rejected', 'paused', 'archived')),
  constraint service_capacity_positive check (slot_capacity > 0),
  constraint service_duration_positive check (duration_minutes > 0)
);

create index service_offerings_org_idx          on service_offerings (organization_id) where organization_id is not null;
create index service_offerings_provider_idx     on service_offerings (provider_user_id) where provider_user_id is not null;
create index service_offerings_pending_idx      on service_offerings (status, submitted_at) where status = 'pending_approval';
create index service_offerings_active_search_idx on service_offerings (service_kind, status) where status = 'approved';
create index service_offerings_jurisdiction_idx on service_offerings (jurisdiction_country, jurisdiction_province, jurisdiction_locality);
```

**Lifecycle:**

```
[org or vet creates]  pending_approval
                          │
                          ├──[govt in scope approves]──► approved ─┬──[provider pauses]──► paused ──[provider reactivates]──► approved
                          │   (fallback: admin if no govt covers)  ├──[provider archives]──► archived
                          │
                          └──[govt or admin rejects]──► rejected
```

Un provider (org o vet independiente) **no puede tener slots si el offering no está en `approved`**. Si paused, los slots existentes quedan pero no se materializan nuevos. Si archived, slots futuros se cancelan automáticamente.

**Approval routing.** El approval request se enruta al govt cuya `govt_assignments` scope cubre `jurisdiction_locality` del offering. Si no hay govt covering esa locality, cae al admin queue. Mismo fallback que el symptom surveillance feature.

### 4.2 `service_schedule_rules`

```sql
create table service_schedule_rules (
  id                  uuid primary key default gen_random_uuid(),
  service_offering_id uuid not null references service_offerings(id) on delete cascade,
  days_of_week        smallint[] not null,          -- ISO 8601: 1=Mon..7=Sun
  start_time_local    time not null,
  end_time_local      time not null,
  effective_from      date not null,
  effective_until     date,                          -- null = open-ended
  timezone            text not null default 'America/Argentina/Buenos_Aires',
  status              text not null default 'active', -- 'active' | 'paused' | 'archived'
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint rule_time_window_sane check (end_time_local > start_time_local),
  constraint rule_dates_sane check (effective_until is null or effective_until >= effective_from),
  constraint rule_days_nonempty check (array_length(days_of_week, 1) > 0),
  constraint rule_status_valid check (status in ('active', 'paused', 'archived'))
);

create index schedule_rules_offering_active_idx on service_schedule_rules (service_offering_id) where status = 'active';
```

**Materialización**: el cron diario genera slots para los próximos 60 días según rules activas. Detalle en §8.

**Org puede tener N rules por offering** (e.g., "lunes/miércoles 9-12" + "viernes 14-17"). Cada rule materializa sus propios slots; no se superponen porque vienen de horarios distintos.

### 4.3 `time_slots`

```sql
create table time_slots (
  id                  uuid primary key default gen_random_uuid(),
  service_offering_id uuid not null references service_offerings(id) on delete cascade,
  rule_id             uuid references service_schedule_rules(id) on delete set null,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  capacity            int not null,                  -- snapshot from offering at materialization
  bookings_count      int not null default 0,        -- denormalized
  status              text not null default 'open',  -- 'open' | 'full' | 'cancelled'
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint slot_window_sane check (ends_at > starts_at),
  constraint slot_capacity_positive check (capacity > 0),
  constraint slot_bookings_non_negative check (bookings_count >= 0),
  constraint slot_bookings_within_capacity check (bookings_count <= capacity),
  constraint slot_status_valid check (status in ('open', 'full', 'cancelled'))
);

create unique index time_slots_unique_starts on time_slots (service_offering_id, starts_at);
create index time_slots_offering_window_idx on time_slots (service_offering_id, starts_at) where status = 'open';
create index time_slots_search_idx on time_slots (service_offering_id, starts_at) where status in ('open', 'full');
```

**`capacity` se snapshotea** del offering al momento de materializar. Si la org edita capacity después, slots futuros sin bookings se regeneran; slots con bookings o pasados quedan con su capacity original.

**`bookings_count` dual-write** desde el server action de booking. La constraint `bookings_count <= capacity` es el guardrail final contra race conditions; el advisory lock es la mitigación primaria.

### 4.4 `appointments`

```sql
create table appointments (
  id                       uuid primary key default gen_random_uuid(),
  public_token             text not null unique,           -- e.g. APT-XXXX-XXXX
  slot_id                  uuid not null references time_slots(id) on delete restrict,
  pet_id                   uuid not null references pets(id) on delete cascade,
  owner_user_id            uuid not null references profiles(id) on delete cascade,
  service_offering_id      uuid not null references service_offerings(id),  -- denormalized
  organization_id          uuid not null references organizations(id),       -- denormalized — appointment view shows it
  status                   text not null default 'confirmed',
  -- 'confirmed' | 'attended' | 'no_show' | 'cancelled_by_owner' | 'cancelled_by_org'

  attended_at              timestamptz,
  attended_by_user_id      uuid references profiles(id),
  cancelled_at             timestamptz,
  cancelled_by_user_id     uuid references profiles(id),
  cancellation_reason      text,
  no_show_marked_at        timestamptz,
  outcome_event_id         uuid references pet_events(id),  -- set when attendance fires the event
  reminder_id              uuid references reminders(id),   -- the parallel private todo
  notes_from_owner         text,
  notes_from_org           text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint appointment_status_valid check (status in (
    'confirmed', 'attended', 'no_show', 'cancelled_by_owner', 'cancelled_by_org'
  )),
  constraint appointment_outcome_only_when_attended check (
    (outcome_event_id is null) or (status = 'attended')
  )
);

create index appointments_pet_idx       on appointments (pet_id, created_at desc);
create index appointments_owner_idx     on appointments (owner_user_id, status);
create index appointments_org_idx       on appointments (organization_id, status);
create index appointments_slot_idx      on appointments (slot_id) where status = 'confirmed';
```

**Status transitions:**

```
confirmed ─┬─► attended (outcome_event_id set)
           ├─► no_show
           ├─► cancelled_by_owner
           └─► cancelled_by_org
```

Todos terminal después de `confirmed`. Para correcciones (vino y se marcó no_show por error), se emite un evento de corrección manual en la libreta del pet, no se mutate el appointment row.

### 4.5 Extensión a `reminders`

```sql
alter table reminders
  add column appointment_id uuid references appointments(id) on delete set null;
```

Reminder sin appointment = anotación privada del dueño (flujo "Agendar vacuna" actual). Reminder con appointment = backed por reserva real. La página "Próximas vacunas" muestra ambos casos mezclados, con badge "Reservado" cuando hay appointment.

### 4.6 Notification types nuevos

`Notification.notification_type` agrega valores (TEXT, sin migración):

- `service_offering_submitted` → al admin cuando una org somete una solicitud
- `service_offering_approved` → al org admin cuando se aprueba
- `service_offering_rejected` → al org admin cuando se rechaza, con motivo
- `appointment_booked_owner` → al owner cuando reserva
- `appointment_booked_org` → al org admin cuando alguien reserva un slot suyo
- `appointment_cancelled_by_owner` → al org cuando owner cancela
- `appointment_cancelled_by_org` → al owner cuando org cancela
- `appointment_attended` → al owner cuando se marca asistido (con CTA a su libreta sanitaria)
- `appointment_reminder_24h` → al owner 24h antes (out of scope para v1, ver §13)

## 5. Approval workflow

### 5.1 Org submits offering

Org admin (member con capability `service_offering.create`) abre `/refugio/servicios/nuevo`:

```
Form:
  - Tipo de servicio (select de service_kind catalog)
  - Nombre visible al público (text, e.g. "Antirrábica perro adulto")
  - Descripción (textarea, opcional)
  - Duración por slot (number, default 15 minutos)
  - Capacidad por slot (number, default 1)
  - Precio en pesos (number, opcional — vacío = gratis)
  - Especies elegibles (checkboxes: perro, gato, ambos)
  - Edad mínima en meses (number, opcional)
  - Edad máxima en meses (number, opcional)

Submit → createServiceOfferingAction:
  1. requireCapability('service_offering.create') — for org offerings; OR vet with professional.provider capability
  2. Insert service_offerings con status='pending_approval' and jurisdiction fields from provider
  3. Lookup govt users cuya scope cubre jurisdiction_locality del offering:
     - If govts found: Insert Notification para cada govt covering
       - type='service_offering_submitted'
       - title="Solicitud nueva: {service_kind} de {provider display_name}"
       - severity='info'
       - cta a /gob/servicios/{public_token}
     - If no govt covering: Insert Notification para todos los users con role='admin' (fallback)
       - Same shape but cta a /admin/servicios/{public_token}
  4. Redirect a /org/[orgToken]/servicios/{public_token} (org offering) OR /pro/servicios/{public_token} (vet offering) con badge "En revisión"
```

### 5.2 Govt / admin reviews

**Govt (locality-scoped)** abre `/gob/servicios`:

```
Lista de service_offerings con status='pending_approval' cuya jurisdiction_locality
está cubierta por al menos un govt_assignment del usuario actual.

Click → /gob/servicios/{public_token}:
  - Detalles completos del offering
  - Info del provider (org o vet, jurisdicción, verified status)
  - Botones:
    [Aprobar]         → submit a approveServiceOfferingAction
    [Rechazar]        → modal con textarea de motivo, submit a rejectServiceOfferingAction
```

**Admin (fallback)** abre `/admin/servicios`:

```
Lista de service_offerings con status='pending_approval' SIN govt covering su jurisdiction_locality.
Mismo UI que /gob/servicios pero scope universal.
```

`approveServiceOfferingAction`:
```
  1. requireRole('admin') (placeholder — admin page Fase 0 lo formaliza después)
  2. UPDATE service_offerings SET status='approved', reviewed_at=now(), reviewed_by_user_id=admin.id
  3. Insert Notification al org admin (todos los members con capability service_offering.create):
     - type='service_offering_approved'
     - title="Tu servicio fue aprobado: {display_name}"
     - severity='success'
     - cta="/refugio/servicios/{public_token}"
```

`rejectServiceOfferingAction`:
```
  1. requireRole('admin')
  2. Validar rejection_reason (required, min 30 chars)
  3. UPDATE service_offerings SET status='rejected', reviewed_at, reviewed_by_user_id, rejection_reason
  4. Insert Notification al org admin:
     - type='service_offering_rejected'
     - title="Tu solicitud fue rechazada: {display_name}"
     - body con motivo
     - severity='warning'
     - cta a /refugio/servicios/{public_token} (donde puede ver detalle + crear uno nuevo corregido)
```

### 5.3 Después de aprobación

La org ya puede crear schedule rules y los slots empiezan a materializarse (§8). La org no puede editar `service_kind` ni `price_ars` después de aprobado — eso requeriría nueva aprobación. Sí puede editar `display_name`, `description`, `slot_capacity`, `duration_minutes` (cambios cosméticos / operativos), `eligibility_*`. Para cambiar service_kind o el precio: crear un nuevo offering.

## 6. Org-side flow

### 6.1 Mis servicios

`/refugio/servicios` — lista de offerings de la org en cualquier status. Acciones por status:

| Status | Acciones disponibles |
|---|---|
| `pending_approval` | Ver detalles, cancelar solicitud (delete row) |
| `approved` | Editar (campos editables), gestionar agenda, ver bookings, pausar, archivar |
| `rejected` | Ver motivo, crear nuevo offering basado en este |
| `paused` | Reactivar, archivar |
| `archived` | (read-only) |

### 6.2 Gestionar agenda de un offering aprobado

`/refugio/servicios/{public_token}/agenda`:

- Lista de schedule rules activas con su descripción legible
- Botón "Agregar regla" → form:
  ```
  Días de la semana: checkboxes Lun/Mar/Mié/Jue/Vie/Sáb/Dom
  Hora desde: time picker
  Hora hasta: time picker
  Vigente desde: date picker (default hoy)
  Vigente hasta: date picker (opcional, vacío = sin fin)
  ```
- Cada rule existente tiene botón "Pausar" / "Archivar" / "Eliminar"
- Después de cualquier cambio, el job nocturno (§8) regenera slots. Para preview inmediato, hay un botón "Materializar ahora" que dispara el job para este offering específico.

### 6.3 Ver bookings del día

`/refugio/agenda` (dashboard agregado de todos los offerings de la org):

- Vista por día con todos los slots y appointments
- Cada slot muestra: hora, servicio, capacidad usada (e.g., "2/5 booked")
- Click en un slot → lista de appointments en ese slot
- Cada appointment muestra: pet name + photo, owner first name, owner phone, notes

### 6.4 Marcar asistencia o no_show

En la vista del appointment (`/refugio/agenda/turnos/{appointment_token}`):

```
Estado: Confirmado · {fecha hora}
Mascota: {pet name + foto}
Dueño: {first name + phone si disponible}
Notas del dueño: {notes_from_owner si hay}

[Marcar como atendido]
[Marcar como no_show]
[Cancelar este turno] (con motivo)
```

**Marcar como atendido** → form específico al `service_kind`:

- Para `vaccination_*`: campos para `vaccine_name` (default desde el service_kind), `brand`, `batch`, `administered_by`, `next_due_at`
- Para `sterilization_*`: campos para `procedure` (castration/spay), `performed_by`, `clinic`, `complications` opcional
- Para `general_checkup`: campos para diagnóstico, recomendaciones
- Etc. (cada service_kind mapea a un `pet_event` type con su payload propio)

Submit → `markAppointmentAttendedAction`:

```
Transacción atómica:
  1. requireCapability('appointment.attend') sobre la org
  2. Verificar appointment.status === 'confirmed'
  3. Construir payload del evento según service_kind y los datos del form
  4. validateEventPayload(eventType, payload) — Zod del hardening
  5. Insert pet_events:
     - event_type según service_kind (vaccination_administered, sterilization_performed, etc.)
     - occurred_at = slot.starts_at (truncado al día y hora del slot)
     - recorded_at = now
     - recorded_by_user_id = el actor (vet operando)
     - author_role = 'vet'
     - author_organization_id = appointment.organization_id
     - author_verified = (org.verified === true)
     - payload = el payload validado
  6. UPDATE appointments SET status='attended', attended_at=now, attended_by_user_id, outcome_event_id=<new>
  7. UPDATE reminders SET completed_at=now WHERE id=appointment.reminder_id
  8. Insert Notification al owner:
     - type='appointment_attended'
     - title="Listo. La vacuna quedó en la libreta de {pet.name}."
     - body con detalles del evento
     - severity='success'
     - cta a /mis-mascotas/{pet.publicToken}/libreta
```

**Marcar como no_show** → simple update + notification (sin event):
```
  UPDATE appointments SET status='no_show', no_show_marked_at=now
  Notification al owner: "No te presentaste al turno de {servicio} el {fecha}.
                         Si fue un error o querés reagendar, contactá a {org}."
```

**Cancelar turno (org-initiated)** → modal con motivo, update + notification al owner. El slot recupera 1 unidad de capacidad (decrement `bookings_count`).

## 7. Owner-side flow

### 7.1 Entry points

Dos vías al booking:

**Desde el flujo de "Programar vacuna" existente** — el form actual queda intacto. Al final, agregar un link:

```
Form actual de programar vacuna:
  - Vaccine name
  - Due date
  - Notes
  - [Programar vacuna] (crea Reminder privado — comportamiento actual)

  ────────────────

  ¿Querés reservar un turno real?
  → Buscar turnos disponibles para esta vacuna
```

El link lleva a `/turnos/buscar?service_kind=vaccination_rabies` (mapping vaccine name → service_kind).

**Desde una entrada nueva en /mis-mascotas/{token}**:

```
Acciones (sección):
  Programar vacuna (→ flujo actual)
  Buscar turno en una clínica (→ /turnos/buscar)  [NEW]
```

### 7.2 Búsqueda

`/turnos/buscar`:

```
Filters:
  - Tipo de servicio (select de service_kind catalog) [required]
  - Provincia (default: jurisdicción de la mascota)
  - Localidad (default: jurisdicción de la mascota)
  - Mascota a reservar (select de las mascotas del owner)
  - Desde / Hasta (date range, default próximos 30 días)

Results: list de slots disponibles ordenados por fecha asc, agrupados por org.

Cada result row:
  Fecha + hora
  Org name + logo
  Org dirección (si disponible)
  Precio (gratis / $X)
  Capacidad disponible ("3 de 5 cupos")
  [Reservar]

Si el offering tiene eligibility (species/age) que no match con la mascota seleccionada → row aparece deshabilitada con tooltip "Este servicio es para gatos, tu mascota es perro" (etc.).
```

Query SQL aproximada:

```sql
SELECT
  ts.*, so.*, o.*
FROM time_slots ts
JOIN service_offerings so ON so.id = ts.service_offering_id
JOIN organizations o ON o.id = so.organization_id
WHERE ts.status = 'open'
  AND ts.bookings_count < ts.capacity
  AND ts.starts_at >= :from
  AND ts.starts_at <= :until
  AND so.status = 'approved'
  AND so.service_kind = :service_kind
  AND o.verified = true
  AND o.status = 'active'
  AND (o.jurisdiction_province = :province OR :province IS NULL)
  AND (o.jurisdiction_locality = :locality OR :locality IS NULL)
ORDER BY ts.starts_at ASC
LIMIT 100;
```

### 7.3 Reserva

Click "Reservar" → form de confirmación:

```
Estás por reservar:
  Servicio: {display_name}
  Org: {org.display_name}
  Fecha: {slot.starts_at fmt}
  Mascota: {pet.name + foto}
  Precio: {gratis / $X}

  Notas para el veterinario (opcional):
  [textarea]

  [Confirmar reserva]
```

Submit → `bookSlotAction`:

```
Transacción atómica con advisory lock:
  1. requirePetByToken(petToken) — confirma ownership
  2. pg_advisory_xact_lock(hashtextextended(slot_id::text, 0))
  3. SELECT slot ... FOR UPDATE
     Verificar: status='open' AND bookings_count < capacity AND starts_at > now()
     Si NO: return { error: "Este turno ya no está disponible. Buscá otro." }
  4. Verificar eligibility:
     - species en eligibility_species (si está set)
     - pet age vs eligibility_age_min/max_months (si están set)
     Si NO: return { error: específico al criterio que falla }
  5. Verificar que no haya otro appointment del mismo pet en el mismo slot
     (constraint suave anti doble-booking)
  6. Insert appointments:
     - status='confirmed'
     - public_token generado
     - service_offering_id, organization_id denormalizados
     - reminder_id se setea en el step 8
  7. UPDATE time_slots SET bookings_count = bookings_count + 1
     Si bookings_count llega a capacity → status='full'
  8. Insert reminders con appointment_id=<new>:
     - reminder_type según service_kind (vaccine / appointment / etc.)
     - due_at = slot.starts_at
     - title = "{service display_name} - {org.display_name}"
     - description con info adicional
  9. UPDATE appointments SET reminder_id=<new>
  10. Insert Notification al owner:
      - type='appointment_booked_owner'
      - title="Turno confirmado: {service} el {fecha}"
      - body con detalles + cta a /mis-turnos/{appointment_token}
  11. Insert Notification a admins de la org:
      - type='appointment_booked_org'
      - title="Nueva reserva: {pet.name} para {service} el {fecha}"
Commit.
```

Race-resolution: el advisory lock serializa accesos al slot. La constraint `bookings_count <= capacity` es la última red.

### 7.4 Ver mis turnos

`/mis-turnos` — lista de appointments del owner:

```
Próximos:
  {fecha hora} · {servicio} · {org} · {pet.name}
  [Cancelar]    [Ver detalles]

Pasados:
  {fecha} · {servicio} · {org} · {pet.name}
  Estado: Atendido / No te presentaste / Cancelado
  Si atendido: link a la entrada en la libreta sanitaria del pet
```

### 7.5 Detalle del turno

`/mis-turnos/{appointment_token}`:

```
{service display_name}
{Org name + logo + dirección + teléfono si disponible}

Fecha: {slot.starts_at}
Mascota: {pet.name + foto}
Precio: {gratis / $X}
Estado: Confirmado / Atendido / No_show / Cancelado

Si confirmed y starts_at > now:
  [Cancelar este turno]
Si attended:
  Listo. Ver en la libreta sanitaria de {pet.name} → (link)
Si cancelled:
  Cancelado el {date} {reason si hay}
  [Reservar otro]
```

### 7.6 Cancelación por el owner

`cancelAppointmentByOwnerAction`:

```
Atomic transaction:
  1. Verificar appointment.owner_user_id === session.user.id
  2. Verificar appointment.status === 'confirmed' AND slot.starts_at > now
  3. UPDATE appointments SET status='cancelled_by_owner', cancelled_at, cancelled_by_user_id
  4. UPDATE time_slots SET bookings_count = bookings_count - 1
     Si era 'full' → vuelve a 'open'
  5. UPDATE reminders SET completed_at=now (cierra el todo asociado)
  6. Notification a la org: appointment_cancelled_by_owner
Commit.
```

**No hay penalización por cancelar.** Si la fricción es necesaria (no-show pattern), se evalúa más adelante.

## 8. Materialización de slots

Script cron `scripts/materialize-slots.ts` corre diariamente (sugerido 3am AR time). Idempotent.

```ts
const HORIZON_DAYS = 60;
const now = new Date();
const horizon = addDays(now, HORIZON_DAYS);

for each schedule_rule WHERE status='active' AND (effective_until IS NULL OR effective_until >= today):
  if rule.service_offering.status !== 'approved':
    continue  // pausados/archivados/etc. no generan slots

  for each date D between max(today, rule.effective_from) and min(horizon, rule.effective_until ?? horizon):
    if dayOfWeekISO(D) IN rule.days_of_week:
      compute slots within [start_time_local, end_time_local) chunked by service_offering.duration_minutes
      for each (slot_start, slot_end):
        compute timestamptz from local + timezone
        INSERT INTO time_slots (offering_id, rule_id, starts_at, ends_at, capacity, status)
          VALUES (..., service_offering.slot_capacity, 'open')
          ON CONFLICT (service_offering_id, starts_at) DO NOTHING
```

**Job para regenerar de un solo offering** (botón "Materializar ahora" en §6.2): mismo código pero filtrado al offering específico. Útil cuando la org acaba de crear una rule y quiere ver los slots inmediatamente.

**Borde — offering pasa de approved a paused/archived**: slots futuros sin bookings se marcan `status='cancelled'` (no se borran). Slots con bookings activos quedan abiertos hasta resolución (asistencia, no_show, cancel). El job verifica esto en cada corrida.

**Borde — schedule rule editada**: lo mismo. Slots futuros sin bookings de la rule editada se borran y se re-materializan con los nuevos parámetros. Con bookings: quedan con los parámetros viejos.

**Borde — capacity del offering cambia**: solo aplica a slots futuros sin bookings. Slots con bookings (incluso parciales) mantienen su capacity original.

## 9. UI surfaces — resumen

### Org-side (route group `/refugio` existente)

| Ruta | Quién | Función |
|---|---|---|
| `/refugio/servicios` | Org admin con `service_offering.create` | Lista de offerings de mi org |
| `/refugio/servicios/nuevo` | Idem | Form para crear nuevo offering (status pending_approval) |
| `/refugio/servicios/{token}` | Idem | Detalle de un offering, acciones según status |
| `/refugio/servicios/{token}/agenda` | Idem (approved only) | Gestión de schedule rules + slots |
| `/refugio/agenda` | Org admin con `appointment.view` | Dashboard de bookings del día |
| `/refugio/agenda/turnos/{token}` | Idem | Detalle de un appointment, marcar attended/no_show/cancel |

### Owner-side (route group `/(app)`)

| Ruta | Función |
|---|---|
| `/turnos/buscar` | Búsqueda de slots disponibles con filtros |
| `/mis-turnos` | Lista de mis appointments (futuros + pasados) |
| `/mis-turnos/{token}` | Detalle de un appointment, cancel si futuro |
| `/mis-mascotas/{token}/eventos/nuevo/vacuna` | El flujo actual extendido con link a "Buscar turnos" |
| `/mis-mascotas/{token}` | Pet profile con sección "Próximas vacunas" mezclando reminders puros + con appointment |

### Admin-side (route group `/admin`, mínimo viable hasta admin page Fase 0)

| Ruta | Quién | Función |
|---|---|---|
| `/admin/servicios` | `profiles.role='admin'` | Lista de pending_approval para revisión |
| `/admin/servicios/{token}` | Idem | Detalle + aprobar / rechazar |

Cuando admin page Fase 0 mergee, estos URLs migran al `/admin/cola` unificado y los datos de `service_offerings.status` se sincronizan con `approval_requests`. Migración trivial.

## 10. RLS

**`service_offerings`:**
- SELECT: org members + admin + público (cuando `status='approved'`, para discovery)
- INSERT: org members con capability `service_offering.create`
- UPDATE: org members (campos no-restringidos), admin (status transitions)
- DELETE: org members solo si `status='pending_approval'` (cancelar antes de revisión)

**`service_schedule_rules`:**
- SELECT: org members + público (lectura inferida de los slots públicos)
- INSERT/UPDATE/DELETE: org members con capability

**`time_slots`:**
- SELECT: público (es la disponibilidad)
- INSERT: solo via materialization script (service_role)
- UPDATE: server actions (bookings_count, status)
- DELETE: solo via materialization en cleanup

**`appointments`:**
- SELECT: owner_user_id + organization members + admin
- INSERT: server actions (booking)
- UPDATE: server actions

**Server actions como authorization boundary**, igual que el resto del repo. RLS es defense-in-depth.

## 11. Integración con sistemas existentes

### 11.1 Reminders coexistence

El form actual de `/mis-mascotas/{token}/vacunas/programar` queda **intacto**. Al final, agregar un link al search:

```
Después del submit del form:
  o ¿Preferís reservar un turno real en una clínica? Buscar disponibles →
```

Si el dueño usa el form viejo → solo crea Reminder, sin appointment. Comportamiento idéntico a hoy.

Si el dueño va por el link → llega a `/turnos/buscar` pre-filteado por service_kind. Booking crea Reminder + Appointment linkeados.

La página `/mis-mascotas/{token}` muestra "Próximas vacunas" como una mezcla:

- Reminder sin appointment: "Antirrábica · 2026-08-15 · Programado por vos" + botón "Buscar turno"
- Reminder con appointment: "Antirrábica · 2026-05-25 09:30 · Clínica San Telmo · Confirmado" + botón "Ver turno"

### 11.2 Libreta sanitaria

Cuando se marca asistencia, el `pet_event` emitido (vaccination_administered, sterilization_performed, etc.) es libreta-sanitaria event (ya están en `LIBRETA_SANITARIA_EVENT_TYPES`). Aparece automáticamente en `/mis-mascotas/{token}/libreta` cuando esa ruta exista (libreta sanitaria Parte B).

El `appointment.outcome_event_id` da el link bidireccional: desde el appointment veo el evento, desde el evento veo el appointment.

### 11.3 Org portal existente

El feature usa el route group `/refugio/*` que ya existe. Sumamos `/refugio/servicios` y `/refugio/agenda`. Los capabilities de `service_offering.*` y `appointment.*` se agregan al sistema de capabilities existente (`lib/capabilities.ts`).

## 12. Phasing

**Fase 0 — Schema foundation (1 PR).** Migración de 4 tablas (service_offerings, service_schedule_rules, time_slots, appointments) + `reminders.appointment_id` FK. Drizzle models. Zod schemas. RLS básica. Notification types nuevos.

**Fase 1 — Approval workflow (1 PR).** Server actions: createServiceOfferingAction, approveServiceOfferingAction, rejectServiceOfferingAction. Routes `/refugio/servicios`, `/refugio/servicios/nuevo`, `/refugio/servicios/{token}`. Mínima ruta `/admin/servicios` para review.

**Fase 2 — Org schedule management (1 PR).** Routes `/refugio/servicios/{token}/agenda`. Server actions para CRUD de schedule_rules. Tests del impacto en materialización.

**Fase 3 — Slot materialization (1 PR).** Script `scripts/materialize-slots.ts` + cron route `/api/cron/materialize-slots`. Botón "Materializar ahora" para regeneración manual de un offering. Tests de idempotencia + bordes (paused, archived, capacity changes).

**Fase 4 — Owner search + book (1 PR).** Routes `/turnos/buscar`, `/mis-turnos`, `/mis-turnos/{token}`. Server action `bookSlotAction` con advisory lock. Tests de race condition.

**Fase 5 — Org booking management + attendance (1 PR).** Routes `/refugio/agenda` (dashboard del día), `/refugio/agenda/turnos/{token}`. Server actions markAppointmentAttended, markAppointmentNoShow, cancelAppointmentByOrg. Forms específicos por service_kind para el payload del evento.

**Fase 6 — Owner cancellation (1 PR).** Server action cancelAppointmentByOwner. UI en `/mis-turnos/{token}`.

**Fase 7 — Existing form integration (1 PR).** Modify `/mis-mascotas/{token}/vacunas/programar` para agregar link a `/turnos/buscar`. Modify `/mis-mascotas/{token}` para mostrar la mezcla reminder/appointment.

**Fase 8 — Polish (1 PR opcional).** 24h reminder notification (cron). Logos de orgs en search results. Filtros adicionales (precio, próximos N días).

Cada fase es 1 PR. Total ~8 PRs chicos, ~2 semanas de trabajo.

## 13. Lo que NO está en este diseño

- **Polimorfismo provider** (org o vet individual): solo orgs. Vets independientes ofrecerán turnos via la org donde trabajan
- **Campaigns como entidad propia**: un offering subsidiado por la CABA es solo `price_ars=null` + display_name explicativo. Si más adelante hay reporting agregado de campañas, se modela como tabla aparte
- **Confirmation modes** (manual / instant): solo instant. Si una org necesita filtrar, define menos slots
- **Multi-pet booking en un solo slot** (un dueño con 3 perros reservando todos para el mismo slot batch): si el slot tiene capacity 3, hace 3 reservas separadas
- **Email transaccional**: solo in-app Notifications hasta que exista provider
- **Pagos online**: `price_ars` es informativo. El pago se gestiona offline
- **No-show penalty / rate-limit**: sin tracking de patrones. Si en producción se ve abuso, se agrega
- **Lista de espera**: si un slot está full y luego alguien cancela, no hay flujo automático de "alguien estaba esperando, le aviso"
- **Cross-org search** (campaña coordinada de varias clínicas): cada org tiene sus offerings independientes. La búsqueda los junta naturalmente
- **24h reminder automation**: anotada como Fase 8 opcional, no crítica para el v1
- **Bulk attendance** (org marca 20 atendidos juntos): schema soporta, UX deferred
- **Appointment rescheduling**: cancelar + reservar otro. Sin "mover este turno a otro slot" directo
- **Recurrences avanzadas** (primer martes del mes, cada 2 semanas): RRULE deferred hasta que aparezca caso real
- **Multi-locality coverage por org**: la org tiene UNA jurisdicción. Si una org opera en varios barrios, modela esto via `organization_coverage` que ya existe (usada por lost-pet broadcast). La búsqueda de turnos solo filtra por jurisdicción de la org en v1
- **`appointment_attended` event type separado**: no se introduce. La asistencia se traduce directamente al `pet_event` médico que corresponde por service_kind

---

## Próximo paso

Cuando este diseño tenga OK, el plan ejecutable lo escribimos siguiendo el formato de los otros planes en `docs/superpowers/plans/`. Las 8 fases son secuenciales en dependencias (cada una construye sobre la anterior) pero cada una es entregable independiente.

Si querés ajustar antes del plan: catálogo de `service_kind` (qué servicios entran en v1), defaults de duración/capacity, copy de notifications, o cualquier cosa del flujo — decímelo y lo reflejo acá. Cambiar después del plan cuesta más.
