# Listado de voluntarios para tránsito — design spec

> Pool público de owners voluntarios que se ofrecen para hospedar temporalmente animales de refugios, con preferences declaradas (especies, tamaño, razas excluidas, etc.). Las orgs verified buscan en el pool y proponen tránsitos concretos a un voluntario para un pet específico; el voluntario acepta con timeframe estimado o rechaza con motivo. **Voluntarios deben ser usuarios DIM completos (DNI verificado + perfil hidratado)** — esto los habilita a fluir directamente al proceso de adopción si más adelante deciden adoptar al animal en tránsito, sin re-onboarding. Complementa los dos flows de tránsito ya existentes (foster member-based + vecino-en-tránsito reactivo) cubriendo el caso "owner que quiere ayudar pero no es miembro del refugio ni encontró un animal en la calle".
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC — plan ejecutable en `plans/2026-05-18-foster-volunteers-pool.md` (a escribir post-OK)
> **Versión:** 1.4

### Changelog

| Versión | Fecha | Cambios |
|---|---|---|
| **v1.4** | 2026-05-18 | **Resolución de las 8 open questions.** (a) D16: modelo de slots — cada inscripción genera 1 slot; aceptar foster lo consume; tras termination el sistema pregunta "¿volver al pool?". El voluntario nunca recibe propuestas si slots=0. (b) D17: co-foster opt-in — el primer foster marca explícitamente si permite que la org asigne un co-foster simultáneo sobre el mismo pet. (c) D18: cascade auto-cancel — cuando un voluntario acepta una propuesta y sus slots llegan a 0, las otras propuestas pending al mismo voluntario se cancelan automáticamente. (d) Eliminada tabla `org_proposal_settings` (settings mínimas, no necesarias en v1). (e) `notes` del voluntario ahora visible en el listado (no solo detalle). (f) Visibility agregada de aceptaciones/rechazos históricos del voluntario, sin detalle por org. Status: 🟢 Ready for CC. |
| v1.3 | 2026-05-18 | D15 + §6.10: capacidades plenas del foster como owner durante el tránsito. Entry point revertido a `/cuenta/ofrecerme-como-tránsito`. |
| v1.2 | 2026-05-18 | D14 adoption eligibility + §6.3 surface unificado tránsitos + §6.9 end-of-flow + §17 listado no-aptas. (Entry point a `/mis-mascotas/voluntario` revertido en v1.3.) |
| v1.1 | 2026-05-18 | D13 (pre-condiciones) + §15 (adoption pathway) + §16 (post-adoption tracking). |
| v1.0 | 2026-05-18 | Versión inicial. |

---

## 1. El gap que cierra

DIM tiene dos paths para tránsito hoy:

1. **Foster member-based** (`app/actions/foster.ts`). Refugio con `foster.assign` capability asigna a un **miembro activo de su org** como foster. Coexiste con `shelter_custody`. Sirve para refugios con equipo estable de voluntarios formalizados.
2. **Vecino-en-tránsito** (`plans/2026-05-16-vecino-mascota-en-transito.md` ✅ implementado). Un vecino reactivo encuentra un perro en la calle, lo declara y queda como `shelter_custody` directo en su propio profile. Es un descubrimiento, no una afiliación.

**Lo que falta**: el owner proactivo. Una persona que vive en CABA, tiene su perro Pepe registrado en DIM, ve que el refugio del barrio está saturado, y quiere ofrecer su casa por algunas semanas. Hoy no tiene cómo expresar esa disponibilidad. El refugio tampoco tiene cómo descubrirlo. La oferta y la demanda existen pero no se cruzan.

Este flow se llama tradicionalmente **foster network** en refugios anglosajones (Best Friends, ASPCA, RSPCA) y en AR funciona vía WhatsApp grupos cerrados (El Campito tiene ~200 voluntarios en una lista privada, Patitas Vagabondas idem). El espacio digital está vacío. DIM tiene la base perfecta para llenarlo: los owners ya están en el sistema, las orgs verified también, las capabilities existen.

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| D1 | **Pool global de voluntarios, no por-org**. Una sola tabla `foster_volunteers` con una row por owner que se ofrece. Visible a todas las orgs verified con `foster.assign` capability | El voluntario ofrece su casa al ecosistema, no a una org específica. Patitas Vagabondas y El Campito pueden ambos proponerle. Replicar "membership por org" para esto inflaría memberships sin razón |
| D2 | **El voluntario NO es organization_member**. Su ownership row `role='foster'` que se materializa post-aceptación existe sin `organization_membership` | Member significa "soy parte del equipo del refugio" — un voluntario eventual no es eso. Relax el check actual de `assignFosterAction` que exige membership: el nuevo path (proposal-accepted → materializa foster) no pasa por ese action, va por `acceptFosterProposalAction` que crea ownership directo |
| D3 | **Org-initiated solamente en v1**. El voluntario NO browse pets disponibles; sólo declara su disponibilidad y espera propuestas. La org busca el pool y propone | UX simpler. El owner típico no quiere "elegir" un pet — quiere ofrecer ayuda y dejar que el experto (refugio) decida el match. Browse-by-volunteer abre fricción (qué hace si el pet que le gusta ya tiene foster?), expectativas raras, etc. Si emerge demanda, se agrega después |
| D4 | **Multi-propuesta paralela permitida sin auto-cancel**. Una org puede proponer a varios voluntarios para el mismo pet; un voluntario puede recibir varias propuestas de distintas orgs simultáneamente. Cuando uno acepta, las otras propuestas a OTROS voluntarios para el mismo pet quedan operativamente vencidas (la org las cancela manualmente) | No auto-cancel evita race conditions complejas. Operativamente: cuando un voluntario acepta, la org cierra las otras propuestas pendientes por ese pet. Es 1 acción extra por parte de la org, manageable |
| D5 | **Match constraints son guidelines, no validaciones duras**. Si una org propone un pet de raza PPP a un voluntario que NO marcó `accepts_dangerous_breeds=true`, el sistema **avisa con warning** pero NO bloquea. El voluntario decide al recibir la propuesta | El refugio tiene contexto. Quizás conoce al voluntario y sabe que puede manejarlo aunque no haya marcado el toggle. Bloquear duro sería paternalista. El warning visible al proponer cubre el riesgo de mismatch accidental |
| D6 | **Pet siempre concreto en la propuesta**. La org elige UN pet específico de los que tiene en `shelter_custody` activo, no propone "tránsito genérico" | Las propuestas abstractas ("¿estás disponible en general?") son ruido. Cada propuesta es decisión concreta sobre un animal real, con foto, edad, contexto |
| D7 | **PPP excluidas por default**. Cuando un volunteer se registra, `accepts_dangerous_breeds=false` es el default. Tiene que opt-in explícito con confirmation | Coherente con el modelo legal AR (PPP requiere atestación + responsabilidad legal extra). Default conservador. Opt-in muestra disclaimer sobre responsabilidad |
| D8 | **Locality del voluntario es opcional**. El voluntario indica su locality si quiere (para que la org filtre por proximidad), pero puede dejar vacío. La org puede proponer al voluntario fuera de su jurisdicción operativa (caso emergencia) | Lo importante es la voluntad, no el barrio. La org tiene contexto para decidir si vale la pena coordinar handoff cross-locality |
| D9 | **Estado del voluntario: `active` | `paused` | `withdrawn`**. Paused = vacaciones, sin propuestas nuevas pero sus tránsitos en curso siguen. Withdrawn = retirada formal del pool (la row queda histórica) | Paused permite ausencias temporales sin re-onboarding. Withdrawn es terminal pero no destructivo |
| D10 | **Propuestas tienen expiración suave de 7 días**. Después de 7 días sin respuesta, la propuesta se marca `expired` automáticamente vía el cron de auto-expiry de Fase 14 (admin page) | Evita ruido permanente. El cron ya existirá; reusamos. El voluntario que se demora puede pedir a la org que vuelva a proponer |
| D11 | **Foster materializado tras aceptación NO requiere `foster.assign` capability de la org**. La aceptación del voluntario es el evento autoritativo; la org solo tuvo que tener la capability para *proponer*. Materializar ownership es consecuencia técnica | Evita check duplicado. El gating está en el proposal step, no en el materialize step |
| D12 | **Notification al refugio cuando volunteer acepta es obligatoria; cuando rechaza opcional según preference del refugio** | Aceptaciones cambian el estado operacional del refugio (animal a entregar). Rechazos son señal informativa, menos urgente. La org puede silenciar rejections en sus settings |
| D13 | **Pre-condiciones de inscripción al pool**: el owner debe tener (a) cuenta DIM activa (auth.users + profiles), (b) `dniVerified=true`, (c) `display_name` no vacío, (d) `phone` declarado (no obligatorio en DB hoy pero requerido para esta capability — la org necesita un canal de contacto operativo). Sin cualquiera de estos, el form de inscripción muestra el step faltante con CTA específico (ej. "Verificá tu DNI primero → /cuenta/verificar-dni") | El voluntario va a hospedar un animal de un refugio en su casa. La org necesita confianza en la identidad (DNI verificado) y un canal de comunicación operativo (phone). Y crucialmente: si más adelante el foster decide adoptar el animal, el flow de adopción ya tiene todos los datos que necesita — no hay re-onboarding (ver §15). Esto eleva la barra del pool comparado con el adopter-stub que crea el adoption flow hoy (`dniVerified=false`, sin auth user); el foster es alguien "real" en DIM desde el inicio |
| D14 | **Adoption eligibility flag por pet, set por la org al intake**. Columna `pets.adoption_eligible` (boolean, nullable). `null`=no determinado todavía (default al pet_registered); `true`=apta para adopción; `false`=no apta con motivo estructurado en `pets.adoption_ineligible_reason`. Cambios al flag generan event `adoption_eligibility_set` en `pet_events`. Pets no aptas pueden recibir foster igual — eligibility solo controla visibility en `/adoptar` futuro y aparición en el listado "no aptas" de la org | Caso real: refugio rescata un perro con parvo. Está en tránsito médico, recibe foster cuando se estabilice, pero NO está apta para adopción hasta que termine el tratamiento. Sin este flag, el pet aparecería en la lista pública de adopción genérico con riesgo de zoonosis o expectations rotas. La razón es estructurada (medical / behavioral / legal / quarantine / recovery / other) para que el listado especial pueda agruparlas operativamente |
| D15 | **Foster tiene capacidades plenas como owner durante el tránsito**. La ownership row `role='foster'` da acceso TOTAL al pet para todas las acciones de cuidado diario: registrar pet_events de cualquier libreta-sanitaria type (`weight`, `vaccination_administered`, `vet_visit`, `medication_administered`, `clinical_info_logged`, `symptom_observed`, etc.), agregar photos, marcar lost/found, ver y editar credencial pública con disclosure prefs, configurar chapas físicas, generar libreta para el vet, etc. La única restricción son las acciones que tocan **ownership o terminal state**: `adoption_finalized`, `custody_transferred`, `death_recorded` (estas siguen siendo de la org o requieren approval workflow) | El user lo expresó claro: "la persona que lo tiene en tránsito PUEDE hacer cualquier cosa como si fuera propia la mascota". Esto refleja la realidad del foster — vive con el animal, lo cuida diariamente, lleva la libreta sanitaria al día, lo ve enfermo y va al vet. Restringir esas capacidades es contraproducente operativamente y desincentiva ser foster. La org mantiene la authority sobre las acciones que cambian ownership/terminan el animal — esas son decisiones del refugio, no del foster |
| D16 | **Modelo de slots single-use por inscripción**. `foster_volunteers.available_slots` (int, default 0). Cada inscripción al pool incrementa +1 slot. Al aceptar una propuesta, -1 slot. Si slots=0, el voluntario NO aparece en searches de orgs y NO recibe propuestas nuevas. Cuando un foster termina (cualquier vía de §6.9), el sistema notifica al voluntario preguntando "¿querés volver al pool?" — su respuesta afirmativa hace +1 slot. La inscripción al pool puede repetirse en cualquier momento (incluso teniendo fosters activos): el voluntario que sabe que tiene capacity para 2 simultáneos se anota 2 veces y queda con 2 slots disponibles | Modelo elegido por Nacho: "se anota 1 vez, se le asigna, queda completo. Si se anota de nuevo, puede recibir otro." Esto evita el problema de la disponibilidad ambigua (¿está abierto a recibir? ¿tiene capacidad?). El voluntario manifiesta intención explícita cada vez. La pregunta automática post-termination cierra el ciclo proactivamente: el sistema no asume que el voluntario quiera volver, le pregunta |
| D17 | **Co-foster opt-in por el primer foster**. Al aceptar una propuesta, el voluntario marca un checkbox opcional "Permito que la org asigne otro co-foster a este pet mientras yo lo cuide". Si lo marca, la org puede proponer un segundo (o tercer) voluntario sobre el mismo pet. Cada uno tiene su propia ownership row `role='foster'` activa simultánea. Si CUALQUIER foster activo del pet tiene `allow_co_foster=false`, la org no puede agregar más fosters sobre ese pet | Default conservador: no co-foster a menos que el primer foster lo permita. Caso de uso real: pareja que comparte el cuidado pero figuran como dos hogares distintos en DIM (raro pero existe); o foster que toma uno y dice "OK puedo recibir otro de la misma camada". Sin el flag explícito, el primer foster controla — su decisión, su casa |
| D18 | **Cascade auto-cancel al consumir el último slot**. Cuando un voluntario acepta una propuesta y sus `available_slots` queda en 0, **todas las otras propuestas pending dirigidas a este mismo voluntario** se marcan automáticamente `status='cancelled'` con `cancellation_reason='volunteer_accepted_another'`. Las orgs afectadas reciben notification informándoles. Si el voluntario tenía slots > 1 (caso "me anoté 2 veces"), aceptar una solo descuenta 1 — las otras propuestas pending siguen activas porque aún tiene capacity | Decisión limpia para evitar UX rara: si el voluntario solo tenía 1 slot, las 2 propuestas pending de otras orgs ya no pueden ejecutarse (el slot ya se fue). Mejor cerrarlas explícitamente con razón clara que dejarlas pending indefinidamente hasta que expiren (cron 7d). Si el voluntario tenía slots múltiples, no hay cascade — las propuestas restantes son válidas |

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **Foster volunteer** | Owner que se ofrece como caregiver temporal voluntario para pets de refugios | `foster_volunteers` (tabla nueva) |
| **Volunteer preferences** | Restricciones declaradas: especies, tamaños, razas excluidas, duración max, etc. | Columnas en `foster_volunteers` |
| **Foster proposal** | Propuesta concreta de org→voluntario para un pet específico con timeframe estimado | `foster_proposals` (tabla nueva) |
| **Match warning** | Aviso (no error) cuando una propuesta cruza una preference del voluntario | Computed at propose-time, render-only |
| **Foster cycle** | Período entre `foster_assigned` y `foster_ended` | Eventos existentes en `pet_events` |
| **Active foster** | Volunteer con `status='active'` que recibe propuestas | Filtro de la query principal |

## 4. Domain model

### 4.1 Tabla `foster_volunteers`

```sql
create table foster_volunteers (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null unique references profiles(id) on delete cascade,

  -- Status — operational state of the volunteer relationship with DIM
  status                        text not null default 'active',         -- 'active' | 'paused' | 'withdrawn'

  -- Slots (D16): each enrollment to the pool adds +1; each acceptance subtracts 1.
  -- When available_slots=0 the volunteer does NOT appear in org searches.
  -- Default 0: nobody appears in the pool until they explicitly enroll.
  available_slots               integer not null default 0,

  -- Geography (optional — for filter by proximity)
  jurisdiction_province         text,
  jurisdiction_locality         text,

  -- Species accepted (at least one required when status='active')
  accepts_dogs                  boolean not null default false,
  accepts_cats                  boolean not null default false,
  accepts_other_species         boolean not null default false,        -- conejo, hurón, cobayo, etc.

  -- Size (applies primarily to dogs; ignored for species where N/A)
  accepts_size_small            boolean not null default true,         -- <10 kg
  accepts_size_medium           boolean not null default true,         -- 10-25 kg
  accepts_size_large            boolean not null default false,        -- >25 kg

  -- Age preferences
  accepts_puppies               boolean not null default false,        -- <4 months, incomplete vacc, more attention
  accepts_seniors               boolean not null default true,         -- >7 years, chronic care more likely

  -- Special needs
  accepts_chronic_conditions    boolean not null default false,        -- diabetic, post-surgery, etc.
  accepts_dangerous_breeds      boolean not null default false,        -- PPP per CABA 4078 / Prov 14.107

  -- Operational preferences
  max_duration_weeks            integer,                                -- null = open-ended
  household_other_pets          boolean,                                -- has other pets at home (info for org)
  household_kids                boolean,                                -- has kids at home (info for org)

  -- Free text
  notes                         text,                                   -- "Trabajo desde casa, tengo patio, etc."

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint foster_volunteers_status_valid check (status in ('active','paused','withdrawn')),
  constraint foster_volunteers_slots_non_negative check (available_slots >= 0),
  constraint foster_volunteers_at_least_one_species check (
    status != 'active'
    or (accepts_dogs or accepts_cats or accepts_other_species)
  )
);

-- Searchable pool: active status AND available_slots > 0
create index foster_volunteers_pool_idx
  on foster_volunteers (status)
  where status = 'active' and available_slots > 0;

create index foster_volunteers_locality_idx
  on foster_volunteers (jurisdiction_province, jurisdiction_locality)
  where status = 'active' and available_slots > 0;

create index foster_volunteers_user_idx on foster_volunteers (user_id);
```

**Notas:**
- `user_id` UNIQUE: un owner solo aparece una vez en el pool.
- El CHECK garantiza que un voluntario `active` tiene al menos una especie aceptada. Si edita y deja todas en false, el sistema fuerza pasar a `paused` o re-elegir especie.
- Locality es FK conceptual al catálogo INDEC cuando se implemente (Fase E del plan de localidades). Hasta entonces es TEXT.

### 4.2 Tabla `foster_proposals`

```sql
create table foster_proposals (
  id                            uuid primary key default gen_random_uuid(),
  public_token                  text not null unique,                  -- "FP-XXXX-XXXX"

  -- Parties
  organization_id               uuid not null references organizations(id) on delete cascade,
  volunteer_user_id             uuid not null references profiles(id) on delete cascade,
  pet_id                        uuid not null references pets(id) on delete cascade,
  proposed_by_user_id           uuid not null references profiles(id),  -- the org member who initiated

  -- Org-side proposal data
  proposed_at                   timestamptz not null default now(),
  proposed_duration_weeks       integer,                                -- estimate; null = open-ended
  proposed_notes                text,                                   -- "Pepe es un golden manso, vacc al día, etc."
  match_warnings                jsonb not null default '[]'::jsonb,    -- snapshot of mismatches at propose-time
  expires_at                    timestamptz not null,                   -- proposed_at + 7 days

  -- Status
  status                        text not null default 'pending',        -- 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled'

  -- Volunteer-side response
  responded_at                  timestamptz,
  response_notes                text,                                   -- accepted: confirmation message; rejected: motivo
  rejection_reason              text,                                   -- structured: 'capacity' | 'health_mismatch' | 'timing' | 'other'

  -- Cancellation (org cancels their own proposal)
  cancelled_at                  timestamptz,
  cancelled_by_user_id          uuid references profiles(id),
  cancellation_reason           text,

  -- Resolution (when accepted, this links to the foster ownership row)
  resolved_ownership_id         uuid references ownerships(id),

  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint foster_proposals_status_valid check (status in (
    'pending','accepted','rejected','expired','cancelled'
  )),
  constraint foster_proposals_response_consistent check (
    (status = 'pending'  and responded_at is null and cancelled_at is null)
    or
    (status = 'accepted' and responded_at is not null and resolved_ownership_id is not null)
    or
    (status = 'rejected' and responded_at is not null)
    or
    (status = 'expired'  and expires_at < responded_at_or_now())
    or
    (status = 'cancelled' and cancelled_at is not null and cancelled_by_user_id is not null)
  ),
  constraint foster_proposals_rejection_reason_valid check (
    rejection_reason is null
    or rejection_reason in ('capacity','health_mismatch','timing','distance','household','other')
  )
);

create index foster_proposals_volunteer_idx    on foster_proposals (volunteer_user_id, status, proposed_at desc);
create index foster_proposals_org_idx          on foster_proposals (organization_id, status, proposed_at desc);
create index foster_proposals_pet_idx          on foster_proposals (pet_id) where status in ('pending','accepted');
create index foster_proposals_status_idx       on foster_proposals (status, expires_at);
```

**Notas:**
- `public_token` formato `FP-XXXX-XXXX` para URLs públicas tipo `/cuenta/transitos/propuestas/FP-XXXX-XXXX` y `/org/[orgToken]/voluntarios/propuestas/FP-XXXX-XXXX`.
- `match_warnings` se calcula al propose-time y se snapshota (volunteer preferences pueden cambiar entre propose y response — la propuesta debe mostrar el match-at-propose-time).
- `responded_at_or_now()` en el CHECK es notación; en SQL real se reemplaza por COALESCE expression.
- `resolved_ownership_id`: cuando se acepta, el server action crea la ownership row con `role='foster'` y la liga acá. Trazabilidad bidireccional.

### 4.3 Settings de la org

**No hay tabla de settings** en v1 (resuelto en v1.4). Las notifications obligatorias de D12 se mandan siempre. Si emerge demanda de silenciar (org con muchos rechazos que satura inbox de su coordinator), se agrega `org_proposal_settings` como tabla aparte. Por ahora: hardcoded permissive.

### 4.4 Extensión a `ownerships` para co-foster (D17)

```sql
-- Add a column to existing ownerships table. NULL/false for non-foster rows
-- and for foster rows where the foster did not opt-in to co-foster.
alter table ownerships
  add column allow_co_foster boolean not null default false;
```

**Reglas de uso**:
- Solo es significativo cuando `ownerships.role='foster'`. En otras roles se ignora.
- El primer foster lo setea al aceptar la propuesta (checkbox opt-in en `acceptFosterProposalAction`).
- Después de aceptar, el foster puede mutar el flag en `/cuenta/transitos/activos/[petToken]` (toggle).
- Al proponer un segundo foster sobre el mismo pet, `proposeFosterAction` valida que **todas** las foster ownership rows activas del pet tengan `allow_co_foster=true`. Si alguna es false, error: "Este pet ya tiene foster activo y no admite co-foster."

### 4.5 Event catalog adds (en `pet_events`)

Siguiendo el patrón `*_proposed/*_executed` cross-cutting del cleanup plan:

| Event type | Cuándo | Payload |
|---|---|---|
| `foster_proposed` | Org propone tránsito a voluntario | `{ proposal_public_token, volunteer_user_id, proposed_duration_weeks?, match_warnings: string[] }` |
| `foster_proposal_accepted` | Voluntario acepta propuesta | `{ proposal_public_token, response_notes? }` |
| `foster_proposal_rejected` | Voluntario rechaza propuesta | `{ proposal_public_token, rejection_reason, response_notes? }` |
| `foster_proposal_cancelled` | Org cancela su propia propuesta | `{ proposal_public_token, cancellation_reason? }` |
| `foster_proposal_expired` | Cron marca expired tras 7d sin respuesta | `{ proposal_public_token }` |
| `foster_co_foster_allowed` | Foster opt-in/opt-out de co-foster (al aceptar propuesta o vía toggle posterior) | `{ allow_co_foster: bool, foster_ownership_id }` |

**`foster_assigned`** y **`foster_ended`** ya existen (assignFosterAction / endFosterAction). El path de aceptación reusa `foster_assigned` post-materialización.

**No** se emiten events de pet por las acciones del slot (enrollment / decrement / re-enroll prompt) — son cambios en `foster_volunteers` que no afectan al pet. Quedan en `foster_volunteers.updated_at` y notifications.

## 5. Capability matrix

| Acción | Owner sin pool | Owner en pool | Org member con `foster.assign` | Admin |
|---|---|---|---|---|
| Inscribirse en el pool | ✓ | — | ✓ (puede inscribirse igual) | — (institucional, no aplica) |
| Ver lista de orgs que le proponen | — | ✓ (sus propias propuestas) | — | ✓ (auditoría) |
| Aceptar/rechazar propuesta recibida | — | ✓ | — | — |
| Buscar pool de voluntarios | — | — | ✓ | ✓ (read-only) |
| Proponer tránsito a voluntario | — | — | ✓ | — |
| Cancelar propia propuesta pending | — | — | ✓ (la que él propuso o cualquiera de su org) | — |
| Editar preferences propias | — | ✓ | — | — |
| Pausar/withdraw del pool | — | ✓ | — | — |
| Suspender voluntario (caso fraude) | — | — | — | ✓ (admin only) |

**Capability nueva**: ninguna. Reusa `foster.assign` (que ya existe) para gate la búsqueda y la propuesta. Materialización post-aceptación NO usa capability (D11).

## 6. UX flows

### 6.1 Inscripción del voluntario

**Entry point**: en `/cuenta`, una card en la sección de capacidades del owner:

```
┌──────────────────────────────────────────────────────────┐
│  🏠  ¿Querés ofrecerte como hogar de tránsito?           │
│                                                           │
│  Los refugios cerca tuyo necesitan voluntarios para      │
│  hospedar mascotas temporalmente mientras esperan        │
│  adopción.                                                │
│                                                           │
│  [ Ofrecerme como voluntario → ]                          │
└──────────────────────────────────────────────────────────┘
```

Si el owner YA está inscripto, la card cambia copy según slots disponibles (D16):

```
─ caso slots > 0 ──────────────────────────────────────────
┌──────────────────────────────────────────────────────────┐
│  🏠  Sos voluntario de tránsito · disponible             │
│      X propuestas activas · Y slot(s) disponible(s)      │
│  [ Ver mi perfil de voluntario → ]                        │
└──────────────────────────────────────────────────────────┘

─ caso slots = 0, foster activo ───────────────────────────
┌──────────────────────────────────────────────────────────┐
│  🏠  Sos voluntario de tránsito · ocupado                │
│      Estás cuidando: Pepe (Patitas Vagabondas)           │
│  [ Inscribirme de nuevo para recibir otro → ]            │
└──────────────────────────────────────────────────────────┘

─ caso slots = 0, sin foster activo (post-termination) ───
┌──────────────────────────────────────────────────────────┐
│  🏠  Tu último tránsito (Pepe) terminó. ¿Querés          │
│      volver al pool y recibir nuevas propuestas?         │
│  [ Inscribirme de nuevo → ]                               │
└──────────────────────────────────────────────────────────┘
```

El click lleva a `/cuenta/ofrecerme-como-tránsito` (la página de inscripción/edición).

```
Owner navega a /cuenta/ofrecerme-como-tránsito (via card en /cuenta)

PRE-CHECK (D13): server-side antes de renderizar el form, verifica:
  - profile.dniVerified === true
  - profile.displayName no vacío
  - profile.phone no vacío
  - profile.role === 'owner' (account_type='personal')

Si falla algún check → renderiza checklist con los steps faltantes:
  ┌──────────────────────────────────────────────────────┐
  │  Para ser voluntario de tránsito necesitás:          │
  │                                                       │
  │  ✓ Cuenta DIM activa                                 │
  │  ✗ DNI verificado     → [Verificar DNI]              │
  │  ✓ Nombre completo                                   │
  │  ✗ Teléfono declarado → [Agregar teléfono]           │
  │                                                       │
  │  Volvé acá cuando completes todos los pasos.         │
  └──────────────────────────────────────────────────────┘

Si todos pasan → renderiza el form:
  → Si nunca se inscribió: form en blanco con todas las preferences en default conservador
  → Si ya está inscripto: form prepoblado con valores actuales

Form:
  - [✓] Acepto perros
  - [_] Acepto gatos
  - [_] Acepto otras especies (conejo, hurón, cobayo)
  - Tamaños (solo si acepta perros):
    - [✓] chico (<10 kg)
    - [✓] mediano (10-25 kg)
    - [_] grande (>25 kg)
  - Edades:
    - [_] Acepto cachorros (<4 meses, calendario incompleto)
    - [✓] Acepto seniors (>7 años, condiciones crónicas posibles)
  - Salud:
    - [_] Acepto condiciones crónicas (diabetes, post-cirugía, etc.)
    - [_] Acepto razas PPP (Ley CABA 4078 / Prov 14.107)
        ↑ con disclaimer "Las razas PPP requieren atestación y cuidados especiales. Confirmá que tenés capacidad."
  - Duración máxima estimada: [_____ semanas] o [✓] sin límite
  - Mi locality (opcional): <LocalityCombobox> ← (cuando catálogo INDEC esté listo)
  - Otras mascotas en casa: [Sí/No]
  - Niños en casa: [Sí/No]
  - Notas para el refugio: <textarea>
       "Ej. Trabajo desde casa, tengo patio cerrado, puedo separar areas..."

  - [ Guardar y activar pool ]
  - [ Guardar y pausar ]  (queda registrada pero no recibe propuestas)

Submit → upsertFosterVolunteerAction
  Atomic:
    1. Validate at least one species accepted if status='active'
    2. Upsert foster_volunteers row by user_id
    3. (No pet_events emitted — el voluntario no es un evento del pet)
```

### 6.2 Org busca voluntarios — `/org/[orgToken]/voluntarios`

Requiere `foster.assign` capability.

```
Page: /org/[orgToken]/voluntarios

Pre-filter implícito (no UI): WHERE status='active' AND available_slots > 0. Voluntarios sin slots disponibles NO aparecen (D16).

Filters bar:
  - Especie (perro/gato/otros) — default: la especie del pet que la org tiene pendiente más reciente. **No restrictivo** (D5): la org puede ignorar el filtro y elegir cualquier voluntario; el voluntario decide al recibir
  - Tamaño (S/M/L)
  - Edad (acepta puppies / acepta seniors)
  - Salud (acepta crónicos / acepta PPP)
  - Locality (typeahead) — default: la jurisdicción de la org

Results: tabla con
  - Display name del voluntario
  - Locality (si declaró)
  - Especies que acepta (chips)
  - Capacidades adicionales (puppies, crónicos, PPP) si aplica
  - **Notes del voluntario** (resumen primer línea) — visible directo en listado (resuelto en v1.4)
  - "Veces que aceptó/rechazó tránsito" (count agregado, sin detalle por org) — visible directo en listado
  - Slots disponibles (badge "1 slot" o "2 slots")
  - Botón "Proponer tránsito"

Sin paginación numérica para v1 — top 50 ordenados por:
  1. Slots disponibles > 0 (filtro previo; en el listado, mayor cantidad de slots primero)
  2. Match score (cuántas preferences matchean los pets que la org tiene en shelter_custody) — mayor primero
  3. Aceptaciones históricas — mayor primero

**Detalle del voluntario** al clickear su row: modal o página con TODA la información (preferences, notes completas, historial agregado). Resuelto v1.4: todo público entre orgs del pool, sin gating.
```

### 6.3 Surface unificado de mascotas en tránsito de la org

Antes del flow de proponer, la org necesita VER las mascotas que ya están en tránsito. Sin esto el coordinador no tiene visibilidad operativa básica.

**Surface**: `/org/[orgToken]/transitos`. Requiere `foster.assign` capability.

**Qué muestra**: TODOS los pets de la org con un foster ownership activo, **independientemente del path de origen** (member-based foster del flow existente + voluntary pool del nuevo flow + cualquier shelter_custody migrado a foster vía otros mecanismos futuros). Single source of truth visual.

```
/org/[orgToken]/transitos

Tabla:
┌──────────┬──────────────┬─────────────────┬───────────┬────────────────┬─────────┐
│ Pet      │ Foster       │ Tipo            │ Días en   │ Duración est.  │ Acciones│
│          │              │                 │ tránsito  │                │         │
├──────────┼──────────────┼─────────────────┼───────────┼────────────────┼─────────┤
│ Pepe     │ María G.     │ Voluntario pool │ 12 d      │ 4 sem (~16 d)  │ [Ver]   │
│ Luna     │ Juan F.      │ Member          │ 47 d      │ — (open-ended) │ [Ver]   │
│ Toby     │ vecino@...   │ Vecino-tránsito │ 3 d       │ —              │ [Ver]   │
└──────────┴──────────────┴─────────────────┴───────────┴────────────────┴─────────┘
```

**Cálculo de días en tránsito**:
```sql
extract(day from now() - ownerships.started_at) as days_in_foster
```
(O equivalente en TS para edge cases de timezone — DIM ya tiene helpers de fechas).

**Tipo de foster**: se infiere de la presencia o ausencia de filas relacionadas:
- Si hay `foster_proposals.resolved_ownership_id` apuntando a esta ownership → "Voluntario pool"
- Si el foster es member activo de la org → "Member"
- Si el foster NO es member y NO hay proposal → "Vecino-tránsito" o "Otro"

**Ordenamiento default**: por `días en tránsito DESC` (los más viejos primero). Hipótesis: los tránsitos largos tienen más probabilidad de ser problemáticos y merecen atención prioritaria.

**Filtros**:
- Tipo (todos / member / voluntario pool / vecino)
- Especie
- Tamaño
- "Cerca del plazo estimado" (días en tránsito >= duración estimada × 0.8) — alerta suave

**Acciones por row**:
- "Ver" → `/org/[orgToken]/mascotas/[petToken]` (detail estándar del pet)
- "Finalizar tránsito" → endFosterAction (existente)
- "Finalizar adopción al foster actual" → shortcut de §15.1 (solo si foster es del pool, no para vecino-tránsito reactivo donde el "foster" es el propio finder)

**Empty state**: si no hay tránsitos activos, mostrar "No hay mascotas en tránsito ahora. Cuando asignes una, va a aparecer acá."

**Link cruzado**: la card de cada pet en `/org/[orgToken]/mascotas/[petToken]` también muestra "🏠 En tránsito con María G. desde hace 12 días" cuando aplica.

### 6.4 Org propone tránsito

```
Org click "Proponer tránsito" desde el listado:

Modal/form:
  - Volunteer info (read-only): display name + preferences resumidas
  - Pet selector: dropdown de pets en shelter_custody activo de la org SIN foster activo
    - Opcionalmente filtrar a pets que matchean las preferences (default: ON)
  - Duración estimada (semanas): input number o "sin límite"
  - Notas: textarea
       "Ej. Pepe es un golden retriever de 5 años, manso, vacc al día, le falta esterilizar..."

  Al elegir pet, calcular y mostrar match_warnings en tiempo real:
    - "⚠ El voluntario marcó tamaño máximo medium. Este pet es grande (28 kg)."
    - "⚠ El voluntario no acepta razas PPP. Este pet es Rottweiler (PPP-attested)."
    - "⚠ El voluntario no acepta puppies. Este pet tiene 3 meses."

  Warnings NO bloquean. Solo informan.

  - [ Enviar propuesta ]

Submit → proposeFosterAction
  Atomic:
    1. requireCapability('foster.assign')
    2. Validate pet está en shelter_custody activo de la org
    3. Validate pet foster state:
       - Si NO tiene foster activo → OK proceder
       - Si tiene foster activo(s) → validar que TODAS las ownership rows role='foster' activas
         tengan allow_co_foster=true (D17). Si alguna es false → error
         "Este pet ya tiene foster activo y no admite co-foster."
    4. Validate volunteer status='active' AND available_slots > 0 (D16)
       Si no → error "Este voluntario no tiene slots disponibles."
    5. Compute match_warnings snapshot
    6. INSERT foster_proposals con status='pending', expires_at = now + 7 days
    7. INSERT pet_events type='foster_proposed' con payload
    8. INSERT notification al volunteer
    9. (Volunteer.notify_email opt-in cuando email transactional lande)
  Commit.
  Return public_token.
```

### 6.5 Volunteer recibe y responde — `/cuenta/transitos/propuestas`

```
Page: /cuenta/transitos/propuestas

Tabs/secciones:
  - Activas (pending)
  - Historial (accepted / rejected / expired / cancelled)

Per active proposal:
  - Org name (linked to /org/[orgToken] read-only)
  - Pet info: foto + nombre + especie + edad + tamaño + raza
  - Duración propuesta
  - Notas de la org
  - Match warnings si hay (rojo, con icon)
  - Expira en: "5 días" (countdown)
  - [ Aceptar ]   [ Rechazar ]

Click Aceptar:
  Confirmation modal:
    "Vas a aceptar el tránsito de Pepe (golden, 5 años) propuesto por Patitas Vagabondas.
    Duración estimada: 4 semanas. Después coordinás handoff con la org directamente
    (vas a poder ver sus datos de contacto)."

    [ ] Permito que la org asigne otro co-foster a Pepe mientras yo lo cuide
        ↑ checkbox opcional (D17). Default: NO marcado.

    [ Confirmar aceptación ]

  Submit → acceptFosterProposalAction({ allowCoFoster: boolean })
    Atomic:
      1. Validate session.user is proposal.volunteer_user_id
      2. Validate proposal.status='pending' (anti-race con advisory lock)
      3. Validate pet sigue en shelter_custody de la org. Si pet tiene foster
         activo(s), validar que TODAS sus rows tienen allow_co_foster=true.
         (Defense-in-depth: ya validamos al proponer, pero el estado puede
         haber cambiado entre propose y accept)
      4. Validate volunteer.available_slots > 0 (anti-race con la inscripción)
      5. UPDATE foster_proposals SET status='accepted', responded_at=now()
      6. CREATE ownership: pet_id, owner_user_id=volunteer, role='foster',
                              started_at=now(), assigned_via='proposal',
                              allow_co_foster=<from checkbox>
      7. UPDATE foster_proposals SET resolved_ownership_id=<new ownership id>
      8. INSERT pet_events type='foster_proposal_accepted'
      9. INSERT pet_events type='foster_assigned' (reusa el existing event)
      10. Si allowCoFoster: INSERT pet_events type='foster_co_foster_allowed'
          con payload { allow_co_foster: true, foster_ownership_id }
      11. UPDATE foster_volunteers SET available_slots = available_slots - 1
          WHERE user_id = volunteer  (D16)
      12. **D18 cascade auto-cancel**: si volunteer.available_slots ahora = 0,
          UPDATE foster_proposals SET status='cancelled',
                                       cancelled_at=now(),
                                       cancellation_reason='volunteer_accepted_another'
          WHERE volunteer_user_id = volunteer
            AND status = 'pending'
            AND id != current_proposal.id
          + INSERT pet_events 'foster_proposal_cancelled' por cada una
          + INSERT notification a cada org afectada
      13. INSERT notification a org members con foster.assign capability
      14. UNLOCK contact info (email/phone) entre las dos parties via session policy
    Commit.

Click Rechazar:
  Modal:
    Motivo (dropdown obligatorio):
      - No tengo capacidad ahora mismo
      - El pet no es compatible con mi hogar
      - Timing no me funciona
      - Distancia muy lejos
      - Otras mascotas/personas en casa lo dificultan
      - Otro
    Notas (opcional, textarea)
    [ Confirmar rechazo ]

  Submit → rejectFosterProposalAction
    Atomic:
      1. Validate session.user is proposal.volunteer_user_id
      2. Validate proposal.status='pending'
      3. UPDATE foster_proposals SET status='rejected', responded_at=now(),
                                     rejection_reason=<dropdown>, response_notes=<text>
      4. INSERT pet_events type='foster_proposal_rejected'
      5. INSERT notification a org (si org.notify_on_rejection=true)
    Commit.
```

### 6.6 Org cancela propuesta pending

Cuando la org ya consiguió foster por otro voluntario, o cuando el pet pasó a otra situación (adopción, transferencia, etc.):

```
Org abre /org/[orgToken]/voluntarios/propuestas (tabla de propuestas activas)
  → Click "Cancelar" sobre una pending
  → Form: motivo opcional
  → Submit → cancelFosterProposalAction
    Atomic:
      1. requireCapability('foster.assign')
      2. Validate proposal.organization_id = current org
      3. Validate status='pending'
      4. UPDATE status='cancelled', cancelled_at, cancelled_by_user_id, cancellation_reason
      5. INSERT pet_events type='foster_proposal_cancelled'
      6. INSERT notification al volunteer
```

### 6.7 Cron de expiración

Reusa la infra de Fase 14 (admin page: auto-expiry sweep). Agregar al cron diario:

```ts
// En el mismo route handler /api/cron/auto-expire-approvals (renombrar o paralelo):
// Foster proposals: status='pending' AND expires_at < now() → status='expired'.
```

O crear `/api/cron/expire-foster-proposals` separado. Mi propuesta: separar para que cada cron tenga responsabilidad única. Mismo pattern, distinta tabla.

### 6.8 Foster materializado funciona como existing

Una vez la ownership row `role='foster'` existe, el flow es **idéntico al existing**:
- `endFosterAction` lo termina (org coordinator o admin)
- Coexiste con shelter_custody de la org
- Aparece en libreta sanitaria, timeline, etc.

No hay paralelo de "foster from proposal" vs "foster from member assign" — son la misma cosa una vez materializados. La diferencia es solo el path de origen.

### 6.9 End-of-flow — cómo termina un tránsito

El tránsito termina por una de **cuatro vías**, cada una con tratamiento específico:

**A. Devolución normal (happy path)**.
El foster decide entregar el pet de vuelta al refugio en el plazo estimado o antes. La org ejecuta `endFosterAction`. La ownership `foster` se cierra (`ended_at=now()`); la `shelter_custody` de la org sigue activa. Event: `foster_ended` con payload `{ reason: 'returned' }`. Pet vuelve al circuito normal de tránsitos/adopción.

**B. Devolución anticipada por imposibilidad del foster**.
El foster pide terminar antes (mudanza, problema de salud propio, conflicto con otras mascotas, etc.). UX: en `/cuenta/transitos/activos`, botón "Pedir devolución anticipada" abre form con motivo + propuesta de fecha de handoff. La org confirma → `endFosterAction` con `reason='early_return_by_foster'`. Identico final state que A; auditable en payload.

**C. Pet muere durante el tránsito**.
Caso pesado pero real. El foster (o el vet que atendió al pet) registra `death_recorded` event en el pet. El server action de `death_recorded` se extiende para **detectar foster activo y cerrarlo automáticamente** en la misma transacción:

```
Si pet.id tiene ownership.role='foster' activa:
  UPDATE ownerships SET ended_at=now() WHERE id=<foster_ownership_id>
  INSERT pet_events type='foster_ended' con payload { reason: 'pet_died', death_event_id: <new_event_id> }
```

La org se entera por notification automática (`pet_died_during_foster_org`). UX adicional: el foster que registra la muerte recibe un mensaje cuidado (D14 de welfare events: lenguaje no judgmental). Aparece en libreta sanitaria como evento terminal del pet.

Importante: el foster NO es responsable legal/financieramente por la muerte por default (a menos que haya `maltreatment_reported` event paralelo que lo investigue). El sistema documenta el hecho sin atribuir culpa.

**D. Pet se pierde durante el tránsito**.
El foster reporta el pet como perdido vía el flow existing de lost-and-found (`/perdida` con `MarkLostForm`). El pet pasa a `status='lost'`. **La ownership `foster` permanece activa** — el foster sigue siendo el responsable legal del animal mientras esté perdido. Razón: si la org cierra el foster acá, no queda claro quién es el contact point ni quién financia los esfuerzos de búsqueda.

Resoluciones posibles desde el estado `lost` + `foster activa`:
1. **Recuperación**: el pet aparece. El foster lo recupera, status vuelve a `home`, foster continúa el tránsito o pide devolución (caso B).
2. **No-recuperación tras N días**: si pasa > 30 días sin signs of life, la org puede `endFosterAction` con `reason='lost_unrecovered'`. El foster ownership se cierra pero el pet sigue con `status='lost'` indefinidamente.
3. **Recuperación por tercero**: alguien encuentra el pet vía scan QR. El finder no es el foster — sigue el flujo normal de return-to-owner del spec de lost-and-found, que reconoce al foster como el "owner actual" (porque es el ownership activo). El finder coordina entrega al foster.

**Eventos emitidos según vía**:
| Vía | Events | Foster ownership |
|---|---|---|
| A. Devolución normal | `foster_ended { reason: 'returned' }` | Cerrada |
| B. Devolución anticipada | `foster_ended { reason: 'early_return_by_foster', notes? }` | Cerrada |
| C. Muerte | `death_recorded` (existente) + `foster_ended { reason: 'pet_died' }` (auto-cerrado) | Cerrada |
| D.1. Lost → recuperado | `status_changed: lost → home` (existentes) | Sigue activa |
| D.2. Lost → no recuperado tras N días | `foster_ended { reason: 'lost_unrecovered' }` | Cerrada |
| D.3. Lost → finder lo trae al foster | `status_changed: lost → home` + foster sigue activa | Sigue activa |

**Schema impact**: ninguno. Reusa el `endFosterAction` y `foster_ended` event existentes; solo se agrega la lista de motivos válidos al Zod schema del `foster_ended.payload.reason` (extender enum existente).

**Slots prompt al terminar (D16)**: en CUALQUIERA de las cuatro vías de termination del foster, después del commit del `foster_ended`:

```
Background job (mismo transaction o post-commit):
  Si volunteer.available_slots == 0:
    INSERT notification al volunteer con type='foster_volunteer_reenroll_prompt',
      payload = { pet_public_token, pet_display_name, ended_reason }
    Render: "Tu tránsito con Pepe terminó. ¿Querés volver al pool y recibir
             nuevas propuestas?"
    CTA principal: "Inscribirme de nuevo →" (incrementa +1 slot al click)
    CTA secundario: "No por ahora" (dismiss; no incrementa slots)

  Si volunteer.available_slots > 0:
    No prompt — el voluntario aún tiene slots de inscripciones previas o
    paralelas, sigue disponible automáticamente.
```

El prompt es notification + entry en `/cuenta/transitos/historial`. El voluntario puede ignorarlo y nunca volver al pool, o clickear "Inscribirme de nuevo" cuando quiera (puede ser días después).

### 6.10 Capacidades del foster durante el tránsito — "como si fuera propia"

D15 establece el principio: el foster tiene autoridad plena sobre el cuidado diario del pet. Esta sección concreta qué significa en términos de capabilities y RLS.

**El tránsito ES un estado del pet**. Visualmente se muestra como un badge en el credencial público y en el pet detail:

```
┌────────────────────────────────────────────────┐
│  Pepe (Golden Retriever)                       │
│  🏠 En tránsito · cuidado por María González   │
│  Refugio: Patitas Vagabondas · día 12 de ~28   │
└────────────────────────────────────────────────┘
```

Pero técnicamente "en tránsito" se **deriva** de la presencia de `ownership.role='foster'` activa — no agregamos `pets.status='in_foster'` como valor enum. El status sigue siendo `home` (o `lost` si el foster reporta perdido). Esto preserva el modelo actual sin introducir un estado nuevo que habría que mantener en sync.

#### Capacidades del foster (lista taxativa)

**SÍ puede** (mismo nivel que un primary_owner):

| Categoría | Acciones |
|---|---|
| Libreta sanitaria | Registrar `weight`, `vaccination_administered` (vía vet), `medication_administered`, `vet_visit`, `clinical_info_logged`, `symptom_observed`, `treatment_started/ended` |
| Identidad visual | Subir/cambiar foto principal, agregar fotos al timeline, editar `nickname` (NO `display_name` legal — eso es de la org) |
| Credencial pública | Configurar disclosure prefs del `/p/[publicToken]` (show_phone, show_email, etc.), generar libreta share token para vet, gestionar chapas físicas |
| Lost & found | Marcar pet como perdido, agregar last_seen_location, recibir notificaciones de scans del QR, gestionar broadcasting |
| Scheduling | Reservar turnos de vet (`/turnos/buscar`), confirmar asistencia, recibir reminders 24h |
| Eventos | Emitir cualquier event_type del catálogo donde `author_role='owner'` sea válido. El foster es **el** owner operativo durante el tránsito |
| Surveillance | Reportar síntomas que se procesan en el flow de symptom-disease-surveillance |
| Disputes | Plantear `custody_dispute_raised` si algo grave ocurre (ej. la org no responde tras enfermedad seria del pet) — esto es defensa del foster, no debe bloquearse |

**NO puede** (autoridad de la org, requieren approval o son acciones de la org):

| Acción | Quién sí | Razón |
|---|---|---|
| `adoption_finalized` | Org con `adoption.finalize` capability | Cambia ownership permanente. El foster puede SOLICITAR adopción (§15.1) pero no formalizarla unilateralmente |
| `custody_transferred` (a otro user/org) | Org con `custody.transfer` | Idem |
| `death_recorded` | Foster + vet juntos: el foster puede emitir `death_recorded` si registra que el pet murió (es un hecho médico, no una decisión); pero la **eutanasia decision** requiere consentimiento de la org. Editorial: el spec del cleanup plan no distingue tipos de muerte — esto queda como matiz de la org, no del schema. Decisión técnica: foster PUEDE emitir `death_recorded` con `payload.was_authorized_by_org=true` flag obligatorio si la causa es euthanasia | Decisión terminal con responsabilidad legal |
| `adoption_eligibility_set` | Org con `pets.intake` | El foster opina pero la decisión de "apta para adopción" es del refugio, que tiene el contexto general del proceso |
| Editar campos legales del pet | Org | `display_name` legal, `microchip_id` (post-implante), `species`, `breed_attested`, `date_of_birth_estimated` — son atributos identidad/legales |
| `foster_ended` | Org u admin | El foster pide devolución, la org la ejecuta (§6.9 caso B) |
| Aceptar otra propuesta de tránsito sobre el mismo pet | Sistema | El pet ya tiene foster activo |

#### Implementación RLS

Hoy, las RLS de `pet_events` y `pets` permiten al ownership user (cualquiera con ownership activa) leer y escribir. Verificar que la lógica actual reconoce `ownership.role='foster'` igual que `primary_owner`. Si no, ajustar las RLS para que sea explícito.

Las RLS de `ownerships` no cambian — el foster ve su propia ownership row + las de los pets que tiene a cargo.

#### Implementación de capabilities

`requireCapability` en server actions debe seguir funcionando porque los actions de care diaria no requieren capability formal — los emite el ownership user. Verificar especialmente:

- `app/actions/events.ts` actions varios (vaccination, weight, etc.): aceptan al foster como `author_role='owner'`.
- `app/actions/lost-and-found/*`: aceptan al foster como reporter.
- `app/actions/libreta-share.ts`: el foster puede generar share tokens.

Si emerge algún path que hoy hardcodea "primary_owner only", se relaxa en este spec.

#### Foster del pool vs vecino-en-tránsito (clarificación)

Ambos tienen `ownership.role='shelter_custody'` o `role='foster'` activa con `owner_user_id=user`. Ambos tienen las mismas capacidades durante el tránsito. La distinción es solo el path de origen:

- **Vecino-en-tránsito**: encontró el pet en la calle, declaró custody. Sin org de respaldo formal (o con org informal).
- **Foster del pool**: aceptó propuesta de una org verified. La org respalda el cuidado.

Para el foster en sí, día a día, son equivalentes en capacidades. La diferencia está en cómo termina el tránsito (vecino-en-tránsito típicamente fluye a adopción propia o transfer a refugio; foster del pool fluye a return-to-org o adoption-by-foster).

## 7. Privacy

**Datos visibles a orgs verified con `foster.assign`** sobre cada voluntario en el pool:

- `display_name`
- `jurisdiction_province`, `jurisdiction_locality` (si declarados)
- Todas las preferences booleanas + `max_duration_weeks`
- `household_other_pets`, `household_kids` (Sí/No, sin detalle)
- `notes` (texto libre que el voluntario escribió pensando en orgs)
- Count de propuestas aceptadas históricamente

**NO visible al pool browse**:
- Email
- Teléfono
- DNI
- Dirección completa
- Mascotas propias del voluntario (su lista de pets en `/mis-mascotas` queda privada)

**Contact info unlock**: cuando una propuesta pasa a `status='accepted'`, ambas parties (volunteer y org members con foster.assign) ven mutuamente:
- Email del otro
- Teléfono del otro si declarado
- Esta info solo se desbloquea para el contexto de esa propuesta, en la página de detalle de la propuesta — no en el listado general

**Voluntarios paused o withdrawn**: no aparecen en el listado general. Sus propuestas pasadas siguen accesibles en historial de ambas parties.

## 8. RLS

```sql
alter table foster_volunteers enable row level security;
alter table foster_proposals enable row level security;
alter table org_proposal_settings enable row level security;

-- foster_volunteers
-- SELECT: own row (always); org members with foster.assign capability (active pool);
--         admin (all).
create policy "fv select own" on foster_volunteers for select
  using (user_id = auth.uid());

create policy "fv select active pool by org" on foster_volunteers for select
  using (
    status = 'active'
    and exists (
      select 1 from organization_memberships om
      join organization_capability_grants ocg on ocg.organization_id = om.organization_id
      where om.user_id = auth.uid()
        and om.left_at is null
        and ocg.capability = 'foster.assign'
        and ocg.revoked_at is null
    )
  );

create policy "fv select admin" on foster_volunteers for select
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );

-- INSERT/UPDATE solo via server action (no policy = denied to PUBLIC).

-- foster_proposals
-- SELECT: the volunteer (their proposals); org members of the proposing org;
--         admin (all).
create policy "fp select volunteer" on foster_proposals for select
  using (volunteer_user_id = auth.uid());

create policy "fp select org members" on foster_proposals for select
  using (
    exists (
      select 1 from organization_memberships om
      where om.user_id = auth.uid()
        and om.organization_id = foster_proposals.organization_id
        and om.left_at is null
    )
  );

create policy "fp select admin" on foster_proposals for select
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid()
        and p.role = 'admin'
        and p.account_type = 'institutional'
        and p.deactivated_at is null
    )
  );

-- INSERT/UPDATE solo via server action.
```

## 9. Notificaciones

`notification_type` agrega:

- `foster_proposal_received` → al volunteer cuando se propone
- `foster_proposal_accepted_org` → a org members con foster.assign cuando volunteer acepta
- `foster_proposal_rejected_org` → idem (siempre, sin org settings — v1.4 simplificó)
- `foster_proposal_expired` → al volunteer y a la org
- `foster_proposal_cancelled_volunteer` → al volunteer si org cancela
- `foster_proposal_auto_cancelled_org` → a la org cuando el cascade D18 cancela su propuesta porque el volunteer aceptó otra
- `foster_volunteer_reenroll_prompt` → al volunteer cuando un foster terminó y queda con slots=0 (D16)
- `foster_volunteer_signed_up` → no notification (no relevance externa)

## 10. Server actions

```ts
// app/actions/foster-volunteers.ts (nuevo)

// First enrollment: creates the row with available_slots=1.
// Subsequent enrollments: status='active' + available_slots += 1.
// Updating preferences (without "re-enrolling"): does NOT touch available_slots.
export async function upsertFosterVolunteerAction(input: {
  // mode: 'enroll' increments slots; 'update_preferences_only' doesn't (D16)
  mode: "enroll" | "update_preferences_only";
  status: "active" | "paused";
  acceptsDogs: boolean;
  acceptsCats: boolean;
  acceptsOtherSpecies: boolean;
  acceptsSizeSmall: boolean;
  acceptsSizeMedium: boolean;
  acceptsSizeLarge: boolean;
  acceptsPuppies: boolean;
  acceptsSeniors: boolean;
  acceptsChronicConditions: boolean;
  acceptsDangerousBreeds: boolean;
  maxDurationWeeks: number | null;
  jurisdictionProvince?: string;
  jurisdictionLocality?: string;
  householdOtherPets: boolean;
  householdKids: boolean;
  notes?: string;
}): Promise<{ volunteerId: string; availableSlots: number } | { error: string }>;

export async function withdrawFosterVolunteerAction(): Promise<{ ok: true } | { error: string }>;

// Toggle co-foster on an active foster row (post-acceptance change of mind)
export async function setCoFosterAllowedAction(input: {
  fosterOwnershipId: string;
  allowCoFoster: boolean;
}): Promise<{ ok: true } | { error: string }>;

// app/actions/foster-proposals.ts (nuevo)

export async function proposeFosterAction(input: {
  orgToken: string;
  volunteerUserId: string;
  petPublicToken: string;
  proposedDurationWeeks?: number;
  proposedNotes?: string;
}): Promise<{ proposalPublicToken: string } | { error: string }>;

export async function acceptFosterProposalAction(input: {
  proposalPublicToken: string;
  allowCoFoster: boolean;          // D17 — checkbox del modal de confirmación
  responseNotes?: string;
}): Promise<{
  fosterOwnershipId: string;
  remainingSlots: number;          // D16 — informa al UI de slots tras descontar
  cascadeCancelledProposals: string[];  // D18 — tokens de propuestas auto-canceladas
} | { error: string }>;

export async function rejectFosterProposalAction(input: {
  proposalPublicToken: string;
  rejectionReason: "capacity" | "health_mismatch" | "timing" | "distance" | "household" | "other";
  responseNotes?: string;
}): Promise<{ ok: true } | { error: string }>;

export async function cancelFosterProposalAction(input: {
  proposalPublicToken: string;
  cancellationReason?: string;
}): Promise<{ ok: true } | { error: string }>;

// Search the pool — used by /org/[orgToken]/voluntarios page.
export async function searchFosterVolunteers(input: {
  orgToken: string;
  filters: {
    species?: "dog" | "cat" | "other";
    size?: "small" | "medium" | "large";
    acceptsPuppies?: boolean;
    acceptsChronicConditions?: boolean;
    acceptsDangerousBreeds?: boolean;
    province?: string;
    locality?: string;
  };
}): Promise<{ volunteers: VolunteerPoolEntry[] } | { error: string }>;
```

## 11. Match scoring (helper)

`lib/foster-matching.ts` (nuevo):

```ts
export type MatchScoreResult = {
  score: number;          // 0-100
  warnings: MatchWarning[];
};

export type MatchWarning = {
  kind: "species_mismatch" | "size_mismatch" | "age_mismatch" | "health_mismatch" | "ppp_mismatch" | "duration_mismatch";
  message: string;        // human-readable for UI
};

export function computeMatch(
  pet: { species: string; estimated_weight_kg?: number; age_months?: number; is_ppp: boolean; has_chronic?: boolean },
  volunteer: FosterVolunteer,
  proposedDurationWeeks?: number,
): MatchScoreResult;
```

Scoring simple en v1: cada mismatch resta puntos. ≥ 90 = match perfecto, 70-90 = bueno con warnings, <70 = mal match (sigue siendo permitido pero la org ve el aviso prominente).

## 12. Out-of-scope explícito

- **Volunteer-initiated browse de pets disponibles**: el volunteer no busca, solo recibe. v2 si emerge demanda.
- **Volunteer-initiated requests** ("quiero hospedar a algún animal, mandame propuestas activamente"): el toggle `status='active'` ya cumple ese rol pasivamente.
- **Matching automático sin búsqueda manual**: la org navega y elige. No hay "propose automáticamente al best match".
- **Tariff / compensación económica**: voluntary = unpaid. Si emerge demanda de fosters pagos (algunos refugios cubren comida/vet), modelar como variant en v2.
- **Score reputacional bidireccional**: el volunteer no rate orgs ni viceversa. Solo el count histórico de propuestas aceptadas es visible.
- **Verificación de domicilio / visita previa**: el sistema no valida domicilio físico. La org coordina visit domiciliaria offline si lo considera necesario. La verificación de identidad (DNI) sí es enforceable y obligatoria via D13 — no es opcional.
- **Multi-pet en una sola propuesta**: una propuesta = un pet. Si la org quiere hospedar 2 pets con el mismo volunteer, son 2 propuestas independientes.
- **Visibility a govts**: govts no ven el pool. No es info de gobernanza sino operativa-privada del ecosistema refugios↔owners.
- **Integración con vecino-en-tránsito**: son flows distintos. Vecino-en-tránsito es reactive shelter_custody directo al vecino; volunteer pool es proactive foster bajo paraguas org. No interfieren.

## 13. Open questions — RESUELTAS en v1.4

Todas las open questions originales del spec ahora tienen decisión cerrada:

| # | Pregunta | Resolución (v1.4) | Ref |
|---|---|---|---|
| 1 | Multi-foster simultáneo por volunteer | **Modelo de slots single-use**: cada inscripción +1 slot, cada aceptación -1 slot, prompt post-termination "¿volver al pool?". El volunteer controla disponibilidad explícitamente | D16 |
| 2 | Browse del detalle del volunteer | **Todo público entre orgs del pool** — sin gating entre filter vs detalle. La org ve toda la info disponible | D5 reforzado |
| 3 | Notification settings adicionales | **Settings mínimas**: solo las notifications obligatorias de D12, sin tabla `org_proposal_settings`. Si emerge demanda, se agrega después | §4.3 |
| 4 | Default `accepts_seniors=true` | **Mantener**: senior cuidado es común y culturalmente aceptado | §4.1 |
| 5 | Notes del volunteer en listado vs detalle | **En listado** (resumen primera línea visible directo) más detalle completo al click | §6.2 |
| 6 | Visibility de propuestas pasadas a otras orgs | **Agregado**: count "12 aceptadas, 3 rechazadas" visible. **Sin detalle** de qué org específica | §6.2 |
| 7 | Cascade auto-cancel | **Sí cascade** cuando slots queda en 0 — las otras propuestas pending del mismo volunteer se auto-cancelan con razón estructurada | D18 |
| 8 | Multi-foster por pet en paralelo (co-foster) | **Permitido si el primer foster opt-in explícito** vía checkbox en `acceptFosterProposalAction`. Default off. Cada foster tiene `allow_co_foster` propio | D17 |

Si emerge alguna pregunta nueva durante implementación o uso, se agrega acá con su resolución.

---

## 14. Phasing — 4 PRs

| Fase | Resumen | PRs |
|---|---|---|
| **A** | Schema voluntarios + propuestas (`foster_volunteers` + `foster_proposals` + `org_proposal_settings`) + Drizzle models + Zod schemas para nuevos event types + CI cobertura | 1 PR |
| **B** | Schema adoption eligibility (columnas en `pets` + Zod schema de `adoption_eligibility_set` event + setAdoptionEligibilityAction + extensión de intakeAction para input opcional) | 1 PR |
| **C** | Server actions voluntarios (5 nuevos) + lib/foster-matching.ts + tests. Extensión de `endFosterAction` + `death_recorded` action para auto-close foster en muerte (§6.9). Extensión de `foster_ended` payload schema con catálogo de reasons | 1 PR |
| **D** | UI surfaces: card en `/mis-mascotas` + `/mis-mascotas/voluntario` (pre-check D13) + `/cuenta/transitos/propuestas` + `/cuenta/transitos/activos` + `/org/[orgToken]/voluntarios` + `/org/[orgToken]/voluntarios/propuestas` + **`/org/[orgToken]/transitos`** (§6.3) + **`/org/[orgToken]/pets/no-aptas`** (§17.6) + UI de eligibility en pet detail + integración con cron de expiry. Shortcut de adopción a foster actual (§15.1) | 1 PR |

Total: ~4 días de CC. Plan ejecutable se escribe post-OK del spec.

## 15. Adoption pathway desde foster — el voluntario que se queda

Una de las funciones del foster pool, además de aliviar capacidad del refugio, es que **el foster suele convertirse en adopter**. Es el patrón "foster fail" del léxico anglosajón — el voluntario se encariña, decide quedarse con el animal, transita de custodia temporal a propiedad permanente.

DIM ya tiene el flow de adopción implementado (`app/actions/adoption.ts → finalizeAdoptionAction`, requirido `adoption.finalize` capability). Hoy ese flow:

1. Recibe DNI + nombre + teléfono del adopter.
2. Si el DNI no matchea ningún profile existente, crea un **stub profile** con `dniVerified=false` y sin auth user — el adopter "real" lo claima después via Mi Argentina sign-in.
3. Cierra `shelter_custody` (y `foster` si había) y abre `primary_owner` con el adopter.

**Para fosters del pool, ese flow se simplifica radicalmente** porque la pre-condición D13 garantiza que el foster ya es un user DIM real con perfil completo. Cuando el refugio finaliza la adopción a favor de un foster del pool:

- **No se crea stub profile**. El `adopter_user_id` ya existe — es el `foster_proposals.volunteer_user_id` que se aceptó.
- **No se pide DNI ni nombre de nuevo**. Ya está verificado y completo en el profile.
- **No hay "claim later" con Mi Argentina**. El adopter ya tiene auth user con su email/password (o magic link).
- La org solo confirma "queremos adoptar a Pepe a María González (su foster actual)" y el flow lo cierra.

### 15.1 UI suggestion: shortcut en el foster detail

Cuando una propuesta está en `status='accepted'` y la org ve el detalle del foster activo en `/org/[orgToken]/mascotas/[petToken]`, además del botón existente "Finalizar adopción" (genérico, que pide DNI), aparece un botón nuevo:

```
[ Finalizar adopción al foster actual (María González) ]
```

Que llama a `finalizeAdoptionAction` con el `adopterUserId` pre-poblado del foster row, salteando la búsqueda por DNI. UX: 1 click + confirmation modal en vez de pedir DNI + nombre + teléfono otra vez.

### 15.2 No cambia el contrato de eventos

Sigue siendo `adoption_finalized` event como en el flow normal. El payload puede llevar opcionalmente `via_foster_proposal_id` para trazar el origen, pero no es obligatorio. Lo importante es que en el timeline del pet aparezca:

```
foster_proposed (de Patitas Vagabondas)
foster_proposal_accepted (María González acepta)
foster_assigned (María comienza el tránsito)
... [N meses de vacunas, weight, notas, etc.]
adoption_finalized (María formaliza la adopción)
foster_ended (auto-cerrado dentro del mismo transaction)
```

Coherencia narrativa total. El "foster fail" queda registrado como una transición natural del estado del animal.

### 15.3 Server action update mínimo

`finalizeAdoptionAction` recibe un parámetro opcional nuevo `adopterUserId?: string`. Si viene set:
- Skip la lookup por DNI.
- Skip la creación de stub profile.
- Validar que ese user existe y tiene `dniVerified=true` y `account_type='personal'` y rol owner.
- El resto del flow es idéntico.

Ese parámetro solo lo manda el shortcut UI de §15.1, nunca el form manual. **No es nuevo server action** — es extender el existente.

## 16. Seguimiento post-adopción

El pet sigue en DIM tras la adopción. Esto NO es una feature de este spec — es **una propiedad inherente** del modelo de event-sourcing. Pero vale documentarlo acá porque cierra el ciclo conceptual del foster pool.

### 16.1 Lo que sigue funcionando solo

- **Timeline del pet** continúa. Vacunas, weight, notas, vet visits — todo sigue acumulándose.
- **Libreta sanitaria** sigue viva. El nuevo owner accede a la libreta histórica completa (incluyendo el período de foster) más lo que vaya agregando.
- **Credencial pública** `/p/[publicToken]` sigue válido. El microchip + token se preservan. Si la chapa física (spec separado) ya estaba activada, queda con el animal.
- **Lost & found**, **dispute resolution**, **scheduling** — todos los demás features siguen aplicando al pet bajo su nuevo owner.

### 16.2 Post-adoption check-ins (infra existente)

DIM ya tiene `notification_type='post_adoption_reminder'` registrado en migración `0005_post_adoption_reminder_type.sql` y el campo `followup_months` en `finalizeAdoptionAction`. Esto habilita:

- El refugio setea `followup_months=3` al finalizar la adopción.
- Un cron (a implementar — registrado como follow-up) emite `post_adoption_reminder` notification al refugio a los 3 meses.
- El refugio decide si reachoutea al adopter para check-in informal — DIM no impone el reachout, solo recuerda.

**No es parte de este spec**. Mencionado para que el lector entienda que el seguimiento post-adopción YA está en el roadmap y se conecta naturalmente con foster→adopter pathway.

### 16.3 Si el adopter (ex-foster) abandona o re-entrega

Caso real: foster adopta, después de 6 meses no puede sostenerlo, lo devuelve al refugio. Flow:

- El (ex-)owner emite `custody_transferred` proposal a la org (flow estándar que ya existe).
- Refugio acepta → `shelter_custody` se reabre.
- El pet vuelve al circuito de tránsito/adopción.
- El historial completo queda en eventos: foster → adopción → retorno. Auditable, no se pierde nada.

Si el refugio quiere bloquear futuros fosters/adopciones al mismo user por un período (por la re-entrega), eso es feature separado (blacklist por org) — out of scope.

## 17. Adoption eligibility — listado de no-aptas

D14 introduce un flag por pet que la org setea al ingreso (intake) y puede mutar durante la estadía. Esta sección documenta el schema, el flow y el surface dedicado para "no aptas para adopción".

### 17.1 Schema additions

```sql
alter table pets
  add column adoption_eligible boolean,                          -- null = undetermined; true = eligible; false = not eligible
  add column adoption_ineligible_reason text,                    -- structured, see catalog below
  add column adoption_ineligible_reason_notes text,              -- free text complement (especially for 'other')
  add column adoption_ineligible_until timestamptz,              -- optional: when the org expects to re-evaluate
  add column adoption_eligibility_set_at timestamptz,
  add column adoption_eligibility_set_by_user_id uuid references profiles(id);

alter table pets
  add constraint pets_adoption_ineligible_reason_valid check (
    adoption_ineligible_reason is null
    or adoption_ineligible_reason in (
      'medical_treatment',     -- recibiendo tratamiento, no puede irse
      'behavioral_evaluation', -- pendiente evaluación de comportamiento
      'recovery',              -- post-cirugía o convalecencia
      'quarantine',            -- cuarentena sanitaria (parvo, rabia obs, etc.)
      'legal_hold',            -- disputa de custodia, decomiso, etc.
      'age',                   -- demasiado joven o demasiado viejo según política del refugio
      'pending_intake_eval',   -- recién entró, falta evaluación general
      'other'                  -- requiere notes_obligatorios
    )
  );

alter table pets
  add constraint pets_adoption_eligibility_consistent check (
    (adoption_eligible is not null and adoption_eligibility_set_at is not null)
    or (adoption_eligible is null and adoption_eligibility_set_at is null)
  );

alter table pets
  add constraint pets_adoption_ineligible_reason_required check (
    adoption_eligible is null
    or adoption_eligible = true
    or (adoption_eligible = false and adoption_ineligible_reason is not null)
  );

alter table pets
  add constraint pets_adoption_ineligible_other_needs_notes check (
    adoption_ineligible_reason != 'other'
    or (adoption_ineligible_reason_notes is not null and length(trim(adoption_ineligible_reason_notes)) > 0)
  );

create index pets_adoption_eligibility_idx
  on pets (adoption_eligible)
  where adoption_eligible is not null;

create index pets_adoption_ineligible_until_idx
  on pets (adoption_ineligible_until)
  where adoption_eligible = false and adoption_ineligible_until is not null;
```

### 17.2 Event type nuevo: `adoption_eligibility_set`

Append-only en `pet_events`, con Zod schema:

```ts
adoption_eligibility_set: z.object({
  eligible: z.boolean(),
  ineligible_reason: z.enum([
    "medical_treatment", "behavioral_evaluation", "recovery", "quarantine",
    "legal_hold", "age", "pending_intake_eval", "other"
  ]).optional(),
  ineligible_reason_notes: z.string().optional(),
  ineligible_until: z.string().datetime().optional(),  // ISO 8601
  previous_state: z.object({
    eligible: z.boolean().nullable(),
    reason: z.string().nullable(),
  }).optional(),  // snapshot for audit
})
```

El event documenta CADA cambio del flag. La denormalización en `pets.adoption_eligible` refleja el estado actual; los events dan history completo de cómo llegó ahí.

### 17.3 Server action

```ts
// app/actions/adoption-eligibility.ts

export async function setAdoptionEligibilityAction(input: {
  orgToken: string;
  petPublicToken: string;
  eligible: boolean;
  ineligibleReason?:
    | "medical_treatment" | "behavioral_evaluation" | "recovery"
    | "quarantine" | "legal_hold" | "age" | "pending_intake_eval" | "other";
  ineligibleReasonNotes?: string;
  ineligibleUntil?: string;  // ISO date, optional re-evaluation hint
}): Promise<{ ok: true } | { error: string }>;
```

**Validaciones**:
1. `requireCapability("pets.intake")` o capability nueva `pets.set_adoption_eligibility` (decisión: reusar `pets.intake` — es la misma persona que evalúa al ingreso).
2. Pet debe estar en `shelter_custody` activa de la org actor.
3. Si `eligible=false`: `ineligibleReason` obligatorio. Si reason=`other`: `ineligibleReasonNotes` obligatorio.
4. Si `eligible=true`: clear todos los campos `ineligible_*`.

**Transacción**:
1. UPDATE pets con los nuevos valores.
2. INSERT pet_events `adoption_eligibility_set` con previous_state snapshot.
3. Si `eligible=false`: INSERT notification a admins de la org (para visibility operativa).

### 17.4 Flow al intake (setting inicial)

Cuando una org rescata un pet y lo ingresa por primera vez:

```
Org abre /org/[orgToken]/intake
  → form de rescue/intake estándar (existente)
  → AGREGAR sección "Estado de adopción inicial":
      ( ) Apta para adopción
      ( ) No apta para adopción (especificar motivo abajo)
      (•) Sin determinar todavía (default — requiere evaluación posterior)

  → Si elige "No apta": muestra dropdown de razones + textarea para notes
  → Si elige "Sin determinar": pet entra con `adoption_eligible=null`, banner amarillo en pet detail "Falta evaluación de adopción"

  → Submit (intakeAction existente + setAdoptionEligibilityAction si se especificó)
```

### 17.5 Mutación posterior

Desde el pet detail `/org/[orgToken]/mascotas/[petToken]`, en una card "Estado de adopción":

```
┌──────────────────────────────────────────────────────────┐
│  Estado de adopción                                       │
│                                                           │
│  🟢 Apta para adopción                                   │
│  Desde 15 mar 2026 · seteado por Coordinator: María L.   │
│                                                           │
│  [ Cambiar a no apta ]                                    │
└──────────────────────────────────────────────────────────┘
```

O:

```
┌──────────────────────────────────────────────────────────┐
│  Estado de adopción                                       │
│                                                           │
│  🔴 No apta — Tratamiento médico                          │
│  Notas: "En tratamiento por parvovirus, esperamos        │
│         re-evaluar a las 6 semanas (≈ 5 mayo 2026)."     │
│  Re-evaluar: 5 may 2026                                   │
│  Desde 15 mar 2026 · seteado por Vet: Juan P.            │
│                                                           │
│  [ Marcar como apta ]   [ Editar motivo ]                 │
└──────────────────────────────────────────────────────────┘
```

### 17.6 Listado especial — `/org/[orgToken]/pets/no-aptas`

Surface dedicado. Requiere `pets.intake` capability (las mismas personas que setean el flag).

**Qué muestra**: TODOS los pets de la org con `adoption_eligible=false`, agrupados por `ineligible_reason`.

```
/org/[orgToken]/pets/no-aptas

┌─ Tratamiento médico (3) ────────────────────────────────┐
│  • Pepe   — parvovirus, re-eval 5 may                   │
│  • Luna   — fractura cadera, post-cirugía, re-eval —    │
│  • Toby   — leishmaniasis crónica, indefinido           │
└──────────────────────────────────────────────────────────┘

┌─ Cuarentena sanitaria (2) ──────────────────────────────┐
│  • Roco   — observación rabia (mordedura 12 mar), 10 d │
│  • Bella  — parvo aislamiento, re-eval 18 mar          │
└──────────────────────────────────────────────────────────┘

┌─ Evaluación de comportamiento (1) ──────────────────────┐
│  • Bruno  — mordedor humano, eval con etóloga 22 mar    │
└──────────────────────────────────────────────────────────┘

┌─ Legal hold (1) ────────────────────────────────────────┐
│  • Coco   — decomiso Ley 14.346, esperando fallo       │
└──────────────────────────────────────────────────────────┘
```

**Por pet en el listado**:
- Foto + nombre
- Razón estructurada + notes
- Re-evaluación esperada (si tiene `ineligible_until`)
- Días en el estado actual (similar a §6.3 días en tránsito)
- Acciones: [Marcar apta] (mismo flow §17.5), [Ver detalle del pet]

**Filtros**: por razón, por re-evaluación próxima (próximos 7d), por especie.

**Empty state**: "No hay pets con estado no-apto para adopción ahora mismo."

**Vencimiento de `ineligible_until`**: cuando la fecha pasa, el pet sigue siendo "no apta" pero aparece un banner amarillo en su row: "Re-evaluación venció el X. Confirmá si sigue no apta o marcala apta." No auto-cambio — la org decide explícitamente.

### 17.7 Visibility en futuros surfaces

Cuando se implemente el surface público `/adoptar` (Out-of-scope hoy, listado en AGENTS.md futuro):
- Pets con `adoption_eligible=true` aparecen en el listado público.
- Pets con `adoption_eligible IS NULL` o `false` NO aparecen.

Cuando se implemente el `/gob` regional dashboard (Fase 11 admin):
- Métrica nueva "Pets no aptas por jurisdicción" agrupada por razón. Útil para detectar concentración de problemas sanitarios o legales.

### 17.8 Relación con foster pool

**Importante**: el flag de eligibility **NO impide** que un pet reciba foster. Un pet en quarantine o en tratamiento médico puede perfectamente recibir foster — el foster lo asiste durante la condición. El listado de "no aptas" simplemente significa "no apta para adopción AHORA", no "no apta para foster".

Edge case: un foster del pool acepta un pet, después de 4 semanas decide adoptarlo (§15) pero el pet está con `adoption_eligible=false`. **Decisión**: `finalizeAdoptionAction` valida `pets.adoption_eligible=true` antes de finalizar. Si está false, error "Esta mascota no está apta para adopción hoy. Resolvé el motivo antes de finalizar." El refugio puede en ese momento decidir marcar como apta (si la condición resolvió) o postergar.

### 17.9 Out-of-scope adoption eligibility

- **Approval workflow para marcar apta**: hoy cualquier member con `pets.intake` puede flip. No requiere doble aprobación. Si emerge demanda (refugios grandes con coordinators vs vets), se agrega después.
- **Templates de evaluación** (checklists de criterios para marcar apta): out of scope. Cada refugio tiene su propia política — el flag es la información estructurada que comparten todos.
- **Listado público de no aptas**: no, es info operativa interna de la org. Govts pueden ver agregado (sin nombres) en regional dashboards.
- **Reglas auto por especie/edad**: ej. "todos los puppies < 2 meses son auto-no-aptas hasta vacc completa". Out of scope; la org decide caso por caso.

## 18. Próximo paso

Si el spec tiene OK, escribimos el plan en `plans/2026-05-18-foster-volunteers-pool.md` siguiendo el patrón de los demás (3 fases A-B-C como PRs separados con archivos exactos, schema migration, tests, smoke verification por fase).

**Decisiones pendientes** que necesito de vos antes del plan (las 8 open questions):

- **Críticas** (cambian el modelo): #1 (multi-foster simultáneo), #7 (cascade cancel), #8 (multi-foster por pet)
- **Cosméticas** (no cambian modelo): #2, #3, #4, #5, #6

Mi propuesta es ir con mis defaults para todas, pero **#1, #7, #8 deciden cuán "agresivo" es el system** — vale la pena confirmar antes de escribir código.
