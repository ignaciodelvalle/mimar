# Admin page — design spec

> Diseño exhaustivo de la página admin de DIM. Modelo de dos `account_type`s (`personal` y `institutional`), cuatro roles (`owner`, `vet`, `govt`, `admin`), govt scope-limitado por localidad, admin universal sin pets, workflows de approval / revocación / self-resign / deactivation con evidencia y audit log inmutable. Auto-contenido; el plan de implementación va aparte.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Estado:** implementado — código alineado a spec en migración 0015
> **Versión:** 2.3 — cierre de código vs spec: migration 0015 elimina los 3 tipos removidos de `approval_requests`, tightens CHECKs, reemplaza trigger. Reemplaza v2.2.

### Changelog

| Versión | Fecha | Cambios |
|---|---|---|
| **v2.3** | 2026-05-18 | **Cierre código-spec (migración 0015):** Tipos `role_upgrade_govt`, `role_upgrade_admin`, `govt_assignment_grant` eliminados del CHECK en `approval_requests` (nunca existieron en prod — cuentas institucionales se crean directo). Trigger renombrado de `enforce_admin_no_pets` a `enforce_institutional_no_pets` (scope correcto: `account_type='institutional'`). Constraints `profiles_account_type_role_match` y `profiles_institutional_no_pii` añadidos. Admin surfaces `/admin/cola`, `/admin/historial`, `/admin/auditoria`, `/admin/usuarios`, `/admin/organizaciones` + `/gob/historial` implementados. Routing `routeOutbreakSignalNotification` ahora usa `findAuthoritiesForJurisdiction` (govt-first, admin fallback) en lugar de admin-only. |
| v2.2 | 2026-05-17 | Split de surfaces `/gob` (govt scope-bound) vs `/admin` (universal meta-admin). Los 3 tipos removidos respecto a v2.0 documentados en D7. |
| v2.1 | — | Versión anterior. |

---

## 1. Por qué este documento existe

DIM hoy tiene **submission flows** (los usuarios pueden pedir upgrade a vet o registrar una org) pero **cero approval UI**. Ver `app/actions/upgrade.ts` — los usuarios mandan matrícula/CUIT, las filas se guardan con `matriculaVerified=false` o `organizations.verified=false`, y el admin tiene que entrar a **Supabase Studio** para flippear los flags a mano. Inmantenible más allá de los primeros diez usuarios.

`AGENTS.md → User roles & account types` establece el modelo conceptual: dos account types, cuatro roles, hard constraints DB-enforced. Este doc cierra el hueco operativo con el diseño técnico de la página admin: schema, server actions, RLS, UI surfaces, capability matrix, y los flows de approval / revocation / deactivation.

## 2. Decisiones cerradas (no relitigar)

Tomadas con Nacho explícitamente. Si encontrás algo en este doc que las contradice, gana lo de acá. Si encontrás algo que contradice `AGENTS.md → User roles & account types`, gana AGENTS.md.

| # | Decisión | Razón |
|---|---|---|
| D1 | **Dos account types** (`personal`, `institutional`) en columna nueva `profiles.account_type`. Cada uno permite roles distintos | Personal = humano con pets y Mi Argentina. Institutional = service account sin pets ni DNI. Modelos fundamentalmente distintos; mezclar fuerza special-casing en todas las queries |
| D2 | **Cuatro roles**: `owner`, `vet` (personal); `govt`, `admin` (institutional). Jerarquía implícita por capabilities, no por enum de tiers | Refleja el modelo argentino — autoridad local + central. Sin tiers de admin |
| D3 | **No existe "upgrade" de personal a institutional.** Las cuentas institucionales se crean directo por un admin existente, ingresando email + display name + role + (govt) localidades | Si un humano necesita los dos accesos, tiene dos cuentas distintas con dos emails. Más limpio que migrar identidades |
| D4 | **Govt scope-limitado por (provincia, localidad)** vía tabla `govt_assignments`. Multi-locality por govt (varias rows) | Cubre las localidades donde efectivamente opera. El admin asigna y revoca localidades directamente — no hay approval_request para esto |
| D5 | **Institutional accounts no tienen pets.** CHECK + trigger DB-enforced | Excepción explícita al principio "Role does not restrict owning pets" en AGENTS.md. Aplica a govt y admin por igual vía `account_type='institutional'` |
| D6 | **Fallback al admin queue**. Si no hay govt activo para la localidad de un request, el request es visible al admin que lo resuelve directamente | Evita que requests queden en limbo. Cubierto automáticamente por el `NOT EXISTS` del scope match (§6) |
| D7 | **Approval workflow**: tabla `approval_requests` con type + target polimórfico + jurisdicción + payload. Tres tipos en v1: `role_upgrade_vet`, `organization_verification`, `service_provider_scheduling`. Mutación al target en transacción de aprobación; row queda como artefacto inmutable | Coherente con el patrón de DIM. Permite re-aplicación post-rechazo. Los tipos eliminados respecto a v2.0 (`role_upgrade_govt`, `role_upgrade_admin`, `govt_assignment_grant`) no existen porque cuentas institucionales se crean direct, no upgradean |
| D8 | **Revocación como acción directa**, no como approval_request. La autoridad ejecuta directo, con evidencia + motivo obligatorios. Logged en `audit_log` con `action='revocation_*'` | Quien revoca tiene autoridad — no necesita segunda aprobación. Lo que necesita es traza |
| D9 | **Self-resign solo para `role='vet'`** (cuenta personal). Para institucionales: govt puede self-deactivate con coverage check; admin **no puede** self-deactivate jamás | Vet renunciando es lifestyle (dejé de ejercer). Govt deactivate es retirar un service-account con safeguard de continuidad. Admin self-deactivate sería un footgun catastrófico |
| D10 | **`audit_log` unificado** captura toda acción de autoridad: approve, reject, revoke, deactivate, create_institutional, self_resignation_vet, evidence_viewed, pii_queried. Append-only enforced por trigger | Mismo patrón que `pet_events` para el dominio "acciones de autoridad". Inmutable, auditable |
| D11 | **Bootstrap del primer admin** vía Studio (manual seed con account_type='institutional', role='admin'). Subsiguientes admins creados por el admin existente | Chicken-and-egg unavoidable. El primer admin es Nacho con email nuevo dedicado, distinto de su email personal |
| D12 | **Single-operator por cuenta institucional en v1.** Una credencial por govt/admin. El audit log muestra la cuenta institucional como actor. Multi-operator vía memberships queda para futura iteración | Suficiente para v1 con pocos admins/govts. Handoff via password reset del admin |

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **Account type** | Personal o institutional. Define qué roles permite y qué constraints aplican | `profiles.account_type` |
| **Personal account** | Cuenta de un humano con pets, posible vínculo Mi Argentina, posible matrícula vet | `profiles.account_type='personal'` |
| **Institutional account** | Service account para gobernanza. Sin pets, sin DNI, sin matrícula | `profiles.account_type='institutional'` |
| **Approval request** | Solicitud de aprobación con evidencia adjunta y estado. Generada por personal user, decidida por govt/admin | `approval_requests` (nueva) |
| **Govt assignment** | Una localidad asignada a un govt institutional. Multi-row por govt | `govt_assignments` (nueva) |
| **Audit log entry** | Fila inmutable que registra cualquier acción de autoridad (aprobar, rechazar, revocar, desactivar, leer PII, crear cuenta institucional) | `audit_log` (nueva) |
| **Target** | La fila que la aprobación mutará (un user, una org, un service provider) | `approval_requests.target_*_id` |
| **Actor** | El usuario que ejecuta una acción (admin/govt aprobando, vet renunciando) | `audit_log.actor_user_id` |
| **Deactivation** | Marca una cuenta institucional como retirada. Diferente de delete; preserva audit history | `profiles.deactivated_at` (nuevo) |

## 4. Domain model

### 4.1 Extender `profiles`

```sql
-- Step 1: extend user_role enum with 'admin'
alter type user_role add value if not exists 'admin';

-- Step 2: add account_type column with default 'personal'
alter table profiles add column account_type text not null default 'personal';
alter table profiles add constraint profiles_account_type_valid
  check (account_type in ('personal', 'institutional'));

-- Step 3: add deactivated_at for institutional retirement
alter table profiles add column deactivated_at timestamptz;

-- Step 4: account_type ↔ role match (CHECK constraint)
alter table profiles add constraint profiles_account_type_role_match
  check (
    (account_type = 'personal' and role in ('owner', 'vet'))
    or
    (account_type = 'institutional' and role in ('govt', 'admin'))
  );

-- Step 5: institutional accounts have NULL personal-identity fields
alter table profiles add constraint profiles_institutional_no_pii
  check (
    account_type = 'personal'
    or (
      dni_number is null
      and dni_verified = false
      and matricula_number is null
      and matricula_jurisdiccion is null
      and matricula_verified = false
    )
  );
```

**Pre-migración (single-shot):** todas las filas existentes se quedan con `account_type='personal'` por el default. Si alguna ya tiene `role='govt'` (asignado vía Studio en el pasado), antes de la migración se debe decidir qué hacer con ellas — re-crearlas como `institutional` o downgrade a `owner`. El plan recomendado: rebajar a `owner` y luego re-crearlas correctamente via la UI nueva, asumiendo que esos cases son pocos y testimoniales.

### 4.2 `govt_assignments`

```sql
create table govt_assignments (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references profiles(id) on delete cascade,
  jurisdiction_country   text not null default 'AR',
  jurisdiction_province  text not null,
  jurisdiction_locality  text not null,
  granted_by_user_id     uuid references profiles(id),       -- always an active admin
  granted_at             timestamptz not null default now(),
  revoked_at             timestamptz,
  revoked_by_user_id     uuid references profiles(id),
  revocation_reason      text,
  notes                  text,
  created_at             timestamptz not null default now()
);

create unique index govt_assignments_active_unique
  on govt_assignments (user_id, jurisdiction_province, jurisdiction_locality)
  where revoked_at is null;

create index govt_assignments_user_active_idx
  on govt_assignments (user_id) where revoked_at is null;

create index govt_assignments_locality_idx
  on govt_assignments (jurisdiction_province, jurisdiction_locality)
  where revoked_at is null;
```

**Cómo se inserta:** un govt assignment se crea solo vía direct admin action (al crear la cuenta govt, o al agregar localidad después). Nunca vía approval_request. Application-level invariant: `user_id` debe ser una cuenta `account_type='institutional' AND role='govt'`.

### 4.3 Trigger: institutional accounts no pueden tener pets

```sql
create or replace function public.enforce_institutional_no_pets()
returns trigger
language plpgsql
as $$
declare
  target_account_type text;
begin
  -- Only check user-owned ownerships (organization-owned is irrelevant)
  if new.owner_user_id is null then
    return new;
  end if;

  select account_type into target_account_type
  from public.profiles where id = new.owner_user_id;

  if target_account_type = 'institutional' then
    raise exception 'Cuentas institucionales (govt, admin) no pueden tener mascotas asignadas.'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists ownerships_institutional_no_pets on public.ownerships;
create trigger ownerships_institutional_no_pets
  before insert or update on public.ownerships
  for each row execute function public.enforce_institutional_no_pets();
```

Aplicado vía Studio (mismo pattern que `db/triggers.sql`).

### 4.4 `approval_requests`

```sql
create table approval_requests (
  id                          uuid primary key default gen_random_uuid(),
  public_token                text not null unique,                 -- e.g. APR-XXXX-XXXX
  type                        text not null,                        -- see catalog below
  status                      text not null default 'pending',      -- 'pending' | 'approved' | 'rejected' | 'withdrawn'

  applicant_user_id           uuid not null references profiles(id) on delete cascade,
  initiated_by                text not null default 'self',         -- 'self' | 'authority'
  initiated_by_user_id        uuid references profiles(id),

  target_user_id              uuid references profiles(id) on delete cascade,
  target_organization_id      uuid references organizations(id) on delete cascade,
  target_service_provider_id  uuid references service_providers(id) on delete cascade,

  jurisdiction_country        text not null default 'AR',
  jurisdiction_province       text not null,
  jurisdiction_locality       text not null,

  payload                     jsonb not null default '{}'::jsonb,

  decided_at                  timestamptz,
  decided_by_user_id          uuid references profiles(id),
  decision_notes              text,
  withdrawn_at                timestamptz,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint approval_type_valid check (type in (
    'role_upgrade_vet',
    'organization_verification',
    'service_provider_scheduling'
  )),
  constraint approval_status_valid check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  constraint approval_initiated_valid check (initiated_by in ('self', 'authority')),

  constraint approval_target_consistent check (
    case type
      when 'role_upgrade_vet'             then target_user_id is not null and target_organization_id is null and target_service_provider_id is null
      when 'organization_verification'    then target_user_id is null and target_organization_id is not null and target_service_provider_id is null
      when 'service_provider_scheduling'  then target_user_id is null and target_organization_id is null and target_service_provider_id is not null
    end
  ),

  constraint approval_decision_consistent check (
    (status in ('approved', 'rejected') and decided_at is not null and decided_by_user_id is not null)
    or (status in ('pending', 'withdrawn') and decided_at is null and decided_by_user_id is null)
  )
);

create index approval_requests_status_idx        on approval_requests (status, created_at) where status = 'pending';
create index approval_requests_applicant_idx     on approval_requests (applicant_user_id, created_at desc);
create index approval_requests_juris_idx         on approval_requests (jurisdiction_province, jurisdiction_locality) where status = 'pending';
create index approval_requests_type_idx          on approval_requests (type, status);
```

**Catálogo de tipos (3 en v1):**

- `role_upgrade_vet` — owner personal solicita upgrade a vet. Payload: `{ matricula_number, matricula_jurisdiccion, especialidad?, anos_experiencia? }`. Aprobado por govt de su locality (fallback: admin).
- `organization_verification` — org solicita verified=true. Payload: `{ org_type, cuit?, personeria_juridica_number?, additional_documents_summary? }`. Aprobado por govt de su locality (fallback: admin).
- `service_provider_scheduling` — provider solicita scheduling_approved=true. Payload: `{ service_types_planned: string[], operational_zone_description, capacity_note }`. Aprobado por govt de su locality (fallback: admin).

**Lo que NO está en el catálogo (porque es direct admin action, no approval):**

- Crear cuenta govt institutional → §7.4
- Crear cuenta admin institutional → §7.4
- Asignar localidad a govt existente → §7.4
- Revocar localidad de govt → §7.7
- Deactivate govt institutional → §7.5
- Deactivate admin institutional → §7.6
- Revocar verified de org → §7.7
- Revocar matriculaVerified de vet → §7.7
- Revocar scheduling de provider → §7.7
- Self-resignation de vet → §7.8

### 4.5 `audit_log`

```sql
create table audit_log (
  id                          uuid primary key default gen_random_uuid(),
  actor_user_id               uuid not null references profiles(id) on delete restrict,
  action                      text not null,
  approval_request_id         uuid references approval_requests(id),
  target_user_id              uuid references profiles(id),
  target_organization_id      uuid references organizations(id),
  target_service_provider_id  uuid references service_providers(id),
  target_govt_assignment_id   uuid references govt_assignments(id),
  payload                     jsonb not null default '{}'::jsonb,
  performed_at                timestamptz not null default now()
);

create index audit_log_actor_idx          on audit_log (actor_user_id, performed_at desc);
create index audit_log_request_idx        on audit_log (approval_request_id);
create index audit_log_target_user_idx    on audit_log (target_user_id);
create index audit_log_action_idx         on audit_log (action, performed_at desc);

-- Append-only enforcement (same pattern as pet_events)
create or replace function public.enforce_audit_log_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only. % blocked.', tg_op
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists audit_log_no_update on public.audit_log;
create trigger audit_log_no_update before update on public.audit_log
  for each row execute function public.enforce_audit_log_append_only();

drop trigger if exists audit_log_no_delete on public.audit_log;
create trigger audit_log_no_delete before delete on public.audit_log
  for each row execute function public.enforce_audit_log_append_only();
```

**Action catalog** (TEXT, sin enum):

| action | Cuándo | Payload típico |
|---|---|---|
| `request_viewed` | Authority abre detalle de approval_request | `{}` |
| `evidence_viewed` | Authority visualiza un attachment de evidencia | `{ attachment_id }` |
| `request_approved` | Authority aprueba un request | `{ mutations_applied: [...] }` |
| `request_rejected` | Authority rechaza | `{ reason }` |
| `institutional_govt_created` | Admin crea cuenta govt nueva | `{ email, display_name, initial_localities: [{province, locality}, ...] }` |
| `institutional_admin_created` | Admin crea cuenta admin nueva | `{ email, display_name }` |
| `govt_locality_assigned` | Admin asigna localidad nueva a govt existente | `{ govt_assignment_id, province, locality }` |
| `govt_locality_revoked` | Admin u otro govt en scope revoca una localidad de un govt | `{ govt_assignment_id, reason, evidence_attachment_ids }` |
| `govt_self_deactivated` | Operador govt se desactiva con coverage check pasado | `{ reason?, covered_by: [{user_id, locality}] }` |
| `govt_deactivated_by_admin` | Admin desactiva un govt directamente con revocación | `{ reason, evidence_attachment_ids }` |
| `admin_deactivated_by_admin` | Admin desactiva otro admin (nunca self) | `{ reason, evidence_attachment_ids, remaining_admins_count }` |
| `revocation_org_verified` | Govt o admin revoca verified=true de una org | `{ reason, evidence_attachment_ids }` |
| `revocation_vet_role` | Govt o admin revoca rol vet (downgrade a owner) | `{ reason, evidence_attachment_ids }` |
| `revocation_scheduling` | Govt o admin revoca scheduling_approved de provider | `{ reason, evidence_attachment_ids }` |
| `self_resignation_vet` | Vet usa form de self-resign | `{ reason? }` |
| `operator_credentials_reset` | Admin resetea credentials de una cuenta institucional (handoff de operador) | `{ method: 'magic_link' \| 'temp_password' }` |
| `pii_queried` | Authority busca users/orgs por DNI / email completo / CUIT | `{ query, result_count }` |
| `admin_seeded` | Bootstrap manual del primer admin via Studio (informativo) | `{ source: 'studio' }` |

### 4.6 Extender `attachments`

```sql
alter table attachments
  add column approval_request_id uuid references approval_requests(id) on delete cascade,
  add column audit_log_id        uuid references audit_log(id) on delete cascade;
```

Una attachment puede colgarse de un approval_request (evidencia presentada) o de un audit_log entry (evidencia de revocación o deactivation). `purpose='approval_evidence'` o `purpose='revocation_evidence'` distingue para policies de storage.

### 4.7 Lo que NO se toca

- `profiles.matriculaNumber`, `matriculaJurisdiccion`, `matriculaVerified` siguen igual — se setean en la aprobación (account_type='personal' only por el CHECK)
- `organizations.verified`, `verified_at`, `verified_by_user_id` siguen igual
- `service_providers.scheduling_approved` (cuando exista) sigue igual
- Triggers y RLS existentes (welfare, scheduling, etc.) no se tocan

La verdad operativa del estado actual queda en las tablas de dominio. Las tablas nuevas son **el sistema de gobernanza**, no la verdad operativa.

## 5. Capability matrix

Quién puede hacer qué. Hardcoded por role + account_type.

### Surface ownership

| Action category | Surface | Visible to | Notes |
|---|---|---|---|
| Approvals scoped a locality | `/gob/cola` | Govt con assignment covering | Org verification, vet upgrade, service offering, scheduling |
| Approvals fallback (no govt covering) | `/admin/cola` | Admin | Same actions as `/gob/cola` but for localities sin govt |
| Approvals meta (role upgrade to govt/admin) | `/admin/cola` | Admin only | role_upgrade_govt, role_upgrade_admin |
| Crear cuentas institucionales | `/admin/cuentas` | Admin only | Create govt, create admin |
| Dashboards regionales | `/gob/dashboards` | Govt en su scope | Vaccination coverage, mortality clusters, etc., filtered to assigned localities |
| Dashboards del aplicativo | `/admin/sistema` | Admin only | DAU, signups, retention, perf, costs |
| Audit log propio | `/gob/historial` o `/admin/historial` | Cada user el suyo | |
| Audit log global cross-govt | `/admin/auditoria` | Admin only | |
| Business rules en mi scope | `/gob/reglas` | Govt en su scope | Locality / province scoped rules (future) |
| Business rules universales | `/admin/reglas` | Admin | Country-wide defaults, override capability per any jurisdiction (future) |

### Approvals (approval_requests)

| Acción | govt en scope | admin |
|---|---|---|
| Ver queue de su scope | ✓ | ✓ (universal) |
| Aprobar `organization_verification` (locality propia) | ✓ | ✓ |
| Aprobar `role_upgrade_vet` (locality propia) | ✓ | ✓ |
| Aprobar `service_provider_scheduling` (locality propia) | ✓ | ✓ |
| Aprobar request en localidad sin govt (fallback) | — | ✓ |

### Direct admin actions (no approval, logged in audit_log)

| Acción | govt en scope | admin |
|---|---|---|
| Crear cuenta institutional govt | — | ✓ |
| Crear cuenta institutional admin | — | ✓ |
| Asignar localidad nueva a govt existente | — | ✓ |
| Revocar localidad puntual de un govt | ✓ (si la locality es suya) | ✓ |
| Desactivar govt institutional (revocación directa) | — | ✓ |
| Desactivar admin institutional (otro admin) | — | ✓ (con last-admin safeguard) |
| Resetear credentials de cuenta institutional (handoff) | — | ✓ |
| Revocar `org.verified` (locality propia) | ✓ | ✓ |
| Revocar `matriculaVerified` / rol vet (locality propia) | ✓ | ✓ |
| Revocar `scheduling_approved` de provider (locality propia) | ✓ | ✓ |

### Self actions

| Acción | Quién lo dispara | Auth check |
|---|---|---|
| Self-resignation vet (vet → owner) | el vet mismo | session.user.role === 'vet' AND account_type='personal' |
| Govt self-deactivation | el govt mismo | session.user.role === 'govt'. Coverage check passes |
| Admin self-deactivation | — | **PROHIBIDO** (server action refuses) |

## 6. Scope matching

**Govt queue:**

```sql
select r.* from approval_requests r
where r.status = 'pending'
  and exists (
    select 1 from govt_assignments g
    where g.user_id = :govt_user_id
      and g.revoked_at is null
      and g.jurisdiction_province = r.jurisdiction_province
      and g.jurisdiction_locality = r.jurisdiction_locality
  );
```

**Admin queue (fallback):**

```sql
select r.* from approval_requests r
where r.status = 'pending'
  and not exists (
    select 1 from profiles p
    join govt_assignments g on g.user_id = p.id
    where p.role = 'govt'
      and p.account_type = 'institutional'
      and p.deactivated_at is null
      and g.revoked_at is null
      and g.jurisdiction_province = r.jurisdiction_province
      and g.jurisdiction_locality = r.jurisdiction_locality
  );
```

**Sutileza del fallback automático.** Cuando un govt es desactivado, sus `govt_assignments` se marcan `revoked_at` y su `profile.deactivated_at` se setea. El `NOT EXISTS` de la query del admin deja de matchear → los requests de esas localidades aparecen automáticamente en la cola del admin. Sin polling, sin migración manual.

## 7. Flujos

### 7.1 Self-service approval (vet, org, provider scheduling)

```
Usuario abre /cuenta
  → ve su rol actual y opciones de upgrade
  → click "Quiero ser veterinario/a" (o "Registrar mi org", "Solicitar scheduling")
  → form pide jurisdicción (province + locality donde opera) + datos específicos + evidencia
  → submit → createApprovalRequestAction(type='role_upgrade_vet', ...)
    Transacción atómica:
      1. Insert en approval_requests con status='pending'
      2. Insert attachments con purpose='approval_evidence', approval_request_id=...
      3. Update profiles (matriculaNumber, matriculaJurisdiccion) — info submitida, NO verified
      4. Notify govt(s) en esa locality (o admin si no hay govt activo)
  → Redirect a /cuenta/solicitudes/{public_token}
  → Usuario puede ver / withdraw mientras esté pending
```

Idéntico para `organization_verification` y `service_provider_scheduling`.

### 7.2 Admin-initiated approval request

```
Admin o govt navega a /admin/usuarios o /admin/organizaciones
  → busca al user u org
  → click "Proponer upgrade a vet" / "Proponer verificación"
  → form prefilled con datos visibles
  → submit → createApprovalRequestAction(initiated_by='authority', ...)
  → request entra al queue normal. La misma authority puede aprobarlo si tiene capability —
    el audit log lo refleja con dos entries (created por authority X, approved por X o por otra).
```

### 7.3 Decisión (approve / reject)

```
Authority abre /admin/cola → ve queue de su scope
  → click → /admin/cola/{public_token}
    Auto-log: action='request_viewed', actor_user_id=current
  → ve aplicante, jurisdicción, payload, evidencia
  → click en evidencia → action='evidence_viewed' logged, signed URL, abre
  → toma decisión

  APROBAR (atomic):
    1. requireCapability(authority, request.type, request.jurisdiction)
    2. status='pending' check (anti-race)
    3. Mutación al target:
       - role_upgrade_vet: profiles.role='vet', matriculaVerified=true
       - organization_verification: orgs.verified=true, verified_by, verified_at
       - service_provider_scheduling: providers.scheduling_approved=true, ...
    4. UPDATE approval_requests SET status='approved', decided_*
    5. INSERT audit_log action='request_approved'
    6. INSERT notification al applicant

  RECHAZAR (atomic):
    1. requireCapability idem
    2. status='pending' check
    3. UPDATE approval_requests SET status='rejected' + decision_notes obligatorio
    4. INSERT audit_log action='request_rejected'
    5. INSERT notification al applicant con motivo visible
```

### 7.4 Creación de cuenta institutional (direct admin action)

Solo un admin existente puede crear cuentas institutional. Flow:

```
Admin abre /admin/govts → "Crear cuenta govt nueva"
  (o /admin/admins → "Crear cuenta admin nueva")
  → form:
    - Email institucional
    - Display name (e.g. "Secretaría Sanitaria CABA")
    - Para govt: lista inicial de localidades (province + locality, multi-select)
  → submit → createInstitutionalAccountAction(role='govt' | 'admin', ...)

  Atomic transaction:
    1. requireCapability: actor must have role='admin' AND account_type='institutional'
    2. Validar email no exista
    3. Crear auth.users entry vía supabase admin SDK
       - email confirmed = true (admin-created accounts are pre-confirmed)
       - genera temp password OR magic link
    4. Insert public.profiles con account_type='institutional', role=<role>, display_name
       - dni_number=null, matricula_*=null (CHECK lo enforce además)
    5. Si role='govt': insert govt_assignments para cada locality inicial
    6. Insert audit_log action='institutional_govt_created' (or 'institutional_admin_created')
       con payload {email, display_name, initial_localities}
    7. Send invitation email con magic link / temp password (out-of-band — provider)

  Failure modes:
    - email ya existe → error claro
    - locality format inválido → error
    - actor no es admin → 403
    - rollback completo si cualquier paso falla
```

**Importante:** la creación es atómica — si falla cualquier paso, no queda ni el auth user ni el profile ni los assignments. La consistencia requiere que el SDK de Supabase Auth permita rollback (en práctica: si falla el insert del profile, el auth user creado se borra explícitamente en el catch).

### 7.5 Govt self-deactivation (with coverage check)

El operador del govt institucional puede decidir desactivar la cuenta — pero el server action chequea coverage.

```
Govt operator abre /cuenta → "Desactivar esta cuenta institucional"

Form muestra:
  - Lista de mis localidades actualmente asignadas
  - Por cada locality: lista de OTROS govts activos que también cubren esa locality
  - Si alguna locality tiene SOLO yo como govt → warning rojo:
    "Esta localidad quedaría sin govt si te desactivás. Pedile a admin que asigne otro govt antes."
  - Si TODAS las localidades tienen al menos otro govt → form de confirmación:
    "Tu cuenta va a quedar desactivada. Tus localidades cascadean a los otros govts.
     Pendientes pasan a sus colas o a la del admin como fallback."
  - Motivo opcional (textarea)
  - Checkbox "Entiendo y confirmo"
  - Botón "Desactivar cuenta"

Submit → govtSelfDeactivateAction:
  Transacción atómica:
    1. requireCapability: session user.role='govt' AND account_type='institutional'
    2. Coverage check:
       for each locality in my active govt_assignments:
         count other_active_govts := count govt_assignments where
           user_id != me AND revoked_at IS NULL
           AND province = locality.province AND locality = locality.locality
           AND user.deactivated_at IS NULL
         if count == 0:
           raise "Localidad X queda sin coverage. Acción bloqueada."
    3. Mark all my govt_assignments as revoked_at=now(), revoked_by_user_id=me,
       revocation_reason='Self-deactivation'
    4. Set profiles.deactivated_at=now() for me
    5. INSERT audit_log action='govt_self_deactivated'
       payload={ reason?, covered_by: [{user_id, locality}, ...] }
    6. Send notification to admin(s) and to the remaining govts that received cascading scope
  Commit.

Post-commit effect:
  - auth.users sigue existiendo (no se borra) pero la app blockea login por
    chequeo de profiles.deactivated_at IS NOT NULL en el layout /admin
  - Pending approval_requests de mis ex-localidades caen al fallback admin queue
    automáticamente vía el NOT EXISTS de §6
```

### 7.6 Admin deactivation (by another admin, with last-admin check)

```
Admin A abre /admin/admins → ve lista de admins activos
  → click sobre Admin B → "Desactivar este admin"

Form muestra:
  - Banner explicando: "Estás por desactivar Admin B. Tras la acción no podrá entrar al admin page."
  - Motivo (textarea, requerido, min 30 chars)
  - Evidencia (al menos 1 attachment requerido)
  - Confirm checkbox: "Entiendo que esta acción solo es reversible recreando la cuenta"
  - Botón "Desactivar"

Submit → adminDeactivateAdminAction(target_admin_user_id, reason, attachment_ids):
  Transacción atómica:
    1. requireCapability: session user.role='admin' AND account_type='institutional'
    2. Validar target_admin_user_id != session.user.id  (no self-deactivate)
    3. Count active admins (account_type='institutional' AND role='admin' AND deactivated_at IS NULL)
       If count - 1 < 1 (i.e. desactivar B dejaría 0 admins):
         raise "No podés desactivar al último admin del sistema."
    4. Set profiles.deactivated_at=now() para B
    5. Insert attachments con purpose='revocation_evidence', audit_log_id=<placeholder>
    6. INSERT audit_log action='admin_deactivated_by_admin'
       payload={ reason, evidence_attachment_ids, remaining_admins_count: count-1 }
    7. Update attachments con audit_log_id real
    8. Notification a Admin B con motivo visible
  Commit.

Post-commit: Admin B no puede acceder a /admin (gated por deactivated_at IS NULL check).
```

### 7.7 Revocación (acción directa sobre estado de cuentas / orgs / providers)

Govt o admin pueden revocar estado verified de orgs, scheduling de providers, o rol vet de personal accounts en su scope.

```
Authority navega a /admin/usuarios/{userId} (vet) o /admin/organizaciones/{orgId} (org)
  → click "Revocar [tipo]"

Form:
  - Motivo (textarea, requerido, min 30 chars)
  - Evidencia (mínimo 1 attachment)
  - Confirm checkbox contextual

Submit → revokeAction(type, target_id, reason, attachment_ids):
  Transacción atómica:
    1. requireCapability(authority, revocation_type, target_scope)
    2. Mutación al target:
       - revocation_org_verified: orgs.verified=false (verified_by_user_id y verified_at quedan como histórico)
       - revocation_vet_role: profiles.role='owner', matriculaVerified=false
         (matriculaNumber stays — es info del user)
       - revocation_scheduling: providers.scheduling_approved=false
    3. Insert attachments con purpose='revocation_evidence', audit_log_id=<placeholder>
    4. INSERT audit_log action='revocation_*', payload={ reason, evidence_attachment_ids }
    5. Update attachments con audit_log_id real
    6. Notification al target con motivo visible y CTA "Re-aplicar"
  Commit.
```

**Revocación de locality específica de un govt** sigue el mismo pattern pero el target es `govt_assignment_id`. Marca `revoked_at` en esa row puntual; el govt sigue activo con sus otras localidades.

### 7.8 Self-resignation (vet only)

Solo aplica a personal vets. Govt no usa esta — usa §7.5. Admin nunca.

```
Vet abre /cuenta → "Renunciar a mi rol de veterinario/a"

Form muestra:
  - "Estás por renunciar a tu rol de veterinario/a."
  - Consecuencias específicas:
    "Perderás la posibilidad de escribir eventos como vet."
    "Tu matrícula quedará registrada pero marcada como NO verificada."
    "Tus mascotas propias siguen siendo tuyas."
    "Para volver a tener el rol vet, vas a tener que solicitarlo de cero y ser aprobado nuevamente."
  - Motivo opcional (textarea)
  - Checkbox "Entiendo y confirmo"
  - Botón "Renunciar"

Submit → vetSelfResignAction:
  Transacción atómica:
    1. Validar session.user.role === 'vet' AND account_type='personal'
    2. UPDATE profiles SET role='owner', matriculaVerified=false WHERE id=session.user.id
    3. INSERT audit_log action='self_resignation_vet', payload={ reason? }
    4. INSERT notification al user confirmando
  Commit.
```

## 8. UI surfaces

Route group `/admin`. Layout chequea `profiles.role IN ('govt','admin') AND account_type='institutional' AND deactivated_at IS NULL`. Si no, redirect a `/admin/sin-acceso`.

### `/admin` — dashboard
- Cards: requests pending en mi scope, decisiones en últimos 7 días, mis localidades (govt) o "Universal" (admin)
- Recent activity feed (audit_log de mis acciones)
- Quick links a queue y gestión

### `/admin/cola` — queue de approvals
- Lista approval_requests pending en mi scope (§6)
- Filters por type, province, fecha

### `/admin/cola/[publicToken]` — review one request
- Header, applicant, evidencia, payload
- Acciones: Aprobar / Rechazar

### `/admin/usuarios` — buscar personal users
- Search por display_name, email (admin) o por jurisdicción para govt
- Resultados muestran rol + acciones contextuales:
  - "Proponer upgrade a vet" (si owner y authority en scope)
  - "Revocar rol vet" (si vet y authority en scope)
  - Búsqueda logged como `pii_queried`

### `/admin/organizaciones` — buscar orgs
- Similar, con acción "Verificar" / "Revocar verificación"

### `/admin/govts` — gestión govts (admin only)
- Lista de cuentas govt activas
- "Crear cuenta govt nueva" → flow §7.4
- "Asignar localidad nueva" a un govt existente
- "Revocar localidad puntual"
- "Desactivar govt" → flow §7.7 revocación directa

### `/admin/admins` — gestión admins (admin only)
- Lista de cuentas admin activas con contador
- "Crear cuenta admin nueva" → flow §7.4
- "Desactivar admin" → flow §7.6 (con last-admin check)
- "Resetear credentials" → handoff de operador

### `/admin/historial` — audit log de self
- Mis acciones pasadas

### `/cuenta` — para users personal
- Vista del rol actual
- "Solicitar upgrade a vet" (si owner)
- "Renunciar a rol vet" (si vet) → flow §7.8

### `/cuenta/upgrade` — submission self-service
- Forms para `role_upgrade_vet`. (Forms para `organization_verification` y `service_provider_scheduling` viven en sus propios surfaces — orgs en `/orgs/nueva`, providers en el spec de scheduling)

### `/cuenta/solicitudes` — mis approval_requests
- Lista de las solicitudes que envié con status
- Withdraw button si pending

### `/cuenta/desactivar` — solo para govts
- Form §7.5 con coverage check

## 9. RLS y security

**`profiles`:** SELECT propio + admins lo ven todo. UPDATE solo via server action. CHECK constraints enforce account_type ↔ role match y "no PII en institutional".

**`govt_assignments`:** SELECT propio (lee sus assignments) + admin (todas). INSERT/UPDATE solo via server action. DELETE nunca.

**`approval_requests`:** SELECT del applicant + govt en scope + admin. INSERT vía server action. UPDATE vía server action.

**`audit_log`:** SELECT del actor (sus entries) + admin (todas). Govt NO ve audit_log de otros govts (audit lateral no existe en v1). INSERT vía server action. UPDATE/DELETE prohibidos (trigger).

**`attachments` con `purpose='approval_evidence'` o `purpose='revocation_evidence'`:** SELECT del owner del request + authorities en scope. Bucket privado, signed URLs server-side.

**Server actions como authorization boundary.** Cada server action arranca con `requireCapability(user, action, scope?)` que valida `role`, `account_type`, `deactivated_at`, y scope match. RLS es defense-in-depth.

## 10. Bootstrap

```sql
-- Run once, manually, en Studio:

-- Step 1: crear auth user (via Studio Auth → Add user)
--   email: el email institucional admin (ej. nacho-admin@dim.ar)
--   set temp password

-- Step 2: insert profile como institutional admin
insert into public.profiles (id, account_type, role, display_name)
values ('<seeded_auth_user_id>', 'institutional', 'admin', 'DIM Admin Bootstrap');

-- Step 3: log the seed
insert into public.audit_log (actor_user_id, action, target_user_id, payload)
values ('<seeded_auth_user_id>', 'admin_seeded', '<seeded_auth_user_id>', '{"source":"studio"}');
```

De ahí en adelante, todas las cuentas institucionales se crean via §7.4. Las personales via self-serve signup normal.

## 11. Notificaciones

`Notification.notification_type` agrega valores (TEXT, sin migración):

- `approval_request_submitted_self` → al aplicante
- `approval_request_pending_authority` → govt(s)/admin en scope
- `approval_request_approved` → al aplicante
- `approval_request_rejected` → al aplicante con motivo
- `revocation_executed` → al target revocado, con CTA "Re-aplicar"
- `institutional_account_created` → al operador de la cuenta nueva con magic link
- `operator_credentials_reset` → al operador con nueva credencial
- `govt_locality_assigned` → al govt cuando le agregan locality nueva
- `govt_locality_revoked` → idem revocación de locality
- `govt_deactivated` → al operador govt con motivo (auto-deactivated o admin-initiated)
- `admin_deactivated` → al operador admin con motivo
- `self_resignation_confirmed` → al vet confirmando

## 12. Integración con `app/actions/upgrade.ts`

`upgrade.ts` actual se refactoriza:

1. **`upgradeToVetAction`**: hoy update `profiles.matriculaNumber`. Refactor: además, crea approval_request type='role_upgrade_vet'. **No flippea role** (lo hace la aprobación).
2. **`createOrganizationAction`**: hoy crea org con `verified=false`. Refactor: además crea approval_request type='organization_verification'.

UX del aplicante no cambia visualmente. Detrás existe ahora la cola.

**Eliminar de upgrade.ts:** cualquier path que intentara llevar a govt o admin. Esas cuentas se crean exclusivamente via §7.4 desde el admin page — nunca por self-service.

## 13. Privacy considerations

- **Toda lectura de PII (evidencia, búsqueda DNI/email/CUIT) genera audit_log entry**
- **PII está scoped al request** — govt no browsea pets del aplicante
- **Govt no ve otros govts' audit_log** — admin lo ve todo
- **Mascotas no son accesibles desde `/admin`** — admin/govt no tienen poder sobre el dominio mascota
- **Admin NO puede tener pets** (DB-enforced por trigger §4.3)
- **Bucket de evidencia es privado** (signed URLs server-side)

## 14. Trade-offs explícitos

- **Account type column vs separate tables**: una columna en `profiles`. Pros: una sola tabla `profiles`, queries simples. Cons: CHECK constraints son la única protección del invariant; trigger en `ownerships` cubre el otro flanco.
- **Approval requests vs direct admin actions**: split por naturaleza. Approval = something submitted by personal user, decided by authority. Direct = something the authority initiates (creación / asignación / revocación / deactivation). Resultado: cada operación tiene su artifact correcto (approval_requests row vs audit_log entry).
- **Govt self-deactivation con coverage check vs sin**: con. La complejidad del check es manejable; la consecuencia de tener una locality sin coverage es operacionalmente molesta.
- **Single-operator por cuenta institucional vs memberships**: single. Para v1 con pocos govts/admins es suficiente. Future extension via memberships (esquema-ready, UI deferred).
- **Trigger institutional_no_pets vs CHECK**: trigger. Un CHECK necesitaría joinear `profiles` desde `ownerships` (no permitido en CHECK constraints). El trigger lee fácil con un SELECT.

## 15. Phasing

**Fase 0 — Schema foundation (1 PR).** Migraciones: extender enum `user_role` con `admin`, agregar columnas `profiles.account_type` y `profiles.deactivated_at`, CHECK constraints, crear `govt_assignments`, `approval_requests`, `audit_log`, extender `attachments`. Trigger `enforce_institutional_no_pets` y triggers append-only para audit_log. RLS para nuevas tablas. Zod schemas para payloads. Seed manual del primer admin.

**Fase 1 — Refactor submission flows (1 PR).** `upgrade.ts` ya no flippea state directamente; crea approval_requests. Cubre `role_upgrade_vet` y `organization_verification`. UX del aplicante intacto.

**Fase 2 — Página admin core: cola + decisión (1-2 PRs).** Route group `/admin` con capability check en layout. `/admin` dashboard. `/admin/cola`. `/admin/cola/[publicToken]`. Server actions approve / reject. Audit logs y notificaciones.

**Fase 3 — Búsqueda + admin-initiated (1 PR).** `/admin/usuarios`, `/admin/organizaciones` con search y "Proponer upgrade / verificación".

**Fase 4 — Revocación workflow (1 PR).** Flow §7.7 para vet, org, scheduling. Direct revocation actions con evidencia.

**Fase 5 — Creación + gestión institutional (1 PR).** `/admin/govts` y `/admin/admins`. `/admin/govts → "Crear cuenta govt"` flow §7.4. Asignación / revocación de localidades. Resetear credentials. (Admin self-deactivate prohibido aquí, así que solo el flow de admin-deactivates-another-admin §7.6 expuesto.)

**Fase 6 — Deactivation flows (1 PR).** Govt self-deactivation (`/cuenta/desactivar`, §7.5) con coverage check. Admin-deactivates-admin (§7.6) en `/admin/admins`. Last-admin safeguard.

**Fase 7 — Self-resign vet (1 PR).** `/cuenta/renunciar` flow §7.8.

**Fase 8 — Aplicante self-service: `/cuenta/solicitudes` (1 PR).** Lista de requests del user, withdraw, historial.

**Fase 9 — Service provider scheduling approval (futura).** Cuando el spec de scheduling se implemente. Hooks ya están.

Plan detallado por archivo y server action queda para un doc aparte por fase, empezando por Fase 0.

## 16. Lo que NO está en este diseño

- **Configurabilidad por govt** — todos los govt comparten el mismo set fijo de capabilities.
- **Business rules configurables por govt** — fuera de scope. v1 solo cubre approvals/revocaciones.
- **Multi-operator por cuenta institucional** — single-operator en v1. Memberships pattern futuro.
- **Admin mobile UI** — admin es desktop-only.
- **Bulk approval/revocation** — schema-ready; UX deferred.
- **SLA / metrics admin**.
- **Public stats** sobre admins/govts/aprobaciones.
- **Appeal process formal** post-rechazo — los aplicantes re-aplican con nueva evidencia.
- **Email transaccional real** — solo in-app notifications hasta que exista provider.
- **Pet-level admin actions** (moderación, override de eventos, custody disputes) — fuera de scope.
- **Multi-country support** — todos los CHECK asumen AR. Generalizamos cuando se internacionalice.
- **Auto-expiry de pending requests** — sin timeout en v1.
- **Two-phase commit en revocaciones** — directas.

---

## Próximo paso

Cuando este diseño tenga OK final, partimos en planes de implementación por fase. Fase 0 (schema foundation) es la más urgente porque desbloquea todo; Fase 1 (refactor submission flows) la sigue.

Si querés ajustar algo (capability matrix, copy de confirmaciones, action catalog del audit_log, payload de cada approval type), **decímelo antes de los planes** — cambiar después cuesta más.
