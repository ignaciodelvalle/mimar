# Admin page — next phases (Fases 10-14) design spec

> Continuación del `2026-05-17-admin-page-design.md` (v2.3, fases 0-9 ya implementadas). Cubre las próximas cinco fases concretas + placeholders para fases más adelantadas. Auto-contenido: este doc es el punto de entrada cuando se quiera planear/implementar moderación pet-level, dashboards regionales gobierno, métricas admin operacionales, bulk ops, o auto-expiry de solicitudes viejas.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready — el plan ejecutable correspondiente es `plans/2026-05-18-admin-page-fases-10-14.md`
> **Versión:** 3.0 — supersede del bullet "Fase 9 futura" del spec original. Las fases 10-14 son aditivas; ninguna toca schema ya estable.

### Relación con specs/plans existentes

| Doc previo | Qué cubre | Cómo este spec lo continúa |
|---|---|---|
| `specs/2026-05-17-admin-page-design.md` v2.3 | Fases 0-9 (schema foundation, approval flows, revocación, gestión institutional, deactivation, self-resign, vista aplicante, scheduling approval) | Hereda decisiones D1-D12, capability matrix, audit_log action catalog. Este doc añade nuevos `action` values y nuevas tablas/columnas con phasing limpio. |
| `plans/2026-05-18-event-catalog-cleanup.md` | Agrega event_types `custody_dispute_raised/resolved`, `adoption_withdrawn`, `microchip_replaced/revoked`. Columna `pets.in_custody_dispute` | **Pre-requisito de Fase 10**. El surface admin de Fase 10 consume `custody_dispute_raised` y emite `custody_dispute_resolved` |
| `plans/2026-05-17-symptom-disease-surveillance.md` | Eventos `outbreak_signal` + routing via `routeOutbreakSignalNotification` (govt-first, admin fallback) | **Pre-requisito de Fase 11**. El dashboard regional gobierno proyecta sobre `pet_events` type `outbreak_signal` con scope-match igual al de la cola |
| `plans/2026-05-16-health-campaigns-and-scheduling.md` | Tabla `service_offerings` con approval status nativo (Fase 9 del spec original quedó cubierta por scheduling) | Sin dependencia directa con Fases 10-14, pero la métrica "scheduling approval rate" sale del mismo conjunto en Fase 12 |
| `plans/2026-05-17-lost-and-found-complete.md` | Tabla de status + broadcasting con coverage | Fuente del dashboard regional "densidad de pets perdidos" en Fase 11 |

---

## 1. Resumen ejecutivo

Las fases 0-9 dejaron al admin/gob portal **operativo para gobernanza**: aprobaciones, revocaciones, gestión de cuentas institucionales. Pero el portal no toca el dominio mascota (intencional en v2.3) y no entrega valor operativo más allá de la cola.

Las próximas cinco fases cierran ese hueco con la mínima superficie nueva:

| Fase | Qué destraba | Surfaces nuevas |
|---|---|---|
| **10. Resolución de disputas de custodia** | Pet-level admin moderation entry point. Consume `custody_dispute_raised` del cleanup plan. Habilita que peritos del estado o adminmedien situaciones donde dos personas reclaman titularidad o un refugio impugna una adopción | `/gob/disputas`, `/gob/disputas/[disputeToken]` |
| **11. Dashboards regionales gobierno** | Visibilidad de la señal sanitaria que ya fluye al govt (outbreak signals) + densidad lost-pet. Es el "para qué entró un govt al portal" más allá de la cola | `/gob/vigilancia`, `/gob/perdidas` |
| **12. Métricas operativas admin** | Salud del sistema: DAU, signups, queue age, revocaciones/período, govt activity | `/admin/sistema` |
| **13. Bulk approval/revocation** | UX table-shaped para batch ops cuando llegue volumen (ej. campaña de verificación masiva de refugios) | Multi-select en `/admin/cola`, `/admin/usuarios`, `/admin/organizaciones`, `/gob/*` equivalentes |
| **14. Auto-expiry sweep** | Cron diario que cierra solicitudes pendientes con > 60 días sin decisión, marcándolas `withdrawn` con razón sistema | Sin surface user-facing; runs via `vercel/cron` |

Cinco PRs independientes, ninguno bloquea al otro excepto Fase 10 que depende del cleanup plan ejecutado primero.

---

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | **Disputas de custodia se resuelven por govt o admin, NUNCA por org** | El conflicto típico es vecino que reclama un perro que está en el refugio. El refugio es parte interesada — no juez. El estado o el admin son el árbitro neutral. |
| D2 | **Disputas viven en su propia tabla `custody_disputes`**, no como approval_request | No es una solicitud que se acepta/rechaza; es un proceso con dos+ partes, evidencia de ambos lados, posible decisión salomónica (third party). Modelo distinto. |
| D3 | **`custody_dispute_raised` event puede ser emitido por cualquier rol con interés legítimo** — owner registrado, org con custody, govt actuando de oficio (denuncia recibida). El campo `author_role` en pet_events ya cubre. | El conflicto puede originarse de cualquier lado |
| D4 | **Mientras `pets.in_custody_dispute=true`** se bloquean: transfer, adopción, abandonment_reported sobre ese pet. Welfare events permitidos (no pueden detener el cuidado) | Coherente con la política del cleanup plan. Cada feature lo enforce en su server action |
| D5 | **Dashboards regionales en Fase 11 son read-only sobre eventos existentes** — sin nuevas tablas, sin proyecciones materializadas todavía | Lee `pet_events` y `pet_status_history` directo. Si la latencia sube, migrate a materialized views en una iteración futura (registrado como Fase 17) |
| D6 | **Fase 11 incluye outbreak signals + lost-pet density** — no incluye vaccination coverage ni mortality clusters todavía | Vaccination coverage requiere catalogo+aggregation que aún no está. Mortality requires death_recorded payload enrichment (placeholder en payload-enrichments). Lo lanzamos cuando el dato esté listo |
| D7 | **Fase 12 métricas admin son operacionales, no estadísticas públicas** — para el admin operador, no para reporting externo | Public stats es Fase 22 con su propio doc. Acá sólo cubrimos "¿cómo va la cola?", "¿hay decay?", "¿qué govt está activo?" |
| D8 | **Fase 13 bulk usa el mismo backend que single-action** — el server action acepta `target_ids: string[]` y itera con savepoint per row | Mantiene la lógica de un solo lugar (idempotente, atómica per item). No optimiza prematuramente |
| D9 | **Fase 14 auto-expiry usa cron diario, no on-demand** — el sweep corre 1× al día, marca lo que toca, notifica al aplicante | Simplicidad. La precisión sub-día es irrelevante para algo que tiene 60 días de tolerancia |
| D10 | **Disputas resueltas son inmutables** — la resolución emite `custody_dispute_resolved` event con `decision_summary` y el flag `pets.in_custody_dispute` se baja. No hay edición posterior | Coherente con event-sourcing. Una decisión errada se corrige raising another dispute |
| D11 | **No agregar configurabilidad por govt** — todos los govts comparten el mismo conjunto de capabilities en estas fases | Coherente con §16 del spec v2.3. La configurabilidad es Fase 21 |

---

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **Custody dispute** | Conflicto formal sobre la titularidad/custodia de un pet específico. Una sola dispute activa por pet | `custody_disputes` (tabla nueva) |
| **Dispute party** | Cuenta involucrada en la dispute (claimant, current owner, current org en custodia, etc.) — multi-row por dispute | `custody_dispute_parties` (tabla nueva) |
| **Outbreak signal feed** | Vista filtrada de `pet_events` type `outbreak_signal` en localidades cubiertas | proyección read-only sobre `pet_events` |
| **Queue age** | Tiempo desde `created_at` de una `approval_requests` row pending hasta ahora | Cálculo on-the-fly en Fase 12 |
| **Bulk action token** | UUID temporal que agrupa una secuencia de acciones individuales emitidas por el mismo bulk submit. Útil para audit_log | `audit_log.payload.bulk_action_id` |
| **Stale request** | `approval_requests.status='pending'` con `created_at` > 60 días | Detectado por sweep en Fase 14 |

---

## 4. Fase 10 — Resolución de disputas de custodia

### 4.1 Por qué

Eventos `custody_dispute_raised` van a empezar a entrar al sistema después del cleanup plan. Hoy no hay donde resolverlos. Sin esta fase:
- El flag `pets.in_custody_dispute=true` nunca se baja
- Transferencias, adopciones, abandonment quedan bloqueadas indefinidamente por el flag (decisión cerrada en cleanup plan)
- No hay paper trail de cómo se resolvió quién es el dueño legítimo

Cada govt cubre sus localidades. Si la dispute nace en una localidad sin govt, fallback a admin (mismo patrón que la cola).

### 4.2 Schema

```sql
-- ---------------------------------------------------------------------------
-- custody_disputes — una fila activa por pet (UNIQUE partial), histórica al resolverse
-- ---------------------------------------------------------------------------
create table custody_disputes (
  id                          uuid primary key default gen_random_uuid(),
  public_token                text not null unique,                 -- DIS-XXXX-XXXX
  pet_id                      uuid not null references pets(id) on delete cascade,

  raised_by_user_id           uuid references profiles(id),         -- nullable: govt acting de oficio
  raised_by_org_id            uuid references organizations(id),    -- nullable: refugio que impugna
  raised_by_role              text not null,                        -- 'owner' | 'org' | 'govt' | 'admin'
  raising_event_id            uuid not null references pet_events(id), -- the custody_dispute_raised event

  jurisdiction_country        text not null default 'AR',
  jurisdiction_province       text not null,
  jurisdiction_locality       text not null,

  status                      text not null default 'open',         -- 'open' | 'resolved' | 'withdrawn'
  resolution                  text,                                  -- 'confirmed_current' | 'transferred_to_claimant' | 'transferred_to_org' | 'transferred_to_third_party' | 'no_change_explained'
  resolution_summary          text,                                  -- prosa libre obligatoria al resolver
  resolution_event_id         uuid references pet_events(id),       -- custody_dispute_resolved
  resolved_by_user_id         uuid references profiles(id),
  resolved_at                 timestamptz,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint custody_disputes_status_valid check (status in ('open','resolved','withdrawn')),
  constraint custody_disputes_resolution_consistent check (
    (status = 'open'      and resolution is null and resolved_by_user_id is null and resolved_at is null)
    or
    (status in ('resolved','withdrawn') and resolved_by_user_id is not null and resolved_at is not null)
  ),
  constraint custody_disputes_resolution_required_when_resolved check (
    status != 'resolved' or (resolution is not null and resolution_summary is not null)
  )
);

-- One open dispute per pet (partial unique).
create unique index custody_disputes_one_open_per_pet
  on custody_disputes (pet_id) where status = 'open';

create index custody_disputes_juris_open_idx
  on custody_disputes (jurisdiction_province, jurisdiction_locality) where status = 'open';

create index custody_disputes_pet_idx on custody_disputes (pet_id, created_at desc);

-- ---------------------------------------------------------------------------
-- custody_dispute_parties — multi-party support per dispute
-- ---------------------------------------------------------------------------
create table custody_dispute_parties (
  id                       uuid primary key default gen_random_uuid(),
  dispute_id               uuid not null references custody_disputes(id) on delete cascade,
  party_user_id            uuid references profiles(id),
  party_organization_id    uuid references organizations(id),
  party_role               text not null,                 -- 'current_owner' | 'claimant_owner' | 'current_org_custody' | 'claimant_org' | 'witness'
  party_position_summary   text,                          -- "Soy el dueño desde 2020, tengo libreta sanitaria"
  added_by_user_id         uuid references profiles(id),
  added_at                 timestamptz not null default now(),

  constraint dispute_party_exactly_one_subject check (
    (party_user_id is not null and party_organization_id is null)
    or
    (party_user_id is null and party_organization_id is not null)
  ),
  constraint dispute_party_role_valid check (party_role in (
    'current_owner','claimant_owner','current_org_custody','claimant_org','witness'
  ))
);

create index custody_dispute_parties_dispute_idx on custody_dispute_parties (dispute_id);
create index custody_dispute_parties_user_idx    on custody_dispute_parties (party_user_id)        where party_user_id is not null;
create index custody_dispute_parties_org_idx     on custody_dispute_parties (party_organization_id) where party_organization_id is not null;
```

**Attachments**: las attachments de evidencia se siguen colgando de `pet_events` (el event `custody_dispute_raised` ya lleva attachments del raiser; cada `custody_dispute_party_added` event posterior puede llevar attachments del party). Nada nuevo en attachments table.

### 4.3 Audit log: nuevos action values

| action | Cuándo | Payload típico |
|---|---|---|
| `dispute_raised` | Authority abre la dispute desde el event `custody_dispute_raised` (auto-emit en el server action del raiser) | `{ dispute_id, pet_id, raising_event_id, raised_by_role }` |
| `dispute_party_added` | Authority agrega una party a la dispute existente | `{ dispute_id, party_id, party_role }` |
| `dispute_evidence_viewed` | Authority abre un attachment de la dispute | `{ dispute_id, attachment_id }` |
| `dispute_resolved` | Authority resuelve la dispute con decisión | `{ dispute_id, resolution, resolution_summary_excerpt }` |
| `dispute_withdrawn` | Raiser retira la dispute antes de decisión (admin puede forzar también) | `{ dispute_id, withdrawn_by_user_id, reason }` |

Las attachments viewing siguen el patrón de `evidence_viewed` del spec v2.3 — un row por view.

### 4.4 Surface

```
/gob/disputas                  → listado de disputes open en scope (govt's localidades; admin universal)
/gob/disputas/[disputeToken]   → detalle: pet info mini, parties, event history del pet (filtrado a custody-related), evidencia, action box

Actions disponibles en el detalle:
  • Agregar party (form: user lookup o org lookup + role + position summary)
  • Ver evidencia (signed URL, audit log entry)
  • Resolver dispute (form: resolution dropdown + resolution_summary textarea min 100 chars + confirm)
  • Retirar dispute (si la raised the same authority o admin)
```

**Mini pet view**: nombre, foto principal, especies, microchip si tiene, current owner display name, current org en custodia si aplica, `pets.in_custody_dispute=true` banner. No mostrar Libreta completa — el admin no necesita ese nivel de detalle, sólo lo necesario para arbitrar.

**Event history filtrado**: solo eventos custody-related del pet (`pet_registered`, `custody_transfer_proposed`, `custody_transferred`, `microchip_implanted`, `microchip_replaced`, `microchip_revoked`, `adoption_*`, `custody_dispute_*`). El resto del timeline (peso, vacunas, etc.) queda fuera para no inducir sesgo médico en una decisión de propiedad.

### 4.5 Server actions

```ts
// app/actions/custody-disputes.ts (nuevo)

export async function addDisputePartyForAuthority({...}): Promise<{ partyId: string }>
export async function resolveDisputeForAuthority({
  disputeId, resolution, resolutionSummary, transferToUserId?, transferToOrgId?,
}): Promise<{ resolvedAt: Date }>
export async function withdrawDisputeForAuthority({...}): Promise<{ withdrawnAt: Date }>
export async function viewDisputeEvidenceAction({...}): Promise<{ signedUrl: string }>
```

**Mutation atómica al resolver**:
1. Capability check: actor.role IN ('govt','admin') con scope match (govt: jurisdiction de dispute matchea su assignment).
2. Status check: dispute.status='open' (anti-race).
3. Si resolution = `transferred_to_claimant` / `transferred_to_org` / `transferred_to_third_party`:
   - Emit `custody_transferred` event con `transferred_by_authority=true` flag en payload
   - Update `ownerships`: cierra el actual, abre el nuevo con `transfer_authority='dispute_resolution'`
4. Emit `custody_dispute_resolved` event con `resolution`, `resolution_summary`, `dispute_id`
5. Update `pets.in_custody_dispute=false`
6. Update `custody_disputes`: status='resolved', resolution, resolution_summary, resolved_*
7. Insert `audit_log` action='dispute_resolved'
8. Insert notifications a TODAS las parties
9. Commit

### 4.6 RLS

`custody_disputes`:
- SELECT: parties involucradas (vía party_user_id/party_organization_id) + govt en scope + admin
- INSERT/UPDATE: solo via server action (server action role)
- DELETE: nunca

`custody_dispute_parties`:
- SELECT: el party + govt en scope del dispute + admin
- INSERT/UPDATE: solo via server action

### 4.7 Notificaciones

Notification.notification_type nuevos:
- `custody_dispute_raised_party` → notif a current owner + current org cuando se raise una dispute sobre su pet
- `custody_dispute_party_added` → notif al party agregado por una authority
- `custody_dispute_resolved` → notif a todas las parties cuando se resuelve
- `custody_dispute_withdrawn` → idem para withdrawal

### 4.8 Out-of-scope explícito de Fase 10

- **Mediación profesional / abogado del estado**: el admin/govt media; no hay sistema de mensajería de las parties dentro de la app. Las parties presentan evidencia y posición; la authority decide unilateralmente.
- **Voto entre múltiples authorities**: una sola authority resuelve. Si dos govts cubren la misma localidad, la primera en abrir la dispute "se la queda" via lock advisory (registrado en sección de open questions).
- **Apelación formal**: no v1. Una decisión errada se cuestiona raising otra dispute.
- **Tipos de dispute específicos** (microchip clonado vs documentación contradictoria vs adopción impugnada): un único tipo dispute con resolution polimórfico. Si en producción aparecen sub-tipos relevantes, se agrega `dispute_sub_kind` en migración futura.

---

## 5. Fase 11 — Dashboards regionales gobierno

### 5.1 Por qué

El symptom-surveillance feature ya emite `outbreak_signal` events que se routean a govt (o admin fallback). La señal entra al sistema pero no hay surface visual para que el govt vea concentración temporal/geográfica. Hoy llega como notification individual, lo cual pierde el patrón.

Idem lost-pets: el feed por locality existe en `/org/[orgToken]` para refugios. El govt podría usar la misma vista para evaluar densidad y eficacia de campañas.

### 5.2 Surface

```
/gob/vigilancia                    → Outbreak signals en scope, agrupados por enfermedad y locality
                                     Filtros: rango de fechas (default últimos 30d), enfermedad, locality
                                     Visual: tabla densa + sparkline por enfermedad

/gob/perdidas                      → Pets con status 'lost' en localidades cubiertas
                                     Filtros: rango de fechas, locality, especie
                                     Visual: tabla con tiempo en estado, último avistamiento, link al credencial público
```

**Sin nuevos tabs en la nav** — agregamos enlaces en el dashboard `/gob` directamente (card-based) y en el header como sub-items debajo del existente "Servicios". Pattern: simple links.

### 5.3 Data sources (read-only sobre tablas existentes)

**`/gob/vigilancia`**:
```sql
select
  e.payload->>'disease_code'                  as disease,
  e.payload->>'jurisdiction_locality'         as locality,
  e.payload->>'jurisdiction_province'         as province,
  e.occurred_at                                as detected_at,
  e.pet_id,
  p.public_token                              as pet_public_token,
  p.display_name                              as pet_display_name
from pet_events e
join pets p on p.id = e.pet_id
where e.event_type = 'outbreak_signal'
  and e.occurred_at >= :since
  and (
       :role = 'admin'                                                 -- universal scope
       or exists (
         select 1 from govt_assignments g
         where g.user_id = :actor_id
           and g.revoked_at is null
           and g.jurisdiction_province = e.payload->>'jurisdiction_province'
           and g.jurisdiction_locality = e.payload->>'jurisdiction_locality'
       )
     )
order by e.occurred_at desc;
```

**`/gob/perdidas`**:
```sql
-- Adapta el lost-and-found feed al govt scope. Usa pets.status='lost' + última status_changed event como timestamp inicial.
select
  p.id, p.public_token, p.display_name, p.species,
  p.last_seen_lat, p.last_seen_lng,
  ls.occurred_at as marked_lost_at,
  o.display_name as owner_display_name,
  pp.jurisdiction_province, pp.jurisdiction_locality
from pets p
left join lateral (
  select occurred_at from pet_events e
  where e.pet_id = p.id
    and e.event_type = 'status_changed'
    and e.payload->>'new_status' = 'lost'
  order by occurred_at desc limit 1
) ls on true
join ownerships o on o.pet_id = p.id and o.ended_at is null
left join profiles pp on pp.id = o.owner_user_id  -- locality del owner como proxy de locality del pet
where p.status = 'lost'
  and (...mismo scope check que arriba sobre pp.jurisdiction_*...)
order by ls.occurred_at desc;
```

Las queries viven en `lib/govt-dashboards.ts` con tests unitarios. No se proyecta en tabla — Drizzle directo.

### 5.4 Visuales

**`/gob/vigilancia`** tres bloques:
1. **Header**: rango activo + filtros (collapsible)
2. **Resumen por enfermedad**: tabla con `disease, count_30d, count_7d, sparkline 30d, count_24h`
3. **Detalle**: lista de signals individuales con pet + locality + timestamp + link al pet event detail

**`/gob/perdidas`** dos bloques:
1. **Header**: filtros
2. **Tabla**: pet (foto + nombre), tiempo perdido, owner, última ubicación (mini-map opcional o sólo coords), link a credencial pública

**Mini-map**: deferred a Fase 17 (PostGIS migration trigger). Por ahora coords en texto + link a OpenStreetMap. Se evalúa volver con un componente shared cuando se haga PostGIS.

### 5.5 Out-of-scope explícito de Fase 11

- **Vaccination coverage** — requiere agregaciones sobre catálogos que aún no están consistentes. Placeholder en `/gob/vigilancia` con copy "Cobertura de vacunación próximamente".
- **Mortality clusters** — requiere `death_recorded.payload.disposition_method` + causa. Placeholder en `/gob/vigilancia`.
- **Export / download CSV** — Fase 18 cuando se construya el pipeline.
- **Email digest diario** al govt con signals nuevos — Fase 16 (depende de email transactional).
- **Mapa interactivo lost-pets** — Fase 17 (PostGIS).
- **Filtros por especie en vigilancia** — agregar cuando el dato lo demande.
- **Cross-locality alerting** (cluster que cruza fronteras administrativas) — Fase 17.

---

## 6. Fase 12 — Métricas operativas admin

### 6.1 Por qué

El admin existente (Nacho, single-operator hoy) no tiene visibilidad de:
- Cuántos signups hubo en las últimas 24h/7d/30d
- Cuántas solicitudes hay paradas más de 14d, 30d, 60d
- Cuántas decisiones se tomaron en cada locality (proxy de govt activity)
- Cuántas revocaciones se ejecutaron en el último mes
- Cuál es la salud del cron de scheduling/booking/sweep

Sin visibilidad, el admin no detecta degradación (ej. un govt inactivo que tiene cola creciendo, un cron caído, un patrón anómalo de signups).

### 6.2 Surface

```
/admin/sistema                  → 4 cards:
                                    1. Usuarios (total, nuevos 24h/7d/30d)
                                    2. Salud de la cola (pending total, oldest pending age, pending 14d+, 30d+, 60d+)
                                    3. Decisiones (decisiones últimos 7d/30d, por type, por authority)
                                    4. Govt activity (último login por govt, decisiones por govt en 30d)

                                  + Bloque "Crons & jobs" con last_run + next_run por cron registrado.
```

### 6.3 Data sources

**Usuarios**:
```sql
select
  count(*) filter (where account_type='personal')                                    as total_personal,
  count(*) filter (where account_type='institutional' and deactivated_at is null)    as total_institutional_active,
  count(*) filter (where created_at >= now() - interval '24 hours')                  as new_24h,
  count(*) filter (where created_at >= now() - interval '7 days')                    as new_7d,
  count(*) filter (where created_at >= now() - interval '30 days')                   as new_30d
from profiles;
```

**Queue health**:
```sql
select
  count(*) filter (where status='pending')                                                            as pending_total,
  extract(epoch from now() - min(created_at) filter (where status='pending'))                          as oldest_pending_seconds,
  count(*) filter (where status='pending' and created_at < now() - interval '14 days')                as pending_14d_plus,
  count(*) filter (where status='pending' and created_at < now() - interval '30 days')                as pending_30d_plus,
  count(*) filter (where status='pending' and created_at < now() - interval '60 days')                as pending_60d_plus
from approval_requests;
```

**Decisiones**:
```sql
select
  count(*) filter (where action='request_approved' and performed_at >= now() - interval '7 days')    as approved_7d,
  count(*) filter (where action='request_rejected' and performed_at >= now() - interval '7 days')    as rejected_7d,
  count(*) filter (where action='request_approved' and performed_at >= now() - interval '30 days')   as approved_30d,
  count(*) filter (where action='request_rejected' and performed_at >= now() - interval '30 days')   as rejected_30d,
  count(*) filter (where action like 'revocation_%' and performed_at >= now() - interval '30 days')  as revocations_30d
from audit_log;
```

**Govt activity** (per row):
```sql
select
  p.id, p.display_name,
  ja.localities_count,
  ad.decisions_30d,
  (select max(performed_at) from audit_log a2 where a2.actor_user_id=p.id) as last_action_at
from profiles p
left join lateral (
  select count(distinct (jurisdiction_province, jurisdiction_locality)) as localities_count
  from govt_assignments ga
  where ga.user_id=p.id and ga.revoked_at is null
) ja on true
left join lateral (
  select count(*) as decisions_30d
  from audit_log a
  where a.actor_user_id=p.id
    and a.performed_at >= now() - interval '30 days'
    and a.action in ('request_approved','request_rejected')
) ad on true
where p.role='govt' and p.account_type='institutional' and p.deactivated_at is null;
```

**Crons & jobs**:
- Lee de tabla nueva `cron_runs` (ver §8.4). Sin migración hasta Fase 14 que la introduce.

### 6.4 Out-of-scope explícito de Fase 12

- **Tendencias históricas largas** (mes a mes, año a año) — agregamos cuando el data set tenga historia.
- **Alerting automatizado** sobre umbrales (ej. "pending > 100" → email) — Fase 16.
- **Métricas business** (revenue/conversion/etc.) — irrelevante en este producto.
- **Per-user activity drilldown** — el detalle vive en `/admin/auditoria?actor=xxx`, no acá.

---

## 7. Fase 13 — Bulk approval/revocation

### 7.1 Por qué

Cuando llegue una campaña tipo "todos los refugios verificados en una ola" (ej. después de un memorándum de la Secretaría de Bienestar Animal CABA) el admin necesita poder seleccionar 30 orgs y aprobar de un saque sin abrir cada una. Idem revocaciones masivas en caso de un proveedor problemático que tuvo múltiples licencias.

Bulk no es lo común, pero cuando se necesita, la falta cuesta horas de operador.

### 7.2 UX

**Pattern uniforme en todas las queues** (`/admin/cola`, `/gob/cola`, `/admin/usuarios`, `/gob/usuarios`, `/admin/organizaciones`, `/gob/organizaciones`):

1. Checkbox por row + "Seleccionar todo" en header
2. Action bar fija al pie cuando hay ≥ 1 selected: "X solicitudes seleccionadas · [Aprobar todo] [Rechazar todo] [Limpiar selección]"
3. Bulk action abre un modal único con:
   - Lista resumida de targets seleccionados
   - Comentario único que se aplica a todos (decision_notes)
   - Si es bulk reject: motivo obligatorio min 30 chars
   - Si es bulk revocación: evidencia mínima 1 attachment (compartida entre todos)
4. Submit → bulk server action

### 7.3 Server actions

```ts
export async function bulkApproveRequestsForAuthority({
  requestIds: string[], decisionNotes?: string,
}): Promise<{ approved: string[]; failed: { id: string; reason: string }[] }>

export async function bulkRejectRequestsForAuthority({
  requestIds: string[], decisionNotes: string,
}): Promise<{ rejected: string[]; failed: { id: string; reason: string }[] }>

export async function bulkRevokeForAuthority({
  targetIds: string[], targetKind: 'vet'|'org'|'govt_assignment',
  reason: string, attachmentIds: string[],
}): Promise<{ revoked: string[]; failed: { id: string; reason: string }[] }>
```

**Pattern de implementación**:
- Wrap todo en una sola transaction
- Para cada item: SAVEPOINT, intenta apply individual logic, si falla RELEASE SAVEPOINT y registra en `failed[]`, sino confirm savepoint
- Genera `bulk_action_id = uuidv4()` al inicio, lo agrega al payload de cada audit_log entry
- Commit final
- Return reporta apruebas exitosas y fallos con razón

**El audit_log queda como entries individuales** (uno por item). El `bulk_action_id` en payload permite filtrar/agrupar después. No agregamos tabla `bulk_actions` — over-engineering.

### 7.4 Capability checks

Cada item se valida individualmente con `requireCapability`. Si el bulk submit incluye ítems de localidades fuera del scope del govt:
- Si todos están fuera → 403
- Si algunos están en scope y otros no → server action procesa sólo los in-scope, retorna los out-of-scope en `failed[]` con `reason='out_of_scope'`

El UI puede deshabilitar la selección de items out-of-scope visualmente para evitar el fallo, pero el server enforces igual.

### 7.5 Out-of-scope explícito de Fase 13

- **Bulk creación de cuentas institucionales** — la creación tiene flujo email único; bulk no aplica.
- **Bulk deactivation de govts** — alto riesgo operativo, mantener single-action.
- **Bulk para disputas de custodia** — cada dispute tiene contexto único, no aplica.
- **Async batch jobs** (background processing) — todo síncrono dentro del request. Si bulk de 50 items pasa de 10s, se separa en chunks de 25 visiblemente.

---

## 8. Fase 14 — Auto-expiry de solicitudes pending viejas

### 8.1 Por qué

Hoy `approval_requests` no tiene timeout. Solicitudes huérfanas (govt inactivo, applicant abandonado) quedan pendientes indefinidamente, ensucian la cola y oscurecen métricas.

Política: si una request lleva > 60 días pending sin ningún `audit_log` action sobre ella (no `request_viewed`, no nada), se marca `withdrawn` con razón `system_auto_expired`. El aplicante recibe notification con CTA "Re-aplicar".

### 8.2 Schema (mínima nueva tabla para crons)

```sql
create table cron_runs (
  id              uuid primary key default gen_random_uuid(),
  cron_name       text not null,                  -- 'approval_requests_auto_expiry', 'scheduling_slots_materialize', etc.
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running',  -- 'running' | 'ok' | 'failed'
  items_processed integer not null default 0,
  details         jsonb not null default '{}'::jsonb,

  constraint cron_runs_status_valid check (status in ('running','ok','failed'))
);

create index cron_runs_name_started_idx on cron_runs (cron_name, started_at desc);
```

Tabla compartida con futuros crons (scheduling materialize, scheduling reminder 24h, posibles otros).

### 8.3 Cron implementation

`app/api/cron/auto-expire-approvals/route.ts` (App Router edge runtime):
- Protected con `Authorization: Bearer ${process.env.CRON_SECRET}` header
- Insert row en `cron_runs` con status='running'
- Query approval_requests con `status='pending' AND created_at < now() - interval '60 days'`
- Para cada row:
  - Update status='withdrawn', withdrawn_at=now(), decision_notes='Auto-expired after 60 days inactivity'
  - Insert audit_log action='approval_request_withdrawn_by_system' con payload `{ reason: 'auto_expired', cron_run_id }`
  - Insert notification a applicant: type='approval_request_auto_expired'
- Update cron_runs status='ok', finished_at=now(), items_processed=N

Frequency: **daily at 04:00 UTC** (01:00 AR-time, off-peak).

### 8.4 Audit log: nuevos action values

| action | Cuándo | Payload |
|---|---|---|
| `approval_request_withdrawn_by_system` | Auto-expiry cron procesa una request | `{ reason: 'auto_expired', cron_run_id, days_pending }` |

`actor_user_id` para este action: **el primer admin del sistema** (admin_seeded). El audit_log requiere actor non-null y el cron no es un user. Convención: lookup el primer admin activo y usar su id como actor del system action. Si no hay ninguno, el cron falla loudly (no crear system actions sin actor identificable).

### 8.5 Notificaciones

- `approval_request_auto_expired` → al aplicante con CTA "Re-aplicar"

### 8.6 Out-of-scope explícito de Fase 14

- **Notificación de aviso a los 50 días** ("tu solicitud va a expirar en 10 días") — Fase 16 (depende de email).
- **Política configurable de TTL por type** — todos los types comparten 60d. Si emerge una request type que necesita TTL distinto, se hace en su propia fase.
- **Reopen de auto-expired sin re-aplicar** — el aplicante debe re-aplicar (es nuevo paper trail).
- **Sweep on-demand button en admin UI** — el cron diario es suficiente. Si el admin quiere forzar ahora, runs el job manualmente vía CLI.

---

## 9. Capability matrix delta (vs spec v2.3)

| Acción | govt en scope | admin |
|---|---|---|
| Ver `/gob/disputas` | ✓ | ✓ (universal) |
| Resolver `custody_dispute_raised` (locality propia) | ✓ | ✓ |
| Withdraw dispute que él mismo abrió | ✓ | ✓ |
| Force-withdraw dispute (no abierta por él) | — | ✓ |
| Ver `/gob/vigilancia` | ✓ | ✓ (universal) |
| Ver `/gob/perdidas` | ✓ | ✓ (universal) |
| Ver `/admin/sistema` | — | ✓ |
| Bulk approve/reject en cola scope | ✓ | ✓ |
| Bulk revoke en scope | ✓ | ✓ |
| Disparar manual auto-expiry sweep | — | ✓ (via CLI) |

---

## 10. Notificaciones nuevas (acumuladas)

```
custody_dispute_raised_party
custody_dispute_party_added
custody_dispute_resolved
custody_dispute_withdrawn
approval_request_auto_expired
```

Patrón continúa siendo TEXT en `notification_type`, sin enum migration. Mismas tablas, mismos surfaces.

---

## 11. Phasing

| Fase | Resumen | PRs | Pre-requisitos |
|---|---|---|---|
| **10** | Custody dispute resolution surface + tablas + actions | 1 PR grande | event-catalog-cleanup plan ejecutado |
| **11** | Govt regional dashboards (vigilancia + perdidas) | 1 PR | Surveillance feature ya implementado (✅) |
| **12** | Admin system metrics dashboard | 1 PR | cron_runs table no es bloqueante; aparece vacía hasta Fase 14 |
| **13** | Bulk approval/revocation en queues | 1 PR | Ninguno |
| **14** | Auto-expiry cron + cron_runs table | 1 PR | Vercel Cron configured (mismo pre-req que scheduling 24h reminder) |

Las fases son **independientes** excepto Fase 10 que necesita el cleanup primero. Se pueden ejecutar en orden 11 → 12 → 13 → 14 → 10 si querés esperar al cleanup, o 10 → 11 → 12 → 13 → 14 si arrancás cleanup primero.

---

## 12. Placeholders — fases más adelantadas (sin spec/plan todavía)

Las siguientes fases son conocidas y citadas en otros docs pero no se diseñan acá. Documentar para que el roadmap quede explícito:

| Fase | Nombre | Trigger para diseñar |
|---|---|---|
| **15** | Memberships / multi-operator por cuenta institucional | Cuando una org/govt tenga > 1 persona operando regularmente (hoy single-operator es suficiente per D12 de spec v2.3) |
| **16** | Email transactional provider real | Cuando estemos listos para campañas de adopción / digest semanal a govt / aviso de auto-expiry pre-50d. Provider TBD (Resend / Postmark / AWS SES) |
| **17** | PostGIS migration + interactive map dashboards | Cuando radius search / cluster detection / mapa lost-pet se vuelvan demanda real |
| **18** | Export CSV / Excel desde dashboards | Cuando un govt pida "necesito reporte de vigilancia trimestral para mi superior" |
| **19** | Appeal process formal post-rejection | Si emergen casos donde la re-aplicación pierde contexto de por qué fue rechazada |
| **20** | Two-phase commit en revocaciones (propose → execute con espera) | Si emerge un caso donde la revocación inmediata bloquea operaciones legítimas que necesitaban transition window |
| **21** | Mobile admin UI | Cuando el admin necesite operar desde teléfono. Hoy desktop-only |
| **22** | Multi-country support | Cuando expandamos fuera AR (Uruguay, Chile, Paraguay candidates) |
| **23** | Business rules configurables por govt | Si emerge diferencia operativa que un govt quiere personalizar (ej. su política de "tiempo máximo a la decisión") |
| **24** | Public stats sobre el sistema | Site-wide página "estado de DIM" para periodismo/transparency. Bajísima prioridad |
| **25** | Restore `profiles_account_type_role_match` CHECK (tech debt de migración 0016) | Cuando descubramos por qué Drizzle no podía hacer el UPDATE atómico. App-layer enforcement cubre por ahora |

---

## 13. RLS y security delta

**`custody_disputes`**: SELECT a parties + govt en scope + admin. INSERT/UPDATE solo via server action.
**`custody_dispute_parties`**: SELECT al party + govt en scope del dispute + admin.
**`cron_runs`**: SELECT solo admin. INSERT solo via cron route + server (con CRON_SECRET).

Server actions de Fase 13 (bulk) heredan los mismos capability checks que los single-action equivalents — son wrappers que iteran, no nuevos privilege paths.

---

## 14. Bootstrap y rollback

Ninguna de Fases 10-14 toca tablas existentes excepto:
- `pets.in_custody_dispute` (ya estuvo en cleanup plan)
- `approval_requests.status` puede pasar a 'withdrawn' por el cron (semánticamente legítimo)
- `pet_events` recibe nuevos types ya registrados en cleanup plan (`custody_dispute_resolved`)

Rollback per fase:
- **Fase 10**: drop custody_disputes + custody_dispute_parties. Sin rollback de `in_custody_dispute=true` rows en pets (event histórico preservado).
- **Fase 11**: rollback es removing surfaces (read-only sobre tablas existentes).
- **Fase 12**: rollback es removing surface.
- **Fase 13**: rollback es removing bulk UI; los single-action paths siguen funcionando.
- **Fase 14**: drop cron_runs + remove cron route. Pending requests > 60d quedan donde estaban hasta que se reimplemente.

---

## 15. Lo que NO está en este spec

Para evitar scope creep:

- **Configurabilidad por govt** (D11) — Fase 23 cuando aparezca demanda real.
- **Memberships** — Fase 15 (placeholder).
- **Email real** — Fase 16.
- **Mapa interactivo** — Fase 17.
- **Export** — Fase 18.
- **Appeal process** — Fase 19.
- **Two-phase revocations** — Fase 20.
- **Mobile UI** — Fase 21.
- **Multi-country** — Fase 22.
- **Public stats** — Fase 24.
- **Restore CHECK constraint dropped en 0016** — Fase 25.
- **Custody dispute mediation chat** (parties intercambiando mensajes dentro de la app) — out of scope. La authority arbitra unilateralmente con evidencia.
- **Cross-locality dispute** (pet movido entre localidades durante la dispute) — la dispute se asigna a la locality del pet al momento del raise. Si cambia, no re-asigna.

---

## 16. Próximo paso

El plan ejecutable correspondiente es `plans/2026-05-18-admin-page-fases-10-14.md`. Cubre las cinco fases como cinco PRs independientes con paso a paso, archivos a tocar, tests, RLS, migration scripts, y verificación.

Cualquier ajuste del catálogo (resolutions de dispute, métricas del admin sistema, política del cron) — **decímelo antes**. Cambiar después del plan cuesta más.
