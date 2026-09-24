> **IMPLEMENTED / shipped** — This spec has been fully implemented. Org-sourced welfare reports with elevated priority are handled in `src/modules/welfare/actions.ts` and surfaced in the `/gob/maltrato` queue. Archived for historical reference only.

# Org abuse investigation — flagged higher for admins — design spec

> Cuando una organización verificada (clínica, refugio, rescue network, sanitary_authority) detecta un caso de maltrato durante su operativa profesional, debería poder reportarlo a través de un flujo dedicado que (a) levanta automáticamente la severity, (b) populates `reporter_organization_id` para audit + priority sort, (c) trigger notification inmediata urgent al govt scope + admin, (d) aparece arriba en `/gob/maltrato` queue. Estos reports son cualitativamente distintos del flow anon / autenticado-individual porque vienen con contexto profesional verificable.
>
> NO crea case_kind nuevo — sigue siendo `welfare_denuncia` pero con metadata adicional que lo prioriza. NO crea welfare_reports table separada — extiende la existente.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** `welfare_reports` table existente, sistema de casos (`welfare_denuncia` case_kind del lifecycles spec §7).

---

## 1. Por qué este documento existe

Hoy `app/actions/welfare.ts` tiene un único entry point `createWelfareReportAction` que sirve para todo el mundo (anon, autenticado civil, govt manual). Esto significa:

- Una clínica veterinaria que recibe un perro con signos claros de maltrato físico (heridas múltiples, cicatrices, malnutrición severa) **no tiene canal diferenciado**. El vet debe entrar al form genérico de `/denuncias/nueva` y "competir" en la queue triage con denuncias anon de barrios.
- El sistema **no puede priorizar** automatic: el `severity` es elegido por el reporter en el form, y un anon spam puede marcarse `critical` (será filtrado por moderation, pero hasta entonces queda en pool).
- El govt que mira `/gob/maltrato` (cuando exista) **no distingue** "esto vino de Vet Patitas hace 2 horas" vs "esto es anon DEN-XK3P". Pierde context valioso para triage.

Tres problemas concretos derivados:

1. **Pérdida de tiempo del welfare officer**: triage parejo de fuentes muy distintas.
2. **Riesgo operativo**: casos verdaderamente urgentes (animal con vida en peligro inmediato) reportados por professional pueden esperar días en queue cuando deberían triagearse en horas.
3. **Bajada de adopción del flow por orgs**: una clínica que sabe que su report va al pool genérico puede sentirse desincentivada a usar MiMAR vs. llamar directo al Min. Salud / fiscalía.

Este spec abre el canal dedicado: org members con la capability `welfare.report` (granted automáticamente a TODA la org) emiten reports que entran al sistema con priority + identidad de la org.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| OA1 | **Capability `welfare.report` granted AUTOMÁTICAMENTE a TODA la org** (org_memberships con left_at IS NULL) — no requiere grant individual. La verified-ness de la org es el gate; cualquier member representa institucionalmente | Decisión explícita del producto. Una clínica vet con 5 staff: los 5 pueden emitir. Si la org abusa de la capability, admin puede revocar globalmente |
| OA2 | **Severity auto-override a `'critical'`** si el reporter es org member con capability. El form muestra el slider de severity como reference pero el server action lo IGNORA y setea `'critical'` siempre. Razón explícita en UI: "Tu rol profesional eleva automáticamente la prioridad del reporte" | El profesional califica info-quality vía su rol. Si el caso es realmente menor, el welfare officer post-triage puede bajarlo. Default seguro: assume critical |
| OA3 | **`welfare_reports.reporter_organization_id`** nueva columna FK opcional. Cuando populated → es un org-side report. UI distingue visualmente con badge "Reportado por [Org]" | Audit + priority sort + identity en queue |
| OA4 | **Notif inmediata urgent** al disparo del report (NO espera el daily digest, NO espera moderation). Destinatarios: todos los govt en jurisdiction + todos los admins. Severity max | Critical reports merecen attention real-time. Anon spam queda en el flow regular con moderation; org-side bypass-de-moderation porque la org es accountable |
| OA5 | **Auto-attach al `welfare_denuncia` case** (modo `opens` per attachment spec §7.10). El case se abre simultáneamente al welfare_report INSERT, igual que el flow normal. La diferencia: el `case.opened_reason='auto: org-side welfare report by {org.name}'` queda explícito | Coherencia con el cases system. Sin código nuevo en el cases system; solo el opened_reason describe el origen |
| OA6 | **Priority sort en `/gob/maltrato` queue**: org-side reports (con `reporter_organization_id` populated) arriba, después por severity desc, después por created_at asc. Visualmente el badge "Reportado por [Org]" es distintivo | Heuristic explícita. Sin algorithm complex; ordering simple por flag |
| OA7 | **Org-side reports NO pasan por moderation** (a diferencia de los anon que pueden ser auto-flagged spam). La org es accountable; un report falso tiene implicancias legales para la org | Trust ya escalonado por verified-ness. Moderation queue queda para anon path |
| OA8 | **Bridge events (maltreatment_reported, abandonment_reported, symptom_observed)** se emiten igual que en el flow normal cuando subject is registered_pet. Single diff: `author_role='shelter'` (o `'vet'`) + `author_organization_id` populated en el event payload | Coherencia con el welfare normal. Bridge events son source-of-truth en libreta del pet (cuando subject=registered_pet) |
| OA9 | **Multi-org corroboration boost**: si una pet ya tiene un welfare_denuncia open Y otra org distinta agrega su propio report, el case se marca como "multi-source" en metadata (note_added system) + escalation visible adicional al govt. NO se crea segundo case (one case per (pet, kind)) | Múltiples orgs viendo el mismo case = señal fuerte de que es real. Worth highlighting |
| OA10 | **El "Subject" puede ser registered_pet O unowned_animal O location** — mismo polymorphism que el form public. La org puede reportar un pet ajeno que vio en una calle del barrio, no solo sobre pets en su custodia | Consistencia. Las orgs pueden ver maltrato en cualquier subject; la diff es la identidad del reporter, no del subject |
| OA11 | **Capability NO transitive a fosters individuales**: solo org_memberships con left_at IS NULL Y rol IN ('admin', 'coordinator', 'member', 'vet_individual'). NO 'volunteer', NO 'foster' (porque estos suelen ser personas externas con menos accountability institucional) | Trust granular. Foster es persona física que la org "presta" su umbrella legal — no necesariamente representa institucionalmente |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Org-side report** | `welfare_reports` row con `reporter_organization_id` populated. Distinto del flow anon o autenticado-individual |
| **Capability `welfare.report`** | Habilita el flow org-side. Auto-granted a org members con role IN ('admin', 'coordinator', 'member', 'vet_individual') |
| **Priority sort** | Order en `/gob/maltrato` queue: (a) org-side reports first, (b) severity desc, (c) created_at asc |
| **Multi-source escalation** | Cuando 2+ orgs distintas reportan sobre el mismo welfare_denuncia case |
| **Trust ladder** | El system trustea según verified-ness: anon < authenticated civil < authenticated org member of verified org |

---

## 4. Domain model

### 4.1 Schema delta a `welfare_reports`

```ts
// db/schema.ts welfareReports
reporterOrganizationId: uuid('reporter_organization_id').references(() => organizations.id, { onDelete: 'set null' }),
```

Migration:

```sql
alter table welfare_reports add column reporter_organization_id uuid
  references organizations(id) on delete set null;
create index welfare_reports_org_reporter_idx
  on welfare_reports (reporter_organization_id)
  where reporter_organization_id is not null;
```

Sin CHECK constraint adicional — la combinación de `reporter_user_id`, `reporter_organization_id`, ambos null (anon), uno solo (civil o org-via-user), o ambos (anon-with-org? no aplica) ya está permitida.

### 4.2 Capability check

Capability `welfare.report` debe definirse si no existe en `lib/capabilities.ts`. Resolver:

```ts
// lib/capabilities.ts
export async function getGrantedCapabilities(userId: string): Promise<Capability[]> {
  const caps: Capability[] = [];
  // ... existing logic for vet.clinical_write, bite.report, etc.

  // welfare.report — automatic if user has active membership in verified org
  const orgMemberships = await db
    .select({ orgId: organizationMemberships.organizationId, role: organizationMemberships.role })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(
      eq(organizationMemberships.userId, userId),
      isNull(organizationMemberships.leftAt),
      eq(organizations.verified, true),
      inArray(organizationMemberships.role, ['admin', 'coordinator', 'member', 'vet_individual']),
    ));
  if (orgMemberships.length > 0) caps.push('welfare.report');

  return caps;
}
```

(Si ya hay otro pattern de capability resolution en el código, adaptarlo.)

### 4.3 Sin case_kind nuevo

`welfare_denuncia` ya existe. El cases system §7 lo cubre. La única diff es metadata adicional en el case + el welfare_report.

### 4.4 Audit log actions

Agregar a `AUDIT_LOG_ACTIONS` (`db/schema.ts`):

```ts
'welfare_report_submitted_by_org',
```

Para distinguir del `'welfare_report_submitted'` que cubre el flow anon/civil.

---

## 5. Server action

### 5.1 `createOrgWelfareReportAction` (nuevo)

```ts
// app/actions/welfare.ts (extender)
export async function createOrgWelfareReportAction(
  orgToken: string,
  formData: FormData,
): Promise<WelfareReportFormState> {
  // 1. Verificar user autenticado con capability welfare.report
  const { user } = await requireUserOrRedirect();
  const caps = await getGrantedCapabilities(user.id);
  if (!caps.includes('welfare.report')) {
    return { error: 'Capability welfare.report requerida' };
  }

  // 2. Verificar user es member of org con orgToken
  const [org] = await db
    .select()
    .from(organizations)
    .innerJoin(organizationMemberships, eq(organizationMemberships.organizationId, organizations.id))
    .where(and(
      eq(organizations.publicToken, orgToken),
      eq(organizationMemberships.userId, user.id),
      isNull(organizationMemberships.leftAt),
    ))
    .limit(1);
  if (!org) return { error: 'No sos miembro activo de esta organización' };

  // 3. Parse form (mismo set de fields que createWelfareReportAction)
  const kind = String(formData.get('kind') ?? '').trim();
  // ... parsing similar al action existente, pero con auto-override de severity

  // 4. OVERRIDE severity to 'critical' (OA2)
  const severity: WelfareReportSeverity = 'critical';

  // 5. Resolve subject (registered_pet | unowned_animal | location | general)
  const subjectKind = String(formData.get('subjectKind') ?? '').trim();
  // ... resolución

  await db.transaction(async (tx) => {
    // 6. INSERT welfare_reports con reporter_organization_id populated + reporter_user_id populated (no anon)
    const [report] = await tx.insert(welfareReports).values({
      referenceCode: await generateUniqueDenCode(tx),
      reporterUserId: user.id,
      reporterOrganizationId: org.id,
      kind,
      severity,  // forced critical
      description,
      subjectKind,
      subjectPetId,
      subjectDescription,
      // ... location, occurred_at, etc.
    }).returning();

    // 7. openCase welfare_denuncia (cascade del cases system §7)
    const [caseRow] = await openCase(tx, {
      kind: 'welfare_denuncia',
      primarySubjectKind: subjectKind,
      primaryPetId: subjectPetId,
      primaryLocationLat,
      primaryLocationLng,
      jurisdictionCountry,
      jurisdictionProvince,
      jurisdictionLocality,
      welfareReportId: report.id,
      openedByUserId: user.id,
      openedByOrganizationId: org.id,
      openedReason: `auto: org-side welfare report by ${org.displayName}`,
    });

    // 8. UPDATE welfare_reports.case_id
    await tx.update(welfareReports)
      .set({ caseId: caseRow.id })
      .where(eq(welfareReports.id, report.id));

    // 9. Bridge events si subject=registered_pet (igual que flow normal pero con author_organization_id)
    if (subjectKind === 'registered_pet' && subjectPetId) {
      await emitBridgeEvents(tx, {
        petId: subjectPetId,
        caseId: caseRow.id,
        kind,
        report,
        authorRole: 'shelter',
        authorOrganizationId: org.id,
      });
    }

    // 10. Multi-source check: hay welfare_denuncia abierto previo sobre la misma pet?
    if (subjectKind === 'registered_pet' && subjectPetId) {
      const existingCases = await tx
        .select()
        .from(cases)
        .where(and(
          eq(cases.primaryPetId, subjectPetId),
          eq(cases.caseKind, 'welfare_denuncia'),
          inArray(cases.status, ['open', 'escalated']),
          ne(cases.id, caseRow.id),  // exclude the one we just created
        ));
      if (existingCases.length > 0) {
        // Multi-source escalation: marcar el case original + emit note_added system
        const original = existingCases[0];
        await tx.insert(petEvents).values({
          petId: subjectPetId,
          caseId: original.id,
          eventType: 'note_added',
          payload: {
            category: 'system',
            scope: 'internal_govt',
            text: `Otra organización (${org.displayName}) reportó un caso adicional sobre esta mascota. Ver case ${caseRow.publicCode}. Múltiples fuentes elevan la prioridad.`,
          },
          recordedByUserId: null,
          authorRole: 'system',
        });
        // Notif urgent al govt+admin del case original
        await emitCaseNotification('welfare_multi_source_escalation', {
          governmentInScopeOf(original.jurisdictionLocality),
          adminAll(),
        }, { related_case_id: original.id });
      }
    }

    // 11. Notif inmediata urgent al govt scope + admin (OA4)
    await emitCaseNotification('welfare_org_side_critical_received', {
      governmentInScopeOf({ province, locality }),
      adminAll(),
    }, { related_case_id: caseRow.id, related_pet_id: subjectPetId, vars: { org_name: org.displayName, severity: 'critical' } });

    // 12. Notif al reporter (confirmación)
    await emitCaseNotification('welfare_org_side_confirmed_reporter', {
      directly: [user.id],
    }, { related_case_id: caseRow.id, vars: { case_code: caseRow.publicCode } });

    // 13. Audit log
    await tx.insert(auditLog).values({
      actorUserId: user.id,
      action: 'welfare_report_submitted_by_org',
      payload: {
        organizationId: org.id,
        organizationName: org.displayName,
        welfareReportId: report.id,
        caseId: caseRow.id,
        subjectKind,
      },
    });
  });

  redirect(`/org/${orgToken}/maltrato/recibidos`);
}
```

---

## 6. UX

### 6.1 Entry point — `/org/[orgToken]/maltrato/nuevo`

Ruta nueva. Form parecido al `/denuncias/nueva` público pero con:

- Pre-fill del `reporter_organization_id` (no editable, badge "Reportando como [Org name]").
- Severity slider visible pero con disclaimer "Como reporte profesional, tu denuncia se procesa con prioridad crítica automáticamente."
- Subject picker: registered_pet (con autocomplete sobre pets de la propia org primero, después abierto a search) | unowned_animal | location | general.
- Adjuntos OBLIGATORIOS (mínimo 1 photo) — la professional accountability requiere evidencia.
- Notas internas obligatorias.

```
Nueva investigación de maltrato

Reportando como: [Refugio Belgrano Animales]  ← read-only badge

[Tipo de maltrato]
  ( ) Abandono · ( ) Negligencia · ( ) Maltrato físico
  ( ) Encadenado · ( ) Sin refugio · ( ) Acumulación
  ( ) Pelea de perros · ( ) Tráfico · ( ) Otro

[Severity sugerida]
  slider Low ────────●─── Critical
  ℹ Como reporte profesional, se eleva automáticamente a Critical.

[Sujeto del reporte]
  ( ) Mascota registrada en MiMAR
      → combobox sobre pets (con prioridad a pets en custodia de esta org)
  ( ) Animal sin registrar
      → descripción opcional
  ( ) Una ubicación (no específico)
      → location picker
  ( ) General

[Ubicación]
  address + map pin (req cuando subject=location)

[Cuándo ocurrió] datetime
[Descripción del caso] textarea (min 100 chars)
[Adjuntos] file picker (min 1 photo, max 10)

⚠ Este reporte se procesa con prioridad crítica.
  Será notificado inmediatamente al govt {scope_jurisdiction} y al equipo admin.

[Enviar investigación]
```

### 6.2 Inbox de la org — `/org/[orgToken]/maltrato/recibidos`

Lista de los welfare_reports emitidos por la org (read-only del status):

| Código | Subject | Severity | Status | Fecha |
|---|---|---|---|---|
| DEN-XK3P | 🐕 Roco (pet registrada) | Critical | Triaged | hace 3 días |
| DEN-9DLM | Ubicación: Av. Corrientes 1234 | Critical | In progress | hace 2 semanas |

Click → case detail.

### 6.3 UI tweaks en `/gob/maltrato` queue

(Esta queue todavía no existe — está en el TODO operativo del welfare-officer queue. Cuando se construya, debe incluir):

- **Priority sort**: (1) org-side reports (`reporter_organization_id IS NOT NULL`) primero, (2) severity DESC, (3) created_at ASC.
- **Badge "Reportado por [Org]"** visible en cada row con `reporter_organization_id`.
- **Filter**: "Solo reports de organizaciones" toggle.
- **Detail view**: muestra el reporter_organization con link al perfil de la org + verified badge.

(El queue UI completo es scope del welfare-officer queue spec — este spec solo agrega las hooks visibles cuando aplica.)

### 6.4 Multi-source escalation

Cuando `welfare_multi_source_escalation` fires (OA9):

- Banner en el case detail original: "⚠ Esta investigación tiene reportes adicionales de otras organizaciones. Ver corroboraciones (N)."
- Click "Ver corroboraciones" → lista de los cases secundarios sobre la misma pet, ordenados por created_at desc.
- Govt + admin reciben notif urgent con "Multi-source escalation: [pet.name] tiene N reports de orgs distintas".

---

## 7. Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Org-side report submitted | govt scope-matching + admin | `urgent` | `welfare_org_side_critical_received` |
| Org-side report submitted | reporter (confirmation) | `info` | `welfare_org_side_confirmed_reporter` |
| Multi-source escalation | govt + admin del case original | `urgent` | `welfare_multi_source_escalation` |
| (transitions del case siguen el welfare_denuncia lifecycle normal del spec) | (per templates of welfare_denuncia) | various | `welfare_denuncia_*` |

---

## 8. Tests

```ts
// __tests__/org-welfare-report-flow.test.ts
it('org member con verified org puede emitir');
it('org member de unverified org rechazado');
it('user con role=volunteer NO puede emitir (OA11)');
it('user con role=foster NO puede emitir');
it('user sin org_memberships rechazado (no es el flow anon — el spec del anon va por createWelfareReportAction)');
it('severity del form override a critical');
it('reporter_organization_id populated en welfare_reports');
it('welfare_denuncia case open + welfare_report.case_id populated');
it('bridge events emitted con author_organization_id (cuando subject=registered_pet)');
it('notif urgent disparada al govt + admin inmediatamente');
it('multi-source: segundo org-side report sobre misma pet con welfare_denuncia open → emit note + notif al govt original');
it('audit log "welfare_report_submitted_by_org" emitted');

// __tests__/welfare-queue-priority.test.ts (cuando exista la queue)
it('org-side reports aparecen arriba en /gob/maltrato sort');
it('badge "Reportado por [Org]" visible en row');
```

---

## 9. Open questions

- **Org abusa de la capability** (emite N reports falsos): ¿qué mechanism de freno? Tendencia: admin puede revocar `verified=false` a la org (drástico pero efectivo) o lanzar `org.welfare_report.disabled=true` granular como capability deny. Defer al spec de admin governance.
- **Org reportando contra sí misma** (e.g., un coordinator denuncia abuso del director): bizarre but possible. Tendencia: NO bloquear — el spec del welfare flow tiene la atribución correcta (`reporter_user_id` específico) y el case detail muestra reporter individual + org. Si el caso es de abuse interno, lo va a ver govt + admin. Sin filtros.
- **Anonimato del reporter individual dentro de la org**: el coordinator que reportó figura por nombre o solo "Refugio Belgrano Animales"? Tendencia: para govt + admin → reporter individual visible (accountability); para subject_owner si llega a ver case → solo "Refugio Belgrano Animales" (privacy del reporter). Mismo patrón que welfare_denuncia normal.
- **Override severity floor**: ¿siempre `critical` o se debería permitir 'high' como default cuando el form dice low? Tendencia: siempre critical en v1 — simplifica + safe default. Si genera ruido excesivo, ajustar después.
- **Multi-org corroboration count display**: ¿cuál es el threshold para "multi-source" — 2 orgs, 3 orgs? Tendencia: 2+ — cualquier corroboración cuenta. Visualmente "Reportes adicionales: N" donde N es el count.

---

## 10. Out of scope

- **Vet individual sin org**: un vet con `professional.provider` granted pero sin membership en org no puede usar este flow. Sigue limitado al flow autenticado-civil (no priority boost). Cuando exista el `/pro` portal completo, considerar agregar `welfare.report.vet_independent` capability.
- **API externa para denuncia desde sistemas govt** (e.g., DENUMA, MPF CABA, etc.): fuera de scope. El spec asume input vía MiMAR UI. Webhook entrada cuando integración externa exista.
- **Auto-triage del govt cuando org-side report llega** (e.g., auto-asignar a un welfare officer based on jurisdiction load): defer al spec del welfare officer queue.
- **Reports con denunciante anónimo dentro de la org** (el coordinator no quiere que su nombre figure en audit interno): defer. Por ahora todo audit con `actor_user_id` populated.

---

## 11. Implementation outline (para plan ejecutable post-OK)

1. **Fase 1** — Schema delta (`reporter_organization_id` column + index + audit_log action). ~½ día.
2. **Fase 2** — Capability `welfare.report` resolver en `lib/capabilities.ts`. ~½ día.
3. **Fase 3** — `createOrgWelfareReportAction` + helper `emitBridgeEvents` extension para org-side. ~1 día.
4. **Fase 4** — UI `/org/[orgToken]/maltrato/nuevo` + `/org/[orgToken]/maltrato/recibidos`. ~1 día.
5. **Fase 5** — Multi-source escalation logic + notif templates. ~½ día.
6. **Fase 6** — Tests. ~1 día.
7. **Fase 7** (cuando la queue exista) — Priority sort en `/gob/maltrato`. ~½ día.

Total ~4-5 días. Depende de sistema de casos implementado. Welfare officer queue de la priority #4 del README puede ejecutarse en paralelo / antes.
