# Event-trust hardening — Tiers 2-4 (future work, low priority)

> Spec design-only que captura los gaps remaining del brainstorm de event-sourcing additions del 22 may 2026, después de que Tier 1 (`plans/2026-05-22-event-trust-tier-1.md`) cierre las tres mejoras urgentes (confidence tier + idempotency keys + outbox).
>
> **Fecha:** 2026-05-22
> **Owner:** Ignacio Del Valle
> **Estado:** 🟠 Low priority — design captured, no plan, no schedule
> **Versión:** 1.1
> **Depende de:** Tier 1 implementado.
>
> **v1.1 (2026-05-22):** Tier 1 está en flight — 5 PRs abiertos contra `develop` que entre todos completan el plan:
>
> - **Fase A** (confidence tier `computeConfidence()`) — PR #129
> - **Fase B** (idempotency keys + 14-form retrofit) — PR #133
> - **Fase C.1** (`event_notification_outbox` + drainer cron) — PR #135
> - **Fase C.2** (`/admin/outbox` UI) — PR #139 (stacked sobre #135)
> - **Bug fix descubierto durante C.1** (eno-trigger disease-code bridge) — PR #137
>
> Hasta que estos PRs mergen, los items de este spec que dependen de "Tier 1 §A" (T2.1, T3.1, T3.3) están bloqueados implementacionalmente. Una vez en develop, los triggers de §1 pueden empezar a fire.

---

## 0. Por qué este documento existe

El brainstorm en chat del 22-05 produjo ~11 ideas de mejora al event sourcing. Tres se promovieron a plan ejecutable (Tier 1). El resto se capturan acá para no perderlas — en orden descendente de marginal value dado lo que ya existe en el repo. Ninguno es bloqueante para nada en flight. Ninguno está priorizado para los próximos 3-6 meses.

**Por qué dejarlas escritas en lugar de borrarlas**: dos razones. Primera, varias se vuelven necesarias en momentos específicos (Merkle anchoring cuando aparezca el primer requerimiento de auditoría externa; right-to-erasure cuando la AAIP haga la primera consulta; vector clocks cuando se vea evidencia real de conflictos offline-first). Tenerlas pre-pensadas evita que el día que llegue el trigger, el diseño se haga apurado. Segunda, son ideas que tienden a reemerger en discusiones futuras — escribirlas una vez ahorra re-deliberar.

**Cuándo promover un item a plan**: cuando ocurra el trigger específico de cada uno (cada §§ abajo lo nombra), bumpear este spec a v2 con cualquier refinamiento que el contexto haya generado, y escribir el plan correspondiente bajo `plans/`.

---

## 1. Inventario y triggers

| # | Item | Trigger que promueve a plan | Esfuerzo estimado | Depende de |
|---|---|---|---|---|
| T2.1 | Correction events como umbrella formal | Primer caso real de "tuve que rehacer un evento mal cargado y ahora no se entiende qué pasó" → señal de que la informal correction-via-new-event no escala | S (1-3 días) | Tier 1 §A (confidence tier) |
| T2.2 | Content-addressed evidence attachments | Primer requerimiento de SENASA / Colegio Veterinario sobre integridad de archivos adjuntos (lab results, fotos), o cuando aterrice el plan de digitalización de libretas de papel | S (1-3 días) | Ninguno |
| T2.3 | Disputed events como case_kind | Primer dispute real entre vet y owner que necesita resolución formal, o pre-emptive antes del onboarding del primer Colegio provincial | S-M (3-7 días) | Sistema de casos (priority #1 actual del README) |
| T3.1 | Right-to-erasure tombstones | Primera consulta de la AAIP, primera solicitud formal de erasure de un tutor, o auditoría legal del cumplimiento Ley 25.326 | M (3-7 días) | Tier 1 §A |
| T3.2 | Merkle anchoring | Primer requerimiento de auditoría externa sobre integridad histórica (probable: en la mesa con SENASA federal post-piloto Mendoza) | S (1-3 días) | Ninguno |
| T3.3 | Reputation per emitter (derived) | Después de 6+ meses con `/pro` en producción y suficiente data volume, cuando alguien pregunte "¿cuánto puedo confiar en este vet vs ese?" | S (1-3 días) | Tier 1 §A |
| T4.1 | Vector clocks / offline-first conflict resolution | Evidencia en producción de conflictos por escrituras offline simultáneas en `/pro` (probable: post-Mendoza pilot con vets en zonas rurales) | L (1-3 semanas) | Ninguno técnico; mucho design lift |

Total scope si se hicieran todos: ~5-8 semanas de trabajo distribuidas. Nadie debería intentar hacerlos en batch — cada uno tiene su momento.

---

## 2. T2.1 — Correction events como umbrella formal

### 2.1 Estado actual

`AGENTS.md` dice "corrections are new events" pero el patrón es informal: típicamente el corrector emite un event nuevo del mismo tipo (`vaccination_administered` corregido) con un campo `payload.corrects_event_id` ad-hoc cuando se acuerda. No hay event_type dedicado, no hay validación de la cadena, y el UI no distingue una correction de una entry normal.

### 2.2 Problema

Cuatro problemas concretos:

1. **Audit poco legible**. Un row de `vaccination_administered` con `corrects_event_id=xxx` requiere que el lector sepa buscar ese campo. No es discoverable.
2. **Projections doble-cuentan**. Si el corrector no marcó el `corrects_event_id` o el reader no lo respeta, el cobertura dashboard cuenta 2 vacunaciones donde hubo 1 corregida.
3. **No hay reason capture**. Las correcciones reales tienen causa ("el vet anotó la fecha equivocada", "se mezcló con la libreta de otro perro de la misma familia"). El historial necesita esa razón.
4. **Sin distinción amendment vs retraction**. "Corregí la fecha" es diferente de "esto nunca pasó, retiren". Ambos son corrections pero con semantics distintas para projections y para dashboards.

### 2.3 Propuesta

Nuevo umbrella event_type `event_corrected` con `payload.correction_kind: 'amendment' | 'retraction' | 'reclassification'`, `payload.corrects_event_id: uuid` (FK lógica, validada en server action), `payload.reason: string`, y los fields del corrected event repetidos según correction_kind:

- `amendment`: payload incluye los nuevos values de los fields corregidos. Projections deben aplicar el nuevo state.
- `retraction`: payload solo el reason. Projections deben **excluir** el original event como si nunca hubiera existido.
- `reclassification`: el event original era del tipo equivocado. Payload incluye `target_event_type` y `target_payload`. Projections deben tratar el original como retraction + el target como nuevo event con `occurred_at` del original.

### 2.4 Decisiones a cerrar cuando se promueva

| ID | Pregunta |
|---|---|
| C-D1 | ¿Las corrections se pueden encadenar? (corrección de una corrección). Default propuesto: sí, pero la chain está limitada a 5 niveles para evitar abuso |
| C-D2 | ¿Quién puede emitir corrections? El propio author del original, su org admin, govt scope-matching, admin. ¿Otros? |
| C-D3 | ¿Hay capability granular? `event.correct` separable de la capability del event_type original |
| C-D4 | ¿La UI del libreta tacha el original o lo oculta? Tachado es más auditable; ocultar es más limpio. Propuesto: tachado con tooltip explicando la corrección + click expande a ver original + reason |
| C-D5 | Cron policy: ¿hay un upper bound de tiempo para emitir una corrección? (e.g., max 90 días post-original). O queda open forever |
| C-D6 | Audit log: cada correction se duplica en `audit_log` además del row en `pet_events`. Default sí |

### 2.5 Interacción con confidence tier

Una correction de un event `institutional_verified` por parte de un `owner` debería downgrade el tier visible? Propuesta: NO. La correction es un nuevo event con su propio tier; el original sigue en el log como facto histórico. Las projections respetan la correction pero el audit show ambos events con sus tiers individuales.

### 2.6 Scope mínimo cuando se planee

- Schema: nuevo event_type, payload validations Zod
- Projection helpers: todas las projections que consumen events afectados deben aplicar la correction logic (probablemente vía un wrapper `applyCorrectionChain(events)` que retorna la lista "effective" después de aplicar amendments/retractions)
- UI: tachado en libreta + tooltip + entry point "Corregir entrada" desde el detail view de cualquier event del que el user sea legitimate corrector
- Tests: cobertura de chain de 1, 2, 3 niveles + retraction + reclassification

---

## 3. T2.2 — Content-addressed evidence attachments

### 3.1 Estado actual

`lib/case-attachment.ts` es sobre cases que se attachean a events. NO sobre archivos. Hoy los attachments de archivos (fotos de libretas, lab results, evidencia de denuncias) viven como URLs en `welfare_reports.attachments` y similares — strings que dependen de que el storage path nunca cambie y que el archivo no sea swap-eado por otro.

### 3.2 Problema

Tres niveles de problema, en orden de gravedad:

1. **Tamper risk**: si alguien con acceso a Storage reemplaza `foo.jpg` por otro archivo con el mismo nombre, el link sigue válido pero el contenido cambió. No hay forma de detectar.
2. **Audit trail incompleto**: cuando una denuncia llega al MPF como export y la URL muere (porque cambió bucket, expiró, o el storage migró), el adjunto queda inaccesible y la denuncia pierde sustancia.
3. **Privacy + dedup**: dos uploads del mismo archivo (e.g., el owner sube la libreta + el vet sube la misma foto) generan dos rows + dos archivos. No es problema crítico pero es desprolijo.

### 3.3 Propuesta

Storage permanece pero se complementa con `sha256_hex` calculado al upload, persistido junto al storage path. Reglas:

- Al upload, computar hash. Si existe un row con el mismo hash, reusar (dedupe). Si no, store + persist row con hash + path.
- Al render, si el archivo cambió de hash (porque alguien lo overwrite via Studio), badge "Archivo modificado" en el UI y log en audit.
- Al export (MPF, govt audit), incluir el hash en el manifest. El receptor puede verificar.

Esquema de tabla nueva `evidence_attachments`:

```sql
CREATE TABLE evidence_attachments (
  id UUID PRIMARY KEY,
  sha256_hex CHAR(64) NOT NULL UNIQUE,  -- content address
  storage_path TEXT NOT NULL,            -- where the bytes live
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  uploaded_by_user_id UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE event_attachments (
  event_id UUID REFERENCES pet_events(id),
  attachment_id UUID REFERENCES evidence_attachments(id),
  PRIMARY KEY (event_id, attachment_id)
);

CREATE TABLE welfare_report_attachments (  -- migrate existing welfare_reports.attachments here
  welfare_report_id UUID REFERENCES welfare_reports(id),
  attachment_id UUID REFERENCES evidence_attachments(id),
  PRIMARY KEY (welfare_report_id, attachment_id)
);
```

### 3.4 Decisiones a cerrar

| ID | Pregunta |
|---|---|
| CA-D1 | Hash algorithm. SHA-256 (64 hex chars) es estándar y suficiente. ¿Algo más fuerte? Propuesto: no, SHA-256 |
| CA-D2 | Verificación on-read es opcional o automática. Verificar siempre es costoso; verificar nunca defeats the purpose. Propuesto: verify on admin export + on dispute claim; lazy en render normal |
| CA-D3 | Backfill de existing attachments. Script que computa hash sobre todos los `welfare_reports.attachments` actuales y los migra a la nueva tabla. ¿Hacerlo en el mismo PR o follow-up? |
| CA-D4 | Dedup policy. Si dos users uploadean el mismo archivo, ¿ambos ven el mismo row attached o cada uno tiene su event_attachments row separado? Propuesto: row attachment separado per event (porque el contexto difiere), bytes únicos en evidence_attachments (dedup real) |
| CA-D5 | RLS sobre evidence_attachments. ¿Cualquier user puede leer cualquier attachment si tiene el hash? Probablemente no. Acceso vía event/report row, que ya tiene RLS |

### 3.5 Interacción con confidence tier

Una vez existente, `computeConfidence` puede bumpear un `self_reported` a `corroborated` si tiene attachments con hash verificado en lugar del check de `evidence_hash` ad-hoc que dejé en Tier 1 (A1). Una mejora natural.

---

## 4. T2.3 — Disputed events como case_kind

### 4.1 Estado actual

No hay forma formal para que un party dispute un event que otro party emitió. Si el owner sospecha que el vet anotó mal, la única vía es WhatsApp + correction informal. Si el vet sospecha que el owner inventó un self-report de vacunación, no hay surface.

### 4.2 Propuesta

Nuevo `case_kind = 'event_dispute'` en el sistema de casos. Flow:

1. Cualquier party con relación legítima al pet (owner, org member, vet con prior interaction, govt scope-matching) puede abrir un dispute desde el detail view del event.
2. El dispute es un case con `subject_event_id` populated. Notifica a las partes involucradas.
3. La resolución es ella misma un event (`event_dispute_resolved`) con outcome:
   - `upheld`: el disputador tenía razón → emite automáticamente una correction (T2.1)
   - `dismissed`: el disputador no tenía razón → el event original queda intacto + entry en su perfil noting el dispute history
   - `mediated`: ambos partes acordaron una nueva versión → emite correction tipo `amendment` con los acordados
4. Mientras el case está open, el event se renderea con badge "En disputa" en libreta.

### 4.3 Decisiones a cerrar

| ID | Pregunta |
|---|---|
| ED-D1 | ¿Quién resuelve? Default propuesto: cuando ambas partes son orgs verified o govt, ellas mediate. Cuando es owner vs vet, el resolver es govt scope-matching. Caso owner vs org sin govt involved → admin escalation |
| ED-D2 | Time-bound para abrir dispute. Default: 90 días desde el original event. Después de eso, no se puede disputar pero sí corregir si la capability lo permite |
| ED-D3 | Stigma para el disputed party. Mostrar dispute count en el perfil del vet o de la org? Propuesto: SÍ visible en `/admin` (interno), NO visible en surfaces públicas (anti-abuse) |
| ED-D4 | Capability requerida para disputar. `event.dispute` separable. Default granted to owner + org_member + vet con prior interaction |
| ED-D5 | Auto-resolution si el disputed party no responde en N días. Default: 14 días → marca `dismissed_by_silence` con notification |

### 4.4 Interacción con confidence tier

Un event con dispute open tiene su tier visualmente flagged ("Verificado por veterinario · En disputa"). Si el outcome es `upheld`, las projections respetan la correction. Si es `dismissed`, el tier vuelve al estado normal + el dispute aparece en el history pero no en la projection activa.

---

## 5. T3.1 — Right-to-erasure tombstones

### 5.1 Estado actual

`AGENTS.md` es explícito: events son append-only. No hay path para DELETE. La Ley 25.326 (Protección de Datos Personales) sin embargo otorga derecho de supresión a los titulares. Hoy esa solicitud es no-respondible operativamente.

### 5.2 Problema

Trade-off conocido entre append-only contract y data protection. Las dos opciones malas:

1. **Hard delete**: rompe el append-only contract, defeats audit, breaks projection rebuild, viola los principios de event sourcing.
2. **No erasure**: viola Ley 25.326 a fondo.

La opción correcta es un middle ground: redact PII sin destruir la spine sanitaria.

### 5.3 Propuesta

Nuevo event_type `pii_redacted` que apunta a un sujeto (user_id, no pet_id) y declara intent. Una vez emitido:

- Projections que leen events de cualquier pet del que ese user fue owner aplican un redaction mask al payload: PII fields (nombre, teléfono, email, DNI específico, dirección exacta) reemplazados por `[redacted]`. Sanitary fields (vacunación happened, fecha, jurisdicción agregada) se preservan.
- El audit_log de ese user sigue existiendo (con su PII) pero retention queda limited según legal hold.
- `recorded_by_user_id` en pet_events queda como UUID, pero la profile row del user puede ser hard-deleted post-retention (las refs quedan dangling, eso está OK porque on delete set null lo maneja).

Implementación requiere un per-event-type **redaction policy**: cada event_type declara qué fields son PII vs sanitary. Análogo al patrón de `libreta-sanitaria` (que ya separa libreta vs non-libreta events). Probablemente vivirá en `lib/event-redaction-rules.ts`.

### 5.4 Decisiones a cerrar

| ID | Pregunta |
|---|---|
| RE-D1 | Scope de la redaction. ¿Solo PII del titular o también de partes relacionadas (e.g., el vet que firmó)? Default: solo del titular que solicita |
| RE-D2 | Reversibilidad. Una redaction es definitiva o reversible si el titular cambia de idea. Propuesto: definitiva una vez confirmada (Ley 25.326 lo trata como acción concluyente) |
| RE-D3 | Mascotas del titular post-redaction. ¿Se transfieren a otro tutor o quedan como "huérfanas" con datos sanitarios pero sin owner? Probablemente cascade: el user pierde owner role, las pets quedan en estado especial "sin tutor registrado" hasta que otro user las claim |
| RE-D4 | Legal hold override. Si hay una denuncia abierta o un caso judicial que requiere preservar datos, el redaction se posterga. ¿Quién valida ese override? Admin con justificación documentada |
| RE-D5 | Notification a partes que tienen el dato. Si un vet tiene en su sistema interno los datos del owner que después solicitó erasure, MiMAR debería notificar al vet sobre la obligación? Propuesto: no — eso excede el scope de MiMAR. Solo redactamos en MiMAR |
| RE-D6 | Tiempo para procesar. Ley 25.326 da 10 días corridos. ¿Auto-aplicación al confirmar request o admin review previa? Default: admin review 24h, then auto-apply |

### 5.5 Interacción con confidence tier

Una vez redacted, el event mantiene su tier original — la confianza del cuidado sanitario se mantiene aunque la identidad esté tapada. Solo el "Verificado por X" deja de mostrar el nombre del verificador titular (queda anónimo) si X fue el solicitante.

---

## 6. T3.2 — Merkle anchoring para tamper-evidence

### 6.1 Estado actual

`pet_events` tiene trigger append-only que previene `UPDATE`/`DELETE`. Eso protege contra modificaciones via app y via SQL "normal". NO protege contra:

- Un admin con acceso a Studio que disable temporariamente el trigger
- Un futuro hosting provider con acceso a la DB
- Un cambio retroactivo entre backup y restore
- Un disputado que dice "ustedes modificaron mi caso" sin que MiMAR pueda probar lo contrario

### 6.2 Propuesta

Cron diario que computa un Merkle root sobre el set de events del día (key: `(id, recorded_at, payload_hash)`) y lo publica externamente. "Externamente" en v1 puede ser:

- Commit a un repo GitHub público (e.g., `mimar-org/mimar-audit-anchors`) con un append-only log de anchors
- Object versionado en S3-compatible público
- Eventualmente: layer notarial de Mi Argentina si se materializa

La publicación es opt-in y la URL queda en `/admin/audit-anchors`. La verificación post-hoc consiste en: tomar los events de un día, recalcular el Merkle root, comparar con el anchor publicado. Si difieren, alguien tocó el log.

### 6.3 Decisiones a cerrar

| ID | Pregunta |
|---|---|
| MA-D1 | Granularidad del anchor. ¿Diario, horario, por-event? Diario es probablemente suficiente para political value; por-event es overkill y costoso |
| MA-D2 | Qué hash function. SHA-256 estándar. Merkle tree con orden lexicográfico por event id |
| MA-D3 | Qué fields entran al leaf hash. Propuesta: `sha256(canonical_json({ id, pet_id, event_type, occurred_at, recorded_at, payload, recorded_by_user_id }))`. Excluir fields mutables (no hay actualmente, pero defensive) |
| MA-D4 | Destination del anchor. v1 GitHub repo. v2 cuando sea relevante: Mi Argentina notarial layer. ¿Hardcode v1 o pluggable desde el inicio? Propuesto: pluggable desde el inicio (`lib/audit-anchor-targets.ts`) |
| MA-D5 | Privacy. El anchor es público; revela timestamps + cardinalidad de events por día. ¿Es un problema? Probable no — esos metadata no son PII. Pero documentar |
| MA-D6 | Verification UI. ¿/admin/audit-anchors tiene "Verify a date" button que recomputa y compara? Default sí |

### 6.4 Interacción con outbox

El anchor publicación puede vivir en el outbox como un `target_kind='audit_export'` con SLA diario. Reutiliza la tubería.

---

## 7. T3.3 — Reputation per emitter (derived)

### 7.1 Estado actual

Tier 1 §A (confidence tier) clasifica un event individual por la calidad de su provenance. No hay aggregate sobre el track record de un emisor.

### 7.2 Propuesta

Pure projection sobre `pet_events` que agrupa por `author_organization_id` y `recorded_by_user_id`, calcula métricas:

- **Total events emitted** (de cada tipo)
- **Correction rate**: porcentaje de events del emisor que fueron luego corregidos (T2.1 dependency)
- **Dispute rate**: porcentaje que fueron disputed (T2.3 dependency)
- **Average time-to-record**: gap entre `occurred_at` y `recorded_at` (proxy de timeliness en campañas)
- **Confidence tier distribution**: % de events del emisor por tier
- **Cross-org consistency**: cuántas orgs reconocen los events de este emisor (para vets que rotan)

Surface en `/admin/reputation/[user_or_org_id]` (read-only). NO se usa para gating automático — es un soft signal para investigaciones, no un score para banear.

### 7.3 Decisiones a cerrar

| ID | Pregunta |
|---|---|
| R-D1 | Cache strategy. Computar on-read es lento sobre 100K+ events. ¿Materialized view daily? Probablemente sí, refresh nightly |
| R-D2 | Privacy del display. ¿El emisor ve su propio score? El Colegio del emisor ve el score? Govt scope-matching? Default: emisor sí (su propio), Colegio sí (de sus matriculados), govt no (anti-political-targeting de profesionales) |
| R-D3 | Time window. ¿Toda la historia o trailing 12 meses? Propuesto: trailing 12 + lifetime separado, ambos visibles |
| R-D4 | Comparar entre emisores. ¿Mostrar percentiles? Probablemente no — invita a ranking competitivo que no es el propósito |

---

## 8. T4.1 — Vector clocks / offline-first conflict resolution

### 8.1 Estado actual

PWA online-only effectively. La idempotency de Tier 1 §B cubre flaky-network pero NO offline-first con sync diferido. Un vet que pasa 4h offline cargando 30 events en una campaña rural depende de que cuando llegue señal, los inserts pasen en orden y sin conflict.

### 8.2 Problema

Casos reales que vendrán post-Mendoza:

- Vet en campaña con tablet, queue de 40 events local
- Conexión vuelve, sync envía batch
- Mientras la batch viajaba, otro vet de la misma org tocó la misma pet
- Conflict: dos events `weight_recorded` en el mismo pet con timestamps muy cercanos
- ¿Cuál gana? ¿Se quedan ambos? Si ambos, ¿qué projection refleja?

Last-write-wins (cliente) es problemático porque el cliente offline no sabe del otro write. Server-side timestamp es preciso pero ignora la realidad de que el evento offline ocurrió ANTES.

### 8.3 Propuesta (skeletal — design lift es grande)

**Vector clocks** por (org_id, device_id, sequence_n). Cada cliente offline mantiene un counter local. Al sync, los events vienen con `vector: { device_id, sequence_n }` y el server detecta conflicts si dos events tienen vectores que no se ordenan estrictamente.

Conflict resolution policy:

- Si los events son del mismo event_type y misma pet y mismo `occurred_at` (within ~5 min) → mergear si los payloads coinciden, sino abrir un dispute case (T2.3)
- Si son distinto event_type → ambos quedan, no hay conflict real
- Si son mismo type pero distinto `occurred_at` → ambos quedan, orden por `occurred_at`

### 8.4 Decisiones a cerrar

Muchas. Este item es el más design-heavy del spec, probablemente demanda su propio spec dedicado cuando llegue el trigger. Cuestiones clave:

| ID | Pregunta |
|---|---|
| VC-D1 | Device identity. ¿Per device install o per user-session? Per device es más estricto pero rompe si el user limpia browser data |
| VC-D2 | Sequence persistence. localStorage del PWA. ¿Qué pasa si el user borra storage? Reset a 0 + treat as new device |
| VC-D3 | Conflict UI. ¿El vet ve el conflict cuando vuelve a estar online y resuelve manualmente, o el sistema decide automáticamente? Propuesto: automático cuando el resolver es claro (payload idéntico → merge), manual con UI cuando ambos events son legítimos |
| VC-D4 | Tombstone para offline-cancelled. Si el vet cargó offline y antes de sync decide cancelar la entry, ¿cómo se transmite? Probablemente un compact "cancel before sync" client-side que jamás llega al server (sin row) |
| VC-D5 | Storage growth de vectores. Cada event crece 50-100 bytes con vector. A 1M events = 50-100MB extra. Aceptable |

---

## 9. No incluidos acá

Items del brainstorm que ya están cubiertos por el repo y NO necesitan trabajo nuevo:

- **Schema versioning + upcasters**: hecho (`docs/superpowers/event-versioning.md` + `lib/event-upcasters.ts`)
- **Zod payloads per event type**: hecho (`lib/event-schemas.ts`)
- **Append-only triggers**: hecho a nivel DB
- **Projection rebuild script**: hecho (`scripts/rebuild-projections.ts`)
- **Causal links**: hecho parcialmente vía `case_id` + `source_event_id` (reminders) + `*_proposed` references — la mejora marginal es trivia, no item de spec
- **Auto-close cron para `*_started/*_ended`**: hecho (rabies observation, foster proposals)
- **Sagas / process managers**: hecho vía sistema de casos
- **Confidence basics**: cubierto en Tier 1 §A
- **Idempotency keys**: cubierto en Tier 1 §B
- **Outbox pattern**: cubierto en Tier 1 §C

---

## 10. Cómo este spec progresa

Este documento NO está priorizado para los próximos 3-6 meses. Funciona como **memo of intent** + **trigger-based backlog**.

**Cuándo revisitar**:

- Cuando ocurra el trigger específico de un item (§1 los lista)
- Cuando alguien (Ignacio, futuro maintainer, reviewer) tenga una idea que parezca encajar con uno de los §§ — agregar al §§ correspondiente o crear un §§ nuevo
- Cuando Tier 1 se complete y haya bandwidth para considerar el siguiente

**Cuándo NO revisitar**: porque "se ve interesante". Cada item de este spec tiene un costo de oportunidad. La regla es: el trigger valida que el trabajo paga la pena AHORA, no la idea per se.

**Cuando un item se promueve**: este spec se versiona (`v1.1`, `v1.2`) con el item marcado promoted + linkeo al plan correspondiente. El §§ del item migra al plan; queda solo el header "Promoted to plan X on YYYY-MM-DD" en este spec.

---

**Fin del spec.** No tiene plan ejecutable asociado intencionalmente.
