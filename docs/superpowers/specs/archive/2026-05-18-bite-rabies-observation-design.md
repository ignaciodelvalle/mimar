> **IMPLEMENTED / shipped** — This spec has been fully implemented. The bite-rabies observation flow is live: `rabies_observation_started`/`_ended` event types, `app/admin/observaciones/[publicToken]`, cron `app/api/cron/close-rabies-observations/route.ts`. Archived for historical reference only.

# Bite reporting + 10-day rabies observation — design spec

> Cuando se reporta que una mascota DIM mordió a alguien (humano u otro animal), arranca automáticamente el período de observación antirrábica de 10 días que la legislación argentina exige. Durante esos 10 días, cualquier `symptom_observed` que matchee síntomas compatibles con rabia (alta especificidad) **escala** al nivel `urgent` y dispara alerta a autoridad sanitaria + nudge fuerte al dueño para que consulte al vet de inmediato. Al día 11, si no hubo síntomas escalables, el período se cierra automáticamente como negativo. Si hubo, queda abierto para decisión profesional.
>
> Auto-contenido; el plan de implementación va aparte.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.1 — refactor de modelado: los bites NO son un `event_type` propio. Viven dentro de `incident_reported` con `incident_type='bite_inflicted'`. El schema de `incident_reported` ya incluye los campos bite-específicos como opcionales (ver `event-catalog-cleanup` paso 3). Funcionalmente equivalente a v1.0; cambia el plumbing del event_type.

---

## 1. Por qué este documento existe

`AGENTS.md` (sección 6.3 de `legal-framework-full.md`) ya ancla este feature como **futuro** con los event types reservados: `bite_inflicted`, `rabies_observation_started`, `rabies_observation_ended`. La sección 7 lista los datos exigidos por la norma (identificación del animal, antirrábica vigente o no, datos del propietario, datos del mordido, fecha y lugar del hecho). Los hooks legales son:

- **Decreto 4669 / 1973 (PBA)** — observación antirrábica obligatoria de 10 días para mordedores, in situ o en sede oficial
- **Ordenanza CABA 41.831 / 1987** — análogo en CABA, observación en Instituto Pasteur o domicilio
- **Resolución MS 1144 / 2018** — guía nacional de prevención, vigilancia y control de rabia; define APR (atención post-exposición)
- **Ley 15.465 / 1960 + Decreto 3640/1964** — rabia es enfermedad de notificación obligatoria nacional
- **Ley 5325 / 1948 (PBA)** — denuncia obligatoria de enfermedades transmisibles dentro de 24 hs
- **Ley CABA 4078 / 2012 + Res. 93/APRA/2021** — notificación de incidentes <48 hs para PPP

Hoy DIM no tiene **ninguna** de las tres entidades. Si un dueño reporta una mordedura, no hay flow — el dato se pierde. Y la conexión natural con surveillance (rabies symptoms detected) no escala porque no hay state que marque "estamos en observación, esto es urgente".

Este spec cierra ese hueco haciendo lo que la ley pide, integrándolo con `symptom_observed` ya implementado, y disparando alertas escaladas cuando corresponda. **Sin reemplazar al sistema sanitario oficial** — DIM no es el dispensario antirrábico; es la libreta digital del dueño que **se acuerda** del bite y deja constancia. Para el vet/govt es un signal adicional sobre el animal específico que cruza con el surveillance feature general.

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| D1 | **El período es exactamente 10 días** desde la fecha del bite, sin configurabilidad. La ley dice 10; no inventamos otro valor | Hard-coded en `RABIES_OBSERVATION_DAYS = 10` constant. Si algún día CABA o PBA cambia, se actualiza en un único lugar |
| D2 | **Tres event types nuevos**: `bite_inflicted`, `rabies_observation_started`, `rabies_observation_ended`. Todos son **libreta-sanitaria events** (el vet futuro va a querer ver "este perro mordió en 2026 y completó observación negativa") | Coherente con `LIBRETA_SANITARIA_EVENT_TYPES`. La libreta tiene que reflejar la historia clínica completa |
| D3 | **`rabies_observation_started` se emite automáticamente** en la misma transacción que el `bite_inflicted`. Atómico — si insertás un bite, arrancás observación. Sin opción "no observar" | La ley no da opción. Reportar mordedura y no iniciar observación es bug |
| D4 | **Columna `pets.rabies_observation_status`** denormalizada con valores `null | 'in_progress' | 'completed_negative' | 'completed_positive_rabies' | 'completed_dead'`. Dual-write desde los server actions; re-derivable de los events si fuera necesario | Permite queries rápidas tipo "todos los pets en observación activa" sin escanear `pet_events`. Mismo patrón que `pet.status` o `pet.estimatedWeightKg` |
| D5 | **`symptom_observed` durante observación activa dispara escalada**. El matcher de surveillance (ya implementado) detecta `rabies_suspected` con specificity alta → si pet está `in_progress`, el `outbreak_signal` sube de severity `warning` a `urgent` y se notifica al owner además del govt | Excepción explícita a D1 del surveillance spec (que dice "el dueño no ve diagnósticos"). En este caso, el riesgo de salud pública es concreto: persona mordida, ventana de 10 días, vacuna PEP humana necesaria si la sospecha es real. El nudge al dueño es legítimo |
| D6 | **Routing de notification: govt scope-matching + admin fallback**, mismo patrón que symptom-surveillance feature. Govt en la localidad del bite recibe el bite_inflicted; durante observación, escalations también van al mismo govt | Reusa infrastructure ya escrita (`findAuthoritiesForJurisdiction`). Sin código nuevo de routing |
| D7 | **Cron diario chequea observaciones vencidas**. Pet con `rabies_observation_status='in_progress'` y `bite.occurred_at + 10 days < now` y sin `symptom_observed` escalable durante el período → auto-emite `rabies_observation_ended` con outcome `negative` | Necesitamos cron porque el período se cierra solo en happy path. Mismo patrón que `materialize-slots`. Cron route `/api/cron/close-rabies-observations` |
| D8 | **Auto-cierre solo en happy path**. Si hubo CUALQUIER `symptom_observed` con rabies high-spec match durante el período, el auto-cierre se bloquea. La observación queda `in_progress` esperando intervención humana (owner, vet, o govt) que la cierre manualmente con outcome `positive_rabies` o `negative` (si el vet descartó) | El sistema no puede inferir clínicamente si fue rabia o no. Lo que SÍ puede es no dejarlo pasar silenciosamente |
| D9 | **Muerte durante observación = escalada máxima**. Si se inserta `death_recorded` mientras `rabies_observation_status='in_progress'`, el server action atómicamente flippea status a `completed_dead`, notifica govt/admin con severity `urgent`, y agrega flag al `death_recorded.payload.during_rabies_observation=true` para audit. Si la causa declarada del fallecimiento es `rabies` o `unknown`, severity de la notificación es máxima | Caso crítico desde public-health. El centro de salud que atendió a la víctima necesita saber INMEDIATAMENTE |
| D10 | **Quién puede reportar `bite_inflicted`**: owner (self-report), vet/org-member con capability (registro profesional), govt en scope (cuando reciben report desde centro de salud). Capability nueva `bite.report` para vet/org; owner tiene auto-permiso sobre sus pets | Acordemos los tres path de origen. El bite puede entrar a DIM por cualquiera de los tres sentidos |
| D11 | **Quién puede cerrar manualmente `rabies_observation_ended`**: owner solo con outcome `negative` (declarando "ya pasaron 10 días, todo bien"). Vet/govt con cualquier outcome incluyendo `positive_rabies`. La razón es asimetría de responsabilidad — el outcome positivo es un acto profesional, no de owner | Owner cierre negative requiere los 10 días cumplidos. Sin trampa de "cierro al día 2" |
| D12 | **Datos del mordido**: si es humano y se identifica, persistimos contacto opcional (nombre, teléfono) en `payload.victim_contact` para denuncia obligatoria. Si es animal, link a `pet_id` si está en DIM, sino texto libre | Privacy: estos datos NO se exponen en credencial pública. Solo a govt/admin que reciben el bite report |
| D13 | **Antirrábica vigente al momento del bite**: snapshot en `bite_inflicted.payload.rabies_vaccine_valid_at_bite: bool`. Lo computamos al insertar el evento, no en runtime. Si la vacuna estaba vencida, la ley lo trata como agravante | Datos congelados al momento del hecho. Si después el owner vacuna, no cambia el flag histórico |
| D14 | **`bite_inflicted` se considera evento de high-stakes**. La operación es atómica y crea TRES events en una sola transacción: `bite_inflicted`, `rabies_observation_started`, y notification al govt. Si la notification falla, el bite se inserta igual (defensive, mismo principio que symptom-surveillance D8). Pero `rabies_observation_started` NO es opcional — si falla, todo rollback | Coherencia event log: si hay bite, hay observación. Sin medias tintas |

## 3. Glosario

| Término | Qué es |
|---|---|
| **Bite event** | Acto de mordedura del animal sobre una víctima (humano u otro animal). Se reporta a DIM creando un `bite_inflicted` event |
| **Observation period** | Los 10 días siguientes al bite. Durante este período, el animal está en `rabies_observation_status='in_progress'` |
| **Observation closure** | Fin del período. Automático (negativo) si no hubo síntomas; manual (positivo o profesional-declarado negativo) si hubo |
| **Escalation** | Cuando un `symptom_observed` durante observación matchea rabia con high specificity, se eleva la severity del signal y se notifica explícitamente al owner |
| **Victim contact** | Datos del mordido (humano principalmente). Sensibles, no aparecen en credencial pública |
| **Rabies-suspected closure** | El cierre con outcome `positive_rabies` solo lo declara un vet o govt — el owner no puede cerrar como positivo |

## 4. Domain model

### 4.1 Extender `EVENT_TYPES` con dos valores

En `db/schema.ts → EVENT_TYPES`:

```ts
"rabies_observation_started",
"rabies_observation_ended",
```

Y agregar ambos a `LIBRETA_SANITARIA_EVENT_TYPES` en `lib/libreta-sanitaria.ts` (son eventos médicos/sanitarios que el vet futuro consulta).

**Nota v1.1:** `bite_inflicted` NO se agrega como event_type. El bite vive dentro de `incident_reported` (que ya existe en EVENT_TYPES + schema desde `event-catalog-cleanup`) con `incident_type='bite_inflicted'`. Los campos bite-específicos (`victim_kind`, `victim_contact_*`, `rabies_vaccine_valid_at_incident`, etc.) ya están como opcionales en el schema de `incident_reported`.

### 4.2 Zod schemas en `lib/event-schemas.ts`

**Nota v1.1:** el bloque `biteInflicted` que la v1.0 incluía acá YA NO va. Los campos bite-específicos viven en el schema de `incident_reported` (extendido en `event-catalog-cleanup` paso 3). Los dos schemas que sí se agregan son `rabiesObservationStarted` y `rabiesObservationEnded`. El `bite_event_id` que ambos referencian es un uuid al `pet_events.id` de un row con `event_type='incident_reported' AND payload->>'incident_type'='bite_inflicted'`.

```ts
const rabiesObservationStarted = z
  .object(
    withVersion({
      bite_event_id: z.string().uuid(), // FK to the originating incident_reported (bite) event
      observation_until: z.string(), // ISO date = bite occurred_at + 10 days
      location: z.enum(["in_situ", "official_site"]), // domicilio vs sede oficial (Instituto Pasteur, dispensario)
      official_site_organization_id: z.string().uuid().nullable(), // when location='official_site'
    }),
  )
  .strict();

const rabiesObservationEnded = z
  .object(
    withVersion({
      bite_event_id: z.string().uuid(),
      observation_started_event_id: z.string().uuid(),
      outcome: z.enum([
        "negative",                  // observation completed, no symptoms, animal healthy
        "positive_rabies",           // confirmed or strongly suspected rabies
        "dead",                      // animal died during observation (cause may be unknown)
        "lost_to_followup",          // animal escaped / owner lost contact during period
      ]),
      closed_by_role: z.enum(["owner", "vet", "govt", "admin", "system"]),
      closure_notes: z.string().nullable(),
      // If outcome is dead, the linked death_recorded event for cross-reference
      death_event_id: z.string().uuid().nullable(),
    }),
  )
  .strict();
```

Registrar en `PayloadSchemas` con los nuevos keys.

### 4.3 Extender `pets` con columna de status denormalizada

```sql
alter table pets
  add column rabies_observation_status text;

-- Valid values when not null:
-- 'in_progress' | 'completed_negative' | 'completed_positive_rabies' | 'completed_dead' | 'completed_lost_to_followup'
alter table pets
  add constraint pets_rabies_observation_status_valid
  check (
    rabies_observation_status is null
    or rabies_observation_status in (
      'in_progress',
      'completed_negative',
      'completed_positive_rabies',
      'completed_dead',
      'completed_lost_to_followup'
    )
  );

-- Index for the cron that scans active observations
create index pets_rabies_observation_in_progress_idx
  on pets (rabies_observation_status)
  where rabies_observation_status = 'in_progress';
```

**Dual-write discipline:** este campo se setea desde los server actions que insertan `rabies_observation_started` (→ `'in_progress'`) y `rabies_observation_ended` (→ algún `completed_*`). Re-derivable consultando los events en `lib/projections/pet-rabies-observation.ts` (sigue el patrón de `pet-status`, `pet-weight`).

### 4.4 Capability nueva

En `lib/capabilities.ts`, agregar `bite.report` para members de organizations (vet o shelter staff que reporta mordedura presenciada). Owner tiene auto-permiso sobre sus pets vía session. Govt en scope tiene auto-permiso vía su role.

### 4.5 Notification types nuevos

`Notification.notification_type` agrega (TEXT, sin migración):

- `bite_reported_owner` — al owner cuando se reporta bite (también si lo reportó vet/govt y owner no estaba presente)
- `bite_reported_authority` — al govt en scope (denuncia obligatoria <24/48 hs)
- `rabies_observation_started_owner` — al owner con instrucciones del período
- `rabies_observation_escalation_owner` — al owner cuando aparece symptom escalable durante observación (severity `urgent`, copy "consultá al vet de inmediato")
- `rabies_observation_escalation_authority` — al govt escalation
- `rabies_observation_completed_negative_owner` — al owner cuando termina ok
- `rabies_observation_pending_review` — al govt cuando vence el período pero hubo symptoms (no auto-cierre, requiere intervención humana)

## 5. Flujos

### 5.1 Reportar mordedura — owner self-report

```
Owner abre /mis-mascotas/{petToken}/eventos/nuevo/mordedura
  → form con:
    - Fecha del incidente (date picker, default hoy, max hoy)
    - Lugar (text + map pin si bidirectional-geocoding está implementado)
    - Tipo de víctima: humano | otro animal | desconocido
    - Si humano: datos opcionales (nombre, teléfono, edad estimada) — disclaimer "estos datos quedan registrados para denuncia obligatoria"
    - Si otro animal: opción "está en DIM" (pet search) o "no está en DIM" (free text)
    - Severidad: leve | moderada | grave (con tooltips de qué significa cada una)
    - Contexto (textarea libre, opcional)
    - Confirmación: "Entiendo que esto inicia un período de observación obligatorio de 10 días"
  → submit → reportBiteAction (server action)

reportBiteAction atomic transaction:
  1. requireOwnedPetByToken — valida ownership
  2. Verificar que pet.rabies_observation_status IS NULL OR 'completed_*'
     (si está in_progress de otro bite, error claro "Esta mascota ya está en observación por otra mordedura")
  3. Computar rabies_vaccine_valid_at_bite:
     query latest vaccination_administered with vaccine_name matching antirrábica
     compare next_due_at > bite_date
  4. Insert pet_events incident_reported con incident_type='bite_inflicted' y payload validado (Zod)
  5. Insert pet_events rabies_observation_started con observation_until = bite_date + 10 days
  6. UPDATE pets SET rabies_observation_status = 'in_progress'
  7. Insert Notification al owner: bite_reported_owner + rabies_observation_started_owner
  8. Insert Notifications a govt(s) scope-matching: bite_reported_authority
     (defensive: si esto falla, NO rollback. Log error)
  Commit.

Owner sees: confirmation page con instrucciones del período de 10 días, fecha de cierre estimada, qué hacer si nota síntomas raros.
```

### 5.2 Reportar mordedura — vet/org-member

Mismo flow pero desde `/org/{orgToken}/mordedura/nuevo`. El org-member elige el pet (search por publicToken o display de pets atendidos recientemente). Capability check: `bite.report`. Resto idéntico, salvo `reporter_role` = 'vet' o 'shelter' según membership.

### 5.3 Reportar mordedura — govt

Govt reporta desde `/gob/incidentes/nuevo` cuando un centro de salud les comunica el caso. Mismo flow + capability check via `role='govt'` con assignment matching la jurisdicción del bite.

### 5.4 Período de observación — monitoring activo

Durante los 10 días, no hay acción del owner *requerida* — la observación es pasiva. Pero pasan dos cosas en el sistema:

**5.4.1 Reminder visible al owner.** Insertamos un Reminder con `due_at = bite_date + 10 days`, `reminder_type = 'rabies_observation'`, linkeado a los events. Aparece en "Próximos eventos" del pet profile con copy: *"Termina la observación de 10 días por mordedura. Si {Pet} no mostró síntomas raros (salivación excesiva, agresividad inusual, parálisis), la observación se cierra automáticamente. Si notás algo, consultá al vet de inmediato."*

**5.4.2 Surveillance escalation hook.** En `app/actions/events.ts → createSymptomObservedAction` (o donde sea que se inserta `symptom_observed`), antes de emitir el `outbreak_signal` consultar `pet.rabies_observation_status`. Si está `'in_progress'` Y el matcher detecta `rabies_suspected` con specificity high → escalation:

```ts
const isEscalating = (
  pet.rabies_observation_status === 'in_progress' &&
  alertableDiseases.some(d =>
    d.disease_code === 'rabies_suspected' &&
    d.high_count >= 1
  )
);

if (isEscalating) {
  // 1. Insert outbreak_signal with severity='urgent' + payload.bite_observation_active=true
  // 2. Insert Notification to owner: rabies_observation_escalation_owner
  //    title: "Urgente: posible signo de rabia en {pet.name}"
  //    body: "Durante el período de observación por mordedura, registraste síntomas
  //           que podrían indicar rabia. CONSULTÁ AL VETERINARIO INMEDIATAMENTE.
  //           Si no podés, andá al dispensario antirrábico más cercano o llamá al 107."
  //    severity: 'urgent'
  // 3. Insert Notification to govt: rabies_observation_escalation_authority (urgent)
}
```

**Notar la asimetría con el spec original de symptom-surveillance (D1)**: ahí el owner NUNCA ve diagnósticos especulativos. Acá SÍ — porque el contexto cambió. Hay ventana de 10 días, hay víctima humana (probablemente), y hay decisión médica que el owner debe disparar de inmediato. La excepción está documentada en D5 de este spec.

### 5.5 Cierre automático del período (happy path)

Cron `/api/cron/close-rabies-observations` corre cada día a las 03:00 AR. Idempotent.

```ts
// Pseudocode
const now = new Date();

// Find pets in observation whose period has ended
const eligible = await db.select()
  .from(pets)
  .where(eq(pets.rabies_observation_status, 'in_progress'));

for (const pet of eligible) {
  // Find the active observation started event
  const [startedEvent] = await db.select().from(petEvents).where(and(
    eq(petEvents.petId, pet.id),
    eq(petEvents.eventType, 'rabies_observation_started'),
  )).orderBy(desc(petEvents.occurredAt)).limit(1);

  const observationUntil = new Date(startedEvent.payload.observation_until);
  if (observationUntil > now) continue; // period not over yet

  // Find the bite event
  const biteEventId = startedEvent.payload.bite_event_id;

  // Check if there are escalating symptom_observed events during the period
  const escalatingSymptoms = await db.select().from(petEvents).where(and(
    eq(petEvents.petId, pet.id),
    eq(petEvents.eventType, 'symptom_observed'),
    gte(petEvents.occurredAt, startedEvent.occurredAt),
    lte(petEvents.occurredAt, observationUntil),
    // Use a SQL contains on payload.alerted_disease_codes for 'rabies_suspected'
    sql`payload->'alerted_disease_codes' ? 'rabies_suspected'`,
  ));

  if (escalatingSymptoms.length > 0) {
    // BLOCK auto-close. Notify govt for review.
    await db.insert(notifications).values({
      ...
      notificationType: 'rabies_observation_pending_review',
      severity: 'urgent',
      title: `Observación pendiente de revisión: ${pet.name}`,
      body: 'Hubo síntomas escalables durante el período. Cierre profesional requerido.',
    });
    continue;
  }

  // Happy path: auto-close as negative
  await db.transaction(async (tx) => {
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: 'rabies_observation_ended',
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: null,
      authorRole: 'system',
      payload: validateEventPayload('rabies_observation_ended', {
        bite_event_id: biteEventId,
        observation_started_event_id: startedEvent.id,
        outcome: 'negative',
        closed_by_role: 'system',
        closure_notes: 'Auto-cerrado tras 10 días sin síntomas escalables',
        death_event_id: null,
      }),
    });
    await tx.update(pets)
      .set({ rabies_observation_status: 'completed_negative', updatedAt: now })
      .where(eq(pets.id, pet.id));
    // Complete the linked reminder if any
    // Notify owner: rabies_observation_completed_negative_owner
  });
}
```

### 5.6 Cierre manual

**Owner cierra como negative**: desde `/mis-mascotas/{petToken}` aparece un botón "Confirmar fin de observación" cuando `rabies_observation_status='in_progress'` Y `observation_until < now`. Cuando lo aprieta:

```
ownerCloseRabiesObservationAction(petToken):
  - Valida: status='in_progress', observation_until < now, no escalating symptoms
  - Si no hay symptoms escalables → mismo flow que auto-close pero closed_by_role='owner'
  - Si hubo symptoms escalables → error claro, redirige al owner a "contactá al vet, esto necesita cierre profesional"
```

**Vet/govt cierra con cualquier outcome**: desde `/org/{orgToken}/...` o `/gob/...`, capability `bite.close_observation`. Form para elegir outcome (`negative`, `positive_rabies`, `lost_to_followup`) + closure_notes. Si outcome=`positive_rabies`:
- Notification urgent al owner
- Notification urgent escalada a admin
- Considerar: emit `death_recorded` automático? **NO**. Solo si el vet/govt también declara muerte. Separamos las cosas

### 5.7 Muerte durante observación

Cuando se inserta un `death_recorded` event y `pet.rabies_observation_status='in_progress'`:

```
En el server action que inserta death_recorded (existing):
  1. Detectar pet.rabies_observation_status='in_progress'
  2. Atomic en la misma transacción:
     - Insert rabies_observation_ended con outcome='dead', death_event_id=<new>, closed_by_role='system'
     - UPDATE pets SET rabies_observation_status='completed_dead'
     - Insert death_recorded.payload.during_rabies_observation=true (extender Zod schema)
     - Notification urgent a govt + admin: rabies_observation_completed_dead_authority
     - Si causa declarada es 'rabies' o 'unknown' → notification también al owner con copy fuerte
```

## 6. Integración con sistemas existentes

### 6.1 Libreta sanitaria

Los tres nuevos events son libreta. Aparecen agrupados en la sección "Incidentes" o (mejor) en nueva sección "Mordeduras y observación" del libreta-view (Parte B/C ya implementadas).

### 6.2 Surveillance feature

Hook descripto en §5.4.2. Sin tocar `symptom-matcher.ts` core, solo agregar el check en el server action que ya inserta `outbreak_signal`. Mínimo cambio.

### 6.3 Notification routing

Reusa `findAuthoritiesForJurisdiction(province, locality)` del scheduling feature. Govt-first, admin-fallback. Sin código nuevo de routing.

### 6.4 Public credential

Por defecto, los bite events NO aparecen en credencial pública (privacy del mordido). Pero la sección "Estado de observación: en curso hasta {date}" SÍ aparece como banner ámbar cuando `rabies_observation_status='in_progress'` y la credencial es de un pet `status='lost'` — porque un finder que recupera al pet tiene que saber que está en observación antirrábica (la ley lo exige).

Cuando `status='active'` y solo `rabies_observation_status='in_progress'`, NO se expone en credencial pública (el owner no quiere que el mundo sepa que su perro mordió a alguien).

### 6.5 Disclosure preferences (lost-and-found)

Si el pet está perdido + en observación, el banner antirrábico aparece como información de seguridad pública. Es un override de las disclosure preferences del owner — la seguridad de quien encuentra al animal supera la preferencia del owner sobre exposición.

## 7. UI surfaces

### Owner-side
- `/mis-mascotas/{petToken}/eventos/nuevo/mordedura` — form de bite report
- `/mis-mascotas/{petToken}` — pet profile muestra banner "Observación antirrábica hasta {date}" cuando `in_progress`. Botón "Confirmar fin" cuando vencido
- `/mis-mascotas/{petToken}/libreta` — sección Mordeduras visible

### Org-side
- `/org/{orgToken}/mordedura/nuevo` — vet/shelter reporta bite presenciado
- `/org/{orgToken}/observaciones` — lista de pets en observación que el org está siguiendo

### Govt-side
- `/gob/incidentes` — cola de bites reportados en su scope
- `/gob/incidentes/nuevo` — govt registra bite desde centro de salud
- `/gob/observaciones` — lista de observaciones activas en su scope + las que vencen pronto

### Admin-side
- `/admin/observaciones` — fallback queue (jurisdicciones sin govt)

## 8. RLS

- `pet_events` (bite_inflicted, rabies_observation_*) — owner del pet ve sus events. Govt/admin ven via su scope para approvals/dashboards. Mismo pattern existente
- `pets.rabies_observation_status` — visible al owner. Visible a govt en scope vía join. RLS existente cubre
- `Notification` — scoped por user_id, mismo pattern

Sin policies nuevas.

## 9. Privacy

- `bite_inflicted.payload.victim_contact_*` — solo accesible a owner del pet (su record) + govt/admin scope-matching. Nunca expuesto en credencial pública
- `rabies_observation_status='in_progress'` — visible públicamente SOLO cuando pet está lost (override de disclosure prefs). En todos los otros casos, info privada owner-only
- Audit log: cada acción sobre bite/observation queda en `audit_log` (cuando admin page Fase 0 land); hasta entonces, en server logs

## 10. Phasing

**Fase 0 — Schema foundation (1 PR).** Migración (extender EVENT_TYPES, agregar columna `pets.rabies_observation_status`, agregar Zod schemas, registrar en libreta sanitaria). Capability `bite.report` agregada. Tests del schema + Zod.

**Fase 1 — Server actions + owner UI (1-2 PRs).** `reportBiteAction` (owner-initiated), `ownerCloseRabiesObservationAction`. UI en `/mis-mascotas/*`. Reminder integration.

**Fase 2 — Surveillance hook + escalation (1 PR).** Modificar el server action de `symptom_observed` insertion para detectar observación activa + escalation. Tests cubriendo el caso escalable y el no-escalable.

**Fase 3 — Cron de auto-cierre (1 PR).** Script + cron route. Idempotent. Tests del happy path + del bloqueo cuando hay escalating symptoms.

**Fase 4 — Org-side reporting (1 PR).** UI en `/org/{orgToken}/mordedura/*`. Capability check. Mismo backend del Fase 1.

**Fase 5 — Death-during-observation hook (1 PR).** Modificar el server action que inserta `death_recorded` para auto-cerrar la observación. Tests.

**Fase 6 — Govt/admin surfaces (1 PR, depende de admin page Fase 0).** `/gob/incidentes`, `/gob/observaciones`, `/admin/observaciones`. Hasta que admin page Fase 0 mergee, los bite reports notifican a admin via fallback.

**Total estimado:** ~5-6 PRs chicos, ~3-4 días de trabajo.

## 11. Lo que NO está en este diseño

- **Atestación profesional de la observación**: la ley dice "in situ o en sede oficial". DIM no diferencia operativamente — el dueño hace observación en su casa, el govt no audita físicamente. Si llega el momento de integrar con dispensarios antirrábicos reales (Instituto Pasteur, dispensario PBA), el campo `location` del schema lo soporta
- **Vaccination follow-up**: si la observación cierra negativa, eso no implica que la antirrábica esté al día. Lo dejamos como respuesta separada — el dueño tiene que revisar `vaccination_administered` con vencimiento y agendar la próxima
- **Reporte a sistemas externos** (SIVILA, Pasteur, SISA-Salud): manual por ahora. El govt que recibe la notificación tiene que cargar el caso en sus sistemas. Integración API es futuro
- **Multi-bite incidents** (un perro muerde a múltiples víctimas en un solo evento): por ahora un `bite_inflicted` event por víctima. Si emerge un patrón, podemos agregar grouping después
- **Cuarentena vs observación**: son cosas distintas legalmente. La cuarentena es preventiva sin signo clínico; la observación es post-evento. DIM cubre observación. Cuarentena queda para futuro
- **Apelación / disputa del bite report**: si el owner cree que es falso, no hay flow formal. Puede contactar al govt offline. La nota_added event puede capturar la disputa pero el bite_inflicted queda en el log inmutable
- **Búsqueda de víctima dentro de DIM**: si la víctima es otro pet DIM, sí — link explícito. Si es humana con cuenta DIM (dueño de otra mascota), NO se hace cross-match. Privacy too sensitive
- **Análisis epidemiológico cross-pet**: dashboards de govts viendo "rate de bites por barrio" es feature futuro de los `/gob/dashboards` cuando se construyan
- **Re-observation** si el animal muerde a otro humano dentro del período: edge case, lo dejamos abierto. Probablemente extiende el período actual

---

## Próximo paso

Cuando este diseño tenga OK, el plan ejecutable lo escribo siguiendo el formato de los otros planes. 6 fases secuenciales con dependencias claras. Total ~3-4 días.

Si querés ajustar antes del plan:
- Duración del período (10 días vs configurable por jurisdicción)
- Severity de la notification al owner cuando hay escalation (urgent vs warning)
- Si se permite owner-self-cierre antes de los 10 días con justificación (no recomendado)
- Si el `bite_inflicted` debería poder cargarse retroactivamente (e.g., mordida de la semana pasada que se acuerda ahora) — por ahora SÍ, con disclaimer
- Catálogo de severity (leve/moderada/grave) — definiciones por tooltip

Decímelo antes y lo reflejo. Cambiar después del plan cuesta más.
