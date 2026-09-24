> **IMPLEMENTED / shipped** — This spec has been fully implemented. Event-to-case attachment logic lives in `lib/case-attachment.ts`; the case model and queries in `lib/case-queries.ts`. Archived for historical reference only.

# Casos (expedientes) — attachment de eventos — design spec

> Introducir un objeto **Caso** (a.k.a. *expediente*) como capa de coordinación liviana sobre el event log. Un caso agrupa todo lo que pasa alrededor de una situación real-life (una mordida, una denuncia, una adopción, una pérdida) y derivado de eso le da contexto unificado a actores, aprobaciones y normativas aplicables. Este documento define **cómo cada event_type del catálogo se relaciona con el sistema de casos**: si lo abre, si se le adjunta, si lo cierra, si lo ignora. Los lifecycles detallados por `case_kind` quedan para el spec siguiente.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.1 — el `adoption_pipeline` único se desdobla en dos kinds: `adoption_application` (per applicant, "solicito y espero") y `adoption_listing` (per pet at org, "recibo varios, elijo, avanzo"). Razón: el dueño/postulante y la org viven dos flujos distintos; meterlos en un solo caso obligaba a una vista compartida que no respetaba la asimetría real. También se agregan los 4 event_types que faltaban en v1.0: `foster_proposed`, `foster_proposal_resolved`, `foster_co_foster_allowed`, `adoption_eligibility_set` (estaban en el catálogo de 41 pero el enumerado evento-por-evento los omitía). Adopción token visual: **Caso** (decisión de UI cerrada).
> **Sucede a:** brainstorm en chat 2026-05-19 (decisiones D1–D5 vienen de ahí)
> **Sucesor:** `2026-05-19-cases-lifecycles-design.md` (a escribir después)

---

## 1. Por qué este documento existe

DIM ya tiene varios workflows con forma de "caso" pero cada uno inventa su propia máquina de estados:

- **Bite + observación antirrábica** (Decreto 4669 PBA, Ord. CABA 41.831) — vive en `pets.rabies_observation_status` + 2 event_types + cron + escalación. Estado denormalizado en la pet row.
- **Pipeline de adopción** — vive en `adoption_applications` + cadena de event_types + checkins + ventana de followup. Estado distribuido.
- **Custody dispute** (Fase 14 del admin page) — tabla `custody_disputes` + `pets.in_custody_dispute` + dos event_types.
- **Denuncia welfare** — tabla `welfare_reports` con código `DEN-XXXX-XXXX` y bridge a pet_events. Es lo más cerca que tenemos hoy de un caso de primera clase.
- **Lost-pet episode** — flippeo de `pets.status='lost'` + broadcast + return-to-owner two-phase + flippeo de vuelta a `active`. Sin objeto que lo represente.
- **Foster placement** — `foster_assigned`/`foster_ended` + ownership row con role='foster'.

Cada uno reinventó coordinación, visibilidad y cierre. La consecuencia operativa es real: el dueño que recibe a su perro encontrado no ve "el caso de pérdida cerrado"; ve event_types sueltos. El govt que mira `/gob/maltrato` (cuando exista) va a tener que reconstruir el "qué pasó alrededor de esta denuncia" desde tablas dispersas. La integración futura con Mi Argentina va a pedir expediente-shape sí o sí — es como hablan los sistemas del Estado argentino.

Este spec extrae el patrón común. **NO reemplaza** ninguno de los workflows existentes: los `*_started`/`*_ended`, los `*_proposed`/`*_executed`, las tablas auxiliares (`adoption_applications`, `welfare_reports`, `custody_disputes`) siguen igual. Lo que agrega es un `case_id` opcional en `pet_events` (y en `welfare_reports`) más una tabla `casos` minimal que cumple el rol de "carpeta" — todo lo que el usuario llamaría intuitivamente "el caso" se proyecta desde ahí.

El objetivo de este doc puntual: enumerar **evento por evento** del catálogo de 41 types qué hace cuando se inserta, en relación al sistema de casos. Sin esa enumeración primero, el spec de lifecycles flota.

---

## 2. Glosario

| Término | Qué es |
|---|---|
| **Caso** (sinónimo: **expediente**) | Row en tabla `casos`. Coordinación liviana sobre N eventos relacionados. NO duplica datos del event log — es una "carpeta" con metadata mínima |
| **case_kind** | Discriminador del caso (`bite_incident`, `lost_pet_episode`, `adoption_listing`, `adoption_application`, etc.). Define lifecycle, qué events lo pueden abrir/cerrar, qué normativas aplican, qué actores ven qué |
| **Primary subject** | El sujeto del caso. Casi siempre un `pet`, pero polimórfico siguiendo el modelo de `welfare_reports.subjectKind` — puede ser `unowned_animal`, `location` o `general` |
| **Attachment mode** | Cómo un event_type se relaciona con casos al insertarse. Cinco modos: `opens`, `requires-open`, `attaches-when-open`, `optional`, `never` (ver §5) |
| **Superseded by** | Caso que reemplaza a otro (por merge). El caso superseded queda cerrado con `closed_reason='merged'` y `superseded_by_case_id` apuntando al nuevo. Los events del caso viejo NO se reasignan — siguen apuntando al case_id original (events son immutable). La UI sigue la cadena |
| **Scope** | Conjunto de actores que pueden leer un caso o partes de él. Definido por `case_kind` × `actor_relation` (ver §9) |
| **Normativa** | Ley o decreto aplicable. NO se almacena en el caso — se computa con un lookup `case_kind × jurisdiction → laws[]` que vive en `lib/case-normatives.ts` (a crear) |

---

## 3. Decisiones cerradas

Vienen del brainstorm 2026-05-19. Aquí las dejamos congeladas para que el resto del doc pueda apoyarse en ellas sin re-litigar.

| # | Decisión | Razón |
|---|---|---|
| D1 | **1:N event → caso (al menos 0, máximo 1)**. Un event apunta a *un* caso o a ninguno. La libreta sanitaria queda ortogonal — su proyección sigue siendo por event_type, no por case_id | Simplicidad de modelo. Cuando un mismo hecho real cierra dos casos a la vez, se resuelve por cascade-emission (§8), no por relación many-to-many |
| D2 | **Todos los events relacionados se atan al caso real-life**. Si la situación es un solo expediente, todos sus events viven bajo el mismo `case_id`. Cuando un caso se merge a otro vía `superseded_by_case_id`, los events del original NO se mueven (immutables) pero la UI presenta la cadena completa | Coherencia con el principle "append-only, never edit". El historial del case_id original es real, no debe rewriteearse |
| D3 | **Los casos son independientes y se pueden crear de dos formas**: manualmente (un actor con permiso abre el caso) o automáticamente vía un event_type configurado como `opens` (ver §5) | La mayoría de los casos van a auto-abrir (bite, denuncia, pérdida). Pero govt necesita poder abrir manualmente un `welfare_denuncia` cuando recibe un reporte externo que no entró por el form de DIM, y admin necesita poder abrir manualmente un `custody_dispute` cuando llega un oficio judicial |
| D4 | **Visibilidad scope-bound + composable**. Cada actor (owner, vet, refugio, govt, admin, anon) ve la porción del caso que le corresponde a su scope. La unión de todas las vistas reconstruye el caso completo. Mecanismo: RLS sobre `casos` + `pet_events.case_id`, declarativo por `case_kind` (ver §9). PII jamás sale fuera de scope | Es el patrón que el resto del sistema ya usa (privacy tiers en pet view, RLS en core tables). Casos no introducen excepción |
| D5 | **Normativas son lookup derivado, no datos en el caso**. Tabla / lookup estático `lib/case-normatives.ts` mapea `(case_kind, jurisdiction)` → `LawReference[]`. Las leyes pueden cambiar; los casos no se rewritean — se vuelve a renderizar el lookup. Snapshot solo si una decisión histórica necesita el texto exacto vigente al momento (caso raro, deferido) | Evita carry-on de leyes obsoletas por cada caso histórico. Documentation made queryable |

---

## 4. Domain model

### 4.1 Tabla `casos`

Coordinación mínima. NO duplica datos del event log.

```ts
// db/schema.ts (sketch — no es código final)
export const cases = pgTable("cases", {
  id: uuid("id").defaultRandom().primaryKey(),
  publicCode: text("public_code").notNull().unique(), // "CAS-XK3P-9D2L" estilo DIM-tokens
  caseKind: text("case_kind").notNull(), // enum-via-string, mismo patrón que event_type / org_type
  status: text("status").notNull().default("open"), // open | closed | escalated | merged
  closedReason: text("closed_reason"), // resolved | auto_expired | merged | cancelled | superseded — null mientras open
  supersededByCaseId: uuid("superseded_by_case_id").references((): AnyPgColumn => cases.id),

  // Sujeto polimórfico (mirror de welfare_reports.subjectKind)
  primarySubjectKind: text("primary_subject_kind").notNull(), // registered_pet | unowned_animal | location | general
  primaryPetId: uuid("primary_pet_id").references(() => pets.id),
  primaryLocationLat: numeric("primary_location_lat", { precision: 10, scale: 7 }),
  primaryLocationLng: numeric("primary_location_lng", { precision: 10, scale: 7 }),

  // Jurisdicción (igual que pets.jurisdiction_*)
  jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
  jurisdictionProvince: text("jurisdiction_province"),
  jurisdictionLocality: text("jurisdiction_locality"),

  // Apertura
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  openedByUserId: uuid("opened_by_user_id").references(() => profiles.id),
  openedByOrganizationId: uuid("opened_by_organization_id").references(() => organizations.id),
  openedReason: text("opened_reason"), // free text — "auto: incident_reported.bite_inflicted" o "manual"

  // Cierre
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: uuid("closed_by_user_id").references(() => profiles.id),

  // Linkbacks opcionales a tablas auxiliares cuando el caso "viene de" o "envuelve" una
  welfareReportId: uuid("welfare_report_id").references(() => welfareReports.id), // para welfare_denuncia
  adoptionApplicationId: uuid("adoption_application_id").references(() => adoptionApplications.id), // para adoption_application (per applicant)
  // adoption_listing (per pet+org) NO necesita backlink — su identity es (primary_pet_id, opened_by_organization_id)
  custodyDisputeId: uuid("custody_dispute_id").references(() => custodyDisputes.id), // para custody_dispute

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Reglas duras:**

- CHECK `(primary_subject_kind = 'registered_pet') = (primary_pet_id IS NOT NULL)` — sujeto y pet linkeados son la misma cosa.
- CHECK `(primary_subject_kind = 'location') = (primary_location_lat IS NOT NULL AND primary_location_lng IS NOT NULL)`.
- CHECK `status = 'merged' = (superseded_by_case_id IS NOT NULL AND closed_reason = 'merged')`.
- CHECK `(status = 'closed' OR status = 'merged') = (closed_at IS NOT NULL)`.
- Index parcial `(primary_pet_id, case_kind) WHERE status = 'open'` para el lookup "¿hay caso abierto de tipo X sobre esta mascota?" (lo usa cada attachment automático).
- Index parcial `(jurisdiction_locality, case_kind) WHERE status = 'open'` para la cola del welfare-officer (`/gob/maltrato`) y futuras colas similares.

### 4.2 Columna `case_id` en `pet_events`

Nullable. FK suave a `cases.id` (sin cascade — un caso se "merge", nunca se borra, así que CASCADE no debería dispararse jamás; lo dejamos `ON DELETE RESTRICT` defensivo).

```ts
// adición a pet_events
caseId: uuid("case_id").references(() => cases.id),
```

Reglas:

- **Append-only se mantiene.** El `case_id` se setea al INSERT del event y no se modifica nunca (RLS de pet_events no permite UPDATE de ningún campo, igual que hoy).
- **El attachment se decide en el server action que crea el event**, NO en un trigger DB. Razón: la lógica involucra (a) lookup del caso abierto correcto, (b) decisión de auto-open vs. attach vs. cascade-emit, (c) validación de scope. Demasiado para un trigger; queda explícito en la lógica de cada action y testeable.
- **Validación trigger-side mínima**: si `case_id IS NOT NULL`, el caso referenciado debe estar `status IN ('open', 'escalated')` o haber estado abierto en el último 24h (margen para casos cerrados por cron mientras el event entraba). Defense-in-depth, no reemplaza la validación en action.

### 4.3 Columna `case_id` en `welfare_reports`

Nullable. Misma forma. La denuncia se crea primero (anonymous form o autenticado); el caso `welfare_denuncia` se abre en la misma transacción y se backreference acá. Cuando admin/govt abre un caso manualmente para una denuncia preexistente sin caso, se hace UPDATE de este campo (es la única excepción al "no UPDATE" — `welfare_reports` ya permite update de su campo `status`, no es append-only).

### 4.4 Lo que NO va al modelo

- **Approvals no son tabla nueva.** Las aprobaciones que un caso pueda requerir ya son event_types (`adoption_application_resolved`, `custody_transfer_proposed`/`_executed`, `dangerous_breed_attested`). La vista del caso filtra events por "shape de aprobación" y los renderiza como milestones; las pendientes se computan del lifecycle (`case_kind` + estado actual − approvals ya recibidas).
- **Normativas no son tabla.** Lookup estático `lib/case-normatives.ts`. Si la ley cambia, se actualiza el lookup; los casos viejos automáticamente reflejan el nuevo texto.
- **Comentarios/notes no son tabla nueva.** Reusan `note_added` event_type adjuntado al case_id. Da búsqueda, audit y append-only gratis.

---

## 5. Categorías de attachment

Cinco modos. Cada event_type del catálogo cae en uno y solo uno (validado por test de cobertura, ver §11).

| Modo | Comportamiento al INSERT del event | Ejemplo canónico |
|---|---|---|
| **`opens`** | Crea un caso nuevo del `case_kind` declarado y le ata el event. Si ya existe un caso abierto compatible (mismo kind + mismo primary_subject), el modo degrada a `attaches-when-open` automáticamente para evitar duplicados | `incident_reported(bite_inflicted)` → abre `bite_incident` |
| **`requires-open`** | Exige que exista un caso abierto compatible. Si no existe, el INSERT del event **falla** con error explícito (no auto-abre). Atributo defensivo para eventos de cierre/avance que solo tienen sentido dentro de un caso vivo | `rabies_observation_ended`, `adoption_finalized`, `custody_dispute_resolved` |
| **`attaches-when-open`** | Si hay un caso abierto compatible, ata el event al caso. Si no hay ninguno, el event se inserta sin `case_id` (event válido y autónomo). No falla nunca | `credential_scanned` durante `lost_pet_episode`; `symptom_observed` durante `bite_incident` con escalación rábica |
| **`optional`** | El actor humano elige al crear el event si lo ata a algún caso abierto (UI presenta selector de casos compatibles abiertos sobre el pet). Default: sin attachment. Útil para events que mayoritariamente son libreta pura pero que ocasionalmente son milestone de un caso | `vet_visit_logged`, `clinical_info_logged`, `note_added` |
| **`never`** | El event nunca se ata a un caso. Libreta-only o telemetría pura | `vaccination_administered`, `weight_recorded`, `microchip_implanted`, `pet_registered` |

**Reglas que aplican transversalmente a los cinco modos:**

- **Compatibilidad** (entre event_type y case_kind): declarada en la tabla del §7. Un event nunca se puede atar a un caso de un kind con el que no es compatible. Por ejemplo, `vaccination_administered` (modo `never`) jamás se ata; `adoption_finalized` (modo `requires-open`) solo es compatible con `adoption_listing`.
- **Single-target compatibility primero, multi-target después**: si en el futuro descubrimos un event que califica para 2+ case_kinds abiertos simultáneos sobre el mismo pet (rar-ísimo), la resolución es por prioridad declarada en lifecycle. Por ahora todos los events que llegan a `attaches-when-open` tienen 1 sola intersección.
- **Self-scan exclude**: `credential_scanned` con `is_self_scan=true` se inserta normal pero NO dispara lógica de attachment (no abre, no se ata, no busca). Coherente con el filtro de timeline que ya los esconde.

---

## 6. Catálogo preliminar de `case_kind`

Definición completa de lifecycles en el spec siguiente. Acá solo los nombres y una línea de propósito, porque el §7 los referencia.

| `case_kind` | Una línea | Sujeto típico | Ancla legal principal |
|---|---|---|---|
| `bite_incident` | Mordida + observación antirrábica de 10 días + posible escalada por síntomas | `registered_pet` (mordedor) | Decreto 4669/73 PBA, Ord. CABA 41.831/87, Res. MS 1144/18 |
| `lost_pet_episode` | Pet marcada perdida → broadcast → posible match → return-to-owner → reactivación | `registered_pet` | — (interno) |
| `welfare_denuncia` | Denuncia de maltrato/abandono — triage, investigación, eventual export a fiscalía | `registered_pet` o `unowned_animal` o `location` | Ley Nacional 14.346 |
| `adoption_listing` (org-side) | Pet publicada para adopción por una org. Lifecycle: listing publicada → recibe N postulaciones → org analiza → elige una → finaliza → followup window 12 meses → cierre. El caso es **del refugio** y abarca todo el proceso multi-postulante. La pet puede tener **a lo sumo 1 `adoption_listing` abierta por org** | `registered_pet` (publicado) | — (contractual privado) |
| `adoption_application` (applicant-side) | Postulación individual de un usuario a una `adoption_listing`. Lifecycle lineal: submitted → reviewed (sin event explícito, vive en el status field de la application) → resolved (approved/rejected) → si approved, espera finalization → won/lost. El caso es **del postulante**, solo él ve su propio progreso (D8 spec adoption: no ve competencia). Cada postulación es su propio caso, paralelo a los otros postulantes | `registered_pet` (al que se postula) + `applicant_user_id` como parte del identifier de unicidad | — |
| `custody_episode` | Custodia temporal de unowned animal (shelter intake → handoff o adopción) | `registered_pet` o `unowned_animal` | — (interno, hereda de los párrafos del Código Civil sobre tenencia) |
| `custody_transfer_handshake` | Propose → accept handshake entre orgs o refugio→owner | `registered_pet` | — (interno) |
| `custody_dispute` | Pet flagged por proceeding judicial externo. Read-only para flows normales | `registered_pet` | Caso a caso (oficio judicial) |
| `foster_proposal` | Propuesta de la org a un voluntario del pool para foster específico. Lifecycle: proposed → accepted/rejected/cancelled/expired (umbrella `foster_proposal_resolved`). Si accepted, cascade a `foster_placement` | `registered_pet` + `volunteer_user_id` | — (interno) |
| `foster_placement` | foster_assigned → checkpoints → foster_ended | `registered_pet` | — (interno) |
| `outbreak_investigation` | Cluster de `symptom_observed` o `outbreak_signal` en una jurisdicción | `location` | Ley 15.465/60 + Decreto 3640/64 (notif obligatoria), Ley 5325/48 PBA |
| `microchip_remediation` | Reemplazo o revocación de chip por fraud/duplicate detection | `registered_pet` | Ley Prov 14.107/10 (chip obligatorio) |
| `rabies_observation_followup` | (Subcaso o continuación de `bite_incident` post-cierre profesional, por ahora plegado dentro de bite_incident — open question §12) | — | — |

13 kinds preliminares; el spec de lifecycles los ratifica o consolida. **Para el v1 implementable**, el subset mínimo recomendado es: `bite_incident`, `lost_pet_episode`, `welfare_denuncia`, `adoption_listing` + `adoption_application` (van juntos sí o sí), `custody_dispute`, `foster_placement`. Los otros se agregan cuando su workflow asociado lo amerite (no antes — abrir un case_kind sin lifecycle escrito es prematuro).

**Asimetría adoption_listing vs adoption_application — por qué dos kinds.** El refugio y el postulante viven flujos genuinamente distintos:

- El **refugio** opera en lógica de selección multi-postulante: recibe varias postulaciones a la misma pet, las compara, las shortlistea, elige una, gestiona el contrato, hace seguimiento post-adopción. Su caso (`adoption_listing`) abarca todo eso y todas las postulaciones recibidas como hijos. Cierra cuando la adopción se finaliza + termina la ventana de followup, o cuando el refugio retira el listing.
- El **postulante** opera en lógica lineal: postuló, espera respuesta, le aprueban o le rechazan. No ve competencia, no ve deliberación interna. Su caso (`adoption_application`) abarca su propia postulación de punta a punta y cierra cuando le resuelven (aprobado→finalizado→ganó, o rechazado, o adopción finalizada para otro postulante→perdió).

Si los hubiéramos modelado como un único `adoption_pipeline` por pet, la visibilidad scope-bound se complicaba (cada vista tenía que filtrar agresivamente los events del otro lado) y los cierres tampoco coincidían (la listing del refugio sigue abierta en followup, las applications de los rechazados ya cerraron). Dos kinds es más simple en RLS, más simple en UI, y más fiel al fenómeno real.

**Linkage entre los dos**: `adoption_application` tiene `parent_listing_case_id` (FK opcional a `cases.id` con kind `adoption_listing`). Esto permite al refugio listar "postulaciones recibidas para esta pet" como un join, sin atar events a los dos casos. Cuando una pet no tiene listing publicada (caso edge: postulación directa fuera del sistema de listings, no soportado en v1), `parent_listing_case_id=NULL` y la postulación queda huérfana — no debería pasar normalmente y el server action puede rechazarlo.

---

## 7. Catálogo `event_type` × attachment behavior

Enumeración exhaustiva del catálogo de 41 events. Columnas:

- **Modo**: uno de los cinco del §5.
- **Compatibles con**: case_kinds con los que se relaciona. `—` si modo `never`.
- **Si abre, abre**: el `case_kind` que abre cuando aplica (modo `opens` o auto-degrade).
- **Notas**: condicionales, payload-driven branching, cascade implications.

### 7.1 Lifecycle (4 events)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `pet_registered` | `never` | — | — | Standalone. Onboarding |
| `pet_profile_updated` | `never` | — | — | Edición de profile. No es case-shaped |
| `status_changed` | branch | `lost_pet_episode` | `lost_pet_episode` | `to_status='lost'` → modo `opens` (abre `lost_pet_episode`). `to_status='active'` desde `lost` → modo `requires-open` (cierra el `lost_pet_episode` abierto). Cualquier otro → `never` |
| `death_recorded` | `attaches-when-open` | `bite_incident`, `foster_placement`, `adoption_listing`, `adoption_application`, `custody_episode`, `lost_pet_episode` | — | **Hot cascade**: muerte cierra simultáneamente varios casos abiertos. Atrás del scenes el server action emite *cascade events* (ver §8). El `death_recorded` original se ata al case más "lifecycle-terminal" (prioridad: `bite_incident` > `lost_pet_episode` > `adoption_listing` > `foster_placement` > `custody_episode`; las `adoption_application` open reciben cascade dedicado en §8) |

### 7.2 Preventive medicine (3)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `vaccination_administered` | `never` | — | — | Libreta-only. Cuando exista un `campaign_episode` case_kind para campañas govt, esto cambiará a `attaches-when-open` con la campaña activa. Deferido |
| `deworming_administered` | `never` | — | — | Idem |
| `sterilization_performed` | `never` | — | — | Idem |

### 7.3 Medication (3)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `medication_started` | `never` | — | — | Libreta. Si una medicación es parte del tratamiento post-mordida, el vet usa `note_added` en modo `optional` para dejar constancia explícita en el caso |
| `medication_stopped` | `never` | — | — | Idem |
| `medication_dose_taken` | `never` | — | — | Telemetría de adherencia |

### 7.4 Clinical encounters and findings (2)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `vet_visit_logged` | `optional` | `bite_incident`, `adoption_listing`, `welfare_denuncia`, `foster_placement` | — | UI default: sin attachment. Si hay caso abierto compatible, presenta selector "¿este turno está relacionado con un caso abierto?". Útil cuando la visita ES el milestone (chequeo post-bite, visita pre-adopción) |
| `clinical_info_logged` | `optional` | `bite_incident`, `welfare_denuncia`, `outbreak_investigation` | — | Idem. `sub_kind='lab_work'` con un código compatible con rabia → la UI proactivamente sugiere atar al `bite_incident` abierto |

### 7.5 Body metrics (1)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `weight_recorded` | `never` | — | — | Libreta-only |

### 7.6 Identification & legal (3)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `microchip_implanted` | `never` | — | — | Auto-emitido al pet_registered cuando hay chip. No es case-shaped |
| `microchip_replaced` | branch | `microchip_remediation` | `microchip_remediation` | `reason IN ('fraud_detected', 'duplicate_detected')` → modo `opens`. Cualquier otro motivo (`damaged`, `unreadable`, `device_failure`, etc.) → `never`. El `new_chip_number=null` (revocation) entra al mismo branch |
| `dangerous_breed_attested` | `never` | — | — | Atestación legal puntual. NO es case-shaped (es un dato que el pet "tiene", no algo que "está pasando") |

### 7.7 Free-form (1)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `note_added` | `optional` | **todos** | — | El único event polimorfo en compatibilidad. UI presenta selector con casos abiertos del pet + opción "no relacionado". Default: sin attachment. Para owner el selector solo aparece si hay >0 casos abiertos visibles a su scope |

### 7.8 System / observed (3)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `credential_scanned` | branch | `lost_pet_episode` | — | Si `pet.status='lost'` Y hay `lost_pet_episode` abierto Y `is_self_scan=false` → modo `attaches-when-open` (atado al lost_pet_episode como signal de visibilidad pública). Cualquier otra combinación → `never`. La condición se chequea al INSERT del scan |
| `incident_reported` | branch | `bite_incident` | `bite_incident` | `incident_type='bite_inflicted'` → modo `opens` (abre `bite_incident`). `bite_suffered` → modo `attaches-when-open` (puede pertenecer a un caso bite del agresor si DIM lo identifica, pero no abre uno nuevo del lado del mordido). Cualquier otro incident_type → `never` por ahora |
| `outbreak_signal` | `opens` | `outbreak_investigation` | `outbreak_investigation` | El sujeto es `location`, no un pet. Abre `outbreak_investigation` jurisdicción-scoped si no existe uno abierto cubriendo el match. Auto-degrade aplica: si ya hay outbreak abierto para `(disease_code, jurisdiction)`, se ata |

### 7.9 Non-owner reporting flow (3)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `symptom_observed` | branch | `bite_incident`, `outbreak_investigation`, `welfare_denuncia` | — | Branch por payload: si `source='welfare_report'` → modo `requires-open` sobre `welfare_denuncia` (la denuncia ya abrió el caso). Si hay `bite_incident` abierto sobre el pet **y** los `matched_symptom_codes` incluyen rabia high-spec → `attaches-when-open` sobre el bite (mecanismo de escalación documentado en bite-rabies spec D5). Si dispara `outbreak_signal` que abre `outbreak_investigation` → cascade-attach al outbreak. Sin condición especial → `never` |
| `abandonment_reported` | `requires-open` | `welfare_denuncia` | — | Bridged desde welfare_reports → el caso `welfare_denuncia` se abre al INSERT del welfare_report (no acá). Acá ya hay caso |
| `maltreatment_reported` | `requires-open` | `welfare_denuncia` | — | Idem |

### 7.10 Custody & adoption (16)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `shelter_intake_recorded` | `opens` | `custody_episode` | `custody_episode` | Abre custodia temporal. Se cierra cuando ownership cambia (adoption_finalized, custody_transferred sale) |
| `adoption_eligibility_set` | branch | `adoption_listing` | `adoption_listing` | `payload.eligible=true` → modo `opens` (abre `adoption_listing` para el `(pet, org_in_custody)`). Auto-degrade si ya hay listing abierta para esa misma (pet, org). `payload.eligible=false` → modo `requires-open` (cierra la listing abierta con `closed_reason='cancelled'`, cascade rechaza todas las applications open con `auto_generated=true`). Si `eligible=false` pero no había listing abierta → `never` |
| `foster_proposed` | `opens` | `foster_proposal` | `foster_proposal` | Phase 1 del two-phase foster pool. Abre `foster_proposal` con `volunteer_user_id` como parte del identity. Múltiples propuestas paralelas (un pet a varios voluntarios) → cada una su propio caso, mismo patrón que `adoption_application` |
| `foster_proposal_resolved` | `requires-open` | `foster_proposal` | — | Cierra `foster_proposal`. Si `outcome='accepted'`, cascade-emit `foster_assigned` que abre `foster_placement`. Otros outcomes (`rejected`, `cancelled`, `expired`) cierran sin cascade adicional |
| `foster_co_foster_allowed` | `requires-open` | `foster_placement` | — | El primer foster opta por permitir co-foster (D17 foster pool). State-mutation event sobre la placement abierta |
| `foster_assigned` | `opens` | `foster_placement` | `foster_placement` | Subcaso bajo el `custody_episode` del refugio (link semántico, no FK formal en v1 — un pet puede tener varios fosters consecutivos bajo el mismo custody_episode). Cuando viene cascade-emitido por `foster_proposal_resolved(accepted)`, lleva el `triggered_by_event_id` del proposal_resolved en payload |
| `foster_ended` | `requires-open` | `foster_placement` | — | Cierra el `foster_placement`. Si la razón es `adoption`, no cascade — la adopción es su propio flujo (`adoption_listing` + `adoption_application`s) y se coordina vía `adoption_finalized` |
| `adoption_application_submitted` | `opens` | `adoption_application` (y por linkage, `adoption_listing`) | `adoption_application` | Abre `adoption_application` per applicant + setea `parent_listing_case_id` apuntando al `adoption_listing` abierto del (pet, org). **Validación pre-INSERT**: debe existir un `adoption_listing` open para la (pet, org); si no existe, el server action lo rechaza (no se permite postularse a una pet que la org no marcó como elegible). El listing case NO recibe este event directamente (D1: 1 event = 1 caso); lo ve por join desde sus applications hijas |
| `adoption_application_resolved` | `requires-open` | `adoption_application` | — | Cierra la application del postulante. `outcome='rejected'` → `closed_reason='resolved'`. `outcome='approved'` → caso queda abierto esperando `adoption_finalized` para ese applicant. `auto_generated=true` (cascade de finalize) entra acá para las losing applications |
| `adoption_finalized` | `requires-open` | `adoption_listing` | — | Marca la listing como "en followup". El caso `adoption_listing` permanece abierto hasta que el cron lo cierra al expirar `post_adoption_followup_months` (12 default). **Cascades**: (a) en la `adoption_application` ganadora emite cierre con `closed_reason='resolved'` y un new payload field `won=true` (o reusa `adoption_application_resolved` con marker — TBD en lifecycles spec); (b) en cada `adoption_application` perdedora aún abierta emite `adoption_application_resolved(outcome='rejected', auto_generated=true)`; (c) cierra cualquier `foster_placement` activo con `foster_ended(reason='adoption')`; (d) cierra el `custody_episode` del refugio que tenía custody emitiendo `custody_transferred(from_role='shelter_custody', to_role='owner')` |
| `post_adoption_checkin` | `requires-open` | `adoption_listing` | — | Solo válido en la ventana de followup del listing. El owner-adopter lo ve también porque ya es el subject_owner (es Ownership row activa); la org lo ve como custody_holder reciente dentro de la followup window |
| `adoption_reversed` | branch | `adoption_listing` | — | Modo `requires-open` si la listing aún está abierta en followup. Si está cerrada por followup-expired, **reabre** la listing (status `open` + `closed_at=NULL`) en modo `requires-open`-like — esto es la única excepción al "no UPDATE de casos cerrados", justificada porque el adoption_reversed es por definición un cambio retroactivo sobre el outcome. Cascade: la `adoption_application` ganadora original también se reabre con un cierre nuevo de `outcome='rejected'` post-reversal |
| `custody_transferred` | branch | `custody_transfer_handshake`, `custody_episode`, `lost_pet_episode`, `adoption_listing` | — | Branch denso: si está cerrando un `custody_transfer_handshake` propuesto, modo `requires-open` ahí. Si es interno a una adopción finalizada (refugio→adopter), modo `requires-open` sobre `adoption_listing` (ya cubierto por el cascade del adoption_finalized). Si es return-to-owner durante un `lost_pet_episode`, modo `requires-open` sobre el episode. Standalone (custody común sin handshake previo) → modo `attaches-when-open` o `never` |
| `custody_transfer_proposed` | `opens` | `custody_transfer_handshake` | `custody_transfer_handshake` | Phase 1 del two-phase. Caso queda abierto hasta accept (cierra con `custody_transferred`) o expira |
| `custody_dispute_raised` | `opens` | `custody_dispute` | `custody_dispute` | Solo admin/govt puede emitir |
| `custody_dispute_resolved` | `requires-open` | `custody_dispute` | — | Cierra el dispute |

### 7.11 Bite-rabies observation (2, declarados en bite-rabies spec)

| event_type | Modo | Compatibles con | Si abre, abre | Notas |
|---|---|---|---|---|
| `rabies_observation_started` | `requires-open` | `bite_incident` | — | Auto-emitido en la misma transacción que el `incident_reported(bite_inflicted)` que abrió el caso. Inserción atómica: bite_incident case + incident_reported + rabies_observation_started, todo o nada |
| `rabies_observation_ended` | `requires-open` | `bite_incident` | — | Cierra el caso `bite_incident`. Auto-emitido por cron (happy path) o por vet/govt action (outcome ≠ negative) |

### 7.12 Verificación de cobertura

Test obligatorio en `__tests__/case-event-attachment.test.ts`:

```ts
// pseudocódigo
import { EVENT_TYPES } from "@/db/schema";
import { CASE_ATTACHMENT_RULES } from "@/lib/case-attachment";

it("every event_type declares an attachment mode", () => {
  for (const eventType of EVENT_TYPES) {
    expect(CASE_ATTACHMENT_RULES[eventType]).toBeDefined();
  }
});

it("modes that aren't 'never' declare at least one compatible case_kind", () => {
  for (const [eventType, rule] of Object.entries(CASE_ATTACHMENT_RULES)) {
    if (rule.mode !== "never") {
      expect(rule.compatibleWith.length).toBeGreaterThan(0);
    }
  }
});

it("modes 'opens' / 'requires-open' / branch-opens declare which case_kind they open/require", () => {
  // ...
});
```

Mismo principio que el coverage test de `event-schemas.test.ts` que ya existe: el catálogo no puede crecer sin que el spec diga qué hace.

---

## 8. Cascade-emission (cuando un hecho cierra varios casos)

Consecuencia directa de D1 (1:N event→caso). Un único hecho real (la muerte del animal, la finalización de una adopción) puede tocar varios casos abiertos. Como cada event apunta a *un* caso, la solución es **cascade-emit**: el server action emite events adicionales, cada uno ata a su caso, cada uno con un payload field apuntando al event original.

**Ejemplo canónico: `death_recorded` con `bite_incident` + `adoption_listing` (con 3 `adoption_application` open hijas) + `foster_placement` abiertos**.

```text
INSERT pet_events {
  event_type: 'death_recorded',
  case_id: <bite_incident_case_id>,                  ← primary attachment por prioridad (§7.1)
  payload: { cause: 'unknown', confirmed_by_vet: true, during_rabies_observation: true, ... }
}

INSERT pet_events {
  event_type: 'rabies_observation_ended',
  case_id: <bite_incident_case_id>,
  payload: { outcome: 'dead', triggered_by_event_id: <death_event_id> }
}
UPDATE cases SET status='closed', closed_reason='resolved', closed_at=now()
WHERE id = <bite_incident_case_id>

INSERT pet_events {
  event_type: 'adoption_reversed',
  case_id: <adoption_listing_case_id>,
  payload: { actor: 'shelter', reason: 'pet_died', reverted_finalization_event_id: ..., triggered_by_event_id: <death_event_id> }
}
UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=now()
WHERE id = <adoption_listing_case_id>

# Por cada adoption_application open hija de la listing:
INSERT pet_events {
  event_type: 'adoption_application_resolved',
  case_id: <adoption_application_case_id>,
  payload: { outcome: 'rejected', auto_generated: true, reason: 'pet_died', triggered_by_event_id: <death_event_id> }
}
UPDATE cases SET status='closed', closed_reason='resolved', closed_at=now()
WHERE id = <adoption_application_case_id>

INSERT pet_events {
  event_type: 'foster_ended',
  case_id: <foster_placement_case_id>,
  payload: { ended_by: 'other', reason: 'pet_died', triggered_by_event_id: <death_event_id> }
}
UPDATE cases SET status='closed', closed_reason='cancelled', closed_at=now()
WHERE id = <foster_placement_case_id>
```

**Reglas del cascade:**

- **Atomic**: todo en una sola DB transaction. Si cualquier parte falla, rollback completo.
- **Payload tag `triggered_by_event_id`**: convención universal para cascade-emitted events. Permite a la UI mostrar "este foster_ended se generó automáticamente por la muerte del animal el ___" sin reinterpretar lógica de negocio.
- **No cascade infinito**: events cascadeados nunca generan sus propios cascades. La regla la enforcea el server action que las emite (flag `isCascade=true` en el call, que skipea el resto del cascade tree).
- **No notif duplicate**: los cascade events NO emiten su propia notification al owner. La notificación del event original cubre el caso. Cascade events generan notification solo a partes institucionales (org, govt) que necesitan saber del cierre forzado.

**Lista cerrada de cascades** (otros se agregarán cuando aparezcan; por ahora estos cubren los flujos existentes):

| Trigger event | Cascade emits | Notas |
|---|---|---|
| `death_recorded` (durante `bite_incident` abierto) | `rabies_observation_ended` (outcome `dead`) | Ya documentado en bite-rabies D9 |
| `death_recorded` (durante `adoption_listing` en followup) | `adoption_reversed` (actor `shelter`, reason `pet_died`) | Cierra la listing limpio. Cascade del cascade: el `adoption_reversed` reabre y vuelve a cerrar la `adoption_application` ganadora original (porque ya no hay adopción que sostener) |
| `death_recorded` (durante `foster_placement`) | `foster_ended` (reason `other` + payload reason `pet_died`) | |
| `death_recorded` (durante `foster_proposal` abierta sin resolver) | `foster_proposal_resolved` (outcome `cancelled`, reason `pet_died`) | El voluntario recibe notif con el motivo |
| `death_recorded` (durante `adoption_application` open) | `adoption_application_resolved` (outcome `rejected`, auto_generated=true, reason `pet_died`) | Para cada postulación abierta a esa pet, en todas las listings activas. El postulante recibe notif sensible (copy específica por ser muerte, no por ser elegido otro) |
| `adoption_finalized` | (a) en la `adoption_application` ganadora: cierre marcando "ganó" (TBD si reusa `adoption_application_resolved` con marker o usa event nuevo — ver §12); (b) en cada `adoption_application` perdedora aún open: `adoption_application_resolved(outcome=rejected, auto_generated=true)` (es la cascada F5.5 ya existente); (c) `foster_ended` (reason `adoption`) si hay foster_placement activo; (d) `custody_transferred` (from_role `shelter_custody` to_role `owner`) cerrando el `custody_episode` | El cascade (b) es el que ya implementó F5.5 del adoption listing; ahora se ata explicitamente a cada `adoption_application` correspondiente |
| `adoption_eligibility_set(eligible=false)` con listing open | (a) cierre de `adoption_listing` con `closed_reason='cancelled'`; (b) cada `adoption_application` open hija recibe `adoption_application_resolved(outcome=rejected, auto_generated=true, reason='listing_withdrawn')` | Org puede retirar la listing en cualquier momento; los postulantes deben enterarse con motivo claro |
| `foster_proposal_resolved` (outcome `accepted`) | `foster_assigned` (con `triggered_by_event_id` del proposal_resolved) | Abre `foster_placement`. Es el único cascade que ABRE un caso nuevo (los demás cierran o reabren) |
| `custody_dispute_raised` | (no cascade, solo flag `pets.in_custody_dispute=true`) | Suspende workflows pero no cierra otros casos |
| `custody_dispute_resolved` (outcome `ownership_transferred`) | `custody_transferred` con from/to derivados del dispute | |
| `status_changed` (to_status `active` desde `lost`) | (cierre del `lost_pet_episode`, sin cascade adicional salvo el cierre del caso mismo) | |
| `outbreak_signal` durante un `bite_incident` abierto con escalación rábica | (no cascade, solo `attaches-when-open` adicional al outbreak_investigation paralelo si existe) | |

---

## 9. Scope visibility (D4 expandido)

El caso tiene visibilidad scope-bound por actor. Cada `case_kind` declara su matriz `actor_relation × visible_facets`. Los facets son:

- **`case_meta`**: existencia del caso, su `public_code`, kind, status, opened/closed dates, primary_subject (con redacciones)
- **`events_full`**: events del caso con todo su payload (incluido PII)
- **`events_redacted`**: events del caso con PII reemplazada (e.g., victim_contact removido, owner display_name reducido a first name)
- **`actors_list`**: lista de actores involucrados (con grado de identificación apropiado)
- **`pending_approvals`**: aprobaciones que el caso espera (rellenadas con CTAs si el actor puede actuar)
- **`normatives`**: leyes aplicables (siempre visibles a quien tenga `case_meta`; documentation pública)
- **`attachments`**: archivos adjuntos a events del caso

Las **actor_relations** son:

| Relation | Cómo se computa |
|---|---|
| `subject_owner` | actor es el `owner` actual del primary_pet del caso |
| `subject_co_owner` | actor es `co_owner` del primary_pet |
| `case_participant` | actor aparece como `recorded_by_user_id` o miembro de `author_organization_id` en algún event del caso |
| `org_custody_holder` | actor pertenece a una org que tiene `shelter_custody` activa o reciente (dentro de followup window) del primary_pet |
| `govt_in_scope` | actor es `govt` con assignment en `jurisdiction_locality` o `jurisdiction_province` del caso |
| `admin` | actor es `admin` (universal) |
| `anon_public` | sin sesión |

**Matriz inicial por case_kind** (sketch — el spec de lifecycles puede refinar):

### `bite_incident`

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| subject_owner | ✅ | redacted (victim_contact oculto si no lo aportó el owner) | ✅ (solo org del vet que reportó) | ✅ | ✅ (los que adjuntó el owner) |
| case_participant (vet) | ✅ | full | ✅ | ✅ | ✅ |
| govt_in_scope | ✅ | full | ✅ | ✅ | ✅ |
| admin | ✅ | full | ✅ | ✅ | ✅ |
| anon_public | ❌ | ❌ | ❌ | ❌ | ❌ |

### `welfare_denuncia`

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| subject_owner (si pet registrada) | ❌ (la denuncia es contra el dueño en muchos casos — no se le notifica de la existencia) | ❌ | ❌ | ❌ | ❌ |
| `denuncia_reporter` (autenticado, no anon) | ✅ (vía `DEN-XXXX-XXXX`) | redacted (sin datos de triage interno) | redacted | ✅ | ✅ (los suyos) |
| govt_in_scope (welfare officer) | ✅ | full | ✅ | ✅ | ✅ |
| admin | ✅ | full | ✅ | ✅ | ✅ |
| anon (con código de tracking) | tracking-status only | ❌ | ❌ | ❌ | ❌ |

### `adoption_listing` (org-side, master case por pet+org)

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| org_custody_holder (refugio dueño del listing) | ✅ | full (incluido cross-application aggregate: cantidad de postulaciones, status de cada una) | full (todos los applicants, vet, voluntarios involucrados) | ✅ | ✅ |
| subject_owner (= adopter post-finalización, durante followup window) | ✅ (resumen post-adopción) | full de los events post-finalización (checkins, su propia ownership); meta-only de los pre-finalización (sabe que hubo otros postulantes pero no cuáles) | reducido (refugio + sus propios checkins) | ✅ | ✅ (los suyos + el contrato firmado) |
| applicant (cualquiera postulado al listing, durante review) | meta-only ("esta pet tiene listing activa") | ❌ (no ve events del listing — toda su actividad vive en su propio `adoption_application`) | ❌ | ✅ | ❌ |
| govt_in_scope | meta-only (campañas, métricas, aggregate por jurisdicción) | ❌ | ❌ | ✅ | ❌ |
| admin | ✅ | full | full | ✅ | ✅ |

### `adoption_application` (applicant-side, per postulación)

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| applicant (dueño de la postulación) | ✅ | full (su postulación punta a punta — submitted, su resolved, won/lost) | reducido (solo refugio destinatario; NO ve otros applicants, NO ve deliberación interna del refugio) | ✅ | ✅ (los que adjuntó él) |
| org_custody_holder (refugio destinatario) | ✅ | full (incluyendo notas internas del review en el `note_added` con scope `internal_org`) | full (applicant + sus refs) | ✅ | ✅ |
| other_applicants_to_same_listing | ❌ | ❌ | ❌ | ❌ | ❌ |
| subject_owner (= adopter post-finalización, si esta application es la ganadora) | ✅ (su propia historia, como recordatorio) | full | reducido | ✅ | ✅ |
| govt_in_scope | ❌ | ❌ | ❌ | ✅ (solo el lookup) | ❌ |
| admin | ✅ | full | full | ✅ | ✅ |

**Asimetría visible**: el `org_custody_holder` ve TODO en ambos kinds (es su flujo). El `applicant` solo ve su propia `adoption_application` y no tiene visibilidad sobre `adoption_listing` salvo meta-confirmación de que existe. Esto materializa D8 del spec adoption-listing ("postulante no ve competencia") como RLS, no como filtro en application code.

### `lost_pet_episode`

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| subject_owner | ✅ | full | full (incluyendo scanners autenticados de la credencial) | ✅ (interno, ninguna ley dura) | ✅ |
| org_custody_holder (refugio de targeting del broadcast) | ✅ (resumen del lost-pet, no full) | redacted (sin scan-history detallado) | reducido | ✅ | ❌ |
| govt_in_scope | meta-only para heatmap | ❌ | ❌ | ✅ | ❌ |
| anon_public | tier-1 view solo en credencial pública | N/A | N/A | N/A | N/A |

(Resto de kinds: completar en spec de lifecycles.)

**Implementación de visibilidad**: RLS policy sobre `cases` (por kind via función `case_visibility(case_id, auth_uid)`) + RLS sobre `pet_events` extendido — actualmente filtra por owner del pet; agregarle un OR para "puede ver porque tiene visibilidad del case_id". El test `pnpm rls:smoke` debe extenderse con 2-3 escenarios cross-case para verificar que un applicant no ve la competencia, un denuncia_reporter no ve triage notes, etc.

---

## 10. Interacción con conceptos existentes

### 10.1 Libreta sanitaria — ortogonal (D1)

La libreta sigue siendo una proyección por event_type (`LIBRETA_SANITARIA_EVENT_TYPES`). El `case_id` de un event no afecta su pertenencia a la libreta. Un `vet_visit_logged` durante un `bite_incident` aparece tanto en la libreta como en el caso. Un `vaccination_administered` siempre aparece en la libreta y nunca en un caso.

La UI del caso muestra **todos** los events atados al caso, ordenados, sin filtrar por libreta-ness. El cuadro "Libreta" sigue independiente. Si el usuario quiere ver "qué eventos médicos cayeron durante este bite_incident", lo ve directamente en la timeline del caso (los `vet_visit_logged` y `clinical_info_logged` atados explícitamente al caso vía modo `optional` aparecen sin necesidad de cruzar con libreta).

### 10.2 `welfare_reports` — caso es el envoltorio natural

La denuncia welfare se sigue creando primero (form público / autenticado / anon). En la misma transacción del INSERT:

1. INSERT `welfare_reports`
2. INSERT `cases` con `case_kind='welfare_denuncia'`, `welfare_report_id` apuntando atrás
3. UPDATE `welfare_reports.case_id` con el id del caso
4. INSERT cualquier `pet_events` bridge (`maltreatment_reported`, `abandonment_reported`, `symptom_observed`) ya con `case_id` del caso

El `DEN-XXXX-XXXX` sigue siendo el código de tracking público — pero el caso también tiene su `CAS-XXXX-XXXX`. Para denuncias, los códigos son interchangeables; la UI muestra DEN- al denunciante (continuidad de UX) y CAS- a govt/admin (consistencia con otros casos).

### 10.3 `Ownership` — el caso es histórico; ownership es proyección

Una `Ownership` row activa NO es un caso. La custodia es un estado permanente del pet (o semi-permanente para shelter_custody/foster). Los **cambios** de ownership son events (`custody_transferred`, `adoption_finalized`) que pueden atar a un caso. Pero "este pet está bajo custodia de tal refugio" no abre un caso por sí solo — abre uno cuando hay un workflow alrededor (intake, foster, dispute).

### 10.4 `Notification` — los casos generan notifications, no las reemplazan

El caso es un objeto de coordinación; las notifications son mensajes-a-usuarios. Cuando un caso cambia de estado significativamente (se abre, se cierra, una aprobación llega, una se vence), se emiten notifications a los actores con visibilidad apropiada. La notification carry-on un `related_case_id` (campo nuevo, similar a `related_event_id` y `related_pet_id` existentes).

### 10.5 Custody dispute — caso reemplaza la tabla? No

`custody_disputes` y `custody_dispute_parties` (Fase 14 admin page) se mantienen. El caso `custody_dispute` es el envoltorio coordinador, con `case.custody_dispute_id` apuntando atrás. La tabla `custody_disputes` retiene los datos específicos (external_proceeding_reference, las parties involucradas, outcome details). Mismo patrón que `welfare_reports`.

### 10.6 `Reminder` — sin cambio

Los reminders siguen apuntando a `source_event_id`. No al caso. Razón: un reminder es per-user, y el caso es scope-bound — confundir los dos llevaría a casos donde un reminder existe pero el actor perdió visibilidad del caso. Mantenelo simple: reminders viven del lado del event individual.

### 10.7 `Attachments` — un attachment hereda visibilidad de su event

Cuando un event con `case_id` tiene attachments, esos attachments heredan el scope del caso (no del pet). El RLS de `attachments` se actualiza para chequear:

```sql
exists(
  select 1 from pet_events e
  where e.id = attachments.event_id
    and (
      -- visibilidad histórica por pet
      can_read_pet(e.pet_id, auth.uid())
      OR
      -- visibilidad nueva por caso
      (e.case_id is not null and can_read_case(e.case_id, auth.uid()))
    )
)
```

Permite que un denuncia_reporter externo siga viendo SUS fotos adjuntas a una denuncia sin necesidad de tener visibilidad del pet (no la tiene — la denuncia puede ser contra un dueño desconocido).

---

## 11. Implementación — orden recomendado

(El plan completo va aparte. Acá solo el orden lógico para discutir):

1. **Schema base**: tabla `casos`, columna `case_id` en `pet_events`, columna `case_id` en `welfare_reports`. Migration nueva. Sin lógica.
2. **`lib/case-attachment.ts`**: declarar `CASE_ATTACHMENT_RULES` mapeando los 41 event_types al modo + compatibilidad del §7. Coverage test obligatorio.
3. **`lib/case-normatives.ts`**: lookup `(case_kind, jurisdiction) → LawReference[]`.
4. **Helper `attachEventToCase(eventInput) → { case_id, cascadeEvents[] }`**: función pura que dado un event input decide qué case_id ponerle y qué cascade emitir. Testeable en isolation.
5. **Refactor de cada server action que inserta events**: llamada a `attachEventToCase` antes del INSERT. Empezar por las dos más case-shaped: welfare actions y bite actions. Iterar.
6. **RLS extension**: agregar visibilidad por caso a `pet_events` y `attachments`. Función `can_read_case(case_id, uid)` en SQL.
7. **UI**: ruta `/casos/[publicCode]` con vista unificada (timeline + actores + normativas + pending approvals). Linkbacks desde pet profile ("Casos abiertos"), desde org portal, desde govt portal.
8. **Migration de datos retroactiva** (opcional, bajo el "DB se va a wipear" del catalog cleanup): si la DB se mantiene, backfill de cases para `welfare_reports` existentes, `custody_disputes`, `adoption_applications` con `status IN ('approved','finalized')`, y bites con observación abierta. Si la DB se wipea, ignorar.

Tiempo estimado punta-a-punta: 2-3 semanas (lifecycles spec + 6 actions refactoreadas + UI + RLS smoke). NO empezar plan hasta tener el spec de lifecycles aprobado.

---

## 12. Preguntas abiertas

- **`outbreak_investigation` polimórfico al `location`** — el primary_subject_kind=`location` introduce un caso sin pet. El modelo del §4 lo soporta. ¿Hay otros case_kinds futuros que vayan a necesitar primary_subject=`general` (no-pet, no-location)? Si sí, dejar el enum abierto.
- **Casos manuales sin event de apertura** — D3 permite que un admin abra un caso a mano. ¿Qué event_type registra ese acto? Opciones: (a) un `case_opened_manually` event nuevo que se ata al caso, (b) ningún event — el caso tiene su propio `opened_by` y eso es suficiente. Tendencia: (b) por simpleza, dejando los events para hechos sobre el sujeto, no metadata del caso mismo.
- **`rabies_observation_followup`** — la sección §6 lo mencionó como posible subcaso post-cierre profesional. Probablemente NO es un case_kind separado, sino una fase tardía del mismo `bite_incident` (status `escalated` después del cierre con outcome `positive_rabies`). Decidir en lifecycles spec.
- **Cases para event_types modo `optional` que mayoritariamente quedan sin atar** — `vet_visit_logged` y `clinical_info_logged` van a atar a casos raramente. ¿La UI default debe mostrar el selector siempre, o solo cuando hay caso compatible abierto? Tendencia: solo cuando hay (menor fricción).
- **Cierre del applicant ganador**: cuando `adoption_finalized` cierra la `adoption_application` ganadora, ¿usamos `adoption_application_resolved` con un marker (e.g., `outcome='approved'` + payload field `finalized=true`), o un event_type nuevo (`adoption_application_won`)? Tendencia: marker — evita inflar el catálogo y respeta el patrón cascade-emit ya establecido. Decidir en lifecycles spec.
- **Constraint de unicidad para `adoption_application`** — el index parcial sugerido en §4.1 (`(primary_pet_id, case_kind) WHERE status='open'`) no aplica directo a `adoption_application` porque puede haber N postulaciones paralelas. Constraint correcto para ese kind: `(primary_pet_id, case_kind, applicant_user_id) WHERE status='open'` — UNIQUE. Para `adoption_listing`: `(primary_pet_id, case_kind, opened_by_organization_id) WHERE status='open'` UNIQUE (una pet puede estar listada por múltiples orgs solo si tiene custody distribuida — caso edge). Concretar el SQL en el plan.
- **Casos pre-existentes a la migración** — incluso si la DB se wipea (catalog cleanup nota), los workflows productivos en el momento de wipe (denuncias activas, observaciones rábicas abiertas, adoption applications en review) requieren backfill manual. ¿Vale la pena escribir el script, o aceptar que el wipe descarta esos en-flight? Pregunta operativa.
- **Visibilidad del caso a usuarios que tuvieron relación histórica pero ya no** — un foster que cuidó al pet durante un `foster_placement` ya cerrado, ¿sigue viendo el caso después de cerrado? Tendencia: sí, dentro de una ventana (180 días) — coherente con el principio de transparencia retro del foster pool spec.
- **Notas internas del refugio en `adoption_application`** — la matriz de §9 menciona que `org_custody_holder` ve "notas internas del review en el `note_added` con scope `internal_org`". Esto requiere un nuevo payload field `scope: 'public' | 'internal_org'` en `note_added` — pequeño pero no trivial (afecta filtros de la libreta, RLS de events). Concretar en lifecycles spec o en un follow-up de `note_added` directamente.

---

## 13. Out of scope (para este doc)

- **Lifecycles detallados por `case_kind`** — los estados intermedios, condiciones de cierre auto, eventos pendientes, normativas exactas por kind. Va al spec sucesor `2026-05-19-cases-lifecycles-design.md`.
- **UI mocks** — `/casos/[publicCode]`, los entry points desde pet profile / org portal / govt portal. Va en spec posterior una vez los lifecycles estén firmes.
- **Reportes y exports** — exportar un caso a PDF para denuncia formal, integración con MPF CABA, etc. Cuando aparezcan los consumers.
- **Materializar campaigns como case_kind** — `campaign_episode` para campañas de vacunación/esterilización gubernamentales. Cuando llegue el campaign management UX (open question en AGENTS.md).
- **Plan de implementación** — el §11 es solo orden de trabajo; el plan ejecutable para Claude Code va separado, post-OK del spec de lifecycles.
