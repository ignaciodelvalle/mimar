# Pregnancy tracking — design spec

> Modela el embarazo de una hembra dentro de la libreta sanitaria como un proceso bounded (start → end), con flag denormalizada `pets.pregnancy_status` para queries rápidos, sección destacada en el pet profile v2 mientras esté activo, y unlock del achievement A4 "Tuve crías" al cierre con `outcome='live_birth'`. **NO event_type nuevo** — el embarazo vive como sub_kind del umbrella `clinical_info_logged` que ya existe (cleanup catalog), siguiendo el patrón establecido. Capture rápida (`/anotar`) reconoce frases tipo "está embarazada", "parió", "nacieron N cachorros" y enruta al form correcto pre-llenado.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** `lib/libreta-sanitaria.ts` (clinical_info_logged ya es libreta), `lib/event-capture-registry.ts` (captura rápida), pet profile v2 spec (sección destacada).

---

## 1. Por qué este documento existe

Hoy el embarazo de una hembra no tiene representación dedicada en MiMAR. El vet/owner que quiere dejarlo registrado tiene tres opciones malas:

- Anotarlo como `note_added` libre — invisible a queries, no destaca, no unlocks achievement
- Forzarlo como `clinical_info_logged(sub_kind='other')` — sin discriminator estandarizado, sin pair start/end, sin denorm flag
- No registrarlo — la historia clínica queda incompleta y nunca podemos surfacear "atención, hay 3 hembras embarazadas en seguimiento en CABA esta semana" como signal poblacional

El embarazo es **bounded process** clásico (igual que rabies observation): tiene un inicio identificable, una duración limitada conocida (perros ~58-68 días, gatos ~63-67 días), y un fin con outcome categorizable (parto vivo, óbito fetal, aborto espontáneo, terminación médica). El catálogo de eventos tiene un patrón establecido para esto (`*_started/*_ended` per `AGENTS.md → Cross-cutting event design patterns §1`).

Pero también es **clinical event**: la decisión del catalog cleanup (`2026-05-18-event-catalog-cleanup`) fue colapsar lab/imaging/surgery/allergy_detection dentro de `clinical_info_logged` con `sub_kind` discriminator. Embarazo cae naturalmente bajo el mismo umbrella — no merece event_type propio, sí merece su sub_kind con su payload schema.

Además, el embarazo tiene un componente UX/emocional fuerte: el dueño quiere ver "MI mascota está embarazada" destacado en el profile, no enterrado en libreta. Eso es el motivo de §4 (sección destacada en pet profile v2) y del achievement A4 que ya está dentro del POC.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| PR1 | **NO event_type nuevo**. Embarazo vive como **`clinical_info_logged(sub_kind='pregnancy')`** con discriminator en payload (`pregnancy_phase: 'started' | 'ended'`) | Consistencia con el catalog cleanup pattern. Evita inflar el catálogo. Reusa el mismo schema infra |
| PR2 | **Solo `pet.sex='female'`** Y **`pet.species IN ('dog', 'cat', 'other')`**. Validation en server action + Zod refinement | Embarazo es de hembras (cubre todas las species DIM relevantes). `other` queda abierto para futuras species (conejos, etc.); el server permite. Machos rechazado con error explícito |
| PR3 | **Pair start/end** con `pregnancy_phase` discriminator en payload. `'started'` abre el período, `'ended'` lo cierra con `outcome`. Al insertar `'started'` con un período activo previo (no cerrado), el server rechaza — solo 1 embarazo activo a la vez | Mismo patrón que `rabies_observation_started/_ended`. Single active period — coherente con biología |
| PR4 | **Denormalized flag `pets.pregnancy_status`** con valores `null | 'in_progress' | 'completed_live_birth' | 'completed_stillbirth' | 'completed_miscarriage' | 'completed_termination' | 'completed_unknown'`. Dual-write desde el server action, re-derivable de events | Permite queries rápidas tipo "todas las pets embarazadas en jurisdicción X" sin scan de pet_events. Mismo patrón que `pet.rabies_observation_status` y `pet.adoption_eligible` |
| PR5 | **Outcomes admitidos** al cerrar: `live_birth | stillbirth | miscarriage | termination | unknown`. Si `outcome='live_birth'` requiere campo opcional `live_births_count` (integer, mínimo 1). Otros outcomes no | Cubre los casos veterinariamente reconocidos. `unknown` para casos donde el cierre se hace tarde y no se confirmó qué pasó |
| PR6 | **Tracking de gestation_weeks_estimated**: payload opcional `weeks_at_diagnosis` (cuando se confirma el embarazo) + cómputo de `expected_birth_date_estimated` derivable. Vista del profile usa este cálculo para "Faltan ~X semanas" | UX. La mascota está embarazada — el dueño quiere saber cuándo viene el parto |
| PR7 | **Capture rápida**: agregar entries al `lib/event-capture-registry.ts` para reconocer "está embarazada", "está preñada", "tuvo cachorros", "parió N", "tuvo crías", "perdió el embarazo", "aborto", "esterilización post parto". Cada match abre el form correcto (`/eventos/nuevo/clinico?sub_kind=pregnancy&phase=started|ended&...prefilled`) | Captura rápida ya cubre 9 forms; agregar embarazo extiende el catálogo determinístico sin LLM |
| PR8 | **Sección destacada en pet profile v2** (cuando `pregnancy_status='in_progress'`): nueva card amber/rosé entre las cards condicionales (PPP, Service Dog) y el header de identidad. Muestra "Embarazo en seguimiento", semanas estimadas, expected birth date, último checkup, CTA "Registrar parto / cierre" | UX. El embarazo es info crítica que el dueño quiere ver de entrada, no enterrado en la libreta |
| PR9 | **Achievement A4 `i_had_litter` se activa cuando** `clinical_info_logged(sub_kind='pregnancy', pregnancy_phase='ended', outcome='live_birth')` existe en events. Se updatea la función `computeStatus` del achievement A4 del pet profile v2 spec | Cierra el TODO del pet profile v2 spec §5.2 (A4 estaba `not_yet_computable`) |
| PR10 | **NO obstetric medical detail más allá de los campos del schema** (`weeks_at_diagnosis`, `outcome`, `live_births_count`, opcional `vet_consulted`, opcional `notes`). Específicamente NO modelo de "controles prenatales mensuales", "ultrasonido", "complicaciones del parto", etc. — esos van como `clinical_info_logged(sub_kind='imaging' \| 'other')` independientes del pregnancy event, ligados por proximity temporal en la libreta | Simplicidad v1. Si después aparece demanda real de "sub-tracking obstétrico", se modela como spec adicional. Por ahora KISS |
| PR11 | **NO notif automática al govt** por embarazo (no es ENO ni reportable). Sí se cuenta en proyecciones poblacionales agregadas para sanitary authority dashboards (futuro). El owner SÍ recibe notification al insertar `pregnancy_started` con copy "Te recomendamos llevar a [pet] a controles veterinarios regulares durante la gestación" | Privacy + utilidad. Embarazo no es info pública ni gubernamental; sí es info que el sistema puede usar para acompañar al dueño |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Pregnancy start** | Evento `clinical_info_logged(sub_kind='pregnancy', pregnancy_phase='started')`. Marca el inicio del período de seguimiento |
| **Pregnancy end** | Evento `clinical_info_logged(sub_kind='pregnancy', pregnancy_phase='ended', outcome=X)`. Cierra el período. `outcome` discrimina cómo terminó |
| **Pregnancy status** | Denormalized flag en `pets.pregnancy_status`. Re-derivable de events. Source of truth para queries fast |
| **Live births count** | Cantidad de cachorros/crías nacidos vivos. Opcional pero recomendado cuando `outcome='live_birth'` |
| **Expected birth date estimated** | Cómputo derivado de `pregnancy_started.occurred_at + weeks_at_diagnosis + remaining_weeks_for_species`. Solo display, no schema field |
| **Achievement A4 unlock** | Trigger del achievement `i_had_litter` definido en pet profile v2 spec §5.2 |

---

## 4. Domain model

### 4.1 Sin cambios al `EVENT_TYPES` const

El `clinical_info_logged` event_type ya existe en `db/schema.ts:266`. No se agrega nada al array.

### 4.2 Extensión al Zod schema de `clinical_info_logged`

`lib/event-schemas.ts` — el schema actual de `clinical_info_logged` tiene:

```ts
sub_kind: z.enum(['lab_work', 'imaging', 'surgery', 'allergy_detection', 'other']),
title: z.string(),
details: z.string().nullable(),
performed_by: z.string().nullable(),
```

Update:

```ts
sub_kind: z.enum([
  'lab_work',
  'imaging',
  'surgery',
  'allergy_detection',
  'pregnancy',  // <-- nuevo
  'other',
]),
// Campos universales se mantienen + pregnancy-specific opcionales:
pregnancy_phase: z.enum(['started', 'ended']).optional(),
weeks_at_diagnosis: z.number().int().min(0).max(12).nullable().optional(),
outcome: z.enum(['live_birth', 'stillbirth', 'miscarriage', 'termination', 'unknown']).nullable().optional(),
live_births_count: z.number().int().min(0).max(20).nullable().optional(),
vet_consulted: z.string().nullable().optional(),
```

Refinement (Zod superRefine):

```ts
.superRefine((payload, ctx) => {
  if (payload.sub_kind !== 'pregnancy') return;

  // pregnancy_phase obligatorio para sub_kind='pregnancy'
  if (!payload.pregnancy_phase) {
    ctx.addIssue({ code: 'custom', message: 'pregnancy_phase required when sub_kind=pregnancy' });
  }

  // outcome obligatorio si phase='ended'
  if (payload.pregnancy_phase === 'ended' && !payload.outcome) {
    ctx.addIssue({ code: 'custom', message: 'outcome required when pregnancy_phase=ended' });
  }

  // outcome NO debe estar si phase='started'
  if (payload.pregnancy_phase === 'started' && payload.outcome) {
    ctx.addIssue({ code: 'custom', message: 'outcome not allowed when pregnancy_phase=started' });
  }

  // live_births_count solo válido con outcome='live_birth'
  if (payload.live_births_count !== null && payload.live_births_count !== undefined) {
    if (payload.outcome !== 'live_birth') {
      ctx.addIssue({ code: 'custom', message: 'live_births_count only valid when outcome=live_birth' });
    }
  }
});
```

### 4.3 Columna nueva en `pets`

```ts
// db/schema.ts pets table extensión
pregnancyStatus: text('pregnancy_status'), // null | 'in_progress' | 'completed_*'
```

Migration:

```sql
alter table pets add column pregnancy_status text;
alter table pets add constraint pets_pregnancy_status_valid check (
  pregnancy_status is null OR pregnancy_status in (
    'in_progress',
    'completed_live_birth',
    'completed_stillbirth',
    'completed_miscarriage',
    'completed_termination',
    'completed_unknown'
  )
);
create index pets_pregnancy_active_idx on pets (id) where pregnancy_status = 'in_progress';
```

Backfill: no aplica (campo nuevo).

### 4.4 Constraint de single active pregnancy

NO se enforce con DB constraint (sería complejo — partial unique sobre derived state). Se enforce en server action `recordPregnancyStartedAction`:

```ts
// pseudo
const [currentPet] = await db.select(...).from(pets).where(eq(pets.id, petId));
if (currentPet.pregnancyStatus === 'in_progress') {
  return { error: 'Esta mascota ya tiene un embarazo en seguimiento. Cerralo primero antes de registrar uno nuevo.' };
}
```

Mismo defensive pattern que `markPetLostAction` con `pet.status='lost'`.

### 4.5 Validación de species + sex

Server action chequea:

```ts
if (pet.sex !== 'female') return { error: 'Solo se pueden registrar embarazos en hembras.' };
if (!['dog', 'cat', 'other'].includes(pet.species)) return { error: 'Especie no soportada para embarazos.' };
```

`other` queda abierto porque el catálogo de species es extensible (rabbit, ferret, etc. del Bloque 1 de additional-species spec). El responsable del registro decide si su species tiene sentido.

---

## 5. Flujo UX — owner

### 5.1 Entry points

Cuatro vías para iniciar el registro:

**A. Captura rápida** (`/anotar`):
- Matches: "está embarazada", "preñada", "espera cachorros / crías", "está esperando", "panza de embarazada".
- Match → abre `/eventos/nuevo/clinico?sub_kind=pregnancy&phase=started` pre-filled.

**B. Desde el form de "anotar algo" cuando el user selecciona "Clínico"**:
- El picker de sub_kind ahora tiene 6 opciones: Lab work, Imagen, Cirugía, Alergia, **Embarazo**, Otro.
- Seleccionar Embarazo → form expande con campos pregnancy-specific.

**C. Desde pet profile**:
- Si la pet es female + species permitida + no pregnancy in_progress → action "Registrar embarazo" en el menu de Acciones.

**D. Desde la sección destacada del profile (cierre)**:
- Si pregnancy_status='in_progress' → la card destacada tiene CTA "Registrar parto / cierre" → form de ended pre-filled.

### 5.2 Forms

**Form `pregnancy_started`** (`/eventos/nuevo/clinico?sub_kind=pregnancy&phase=started`):

```
Registrar embarazo · {pet.name}

⚠ Esta acción dispara recordatorios automáticos de controles veterinarios.

[Fecha estimada de inicio] datepicker (default: today)

[Semanas estimadas al momento del diagnóstico] slider 0-12 (default: null)
  (si tu vet te dio una estimación, ingresala; sino dejalo en blanco)

[Veterinario consultado] text (opcional)

[Notas] textarea (opcional)

[Registrar]
```

Submit → `recordPregnancyStartedAction`:

1. Validar pet female + species OK + no active pregnancy.
2. INSERT `clinical_info_logged(sub_kind='pregnancy', pregnancy_phase='started', ...)`.
3. UPDATE `pets.pregnancyStatus='in_progress'`.
4. INSERT reminder genérico "Control veterinario de embarazo" cada 2 semanas hasta expected birth date estimated.
5. Notification al owner: copy de PR11.
6. Redirect al profile (que ahora muestra la sección destacada).

**Form `pregnancy_ended`** (`/eventos/nuevo/clinico?sub_kind=pregnancy&phase=ended`):

```
Registrar fin del embarazo · {pet.name}

[Fecha] datepicker (default: today)

[Resultado]
( ) Parto exitoso (live_birth)
( ) Óbito fetal (stillbirth)
( ) Aborto espontáneo (miscarriage)
( ) Terminación médica (termination)
( ) No sé / no me consta (unknown)

[Cantidad de crías nacidas vivas] integer
  (solo si outcome = "parto exitoso")
  (rango 1-20)

[Veterinario que asistió] text (opcional)

[Notas] textarea (opcional)

⚠ Tras este registro la mascota podrá ser candidata para futuros embarazos.
   Si querés evitarlo, considerá registrar también una esterilización
   (Acciones → Esterilización).

[Cerrar embarazo]
```

Submit → `recordPregnancyEndedAction`:

1. Validar pregnancy in_progress.
2. INSERT `clinical_info_logged(sub_kind='pregnancy', pregnancy_phase='ended', outcome, ...)`.
3. UPDATE `pets.pregnancyStatus='completed_{outcome}'`.
4. Cancel pending pregnancy-related reminders.
5. Si outcome='live_birth': notification "¡Felicitaciones! Quedó registrado en la libreta de [pet]. Acabás de desbloquear el logro 'Tuve crías'."
6. Si outcome IN ('stillbirth', 'miscarriage'): copy empática + suggestion de seguimiento veterinario.
7. Redirect al profile.

### 5.3 Pet profile v2 — sección destacada (mientras in_progress)

(Cross-ref al pet profile v2 spec §4.9 — esta sección se inserta como §4.10 o se renombra el orden vertical):

```
┌──────────────────────────────────────────────────────────────┐
│ 🌸 Embarazo en seguimiento                                   │
│                                                              │
│ Iniciado: {pregnancy_started.occurred_at}                    │
│ Semanas estimadas: ~{computed_weeks}                         │
│ Estimación de parto: ~{expected_birth_date}                  │
│                                                              │
│ Último checkup: {last_clinical_event.occurred_at}            │
│                                                              │
│ → Registrar parto / cierre                                   │
│ → Anotar control veterinario                                 │
└──────────────────────────────────────────────────────────────┘
```

Posición en el orden vertical (override del §4.9 del pet profile v2 spec):

```
1. BackLink
2. [cond] Casos abiertos
3. [cond] PPP card
4. [cond] Service dog credential card
5. [cond] Pregnancy in_progress card   ← nueva
6. Header de identidad
7. Achievements chips
...
```

---

## 6. Capture rápida — adiciones al registry

`lib/event-capture-registry.ts` (extender):

```ts
{
  eventType: 'clinical_info_logged',
  matchPatterns: [
    /está embarazada/i,
    /está preñada/i,
    /espera (cachorros|crías|gatitos)/i,
    /tiene panza de embarazo/i,
  ],
  slotsDefault: { sub_kind: 'pregnancy', pregnancy_phase: 'started' },
  formPath: '/mis-mascotas/{publicToken}/eventos/nuevo/clinico',
},
{
  eventType: 'clinical_info_logged',
  matchPatterns: [
    /parió (\d+)? ?(cachorros|crías|gatitos)?/i,
    /tuvo (\d+)? ?(cachorros|crías|gatitos)/i,
    /nacieron (\d+) ?(cachorros|crías|gatitos)/i,
  ],
  slotsDefault: { sub_kind: 'pregnancy', pregnancy_phase: 'ended', outcome: 'live_birth' },
  slotExtractors: {
    live_births_count: (text) => parseInt(text.match(/(\d+)/)?.[1] ?? '', 10) || null,
  },
  formPath: '/mis-mascotas/{publicToken}/eventos/nuevo/clinico',
},
{
  eventType: 'clinical_info_logged',
  matchPatterns: [
    /perdió el embarazo/i,
    /tuvo un aborto/i,
    /se complicó el embarazo/i,
  ],
  slotsDefault: { sub_kind: 'pregnancy', pregnancy_phase: 'ended', outcome: 'miscarriage' },
  formPath: '/mis-mascotas/{publicToken}/eventos/nuevo/clinico',
},
```

---

## 7. Lifecycle integration con cases system

`clinical_info_logged(sub_kind='pregnancy')` mantiene su attachment mode actual: **`optional`** (del attachment spec §7.4). Cuando se inserta, NO abre un case nuevo, NO se ata automáticamente — el dueño/vet decide si lo liga a algún caso abierto.

Razón: un embarazo no es un caso (no requiere coordinación multi-actor, no tiene normativas legales gobernando timing, no necesita scope-bound visibility especial). Es un proceso clínico que vive en la libreta y en la sección destacada del profile. KISS.

(Edge: durante un `welfare_denuncia` por crueldad/negligencia, podría tener sentido atar el embarazo al caso — el modo `optional` ya lo permite si el welfare officer lo hace explícito. Sin override de UX.)

---

## 8. Achievement A4 — update al pet profile v2 spec

Update a `lib/achievements/i-had-litter.ts` (cuando se implemente el pet profile v2):

```ts
{
  id: 'i_had_litter',
  label: 'Tuve crías',
  icon: '🐣',
  description: 'Soy mamá. Quedó registrado mi parto en la libreta.',
  computeStatus: ({ events, pet }) => {
    const liveBirths = events.filter(e =>
      e.event_type === 'clinical_info_logged' &&
      (e.payload as any).sub_kind === 'pregnancy' &&
      (e.payload as any).pregnancy_phase === 'ended' &&
      (e.payload as any).outcome === 'live_birth'
    );
    if (liveBirths.length === 0) return { kind: 'not_yet' };
    return {
      kind: 'earned',
      earnedAt: new Date(liveBirths[liveBirths.length - 1].occurred_at),
      count: liveBirths.length > 1 ? liveBirths.length : undefined,
      detail: liveBirths.reduce((sum, e) => sum + ((e.payload as any).live_births_count ?? 0), 0).toString() + ' crías totales',
    };
  },
},
```

(El POC original lo marcaba `not_yet_computable` — ahora pasa a `earned` cuando aplique. Cierra el TODO del pet profile v2 spec §5.2.)

---

## 9. Reminders

Cuando `pregnancy_started` se inserta:

- INSERT reminders cada 2 semanas hasta expected_birth_date_estimated, con `reminder_type='custom'`, title="Control veterinario de embarazo de {pet.name}", source_event_id=<id>.
- Al insertar `pregnancy_ended`, cancel pending reminders (UPDATE completed_at=NULL → sí, cancelar; PR10 dice no obstetric detail, pero los reminders chequeo general son útiles).

Duración default según species:

```ts
const PREGNANCY_DURATION_WEEKS = {
  dog: 9,
  cat: 9,
  other: 9,  // fallback razonable
};
```

Si `weeks_at_diagnosis` está populated → `expected = started_at + (PREGNANCY_DURATION_WEEKS[species] - weeks_at_diagnosis) * 7 days`. Sin él → asume gestación completa desde el started.

---

## 10. Tests

`__tests__/pregnancy-validation.test.ts`:

```ts
it('rechaza pregnancy_started para macho');
it('rechaza pregnancy_started para species no soportada');
it('rechaza pregnancy_started con active pregnancy previa');
it('rechaza pregnancy_ended sin pregnancy in_progress');
it('rechaza pregnancy_ended sin outcome');
it('rechaza live_births_count cuando outcome != live_birth');
```

`__tests__/pregnancy-flow.test.ts`:

```ts
it('flow completo started → ended live_birth: status flippea correcto');
it('flow completo started → ended miscarriage: status flippea correcto');
it('reminders se crean al started + se cancelan al ended');
it('achievement A4 se activa post live_birth');
it('captura rápida match "parió 5 cachorros" pre-rellena form');
```

---

## 11. Open questions

- **Multi-parto histórico**: si una pet tuvo 3 embarazos antes de MiMAR, ¿podemos backfillear? Tendencia: SÍ — el form de `started`/`ended` acepta fechas pasadas. Cada par es independiente. Solo restricción: cualquier `started` requiere que no haya activos al momento del INSERT.
- **Tiempo entre embarazos consecutivos**: ¿warning si el dueño registra un `started` < 4 meses después del último `ended`? Tendencia: warning suave, NO block. La biología de la pet es decisión del dueño/vet.
- **Counts mayores a 20**: cubrimos 1-20 crías. Casos extremos (litters de 14+ en perros, raras pero existen) están cubiertos. >20 es prácticamente imposible biológicamente.
- **Esterilización post-parto sugerida**: el form de `ended` menciona la sugerencia. ¿Sería buen UX disparar una notificación al owner 2 meses post-parto recordando esterilización? Tendencia: SÍ pero como follow-up del achievement de "Esterilización completada" cuando esté en el catálogo de achievements del backlog (§5.4 pet profile v2).

---

## 12. Out of scope

- **Sub-tracking obstétrico avanzado** (ultrasonidos cronológicos, controles prenatales mensuales como event_type) — defer. El que quiera registrar un ultrasonido usa `clinical_info_logged(sub_kind='imaging')` independiente.
- **Tracking de las crías individuales** — los cachorros recién nacidos NO se registran automáticamente como pets nuevas. Si el dueño/refugio quiere darles cuenta MiMAR, los registra normalmente con `pet_registered(acquisition_method='born_in_litter')`. La relación parent-child queda implícita (no se modela explícitamente — defer si aparece demanda real).
- **Inseminación artificial / detection automática** — fuera de scope. El input es siempre humano.
- **Reporting poblacional**: agregar embarazos a govt dashboards es welcome pero defer; cuando los dashboards de sanitary authority se construyan, se agrega el panel "Hembras en seguimiento de embarazo".

---

## 13. Implementation outline (para plan ejecutable post-OK)

1. **Fase 1**: schema (column `pets.pregnancy_status` + Zod extension al `clinical_info_logged`). ~½ día.
2. **Fase 2**: server actions `recordPregnancyStartedAction` + `recordPregnancyEndedAction`. ~1 día.
3. **Fase 3**: forms (extender `/eventos/nuevo/clinico` con pregnancy sub-form). ~1 día.
4. **Fase 4**: capture rápida (entries en registry). ~½ día.
5. **Fase 5**: pet profile v2 — sección destacada in_progress (dependencia: pet profile v2 implementado). ~½ día.
6. **Fase 6**: achievement A4 — update del computeStatus (dependencia: pet profile v2 achievements implementado). ~½ día.
7. **Fase 7**: tests. ~1 día.

Total ~5 días. Plan ejecutable separado cuando se priorice.
