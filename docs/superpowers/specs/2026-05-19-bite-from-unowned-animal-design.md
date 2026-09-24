# Bite from unowned animal — design spec

> Hoy MiMAR solo modela bite events donde la pet mordedora **está registrada**. Si te muerde un perro ajeno en la calle, no hay flow — el dato se pierde. Este spec abre el camino: usuario autenticado reporta haber sido mordido, identifica al perro/dueño si pudo, sino describe completo (raza, marcas, color, edad) y el sistema crea una **"pet temporal"**. Govt/admin con scope puede **reasignar** el caso a una pet real cuando aparezca información. El DNI del dueño (cuando se conoce) se persiste; si esa persona después se registra en MiMAR, el sistema **reconcilia** automáticamente conectando casos históricos a su cuenta y a sus pets.
>
> **Fecha:** 2026-05-19 · **Revisado:** 2026-06-19
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC — **backlog, gated a Wave 5** · plan ejecutable en `plans/2026-06-19-bite-from-unowned-animal.md`
> **Versión:** 2.0 (revisión 2026-06-19: estado de código actualizado + alineación Wave 5 + modelo de víctima + decisiones cerradas)
> **Depende de:** **Wave 5 launch-hardening** (`dim-interno:docs/superpowers-private/specs/2026-06-19-wave5-launch-hardening-handoff.md`, Items 25–28 — `dni_hash`) para la reconciliación. El **sistema de casos ya está implementado** (migraciones 0033/0034, posteriores a v1.0): `cases` con sujeto polimórfico + `pet_events.case_id` ya existen. Bite-rabies observation (`2026-05-18-...`) se extiende para tolerar subject `unowned_animal`.

---

## 0. Revisión v2.0 (2026-06-19) — leer ANTES del cuerpo v1.0

El cuerpo (§1–§12) es de v1.0 (2026-05-19) y sigue siendo válido en su mayoría, pero quedó desactualizado en tres frentes. **Donde haya conflicto, mandan estas decisiones de v2.0.**

**R1 — El sistema de casos YA está en código (la dependencia está resuelta).** v1.0 asumía cases "Ready for CC". Hoy: `cases` (sujeto polimórfico `registered_pet|unowned_animal|location|general`, `primary_pet_id` nullable, CHECK `cases_subject_pet_consistency`), `pet_events.case_id` (FK nullable, append-only, indexado), el módulo `src/modules/cases` (con `casesRepository.openCase()` + generación de `CAS-XXXX`), `/casos/[publicCode]` y las colas govt/admin/org **ya existen**. La feature NO está bloqueada — solo gated a Wave 5 por la reconciliación (R2).

**R2 — Reconciliación por DNI se alinea a Wave 5: `dni_hash`, nunca DNI en claro.** v1.0 (§4.5, §7) matchea `profiles.dni_number` en texto. Wave 5 **dropea `dni_number`** → `dni_hash` (HMAC-SHA256 con pepper en env/KMS) + `dni_last4`, identidad desde claim Mi Argentina (`miarg_sub`). Correcciones obligatorias:
  - `temporary_pet_descriptions.owner_dni_claimed` (texto) → **`owner_dni_hash`** (HMAC) + opcional `owner_dni_last4`. **Nunca** el DNI completo.
  - El match en signup compara `temporary_pet_descriptions.owner_dni_hash == profiles.dni_hash` (mismo pepper). `miarg_sub` NO sirve como clave (un tercero no lo conoce; la víctima solo aporta DNI).
  - Toda la feature corre **después** de Wave 5 (necesita el pepper + `dni_hash`). De ahí el "gated a Wave 5".

**R3 — Embargo de identidad (§10): DESCARTADO.** Con DNI hasheado, govt nunca ve el número completo (igual que de cualquier usuario registrado post-Wave 5 — solo `dni_last4` + nombre). La privacidad es estructural, no un toggle → el checkbox "ocultar DNI a govt" es redundante. Se elimina la open question. Si la víctima no quiere comprometer al dueño, no declara el DNI.

**R4 — Modelo de víctima (cubre los dos escenarios).** El mordedor siempre es el animal ajeno, pero la víctima varía:
  - **Escenario A** — animal ajeno mordió a un **humano** (la víctima/reportante). Entry: `/denuncias/nueva`.
  - **Escenario B** — animal ajeno mordió a **mi mascota DIM**. Entry: `/anotar` (en contexto de mi mascota).
  En B hay dos animales. Decisión: el `bite_incident` se abre sobre el **mordedor ajeno** (con su observación rábica de 10 días — la obligación legal recae sobre el mordedor), **y** se registra a la víctima: `victim_kind` + `victim_pet_id` en el payload de `incident_reported`, **más** un `incident_reported(incident_type='bite_suffered')` en la **libreta de mi mascota** para que el dueño lo vea en su historial.

**R5 — Sin event types nuevos. Se reutilizan los existentes** (el schema ya los anticipa):
  - `incident_reported` — su Zod schema (`lib/event-schemas.ts`) ya incluye `incident_type` con `'bite_inflicted'` **y `'bite_suffered'`**, y los campos `victim_kind`, `victim_pet_id`, `victim_contact_name/phone`, `reporter_role`. No se agrega nada al schema.
  - `rabies_observation_started` / `rabies_observation_ended` — la observación de 10 días.
  - `note_added` con `category='system'` — la nota de auditoría de la reasignación (BU6). Reemplaza la idea de un `case_reassigned` nuevo (§4.4 ya se inclinaba por esto; queda confirmado).

**R6 — Dónde viven los eventos del mordedor ajeno (subject sin `pet_id`).** Existen dos logs: `pet_events` (con `case_id` opcional) y `case_events` (timeline interno del caso, migración 0069, vocabulario `entryType` propio). **Decisión: Opción 1 — `pet_events` con `pet_id=NULL, case_id=set`** (como propone §4.3), porque reusa los EVENT_TYPES de rabia + sus schemas Zod + la semántica legal ya modelada. Esto exige hacer **`pet_events.pet_id` nullable + CHECK de consistencia** (§4.3) — el cambio de mayor riesgo del feature → el plan incluye un **grep/audit obligatorio de todos los consumidores que asumen `pet_id` presente** (proyecciones, RLS, queries) como paso de verificación. *Alternativa considerada y descartada:* `case_events` (evita tocar `pet_events` pero obliga a re-expresar la observación rábica fuera de su schema canónico y el cron no reusaría `validateEventPayload`). El evento de la **víctima** del escenario B sí va a `pet_events` normal (tiene `pet_id`: mi mascota).

**R7 — Govt force-escalate (cierra open question §10).** El detalle del caso (`/casos/[publicCode]`) tiene, para govt scope-matching/admin, un botón **"Escalar a urgente"** que marca el `bite_incident` temporal como escalado (señal manual). La auto-escalación por `symptom_observed` (BU11) sigue sin aplicar salvo que govt agregue ese evento.

**R8 — Entry points de v1 (R4).** Solo **`/anotar`** (escenario B) y **`/denuncias/nueva`** (escenario A, vía CTA cuando el subject es `unowned_animal` y es mordedura). Las otras dos de §5.1 (card en `/inicio`, ítem en gestión del perfil) quedan fuera de v1.

---

## 1. Por qué este documento existe

3 huecos abiertos hoy:

1. **El reporting de bite asume pet mordedora registrada**. El spec `bite-rabies-observation-design.md` v1.1 modela `incident_reported(incident_type='bite_inflicted')` con el pet como subject — no tiene rama para "el perro que me mordió no es de nadie que yo conozca".
2. **La observación antirrábica legal aplica IGUAL** — el Decreto 4669/1973 PBA + Ord. CABA 41.831/1987 obligan a 10 días de observación del animal mordedor. Sin sistema que registre estos casos cuando el animal no está en MiMAR, los datos quedan en el papel (literalmente: el dispensario antirrábico recibe la denuncia y va al barrio). MiMAR puede ser el data layer faltante.
3. **El DNI del dueño identificado se pierde** — si la víctima sabe quién es el dueño (vio el DNI, vecino conocido, etc.), pero el dueño NO está registrado en MiMAR, esa info se desperdicia. Con captura + reconciliación post-signup, el sistema puede conectar puntos automáticamente cuando el dueño eventualmente se registre.

Lo que ya hay en el repo y se reusa:

- `welfare_reports.subjectKind` polimórfico (`registered_pet | unowned_animal | location | general`) — patrón a copiar para `incident_reported` o para `cases.primary_subject_kind`.
- Sistema de casos con `cases.primary_subject_kind` ya polimórfico (attachment spec §4).
- Bite-rabies observation flow + cron de auto-close + escalation por symptom.
- `profiles.dni_number` + `profiles.dni_verified` para el matching automatic.

Este spec extiende sin reemplazar. La pet temporal NO es un parche — es la representación natural del "animal del cual conocemos algo pero no es un account holder".

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| BU1 | **Reporting de bite from unowned: autenticado solamente en v1**. La víctima necesita cuenta MiMAR para reportar. Sin sesión, el flow no abre. Anónimo se difiere (futuro: paridad con denuncia welfare anon) | Reducir spam + tener email/identidad verificable de la víctima para coordinación. La barrera de auth en v1 es aceptable porque el flow welfare ya existe para anon-reports adyacentes |
| BU2 | **El bite_incident case con `primary_subject_kind='unowned_animal'` es legítimo** — NO requiere pet registrada. El attachment spec §4 ya lo soporta (`primary_pet_id` es nullable cuando subject_kind ≠ `registered_pet`) | Reusa modelo existente. Una sola excepción: la denormalized flag `pets.rabies_observation_status` no aplica (no hay pet); el caso vive solo por su `cases.status` |
| BU3 | **Pet temporal**: tabla nueva `temporary_pet_descriptions` ligada al case via FK. NO es una row en `pets` con flag — sería deuda larga (constraints, RLS, joins se confunden con pets reales). Tabla separada keep clean | Aislamiento de dominio. Cuando el caso se reconcilia con una pet real, la temp row se marca `replaced_at` + `replaced_by_pet_id`; no se borra (audit) |
| BU4 | **Si la víctima identifica al perro y al dueño con un identificador trazable** (`microchip_id` de la pet, `pet.public_token` "DIM-XXXX", o DNI del dueño), el sistema **intenta resolver inmediatamente** durante el form. Si hay match → el caso se crea sobre la pet real (kind `registered_pet`); si no → caso temporal con DNI guardado para reconciliación posterior | Eficiencia + UX. Si la víctima ya sabe, no le hacemos describir; tampoco crea data duplicada |
| BU5 | **Reconciliation hook en signup**: cuando un usuario nuevo completa signup con `dni_number` Y `dni_verified=true`, el sistema busca `temporary_pet_descriptions` o `cases.opened_reason` con DNI matching → notifica al usuario nuevo: "Detectamos que figurás como dueño en N caso(s) de mordedura previo(s). Esos casos involucran descripciones de animales que coinciden con el DNI que registraste. ¿Querés vincularlos a una de tus mascotas ya registradas, o creás nuevas?" | Automatic data healing. Sin esto, el DNI capturado queda inerte. Con esto, MiMAR se vuelve sticky para dueños que entran porque "alguien me reportó" |
| BU6 | **Govt/admin manual reassignment**: en el detail del case, hay action "Reasignar a pet real" que abre un selector de pets (con filtros) + confirmación. La reasignación es **atómica**: actualiza `case.primary_pet_id`, `case.primary_subject_kind='registered_pet'`, NO toca el `case_id` de los events ya emitidos (siguen siendo events del case), pero SÍ inserta un `note_added(category='system', payload.scope='internal_govt')` que documenta la reasignación con quién/cuándo/por qué | Audit trail. La reasignación es decisión humana, queda explícita |
| BU7 | **Eventos del caso siguen con `case_id`**, NUNCA con `pet_id` cambiante. El `incident_reported` y `rabies_observation_started` originales viven con `pet_id=NULL` (porque el subject era temporal) y `case_id` apuntando al case. Cuando se reconcilia, NO modificamos esos events (append-only) — solo el case header se actualiza | Coherencia con append-only. La timeline del caso permanece consistente; lo único que cambia es "a qué pet apunta el case header ahora" |
| BU8 | **Visibilidad del caso temporal**: subject_owner no existe (no hay owner), entonces la víctima reportante (`opened_by_user_id`) tiene visibility full + govt scope-matching + admin. NO se notifica a "dueño potencial" cuando solo hay DNI sin cuenta matched — recién al reconciliarse | Privacy. Notificar a un DNI sin cuenta MiMAR implica trazas legales que MiMAR no debe asumir |
| BU9 | **Replace de temp pet en reconciliation por DNI signup** es **opt-in del nuevo usuario**, no automático. La notif explica los cases y el usuario decide para cada uno: "vincular a mi pet X" / "crear pet nueva" / "ignorar (no fue mi animal)" | El sistema sugiere; el humano confirma. Mismo principio que welfare moderation queue |
| BU10 | **El period de 10 días de observación corre IGUAL** para temp pets. El cron `close-rabies-observations` lo procesa con el patrón ya existente, pero el outcome `negative` se aplica al case_id, no a `pets.rabies_observation_status`. El cron necesita pequeño branch para subject_kind | Cumplimiento legal sobre el animal independiente de si está registrado. La info pública del cierre va a govt no al owner (que no existe / o existe pero sin reconciliar todavía) |
| BU11 | **El bite_incident case con subject `unowned_animal` NO escala a outbreak_signal por symptom matching automático**, porque no hay symptom_observed events crudos sobre el animal (la víctima/govt los podría agregar manual durante la observación). Si govt agrega `symptom_observed` con `case_id=<temp_case>` Y el match es rabia high-spec, sí escala. Sin events, sin escalation | Coherencia con el flow normal — la escalation depende de symptom_observed existir |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Bite from unowned** | Acción de la víctima de reportar mordedura cuando el animal NO está registrado en MiMAR |
| **Temp pet** (`temporary_pet_descriptions` row) | Representación liviana de un animal no-registrado en el sistema. Tiene descripción detallada (raza, marcas, color, edad, etc.) pero no es un pet con su propia identidad ni libreta |
| **Reconciliation** | Proceso de unir un caso temporal con datos reales. Dos vías: (a) **automatic match** al INSERT del form (microchip / DIM token / DNI existente en MiMAR), (b) **opt-in del usuario** post-signup vía DNI |
| **DNI captured** | El campo `temporary_pet_descriptions.owner_dni_claimed` — DNI del dueño que la víctima dice haber visto. NO verificado en el momento; solo capturado para reconciliación futura |
| **Reassignment** | Acción manual de govt/admin que cambia el `primary_pet_id` del case a una pet real ya en el sistema |

---

## 4. Domain model

### 4.1 Nueva tabla — `temporary_pet_descriptions`

```ts
// db/schema.ts
export const temporaryPetDescriptions = pgTable('temporary_pet_descriptions', {
  id: uuid('id').defaultRandom().primaryKey(),

  // Linkage al caso que la creó
  caseId: uuid('case_id').notNull().references(() => cases.id),

  // Descripción del animal
  species: text('species').notNull(),  // 'dog' | 'cat' | 'other'
  breed: text('breed'),
  sex: text('sex'),  // 'male' | 'female' | 'unknown'
  estimatedAgeYears: integer('estimated_age_years'),  // approx
  size: text('size'),  // 'small' | 'medium' | 'large'
  color: text('color'),
  distinguishingFeatures: text('distinguishing_features'),  // marca en la oreja, cola corta, etc.

  // Dueño identificado (opcional)
  ownerDniClaimed: text('owner_dni_claimed'),  // DNI declarado por víctima, NO verificado
  ownerNameClaimed: text('owner_name_claimed'),
  ownerContactClaimed: text('owner_contact_claimed'),  // teléfono o address libre

  // Identificadores del animal si la víctima los vio
  microchipNumberClaimed: text('microchip_number_claimed'),
  publicTokenClaimed: text('public_token_claimed'),  // DIM-XXXX si la víctima vio la chapita

  // Ubicación del bite
  biteLocationLat: numeric('bite_location_lat', { precision: 10, scale: 7 }),
  biteLocationLng: numeric('bite_location_lng', { precision: 10, scale: 7 }),
  biteLocationAddress: text('bite_location_address'),

  // Reconciliation tracking
  replacedAt: timestamp('replaced_at', { withTimezone: true }),
  replacedByPetId: uuid('replaced_by_pet_id').references(() => pets.id),
  replacedByUserId: uuid('replaced_by_user_id').references(() => profiles.id),  // quién hizo la reasignación

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Index para reconciliation lookup por DNI
// db/migrations/.../temporary_pets.sql
create index temporary_pet_descriptions_owner_dni_idx
  on temporary_pet_descriptions (owner_dni_claimed)
  where owner_dni_claimed is not null and replaced_at is null;

create index temporary_pet_descriptions_microchip_idx
  on temporary_pet_descriptions (microchip_number_claimed)
  where microchip_number_claimed is not null and replaced_at is null;
```

CHECK: `(replaced_at IS NULL) = (replaced_by_pet_id IS NULL AND replaced_by_user_id IS NULL)`.

### 4.2 Extensión a `cases`

Sin cambios al schema — ya soporta `primary_subject_kind='unowned_animal'` con `primary_pet_id=NULL`. Nuevo campo opcional:

```ts
// db/schema.ts - cases table extensión
temporaryPetDescriptionId: uuid('temporary_pet_description_id')
  .references(() => temporaryPetDescriptions.id),
```

(Backlink desde case al temp pet — facilita render de la card del case con la descripción.)

### 4.3 Extensión a `pet_events`

Sin schema change. Pero **regla nueva**: cuando `case.primary_subject_kind='unowned_animal'`, los events del caso (`incident_reported`, `rabies_observation_started`, etc.) tienen `pet_id=NULL` Y `case_id=<case>`. Hoy `pet_events.pet_id` es NOT NULL. **Hay que cambiarlo a nullable**:

```sql
alter table pet_events alter column pet_id drop not null;
alter table pet_events add constraint pet_events_subject_consistency
  check (
    pet_id is not null
    OR
    (case_id is not null and exists (
      select 1 from cases c where c.id = pet_events.case_id and c.primary_subject_kind <> 'registered_pet'
    ))
  );
```

**Migration implication**: el constraint anterior implícito (`pet_id NOT NULL`) sigue cumpliéndose para todos los events históricos. La excepción se introduce **solo** para casos no-registered.

### 4.4 Eventos extra del catálogo (potencialmente)

Para BU6 — reasignación auditable — podríamos crear `case_reassigned` event nuevo, o usar `note_added(category='system')`. Decisión: **usar `note_added`** para no inflar el catálogo. El payload del note incluye `from_pet_id` (null), `to_pet_id`, `reassigned_by_user_id`, `reason`.

### 4.5 `profiles.dni_number` ya existe

`profiles.dni_number` ya está en schema (línea 239 de schema.ts). Lo reusamos para reconciliation (BU5).

---

## 5. UX flow — reportar bite from unowned

### 5.1 Entry point

Botón nuevo accesible desde:

- `/inicio` dashboard → card "¿Te mordió un perro?" con CTA "Reportar"
- `/anotar` (captura rápida del owner) → si el usuario tipea "me mordieron" / "perro callejero me atacó" / similar → matcher sugiere "¿Querés reportar una mordedura de un animal ajeno?" con CTA
- Pet profile del owner → en la sección "Acciones", item nuevo "Reportar mordedura de animal ajeno" — para el caso "me mordió OTRO perro mientras paseaba al mío"
- `/denuncias/nueva` → en el form, si el subjectKind es `unowned_animal` y el kind sugerido es bite-related → CTA "¿Es una mordedura específica? Reportala acá" (link al form de bite)

Ruta: `/incidentes/mordedura-recibida` (nueva)

### 5.2 Form de reporte — wizard

3 pasos:

**Paso 1 — ¿Identificaste al perro?**

```
( ) Vi el microchip o tag MiMAR del perro
    → input: [chip ISO 15 dígitos] o [DIM-XXXX-XXXX]
    → [Buscar] → server resuelve match
( ) Conozco al dueño
    → input: [DNI del dueño] (opcional pero recomendado)
    → input: [Nombre del dueño] (opcional)
    → input: [Contacto del dueño — teléfono o cómo llegar] (opcional)
    → server busca match por DNI en `profiles`
( ) No identifiqué al dueño ni tengo info del perro
    → continúa a Paso 2 sin matching attempt
```

Si Paso 1 resuelve a una pet real (microchip o DIM token match) → **salta a Paso 3** directo con la pet ya identificada (subject=registered_pet, todo el flow normal del bite-rabies spec corre).

Si Paso 1 resuelve a un user real (DNI match en `profiles` Y ese user tiene mascotas registradas) → mostrar "Encontramos a {first_name}. Tiene N mascotas registradas. ¿Cuál te mordió?" → selector con sus pets → si elige una → mismo flow del bite-rabies normal.

Si Paso 1 NO resuelve, o si la víctima eligió "No identifiqué" → continúa a Paso 2.

**Paso 2 — Descripción del animal**

```
[Species]      ( ) Perro · ( ) Gato · ( ) Otro
[Raza] (texto libre + autocomplete sobre breeds.ts)
[Sexo]         ( ) Macho · ( ) Hembra · ( ) No sé
[Tamaño]       ( ) Chico · ( ) Mediano · ( ) Grande
[Color]        (texto libre, ej "marrón con manchas blancas")
[Edad aprox]   slider 0-20 años (opcional)
[Señales distintivas] (textarea — collar rojo, cola corta, cicatriz en oreja, etc.)
```

**Paso 3 — Detalle del incidente**

```
[Cuándo pasó]            datetime picker (default: hace 30 min)
[Dónde pasó]             address input + map pin (reusa LocationFields)
[Severidad]              ( ) Leve · ( ) Mediana · ( ) Grave (necesité atención médica)
[¿Acudiste a médico?]    [ ] Sí · contactar centro APR (Atención Post-Exposición Rabia)
[¿La mordedura fue provocada?] ( ) No · ( ) Sí · ( ) No sé
[Algo más para contar]   (textarea opcional)

⚠ Alerta sanitaria
  Recordá que por ley, este animal debe ser observado durante 10 días por
  riesgo de rabia. Tu reporte arranca esa observación. Si tenés posibilidad
  de identificar al animal o al dueño después, podés actualizar el caso.

  Si necesitás vacuna antirrábica post-exposición, contactá:
  → Instituto Pasteur (CABA): 011-4953-2826
  → Centro APR más cercano: [link]

[Enviar reporte]
```

### 5.3 Submit action

Server action `reportBiteFromUnownedAction`:

1. Validar payload (todos los pasos completos según rama elegida).
2. Si Paso 1 resolvió a registered_pet → llamar al action existing `reportBiteAction(petId, ...)` y terminar.
3. Si NO resolvió: TX atómica:
   - INSERT `temporary_pet_descriptions` con campos del form.
   - INSERT `cases` con `case_kind='bite_incident'`, `primary_subject_kind='unowned_animal'`, `primary_pet_id=NULL`, `temporary_pet_description_id=<id>`, `opened_by_user_id=victim`, `opened_reason='auto: bite-from-unowned reported by victim'`, jurisdiction derivada del bite_location.
   - INSERT `pet_events` `incident_reported` con `pet_id=NULL`, `case_id=<case>`, payload `incident_type='bite_inflicted'` + víctima context + descriptor de pet temporal en payload (snapshot para resiliencia de queries).
   - INSERT `pet_events` `rabies_observation_started` con mismo `pet_id=NULL`, `case_id=<case>`.
   - Notif al govt scope-matching de la jurisdicción del bite con severity `warning` + CTA al case.
   - Notif al reporter (víctima) confirmando reporte + número de caso CAS-XXXX-XXXX.
4. Return `redirect('/casos/[publicCode]')`.

### 5.4 Render del case detail con subject=unowned

`/casos/[publicCode]` (Fase E del cases plan) tiene que renderizar el case-card del §4 del cases plan. Para `unowned_animal`:

```
┌──────────────────────────────────────────────────────────────┐
│  [icon placeholder 🐕]   Animal sin identificar              │
│                          Perro · macho · ~3 años · grande    │
│                          Marrón con blanco, cola corta       │
│                          Reportado por Patricia López el     │
│                          2026-05-19 17:30                    │
│                          → Reasignar a pet real (govt/admin) │
└──────────────────────────────────────────────────────────────┘
```

El botón "Reasignar a pet real" solo aparece para govt/admin scope-matching. UI del reassignment en §6.

---

## 6. Reassignment flow — govt/admin manual

### 6.1 Trigger

Botón "Reasignar a pet real" en el case detail (`/casos/[publicCode]`) para govt o admin con scope.

### 6.2 UI

Modal / drawer:

```
Reasignar caso CAS-XK3P a una pet real

Buscar pet por:
  [microchip] [____________] [Buscar]
  [DIM token] [____________] [Buscar]
  [DNI del dueño] [____________] [Buscar]
  [Nombre / barrio] [____________] [Buscar]

→ Resultados:
  ┌─────────────────────────────────────────┐
  │ 🐕 Roco (perro, macho, ~4 años)         │
  │    Microchip: 941-000xxxxxxxx            │
  │    Dueño: Federico G. · CABA, Boedo     │
  │    [Reasignar a esta pet]               │
  └─────────────────────────────────────────┘

Motivo de reasignación (obligatorio, min 20 chars):
[textarea]

[Cancelar] [Confirmar reasignación]
```

### 6.3 Server action — `reassignBiteCaseAction`

1. Verificar role: solo govt scope-matching o admin.
2. Verificar `case.case_kind='bite_incident'` Y `case.primary_subject_kind='unowned_animal'`.
3. TX:
   - UPDATE `cases` SET `primary_subject_kind='registered_pet'`, `primary_pet_id=<new>`. NO modificar `temporary_pet_description_id` (preserva linkback histórico).
   - UPDATE `temporary_pet_descriptions` SET `replaced_at=now()`, `replaced_by_pet_id=<new>`, `replaced_by_user_id=<actor>`.
   - INSERT `pet_events` `note_added` con `case_id=<case>`, `pet_id=<new>` (no null, porque ahora hay pet), `payload.category='system'`, `payload.scope='internal_govt'`, `payload.text='Caso reasignado de pet temporal a pet real por {actor.name}. Motivo: {reason}.'`.
   - Si la pet real tiene `rabies_observation_status IS NULL` Y la observación del caso sigue abierta → UPDATE `pets.rabies_observation_status='in_progress'` (sincronizar denorm flag con el case open).
   - Notif al owner de la pet real con severity `urgent`: "Tu mascota [name] fue identificada en un caso de bite_incident reportado el [date]. Está bajo observación antirrábica hasta [date+10]. Detalles: {link}."
   - Notif al govt actor + admin como audit.
4. Redirect al case detail actualizado.

### 6.4 Permisos finos

- Owner de la pet recién reasignada NO puede deshacer la reasignación. Si tiene quejas, abre denuncia welfare contra el reporte erróneo (otro flow).
- Reasignación es **irreversible** (no hay UN-reassign action). Si el govt se equivoca, abre caso nuevo + cierra el viejo con `closed_reason='cancelled', note explaining error'`.

---

## 7. Reconciliation hook on signup (DNI matching)

### 7.1 Trigger

En el server action de signup (`createUserAction` o similar — verificar exacto), después de que el profile se crea con `dni_number` Y `dni_verified=true` (post-Mi-Argentina o post-DNI-verification provider):

```ts
// app/actions/auth.ts (extender)
async function checkReconciliationOnSignup(userId: string, dni: string) {
  // Buscar temp pets con DNI matching
  const tempPets = await db
    .select({
      temp: temporaryPetDescriptions,
      case: cases,
    })
    .from(temporaryPetDescriptions)
    .innerJoin(cases, eq(cases.id, temporaryPetDescriptions.caseId))
    .where(and(
      eq(temporaryPetDescriptions.ownerDniClaimed, dni),
      isNull(temporaryPetDescriptions.replacedAt),
      // caso podría estar abierto o cerrado — incluir ambos en v1
    ));

  if (tempPets.length === 0) return;

  // Insertar 1 notification que lista todos los matches
  await createNotification({
    userId,
    notificationType: 'bite_case_reconciliation_proposal',
    title: `${tempPets.length} caso(s) de mordedura mencionan tu DNI`,
    body: `Detectamos ${tempPets.length} caso(s) de bite_incident donde alguien declaró tu DNI como el del dueño del animal. Si fue tu mascota, vinculá los casos a tu pet real para que el sistema mantenga el historial completo.`,
    severity: 'info',
    ctaLabel: 'Revisar casos',
    ctaUrl: '/cuenta/reconciliacion-bites',
    // relatedCaseId: undefined — la notif agrupa varios, ver list en /cuenta/reconciliacion-bites
  });
}
```

### 7.2 UI — `/cuenta/reconciliacion-bites`

Lista de cases con descripción de temp pet + form de match a una pet del usuario:

```
Reconciliación pendiente

CAS-XK3P · Mordedura del 2026-05-19 17:30 en CABA, Belgrano
Descripción: Perro macho marrón con blanco, cola corta, ~3 años
Reportado por: Patricia López

  ¿Es alguna de tus mascotas?
  ( ) 🐕 Roco (perro, macho, 4 años)
  ( ) 🐕 Lassie (perra, hembra, 7 años)
  ( ) No es ninguna mía / no es mi caso

  [Confirmar]

──────────────────────────────────────────

CAS-9DLM · ...
```

### 7.3 Confirm action

Server action `confirmBiteReconciliationAction`:

1. Si el user selecciona una pet propia → mismo flow que reassignBiteCaseAction (con `actor.role='owner'` en el note).
2. Si elige "No es ninguna mía" → mark notification archived; opcionalmente UPDATE `temporary_pet_descriptions` con flag `owner_disputed_at` (campo nuevo opcional para auditing).
3. Notif al govt scope-matching: "El DNI claimed por la víctima fue verificado por el dueño matchado — caso ahora apunta a [pet real]" (o "El DNI matchado en signup negó haber sido dueño del animal denunciado").

### 7.4 Edge cases

- DNI matched pero el user no tiene mascotas → mostrar "Registrá una mascota nueva con esta descripción" → form de pet pre-llenado con datos del temp pet.
- Multiple temps con el mismo DNI → procesar en bulk pero confirmar cada uno individualmente.
- Temp pet ya reasignada por govt antes del signup → el matching no devuelve esa row (filter `replaced_at IS NULL`).

---

## 8. Lifecycle del bite_incident con subject=unowned

(Update al lifecycles spec §5.)

### 8.1 Estados

Mismos: `open`, `escalated`, `closed`.

### 8.2 Phases

Igual al bite_incident registered, salvo:

- `observation_open`: NO chequeo de `pets.rabies_observation_status` (no aplica). Solo el case status open + rabies_observation_started present + no closed.

### 8.3 Cierre

- Cron `close-rabies-observations` itera **también** sobre cases con subject_kind=`unowned_animal`. Branch: si `case.primary_pet_id IS NULL` → emit close event con `pet_id=NULL` + `case_id` + outcome=negative. Sin UPDATE de `pets.rabies_observation_status` (no hay pet).

### 8.4 Visibility tweaks

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| reporter (víctima, opened_by_user_id) | ✅ | full (su reporte) | reducido (govt, no info de potential owner) | ✅ | ✅ |
| govt_in_scope | ✅ | full | full | ✅ | ✅ |
| admin | ✅ | full | full | ✅ | ✅ |
| dni-matched-user (post-signup) | hasta que confirma reconciliation: ❌. Post-confirm como `subject_owner`: idem caso normal | — | — | — | — |

---

## 9. Tests

### 9.1 Schema constraints

```ts
it('temporary_pet_descriptions requires case_id FK');
it('CHECK: replaced_at <-> replaced_by_pet_id consistency');
it('pet_events.pet_id puede ser NULL solo si case.primary_subject_kind != registered_pet');
```

### 9.2 Action behaviors

```ts
// reportBiteFromUnownedAction
it('si paso 1 resuelve a registered_pet → llama a reportBiteAction normal, NO crea temp');
it('si paso 1 no resuelve → crea temp + case + 2 events atómico');
it('si user no autenticado → 401');

// reassignBiteCaseAction
it('govt scope-match puede reasignar');
it('owner del pet target NO puede reasignar');
it('reasignación: UPDATE case + UPDATE temp.replaced + INSERT note + notif');
it('reasignación de caso ya cerrado → permitida (audit)');

// checkReconciliationOnSignup
it('signup con DNI matching temp pet → notif al user con N matches');
it('signup sin DNI matching → no notif');
it('signup con DNI matching pero temps ya replaced → no notif');

// confirmBiteReconciliationAction
it('user elige pet propia → flow reassignBiteCase con actor.role=owner');
it('user elige "no es mía" → archiva notif + flag opcional disputed');
```

### 9.3 Integration / E2E

```ts
it('flow completo: víctima reporta unowned → caso open → govt reasigna a pet real → owner ve la notif urgent + observation_status flippea');
it('flow completo: víctima reporta con DNI → otro user se registra con ese DNI → recibe notif → confirma vincular a su pet → caso reasignado automáticamente sin pasar por govt');
```

---

## 10. Open questions

- **Reporting anon (sin auth)** — diferido a v1.1. Cuando se haga, mismo patrón que welfare anon: form público + DEN-style tracking code + rate limit. La barrera de v1 (auth required) es deliberada.
- **Pet temporal con embargo de identidad** — escenario: la víctima sabe que el dueño es persona pública / cuestionada y quiere proteger su identidad. ¿El form debería tener checkbox "ocultar DNI declarado a govt"? Tendencia v1: NO — el DNI es info útil que govt podría necesitar para investigación; ocultarlo sería contraproducente. Si la víctima no quiere comprometer al dueño, simplemente no escribe el DNI.
- **Bulk reconciliation** — el govt podría querer mass-reassign N temp pets que claramente coinciden con la pet recién registrada de un nuevo user. UI: añadir checkbox de selección múltiple en una lista de queue específica `/gob/mordedura-temp-pets`. Defer a v1.1.
- **Notification al "DNI claimed" sin cuenta** — BU8 dice NO notificar antes de que tengan cuenta. Pero podríamos enviar invitación legal por canal externo (mail físico si tenemos dirección, sms si tenemos teléfono) en casos graves. Defer; involves canales no-MiMAR.
- **`unowned_animal` outbreak escalation** — BU11 dice no auto-escalation. ¿Vale la pena que govt manualmente pueda forzar escalation desde el case detail si percibe risk? Tendencia: SÍ, pero como acción explícita govt — agregar botón "Escalar a urgent" en case detail para govt.
- **Cross-reporting** — varios reporters víctimas del mismo perro pueden generar múltiples temp pets distintos. Hay risk de duplicación. Govt podría tener una vista que clusterea descripciones similares + ubicación cercana. Defer a v1.1 — herramienta de welfare-officer queue.
- **Borrado de temp pet post-reconciliation** — BU3 dice "no se borra, audit". ¿Algún día se archiva físicamente? Tendencia: retenerlas indefinidamente como evidence legal (Ley 14.346).

---

## 11. Out of scope (v1)

- Reporting anónimo (sin auth) — diferido
- Bulk reconciliation queue para govt
- Notif a DNIs sin cuenta MiMAR por canales externos
- Cross-incident deduplication automatic
- Custodia / decomiso del animal vía caso temporal (si govt va al barrio y secuestra al perro, se modela como nuevo `shelter_intake_recorded` con `from_role='street_stray'` — pet pasa a refugio, después se podría reconciliar con el bite case original via reassignment)
- Auto-link cross-cases por chip si el mismo perro muerde de nuevo en otra ubicación (tema de surveillance — outbreak_investigation se podría usar pero out of scope acá)

---

## 12. Implementation order — sugerencia

Para plan separado posterior:

1. **Fase 1 — Schema** (tabla temp + case extension + nullable pet_id constraint + indexes). ~½ día.
2. **Fase 2 — `reportBiteFromUnownedAction`** + UI wizard `/incidentes/mordedura-recibida`. ~2 días.
3. **Fase 3 — Case detail render con subject=unowned** (override del card según attachment spec §4). ~1 día.
4. **Fase 4 — `reassignBiteCaseAction`** + UI modal govt. ~1 día.
5. **Fase 5 — Reconciliation hook on signup** + `/cuenta/reconciliacion-bites` UI + `confirmBiteReconciliationAction`. ~2 días.
6. **Fase 6 — Cron extension** para soportar unowned (close-rabies-observations branch). ~½ día.
7. **Fase 7 — Tests + docs update** (cases spec lifecycles + bite-rabies spec mencionando el cross-ref). ~1 día.

Total: ~8 días. Plan ejecutable separado cuando se priorice (recomendado: ejecutar DESPUÉS del sistema de casos base).
