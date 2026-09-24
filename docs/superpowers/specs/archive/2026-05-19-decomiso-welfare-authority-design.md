> **IMPLEMENTED / shipped** — This spec has been fully implemented. The decomiso flow is live via `shelter_intake_recorded(intake_reason='seizure')` + case `custody_episode` lifecycle + welfare-officer queue at `/gob/maltrato`. Archived for historical reference only.

# Decomiso (Ley 14.346) → temporary welfare-authority custody → refugio chain — design spec

> Cuando una autoridad sanitaria municipal o un govt office (CABA: comuna, PBA: dispensario antirrábico) ejecuta un **decomiso** de un animal por violación de Ley 14.346 (malos tratos / actos de crueldad) u otras causales legales, hoy no hay flow en MiMAR — solo schema básico (`shelter_intake_recorded(intake_reason='seizure')`). Este spec abre la UI del lado autoridad: form de decomiso con motivo + adjuntos obligatorios + selección de refugio destinatario, materialización del intake event + activation del case_kind `custody_episode` (que estaba en deferred del lifecycles spec), y notification al refugio receptor.
>
> AGENTS.md lo lista explícito como open: *"Decomiso → temporary welfare-authority custody → refugio chain — Ley Nacional 14.346 seizures should flow through `custody_transferred` events with a municipal welfare authority holding `shelter_custody` briefly before transferring to a refugio."*
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** sistema de casos (`2026-05-19-cases-event-attachment-design.md` + `2026-05-19-cases-lifecycles-design.md`). Activa `custody_episode` case_kind del set deferred. Pega bien con `2026-05-19-org-abuse-investigation-design.md` (decomiso a veces es outcome de welfare investigation).

---

## 1. Por qué este documento existe

Tres realidades que el flow actual no cubre:

1. **El decomiso es acción del Estado, no de un refugio.** Una clínica vet puede REPORTAR maltrato (cubierto por org-abuse-investigation spec), pero el decomiso físico (incautar el animal) lo hace una autoridad: municipal welfare officer, fiscalía MPF CABA, comuna con oficial sanitario. El sistema necesita un canal con identidad de la autoridad.
2. **El receiver final es un refugio**, pero hay un **paso intermedio**: la autoridad usualmente mantiene custodia "técnica" muy breve (horas / 1-2 días) mientras coordina con un refugio. Esa transición debe ser auditable.
3. **Adjuntos son evidencia legal**, no decorativo. Fotos del estado del animal, acta de procedimiento, oficio judicial si aplica — sin esto el decomiso queda como afirmación sin sustento, lo cual no sirve para el pipeline post-decomiso (fiscalía, sanción al dueño previo).

El spec materializa todo esto reusando el patrón cases-system + el event `shelter_intake_recorded` que ya existe.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| DC1 | **Solo govt scope-matching + admin** pueden iniciar decomiso. Capability `welfare.decomiso.execute` granted automáticamente a `role='govt'` (todos los govt accounts) y `role='admin'`. NO se otorga a clinics / refugios — ellos pueden detectar y reportar (org-abuse-investigation spec) pero el decomiso es acción del Estado | Apego al marco legal — Ley 14.346 + decomiso administrativo es facultad del Estado. Refugio que decomisa por su cuenta = robo de animal |
| DC2 | **Si el subject es una `registered_pet`**, el decomiso requiere **doble confirmación** (modal explícito + segundo click). Razón: una pet registrada tiene un owner identificado que pierde custodia legal — UI debe asegurar intención clara | Coherencia con custody_dispute spec D5 — cambios de ownership por orden estatal son sensibles |
| DC3 | **Subject puede ser `registered_pet` o `unowned_animal`**. Mayoría de decomisos son sobre unowned/stray con dueño desconocido; pero el caso "decomiso de pet con owner identificado" también ocurre (alguien tiene un perro como mascota y comprobaron maltrato severo) | Polymorphism cubre los dos casos reales |
| DC4 | **Motivo obligatorio**, enum cerrado + opcional notes: `maltrato_fisico | abandono_extremo | acumulacion | trafico | sin_refugio_critico | pelea_de_perros | otro` (mismo set que `welfareReportKindEnum` excepto generalizado un poco) + opcional `judicial_proceeding_reference` (string libre del expediente legal) + opcional link a `welfare_report.id` que originó el decomiso | Trazabilidad. Cada decomiso tiene contexto legal mínimo |
| DC5 | **Adjuntos OBLIGATORIOS — mínimo 2 archivos**: 1 foto del animal + 1 documento (acta administrativa o screenshot del oficio judicial). Max 10 archivos, max 25MB cada uno (mismo límite que welfare attachments) | Evidence. Sin adjuntos, decomiso es palabra contra palabra |
| DC6 | **Selección de refugio destinatario obligatoria** al momento del decomiso. Combobox sobre `organizations` con `org_type IN ('shelter', 'rescue_network')` + `verified=true` + jurisdiction matching priority. El sistema sugiere refugios de la misma jurisdicción primero, opciones cross-jurisdicción visibles pero secundarias | El "limbo" entre decomiso y refugio se minimiza desde el start. Refugio receptor decide aceptar o rechazar |
| DC7 | **El decomiso ABRE 2 `ownerships` simultáneos atómicamente**: (a) row de `shelter_custody` para la welfare authority (govt org) — short-lived, marcada con flag `is_transitional=true` (nuevo campo opcional) o usando un role nuevo `pending_transfer`, (b) row de `shelter_custody` propuesto para el refugio destinatario, pendiente de su accept | Refleja la realidad: la authority tiene custody legal pero el refugio físico es el destino. Si el refugio rechaza, la pet queda con la authority (caso operativo del govt) |
| DC8 | **El refugio destinatario tiene 7 días para aceptar/rechazar** (más corto que cross-org de 30 días — el decomiso es urgente, no tiene sentido dejar al animal en limbo govt-side por semanas). Cron `/api/cron/expire-decomiso-handoffs` cierra los pending automáticamente con escalation al govt para resolución manual | Sensibilidad del caso. 7 días es razonable para que el refugio decida + organice cama |
| DC9 | **Si el refugio rechaza** → la pet queda en custodia oficial de la authority. La authority tiene UI para reasignar a otro refugio (nuevo handshake). Si pasan N rechazos sin destinario, escalation visible al admin nacional | Realismo. A veces ningún refugio tiene cama. El govt no puede tirar la pet a la calle |
| DC10 | **`custody_episode` case_kind se ACTIVA** (estaba en deferred del lifecycles spec). El decomiso abre un `custody_episode` con `opened_by_organization_id=govt`. Cuando el refugio acepta, cascade: cierra el episode del govt + abre el del refugio. Ver lifecycle detail abajo | Coherencia con cases system. El custody_episode envuelve el período entero "esta pet está en custody temporal" |
| DC11 | **`shelter_intake_recorded` se emite UNA VEZ por la authority** (el momento físico del decomiso). El handoff govt→refugio NO emite otro intake — emite `custody_transferred` (mismo patrón que cross-org transfer) | Single intake por episode de custody. Transfers internos del episode son custody_transferred events |
| DC12 | **Bridge con welfare_report** opcional: si el decomiso surge de un welfare_report previo (org-abuse-investigation o public denuncia), el form acepta `originating_welfare_report_id`. Se persiste en el payload del intake event + en el case `welfare_denuncia` se inserta un `note_added(category='system', text='Devino en decomiso, ver case CAS-XXXX')` para mantener trazabilidad cruzada | Coherencia entre cases. El reporte original que llevó al decomiso queda conectado |
| DC13 | **Public credential del pet decomisada** durante el período post-decomiso muestra disclaimer: "Esta mascota está bajo custodia oficial. Para información, contactá [authority]." NO se exponen datos del dueño previo. La pet queda Tier 0 con info limitada hasta finalización | Privacy del dueño previo (a quien le quitaron la pet) + transparencia del proceso al público |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Decomiso** | Incautación física del animal por la autoridad estatal por causales legales (maltrato severo, abandono extremo, etc.) |
| **Welfare authority** | Org con `org_type='sanitary_authority'` o user con `role='govt'` con jurisdiction scope que ejecuta el decomiso |
| **Transitional custody** | El período entre decomiso físico y handoff al refugio. La authority sostiene custodia legal — el animal puede estar físicamente en sede oficial, dispensario, o ya con el refugio en proceso de aceptar |
| **Handoff** | El acto del refugio aceptando custody. Materializa el `custody_transferred` event y cierra el episode del govt |
| **Originating welfare_report** | El report previo que llevó al decomiso (opcional — algunos decomisos son flagrantes sin report previo) |

---

## 4. Domain model

### 4.1 Activar `custody_episode` case kind

Update `lib/case-kinds.ts` (cuando el sistema de casos esté implementado):

```ts
export const V1_CASE_KINDS: readonly CaseKind[] = [
  // ... existing
  'custody_episode',  // ← activate from deferred
];
```

### 4.2 Lifecycle del `custody_episode` — addendum al lifecycles spec

(Esta sección se inserta como §13 del lifecycles spec.)

#### 13.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'` (mayoría) o `'unowned_animal'` (algunos casos de decomiso de stray sin previa registración).
- UNIQUE: a lo sumo 1 `custody_episode` open por `(primary_pet_id, opened_by_organization_id)`. Pet puede tener N episodes consecutivos (cada handoff cierra uno + abre otro) pero no paralelos del mismo holder.

#### 13.2 Estados y phases

`status` admitido: `open`, `closed`.

Phases:

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `intake_pending_acceptance` | `status='open'` Y existe `shelter_intake_recorded` Y se está esperando accept del refugio destinatario | Decomiso recién emitido, refugio aún no aceptó |
| `active_in_custody` | `status='open'` Y el handoff ya ocurrió → este episode es del refugio nuevo (NO el del govt original — ese ya cerró) | Refugio cuidando |
| `closed_handoff_completed` | `status='closed'` Y closed_reason='resolved' Y existe `custody_transferred` que cerró el episode | Handoff ok |
| `closed_to_adoption` | `status='closed'` Y closed_reason='resolved' Y existe `adoption_finalized` que cerró el episode | Pet adoptada |
| `closed_to_owner_return` | `status='closed'` Y closed_reason='resolved' Y existe `custody_transferred(to_role='owner')` (caso lost-and-found return) | Devuelta al owner |
| `closed_pet_died` | `status='closed'` Y closed_reason='cancelled' Y existe `death_recorded` cascade | Murió en custody |

#### 13.3 Apertura

Auto vía `shelter_intake_recorded` (modo `opens` del attachment spec §7.10). Para decomiso específicamente, el server action `executeDecomisoAction` (este spec) hace:

1. Validar govt/admin con capability + jurisdiction match.
2. openCase kind=`custody_episode`, primary_pet_id, primary_subject_kind, opened_by_user_id (govt user), opened_by_organization_id (govt org como sanitary_authority), opened_reason=`auto: decomiso reason={reason} judicial_ref={ref}`.
3. INSERT `shelter_intake_recorded` con case_id + payload extension.
4. Abre handshake con receiver refugio (similar al cross-org transfer pero originated by govt).

#### 13.4 Cierre

Triggered por uno de:

- `custody_transferred` (handoff al refugio destinatario, o de refugio a otro refugio)
- `adoption_finalized`
- `death_recorded` (cascade)
- Authority retira el decomiso (raro, requiere oficio judicial revocando): cancellation manual con `closed_reason='cancelled'`

#### 13.5 Cron expiry — `/api/cron/expire-decomiso-handoffs`

Schedule: cada 12h (más fino que daily, decomisos son urgentes).

Condición: `case_kind='custody_episode'` AND `opened_by_organization.org_type='sanitary_authority'` AND phase='intake_pending_acceptance' AND `opened_at < now() - 7 days`.

Acción: NO cierra el episode automáticamente. Solo emit notification escalation al govt actor + admin con "Decomiso sin refugio destinatario por >7 días". El govt resuelve manualmente (reasignar a otro refugio o mantener en custodia oficial).

#### 13.6 Visibility

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| govt_in_scope (authority originator) | ✅ | full | full | ✅ | ✅ |
| receiver org members (post handoff o pre como propuesta) | meta-only pre-accept; full post-accept | meta pre; full post | ✅ | ✅ | full post |
| subject_owner previo (dueño que perdió custody) | meta-only del decomiso (sabe que ocurrió + motivo curado); ❌ del paradero exact | redacted | reducido | ✅ | ❌ |
| admin | ✅ | full | full | ✅ | ✅ |
| anon | ❌ | ❌ | ❌ | ❌ | ❌ |

#### 13.7 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Decomiso ejecutado | subject_owner previo (si registered_pet) | `urgent` | `decomiso_owner_lost_custody` |
| Decomiso ejecutado | receiver org coordinators | `urgent` | `decomiso_handoff_proposed_receiver` |
| Decomiso ejecutado | govt actor (confirmation) + admin | `info` | `decomiso_confirmed_*` |
| Handoff accepted | govt + receiver | `success` | `decomiso_handoff_accepted_*` |
| Handoff rejected | govt | `info` | `decomiso_handoff_rejected_govt` |
| Cron expire >7d sin accept | govt + admin | `warning` | `decomiso_handoff_stale` |

---

### 4.3 Schema delta a `shelter_intake_recorded` payload

```ts
// lib/event-schemas.ts shelterIntakeRecorded
const shelterIntakeRecorded = z.object(withVersion({
  intake_reason: z.enum(['rescue', 'surrender', 'seizure', 'stray_found', 'other']),
  intake_condition: z.string().nullable(),
  rescue_jurisdiction: z.string().nullable(),

  // Nuevo para decomiso:
  seizure_motive: z.enum([
    'maltrato_fisico', 'abandono_extremo', 'acumulacion',
    'trafico', 'sin_refugio_critico', 'pelea_de_perros', 'otro',
  ]).nullable().optional(),
  seizure_motive_other_detail: z.string().nullable().optional(),
  judicial_proceeding_reference: z.string().nullable().optional(),
  originating_welfare_report_id: z.string().uuid().nullable().optional(),
  intended_receiver_organization_id: z.string().uuid().nullable().optional(),
})).strict()
.superRefine((p, ctx) => {
  if (p.intake_reason === 'seizure') {
    if (!p.seizure_motive) ctx.addIssue({ code: 'custom', message: 'seizure_motive required' });
    if (p.seizure_motive === 'otro' && !p.seizure_motive_other_detail) {
      ctx.addIssue({ code: 'custom', message: 'seizure_motive_other_detail required for otro' });
    }
    if (!p.intended_receiver_organization_id) {
      ctx.addIssue({ code: 'custom', message: 'intended_receiver_organization_id required for seizure' });
    }
  }
});
```

### 4.4 Capability `welfare.decomiso.execute`

```ts
// lib/capabilities.ts
// Granted automáticamente:
// - users con role='govt' (todos)
// - users con role='admin'
// NO se otorga a vet o owner.
```

### 4.5 Audit log

Agregar `AUDIT_LOG_ACTIONS`:

```ts
'decomiso_executed',
'decomiso_handoff_accepted',
'decomiso_handoff_rejected',
'decomiso_handoff_cancelled',
```

---

## 5. Server actions

### 5.1 `executeDecomisoAction` (nueva)

```ts
// app/actions/decomiso.ts (nuevo file)
export async function executeDecomisoAction(formData: FormData): Promise<DecomisoFormState> {
  const { user } = await requireUserOrRedirect();
  const caps = await getGrantedCapabilities(user.id);
  if (!caps.includes('welfare.decomiso.execute')) return { error: 'Capability requerida' };

  // Parse form
  const subjectKind = String(formData.get('subjectKind') ?? '');
  const subjectPetId = subjectKind === 'registered_pet' ? String(formData.get('subjectPetId')) : null;
  const subjectDescription = subjectKind !== 'registered_pet' ? String(formData.get('subjectDescription')) : null;
  const seizureMotive = String(formData.get('seizureMotive') ?? '');
  const seizureMotiveOtherDetail = formData.get('seizureMotiveOtherDetail') ? String(formData.get('seizureMotiveOtherDetail')) : null;
  const judicialRef = formData.get('judicialProceedingReference') ? String(formData.get('judicialProceedingReference')) : null;
  const originatingWelfareReportId = formData.get('originatingWelfareReportId') ? String(formData.get('originatingWelfareReportId')) : null;
  const receiverOrgId = String(formData.get('intendedReceiverOrganizationId') ?? '');
  const attachmentFiles = formData.getAll('attachments') as File[];
  // ... location, occurred_at, etc.

  // Validations
  if (attachmentFiles.length < 2) return { error: 'Mínimo 2 adjuntos requeridos (foto + acta)' };
  // ... más validations

  await db.transaction(async (tx) => {
    // 1. Resolve govt org (sanitary_authority del actor)
    const govtOrg = await resolveGovtOrgForUser(tx, user.id);
    if (!govtOrg) throw new Error('Actor sin govt org assignada');

    // 2. openCase custody_episode
    const [caseRow] = await openCase(tx, {
      kind: 'custody_episode',
      primarySubjectKind: subjectKind,
      primaryPetId: subjectPetId,
      jurisdictionCountry: 'AR',
      jurisdictionProvince: govtOrg.jurisdictionProvince,
      jurisdictionLocality: govtOrg.jurisdictionLocality,
      openedByUserId: user.id,
      openedByOrganizationId: govtOrg.id,
      openedReason: `auto: decomiso motivo=${seizureMotive} judicial_ref=${judicialRef ?? 'sin_ref'}`,
    });

    // 3. INSERT shelter_intake_recorded
    const [intakeEvent] = await tx.insert(petEvents).values({
      petId: subjectPetId,  // null si unowned
      caseId: caseRow.id,
      eventType: 'shelter_intake_recorded',
      payload: {
        intake_reason: 'seizure',
        intake_condition: notesAboutCondition,
        seizure_motive: seizureMotive,
        seizure_motive_other_detail: seizureMotiveOtherDetail,
        judicial_proceeding_reference: judicialRef,
        originating_welfare_report_id: originatingWelfareReportId,
        intended_receiver_organization_id: receiverOrgId,
      },
      occurredAt: new Date(),
      recordedByUserId: user.id,
      authorRole: 'govt',
      authorOrganizationId: govtOrg.id,
      authorVerified: true,
    }).returning();

    // 4. Si subjectKind='registered_pet': cerrar ownerships actuales (subject_owner pierde custody)
    if (subjectPetId) {
      await tx.update(ownerships)
        .set({ endedAt: new Date(), transferredFromId: null })
        .where(and(
          eq(ownerships.petId, subjectPetId),
          isNull(ownerships.endedAt),
        ));
    }

    // 5. INSERT new ownerships: shelter_custody for govt org (transitional)
    await tx.insert(ownerships).values({
      petId: subjectPetId,
      ownerOrganizationId: govtOrg.id,
      role: 'shelter_custody',
      startedAt: new Date(),
    });

    // 6. Upload attachments + link al event
    for (const file of attachmentFiles) {
      const path = await uploadAttachment(file, { eventId: intakeEvent.id, petId: subjectPetId });
      await tx.insert(attachments).values({
        eventId: intakeEvent.id,
        petId: subjectPetId,
        uploadedByUserId: user.id,
        storagePath: path,
        mimeType: file.type,
        fileSize: file.size,
      });
    }

    // 7. Trigger handshake con receiver org (similar al cross-org transfer)
    //    INSERT custody_transfer_proposed con custom payload "from_decomiso=true"
    await tx.insert(petEvents).values({
      petId: subjectPetId,
      caseId: caseRow.id,
      eventType: 'custody_transfer_proposed',
      payload: {
        from_organization_id: govtOrg.id,
        to_organization_id: receiverOrgId,
        reason: 'post_decomiso_assignment',
        from_decomiso: true,
        originating_intake_event_id: intakeEvent.id,
        proposed_at: new Date().toISOString(),
      },
      recordedByUserId: user.id,
      authorRole: 'govt',
      authorOrganizationId: govtOrg.id,
    });

    // 8. Si originating_welfare_report_id present, anotar cross-ref en ese case
    if (originatingWelfareReportId) {
      const [welfareReport] = await tx.select().from(welfareReports).where(eq(welfareReports.id, originatingWelfareReportId)).limit(1);
      if (welfareReport?.caseId) {
        await tx.insert(petEvents).values({
          petId: subjectPetId,
          caseId: welfareReport.caseId,
          eventType: 'note_added',
          payload: {
            category: 'system',
            scope: 'internal_govt',
            text: `Devino en decomiso. Ver case ${caseRow.publicCode} de custody_episode.`,
          },
          authorRole: 'system',
        });
      }
    }

    // 9. Notifications
    // Subject owner (si registered_pet)
    if (subjectPetId) {
      const previousOwners = await getPreviousOwnersBeforeDecomiso(tx, subjectPetId, intakeEvent.id);
      for (const owner of previousOwners) {
        await emitCaseNotification('decomiso_owner_lost_custody', { directly: [owner.userId] }, {
          related_case_id: caseRow.id, related_pet_id: subjectPetId,
          vars: { authority_name: govtOrg.displayName, motive_curated: getMotiveLabel(seizureMotive), judicial_ref: judicialRef },
        });
      }
    }
    // Receiver org coordinators
    await emitCaseNotification('decomiso_handoff_proposed_receiver', {
      orgCoordinatorsOf: receiverOrgId,
    }, { related_case_id: caseRow.id, vars: { authority_name: govtOrg.displayName, expiry_days: 7 } });
    // Govt confirmation
    await emitCaseNotification('decomiso_confirmed_govt', { directly: [user.id] }, { related_case_id: caseRow.id });

    // 10. Audit log
    await tx.insert(auditLog).values({
      actorUserId: user.id,
      action: 'decomiso_executed',
      payload: {
        caseId: caseRow.id,
        petId: subjectPetId,
        govtOrgId: govtOrg.id,
        receiverOrgId,
        seizureMotive,
        judicialRef,
      },
    });
  });

  redirect('/gob/decomisos');
}
```

### 5.2 `acceptDecomisoHandoffAction` (nueva)

Mismo patrón que `acceptCrossOrgTransferAction` del cross-org transfer spec — receiver org member con capability `org.transfer.accept` acepta. Materializa `custody_transferred(from_role='shelter_custody', to_role='shelter_custody', from_organization_id=govt, to_organization_id=receiver)` + ownerships flip + close del custody_episode del govt + apertura del custody_episode del receiver.

### 5.3 `rejectDecomisoHandoffAction` y `reassignDecomisoToAnotherReceiverAction`

- Rejection: emit `note_added(category='rejection')` con motivo, close del handshake como cancelled. Pet queda en transitional custody del govt. Notif al govt para resolución.
- Reassign: govt action — close el handshake actual con rejection, abre uno nuevo a otra org. Capability check + audit.

---

## 6. UX — Govt side

### 6.1 Entry point

`/gob/decomisos/nuevo` (route nueva).

Alternativa: desde `/gob/maltrato/[code]` (detail de una welfare denuncia) → action "Iniciar decomiso a partir de esta denuncia" (preload `originating_welfare_report_id` y subject).

### 6.2 Form de decomiso

```
Iniciar decomiso · {govt_org.name} ({jurisdiction})

⚠ Esta acción transfiere la custodia legal del animal desde su dueño previo
   (si está registrado) hacia esta autoridad sanitaria. Es acción jurídica.

[Sujeto del decomiso]
  ( ) Mascota registrada en MiMAR
      → search/select pet por microchip / DIM token / nombre / dueño
  ( ) Animal sin registrar
      → descripción detallada (species, sex, age, breed, color, marcas)

[Motivo del decomiso]
  ( ) Maltrato físico
  ( ) Abandono extremo
  ( ) Acumulación
  ( ) Tráfico
  ( ) Sin refugio crítico
  ( ) Pelea de perros
  ( ) Otro
  [Detalle del motivo "Otro"] textarea (req si "Otro")

[Detalle del estado del animal] textarea (intake_condition)

[Referencia del expediente judicial] text opcional
  (carátula + juzgado + nº si existe)

[Reporte previo que originó esto] dropdown opcional
  (lista de welfare_reports recientes en jurisdicción del govt)

[Refugio destinatario] combobox OBLIGATORIO
  → orgs verified con org_type IN ('shelter', 'rescue_network')
  → priority: orgs en misma jurisdicción
  → muestra: name + verified + jurisdiction + count pets actuales

[Ubicación del decomiso]
  address + map pin

[Cuándo ocurrió] datetime (default: now)

[Adjuntos OBLIGATORIOS]
  - Foto del animal (1+)
  - Acta administrativa (1+)
  - Otros documentos opcionales
  Max 10 archivos, 25MB c/u
  [file picker]

⚠ DOBLE CONFIRMACIÓN: al enviar este form se ejecuta el decomiso.
   Si el sujeto es registered_pet, el dueño previo recibirá notificación
   inmediata. La acción no es reversible — para revertir requiere oficio
   judicial nuevo.

[Cancelar] [Ejecutar decomiso] ← este botón abre modal de confirmación
```

Modal de confirmación (DC2):

```
Confirmar decomiso

Estás por ejecutar el decomiso de:
  {pet.name si registered_pet, o descripción si unowned}

Motivo: {motive_label}
Destinatario: {receiver_org.name}

¿Estás seguro?

[Cancelar] [Sí, ejecutar decomiso]
```

### 6.3 Dashboard `/gob/decomisos`

Lista de decomisos ejecutados por el govt actor / su org / su scope (según role):

| Código | Pet/Sujeto | Motivo | Destinatario | Status | Días | Acción |
|---|---|---|---|---|---|---|
| CAS-XK3P | 🐕 Roco | Maltrato físico | Refugio Patitas | Esperando accept | 2 | [Ver] [Reasignar] |
| CAS-9DLM | Sin registrar | Acumulación | El Campito | Aceptado (2024-05-10) | — | [Ver] |
| CAS-PLMX | 🐕 Negra | Abandono extremo | Refugio Belgrano | Rechazado | — | [Ver] [Reasignar] |
| CAS-YBTR | Sin registrar | Pelea de perros | Refugio Tres Patas | Expired sin response | — | [Ver] [Reasignar URGENTE] |

Filtros: por status, por motivo, por receiver, por date range.

### 6.4 Detail page del decomiso

`/gob/decomisos/[publicCode]` reusa el `/casos/[publicCode]` (es un case). Action adicional govt-side: "Reasignar a otro refugio" cuando handoff pending o rejected.

---

## 7. UX — Receiver side

Reusa la inbox de `/org/[orgToken]/transferencias/recibidas` del cross-org transfer spec. Para diferenciar visualmente que un handoff viene de decomiso (govt) vs cross-org civil:

- Badge "DECOMISO" rojo prominent en la row.
- Detail muestra "Reportado por autoridad: {govt_org.name}" + jurisdiction.
- Motivo del decomiso visible.
- Adjuntos del decomiso accesibles read-only durante review (transparencia con receiver).

Accept/Reject actions usan los mismos endpoints conceptuales pero diferenciados:

- `acceptDecomisoHandoffAction` vs `acceptCrossOrgTransferAction` — porque las cascades difieren (decomiso cierra el custody_episode del govt, no el de otra org).

---

## 8. UX — Subject owner previo (si registered_pet)

El dueño previo (que perdió custodia) recibe notification urgent al momento del decomiso:

```
title: Custodia oficial transferida
body: La autoridad sanitaria {govt_name} ejecutó un decomiso sobre tu mascota
      {pet.name} el {date}. Motivo: {motive_curated}.
      {if judicial_ref: Referencia judicial: {judicial_ref}.}
      Para más información o para iniciar reclamo, contactá a la autoridad
      sanitaria de tu jurisdicción.
ctaLabel: Información oficial
ctaUrl: {url_a_info_publica_govt}
```

El owner previo NO ve los detalles internos del case (decomiso es scope govt/admin), solo el aviso. Si quiere reclamar, lo hace por canal externo (oficio, abogado) — no vía MiMAR.

El public credential del pet decomisada (`/p/[publicToken]`) muestra el disclaimer del DC13.

---

## 9. Tests

```ts
// __tests__/decomiso-flow.test.ts
it('govt con jurisdiction match puede ejecutar decomiso');
it('govt fuera de jurisdiction RECHAZADO');
it('admin puede ejecutar decomiso en cualquier jurisdiction');
it('vet / owner / refugio NO pueden ejecutar decomiso');
it('decomiso con adjuntos < 2 falla');
it('decomiso sin intended_receiver_organization_id falla');
it('decomiso con motive=otro sin motive_other_detail falla');
it('decomiso sobre registered_pet: ownerships del owner previo cerrados + nuevo shelter_custody de govt creado');
it('decomiso sobre unowned: solo new ownership de govt + intake event con pet_id=NULL');
it('originating_welfare_report_id linked: cross-ref note en case del welfare denuncia');
it('handshake con receiver propuesto + notif al receiver');
it('subject owner previo notified urgent');
it('audit log decomiso_executed populated');

// __tests__/decomiso-handoff.test.ts
it('receiver acepta → custody_transferred + ownerships flip + custody_episode govt cerrado + nuevo custody_episode receiver abierto');
it('receiver rechaza → handshake closed cancelled + pet queda en custody govt + notif govt');
it('cron expira 7d sin accept → notif escalation, NO auto-close del case');
it('govt reasigna a otro receiver tras rejection → handshake nuevo + previous closed');
```

---

## 10. Open questions

- **Owner previo reclama vía MiMAR (futuro)** — agregar form "Reclamar este decomiso" en pet profile cuando user es subject_owner previo. Defer — requiere coordinación con sistema legal externo.
- **Soporte para decomiso múltiple en operativo** (e.g., el govt entra a un caso de hoarding y decomisa 30 animales): batch UI sería útil. Defer a v1.1, scope creep para v1.
- **Welfare authority sin org formal** — algunos comunas tienen oficiales sanitarios pero no están modeladas como `organizations`. Workaround temporal: crear org con `org_type='sanitary_authority'` para esa comuna. Defer institutional onboarding.
- **Cross-jurisdicción decomiso → handoff** — govt CABA decomisa, asigna a refugio Mendoza. Implica movimiento físico inter-provincial — SENASA tiene reglas de traslado para algunas species/condiciones. Spec no bloquea, asume cumplimiento operativo del govt.
- **Refugio destinatario con custody actual del pet** — caso edge: el animal ya estaba en custody del refugio target via foster, ahora govt formaliza decomiso. ¿La cascade es clean? Sí — el ownership previo del refugio se cierra + nuevo se abre con role shelter_custody (post-decomiso). Audit muestra ambos.

---

## 11. Out of scope

- **Quarantine post-decomiso** — algunos casos requieren cuarentena sanitaria (e.g., observación de zoonosis sospechada). Workflow específico no acá; piggyback de rabies observation si aplica.
- **Sanción al dueño previo** — el decomiso es solo el aspecto físico. Sanciones legales / multas son pipeline judicial externo, no MiMAR.
- **Auto-decomiso por hoarding alerta** — defer. v1 todo decomiso es manual human-triggered.
- **Bulk decomiso UI** — defer a v1.1.

---

## 12. Implementation outline (para plan ejecutable post-OK)

1. **Fase 1** — Capability `welfare.decomiso.execute` + schema delta (shelter_intake_recorded payload extension + audit_log actions). ~½ día.
2. **Fase 2** — Activate `custody_episode` case_kind en lifecycles + lifecycle spec addendum. ~½ día.
3. **Fase 3** — `executeDecomisoAction` + helpers (resolveGovtOrgForUser, getPreviousOwnersBeforeDecomiso, upload attachments). ~2 días.
4. **Fase 4** — `acceptDecomisoHandoffAction`, `rejectDecomisoHandoffAction`, `reassignDecomisoToAnotherReceiverAction`. ~1 día.
5. **Fase 5** — Cron `/api/cron/expire-decomiso-handoffs`. ~½ día.
6. **Fase 6** — UI: `/gob/decomisos/nuevo`, `/gob/decomisos`, detail. Reuse de `/org/[orgToken]/transferencias/recibidas` extendido para decomiso. ~2 días.
7. **Fase 7** — Public credential disclaimer (DC13) + notif owner previo. ~½ día.
8. **Fase 8** — Tests. ~1 día.

Total ~7-8 días. Depende de sistema de casos implementado + cross-org transfer UX (para reuso del receiver flow).
