# Casos (expedientes) — implementation plan

> **Estado (2026-06-04):** ✅ COMPLETO — enviado a través de múltiples PRs. Fase G (backfill) intencionalmente omitida por decisión del plan (DB se wipea).

> Plan ejecutable para Claude Code. Implementa el **sistema de casos** definido en los dos specs sucesivos del 2026-05-19: el attachment spec define cómo cada `event_type` se relaciona con casos, y el lifecycles spec define la máquina de estados de cada uno de los 7 `case_kind` del subset v1. Este plan toma esos dos como input único y produce schema + lib + RLS + actions refactor + UI + cron + tests en 7 fases secuenciales.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Tamaño:** 1 migración SQL grande (`cases` table + `case_id` columns + RLS functions) + ~600 LOC en `lib/` (attachment rules, normatives, helpers, cron) + refactor de ~10 server actions existentes + 4 crones nuevos / refactor + 3-5 rutas UI + ~50 tests
> **Estimación:** 2-3 semanas full-time (puede paralelizarse parcialmente — las fases D y E sí, las anteriores no)
> **Depende de:**
> - `docs/superpowers/specs/2026-05-19-cases-event-attachment-design.md` v1.1+
> - `docs/superpowers/specs/2026-05-19-cases-lifecycles-design.md` v1.0+
> - admin page Fase 0+ ya implementado (cron_runs, audit_log, account_type) ✅
> - bite-rabies observation ya implementado ✅
> - welfare_reports + welfare-reports-polish ya implementado ✅
> - custody disputes (admin page Fase 14) ya implementado ✅
> - foster volunteers pool ya implementado ✅
> - adoption-listing-public ⚠️ NO implementado todavía (spec v1.3 ready for CC) — este plan escribe el envoltorio del kind pero los hooks específicos (server actions de adoption_application_submitted, etc.) se agregan cuando se ejecute el plan de adoption-listing-public. Marcado como TODO en Fase D.

---

## 0. Antes de tocar nada

Lectura obligatoria en este orden:

1. **`docs/superpowers/specs/2026-05-19-cases-event-attachment-design.md`** (v1.1+) — define la tabla `cases`, los 5 modos de attachment, el catálogo evento × case-kind para los 41 events, las cascade-emission rules, la matriz de visibility. Cualquier cosa de este plan que contradiga el spec, gana el spec.
2. **`docs/superpowers/specs/2026-05-19-cases-lifecycles-design.md`** (v1.0+) — define lifecycle de cada uno de los 7 kinds del subset v1: estados, transiciones, crones, normativas, notifications. Idem regla anterior.
3. **`AGENTS.md`** end-to-end — principles (especialmente "event log es la espina"), data model, el catálogo de 41 events.
4. **`db/schema.ts`** — `pet_events`, `welfare_reports`, `custody_disputes`, `pets`, `ownerships`, `cron_runs`, `audit_log`. Familiarizate con el `EVENT_TYPES` array y los `AUDIT_LOG_ACTIONS`.
5. **`db/rls.sql`, `db/welfare_rls.sql`, `db/organizations_rls.sql`, `db/foster_rls.sql`** — patrón de RLS por tabla. Vas a agregar `db/cases_rls.sql`.
6. **`lib/event-schemas.ts`** + **`__tests__/event-schemas.test.ts`** — patrón Zod estricto + test de cobertura. Vas a replicarlo para `lib/case-attachment.ts` y `lib/case-lifecycles/*.ts`.
7. **`lib/symptom-disease-catalog.ts`** y similares — patrón de catálogo estático con types fuertes.
8. **`scripts/materialize-slots.ts` + `app/api/cron/materialize-slots/route.ts`** + **`app/api/cron/close-rabies-observations/route.ts`** + **`app/api/cron/auto-expire-approvals/route.ts`** — patrón de cron (CRON_SECRET + cron_runs upsert + helpers). Vas a crear 4 nuevos + refactorear 1.
9. **`pnpm rls:smoke`** (`scripts/rls-smoke.ts`) — test cross-account real PostgREST. Extender con escenarios de cases en Fase F.
10. **`docs/superpowers/specs/2026-05-18-bite-rabies-observation-design.md`** + **`plans/2026-05-18-bite-rabies-observation.md`** — referencia de un workflow similar end-to-end, sirve de plantilla mental.
11. **`docs/legal-framework-full.md`** — anclajes legales (Ley 14.346, Decreto 4669, etc.) para alimentar `lib/case-normatives.ts`.

**Antes de empezar**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes en main. Si hay rojos pre-existentes, parar y avisar a Nacho.

**Branch sugerido**: `feature/cases-system-fase-a` etc. Una rama por fase, PR por fase. Cada PR debe quedar mergeable independiente (no breaks build).

---

## 1. Qué construye este plan

Siete fases secuenciales:

**Fase A — Schema foundation.** Migración SQL: tabla `cases` con CHECK constraints + indexes parciales + helper functions. Columna `case_id` nullable en `pet_events` y `welfare_reports`. Columna `cases.applicant_user_id`. Columna `notifications.related_case_id`. Sin lógica de aplicación todavía. Después: aplicar `db/cases_rls.sql` con políticas mínimas (read-own + admin all + función `can_read_case` shell vacío).

**Fase B — Lib code (data + helpers).** `lib/case-kinds.ts` (constants), `lib/case-attachment.ts` (`CASE_ATTACHMENT_RULES`, attachment helper), `lib/case-normatives.ts` (lookup), `lib/case-lifecycles/<kind>.ts` (uno por kind), `lib/case-helpers.ts` (open/close/transition utilities), `lib/notification-templates.ts` (catalog de templates de cases). Tests de cobertura para cada uno. Sin tocar server actions todavía.

**Fase C — Cron infra.** Helper `lib/case-cron.ts`. 4 crones nuevos + refactor del existente. Vercel.json updated. Tests de cron en condiciones simuladas.

**Fase D — Refactor de server actions existentes.** Sub-fases por workflow, en orden:

- D1 — Welfare: `app/actions/welfare.ts` ata case_id al insertar welfare_report + bridge events.
- D2 — Bite/rabies: `reportBiteAction`, `closeRabiesObservationAction` (owner y profesional) atan a `bite_incident` case.
- D3 — Lost/found: `markPetLostAction`, `markPetFoundAction`, `proposeReturnAction`, `acceptReturnProposalAction` atan a `lost_pet_episode` case.
- D4 — Custody dispute: `raiseCustodyDisputeAction`, `resolveCustodyDisputeAction` atan a `custody_dispute` case.
- D5 — Foster placement: `assignFosterAction`, `endFosterAction`, `acceptFosterProposalAction` (cascade) atan a `foster_placement` case.
- D6 — Adoption listing/application: hooks listos pero **TODO documented** hasta que se ejecute el plan de adoption-listing-public. Server actions stub si no existen.

**Fase E — UI surfaces.** Ruta `/casos/[publicCode]` con vista unificada (timeline + actores + normativas + pending approvals + attachments). Linkbacks: badge "Casos abiertos: N" en pet profile (`/mis-mascotas/[token]` + `/org/[orgToken]/mascotas/[petToken]`), sección "Casos del refugio" en `/org/[orgToken]/casos`, sección "Casos en jurisdicción" en `/gob/casos`, sección "Casos del sistema" en `/admin/casos`. Sin reinventar visual — reusar `EventTimeline` + componentes de UI existentes.

**Fase F — RLS hardening + smoke tests.** Implementar `can_read_case` para cada kind. Extender `attachments` RLS para heredar visibility de case_id. Extender `pet_events` RLS con OR a case visibility. `db/cases_rls.sql` completo. Extender `pnpm rls:smoke` con ≥3 escenarios cross-case (welfare denuncia no-leak al subject_owner, adoption applicant no-leak a competencia, custody dispute no-leak a anon).

**Fase G — Backfill opcional + cleanup.** Script `scripts/backfill-cases.ts` que crea cases retroactivos para welfare_reports + custody_disputes + bite observations en `in_progress` actualmente abiertos. Opcional según contexto del wipe (ver §6).

## 2. Decisiones cerradas (resumen de los 2 specs — NO relitigar)

| # | Decisión | Sección spec(s) |
|---|---|---|
| Att-D1 | 1:N event→caso (al menos 0, máximo 1). Libreta ortogonal | attachment §3 D1 |
| Att-D2 | Todos los events relacionados al mismo caso real. Mergeo via `superseded_by_case_id`, events no se mueven | attachment §3 D2 |
| Att-D3 | Casos auto-abren via event O manualmente (admin/govt) | attachment §3 D3 |
| Att-D4 | Visibility scope-bound + composable. Implementación RLS declarativa por kind | attachment §3 D4 |
| Att-D5 | Normativas son lookup derivado, no datos en el caso | attachment §3 D5 |
| Att-§4 | Tabla `cases` minimal: id, public_code, kind, status, primary_subject_kind, primary_pet_id?, primary_location_*, jurisdiction_*, opened_*, closed_*, welfare_report_id?, adoption_application_id?, custody_dispute_id?, applicant_user_id? | attachment §4 |
| Att-§5 | 5 modos de attachment: opens, requires-open, attaches-when-open, optional, never | attachment §5 |
| Att-§7 | Catálogo evento × case-kind para los 41 events | attachment §7 |
| Att-§8 | Cascade-emission rules para multi-case closures | attachment §8 |
| L1 | status enum: open/escalated/closed/merged. Phases son derived | lifecycles §3 L1 |
| L2 | closed_reason enum: resolved/cancelled/auto_expired/merged | lifecycles §3 L2 |
| L3 | Cascade-open NO es opcional, atómico con el cierre que lo dispara | lifecycles §3 L3 |
| L4 | Reapertura prohibida salvo `adoption_reversed` | lifecycles §3 L4 |
| L5 | Cron default diario 04:00 UTC; rabies overrides a 12h | lifecycles §3 L5 |
| L6 | Notifications additive a las del event, UI colapsa por related_case_id | lifecycles §3 L6 |
| L7 | public_code = CAS-XXXX-XXXX | lifecycles §3 L7 |
| L8 | Manual open requiere opened_reason no-vacío | lifecycles §3 L8 |
| L9 | Lifecycle por archivo en lib/case-lifecycles/<kind>.ts + coverage test | lifecycles §3 L9 |
| L10 | notifications.related_case_id nuevo campo nullable | lifecycles §3 L10 |

## 3. Scope

**Dentro:**

- 1 migración SQL (Fase A)
- ~600 LOC nuevos en `lib/` (Fase B)
- 4 crones nuevos + 1 refactor (Fase C)
- Refactor de ~10 server actions existentes (Fase D, sub-fases D1-D5; D6 stub)
- Ruta UI `/casos/[publicCode]` + 4 entry points (Fase E)
- RLS completo + smoke tests (Fase F)
- Backfill script opcional (Fase G)
- Tests por fase (unit en lib, integration en actions, smoke en RLS, E2E mínimo para UI)
- `db/cases_rls.sql` archivo nuevo

**Fuera (deferred per specs §16, §13):**

- 6 case_kinds deferidos (custody_episode, custody_transfer_handshake, foster_proposal, outbreak_investigation, microchip_remediation, rabies_observation_followup) — sus lifecycles no están especificados; el schema sí los acepta (case_kind es text, no enum)
- UI mocks detallados de `/casos/[publicCode]` — implementar minimal first pass; iterar visual después
- Export PDF de casos (welfare WD5) — usa skill pdf, va separado
- Sistema i18n-ready de templates — los textos español rioplatense van en Fase B inline
- Integración Mi Argentina — separate scope

---

## 4. Fases

### Fase A — Schema foundation

**Estimación:** ~2 días.

**Archivos nuevos:**

- `db/migrations/0033_cases.sql` (asumiendo numbering consecutivo; ajustar al actual)
- `db/cases_rls.sql` (políticas mínimas iniciales; expande en Fase F)

**Archivos modificados:**

- `db/schema.ts`: agregar `cases` table, `caseId` nullable column en `petEvents`, `caseId` nullable en `welfareReports`, `relatedCaseId` nullable en `notifications`, `applicantUserId` nullable en cases (write-once at open).

**Migración SQL (`0033_cases.sql`) — sketch:**

```sql
-- Cases table — coordinación liviana sobre el event log
create table cases (
  id uuid primary key default gen_random_uuid(),
  public_code text not null unique,
  case_kind text not null,
  status text not null default 'open' check (status in ('open', 'escalated', 'closed', 'merged')),
  closed_reason text check (closed_reason in ('resolved', 'cancelled', 'auto_expired', 'merged')),
  superseded_by_case_id uuid references cases(id),

  -- Sujeto polimórfico
  primary_subject_kind text not null check (primary_subject_kind in ('registered_pet', 'unowned_animal', 'location', 'general')),
  primary_pet_id uuid references pets(id),
  primary_location_lat numeric(10, 7),
  primary_location_lng numeric(10, 7),

  -- Para adoption_application (escrito una sola vez al open)
  applicant_user_id uuid references profiles(id),

  -- Jurisdicción
  jurisdiction_country text not null default 'AR',
  jurisdiction_province text,
  jurisdiction_locality text,

  -- Apertura
  opened_at timestamptz not null default now(),
  opened_by_user_id uuid references profiles(id),
  opened_by_organization_id uuid references organizations(id),
  opened_reason text,

  -- Cierre
  closed_at timestamptz,
  closed_by_user_id uuid references profiles(id),

  -- Linkbacks a tablas auxiliares (opcionales según kind)
  welfare_report_id uuid references welfare_reports(id),
  adoption_application_id uuid,  -- FK agrega cuando exista tabla (post adoption-listing-public)
  custody_dispute_id uuid references custody_disputes(id),

  -- Para adoption_application: linkage al listing padre
  parent_listing_case_id uuid references cases(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hard checks
alter table cases add constraint cases_subject_pet_consistency
  check ((primary_subject_kind = 'registered_pet') = (primary_pet_id is not null));
alter table cases add constraint cases_subject_location_consistency
  check ((primary_subject_kind = 'location') = (primary_location_lat is not null and primary_location_lng is not null));
alter table cases add constraint cases_merged_consistency
  check ((status = 'merged') = (superseded_by_case_id is not null and closed_reason = 'merged'));
alter table cases add constraint cases_closed_consistency
  check ((status in ('closed', 'merged')) = (closed_at is not null));
alter table cases add constraint cases_opened_reason_min_length
  check (opened_reason is null or length(opened_reason) >= 10);

-- Index parcial: case abierto por (pet, kind)
create unique index cases_open_per_pet_kind_idx
  on cases (primary_pet_id, case_kind)
  where status in ('open', 'escalated')
    and case_kind not in ('adoption_application', 'adoption_listing', 'welfare_denuncia', 'foster_placement');

-- adoption_application: unicidad por (pet, kind, applicant)
create unique index cases_open_adoption_app_per_applicant_idx
  on cases (primary_pet_id, case_kind, applicant_user_id)
  where status in ('open', 'escalated') and case_kind = 'adoption_application';

-- adoption_listing: unicidad por (pet, kind, org)
create unique index cases_open_adoption_listing_per_org_idx
  on cases (primary_pet_id, case_kind, opened_by_organization_id)
  where status in ('open', 'escalated') and case_kind = 'adoption_listing';

-- foster_placement: unicidad por (pet, kind, foster) — el foster vive en el ownership row, lo computamos en el server action
-- (no index parcial en cases; el constraint vive en la actividad de server action)

-- Index general por jurisdiction para queues govt
create index cases_open_by_jurisdiction_kind_idx
  on cases (jurisdiction_locality, case_kind)
  where status in ('open', 'escalated');

-- Index para queries del owner ("mis casos")
create index cases_open_by_owner_pet_idx
  on cases (primary_pet_id)
  where status in ('open', 'escalated');

-- Index para lookup por public_code (lookup directo)
-- (ya está unique, no necesita índice adicional)

-- Foreign key on pet_events
alter table pet_events add column case_id uuid references cases(id) on delete restrict;
create index pet_events_case_id_idx on pet_events (case_id) where case_id is not null;

-- Foreign key on welfare_reports
alter table welfare_reports add column case_id uuid references cases(id) on delete restrict;
create index welfare_reports_case_id_idx on welfare_reports (case_id) where case_id is not null;

-- Foreign key on notifications
alter table notifications add column related_case_id uuid references cases(id) on delete set null;
create index notifications_related_case_id_idx on notifications (related_case_id) where related_case_id is not null;

-- Trigger de validación case_id append-only en pet_events (defense in depth)
create or replace function check_pet_event_case_id_immutable()
  returns trigger as $$
begin
  if old.case_id is distinct from new.case_id then
    raise exception 'case_id on pet_events is append-only';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger pet_events_case_id_immutable
  before update on pet_events
  for each row
  execute function check_pet_event_case_id_immutable();
```

**`db/schema.ts` adiciones (Drizzle):**

```ts
// Cases table
export const cases = pgTable('cases', {
  id: uuid('id').defaultRandom().primaryKey(),
  publicCode: text('public_code').notNull().unique(),
  caseKind: text('case_kind').notNull(),
  status: text('status').notNull().default('open'),
  closedReason: text('closed_reason'),
  supersededByCaseId: uuid('superseded_by_case_id'),

  primarySubjectKind: text('primary_subject_kind').notNull(),
  primaryPetId: uuid('primary_pet_id').references(() => pets.id),
  primaryLocationLat: numeric('primary_location_lat', { precision: 10, scale: 7 }),
  primaryLocationLng: numeric('primary_location_lng', { precision: 10, scale: 7 }),
  applicantUserId: uuid('applicant_user_id').references(() => profiles.id),

  jurisdictionCountry: text('jurisdiction_country').notNull().default('AR'),
  jurisdictionProvince: text('jurisdiction_province'),
  jurisdictionLocality: text('jurisdiction_locality'),

  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  openedByUserId: uuid('opened_by_user_id').references(() => profiles.id),
  openedByOrganizationId: uuid('opened_by_organization_id').references(() => organizations.id),
  openedReason: text('opened_reason'),

  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedByUserId: uuid('closed_by_user_id').references(() => profiles.id),

  welfareReportId: uuid('welfare_report_id').references(() => welfareReports.id),
  adoptionApplicationId: uuid('adoption_application_id'),
  custodyDisputeId: uuid('custody_dispute_id').references(() => custodyDisputes.id),
  parentListingCaseId: uuid('parent_listing_case_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;

// pet_events: agregar caseId
// (extender existing pgTable definition, agregar)
//   caseId: uuid('case_id').references(() => cases.id),

// welfare_reports: agregar caseId
//   caseId: uuid('case_id').references(() => cases.id),

// notifications: agregar relatedCaseId
//   relatedCaseId: uuid('related_case_id').references(() => cases.id),
```

**`db/cases_rls.sql` (Fase A — minimal):**

```sql
alter table cases enable row level security;

-- Read: subject_owner del primary_pet (owners of the pet)
create policy cases_select_subject_owner on cases for select
  using (
    primary_pet_id is not null and exists (
      select 1 from ownerships o
      where o.pet_id = cases.primary_pet_id
        and o.ended_at is null
        and o.role = 'owner'
        and o.owner_user_id = auth.uid()
    )
  );

-- Read: admin
create policy cases_select_admin on cases for select
  using (
    exists (
      select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Write: ningún role default puede writes; cada server action que insert/update lo hace via service role
-- (NO policy for insert/update — bypassed by Drizzle server-side calls)
```

**`pet_events` RLS extension** (en `db/rls.sql` o new file):

```sql
-- Existing policy permite read si owner del pet. Agregamos OR para case visibility.
drop policy if exists pet_events_select on pet_events;
create policy pet_events_select on pet_events for select
  using (
    -- Existing: owner del pet
    exists (
      select 1 from ownerships o
      where o.pet_id = pet_events.pet_id
        and o.ended_at is null
        and o.role = 'owner'
        and o.owner_user_id = auth.uid()
    )
    OR
    -- New: case visibility (delegated to function — full impl en Fase F)
    (pet_events.case_id is not null and can_read_case(pet_events.case_id, auth.uid()))
  );

-- Función shell para Fase A — full impl en Fase F
create or replace function can_read_case(p_case_id uuid, p_user_id uuid) returns boolean as $$
begin
  -- Stub: solo admin por ahora; Fase F implementa scope-bound per kind
  return exists (select 1 from profiles where id = p_user_id and role = 'admin');
end;
$$ language plpgsql stable;
```

**Tests Fase A:**

- `__tests__/cases-schema.test.ts`: insert manual via Drizzle, verifica constraints (CHECK constraints rechazan inconsistencias), unique partial indexes funcionan.
- `__tests__/cases-rls-baseline.test.ts`: subject_owner reads su caso, admin reads any case, otro usuario no read.

**Aplicación:**

1. `pnpm db:push` para Drizzle (genera + aplica migration).
2. `psql ... -f db/cases_rls.sql` via Supabase Studio (sigue patrón existente).
3. `pnpm typecheck && pnpm test`.

**PR:** `feature/cases-system-fase-a` → merge a main. Cero impacto runtime, schema solo.

---

### Fase B — Lib code

**Estimación:** ~3-4 días.

**Archivos nuevos:**

- `lib/case-kinds.ts` — `CASE_KINDS` const + types
- `lib/case-attachment.ts` — `CASE_ATTACHMENT_RULES`, `decideAttachment(event, openCases) → AttachmentDecision`, `computeCascade(event, openCases) → CascadeEvent[]`
- `lib/case-normatives.ts` — `CASE_NORMATIVES` array + `getNormativesForCase(kind, jurisdiction) → LawReference[]`
- `lib/case-lifecycles/index.ts` — re-export de los 7 modules
- `lib/case-lifecycles/bite-incident.ts` — config completa del kind: states, transitions, terminal events, cron names
- `lib/case-lifecycles/lost-pet-episode.ts`
- `lib/case-lifecycles/welfare-denuncia.ts`
- `lib/case-lifecycles/adoption-listing.ts`
- `lib/case-lifecycles/adoption-application.ts`
- `lib/case-lifecycles/custody-dispute.ts`
- `lib/case-lifecycles/foster-placement.ts`
- `lib/case-helpers.ts` — `openCase`, `closeCase`, `transitionCase`, `generateCasePublicCode`, `findOpenCaseForPet`, `findOpenCaseForListing`
- `lib/case-public-code.ts` — generador CAS-XXXX-XXXX (clone de `lib/publicToken.ts`)
- `lib/notification-templates.ts` — catálogo de templates con título/body por template_id (referenciados en lifecycles spec §§5.9-11.9)
- `lib/case-notifications.ts` — `emitCaseNotification(templateId, recipients, vars)` helper
- `__tests__/case-attachment.test.ts` — cobertura de los 41 event_types
- `__tests__/case-normatives.test.ts` — cobertura de los 7 kinds + ejemplos CABA
- `__tests__/case-lifecycles.test.ts` — sanity de cada module (cada kind tiene archivo)
- `__tests__/case-public-code.test.ts` — colision rate + format

**Archivos modificados:** ninguno. Esta fase es puramente additive en lib/.

**`lib/case-kinds.ts`:**

```ts
export const CASE_KINDS = [
  'bite_incident',
  'lost_pet_episode',
  'welfare_denuncia',
  'adoption_listing',
  'adoption_application',
  'custody_dispute',
  'foster_placement',
  // Deferred (schema acepta, lifecycle TBD):
  'custody_episode',
  'custody_transfer_handshake',
  'foster_proposal',
  'outbreak_investigation',
  'microchip_remediation',
] as const;

export type CaseKind = (typeof CASE_KINDS)[number];

export const V1_CASE_KINDS: readonly CaseKind[] = [
  'bite_incident', 'lost_pet_episode', 'welfare_denuncia',
  'adoption_listing', 'adoption_application',
  'custody_dispute', 'foster_placement',
];
```

**`lib/case-attachment.ts` — estructura clave:**

```ts
import type { EventType } from '@/db/schema';
import type { CaseKind } from './case-kinds';

export type AttachmentMode = 'opens' | 'requires-open' | 'attaches-when-open' | 'optional' | 'never';

export interface CaseAttachmentRule {
  mode: AttachmentMode;
  compatibleWith: readonly CaseKind[];
  opensKind?: CaseKind; // solo si mode = 'opens' o branch-opens
  branch?: (payload: any) => Partial<CaseAttachmentRule>;
}

export const CASE_ATTACHMENT_RULES: Record<EventType, CaseAttachmentRule> = {
  pet_registered: { mode: 'never', compatibleWith: [] },
  pet_profile_updated: { mode: 'never', compatibleWith: [] },
  status_changed: {
    mode: 'opens', // branch override below
    compatibleWith: ['lost_pet_episode'],
    opensKind: 'lost_pet_episode',
    branch: (payload) => {
      if (payload.to_status === 'lost') return { mode: 'opens', opensKind: 'lost_pet_episode' };
      if (payload.from_status === 'lost' && payload.to_status === 'active') return { mode: 'requires-open', compatibleWith: ['lost_pet_episode'] };
      return { mode: 'never', compatibleWith: [] };
    },
  },
  // ... mapping completo de los 41 event_types — fuente: attachment spec §7
};

// Helper: dado un event input + lista de cases abiertos del pet, decide attachment
export function decideAttachment(
  eventType: EventType,
  payload: any,
  openCasesForPet: Array<{ id: string; case_kind: CaseKind }>,
): { attachToCaseId?: string; opensNewCase?: { kind: CaseKind } } {
  const rule = CASE_ATTACHMENT_RULES[eventType];
  const effective = rule.branch ? { ...rule, ...rule.branch(payload) } : rule;
  // ... lógica
}
```

**`lib/case-lifecycles/bite-incident.ts` — sketch:**

```ts
import type { CaseLifecycle } from './types';

export const biteIncidentLifecycle: CaseLifecycle = {
  kind: 'bite_incident',
  uniqueScope: ['primary_pet_id', 'case_kind'],
  statusValues: ['open', 'escalated', 'closed'],
  phases: [
    'observation_open',
    'observation_escalated',
    'observation_closed_negative',
    'observation_closed_positive',
    'observation_closed_dead',
    'observation_closed_lost_to_followup',
  ],
  computePhase: (caseRow, events) => { /* ... */ },
  opensEvents: [{ eventType: 'incident_reported', whenPayload: (p) => p.incident_type === 'bite_inflicted' }],
  terminalEvents: ['rabies_observation_ended'],
  cronCloseRoute: '/api/cron/close-rabies-observations',
  cronCloseScheduleHours: 12,
  manualOpenAllowed: false,
  reopenAllowed: false,
};
```

(Similar para los otros 6 kinds, siguiendo lifecycles spec §§5-11.)

**`lib/case-normatives.ts` — completar con los lookup entries de:**
- §5.7 bite_incident (3 entries: AR, BA, CABA)
- §6.7 lost_pet_episode (array vacío con nota)
- §7.7 welfare_denuncia (2 entries: AR, CABA)
- §8.7 adoption_listing (1 entry contractual)
- §9.7 adoption_application (reuse adoption_listing)
- §10.7 custody_dispute (1 entry código civil + caso-por-caso)
- §11.7 foster_placement (1 entry sin norma específica)

**`lib/case-helpers.ts` — funciones clave:**

```ts
export async function openCase(tx: DBTx, input: OpenCaseInput): Promise<Case> {
  const publicCode = await generateUniqueCasePublicCode(tx);
  const [created] = await tx.insert(cases).values({
    publicCode,
    caseKind: input.kind,
    primarySubjectKind: input.primarySubjectKind,
    primaryPetId: input.primaryPetId,
    /* ... */
    openedReason: input.openedReason ?? `auto: ${input.eventType}`,
  }).returning();
  return created;
}

export async function closeCase(tx: DBTx, caseId: string, input: CloseCaseInput): Promise<Case> {
  // UPDATE status, closed_reason, closed_at, closed_by_user_id
}

export async function findOpenCaseForPet(tx: DBTx, petId: string, kind: CaseKind, extraScope?: object): Promise<Case | null> {
  // SELECT con index parcial
}
```

**`lib/notification-templates.ts` — catálogo:**

```ts
export const CASE_NOTIFICATION_TEMPLATES = {
  bite_incident_opened_owner: {
    title: 'Observación antirrábica iniciada para [PET_NAME]',
    body: '[PET_NAME] mordió a alguien el [BITE_DATE]. Por ley, debe quedar bajo observación durante 10 días. Si presenta síntomas inusuales, contactá inmediatamente al veterinario.',
    severity: 'warning',
    ctaLabel: 'Ver caso',
    ctaUrlPattern: '/casos/[PUBLIC_CODE]',
  },
  // ... ~30+ templates desde lifecycles spec §§5.9-11.9
} as const;

export type CaseNotificationTemplateId = keyof typeof CASE_NOTIFICATION_TEMPLATES;
```

**Tests Fase B:**

- `__tests__/case-attachment.test.ts`: para cada `EVENT_TYPE`, verifica que tiene rule en `CASE_ATTACHMENT_RULES`. Para cada rule no-`never`, verifica `compatibleWith.length > 0`. Para modes `opens`, verifica `opensKind` definido.
- `__tests__/case-normatives.test.ts`: cobertura de los 7 V1_CASE_KINDS, lookups CABA específicos.
- `__tests__/case-lifecycles.test.ts`: cada V1_CASE_KIND tiene un archivo importable.
- `__tests__/case-public-code.test.ts`: 10000 codes generados, 0 colisiones intra-batch; formato regex.
- `__tests__/notification-templates.test.ts`: cobertura de templates referenciados en lifecycles.

**PR:** `feature/cases-system-fase-b` → merge.

---

### Fase C — Cron infra

**Estimación:** ~1-2 días.

**Archivos nuevos:**

- `lib/case-cron.ts` — helper `runCaseCron`
- `scripts/close-stale-lost-episodes.ts`
- `scripts/escalate-stale-welfare-cases.ts`
- `scripts/close-followup-expired-adoptions.ts`
- `scripts/escalate-stale-disputes.ts`
- `app/api/cron/close-stale-lost-episodes/route.ts`
- `app/api/cron/escalate-stale-welfare-cases/route.ts`
- `app/api/cron/close-followup-expired-adoptions/route.ts`
- `app/api/cron/escalate-stale-disputes/route.ts`

**Archivos modificados:**

- `scripts/close-rabies-observations.ts` — extender para emitir `case_id` en el `rabies_observation_ended` event que crea.
- `app/api/cron/close-rabies-observations/route.ts` — schedule 12h en lugar de daily.
- `vercel.json` — registrar 4 crones nuevos + ajustar schedule rabies.

**Patrón del helper:**

```ts
// lib/case-cron.ts
import { db } from '@/db';
import { cases, petEvents } from '@/db/schema';
import { upsertCronRun } from './cron-runs';

export async function runCaseCron(opts: {
  name: string;
  kind: CaseKind;
  scanQuery: (tx: DBTx) => Promise<Case[]>;
  processCase: (tx: DBTx, caseRow: Case) => Promise<void>;
}) {
  const start = await upsertCronRun(opts.name, { status: 'running' });
  let processed = 0;
  let failed = 0;
  try {
    const candidates = await opts.scanQuery(db);
    for (const c of candidates) {
      try {
        await db.transaction((tx) => opts.processCase(tx, c));
        processed++;
      } catch (e) {
        failed++;
        console.error(`[cron:${opts.name}] case ${c.id} failed:`, e);
      }
    }
    await upsertCronRun(opts.name, { status: 'ok', processed, failed });
  } catch (e) {
    await upsertCronRun(opts.name, { status: 'failed', error: String(e) });
    throw e;
  }
}
```

**Vercel cron config** (`vercel.json`):

```json
{
  "crons": [
    { "path": "/api/cron/close-rabies-observations", "schedule": "0 */12 * * *" },
    { "path": "/api/cron/close-stale-lost-episodes", "schedule": "0 4 * * *" },
    { "path": "/api/cron/escalate-stale-welfare-cases", "schedule": "0 4 * * *" },
    { "path": "/api/cron/close-followup-expired-adoptions", "schedule": "0 4 * * *" },
    { "path": "/api/cron/escalate-stale-disputes", "schedule": "0 4 * * *" }
  ]
}
```

**Tests:** integration tests con datos simulados (insert case + eligibility para cierre, correr cron, verificar status flippeado). Patrón existente en `__tests__/cron-rabies.test.ts`.

**PR:** `feature/cases-system-fase-c` → merge.

---

### Fase D — Refactor de server actions existentes

**Estimación:** ~5-7 días total, sub-fases de 1-2 días cada una. Sub-PRs por sub-fase para mantener atomicidad.

**Patrón común para refactor:** cada server action que emite event(s) ahora:

1. Antes del INSERT del event, calcula attachment via `decideAttachment(eventType, payload, openCasesForPet)`.
2. Si abre caso, llama `openCase()` dentro de la misma TX.
3. Si attaches a caso existente, agrega `case_id` al event insert.
4. Si cascade necesario (death_recorded, etc.), llama `computeCascade()` y emite cascade events con sus case_ids.
5. Notifications: usa `emitCaseNotification(templateId, recipients, vars)` para las relacionadas al caso; las del event individual siguen como están.

#### D1 — Welfare (`app/actions/welfare.ts`)

**Cambios:**

- `submitWelfareReportAction`: insert welfare_report → openCase kind=welfare_denuncia → UPDATE welfare_report.case_id → bridge events con case_id.
- `triageWelfareReportAction` / `startWelfareReportAction` / `closeWelfareReportAction` / etc.: cada action que cambia welfare_report.status emite el audit log event (`welfare_report_triaged`, etc.) — agregar case_id si el welfare_report tiene case asociado. NOTE: estos NO son `pet_events`, son audit_log entries; las transitions del case se hacen via UPDATE directo de `cases.status` cuando aplique (closed_resolved / closed_invalid / closed_duplicate / closed_spam).

**Tests:** integration test del submit completo verifica que case se creó con el welfare_report linkado, y que bridge events tienen case_id.

**PR:** `feature/cases-system-d1-welfare`.

#### D2 — Bite/rabies (`app/actions/bites.ts` o similar)

**Cambios:**

- `reportBiteAction`: ahora abre `bite_incident` case atómicamente con `incident_reported` + `rabies_observation_started`. Ambos events llevan el case_id.
- `closeRabiesObservationAction` (owner) y `professionalCloseRabiesObservationAction`: ahora también UPDATE `cases.status='closed'` + closed_reason apropiado.
- `recordDeathAction` (donde sea que esté) — detectar `bite_incident` abierto + cascade `rabies_observation_ended(outcome=dead)`.

**Tests:** integration tests del flow completo (bite → observation → cierre cron y manual con outcomes varios).

**PR:** `feature/cases-system-d2-bite`.

#### D3 — Lost/found (`app/actions/lost.ts`, `app/actions/return.ts`)

**Cambios:**

- `markPetLostAction`: openCase `lost_pet_episode`.
- `markPetFoundAction` (status_changed to_active): closeCase con resolved.
- `proposeReturnAction` (custody_transfer_proposed con from_role=shelter_custody y matched_against_pet_id apuntando a una pet lost): attach al `lost_pet_episode` abierto.
- `acceptReturnProposalAction`: emite `custody_transferred` cierre del handshake + cascade `status_changed(to=active)` cierra el episode.

**Tests:** flow completo lost → match → accept → return.

**PR:** `feature/cases-system-d3-lost`.

#### D4 — Custody dispute (`app/actions/custody-disputes.ts`)

**Cambios:**

- `raiseCustodyDisputeAction`: openCase con custody_dispute_id linkado.
- `resolveCustodyDisputeAction`: closeCase + cascade `custody_transferred` si outcome=ownership_transferred.

**Tests:** raise + resolve para cada outcome.

**PR:** `feature/cases-system-d4-dispute`.

#### D5 — Foster placement (`app/actions/foster.ts`)

**Cambios:**

- `acceptFosterProposalAction`: emite `foster_proposal_resolved(accepted)` y cascade-emit `foster_assigned` que abre `foster_placement` case (todo atómico).
- `assignFosterDirectAction` (si existe la vía direct): abre case en mismo flow.
- `endFosterAction`: closeCase. Manejar cascade desde death y desde adoption_finalized.
- `setCoFosterAllowedAction`: emite `foster_co_foster_allowed` con case_id.

**Tests:** vía pool + vía direct + end normal + end por adoption + end por death.

**PR:** `feature/cases-system-d5-foster`.

#### D6 — Adoption (TODO)

**Estado:** stub. La spec `adoption-listing-public` v1.3 está ready pero no implementada. Cuando se ejecute su plan, los hooks de:

- `setAdoptionEligibilityAction(eligible=true)` → openCase adoption_listing
- `setAdoptionEligibilityAction(eligible=false)` → closeCase + cascade reject apps
- `submitAdoptionApplicationAction` → openCase adoption_application linkeado a listing
- `resolveAdoptionApplicationAction(approved)` → transition app
- `finalizeAdoptionAction` → closeCase logic + cascade winner/loser apps + cascade foster_ended + cascade custody_transferred
- `reverseAdoptionAction` → reopen + reclose

…deben referirse a `lib/case-helpers.ts` igual que las otras sub-fases. Documentar en el plan de adoption-listing-public como Fase + dependencia de este plan.

**Para v1 sin adoption implementado:** no hay action que refactorear; solo los lifecycles + schema están listos para cuando llegue.

---

### Fase E — UI surfaces

**Estimación:** ~3-4 días.

**Archivos nuevos:**

- `app/casos/[publicCode]/page.tsx` — vista unificada del caso
- `app/casos/[publicCode]/CaseTimeline.tsx` — extiende `EventTimeline` con grouping por kind + iconos
- `app/casos/[publicCode]/CaseActorsList.tsx`
- `app/casos/[publicCode]/CaseNormatives.tsx`
- `app/casos/[publicCode]/CasePendingApprovals.tsx`
- `components/CaseBadge.tsx` — chip "Caso CAS-..." con kind icon
- `components/PetOpenCasesSection.tsx` — para embedir en pet profile

**Archivos modificados:**

- `app/(app)/mis-mascotas/[publicToken]/page.tsx` — agregar `<PetOpenCasesSection>` arriba del libreta cuando existan cases abiertos.
- `app/org/[orgToken]/mascotas/[petToken]/page.tsx` — idem con scope org.
- `app/org/[orgToken]/casos/page.tsx` (nuevo) — lista de cases donde la org es opened_by o case_participant.
- `app/gob/casos/page.tsx` (nuevo) — lista de cases en jurisdiction del govt logged in.
- `app/admin/casos/page.tsx` (nuevo) — lista universal.

**Diseño minimal v1 de `/casos/[publicCode]`:**

```
[icon kind] CAS-XK3P-9D2L · [kind label] · estado [open|closed|escalated]
[breadcrumb compacto: Inicio › Casos › CAS-XK3P-9D2L]

┌──────────────────────────────────────────────────────────────┐
│  [pet avatar grande]   [pet.name]                            │
│                        [species · sex · age]                 │
│                        → Ver mascota (botón primario)        │
└──────────────────────────────────────────────────────────────┘

─────────────────────────
[CaseActorsList] · [CaseNormatives] · [CasePendingApprovals]
─────────────────────────
Timeline (eventos del caso, descending)
  · event icon · titulo curado · fecha · actor · payload summary
  · ...
─────────────────────────
[Attachments del caso]
[Acciones disponibles según scope: cerrar, reasignar, agregar nota, etc.]
```

Reusar `EventTimeline` ya existente con filtro `case_id`. Sin reinventar layout.

**1-click to pet — requerimiento explícito:**

El "Ver mascota" desde el case detail tiene que ser acción primaria visible, no escondida en breadcrumb:

- **Case detail (`/casos/[publicCode]`)**: card prominente con avatar + name + species/sex/age + botón primario "Ver mascota →". Click navega a `/mis-mascotas/[publicToken]` si el usuario es subject_owner, o a `/org/[orgToken]/mascotas/[petToken]` si es org_custody_holder, o a `/admin/mascotas/[publicToken]` (futuro) si es admin/govt. La resolución del destino correcto se computa server-side basado en el role del visitante.
- **Listas de casos (`/org/[orgToken]/casos`, `/gob/casos`, `/admin/casos`)**: cada row tiene una columna "Mascota" con avatar + name, y es un link independiente del row link al caso. Mobile: tap-target separado de mínimo 44×44px.
- **Mobile pet profile** (cuando se introduzca en Fase E de pet profile v2): el card de "Casos abiertos" desde la pet también permite ir back al caso con un click — relación bidirectional.
- **Edge case**: si la `primary_pet_id` es null (e.g., welfare_denuncia con subject_kind=`unowned_animal` o `location`), el card se reemplaza por un descriptor read-only ("Sujeto: animal sin identificar en [ubicación]") sin botón "Ver mascota".

**Tests E2E mínimos** (Playwright o vitest+jsdom como el resto):

- Owner navega a su pet con un lost_pet_episode abierto → ve `<PetOpenCasesSection>` con link al caso → click → ve la timeline y puede cerrar el caso desde ahí.
- Govt logged in en jurisdicción CABA visita `/gob/casos` → ve la lista de welfare_denuncias abiertas en CABA, no de Mendoza.

**PR:** `feature/cases-system-fase-e` → merge.

---

### Fase F — RLS hardening + smoke tests

**Estimación:** ~2-3 días.

**Archivos modificados/expandidos:**

- `db/cases_rls.sql` — políticas completas por kind, usando `can_read_case` function expandida.
- `db/rls.sql` — extender `pet_events` SELECT policy con OR case visibility (ya en Fase A shell, ahora real).
- `db/storage.sql` — extender attachments policy.

**`db/cases_rls.sql` (completo):**

```sql
-- Función can_read_case (expandida)
create or replace function can_read_case(p_case_id uuid, p_user_id uuid) returns boolean as $$
declare
  c record;
begin
  select * into c from cases where id = p_case_id;
  if not found then return false; end if;

  -- Admin: siempre
  if exists (select 1 from profiles where id = p_user_id and role = 'admin') then
    return true;
  end if;

  -- Govt scope-matching: si pet/case en jurisdicción del govt
  if exists (
    select 1 from profiles p
    inner join govt_assignments ga on ga.user_id = p.id
    where p.id = p_user_id
      and ga.jurisdiction_province = c.jurisdiction_province
      and (ga.jurisdiction_locality is null or ga.jurisdiction_locality = c.jurisdiction_locality)
  ) then return true; end if;

  -- Subject owner del pet
  if c.primary_pet_id is not null and exists (
    select 1 from ownerships o
    where o.pet_id = c.primary_pet_id
      and o.ended_at is null
      and o.role = 'owner'
      and o.owner_user_id = p_user_id
  ) then
    -- Tweaks por kind: welfare_denuncia oculta al subject_owner (denuncia contra él)
    if c.case_kind = 'welfare_denuncia' then return false; end if;
    return true;
  end if;

  -- Per-kind specifics
  case c.case_kind
    when 'adoption_application' then
      return c.applicant_user_id = p_user_id;
    when 'adoption_listing' then
      -- Members de la org opened_by
      return exists (
        select 1 from organization_memberships m
        where m.organization_id = c.opened_by_organization_id
          and m.user_id = p_user_id
          and m.left_at is null
      );
    when 'foster_placement' then
      -- Foster user (computa del ownership row activo del placement)
      return exists (
        select 1 from ownerships o
        where o.pet_id = c.primary_pet_id
          and o.role = 'foster'
          and o.ended_at is null
          and o.owner_user_id = p_user_id
      );
    when 'custody_dispute' then
      -- Parties opuestas del dispute
      return exists (
        select 1 from custody_dispute_parties cdp
        inner join custody_disputes cd on cd.id = cdp.dispute_id
        where cd.id = c.custody_dispute_id
          and (cdp.party_user_id = p_user_id or cdp.party_organization_id in (
            select organization_id from organization_memberships where user_id = p_user_id and left_at is null
          ))
      );
    else return false;
  end case;
end;
$$ language plpgsql stable security definer;

-- Policy cases SELECT
drop policy if exists cases_select_subject_owner on cases;
drop policy if exists cases_select_admin on cases;
create policy cases_select_visible on cases for select
  using (can_read_case(id, auth.uid()));
```

**`pet_events` policy extension:** ya queda como en Fase A (OR con `can_read_case`).

**`attachments` policy extension:**

```sql
drop policy if exists attachments_select on attachments;
create policy attachments_select on attachments for select
  using (
    -- existing: visible si visible el event/pet
    exists (
      select 1 from pet_events e
      where e.id = attachments.event_id
        and (
          exists (
            select 1 from ownerships o
            where o.pet_id = e.pet_id and o.role = 'owner' and o.ended_at is null and o.owner_user_id = auth.uid()
          )
          OR
          (e.case_id is not null and can_read_case(e.case_id, auth.uid()))
        )
    )
  );
```

**Tests Fase F (`scripts/rls-smoke.ts` extendido):**

Agregar ≥3 escenarios cross-case:

1. **welfare_denuncia no-leak al owner**: User A es owner de pet P. User B somete welfare_report contra P. Verificar que A no puede ver el caso ni los bridge events.
2. **adoption_application no-leak a competencia**: User A y User B se postulan a misma listing. Verificar que A no puede ver el caso de B.
3. **custody_dispute no-leak a anon**: Pet en dispute. Anon visit a `/p/[publicToken]` no menciona dispute. Owner ve case redactado.
4. **foster_placement scope-bound**: Org X tiene placement con foster F. User Y (no foster, no org member) no ve nada del placement.
5. **bite_incident subject_owner sees**: Owner del mordedor ve el caso completo (sin victim_contact si no lo aportó él).

**PR:** `feature/cases-system-fase-f` → merge.

---

### Fase G — Backfill opcional + cleanup

**Estimación:** ~1 día opcional, skip si DB se wipea.

**Decisión upfront:** chequear con Nacho si la DB de producción se va a wipear (catalog cleanup nota). Si sí → skip. Si no → ejecutar backfill.

**Archivos nuevos (si ejecuta):**

- `scripts/backfill-cases.ts` — crea cases retroactivos:
  - Para cada `welfare_reports` con `status IN ('open', 'triaged', 'in_progress')`: openCase `welfare_denuncia` + UPDATE `welfare_reports.case_id` + UPDATE bridge events (`maltreatment_reported`, etc.) `case_id`.
  - Para cada `custody_disputes` con `status='open'`: openCase `custody_dispute` + UPDATE `custody_disputes` (linkback indirect via `cases.custody_dispute_id`) + UPDATE `custody_dispute_raised`/`resolved` events `case_id`.
  - Para cada `pets.rabies_observation_status='in_progress'`: openCase `bite_incident` + UPDATE el `incident_reported(bite_inflicted)` + `rabies_observation_started` events `case_id`.

**No backfill** para: lost episodes pasados (efímeros), adoption applications pre-listing-public (no existen), foster placements (raros y se autoreemplazan al próximo end + assign).

**Cleanup tasks:**

- Actualizar `AGENTS.md` con sección nueva "Casos (expedientes)" referenciando los 2 specs + plan.
- Actualizar `docs/superpowers/README.md` con entradas de los 3 docs nuevos.
- Update Feature inventory en AGENTS.md.

**PR final:** `feature/cases-system-fase-g` → merge.

---

## 5. Verificación final (post Fase G)

Antes de marcar el plan como ✅ Implementado:

- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes
- [x] `pnpm rls:smoke` pasa los 5 escenarios cross-case nuevos
- [x] Manual: abrir un bite_incident vía UI → ver case en `/casos/[code]` → cerrar manualmente con outcome=negative → verificar pet.rabies_observation_status flippeó → verificar libreta sigue mostrando ambos events
- [x] Manual: someter welfare_report anon → tracking con DEN- funciona → govt en CABA ve el case en `/gob/casos` con visibility correcta
- [x] Manual: marcar pet perdida → broadcast → otra cuenta scanea credencial → owner recibe notif "alguien escaneó tu mascota" linked al case → owner marca encontrada → case se cierra
- [x] Cron `close-rabies-observations` corre con datos test → cierra casos elegibles → no toca los no-elegibles
- [x] Cron `close-stale-lost-episodes` corre con datos test → cierra casos >180d sin events
- [x] AGENTS.md actualizado + README.md actualizado
- [x] Specs marcados como ✅ Implementado en README.md

---

## 6. Dependencias / preguntas operativas

- **¿DB se wipea?** Decisión Fase G. Default: ejecutar backfill mínimo (3 categorías).
- **Vercel cron count limit**: el plan agrega 4 nuevos. Verificar cuota actual del proyecto (Hobby = 2, Pro = 40). Si Hobby, hay que upgrade a Pro o consolidar crones.
- **Adoption-listing-public coordination**: cuando se ejecute ese plan (priority 5 del README), agregar los hooks D6 de este plan. Idealmente en el mismo PR.
- **Stale `adoption_application_id` FK**: el campo `cases.adoption_application_id` no tiene FK por ahora (tabla no existe). Cuando llegue adoption-listing-public, agregar `references(() => adoptionApplications.id)` en una migration menor.
- **Notification templates en español rioplatense**: el plan los pone inline en `lib/notification-templates.ts`. Si futuro multi-i18n, mover a estructura per-locale. Out of scope.
- **Performance del `can_read_case` function**: declarada `stable`, debería cachearse dentro del query plan. Si en runtime aparecen N+1 patterns, evaluar materialización (case_visibility table) — pero NO en este plan.

---

## 7. Rollback strategy

Cada PR (uno por fase / sub-fase) es independent. Rollback simple:

- Fase A: revertir migration + drop tables. Sin datos perdidos (nada usa cases todavía).
- Fase B: revertir lib code. Sin impacto runtime.
- Fase C: deshabilitar crones en vercel.json. Sin impacto.
- Fase D (sub-fases): cada server action refactor es backward-compatible al revertir (el caso opcional, no hay nada que rompa si case_id queda null).
- Fase E: deshabilitar rutas / esconder componentes.
- Fase F: revertir RLS al snapshot anterior.
- Fase G: re-correr backfill con DELETE-then-INSERT.

Riesgo principal: Fase F si las nuevas RLS rompen algún flow existente. Mitigación: smoke test obligatorio antes del merge.

---

**Listo para Claude Code.** Empezar por Fase A. Pause natural entre fases para review humano.
