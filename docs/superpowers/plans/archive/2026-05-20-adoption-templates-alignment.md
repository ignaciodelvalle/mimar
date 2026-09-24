# Adoption templates alignment — actualizar el spec del handshake para usar formulario + contrato reales

> **Estado (2026-06-04):** ❎ DIFERIDO — el owner decidió que los 4 campos actuales cubren el caso; el wizard de 28 preguntas se re-evalúa cuando emerja demanda concreta (ver master-execution-plan). Nada implementado a propósito.

> **Estado:** Draft for approval — no implementar todavía.
> Plan **complementario** al de `2026-05-19-adoption-handshake.md`. Lo extiende; no lo reemplaza.
>
> **Fecha:** 2026-05-20
> **Owner:** Ignacio Del Valle
> **Trigger:** dos templates nuevos investigados en CABA (Lomas de Zamora gov + Catpuccino Adopciones + Proyecto 4 Patas + El Campito) que muestran que el flow real de adopción en CABA tiene **dos documentos distintos** que el handshake actual colapsa en uno solo.
>
> **Tamaño estimado:** +1 migración, ~12 archivos nuevos/modificados sobre el plan del 2026-05-19. Shippeable en 2 fases sobre la Fase 1–2 de ese plan.

---

## 0. Por qué este plan existe

El plan del **2026-05-19** (adoption handshake) modela **un único PDF por org** (`organization_documents.document_type = 'adoption_policy'`). Decisión **D1**: "una org, un PDF reemplazable. El contrato firmado sigue siendo off-platform."

Eso era razonable cuando el único documento que importaba era una "política de adopción" genérica. Pero al investigar lo que firman las orgs en CABA en la práctica, hay **dos documentos distintos con roles diferentes**:

| Documento | Cuándo se completa | Quién lo llena | Función |
|---|---|---|---|
| **Formulario de pre-adopción** | Antes de la aprobación. Es la postulación. | El postulante (adopter) | Recopila datos del hogar, experiencia, previsiones (mudanza, embarazo, vacaciones) para evaluar la fit. |
| **Contrato de adopción** | En el acto de entrega (= aceptar el handshake). | Org + adoptante firman. | Documento legal: datos del animal, datos de las partes, 12 cláusulas, anexo sanitario. Tiene merge fields per-adopción. |

El handshake actual asume que el PDF que el adoptante "lee y acepta" es **policy genérica**. En la realidad, lo que firma es **un contrato con sus datos y los del animal específico**. La estructura actual no soporta eso: el PDF es estático y no hay merge fields.

Además, la postulación actual (`ApplicationForm.tsx`) captura solo 4 campos (housing_type, other_pets, daily_routine, notes), pero el formulario real de orgs como Catpuccino tiene **~28 preguntas estructuradas** que cubren previsiones críticas que el equipo de adopciones necesita ver antes de aprobar.

**Outcome de este plan:**
1. La postulación (`adoption_application_submitted`) captura los campos del formulario real, no 4 free-text.
2. El "PDF de adopción" deja de ser un policy genérico y pasa a ser un **contrato per-adopción** generado server-side con datos mergeados de pet + adopter + org al momento del handshake.
3. Ambos documentos quedan archivados como artefactos del case `adoption_handshake`, con trazabilidad legal completa.

---

## 1. Audit del estado actual (gap vs. templates)

### 1.1 Formulario de postulación — gap

Estado en `lib/event-schemas.ts:971` + `ApplicationForm.tsx`:

```ts
adoptionApplicationSubmitted = {
  applicant_user_id, related_organization_id,
  housing_type: enum 4,
  other_pets: nullable string,
  daily_routine: nullable string,
  notes: nullable string,
}
```

Template (`Formulario_Pre-Adopcion_CABA.docx`) cubre 6 secciones:

| Sección | Campos del template | ¿Existe ya? |
|---|---|---|
| 1. Animal a adoptar | Nombre, especie, sexo, edad, tamaño, otras características | ✅ Derivado de `petToken` |
| 2. Datos del adoptante | DNI, edad, profesión, teléfono, domicilio, localidad, IG/FB | ⚠️ Parcial — vive en `profiles`, no en la application; recuperable por join pero no snapshoteado |
| 3. Sobre el hogar | tipo de vivienda, reglamento permite, balcón/patio, protección, personas en hogar, todos de acuerdo, alergias, dónde duerme | ❌ Solo `housing_type` está |
| 4. Experiencia con animales | mascotas previas, qué pasó con ellas, otros animales actuales (especie/sexo/edad/castrados/vacunados/alimento) | ❌ Solo `other_pets` free text |
| 5. Compromiso y previsiones | costos, castración, mudanza, embarazo, vacaciones, motivo de devolución, seguimiento | ❌ Nada |
| 6. Declaración + firma | declaración jurada, firma digital | ❌ Nada (el "submit" del form no es una declaración firmada) |

**Score:** 4/28 campos cubiertos. La org no tiene info suficiente para aprobar responsablemente.

### 1.2 Contrato — gap

Estado en el plan del 2026-05-19:
- `organization_documents.document_type = 'adoption_policy'` (un PDF estático que la org sube).
- Adoptante hace click en signed URL, lo lee, marca checkbox "lo leí", clickea Aceptar.
- **El PDF no tiene datos del adoptante ni del animal.** Es una política genérica.

Template (`Contrato_Adopcion_CABA.docx`) requiere:

| Sección | Contenido | Merge field? |
|---|---|---|
| Datos del adoptante | Nombre, DNI, domicilio, teléfono, email | Sí — desde `profiles` |
| Datos de la org entregante | Nombre, representante, DNI rep, domicilio | Sí — desde `organizations` |
| Datos del animal | Especie, raza, nombre, sexo, edad, tamaño, color, castrado, chip ID | Sí — desde `pets` |
| Cláusulas (12) | Estandarizadas (finalidad, condiciones, salud, castración, no-cesión, maltrato, seguimiento, salud al entregar, responsabilidad civil, incumplimiento, jurisdicción CABA) | No (estáticas, pero versionables) |
| Anexo sanitario | Tabla de vacunas y prácticas con fechas | Sí — desde `pet_events` (vaccination + deworm + castración) |
| Firmas | Bloque doble: adoptante + entregante con DNI y aclaración | Captured digitally (timestamp + user_id snapshot) |

**Score:** 0% del contrato actual está parametrizado. El "PDF policy" actual no es contrato.

---

## 2. Cambio conceptual propuesto

```
Plan 2026-05-19 (actual)                Plan 2026-05-20 (propuesto)
──────────────────────────              ──────────────────────────

Org sube UN PDF policy                  Org configura: 
("términos de la org")                   - Plantilla de cláusulas (versión activa)
                                         - Datos institucionales (representante, dirección)
                                         - (opcional) PDF custom override
       ↓                                       ↓
Adopter postula con 4 campos            Adopter postula con formulario estructurado
free-text                               (28 campos, validados, declaración jurada al final)
       ↓                                       ↓
Org aprueba → handshake muestra         Org aprueba → sistema GENERA contrato PDF
PDF policy genérico                     mergeando: pet + adopter + org + plantilla
                                        + anexo sanitario auto-poblado desde pet_events
       ↓                                       ↓
Adopter marca "lo leí" + Aceptar        Adopter ve el contrato con SUS datos + datos del 
                                        animal específico. Marca "lo leí" + Acepta.
                                        El sistema archiva el PDF generado como evidencia
                                        inmutable (storage path snapshotted en handshake row).
```

**Compatibilidad con el plan del 2026-05-19:**
- La tabla `adoption_handshakes` se conserva tal cual.
- `policy_storage_path` (snapshot) se renombra conceptualmente a `contract_storage_path` (mismo campo, mismo snapshot — solo cambia qué se snapshotea: ahora el PDF generado per-adopción, no el policy de la org).
- `organization_documents` ya no guarda un PDF; pasa a guardar **plantillas** (texto de cláusulas + metadata institucional). El nombre de la tabla se mantiene; cambia `document_type`.
- D8 ("signed URL + checkbox lo leí, no embed") se mantiene literal.
- D9 (snapshot en handshake row) se vuelve **más importante**, no menos: la mutabilidad de plantillas hace que el snapshot sea load-bearing.

---

## 3. Cambios al schema (sobre `0038_adoption_handshake_foundation.sql`)

### 3.1 Extensión de `adoption_application_submitted` event

Renombrar el zod de `lib/event-schemas.ts:971` a una v2 con campos estructurados. Versionado vía `withVersion` (patrón existente):

```ts
adoptionApplicationSubmitted_v2 = {
  // existentes
  applicant_user_id, related_organization_id,
  housing_type: enum 4,
  // nuevos — sección 3 "sobre el hogar"
  rental_pets_allowed: nullable boolean,    // null si vivienda propia
  has_balcony_or_yard: boolean,
  home_has_protection: nullable boolean,    // null si no aplica
  household_size: int,
  household_ages: nullable string,
  household_unanimous: boolean,
  household_allergies: nullable boolean,
  sleep_arrangement: nullable string,
  // nuevos — sección 4 "experiencia"
  has_previous_pets: boolean,
  previous_pets_outcome: nullable string,
  has_current_pets: boolean,
  current_pets_detail: nullable string,     // JSON o texto libre — ver §3.4
  current_pets_food_brand: nullable string,
  // nuevos — sección 5 "compromiso y previsiones"
  can_cover_costs: boolean,
  will_castrate_if_needed: boolean,
  plan_if_move: nullable string,
  plan_if_new_place_disallows: nullable string,
  plan_if_pregnancy: nullable string,
  plan_if_vacation: nullable string,
  return_reasons: nullable string,
  accepts_post_adoption_followup: boolean,
  // legacy preservados
  other_pets: nullable string,              // mantener back-compat
  daily_routine: nullable string,
  notes: nullable string,
  // nuevo — declaración
  declared_truthful_at: timestamptz,        // timestamp del submit con declaración jurada checkbox
}
```

Estrategia: usar `schema_version: 2` en `withVersion`. Eventos viejos (`schema_version: 1`) siguen validando con el shape original. Reader code lee discriminado por versión (patrón ya usado en `event-schemas.ts`).

### 3.2 `organization_documents` deja de ser PDF; pasa a ser plantilla

Migración nueva: `db/migrations/0039_adoption_contract_template.sql`.

```sql
alter table public.organization_documents
  drop constraint organization_documents_document_type_check;

alter table public.organization_documents
  add constraint organization_documents_document_type_check
  check (document_type in (
    'adoption_policy',                 -- legacy, soft-deprecated
    'adoption_contract_template'       -- nuevo
  ));

-- Para plantillas: el storage_path puede ser null (la plantilla vive en columnas
-- estructuradas, no en archivo). Mime también nullable.
alter table public.organization_documents
  alter column storage_path drop not null,
  alter column mime_type drop not null;

alter table public.organization_documents
  add column representative_full_name text,
  add column representative_id_number text,    -- DNI / CUIT del firmante de la org
  add column org_legal_address text,
  add column extra_clauses_md text,            -- markdown opcional de cláusulas extra
  add column jurisdiction text default 'Ciudad Autónoma de Buenos Aires';
```

Las cláusulas estándar (las 12 del template) viven en **código** versionado (`lib/adoption-contract-clauses.ts`), no en la DB. Razón: las cláusulas legales cambian raramente y necesitan code review (no editing libre por orgs). Las `extra_clauses_md` permiten que la org agregue clausulas particulares (ej. "para gatos de raza Persa se exige cepillado diario") sin tocar las 12 base.

### 3.3 `adoption_handshakes` — renombre semántico

El campo `policy_storage_path` (definido en `0038_*.sql`) cambia su semántica: ahora apunta al PDF **generado** per-adopción, no al policy de la org. Para no romper el plan del 2026-05-19 si ya está en flight, agregar columnas nuevas en `0039_*.sql`:

```sql
alter table public.adoption_handshakes
  add column generated_contract_path text,           -- mismo storage path, nombre más claro
  add column contract_template_id uuid references public.organization_documents(id) on delete set null,
  add column contract_clauses_version text not null default 'v1';
```

Backfill `generated_contract_path = policy_storage_path` para handshakes existentes (deberían ser cero si todavía no se shipped el plan del 2026-05-19). Plan: deprecar `policy_storage_path` después de Fase 5 del plan original; por ahora coexisten.

### 3.4 Decisión abierta: `current_pets_detail` shape

Opciones:
- **A (simple):** free-text string. Bajo esfuerzo, alta flexibilidad, baja queryability.
- **B (estructurado):** JSONB array `[{species, sex, age, castrated, vaccinated, dewormed}]`. Permite badges en el portal org tipo "tiene 2 gatos castrados".
- **C (tabla):** `adoption_application_pets` con una row por mascota. Overkill probablemente.

**Recomendación: B** con un componente UI repeat-able que push/pop entries. Cuesta ~2 horas extra de UI y desbloquea filtros futuros.

---

## 4. Generación del contrato PDF

### 4.1 Trigger y storage

- **Cuándo:** al ejecutar `acceptAdoptionHandshakeAction` (= antes del commit de ownership transfer). Si la generación falla, el accept falla — invariante: no hay adopción aceptada sin contrato archivado.
- **Dónde:** mismo bucket `org-documents` del plan original.
- **Path:** `{organization_id}/contracts/{handshake_id}.pdf`.
- **Inmutabilidad:** el bucket policy no permite UPDATE — solo INSERT y soft-delete row-level. El PDF generado nunca se sobrescribe; si se rechaza por algún motivo y se reabre el handshake, se genera un sufijo `-v2.pdf`.

### 4.2 Stack de generación

Tres opciones:

| Opción | Pros | Contras |
|---|---|---|
| **A. `pdfkit` (Node)** | Sin headless browser, rápido en serverless | Lay out manual, poco "WYSIWYG" |
| **B. `@react-pdf/renderer`** | JSX → PDF, declarativo, fits con stack Next.js | +30 MB en deploy, slow cold start |
| **C. HTML → Puppeteer / Playwright** | Diseño en CSS, fácil de iterar | Requiere headless Chrome en runtime — no funciona en Vercel Edge, pesado en Node runtime |

**Recomendación: B (`@react-pdf/renderer`).** Razones:
- El template ya está modelado en `Contrato_Adopcion_CABA.docx`; portarlo a JSX es directo.
- El cold start extra es aceptable (la operación corre solo en accept handshake, no en hot paths).
- Permite preview en dev mode (renderizar a HTML para inspección visual antes de exportar).

Archivo nuevo: `lib/adoption-contract/render.tsx` exporta `renderAdoptionContractToBuffer({ pet, adopter, org, template, clauses, healthRecord }): Promise<Buffer>`.

### 4.3 Anexo sanitario auto-poblado

El template tiene una tabla de plan sanitario (antirrábica, séxtuple/óctuple, desparasitación interna/externa, castración). Datos vienen de `pet_events` filtrados por kind:
- `vaccination_administered`
- `deworming_administered`
- `sterilization_completed`

`lib/adoption-contract/health-record.ts` exporta `buildPetHealthRecord(petId): { vaccinations: [...], deworms: [...], sterilizations: [...] }` corriendo una query indexada por `pet_id + occurred_at desc`.

Si la mascota no tiene los eventos requeridos (ej. no consta la antirrábica), el contrato muestra "**Pendiente**" en lugar de la fecha — con warning visible al adoptante. **No bloquea la firma** (decisión: el adoptante puede aceptar sabiendo que la org se compromete a completar el plan sanitario; el PDF lo deja documentado).

### 4.4 Firma digital

El "bloque de firmas" del template tiene espacio para firma manuscrita. En digital:
- **Adoptante:** se considera firmado por el simple hecho de clickear Aceptar, con timestamp + user_id + IP + user-agent guardados en `adoption_handshakes.accepted_at + accepted_metadata jsonb`.
- **Org:** ya firmó conceptualmente al subir la plantilla y aprobar el handshake. El PDF rendereado muestra:
  ```
  [Adoptante]: Firma digital aceptada el {date} por {full_name}, DNI {dni}, IP {ip}.
  [Org]: Firma digital aceptada el {date} por {representative_full_name}, DNI {representative_id_number}.
  ```
- **No** hay firma criptográfica formal (PKI / firma digital con certificado AFIP). Es firma electrónica simple, suficiente para el contrato civil pero **NO equivale** a una firma con certificado oficial. Documentar este límite en `AGENTS.md` y en el FAQ de adopción.

---

## 5. Cambios a UI

### 5.1 Postulación — `ApplicationForm.tsx`

De un form chico a un wizard de 4 pasos (no scrollazo de 28 inputs en una pantalla):

| Paso | Contenido | Validación |
|---|---|---|
| 1. Vivienda | tipo, reglamento, balcón, protección, personas | required: tipo, household_size, household_unanimous |
| 2. Otros animales | previas, actuales (lista repeat-able si current_pets > 0) | required: has_previous_pets, has_current_pets |
| 3. Previsiones | costos, castración, mudanza, embarazo, vacaciones, motivos de devolución | required: can_cover_costs, will_castrate_if_needed, accepts_post_adoption_followup |
| 4. Declaración | resumen + checkbox "declaro bajo juramento que los datos son verídicos" | required: checkbox marcado para enable submit |

Persistencia local entre pasos: `useReducer` (no localStorage — el form es corto y el riesgo de pérdida por reload es aceptable; documentarlo).

Componentes nuevos:
- `app/adoptar/[petToken]/postular/wizard/Step1Housing.tsx`
- `app/adoptar/[petToken]/postular/wizard/Step2OtherPets.tsx`
- `app/adoptar/[petToken]/postular/wizard/Step3Commitment.tsx`
- `app/adoptar/[petToken]/postular/wizard/Step4Declaration.tsx`
- `app/adoptar/[petToken]/postular/wizard/ApplicationWizard.tsx` (orquestador)

### 5.2 Org review — `/org/[orgToken]/adopciones/[applicationEventId]`

Mostrar todos los campos nuevos en secciones colapsables. Default expandido: "Vivienda" + "Previsiones" (los más críticos). El review-time es la pantalla donde Catpuccino-style decision happens — la org necesita ver todo claramente.

### 5.3 Org config — `/org/[orgToken]/configuracion/adopciones`

Reemplazar el upload de PDF por un formulario de **plantilla de contrato**:

```
[Sección "Datos institucionales para el contrato"]
- Representante legal (nombre completo): [____________]
- DNI/CUIT del representante:           [____________]
- Domicilio legal de la org:            [____________]
- Jurisdicción:                          [CABA ▼]

[Sección "Cláusulas estándar"]
✅ Finalidad: animal de compañía
✅ Prohibiciones de uso (caza, peleas, cría, etc.)
✅ Condiciones de tenencia
✅ Salud y bienestar
✅ Castración obligatoria
✅ Prohibición de cesión y abandono
✅ Maltrato (Ley 14.346)
✅ Seguimiento post-adopción
✅ Estado de salud al entregar
✅ Responsabilidad civil
✅ Incumplimiento
✅ Jurisdicción

[Sección "Cláusulas adicionales" (opcional)]
[textarea markdown] ____________________

[Botón]: Vista previa del contrato (PDF render con datos de ejemplo)
```

El PDF de override (path antiguo) queda disponible como escape hatch para orgs que quieran subir su propio contrato escaneado. Hidden behind "Avanzado".

### 5.4 Adopter signing — `/cuenta/adopciones/[handshakeToken]`

El signed URL ahora apunta al PDF generado per-adopción (con datos del adoptante y la mascota ya mergeados). El copy del checkbox cambia ligeramente:

- Antes: "Descargué y leí el contrato de adopción"
- Después: "Descargué y leí el contrato de adopción que contiene mis datos y los del animal"

Esa frase deja claro al adoptante que el documento es personalizado.

---

## 6. Implementación por fases (sobre el plan del 2026-05-19)

Asume que **Fase 1 y 2 del plan del 2026-05-19 ya están mergeadas** (foundation + upload UI). Si no, ejecutar primero esas y agregar este plan como Fase 1.5 + 2.5.

### Fase A — Schema + plantilla (1 día)

- `db/migrations/0039_adoption_contract_template.sql` — extender `organization_documents`, agregar columnas a `adoption_handshakes`.
- `lib/event-schemas.ts` — `adoptionApplicationSubmitted_v2` con los 20+ campos nuevos.
- `lib/adoption-contract-clauses.ts` — las 12 cláusulas en `const CONTRACT_CLAUSES_V1 = [{...}]`.
- Tests:
  - `__tests__/adoption-application-v2-schema.test.ts` — valida back-compat con v1.
  - Schema integration test sobre la nueva shape de `organization_documents`.

**Sin UI nueva. Sin behavior change.** Safe to ship.

### Fase B — Wizard de postulación (1.5 días)

- 5 componentes nuevos bajo `app/adoptar/[petToken]/postular/wizard/`.
- `submitAdoptionApplicationAction` toma `_v2` payload y emite `adoption_application_submitted` con `schema_version: 2`.
- `ApplicationForm.tsx` legacy queda como fallback feature-flagged (default off).
- Updates al org review page para renderear los nuevos campos.

Tests:
- Cada step renderiza, validación per-step, submit final emite event v2.
- Org review page muestra todos los campos sin error.

### Fase C — Plantilla de contrato (org config) (1 día)

- `app/org/[orgToken]/configuracion/adopciones/page.tsx` reemplaza el upload de PDF por el form de plantilla.
- `app/actions/organization-documents.ts:upsertAdoptionContractTemplateAction` (reemplaza el upload action).
- Vista previa: endpoint `/api/preview/adoption-contract?orgToken=...` que rendera con datos dummy.

### Fase D — Generación del contrato + accept flow (1.5 días)

- `lib/adoption-contract/render.tsx` con `@react-pdf/renderer`.
- `lib/adoption-contract/health-record.ts` query de eventos sanitarios.
- `acceptAdoptionHandshakeAction` ahora:
  1. Genera el PDF (in-memory).
  2. Sube a `org-documents/{org_id}/contracts/{handshake_id}.pdf`.
  3. Snapshot del path en `adoption_handshakes.generated_contract_path`.
  4. Solo entonces ejecuta el ownership transfer + cascade.
- Si la generación falla → handshake queda en `pending`, error visible al adoptante, sin daño en ownership.

Tests:
- E2E: postular → aprobar → handshake genera contrato → adoptante acepta → PDF queda archivado y descargable.
- Failure mode: storage upload falla → handshake no avanza, ownership no cambia.

### Fase E — Deprecar `adoption_policy` PDF (0.5 día)

- Marcar `'adoption_policy'` en `organization_documents` como deprecated (no eliminar; orgs con PDF custom override siguen funcionando).
- Update docs (`AGENTS.md` sección Adopción).

**Total estimado:** 5.5 días de trabajo sobre el plan del 2026-05-19. Total con el plan original: ~7 días.

---

## 7. Riesgos y decisiones abiertas

| Riesgo / Decisión | Comentario |
|---|---|
| **Wizard vs. one-page form** | Long forms tienen drop-off alto. Wizard es la práctica estándar (Typeform, etc.). Drawback: navegación más compleja para usuarios menos técnicos. Mitigación: progress bar visible + permitir saltar atrás sin perder datos. |
| **Auto-poblado del anexo sanitario** | Si la mascota no tiene los eventos requeridos (común en orgs que migran a DIM), el contrato sale con "Pendiente". ¿Bloquear el accept o solo warning? **Recomendación: warning, no bloqueo** — la org se compromete a completar y queda documentado. |
| **Firma electrónica simple vs. firma digital con certificado** | Para CABA (jurisdicción civil), firma electrónica simple + log de auditoría es válida para contratos privados. No reemplaza firma digital AFIP para actos públicos. Documentar explícitamente. |
| **JSONB para current_pets vs. tabla aparte** | Recomendación: JSONB. Si más adelante queremos analytics tipo "adoptantes con ≥2 gatos previos castrados son 30% más exitosos", migramos a tabla. |
| **¿Versionar las cláusulas?** | Sí. `contract_clauses_version` en el handshake row. Si subimos un `v2` de las cláusulas, los contratos viejos firmados bajo `v1` se siguen renderando correctamente. |
| **Idioma del contrato** | Solo español rioplatense por ahora. Si DIM se expande a otras jurisdicciones, plantear i18n del contrato. |
| **Adoptante quiere copia firmada por escrito** | El PDF generado se ofrece como descarga al adopter después del accept. Sí, eso ya está cubierto por el signed URL del path. |
| **Org quiere subir contrato escaneado en lugar de generar** | Mantener el path legacy `'adoption_policy'` como opt-in avanzado. No es default. |

---

## 8. Checklist de aprobación

Antes de ejecutar este plan, confirmar:

- [ ] **¿El plan del 2026-05-19 ya está en flight o no?** Si todavía no se mergeó, considerar mergear los dos planes en uno solo para evitar dos migraciones consecutivas. Si ya está en flight, este plan se shippea encima.
- [ ] **¿Aceptás generar el contrato PDF en el server con `@react-pdf/renderer`?** Alternativa: contratar un servicio tipo PDFMonkey / DocuSeal. Para uni project, librería local es mejor (cero costo, cero dependencias externas).
- [ ] **¿Firma electrónica simple es suficiente para el proyecto?** Asumido sí (es la práctica de Catpuccino, El Campito, etc.).
- [ ] **¿OK el JSONB para `current_pets_detail`?**
- [ ] **¿Mantener el wizard de 4 pasos o preferís single-page con secciones?**
- [ ] **¿Bloquear el accept si el anexo sanitario está incompleto, o solo warning?**

---

## 9. Archivos críticos para Claude Code (orden de implementación)

1. `db/migrations/0039_adoption_contract_template.sql` — base del schema nuevo.
2. `lib/adoption-contract-clauses.ts` — fuente de verdad de las cláusulas.
3. `lib/event-schemas.ts` — `adoptionApplicationSubmitted_v2`.
4. `lib/adoption-contract/render.tsx` — el render del PDF.
5. `app/actions/adoption-applications.ts` — accept el payload v2.
6. `app/adoptar/[petToken]/postular/wizard/*` — la nueva postulación.
7. `app/org/[orgToken]/configuracion/adopciones/page.tsx` — form de plantilla.
8. `app/actions/adoption-handshakes.ts:acceptAdoptionHandshakeAction` — render + upload + snapshot antes del transfer.
9. `__tests__/adoption-contract-render.test.ts` — snapshot test del render.

### Patrones a clonar

- Wizard pattern: ver si existe en el codebase. Si no, base mínima en `useReducer` + tab buttons. No traer Zustand ni react-hook-form solo para esto.
- PDF render: ejemplo oficial `@react-pdf/renderer` README. Mantener el estilo visual sobrio del template `.docx` actual (Arial, headings centrados, tablas con bordes sutiles).

---

**Fin del plan. Aprobá o pedí ajustes; después se ejecuta en Claude Code en orden de Fase A → E.**
