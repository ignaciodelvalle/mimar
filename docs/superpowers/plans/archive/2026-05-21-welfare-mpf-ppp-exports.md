# Welfare fiscalía MPF + PPP exports — plan ejecutable (Chunk F)

> **Status (2026-05-21):** ✅ **SHIPPED.** F-D1=A (PDF libre), F-D2=A (sin firma PKI), F-D3+F-D4=C (solo CABA v1, Prov BA v2), F-D5+F-D6=A+A (snake_case + 2 buckets). F1 (MPF CABA) + F2 (PPP CABA) entregados en un mismo PR. PPP Prov BA queda como `TODO(F2-prov-ba-v2)`. Plan archivado abajo como referencia histórica.
>
> **Fecha:** 2026-05-21
> **Owner:** Ignacio Del Valle
> **Audiencia:** Claude Code (input directo, cuando se reactive)
> **Estimación:** ~7 días (F1 ~4d + F2 ~3d, parcialmente paralelos) — válida cuando se descongele
> **Origen:** `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` §Chunk F
> **Design spec:** ❌ NO EXISTE — este plan es la de-facto spec para F1 + F2
> **Decisiones cerradas:** ninguna pre-existente en `2026-05-21-pending-decisions-resolved.md` para Chunk F; ver §Decisiones a tomar abajo

---

## Resumen ejecutivo

Chunk F entrega dos pipelines de export formal en PDF. F1 genera la denuncia MPF
(Ministerio Público Fiscal) lista para presentar ante la Unidad Fiscal de Maltrato
Animal de CABA, citando Ley Nacional 14.346, e incluye referenceCode, lugar georreferenciado,
descripción del hecho, datos del sujeto y adjuntos firmados. F2 genera el export PPP
provincial para las jurisdicciones que lo exigen (CABA + Prov BA v1), permitiendo al
owner descargar un PDF firmado por DIM para llevarlo al registro correspondiente, con
auto-push opcional si en el futuro se descubren APIs de registro.

**Diferencia crítica respecto a E6 (analytics export):** E6 anonimiza — aplica Zod
schemas que descartan PII antes de generar el CSV. F1 y F2 hacen exactamente lo
opuesto: son documentos legales que REQUIEREN PII visible (nombre del animal, datos
del denunciante, microchip, coordenadas exactas del hecho). No usan el patrón de
anonimización de `lib/govt-exports.ts`. El pipeline compartido con E6 se limita a la
capa de infraestructura: Storage privado → signed URL 24h → email vía Resend +
audit_log row por export.

> **Nota de estado E6:** `lib/govt-exports.ts` y `app/gob/analytics/export/actions.ts`
> aún no existen — E6 no ha shippeado al momento de escribir este plan (último commit:
> `e5ee8ba` — E5). F1b/F2b replicarán el patrón planificado en E6 pero no dependen
> de que E6 esté mergeado.

---

## Diferencias vs E6 (analytics export)

| Dimensión | E6 — analytics export | F1 — MPF denuncia | F2 — PPP export |
|---|---|---|---|
| Propósito | Dataset analítico para funcionarios | Documento legal para fiscalía | Documento para registro provincial |
| PII | Anonimizada (Zod field-drop) | Requerida (nombre, geoloc exacta, denunciante) | Requerida (owner DNI, breed, microchip) |
| Ley principal | Ley 25.326 (datos personales) | Ley 14.346 (maltrato animal) | Ley CABA 4078 / Prov BA 14.107 |
| Audiencia del doc | Analista público | Fiscal/oficial de bienestar | Organismo de registro PPP |
| Formato | CSV / JSON | PDF (una página A4) | PDF (una página A4) |
| Origen de datos | Multi-tabla aggregation | `welfare_reports` + attachments | `pets` + `govt_business_rules` PPP |
| Actor que dispara | Govt con `analytics.read` | Govt/admin con acceso al caso | Owner del pet PPP |
| Generación | Síncrona (misma request) | Síncrona (misma request) v1 | Síncrona (misma request) v1 |
| Anonymization helper | `petsExportSchema.parse()` | ❌ No aplica | ❌ No aplica |

---

## Hallazgo: contexto legal existente en el repo

`lib/case-normatives.ts` ya documenta los marcos legales que F1 usa verbatim:

```ts
// lib/case-normatives.ts líneas 106-128
{
  kind: "welfare_denuncia",
  jurisdiction: { country: "AR" },
  laws: [
    {
      id: "ley_nacional_14346_1954",
      label: "Ley Nacional 14.346 (1954)",
      scope: "Malos tratos y actos de crueldad contra animales",
    },
  ],
},
{
  kind: "welfare_denuncia",
  jurisdiction: { country: "AR", province: "Ciudad Autónoma de Buenos Aires" },
  laws: [
    {
      id: "caba_mpf_pipeline",
      label: "MPF CABA — Unidad Fiscal de Maltrato Animal",
      scope: "Pipeline de denuncia formal (referencia operativa, no marco legal)",
    },
  ],
},
```

El template PDF de F1 puede usar estas strings verbatim. La sección "Normativa
aplicable" del PDF cita `label` + `scope` de ambos objetos, en ese orden.

---

## Hallazgo: infraestructura PPP existente

No hay columnas `pppRequiresAttestation` ni `pppEligibleStartedAt` en `pets`. El
campo relevante es `pets.potentiallyDangerousBreed` (boolean, migration 0026). La
elegibilidad PPP para el export se determina en tiempo de ejecución combinando:

| Fuente | Dato |
|---|---|
| `pets.potentiallyDangerousBreed` | Flag baseline (se fija al registrar) |
| `lib/breeds-server.ts` `isPotentiallyDangerousBreedForJurisdiction()` | Re-evaluación jurisdiction-aware |
| `db.govtBusinessRules` `ppp_breed_list` | Override de jurisdicción |
| `db.govtBusinessRules` `ppp_weight_threshold` | Override de peso |
| `db.govtBusinessRules` `ppp_attestation_required_registries` | ¿A qué registro llevar? |
| `lib/business-rules-resolver.ts` `resolveBusinessRule()` | Cascading resolver (locality > province > country) |
| `lib/business-rules-validators.ts` `pppAttestationRequiredRegistriesSchema` | Zod validator del payload |

El POC de reglas PPP (T7-E spec + Chunk A.5) ya está en el repo. F2 LEE de esta
infraestructura — no crea nueva lógica de elegibilidad. Solo agrega la capa de
generación del documento.

---

## Hallazgo: dependencias técnicas

| Paquete | Estado | Acción en F1b |
|---|---|---|
| `@react-pdf/renderer` | ❌ NO instalado (verificado en `package.json`) | `pnpm add @react-pdf/renderer` — pre-flight obligatorio |
| `resend` | ❌ NO instalado (no encontrado en `package.json`) | `pnpm add resend` — pre-flight obligatorio |
| `maplibre-gl` | ✅ `^5.24.0` | Sin cambios |
| `recharts` | ✅ `^3.8.1` (instalado en E1) | Sin cambios |
| Supabase Storage SDK | ✅ via `@supabase/supabase-js` | Pattern ya en `lib/storage.ts` |

> **Nota sobre Resend:** E6 fue planificado para usar Resend pero aún no shippeó.
> F1b instala el paquete. Cuando E6 sea implementado, usará la misma instalación.
> Coordinar para que F1b y E6 no creen un conflicto de versión de paquete.

---

## Decisiones a tomar (owner input requerido antes de F1b/F2b)

### F-D1. Formato MPF CABA — ¿template oficial o PDF libre de DIM?

**Contexto:** La Unidad Fiscal de Maltrato Animal del MPF CABA no publica un formulario
oficial digitalizable en su sitio web. Las denuncias formales se realizan de dos formas
documentadas: (a) presentación presencial con escrito libre firmado + datos del
denunciante + relato de hechos + evidencias, o (b) denuncia web en el portal del MPF
(`fiscales.gob.ar`) para delitos incluidos en Ley 14.346 que NO requiere un template
fijo — acepta formato de escrito judicial estándar (carátula, numeración, relato
cronológico, pruebas adjuntas).

**Opciones:**

| Opción | Descripción | Ventaja | Riesgo |
|---|---|---|---|
| A | PDF libre diseñado por DIM con los campos de Ley 14.346 (recomendada) | Bajo acoplamiento; funciona para cualquier jurisdicción | No es "el formulario oficial" — el oficial puede pedir uno diferente |
| B | Replicar el escrito judicial estándar del MPF (carátula con nro. de expediente, cuerpo en formato judicial) | Mayor aceptación institucional | Requiere conocer el formato exacto; puede variar por fiscalía |
| C | Ambas: PDF libre + opción "modo formal" con campos de escrito judicial | Máxima flexibilidad | +0.5d de scope |

**Decisión del owner requerida:** A / B / C. Este plan asume **A** como default si no
hay respuesta antes de iniciar F1b. El switch a B o C es menor porque el rendering
es en `lib/welfare-exports.ts`.

---

### F-D2. Firma digital del PDF — nivel requerido

**Contexto:** Argentina regula la firma electrónica en la Ley 25.506 (2001). Para
documentos presentados ante la MPF, la firma "electrónica simple" (sin PKI federal)
tiene valor referencial pero no es equiparable a la firma manuscrita a menos que la
contraparte la acepte. En la práctica los escritos digitales se presentan vía portal
y la trazabilidad la da el acuse de recibo del sistema, no la firma en el PDF.

**Opciones:**

| Opción | Descripción | Costo técnico | Peso legal |
|---|---|---|---|
| A | Sin firma en el PDF — trazabilidad via `referenceCode` + audit_log + signed URL (recomendada para v1) | Mínimo | Suficiente para presentación informal / portal web |
| B | Firma electrónica con clave privada DIM (PKI auto-gestionada, no federal) | Medio (necesita cert management) | "Firma electrónica" per Ley 25.506 §5 |
| C | Firma digital con PKI federal (Argentina.gob.ar / DNRPA) | Alto (depende de integración externa) | Equiparable a manuscrita per Ley 25.506 §2 |

**Decisión del owner requerida:** A / B / C. Este plan asume **A** (sin firma PKI en
v1; el `referenceCode` impreso en el PDF + URL firmada por Supabase Storage es
suficiente para trazabilidad operativa). B y C quedan como diferidos.

---

### F-D3. Canal PPP — CABA: ¿existe API de registro?

**Contexto:** La CABA regula PPP via Ley 4078 y requiere que los dueños inscriban
sus perros PPP en el Registro Único de Perros Potencialmente Peligrosos (RUPPPA). El
registro se realiza en las comunas o en SENASA (para razas de alto porte con
antecedentes). No se encontró evidencia de una API pública o endpoint REST del RUPPPA
CABA que acepte inscripciones programáticas. El canal documentado es presencial o
formulario PDF + turno web en `buenosaires.gob.ar`.

**Opciones:**

| Opción | Descripción |
|---|---|
| A | PDF-only: DIM genera el PDF, el owner lo descarga e imprime para llevar a la comuna (recomendada v1) |
| B | Auto-push si el owner confirma que tiene turno + DIM envía el PDF por email al registro (semi-automatizado) |
| C | Investigación adicional de API CABA antes de implementar (agrega ~0.5d al F2a scope) |

**Decisión del owner requerida:** A / B / C. Este plan asume **A** para v1.

---

### F-D4. Canal PPP — Prov BA: ¿existe API de registro?

**Contexto:** La Provincia de Buenos Aires rige PPP via Ley 14.107. El registro
provincial es descentralizado — cada municipio lleva su propio padrón. La Prov BA no
publica una API unificada de registro PPP. El canal documentado es municipal presencial.

**Opciones:**

| Opción | Descripción |
|---|---|
| A | PDF-only (misma lógica que CABA, opción A de F-D3) — recomendada v1 |
| B | Listar los municipios con registro y generar PDFs diferenciados por municipio |
| C | Diferir Prov BA — sólo CABA en v1, Prov BA en v2 |

**Decisión del owner requerida:** A / B / C. Este plan asume **A** (PDF genérico Prov BA
que el owner lleva al municipio). La cabecera del PDF indica "Registro PPP — Provincia
de Buenos Aires" sin hardcodear el municipio específico.

---

### F-D5. Naming de las action constants en audit_log

Las acciones nuevas deben agregarse a `AUDIT_LOG_ACTIONS` en `db/schema.ts`. El catálogo
existente usa convenciones mixtas (`"welfare_report_triaged"`, `"microchip.replace"`).

**Opciones de nombre:**

| Acción | Opción A (snake_case) | Opción B (dot.notation como microchip) |
|---|---|---|
| Export MPF generado | `"welfare_mpf_export_generated"` | `"welfare.mpf_export"` |
| Export PPP generado | `"ppp_export_generated"` | `"ppp.export"` |

**Decisión del owner requerida:** A o B. Este plan asume **A** (snake_case, consistente
con la mayoría del catálogo).

---

### F-D6. Bucket de Storage para los exports

E6 (analytics export) usará el bucket `analytics-exports` (privado, por crear). F1 y F2
generan documentos con PII sensible — mezclarlos con datasets analíticos puede complicar
políticas de retención y auditoría.

**Opciones:**

| Opción | Buckets | Ventaja | Contra |
|---|---|---|---|
| A | `welfare-exports` + `ppp-exports` separados (recomendada) | Políticas de retención y RLS independientes | 2 buckets nuevos a crear en Supabase |
| B | Reutilizar `analytics-exports` con prefix de path (`welfare/`, `ppp/`) | Un solo bucket | Mezcla PII-rich con datos anonimizados; complica auditoría |
| C | Usar bucket existente `welfare-evidence` para F1 (ya existe) | 0 buckets nuevos para F1 | `welfare-evidence` es para uploads de usuarios, no para outputs de DIM |

**Decisión del owner requerida:** A / B / C. Este plan asume **A** (dos buckets
separados, `welfare-exports` y `ppp-exports`).

---

## F0 (este doc) — completado al escribir

- [x] Design spec implícita escrita (ningún `dim-interno:docs/design/0X-*.md` cubría F).
- [x] Confirmado: `docs/superpowers/plans/2026-05-21-pending-decisions-resolved.md` no tiene entradas para Chunk F.
- [x] Decisiones a tomar surfaced: 6 ítems (F-D1..F-D6).
- [x] Pipeline compartido con E6 definido (Storage + email + audit); divergencia de anonimización documentada.
- [x] Hallazgos legales (`lib/case-normatives.ts`), PPP (`lib/breeds.ts`, `lib/business-rules-resolver.ts`), y técnicos (`package.json`).
- [x] Confirmado: `@react-pdf/renderer` y `resend` NO están instalados → pre-flight en F1b.
- [x] Confirmado: E6 aún no shippeó → F1b instala Resend; coordinar con E6.
- [ ] **Owner action requerida:** resolver F-D1..F-D6 antes de iniciar F1b/F2b.

---

## F1 — Welfare fiscalía MPF (~4d)

### F1a — completado en F0 (spec + plan)

Este documento es el entregable de F1a.

### F1b — implementación (~3.5d)

#### Pre-flight F1b

```bash
pnpm add @react-pdf/renderer
pnpm add resend
# Verificar versiones instaladas y anotar aquí antes de continuar.
# @react-pdf/renderer: probablemente ^3.x — verificar peer deps con React 19.
```

> **Peer deps check:** `@react-pdf/renderer` v3+ soporta React 18. Con React 19
> puede requerir `--legacy-peer-deps` o esperar v4. Verificar al instalar; si hay
> conflicto, evaluar `pdf-lib` como alternativa (ver §Ambigüedades #1).

#### Archivos a crear / modificar — F1b

| Path | Acción | Razón |
|---|---|---|
| `db/schema.ts` | MODIFY | Agregar `"welfare_mpf_export_generated"` a `AUDIT_LOG_ACTIONS` (convención F-D5) |
| `lib/welfare-exports.ts` | NEW | Tipos DTO + mapper `welfareReportToMpfDto()` + template PDF via `@react-pdf/renderer` |
| `lib/storage-exports.ts` | NEW | Helper: `uploadExportToStorage(bucket, path, buffer)` + `createSignedExportUrl(bucket, path, ttl)` — abstracción compartida con F2 y E6 |
| `app/actions/welfare-export-mpf.ts` | NEW | Server action `generateMpfExportAction(reportId)`: mapper → render PDF → Storage upload → Resend email → audit_log |
| `app/gob/maltrato/[id]/MpfExportButton.tsx` | NEW | Client component: botón "Exportar a fiscalía" + confirmation dialog + estado de loading |
| `app/gob/maltrato/[id]/page.tsx` | MODIFY | Integrar `<MpfExportButton reportId={report.id} />` debajo de `<TriageActions>` |
| `__tests__/welfare-mpf-export.test.ts` | NEW | Unit tests del DTO mapper + integration test del server action |

#### Template PDF — F1b (`lib/welfare-exports.ts`)

El template se renderiza con `@react-pdf/renderer` (`<Document>`, `<Page>`, `<View>`,
`<Text>`) y produce un A4 de una sola página. Secciones del documento:

| Sección | Campos fuente |
|---|---|
| **Encabezado DIM** | Logo DIM (SVG inline), texto "MiMAR — Mi Mascota Argentina", fecha de generación |
| **Referencia** | `welfareReports.referenceCode` (formato `DEN-XXXX-XXXX`), ID interno (hash truncado) |
| **Hecho** | `kind` (label), `severity` (label), `occurredAt` (fecha/hora), `description` (texto completo) |
| **Lugar** | `jurisdictionProvince`, `jurisdictionLocality`, `locationAddress` (si existe), `locationLat`/`locationLng` (coordenadas en grados decimales) |
| **Sujeto** | `subjectKind` label, `subjectDescription` (si existe), nombre del pet vinculado + microchip (si `subjectPetId` no es null) o "Animal no identificado" |
| **Denunciante** | `reporterOrganizationId` → nombre de la org si existe; `reporterUserId` → `displayName` del perfil; si ambos null: "Denuncia anónima — referenceCode disponible para seguimiento" |
| **Evidencias adjuntas** | Lista de `welfareReportAttachments` con filename + signed URL (1h TTL — URL para uso interno del funcionario) |
| **Normativa aplicable** | Verbatim de `lib/case-normatives.ts`: "Ley Nacional 14.346 (1954) — Malos tratos y actos de crueldad contra animales" + "MPF CABA — Unidad Fiscal de Maltrato Animal (referencia operativa)" |
| **Audit trail** | `exportGeneratedAt` (timestamp), `exportedByUserId` (displayName del actor), `reportCreatedAt` |
| **Pie** | "Documento generado por MiMAR. Para verificar autenticidad consultar código {referenceCode} en mimar.ar" |

#### Server action pipeline — F1b (`app/actions/welfare-export-mpf.ts`)

```ts
"use server";
// Pipeline: welfare report → PDF bytes → Storage → signed URL → email → audit log
// Pattern mirrors the planned E6 export pipeline (sync v1; add job table at scale).
export async function generateMpfExportAction(
  reportId: string,
): Promise<{ ok: true; signedUrl: string } | { ok: false; error: string }>
```

Flujo interno:
1. Auth guard: `requireAdminOrGovtOrRedirect()` + scope check (mismo que el detail page).
2. Leer `welfareReports` + `welfareReportAttachments` + actors.
3. Llamar `welfareReportToMpfDto()` para mapear a la estructura del template.
4. `renderToBuffer(<MpfDocument dto={dto} />)` de `@react-pdf/renderer`.
5. `uploadExportToStorage("welfare-exports", path, buffer)` — path: `${reportId}/${timestamp}.pdf`.
6. `createSignedExportUrl("welfare-exports", path, 86400)` — 24h TTL.
7. Enviar email via Resend al actor con el signed URL (template mínimo: asunto +
   link + validez 24h).
8. Insertar en `audit_log`: `{ action: "welfare_mpf_export_generated", actorUserId, payload: { reportId, referenceCode, storagePath, schemaVersion: "2026-05-21" } }`.
9. Retornar `{ ok: true, signedUrl }`.

#### Tests — F1b (`__tests__/welfare-mpf-export.test.ts`)

**Unit (lógica pura, sin DB):**
- `welfareReportToMpfDto()` con `subjectPetId = null` → campo sujeto dice "Animal no identificado".
- `welfareReportToMpfDto()` con `reporterUserId = null` y `reporterOrganizationId = null` → denunciante dice "Denuncia anónima".
- `welfareReportToMpfDto()` con `subjectPetId` valido → incluye nombre del pet + microchip (si existe).

**Integration (contra DB local con supabase start):**
- `generateMpfExportAction(validReportId)` → inserta fila en `audit_log` con `action = "welfare_mpf_export_generated"` y `payload.referenceCode` correcto.
- Actor sin acceso al caso (govt de otra jurisdicción) → retorna `{ ok: false, error: "not_found" }`.
- Storage upload mock: verificar que el path tiene el formato `{reportId}/{timestamp}.pdf`.

#### DoD — F1b

- [ ] `pnpm typecheck` clean (incluyendo los tipos de `@react-pdf/renderer`).
- [ ] `pnpm lint` clean.
- [ ] `pnpm test -- welfare-mpf-export` pasan (unit + integration).
- [ ] PDF renderiza sin error para un caso real en staging.
- [ ] Botón "Exportar a fiscalía" visible en `/gob/maltrato/[id]` solo para `govt` y `admin`.
- [ ] Email con signed URL llega al actor (smoke en staging).
- [ ] Audit log row insertado con `action = "welfare_mpf_export_generated"`.
- [ ] Signed URL expira en 24h (verificar TTL en Supabase Storage console).
- [ ] Inventario entrada 13.2 → ✅.

---

## F2 — PPP export provincial (~3d, parcialmente paralelo a F1b)

### F2a — completado en F0 (investigación de canales + spec)

Ver §F-D3 y §F-D4 arriba. Resultado: PDF-only para CABA y Prov BA v1 (opción A en
ambos). Auto-push con queue+retry queda diferido hasta que exista API pública
documentada en alguna de las dos jurisdicciones.

### F2b — implementación (~2.5d)

#### Pre-flight F2b

`@react-pdf/renderer` y `resend` ya instalados por F1b si las ramas se cruzan.
Si F2b corre en paralelo en branch separada, repetir el pre-flight de F1b.

**Orden de PRs recomendado:**
1. F1b PR: instala `@react-pdf/renderer` + `resend`, crea `lib/storage-exports.ts`.
2. F2b PR: depende de F1b mergeado en `develop` para reusar `lib/storage-exports.ts`.
   Si se trabaja en paralelo, F2b crea su propia copia de `storage-exports.ts` y el
   merge resuelve la duplicación.

#### Archivos a crear / modificar — F2b

| Path | Acción | Razón |
|---|---|---|
| `db/schema.ts` | MODIFY | Agregar `"ppp_export_generated"` a `AUDIT_LOG_ACTIONS` |
| `lib/ppp-exports.ts` | NEW | DTO mapper `petToPppExportDto()` + template PDF PPP + eligibility pre-check |
| `app/actions/ppp-export.ts` | NEW | Server action `generatePppExportAction(petPublicToken)`: eligibility check → render PDF → Storage → email → audit_log |
| `app/(app)/mis-mascotas/[publicToken]/ppp-export/page.tsx` | NEW | Owner-facing page: info del export + botón "Generar export PPP" + estado resultado |
| `app/(app)/mis-mascotas/[publicToken]/ppp-export/PppExportForm.tsx` | NEW | Client component del form (jurisdicción de destino selector: CABA / Prov BA) |
| `app/(app)/mis-mascotas/[publicToken]/page.tsx` | MODIFY | Agregar link/CTA "Exportar credencial PPP" si `pet.potentiallyDangerousBreed = true` |
| `__tests__/ppp-export.test.ts` | NEW | Unit + integration tests |

#### Template PDF — F2b (`lib/ppp-exports.ts`)

| Sección | Campos fuente |
|---|---|
| **Encabezado DIM** | Logo DIM, "MiMAR — Mi Mascota Argentina", fecha de generación |
| **Jurisdicción destino** | Seleccionada por el owner (CABA: "Registro RUPPPA CABA, Ley 4078" / Prov BA: "Registro PPP Prov. BA, Ley 14.107") |
| **Datos del owner** | `profiles.displayName`, `profiles.dniNumber` (si verificado), email de contacto |
| **Datos del pet** | `pets.name`, `pets.species`, `pets.breed`, `pets.dateOfBirth` (edad calculada), `pets.microchipNumber` (si existe), `pets.potentiallyDangerousBreed = true` label |
| **Justificación PPP** | Raza en lista PPP vía `resolveBusinessRule("ppp_breed_list", jurisdiction)` — nombre de la raza + norma que la incluye. Si PPP por peso: umbral configurado + peso registrado (último evento `weight_recorded`). |
| **Estado de attestation** | `pppAttestationRequiredRegistriesSchema` para la jurisdicción → lista de registros + estado (pendiente/completado si existe evento `dangerous_breed_attested`). |
| **Normativa aplicable** | CABA: "Ley 4078 — Tenencia de perros considerados peligrosos en la Ciudad Autónoma de Buenos Aires". Prov BA: "Ley 14.107 — Régimen para tenencia de animales potencialmente peligrosos". |
| **QR** | URL pública `mimar.ar/p/{publicToken}` en QR code (usar `qrcode` package o SVG simple) — permite al organismo verificar la identidad del animal online. |
| **Audit trail** | `exportGeneratedAt`, `exportedByUserId` (owner en este caso), `petPublicToken` |
| **Pie** | "Documento generado por MiMAR. Presentar junto al carnet sanitario y libreta de vacunas del animal." |

#### Server action pipeline — F2b (`app/actions/ppp-export.ts`)

```ts
"use server";
export async function generatePppExportAction(
  petPublicToken: string,
  targetJurisdiction: "caba" | "prov_ba",
): Promise<{ ok: true; signedUrl: string } | { ok: false; error: string }>
```

Flujo interno:
1. Auth guard: owner autenticado + ownership check (el pet debe pertenecer al usuario).
2. PPP eligibility pre-check: `isPotentiallyDangerousBreedForJurisdiction()` —
   si el pet no es PPP para la jurisdicción target, retornar `{ ok: false, error: "pet_not_ppp_for_jurisdiction" }`.
3. Resolver `ppp_attestation_required_registries` para la jurisdicción target.
4. `petToPppExportDto()` mapper.
5. `renderToBuffer(<PppDocument dto={dto} />)` via `@react-pdf/renderer`.
6. `uploadExportToStorage("ppp-exports", path, buffer)` — path: `${petPublicToken}/${targetJurisdiction}/${timestamp}.pdf`.
7. `createSignedExportUrl("ppp-exports", path, 86400)` — 24h TTL.
8. Resend email al owner con el signed URL.
9. Insertar en `audit_log`: `{ action: "ppp_export_generated", actorUserId, payload: { petPublicToken, targetJurisdiction, breed: pet.breed, schemaVersion: "2026-05-21" } }`.
10. Retornar `{ ok: true, signedUrl }`.

#### Auto-push vs PDF-only — switch logic

```ts
// lib/ppp-exports.ts
// v1: PDF-only for all jurisdictions. No API exists for CABA RUPPPA or Prov BA
// municipal registries as of 2026-05-21 investigation (see plan F-D3/F-D4).
// v2 toggle: if (await getPppRegistryApiUrl(targetJurisdiction)) → auto-push with queue+retry.
// TODO(ppp-api): monitor buenosaires.gob.ar/api and provincial.gba.gob.ar for registry APIs.
const PPP_CHANNEL: Record<"caba" | "prov_ba", "pdf_only" | "api_push"> = {
  caba: "pdf_only",
  prov_ba: "pdf_only",
};
```

#### Tests — F2b (`__tests__/ppp-export.test.ts`)

**Unit (lógica pura, sin DB):**
- `petToPppExportDto()` con raza en lista PPP de CABA → `justificationSource = "breed_list"`.
- `petToPppExportDto()` con `potentiallyDangerousBreed = false` → la action rechaza antes del render.

**Integration (contra DB local):**
- `generatePppExportAction(validToken, "caba")` con pet PPP → inserta `audit_log` con `action = "ppp_export_generated"`.
- `generatePppExportAction(validToken, "caba")` con pet NO PPP → retorna `{ ok: false, error: "pet_not_ppp_for_jurisdiction" }` y NO inserta audit log.
- Ownership check: owner B no puede exportar pet de owner A → retorna `{ ok: false }`.
- `generatePppExportAction` happy path → `audit_log.payload.targetJurisdiction = "caba"`.

#### DoD — F2b

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` clean.
- [ ] `pnpm test -- ppp-export` pasan (unit + integration).
- [ ] Page `/mis-mascotas/[publicToken]/ppp-export` carga sin 404 para pet PPP.
- [ ] Para pet NO PPP: page muestra error o está oculta (CTA no aparece en el pet detail).
- [ ] PDF renderiza con las secciones definidas arriba.
- [ ] Email con signed URL llega al owner (smoke staging).
- [ ] Audit log row con `action = "ppp_export_generated"`.
- [ ] Inventario entrada 6.9 → ✅.

---

## Definition of Done — Chunk F completo

- [ ] F1: signed URL 24h via email (actor que generó el export).
- [ ] F2: signed URL 24h via email (owner del pet).
- [ ] F1: audit_log row con `action = "welfare_mpf_export_generated"` + `payload.schemaVersion`.
- [ ] F2: audit_log row con `action = "ppp_export_generated"` + `payload.targetJurisdiction`.
- [ ] F1: role guard correcto — solo `govt` (en scope) y `admin` pueden generar el export.
- [ ] F2: ownership guard correcto — solo el owner del pet puede generar el export PPP.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm rls:smoke` green.
- [ ] Coverage no regresa (umbrales de Chunk A1).
- [ ] Buckets `welfare-exports` y `ppp-exports` creados en Supabase como privados.
- [ ] `docs/feature-inventory-2026-05-20.md` entradas 6.9 (PPP) y 13.2 (Welfare MPF) → ✅.
- [ ] Plan movido a `docs/superpowers/plans/archive/`.

---

## Diferidos (fuera de scope de Chunk F)

| Item | Justificación |
|---|---|
| Auto-push a API CABA RUPPPA | Sin API documentada a 2026-05-21; re-evaluar cuando `buenosaires.gob.ar` publique endpoints |
| Auto-push a API Prov BA | Sin API unificada provincial; re-evaluar municipio por municipio (Lomas, La Plata, etc.) |
| PPP exports para otras provincias (Santa Fe, Córdoba, Mendoza) | v1 cubre CABA + Prov BA; las demás van como v2 |
| Firma digital con PKI federal (Ley 25.506 §2) | Depende de decisión F-D2; infraestructura de cert management fuera de scope |
| Reports multi-org MPF (≥2 orgs denuncian el mismo sujeto) | Escalation path definido en spec `2026-05-19-org-abuse-investigation`; diferido |
| Generación de PDF para denuncia anónima (sin actor logueado) | Requiere flow distinto de auth; diferido a v2 |
| Renovaciones automáticas PPP (cron que genera export antes del vencimiento) | v2 — requiere columna `ppp_registered_at` + `ppp_expires_at` en `pets` |
| QR con verificación online del PDF | Depende de ruta pública `/p/{token}` estabilizada; diferir si ruta no está en scope |

---

## Ambigüedades del spec flaggeadas

1. **`@react-pdf/renderer` + React 19:** el paquete soporta React 18 en su versión
   estable actual (`^3.x`). React 19 puede causar conflicto de peer deps. Interpretación
   adoptada: intentar instalar con `--legacy-peer-deps`; si hay problemas de runtime,
   evaluar `pdf-lib` (más bajo nivel, sin React, sin peer deps) para renderizar el PDF
   programáticamente. La decisión final se toma al instalar en F1b pre-flight.

2. **`pets.dniNumber` del owner:** el template PDF de F2 incluye el DNI del owner para
   cumplir con la Ley 4078 (CABA requiere DNI del tenedor en el registro). No hay campo
   `dniNumber` verificado en `profiles` en este momento — sólo `dniVerifiedAt`
   (boolean) per `"dni_verified_self"` en el audit log, pero el número en sí puede estar
   en `profiles.dniNumber` (verificar en schema). Interpretación adoptada: incluir
   `profiles.dniNumber` si no es null; si es null, dejar "DNI no verificado — el
   tenedor debe completarlo en el organismo".

3. **`occurredAt` obligatorio en MPF PDF:** el campo `welfareReports.occurredAt` es
   nullable (el denunciante puede no saber la fecha exacta). Interpretación adoptada:
   si null, imprimir "Fecha del hecho: no especificada por el denunciante".

4. **Signed URL TTL de los adjuntos en el PDF de F1:** los adjuntos de welfare usan
   `welfareAttachmentSignedUrl()` con TTL de 1 hora (hardcoded en `lib/storage.ts`).
   El PDF puede ser guardado por el funcionario y los links expirarán. Interpretación
   adoptada: para el PDF MPF generar signed URLs de attachments con TTL de 7 días
   (extender el helper o pasar TTL explícito). Documentar en el PDF que los links
   tienen validez limitada.

5. **Qué rol puede ver el botón "Exportar a fiscalía":** el detail page usa
   `requireAdminOrGovtOrRedirect()`. Interpretación adoptada: el botón
   `<MpfExportButton>` es visible para cualquier `govt` en scope + `admin`. El
   `triagedByUserId` no es condición — un caso puede exportarse en cualquier estado
   del workflow. Si el owner quiere restringirlo a casos `in_progress` o `triaged`,
   agregar ese guard en el server action y documentarlo en el DoD.

---

## Referencias

- `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` §Chunk F — sequencing parent
- `docs/superpowers/plans/2026-05-21-pending-decisions-resolved.md` — confirmado: sin entradas para Chunk F
- `db/schema.ts` líneas 1048–1138 — tabla `welfareReports` campo por campo
- `db/schema.ts` líneas 1399–1495 — `AUDIT_LOG_ACTIONS` catálogo
- `db/schema.ts` líneas 1535–1578 — `govtBusinessRules` + `GOVT_BUSINESS_RULE_TYPES`
- `lib/case-normatives.ts` líneas 106–128 — Ley 14.346 + MPF CABA anchors (citados verbatim en §Hallazgo)
- `lib/business-rules-resolver.ts` — `resolveBusinessRule()` usado en F2 eligibility check
- `lib/business-rules-validators.ts` — `pppAttestationRequiredRegistriesSchema`
- `lib/business-rules-reeval.ts` — patrón de re-evaluación PPP (lectura de referencia)
- `lib/breeds.ts` + `lib/breeds-server.ts` — `POTENTIALLY_DANGEROUS_DOG_BREEDS` + `isPotentiallyDangerousBreedForJurisdiction()`
- `lib/storage.ts` — `welfareAttachmentSignedUrl()` + patrón de signed URLs
- `app/gob/maltrato/[id]/page.tsx` — punto de integración de `<MpfExportButton>` (debajo de `<TriageActions>`)
- `app/(app)/mis-mascotas/[publicToken]/page.tsx` — punto de integración del CTA PPP export
- Ley Nacional 14.346 (1954) — maltrato animal AR (marco legal F1)
- Ley 25.326 (2000) — datos personales AR (contexto de por qué F no anonimiza a diferencia de E6)
- Ley 25.506 (2001) — firma digital AR (contexto F-D2)
- Ley CABA 4078 — PPP CABA (marco legal F2 jurisdicción CABA)
- Ley Prov BA 14.107 — PPP Prov BA (marco legal F2 jurisdicción Prov BA)
