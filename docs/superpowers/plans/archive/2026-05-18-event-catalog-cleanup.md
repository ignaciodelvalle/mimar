# Event catalog cleanup + coverage discipline + patterns documentation

> Plan ejecutable para Claude Code. Limpieza estructural del catálogo `EVENT_TYPES`: borra eventos redundantes (subsumidos por `clinical_info_logged`), refactorea bite events para vivir adentro de `incident_reported` con sub_kind, agrega eventos nuevos (adoption_withdrawn, custody_dispute_*, microchip_replaced/revoked), deprecada `adoption_application_reviewed`, introduce columna `pets.in_custody_dispute`, agrega CI test de cobertura `EVENT_TYPES ↔ PayloadSchemas`, refresca el Event catalog en AGENTS.md y documenta los cuatro cross-cutting patterns de event design. Actualiza spec/plan de bite-rabies-observation para usar `incident_reported`.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Tamaño:** 1 migración SQL (chica), ~6 archivos de código tocados, 1 test nuevo, AGENTS.md refresh, 2 specs y 1 plan refactoreados, README touch
> **Estimación:** ~1 día / 6-8 horas

---

## 0. Antes de tocar nada

Lectura obligatoria:

1. **`AGENTS.md` → Event catalog (sección "Event catalog — 23 types")** — la lista actual de event_types. Vas a borrar 4, deprecar 1, agregar 5. Y refactorear el shape de bite events
2. **`db/schema.ts → EVENT_TYPES`** — la const con los strings. Source of truth de qué event_types existen
3. **`lib/event-schemas.ts`** — los Zod schemas + `PayloadSchemas` registry. Vas a borrar 4 schemas, agregar 5, extender 1 (`incident_reported`), agregar 1 nuevo (`custody_dispute_resolved`)
4. **`lib/libreta-sanitaria.ts`** — `LIBRETA_SANITARIA_EVENT_TYPES` y `NON_LIBRETA_EVENT_TYPES`. Hay que sincronizar con el catálogo nuevo (sacar los 4 borrados, agregar/clasificar los 5 nuevos, mover bite del catálogo independiente a "ahora vive en incident_reported")
5. **`__tests__/event-schemas.test.ts`** (o donde estén los tests de schemas) — vas a extender con un test nuevo de cobertura
6. **`docs/superpowers/specs/2026-05-18-bite-rabies-observation-design.md`** y **`docs/superpowers/plans/2026-05-18-bite-rabies-observation.md`** — referencias a `bite_inflicted` como event_type. Refactoreás para que use `incident_reported` con `incident_type='bite_inflicted'`
7. **`docs/legal-framework-full.md`** — confirmé en pre-research que NO hay obligación legal de warning automático de vacunación. La obligación es del owner. `vaccination_due_warning` queda como future spec (no se implementa acá)

**Antes de empezar**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes en main. Si hay rojos pre-existentes, parar y avisar.

## 1. Qué construye este plan

Diez pasos, cada uno un commit:

**Paso 1 — CI coverage test.** Test Vitest que itera `EVENT_TYPES` y para cada valor asserta que existe entry en `PayloadSchemas` (y vice-versa). Foundational — protege contra todos los cambios futuros donde alguien agrega un event_type y olvida el schema.

**Paso 2 — Delete 4 redundant event types**. Sacar de `EVENT_TYPES`, `PayloadSchemas`, y `LIBRETA_SANITARIA_EVENT_TYPES`:
- `lab_work_performed`
- `imaging_performed`
- `surgery_performed`
- `allergy_detected`

Todos quedan subsumidos por `clinical_info_logged` con su sub_kind discriminator. Filas históricas en DB se preservan (events son inmutables) — solo borramos del const + schema.

**Paso 3 — Refactor bite events into `incident_reported`.** En lugar de event_type propio `bite_inflicted`, los bites son `incident_reported` con `incident_type IN ('bite_inflicted', 'bite_suffered')`. Extender el Zod schema de `incident_reported` con campos opcionales para bite. Deprecar `dog_attack` en el enum (queda como alias semántico de `bite_suffered`).

**Paso 4 — Add 5 new event types.** Agregar a `EVENT_TYPES` + schemas + clasificación:
- `adoption_withdrawn` (libreta no, custody)
- `custody_dispute_raised` (libreta no, system)
- `custody_dispute_resolved` (libreta no, system)
- `microchip_replaced` (libreta sí)
- `microchip_revoked` (libreta sí)

**Paso 5 — Deprecate `adoption_application_reviewed`.** Borrar de `EVENT_TYPES` y schemas (status de la application cubre el momento "en revisión"; el event intermedio era ruido).

**Paso 6 — Add `pets.in_custody_dispute` column.** Migración chica. Boolean default false. Se setea true en `custody_dispute_raised`, false en `custody_dispute_resolved`. Vía dual-write desde server actions futuros (acá solo el schema; los server actions van en plan separado cuando se implemente el flow).

**Paso 7 — Update bite-rabies-observation spec/plan.** Tres find/replace en el spec + plan: `bite_inflicted` event_type → `incident_reported` con `incident_type='bite_inflicted'`. Ajustar el Zod schema de `rabiesObservationStarted.payload.bite_event_id` (sigue siendo uuid, semántica intacta — solo el evento referenciado cambia de tipo).

**Paso 8 — Refresh libreta-sanitaria classification.** Después de borrar/agregar, los tests de cobertura de `lib/libreta-sanitaria.test.ts` deben seguir pasando. Lista actualizada en este paso.

**Paso 9 — AGENTS.md → Event catalog section refresh.** Reescritura completa de la sección "Event catalog — 23 types" reflejando el nuevo estado (count cambia, deprecaciones explícitas, nuevos events documentados).

**Paso 10 — AGENTS.md → cross-cutting patterns subsection.** Nueva subsección dentro de "Event sourcing" documentando los cuatro patterns recurrentes:
1. `*_started` / `*_ended` pairs con auto-close cron
2. `*_signal` system-emitted con severity/audit
3. `*_proposed` / `*_executed` two-phase con lazy auto-cancel
4. `*_reported` umbrella con sub_kind discriminator

Más README touch reflejando que este plan está done.

## 2. Decisiones cerradas (acordadas con Nacho)

| # | Decisión | Notas |
|---|---|---|
| D1 | **`clinical_info_logged` manda.** Los cuatro `lab_work_performed`, `imaging_performed`, `surgery_performed`, `allergy_detected` se borran del catálogo. Subsumidos por sub_kind de clinical_info_logged | Filas históricas en DB se quedan (immutable). El borrado es del const + Zod. Si alguna fila vieja existe, sus reads siguen funcionando porque `eventPayloadSummary` tiene catch-all |
| D2 | **Bite events son `incident_reported`** con `incident_type IN ('bite_inflicted', 'bite_suffered')`. No event_type propio | Reduce surface de events. El payload de incident_reported gana campos opcionales bite-específicos. La diferencia funcional (rabies observation solo para bite_inflicted) vive en la lógica del server action que lee `payload.incident_type` |
| D3 | **`dog_attack` (existente en incident_type enum) se deprecada** a favor de `bite_suffered` que es más claro semánticamente | Se mantiene como string válido en el enum por back-compat de filas históricas. Documentación nota que nuevos writers usan `bite_suffered` |
| D4 | **`adoption_withdrawn` se agrega** (event type). El aplicante retira su solicitud. NON-libreta (custody flow), libreta-no | Reemplaza el uso de `note_added` con category especial que el spec de adoption usaba |
| D5 | **`custody_dispute_raised` y `custody_dispute_resolved` se agregan**. Admin o govt pueden raisedispute. Cambia el estado de la mascota via columna nueva `pets.in_custody_dispute`. NON-libreta (system) | El dispute es legal externo, no clínico. Pero queda en el log del pet para que el dueño futuro entienda el contexto |
| D6 | **`microchip_replaced` y `microchip_revoked` se agregan**. Cuando se cambia un chip o se invalida uno. LIBRETA-sanitaria (es info clínica/identificatoria) | Edge case pero real (chip dañado, lectura imposible) |
| D7 | **`adoption_application_reviewed` se deprecada**. Status de la app cubre el "en revisión" sin necesidad de event intermedio | Mismo tratamiento que las 4 borradas: filas históricas se mantienen, nuevos writers no lo emiten |
| D8 | **`pets.in_custody_dispute` boolean column** con default false. Set true en raised, false en resolved. Servirá como flag UX en surfaces (banner "este pet está en disputa legal, ciertas acciones bloqueadas") | El "ciertas acciones bloqueadas" se diseña en flow propios (transfer custody, adoption finalize, etc.) — este plan solo agrega el column + events. La política de qué se bloquea va en planes posteriores |
| D9 | **`vaccination_due_warning` NO se implementa**. Pre-research del legal-framework-full.md confirma que no hay obligación legal del sistema de avisar (la obligación es del owner de mantener vigente). Future spec si UX lo justifica | Documentar la decisión en AGENTS.md → Open questions para que no se relitigue |
| D10 | **CI coverage test es no-negociable**. Bloquea merge de cualquier event_type sin schema correspondiente. Mismo patrón que el test de cobertura libreta-sanitaria existente | Es el cierre del gap conceptual entre "EVENT_TYPES const promete one-line-edit" y "validación efectiva" |

## 3. Scope

**Dentro:**
- Modificación de `db/schema.ts → EVENT_TYPES` (borrar 5, agregar 5)
- Modificación de `lib/event-schemas.ts` (borrar 5 schemas, agregar 5, extender `incidentReported`)
- Modificación de `lib/libreta-sanitaria.ts` (sincronizar clasificación)
- Test nuevo `__tests__/event-catalog-coverage.test.ts` (o donde haya tests de schema)
- Migración SQL chica para `pets.in_custody_dispute`
- Update de `docs/superpowers/specs/2026-05-18-bite-rabies-observation-design.md`
- Update de `docs/superpowers/plans/2026-05-18-bite-rabies-observation.md`
- Update de `AGENTS.md` (Event catalog refresh + nueva subsección de patterns)
- Update de `docs/superpowers/README.md` (mark este plan como done cuando termine)

**Fuera:**
- Cualquier UI nueva (no hay forms para `adoption_withdrawn`, `custody_dispute_*`, `microchip_replaced/revoked` en este plan — es solo schema + patterns)
- Server actions para los nuevos events (cuando se diseñen los flows correspondientes, vienen en planes propios)
- La política de bloqueo de acciones cuando `in_custody_dispute=true` (cada feature que la respete lo decide cuando se diseña)
- `vaccination_due_warning` (defer)
- Borrar physically las filas históricas con event_types deprecated (events son inmutables — nunca se borran)
- Implementación del feature de bite/rabies (sigue en su propio plan, solo se refactorea para usar incident_reported)

## 4. Plan paso a paso

### Paso 1 — CI coverage test

Crear `__tests__/event-catalog-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@/db/schema";
import { PayloadSchemas } from "@/lib/event-schemas";

describe("EVENT_TYPES <-> PayloadSchemas coverage", () => {
  it("every EVENT_TYPES value has a registered PayloadSchema", () => {
    const schemaKeys = new Set(Object.keys(PayloadSchemas));
    const missing: string[] = [];
    for (const eventType of EVENT_TYPES) {
      if (!schemaKeys.has(eventType)) missing.push(eventType);
    }
    expect(
      missing,
      `EVENT_TYPES sin schema en PayloadSchemas. Agregalos a lib/event-schemas.ts:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("every PayloadSchemas key is a valid EventType", () => {
    const eventTypesSet = new Set<string>(EVENT_TYPES);
    const orphan: string[] = [];
    for (const key of Object.keys(PayloadSchemas)) {
      if (!eventTypesSet.has(key)) orphan.push(key);
    }
    expect(
      orphan,
      `PayloadSchemas con keys que no están en EVENT_TYPES. Borralos de lib/event-schemas.ts o agregalos a EVENT_TYPES:\n${orphan.join("\n")}`,
    ).toEqual([]);
  });
});
```

**Importante:** este test va a FALLAR antes de hacer los demás pasos porque hay 4 schemas (lab_work_performed, etc.) sin event_type correspondiente DESPUÉS de borrarlos en Paso 2. El test pasa cuando todos los pasos están aplicados consistentemente. **Hacé los pasos atómicamente — si separás los commits, asegurate que en cada checkpoint el test pasa.**

### Paso 2 — Delete 4 redundant clinical events

#### Paso 2.1 — `db/schema.ts`

Buscar en la const `EVENT_TYPES` y borrar las 4 líneas:
- `"lab_work_performed"`
- `"imaging_performed"`
- `"surgery_performed"`
- `"allergy_detected"`

#### Paso 2.2 — `lib/event-schemas.ts`

Borrar:
- La const `labWorkPerformed` (si existe — verificar nombres exactos)
- La const `imagingPerformed`
- La const `surgeryPerformed`
- La const `allergyDetected`

Y borrar sus entries del record `PayloadSchemas`.

#### Paso 2.3 — `lib/libreta-sanitaria.ts`

Si los 4 estaban en `LIBRETA_SANITARIA_EVENT_TYPES`, sacarlos. Si en `NON_LIBRETA_EVENT_TYPES`, sacarlos. Match exacto del nombre.

#### Paso 2.4 — Verificación intra-step

`pnpm typecheck` debería pasar (no hay otros usos de esos schemas en el repo — el spec libreta los nombra pero solo conceptualmente). Si hay typecheck error, identificar el call site y migrarlo a `clinical_info_logged`.

#### Commit Paso 2

```
chore(events): delete 4 redundant event types subsumed by clinical_info_logged

Removes lab_work_performed, imaging_performed, surgery_performed,
allergy_detected from EVENT_TYPES, PayloadSchemas, and
LIBRETA_SANITARIA_EVENT_TYPES classification.

These four were schema-defined but had no active writers — the
clinical_info_logged event with sub_kind discriminator
('lab_work' | 'imaging' | 'surgery' | 'allergy_detection' | 'other')
fully subsumes their semantics.

Historical pet_events rows with these types (if any exist in seeded
test data) are NOT touched — events are immutable. Read paths in
eventPayloadSummary already have a catch-all default branch, so old
rows continue to render.
```

### Paso 3 — Refactor bite events into `incident_reported`

#### Paso 3.1 — Extender el Zod schema de `incident_reported`

En `lib/event-schemas.ts`, encontrar `incidentReported` (el schema existente). Reemplazar por:

```ts
const incidentReported = z
  .object(
    withVersion({
      // Sub_kind discriminator
      incident_type: z.enum([
        "bite_inflicted",       // this pet bit someone (triggers rabies observation)
        "bite_suffered",        // this pet was bitten by another animal
        "dog_attack",           // DEPRECATED — kept for back-compat, equivalent to bite_suffered
        "fight",
        "traffic_accident",
        "fall",
        "poisoning",
        "escape",
        "other",
      ]),
      severity: z.enum(["minor", "moderate", "severe"]).nullable(),
      injuries_summary: z.string().nullable(),
      vet_involved: z.boolean().nullable(),
      // Optional location
      location_description: z.string().nullable().optional(),
      // Bite-specific fields (present only when incident_type is bite_*)
      victim_kind: z.enum(["human", "animal", "unknown"]).nullable().optional(),
      victim_contact_name: z.string().nullable().optional(),
      victim_contact_phone: z.string().nullable().optional(),
      victim_pet_id: z.string().uuid().nullable().optional(),
      victim_age_estimate: z.string().nullable().optional(),
      context: z.string().nullable().optional(),
      rabies_vaccine_valid_at_incident: z.boolean().nullable().optional(),
      reporter_role: z.enum(["owner", "vet", "shelter", "govt", "witness"]).nullable().optional(),
    }),
  )
  .strict();
```

#### Paso 3.2 — Verificar que NO existe schema `biteInflicted`

El spec/plan de bite-rabies-observation mencionaba un schema `biteInflicted`. **Como nunca se implementó (el feature está en spec/plan, no en código)**, el schema no existe físicamente. Verificá en `lib/event-schemas.ts` que no aparece. Si por alguna razón aparece (e.g., alguien empezó la implementación y commiteó el schema solo), borralo.

#### Paso 3.3 — Verificar que `bite_inflicted` NO está en `EVENT_TYPES`

Mismo razonamiento. Verificá. Si está, sacalo.

#### Commit Paso 3

```
refactor(events): bite events live inside incident_reported

Bite events are now incident_reported with incident_type in
('bite_inflicted', 'bite_suffered'), not separate event types.
Reduces the surface of EVENT_TYPES while preserving full semantics
via the existing discriminator pattern.

Extends incidentReported Zod schema with optional bite-specific
fields (victim_kind, victim_contact_*, victim_pet_id,
rabies_vaccine_valid_at_incident, reporter_role, context,
location_description). All optional — back-compat with non-bite
incidents.

Marks 'dog_attack' as deprecated in the incident_type enum — kept
for back-compat with historical rows; new writers use 'bite_suffered'
which is unambiguous about who's the victim.

The bite-rabies-observation spec/plan is updated separately in this
PR set (paso 7) to use incident_reported throughout.
```

### Paso 4 — Add 5 new event types

#### Paso 4.1 — `EVENT_TYPES` const

Agregar al array:
- `"adoption_withdrawn"`
- `"custody_dispute_raised"`
- `"custody_dispute_resolved"`
- `"microchip_replaced"`
- `"microchip_revoked"`

Agruparlos donde tenga más sentido contextualmente (custody con los otros custody, microchip con los otros microchip).

#### Paso 4.2 — Zod schemas

Agregar a `lib/event-schemas.ts`:

```ts
const adoptionWithdrawn = z
  .object(
    withVersion({
      application_event_id: z.string().uuid(), // FK to adoption_application_submitted
      withdrawn_by_user_id: z.string().uuid(),
      reason: z.string().nullable(),
    }),
  )
  .strict();

const custodyDisputeRaised = z
  .object(
    withVersion({
      raised_by_role: z.enum(["admin", "govt"]),
      raised_by_user_id: z.string().uuid(),
      external_proceeding_reference: z.string().nullable(), // e.g., expediente number
      reason: z.string(),
    }),
  )
  .strict();

const custodyDisputeResolved = z
  .object(
    withVersion({
      raised_event_id: z.string().uuid(), // FK to custody_dispute_raised
      resolved_by_role: z.enum(["admin", "govt"]),
      resolved_by_user_id: z.string().uuid(),
      outcome: z.enum(["ownership_confirmed", "ownership_transferred", "case_dismissed", "other"]),
      notes: z.string().nullable(),
    }),
  )
  .strict();

const microchipReplaced = z
  .object(
    withVersion({
      previous_chip_number: z.string(),
      new_chip_number: z.string(),
      reason: z.enum(["damaged", "unreadable", "duplicate_detected", "other"]),
      replaced_by: z.string().nullable(), // vet name
      replaced_at: z.string(), // ISO date
    }),
  )
  .strict();

const microchipRevoked = z
  .object(
    withVersion({
      chip_number: z.string(),
      reason: z.enum(["fraud_detected", "owner_request", "device_failure", "other"]),
      revoked_by_role: z.enum(["admin", "govt", "vet"]),
      revoked_by_user_id: z.string().uuid(),
      notes: z.string().nullable(),
    }),
  )
  .strict();
```

Registrar las 5 en `PayloadSchemas` record.

#### Paso 4.3 — Clasificación libreta-sanitaria

En `lib/libreta-sanitaria.ts`:

- `adoption_withdrawn` → `NON_LIBRETA_EVENT_TYPES` (custody/admin, no clínico)
- `custody_dispute_raised` → `NON_LIBRETA_EVENT_TYPES` (legal externo)
- `custody_dispute_resolved` → `NON_LIBRETA_EVENT_TYPES`
- `microchip_replaced` → `LIBRETA_SANITARIA_EVENT_TYPES` (info identificatoria/clínica)
- `microchip_revoked` → `LIBRETA_SANITARIA_EVENT_TYPES`

#### Commit Paso 4

```
feat(events): add 5 new event types for custody, adoption, microchip lifecycle

- adoption_withdrawn: applicant retires their adoption application
- custody_dispute_raised: admin/govt flags external legal proceeding
- custody_dispute_resolved: closes the dispute with outcome
- microchip_replaced: existing chip is replaced (damage, etc.)
- microchip_revoked: chip is invalidated (fraud, owner request, etc.)

All registered in EVENT_TYPES, PayloadSchemas, and libreta-sanitaria
classification. The CI coverage test (added in Paso 1) keeps these in
sync going forward.

custody_dispute_* events change pet state via pets.in_custody_dispute
column added in paso 6.
```

### Paso 5 — Deprecate `adoption_application_reviewed`

#### Paso 5.1 — `EVENT_TYPES` const

Borrar `"adoption_application_reviewed"` del array.

#### Paso 5.2 — `lib/event-schemas.ts`

Borrar la const `adoptionApplicationReviewed` (verificar nombre exacto) y su entry de `PayloadSchemas`.

#### Paso 5.3 — `lib/libreta-sanitaria.ts`

Sacar de `NON_LIBRETA_EVENT_TYPES` (asumiendo que estaba ahí; si estaba en libreta sacarlo de libreta).

#### Paso 5.4 — Buscar usos en el código

Probablemente no hay writers — verificá con `rg "adoption_application_reviewed"`. Si aparece en código (no en docs), migrar a usar status de la application directamente, o usar `note_added` con category descriptiva.

#### Commit Paso 5

```
chore(events): deprecate adoption_application_reviewed

The intermediate "reviewed" state was never written by any flow —
status field on the adoption application table captures the
"in review" stage without needing an explicit event. Removed from
EVENT_TYPES, PayloadSchemas, and libreta classification.

Historical rows with this event_type (if any) remain in pet_events.
eventPayloadSummary catch-all handles their display.
```

### Paso 6 — Add `pets.in_custody_dispute` column

#### Paso 6.1 — Migración SQL

Crear `db/migrations/NNNN_pets_custody_dispute.sql`:

```sql
-- Adds pets.in_custody_dispute flag. Set true on custody_dispute_raised event,
-- false on custody_dispute_resolved. Dual-written from server actions when
-- those flows are implemented. Today, the column exists and defaults to false
-- so existing pets are unaffected.

alter table public.pets
  add column if not exists in_custody_dispute boolean not null default false;

create index if not exists pets_in_custody_dispute_idx
  on public.pets (in_custody_dispute)
  where in_custody_dispute = true;

comment on column public.pets.in_custody_dispute is
  'True while pet is in external legal custody proceedings. Set by custody_dispute_raised event (admin or govt initiated), unset by custody_dispute_resolved.';

-- Reverse:
-- drop index if exists pets_in_custody_dispute_idx;
-- alter table public.pets drop column in_custody_dispute;
```

Aplicar via Studio.

#### Paso 6.2 — Drizzle model

En `db/schema.ts`, en el model `pets`, agregar:

```ts
inCustodyDispute: boolean("in_custody_dispute").notNull().default(false),
```

#### Commit Paso 6

```
feat(pets): add in_custody_dispute boolean column

True while pet is in external legal custody proceedings (parental
divorce, succession, criminal seizure with eventual return). Default
false. Partial index on true for fast queries of disputed pets.

Set by custody_dispute_raised event (admin or govt initiated),
unset by custody_dispute_resolved. The server actions that emit
these events are NOT in this PR — only the column + schema are.
When the dispute workflow is designed, server actions dual-write
this column alongside the events.

Features that should respect the flag (block transfers, block
adoption finalize, block scheduling on behalf of the disputed
pet, etc.) are designed per-feature when they emerge.
```

### Paso 7 — Update bite-rabies-observation spec/plan

#### Paso 7.1 — Update spec

En `docs/superpowers/specs/2026-05-18-bite-rabies-observation-design.md`:

1. **Header (versión)**: bump a v1.1, agregar nota: *"v1.1 — refactor: bites se modelan como `incident_reported` con `incident_type='bite_inflicted'`. Reemplaza v1.0 que tenía event_type propio."*

2. **§4.1 — extender EVENT_TYPES**: borrar la línea `"bite_inflicted",` (ya no se agrega como event_type propio). Quedan solo:
   - `"rabies_observation_started"`
   - `"rabies_observation_ended"`

3. **§4.2 — Zod schemas**: borrar el bloque `const biteInflicted = z.object(...)`. El schema de `incident_reported` ya tiene los campos bite (paso 3 de este plan agregó esa extension). En su lugar agregar nota:
   > **Nota:** Los bite events viven dentro de `incident_reported` con `incident_type='bite_inflicted'`. El Zod schema de `incident_reported` (en `lib/event-schemas.ts`) tiene los campos bite-específicos como optional. Ver paso 3 del plan `event-catalog-cleanup` para detalle del schema extendido.

4. **§4.2 — `rabies_observation_started` schema**: el campo `bite_event_id` sigue siendo `uuid` — semántica intacta. Solo cambia que el evento referenciado es ahora `incident_reported` con `incident_type='bite_inflicted'` en lugar de `bite_inflicted` standalone.

5. **§5 (flows)**: en cada mención de "insert bite_inflicted event", reemplazar por "insert incident_reported event con `incident_type='bite_inflicted'`". El payload tiene los mismos campos solo que vive adentro del incident_reported schema.

6. **§5.1 owner self-report**: el server action que recibe el form ahora inserta `incident_reported` en lugar de `bite_inflicted`. Pseudocódigo update:
   ```
   const incidentPayload = validateEventPayload("incident_reported", {
     incident_type: "bite_inflicted",
     severity, ... (resto del payload)
   });
   await tx.insert(petEvents).values({
     petId, eventType: "incident_reported", payload: incidentPayload, ...
   });
   ```

7. **§5.4.2 surveillance escalation**: el query que busca "bite event activo" cambia de `eventType='bite_inflicted'` a `eventType='incident_reported' AND payload->>'incident_type'='bite_inflicted'`. Document este detalle en el spec.

8. **§5.5 cron auto-cierre**: idem — busca el evento iniciador via incident_type filter.

9. **§9 RLS y §13 phasing**: ajustar referencias de "bite_inflicted event" a "incident_reported con bite type" donde aplique.

10. **§4.3 (clasificación libreta)**: `bite_inflicted` ya no existe como event_type, sale de la lista. `rabies_observation_started/ended` siguen igual. `incident_reported` ya está clasificado (era libreta antes de este refactor? Verificar — probablemente libreta, ya que es info clínica del pet). Si `incident_reported` está como libreta-sanitaria, los bite events automáticamente lo son.

11. **Cualquier referencia a "bite_inflicted event_type"**: find/replace por la frase "incident_reported con bite type" para mantener coherencia textual.

#### Paso 7.2 — Update plan

En `docs/superpowers/plans/2026-05-18-bite-rabies-observation.md`:

1. **Header (tamaño)**: ajustar — ahora son 2 event types nuevos (rabies_observation_started/ended), no 3, porque bite_inflicted vive adentro de incident_reported

2. **Fase 0**:
   - El paso "Extender EVENT_TYPES en `db/schema.ts`" agrega SOLO los 2 events de observación, NO bite_inflicted
   - El paso de Zod schemas: borrar el bloque `biteInflicted` (lo cubre incident_reported existente); agregar nota de que los campos bite-específicos ya están en el schema de incident_reported
   - El paso de classification: bite_inflicted ya no está clasificado independientemente; rabies_observation_started/ended sí

3. **Fase 1 (reportBiteAction)**:
   - El insert del bite event ahora es `incident_reported` con `incident_type='bite_inflicted'` en el payload
   - `validateEventPayload("incident_reported", { incident_type: "bite_inflicted", ... })`
   - Todo el resto del flow es idéntico

4. **Fase 2 (escalation hook)**:
   - El query que busca "es bite activo?" ahora chequea `pet_events WHERE event_type='incident_reported' AND payload->>'incident_type'='bite_inflicted' AND ...`

5. **Fase 3 (cron)**:
   - Mismo update al query

6. **Fase 4 (org-side reporting)**:
   - Mismo update — server action inserta incident_reported

7. **Fase 5 (death hook)**:
   - El find de "started event activo" no cambia (es rabies_observation_started). El find del bite que lo originó cambia a incident_reported

8. **Casos borde**: actualizar referencias

#### Commit Paso 7

```
docs(bite-observation): update spec and plan to use incident_reported pattern

bite_inflicted is no longer a standalone event_type — bites live
inside incident_reported with incident_type='bite_inflicted'. The
spec (v1.0 → v1.1) and plan are updated to reflect this throughout:

- EVENT_TYPES additions reduce from 3 to 2 (rabies_observation_started,
  rabies_observation_ended only)
- Zod schema biteInflicted is removed; incident_reported's extended
  schema (paso 3 of catalog-cleanup) carries the bite fields
- Server action pseudocode: insert event_type='incident_reported' with
  payload.incident_type='bite_inflicted', plus all the bite-specific
  payload fields
- Surveillance escalation query: filters by event_type='incident_reported'
  AND payload->>'incident_type'='bite_inflicted'
- Cron auto-close query: same filter applied to find the originating bite

Functional semantics unchanged: same atomic transaction, same 10-day
observation period, same escalation logic, same death-during-observation
handling.

When this updated plan is executed, it produces the same final behavior
as the v1.0 plan — only the event_type plumbing is different.
```

### Paso 8 — AGENTS.md → Event catalog section refresh

En `AGENTS.md`, buscar la sección "Event catalog — N types" (probablemente "23 types" o un número similar). Reescribir reflejando el catálogo nuevo:

**Cambios al header:**
- Update count: si era "23 types", calcular el nuevo total (resto 5 borrados, sumo 5 nuevos → 23 + neto 0... wait. Borro 4 redundantes + 1 deprecated = 5 menos. Agrego 5 nuevos. Más bite_inflicted ya no existe → otro -1. Pero hubo otros agregados en planes previos como medication_dose_taken, libreta_shared_viewed, outbreak_signal, clinical_info_logged que ya están en main. Hay que CONTAR el actual real reading the const, no asumir).

**Acción concreta para Claude Code:** después de aplicar todos los pasos 1-7, releé `db/schema.ts → EVENT_TYPES` const, contá las entries, y ese es el nuevo número que va en el header de AGENTS.md.

**Cambios al body:**

Reescribir las tablas agrupadas por purpose (Lifecycle, Preventive medicine, Medication, Clinical encounters, Body metrics, Identification & legal, Custody & adoption, Free-form, System / observed, Schema-ready non-owner). Para cada event_type:
- Mantener si sigue existiendo
- Sacar los 5 borrados/deprecados (lab_work_performed, imaging_performed, surgery_performed, allergy_detected, adoption_application_reviewed)
- Mover bite_inflicted (que ya no existe) y dejar nota bajo `incident_reported` de que ahora cubre bites via incident_type
- Agregar los 5 nuevos (adoption_withdrawn, custody_dispute_raised/resolved, microchip_replaced/revoked, rabies_observation_started/ended cuando se implemente bite-observation)

Agregar una subsección al final de la sección "Event catalog":

```markdown
### Deprecated event types

These event_types existed in earlier versions but are no longer written by any
flow. Historical pet_events rows with these types remain in the database
(events are immutable) and continue to render via the catch-all branch in
eventPayloadSummary.

| Deprecated | Replacement | Deprecated since |
|---|---|---|
| `lab_work_performed` | `clinical_info_logged` with `sub_kind='lab_work'` | 2026-05-18 |
| `imaging_performed` | `clinical_info_logged` with `sub_kind='imaging'` | 2026-05-18 |
| `surgery_performed` | `clinical_info_logged` with `sub_kind='surgery'` | 2026-05-18 |
| `allergy_detected` | `clinical_info_logged` with `sub_kind='allergy_detection'` | 2026-05-18 |
| `adoption_application_reviewed` | Application table status field | 2026-05-18 |

Also, the `incident_type='dog_attack'` value of `incident_reported.payload`
is deprecated in favor of the unambiguous `incident_type='bite_suffered'`.
Historical rows preserved.
```

#### Commit Paso 8

```
docs(agents): refresh Event catalog section after cleanup

Updates the Event catalog section to reflect:
- 4 deprecated event types removed (lab_work_performed, imaging_performed,
  surgery_performed, allergy_detected) — all subsumed by clinical_info_logged
- 1 deprecated (adoption_application_reviewed) — application status covers it
- 5 new event types documented (adoption_withdrawn, custody_dispute_raised,
  custody_dispute_resolved, microchip_replaced, microchip_revoked)
- bite_inflicted documented as incident_reported.incident_type, not a
  standalone event_type
- dog_attack incident_type deprecated in favor of bite_suffered

New "Deprecated event types" subsection lists what's been removed with
replacement guidance. Historical rows preserved (events are immutable).
```

### Paso 9 — AGENTS.md → Cross-cutting event patterns subsection

Dentro de la sección "Event sourcing — invariants and scaling roadmap" (o donde tenga más sentido contextualmente), agregar una nueva subsección:

```markdown
### Cross-cutting event design patterns

Four recurring patterns emerge from DIM's event catalog. New event design should
recognize which pattern fits and use the established shape.

**1. `*_started` / `*_ended` pairs with auto-close cron.**

Used for time-bounded processes: rabies_observation_started/ended (10-day legal
period), foster_assigned/foster_ended, future quarantines. Each pair has:
- An originating event that opens the period and writes a denormalized status
  column on `pets` (e.g., `rabies_observation_status='in_progress'`).
- A closing event that flips the status to a terminal state.
- A daily cron that auto-closes the happy path; manual closure for non-happy
  cases. Cron is idempotent.

The pattern preserves the immutable event log while giving fast queries via the
denormalized status column. When designing a new bounded-process event, follow
this shape.

**2. `*_signal` system-emitted events for surveillance and audit.**

Used when the system itself produces a record that's not directly authored by
a user. Examples: outbreak_signal (system detected disease pattern from
symptom_observed), libreta_shared_viewed (telemetry of share token use),
credential_scanned (QR scan log). Each has:
- `author_role = 'system'`, `recorded_by_user_id = null` (anonymous scans) or
  the relevant party (authenticated scans).
- Severity tagged when actionable (urgent/warning/info).
- Classified as NON-libreta-sanitaria — these are system telemetry, not
  pet medical history.

When designing a new system-emitted event, ensure it's NON-libreta and
documents what triggers its emission.

**3. `*_proposed` / `*_executed` two-phase with lazy auto-cancel.**

Used for high-trust transfers requiring acceptance: custody_transfer_proposed
+ custody_transferred (org-to-org and refugio-to-owner), adoption_application
(submit → review → approve/reject → finalize). Each pair has:
- Phase 1: proposing party emits the *_proposed event. State is "pending".
- Phase 2: receiving party accepts → emits *_executed event in atomic
  transaction; ends related ownership rows, starts new ones.
- Lazy auto-cancel: at Phase 2 accept time, the receiver's server action
  validates preconditions (proposer still has standing, target state still
  matches the proposal context). If any precondition fails, the proposal
  auto-cancels with a note_added event + notification to the original
  proposer. No sweep job needed.

When designing a new transfer or approval workflow, use this pattern. Avoid
ad-hoc state machines; reuse the proposed/executed shape.

**4. `*_reported` umbrella with sub_kind discriminator.**

Used when several variants share a common event shape: incident_reported with
incident_type (bite_inflicted, bite_suffered, fight, traffic_accident, fall,
poisoning, escape, other), clinical_info_logged with sub_kind (lab_work,
imaging, surgery, allergy_detection, other), symptom_observed with implicit
sub_kind via matched_symptom_codes array. Each has:
- A single event_type covering N variants.
- A discriminator field in payload (`incident_type`, `sub_kind`, etc.).
- Optional fields per variant that are only meaningful for some discriminator
  values.

When designing a new event that has 3+ semantically-similar variants, prefer
this umbrella over N separate event_types. Easier to extend (add a new
discriminator value, optionally add new payload fields) than to add N event
types each with own schema.

**When to NOT use these patterns.**

- For purely additive write-once facts (vaccination_administered, weight_recorded,
  death_recorded), no pattern needed. Just an event_type with payload.
- For UI preferences (emergencyInfoVisible, disclose_*_when_lost on pets),
  these aren't events at all — they're mutable state on the entity row.
  Don't emit events for preference flips.
```

#### Commit Paso 9

```
docs(agents): document 4 cross-cutting event design patterns

Codifies the recurring patterns observed across DIM's event catalog:

1. *_started / *_ended pairs with auto-close cron (rabies observation,
   foster, future quarantines)
2. *_signal system-emitted for surveillance and audit (outbreak_signal,
   libreta_shared_viewed, credential_scanned)
3. *_proposed / *_executed two-phase with lazy auto-cancel (custody
   transfers, adoption pipeline)
4. *_reported umbrella with sub_kind discriminator (incident_reported,
   clinical_info_logged, symptom_observed)

Future event design should recognize which pattern fits and reuse the
established shape rather than inventing new ones.

Adds explicit "When NOT to use these patterns" note for additive facts
and for UI preferences (which aren't events at all).
```

### Paso 10 — README touch + open questions update

#### Paso 10.1 — README

En `docs/superpowers/README.md`, agregar al "All plans" table:

```markdown
| `2026-05-18-event-catalog-cleanup.md` | 🟢 Ready for CC | — | Cleanup: borra 4 events redundantes, refactorea bite events bajo incident_reported, agrega 5 events nuevos, deprecada 1, agrega CI coverage test, refresh AGENTS.md Event catalog + nueva subsección de cross-cutting patterns. 10 pasos en 1 PR. ~1 día. |
```

Y al "all specs" table — no aplica (este plan no tiene spec separado, es cleanup).

#### Paso 10.2 — AGENTS.md → Open questions update

Agregar a la sección "Open questions / future work":

```markdown
- **Vaccination due warning to owner** — when a vaccination approaches/passes
  its `next_due_at`. Confirmed in `legal-framework-full.md` (2026-05-18 pass)
  that NO Argentine norm requires the system to warn — the obligation is on
  the owner to keep vaccinations current (Ley 22.953, DL 8056, Ord. 41.831).
  System-side warning is a UX feature, not a compliance requirement. Future
  spec if product decides to implement.
```

#### Commit Paso 10

```
docs: register event-catalog-cleanup plan in README + defer vaccination warning

Updates docs/superpowers/README.md to list this plan as Ready/Implemented
depending on commit state. Adds AGENTS.md open question explicitly
documenting that vaccination_due_warning has no legal basis and is
deferred as a future UX-only feature.
```

## 5. Verificación final

Después de los 10 pasos:

1. `pnpm typecheck` — cero errores
2. `pnpm lint` — cero errores nuevos
3. `pnpm test` — todos verdes, **incluyendo el nuevo test de cobertura**
4. `pnpm build` — compila
5. Verificaciones específicas:
   - `grep "lab_work_performed" db/schema.ts lib/event-schemas.ts lib/libreta-sanitaria.ts` → cero matches en code
   - `grep "bite_inflicted" db/schema.ts lib/event-schemas.ts` → cero matches (vive en incident_reported.payload.incident_type)
   - `grep "adoption_application_reviewed" db/schema.ts lib/event-schemas.ts` → cero matches
   - En Studio: `SELECT in_custody_dispute FROM pets LIMIT 1` retorna false para filas existentes (default aplicado)
   - El test de cobertura de libreta-sanitaria (`lib/libreta-sanitaria.test.ts`) sigue pasando — los nuevos events están clasificados
6. AGENTS.md → Event catalog refleja el nuevo estado con sección de Deprecated event types
7. AGENTS.md → Cross-cutting event design patterns existe y describe los 4 patterns
8. Los specs/plans de bite-rabies-observation (v1.1 en spec, plan actualizado) no mencionan `bite_inflicted` como event_type — todo via incident_reported

## 6. Casos borde

- **Filas históricas con event_types borrados**: si en seed data o en environments de testing hay filas con `event_type='lab_work_performed'` (o cualquier otro borrado), siguen existiendo en DB. `eventPayloadSummary` tiene un catch-all branch que las renderiza con el event_type literal y el payload jsonb plano. **No tocar esas filas** — son inmutables
- **`dog_attack` en incident_type**: queda como valor válido en el enum del Zod (para back-compat con cualquier fila histórica). Documentado como deprecated en AGENTS.md. Nuevos writers usan `bite_suffered`
- **CI test de cobertura corre en orden alfabético de PayloadSchemas keys**: asegurate que el error message liste los faltantes claramente. La función `expect(missing).toEqual([])` da output OK; si el array es largo, joinear con `\n` para que el log sea legible
- **`incident_reported` schema validation**: los campos bite-específicos son OPTIONAL en el Zod. Si alguien inserta un `incident_reported` con `incident_type='fall'` y sin `victim_kind` (correcto porque fall no tiene victim), el schema acepta. Si inserta `incident_type='bite_inflicted'` y omite victim_kind, también acepta (porque optional) — pero eso sería data poor; ojalá el form forces el field. **No agregamos validation a nivel Zod de "si incident_type es bite_*, victim_kind es requerido"** — eso lo hace el form. Razón: simplicidad del schema; flexibility de uso
- **`pets.in_custody_dispute=true` y otras acciones**: este plan SOLO agrega el flag. No bloquea ninguna acción downstream (transfer custody, scheduling, lost-mark, etc.). Cada feature que respete el flag lo agrega cuando se diseñe su flow específico. Documentado en commit msg de paso 6

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos
2. Reportá a Nacho:
   - Cuántos archivos tocados (esperado ~10)
   - Tests passing count (debe haber 1+ nuevo de cobertura)
   - Verificación de los greps de §5
   - AGENTS.md Event catalog actualizado con count nuevo y deprecated section
   - AGENTS.md Cross-cutting patterns subsection legible y completa
3. Si encontraste algún archivo de código que importaba uno de los Zod schemas borrados (e.g., `biteInflicted`, `labWorkPerformed`), documentar qué hiciste para migrarlo (no debería existir si el feature no se implementó, pero por las dudas)
4. Marcar este plan como ✅ Implementado en `docs/superpowers/README.md` cuando todos los commits estén mergeados

## 8. Lo que viene después (no en este PR)

- Cuando llegue el momento de implementar `bite-rabies-observation` (plan separado, spec/plan actualizados acá): seguir el plan v1.1 con el patrón `incident_reported`
- Server actions para `adoption_withdrawn`, `custody_dispute_*`, `microchip_replaced/revoked`: vienen en sus features cuando se diseñen
- Política de "qué se bloquea cuando `pet.in_custody_dispute=true`": cada feature relevante (transfer custody, adoption finalize, scheduling, lost-and-found) lo decide cuando se implementa
- `vaccination_due_warning` UX feature: future spec si decisión de producto lo justifica (no legal)
- Reverso de los deprecaciones: las filas históricas con event_types borrados podrían beneficiarse de un script de migración que las re-clasifique a clinical_info_logged. **NO en este PR** — premature optimization sin volume real
