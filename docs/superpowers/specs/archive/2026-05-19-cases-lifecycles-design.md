> **IMPLEMENTED / shipped** — This spec has been fully implemented. The case system (`lib/case-attachment.ts`, `lib/case-queries.ts`, `lib/case-normatives.ts`, `src/modules/cases/**`) is live. Archived for historical reference only.

# Casos — lifecycles por kind — design spec

> Sucesor del **attachment spec** (`2026-05-19-cases-event-attachment-design.md`). Mientras aquel definió cómo cada `event_type` se relaciona con el sistema de casos, este define **el lifecycle interno de cada `case_kind`**: estados, transiciones, eventos que abren/cierran, crones de auto-cierre, normativas aplicables (lookup `lib/case-normatives.ts`), matriz de notifications, ajustes finos de visibility. Pensado para que Claude Code pueda producir el plan ejecutable a partir de este doc sin volver a chat para decisiones de diseño.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** `specs/2026-05-19-cases-event-attachment-design.md` (v1.1+). Las decisiones D1–D5 de aquel doc se asumen aquí sin re-litigar.
> **Sucesor:** `plans/2026-05-19-cases-system.md` (plan ejecutable, mismo día).

---

## 1. Por qué este documento existe

El attachment spec dejó establecido el **objeto Caso** (tabla `cases` minimal, `case_id` opcional en `pet_events` y `welfare_reports`, 5 modos de attachment, 13 case_kinds preliminares, cascade-emission para multi-case closures, visibility scope-bound vía RLS). Lo que NO definió es, kind por kind, cómo se mueve cada caso entre estados, qué eventos son terminales, qué crones lo cierran solo, ni qué leyes son las que aplican.

Sin ese detalle, el sistema queda "abstracto pero no buildable". Este doc cierra eso para los **7 kinds del subset mínimo v1** que el attachment spec recomienda:

1. `bite_incident`
2. `lost_pet_episode`
3. `welfare_denuncia`
4. `adoption_listing` (org-side)
5. `adoption_application` (applicant-side)
6. `custody_dispute`
7. `foster_placement`

Los otros 6 kinds (`custody_episode`, `custody_transfer_handshake`, `foster_proposal`, `outbreak_investigation`, `microchip_remediation`, `rabies_observation_followup`) quedan deferidos a iteraciones siguientes — su workflow envolvente todavía no está consolidado en producción, abrirlos prematuramente es deuda.

El criterio para incluir un kind acá fue triple: (a) el workflow ya existe en código o en spec aprobado, (b) tiene actores múltiples y/o estados intermedios que justifican un caso, (c) hay valor operativo concreto en darle envoltorio unificado (visibility, normativas, cierre auditable).

---

## 2. Glosario adicional

(Glosario base en attachment spec §2. Acá solo nuevos términos que aparecen en lifecycles.)

| Término | Qué es |
|---|---|
| **Phase** | Subdivisión de `status='open'`. Un caso puede estar `open` durante meses pero pasar por phases (e.g., `adoption_listing` tiene phases `published`, `reviewing`, `finalized_in_followup`). Las phases NO son columnas — se computan del último event relevante. La columna `status` solo distingue open/closed/escalated/merged |
| **Terminal event** | Event_type que cierra el caso al INSERT. La transición a `status='closed'` o `escalated` ocurre en el mismo server action que emite el event |
| **Auto-close trigger** | Cron que cierra el caso sin acción humana. Cada kind declara su cron (si lo tiene), el cron emite un event de cierre apropiado y flippea status. Idempotente |
| **Required approval** | Aprobación que el caso necesita para avanzar a phase siguiente. La aprobación es un event con shape específica (ya existe en el catálogo — `adoption_application_resolved`, etc.). El lifecycle declara cuáles aprobaciones son hard requirements |
| **Pending counter** | Métrica observada que la UI usa para mostrar "X aprobaciones pendientes" sin tocar la lógica del caso. Se deriva de comparing `phase_actual` con `phase_objetivo` por kind |
| **Escalation** | Transición de `status='open'` a `status='escalated'`. Significa "este caso requiere atención humana urgente". Distinto de `closed` — el caso sigue vivo, pero notifica de forma elevada |
| **Closed reason enum** | `resolved` (avanzó al outcome esperado), `cancelled` (alguien lo retiró antes del outcome), `auto_expired` (cron lo cerró por inactividad/timeout), `merged` (superseded por otro caso), `superseded` (legacy — equivale a merged, dejar uno solo) |
| **Manual open** | Caso creado por un humano (admin/govt) sin event de apertura. La columna `opened_reason` lo registra como `manual: <motivo libre>` |
| **Linkage table** | Tabla auxiliar específica del kind que retiene datos no-event-shaped (e.g., `welfare_reports`, `custody_disputes`, `custody_dispute_parties`). El caso le hace FK opcional via `case.welfare_report_id`, `case.custody_dispute_id`, etc. |

---

## 3. Decisiones cerradas cross-kind

Aplicables a todos los lifecycles. Cada kind puede añadir las propias (sección "Decisiones específicas" de cada uno).

| # | Decisión | Razón |
|---|---|---|
| L1 | **`status` es el campo coarse de máquina de estados**. Valores: `open` (default), `escalated`, `closed`, `merged`. No hay estados intermedios "in_progress" etc. — las phases viven en la lectura, no en la columna | Simplicidad SQL. Las phases son derivables; convertirlas en columna obliga a triggers de sincronización y abre la puerta a estados inconsistentes |
| L2 | **`closed_reason` enum es chiquito y cerrado**: `resolved | cancelled | auto_expired | merged`. Si un kind necesita detalle adicional, vive en payload del event de cierre, no en columna nueva | Coherente con el patrón de event_types umbrella + sub_kind. Detalle a payload, taxonomía a columnas |
| L3 | **Auto-open en cascade-emission NO es opcional**. Si una cascade rule del attachment spec §8 abre un caso (e.g., `foster_proposal_resolved(accepted)` que cascadea `foster_assigned` que abre `foster_placement`), ese open ocurre atómicamente con el cierre que lo dispara. Si falla, todo rollback | Coherencia event log: nunca podés terminar con foster_proposal cerrada como accepted pero sin foster_placement abierta |
| L4 | **Reapertura solo en el caso explícito de `adoption_reversed`**. Ningún otro lifecycle permite reabrir un caso cerrado. Si un caso vuelve a estar "activo" después de cerrar (e.g., el dueño vuelve a perder a la misma mascota tras un return-to-owner), se abre un **caso nuevo**, no se reabre el viejo | Reabrir es UPDATE de event log adyacente — viola append-only en espíritu. La excepción `adoption_reversed` se justifica porque es por definición un cambio retroactivo sobre el outcome, no un nuevo episodio |
| L5 | **El cron de auto-close corre 1x/día por defecto**, a las 04:00 UTC (mismo slot que el de `auto-expire-approvals` de admin page Fase 14). Cada kind puede sobrescribir el schedule si lo necesita (rabies observation usa horario más fino por el reloj de 10 días) | Reusa infraestructura `cron_runs` ya existente. Idempotencia por upsert con ON CONFLICT |
| L6 | **Notifications del caso son additive a las del event**. Un event de transición ya emite notification (e.g., `adoption_application_resolved` notifica al applicant). El cierre del caso puede emitir notification adicional al actor que abrió el caso (e.g., al refugio cuando todas las applications de una listing se cerraron). El doble-notification se mitiga colapsando en la UI por `related_case_id`, no en el backend | Mantenelo simple: cada evento emite lo suyo. La UI ya colapsa notifications por contexto |
| L7 | **`public_code` formato `CAS-XXXX-XXXX`**, mismo generator que `DIM-XXXX-XXXX` y `DEN-XXXX-XXXX` (caracteres `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, evitando ambigüedades visuales 0/O, 1/I/L). Lookup table separada para evitar colisiones cross-token | Consistencia con el resto del sistema. Si una denuncia tiene caso, los dos códigos coexisten — el denunciante ve DEN- por familiaridad, el welfare officer ve CAS- por consistencia interna |
| L8 | **Manual open siempre requiere `opened_reason` no-vacío** (free text mínimo 10 chars). Es el equivalente a "motivación del expediente" en términos burocráticos argentinos | Audit trail. Saber por qué un humano abrió un caso a mano es tan importante como saber qué evento lo abrió automáticamente |
| L9 | **Cada kind declara su lifecycle en `lib/case-lifecycles/<kind>.ts`** como objeto tipado. Una función `getLifecycle(kind)` resuelve el módulo. Esto facilita CI: un test de cobertura asegura que todo `case_kind` declarado en `CASE_KINDS` tiene su archivo de lifecycle | Mismo patrón que `lib/event-schemas.ts` con el coverage test. Sin disciplina de archivo, los kinds futuros nacen sin lifecycle escrito |
| L10 | **Notifications del caso usan `related_case_id`** (nuevo campo nullable en `notifications` table). Es el primo de `related_event_id` y `related_pet_id` ya existentes. RLS sobre notifications no cambia — el dueño de la notification es siempre `user_id`, el related no abre permisos | Permite a la UI rutear "ver caso completo" desde una notification individual sin reconstruir contexto |

---

## 4. Plantilla común de lifecycle

Cada kind se documenta en la misma estructura. Sirve a Claude Code como guía de qué buscar al implementar.

```
### N.1 Sujeto y unicidad
- primary_subject_kind requerido
- constraint UNIQUE para evitar duplicados
- linkage table opcional (FK)

### N.2 Estados y phases
- enum status admitido por el kind (subset de open/escalated/closed/merged)
- phases observables (derivadas del último event relevante)
- diagrama ASCII de transiciones

### N.3 Apertura
- eventos que opens el caso (attachment spec §7)
- manual open: quién puede, qué datos requiere
- side effects atómicos al open (denormalized flags, notifications)

### N.4 Avance (intermediate transitions)
- eventos que pasan al caso de una phase a otra sin cerrarlo
- required approvals para cada transición
- escalation triggers (transition open → escalated)

### N.5 Cierre
- terminal events por closed_reason
- auto-close cron (si aplica): schedule, condiciones, qué evento emite
- side effects atómicos al close (flags, notifications, cascade a otros casos)

### N.6 Reapertura
- solo si aplica (default: no)
- condiciones y mecanismo

### N.7 Normativas aplicables
- LawReference[] por jurisdicción
- entries del lookup `lib/case-normatives.ts`

### N.8 Visibility tweaks
- diferencias respecto al default del attachment spec §9
- nuevas actor_relations específicas (si las hay)

### N.9 Notifications matrix
- evento → destinatarios + severity + copy template id

### N.10 Decisiones específicas

### N.11 Open questions específicas
```

**Diagrama de estados — leyenda común:**

```
[phase]      ← círculo, phase observable
event_type   ← arista, evento que dispara la transición
(auto)       ← auto-emitido por cron o cascade
(req-prof)   ← requiere acción profesional (vet/govt/admin)
(req-owner)  ← requiere acción del owner / subject_owner
*[FIN]       ← terminal phase
```

---

## 5. Lifecycle — `bite_incident`

### 5.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'`. El sujeto del caso es **el mordedor** (el perro que mordió), no la víctima — coherente con que la observación antirrábica recae sobre el animal mordedor.
- UNIQUE: `(primary_pet_id, case_kind) WHERE status IN ('open', 'escalated')`. Un pet puede tener a lo sumo 1 `bite_incident` abierto. Múltiples bites consecutivos del mismo pet abren casos secuenciales, no paralelos.
- Linkage table: **ninguna**. Toda la data específica del caso vive en events (`incident_reported`, `rabies_observation_started`, etc.) y en la denormalización `pets.rabies_observation_status` que ya existe.

### 5.2 Estados y phases

`status` admitido: `open`, `escalated`, `closed`. (Nunca `merged` — no se mergea con otros bite_incidents.)

Phases observables:

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `observation_open` | `status='open'` Y existe `rabies_observation_started` Y NO existe `rabies_observation_ended` | Período de 10 días activo, esperando síntomas o cierre |
| `observation_escalated` | `status='escalated'` | Symptom rábico high-spec detectado durante el período. Espera intervención profesional |
| `observation_closed_negative` | `status='closed'` Y último `rabies_observation_ended.payload.outcome='negative'` | Cierre limpio |
| `observation_closed_positive` | `status='closed'` Y `outcome='positive_rabies'` | Rabia confirmada. Caso cerrado pero queda flag histórico |
| `observation_closed_dead` | `status='closed'` Y `outcome='dead'` | Animal murió durante período. Escalada máxima previa al cierre |
| `observation_closed_lost_to_followup` | `status='closed'` Y `outcome='lost_to_followup'` | Profesional declaró que no fue posible seguir el caso |

Diagrama:

```
                       incident_reported(bite_inflicted)
                                    │ + rabies_observation_started (auto-emit, mismo TX)
                                    ▼
                          ┌────────────────────┐
                          │ observation_open   │
                          └────────────────────┘
                            │           │
   symptom_observed         │           │ death_recorded (auto cascade)
   (rabies high-spec)       │           │
                            ▼           ▼
              ┌─────────────────────┐  ┌──────────────────────┐
              │observation_escalated│  │observation_closed_dead│ *[FIN]
              └─────────────────────┘  └──────────────────────┘
                            │
                            │ rabies_observation_ended (req-prof)
                            │   outcome ∈ {positive_rabies, negative, lost_to_followup}
                            ▼
              ┌─────────────────────────────────────────────┐
              │ observation_closed_{positive|negative|...}  │ *[FIN]
              └─────────────────────────────────────────────┘

  + happy path: día 11, sin escalación, cron auto-emite rabies_observation_ended(outcome=negative)
    → observation_closed_negative *[FIN]
```

### 5.3 Apertura

**Auto (única vía):** INSERT de `incident_reported` con `payload.incident_type='bite_inflicted'`. La server action `reportBiteAction` (a refactorear según attachment spec) ejecuta atómicamente:

1. INSERT `cases` con `case_kind='bite_incident'`, `primary_pet_id=<mordedor>`, `jurisdiction_*` heredado del `pet`, `opened_reason='auto: incident_reported.bite_inflicted'`.
2. INSERT `pet_events` `incident_reported` con `case_id=<nuevo>`.
3. INSERT `pet_events` `rabies_observation_started` con `case_id=<nuevo>`. Triggered_by_event_id = el incident_reported.
4. UPDATE `pets.rabies_observation_status='in_progress'`.
5. Routing notification a govt scope-matching + admin fallback (lib existente `findAuthoritiesForJurisdiction`). Severity `warning` (no `urgent` mientras no haya escalación).

**Manual open:** no permitido. Un bite_incident sin event de bite no tiene sentido. Si admin/govt necesita registrar un bite que entró por canal externo (centro de salud llamó), tienen que crear el `incident_reported` ellos mismos vía `/admin/observaciones/[publicToken]` (ya existe).

### 5.4 Avance — open → escalated

Trigger: INSERT de `symptom_observed` con `case_id=<bite_incident_case_id>` Y `payload.matched_symptom_codes` incluyendo cualquier código de rabia high-spec (lookup `lib/symptom-disease-catalog.ts` que ya existe; high-spec son los que dispararon `outbreak_signal` `severity='warning'` o `'urgent'` pre-existente).

Side effects atómicos:

1. UPDATE `cases.status='escalated'`.
2. UPDATE el `outbreak_signal` event emitido en cascade (si lo hubo) con `payload.severity='urgent'` — equivalente al D5 del bite-rabies spec.
3. Notification al owner con severity `urgent` + copy "Atención: la observación antirrábica de [pet] tuvo un signal compatible con rabia. Consultá inmediatamente con tu veterinario o autoridad sanitaria." (excepción explícita al "owner no ve diagnósticos" del surveillance spec, justificada por riesgo público).
4. Notification escalada al govt en jurisdicción, severity `urgent`.

No hay transición `escalated → open` reversible. El único camino siguiente desde escalated es el close manual (req-prof).

### 5.5 Cierre

**Cierres automáticos (cron):**

| Cron route | Schedule | Condición | Event que emite |
|---|---|---|---|
| `/api/cron/close-rabies-observations` (ya existe) | cada 12h | `pets.rabies_observation_status='in_progress'` Y `bite.occurred_at + 10 days < now()` Y **no symptom escalable durante el período** | `rabies_observation_ended` con `payload.outcome='negative'`. Cierra caso con `closed_reason='auto_expired'` (rename: el outcome es negative, el motivo del cierre cron es auto_expired del plazo legal) |

**Cierres manuales:**

| Quién | Outcome admitido | Vía |
|---|---|---|
| Owner | `negative` solamente, y solo si pasaron los 10 días | botón "Cerrar observación" en `/mis-mascotas/[token]` cuando phase=`observation_open` Y `now() > bite.occurred_at + 10d` |
| Vet (org-affiliated) o govt o admin | `negative`, `positive_rabies`, `lost_to_followup` | `/admin/observaciones/[publicToken]` (ya existe, fase F6 del bite-rabies plan) |

Side effects atómicos en cualquier cierre:

1. INSERT `pet_events` `rabies_observation_ended` con `case_id`, payload con outcome y `triggered_by_event_id` (si vino por cascade o cron).
2. UPDATE `cases.status='closed'`, `closed_reason='resolved'` (manual) o `'auto_expired'` (cron), `closed_at=now()`, `closed_by_user_id=actor` (null si cron).
3. UPDATE `pets.rabies_observation_status='completed_{negative|positive_rabies|dead|lost_to_followup}'`.
4. Si `outcome='positive_rabies'`: notification `urgent` a govt + admin + owner (otra vez excepción al silence-owner del surveillance, justificada).
5. Si `outcome='dead'` (caso cascade desde death_recorded): notification `urgent` a govt (caso público-sanitario crítico, el centro de salud que atendió víctima necesita saberlo inmediatamente — bite-rabies D9).

### 5.6 Reapertura

No permitida. Si el mismo pet muerde de nuevo después de un cierre, se abre un `bite_incident` nuevo (caso secuencial, no reabierto).

### 5.7 Normativas aplicables

Lookup `lib/case-normatives.ts` entries:

```ts
{
  kind: 'bite_incident',
  jurisdiction: { country: 'AR' },
  laws: [
    { id: 'ley_15465_60_decreto_3640_64', label: 'Ley 15.465/60 + Decreto 3640/64', scope: 'rabia es enfermedad de notificación obligatoria nacional' },
    { id: 'res_ms_1144_2018', label: 'Res. MS 1144/2018', scope: 'guía nacional de prevención, vigilancia y control de rabia; APR' },
  ],
},
{
  kind: 'bite_incident',
  jurisdiction: { country: 'AR', province: 'Buenos Aires' },
  laws: [
    { id: 'decreto_4669_1973_pba', label: 'Decreto 4669/1973 PBA', scope: 'observación antirrábica obligatoria de 10 días' },
    { id: 'ley_5325_1948_pba', label: 'Ley 5325/1948 PBA', scope: 'denuncia obligatoria de enfermedades transmisibles dentro de 24hs' },
  ],
},
{
  kind: 'bite_incident',
  jurisdiction: { country: 'AR', province: 'Ciudad Autónoma de Buenos Aires' },
  laws: [
    { id: 'ord_caba_41831_1987', label: 'Ord. CABA 41.831/1987', scope: 'análogo CABA — observación en Instituto Pasteur o domicilio' },
    { id: 'ley_caba_4078_2012_res_93_apra_2021', label: 'Ley CABA 4078/2012 + Res. 93/APRA/2021', scope: 'notif <48hs para PPP' },
  ],
},
```

La UI del caso renderiza la unión de los matches `country = AR` + `province = <pet.jurisdiction_province>` + `province + locality = <pet.jurisdiction_locality>`.

### 5.8 Visibility tweaks

(Heredado del attachment spec §9 — sin tweaks adicionales. La matriz ya cubre subject_owner / case_participant / govt_in_scope / admin con el detalle correcto: victim_contact se redacta para subject_owner si no fue él quien aportó los datos.)

### 5.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Caso open (cascade del bite) | owner | `warning` | `bite_incident_opened_owner` |
| Caso open | govt scope-match | `warning` | `bite_incident_opened_govt` |
| Caso escalated (symptom rábico high-spec) | owner | `urgent` | `bite_incident_escalated_owner` |
| Caso escalated | govt | `urgent` | `bite_incident_escalated_govt` |
| Caso closed (outcome `negative`, manual u cron) | owner | `info` | `bite_incident_closed_negative_owner` |
| Caso closed (outcome `positive_rabies`) | owner + govt + admin | `urgent` | `bite_incident_closed_positive_*` |
| Caso closed (outcome `dead`) | govt + admin | `urgent` | `bite_incident_closed_dead_govt`, `_admin` |

Todas las notifications llevan `related_case_id` y `cta_url=/casos/<public_code>`.

### 5.10 Decisiones específicas

| # | Decisión | Razón |
|---|---|---|
| BI1 | El caso se cierra con `closed_reason='auto_expired'` cuando el cron lo cierra al día 11 con outcome `negative`. Decirle "resolved" sería técnicamente correcto pero el motivo de cierre fue temporal, no humano. Documentar | Más útil para auditoría — distinguir "alguien decidió que era negative" vs "pasaron 10 días sin pasar nada" |
| BI2 | El cron corre cada 12h (no diario) para minimizar la ventana en la que un caso elegible queda abierto post-deadline. Cada corrida es idempotente | Más sensible al deadline legal de 10 días que casos normales |
| BI3 | El subject del caso es el pet **mordedor**, no la víctima. Aunque la víctima sea otro pet registrado, ese pet NO tiene `bite_incident` abierto sobre él (puede tener `incident_reported(bite_suffered)` que es modo `attaches-when-open`, pero no abre caso propio) | El caso es por la observación antirrábica; el riesgo público recae sobre el mordedor |
| BI4 | Si un pet con `bite_incident` abierto cambia de dueño (`custody_transferred` durante el período), el caso sigue abierto bajo el mismo case_id; el nuevo dueño hereda visibility como `subject_owner` y el viejo dueño la pierde (excepto retro-history vía la visibility de events propios) | El caso vive en el pet, no en el dueño |

### 5.11 Open questions específicas

- **PPP attestation faltante en el momento del bite** — si `pets.potentially_dangerous_breed=true` Y `dangerous_breed_attested` no existe, ¿el caso debería escalarse automáticamente? Tendencia: NO — son dos issues legales separados; sí se debería emitir notification adicional al owner recordándole la atestación pendiente (sería un follow-up de Ley 4078).
- **Múltiples bites simultáneos** — ¿el pet muerde a 3 personas en el mismo episodio? Modelo actual: 1 `incident_reported` por persona mordida, 1 caso por bite event, pero el primer caso abre observación y los siguientes intentos de open auto-degradan a attach del caso existente. Confirma: sí — el período de 10 días corre por el bite más reciente, los demás incidents se anexan al mismo caso.
- **Vínculo a `outbreak_investigation`** — si el bite_incident está escalado por rabia, ¿debería abrir/atar a un `outbreak_investigation` paralelo? Tendencia: el `outbreak_signal` ya se emite por el matcher; ese signal puede abrir su propio `outbreak_investigation` (case_kind no-v1 por ahora). En v1 simplemente se ve la escalación dentro del bite_incident.

---

## 6. Lifecycle — `lost_pet_episode`

### 6.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'`.
- UNIQUE: `(primary_pet_id, case_kind) WHERE status IN ('open', 'escalated')`. Un pet tiene a lo sumo 1 `lost_pet_episode` abierto. Si se pierde de nuevo después de un return, se abre uno nuevo (L4).
- Linkage table: **ninguna**. Toda la data específica vive en events (`status_changed`, `credential_scanned`, `custody_transfer_proposed`, `custody_transferred`) y en denormalizaciones existentes (`pets.status='lost'`, `pets.last_known_location_*`).

### 6.2 Estados y phases

`status` admitido: `open`, `closed`. (Sin `escalated`. Los lost-pet alerts viven en la severity de las notifications, no en el status del caso.)

Phases observables:

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `lost_broadcast_active` | `status='open'` Y `pets.status='lost'` Y no hay `custody_transfer_proposed` activo del flujo de devolución | El pet figura como perdido, el broadcast está activo (en coverage zones), scans públicos quedan registrados para hotspot tracking |
| `match_proposed` | `status='open'` Y existe `custody_transfer_proposed` con `from_role='shelter_custody'` (un refugio cree haberlo encontrado y propone devolución al dueño) sin `custody_transferred` posterior | Devolución en negociación. El dueño tiene que aceptar |
| `returned_in_progress` | `status='open'` Y `custody_transferred` insertado pero `pets.status` todavía es `'lost'` (gap entre transfer y status flip — defensive, raro) | Estado de transición técnica |
| `closed_returned` | `status='closed'` Y último event terminal fue `status_changed(to='active')` | Cierre feliz |
| `closed_no_return` | `status='closed'` Y closure por cron de inactividad o por owner abandonando el episodio | Cierre operativo, el pet sigue marcado lost o el owner abandonó el episodio |

Diagrama:

```
                    status_changed(to=lost)
                          │
                          ▼
              ┌───────────────────────┐
              │ lost_broadcast_active │
              └───────────────────────┘
               │            │           │
   custody_transfer_proposed│           │ status_changed(to=active) (req-owner)
   (from_role=shelter_custody)          │   directa (el dueño la encontró)
               │            │           │
               ▼            │           ▼
       ┌───────────────┐    │  ┌──────────────────┐
       │ match_proposed│    │  │ closed_returned  │ *[FIN]
       └───────────────┘    │  └──────────────────┘
               │            │
   custody_transferred      │ (auto) cron: inactividad > 180 días
   (accept by owner)        │   sin scans, sin propuestas
               │            │
               ▼            ▼
       ┌───────────────┐  ┌──────────────────┐
       │closed_returned│  │ closed_no_return │ *[FIN]
       │   *[FIN]      │  └──────────────────┘
       └───────────────┘
```

### 6.3 Apertura

**Auto (única vía):** `status_changed` con `payload.to_status='lost'` (modo `opens` por branch del attachment spec §7.1).

Server action `markPetLostAction` (refactor: lo ata al caso nuevo) ejecuta atómicamente:

1. INSERT `cases` con kind=`lost_pet_episode`, primary_pet_id, jurisdiction heredada de `pets`, `opened_reason='auto: status_changed.to=lost'`.
2. INSERT `pet_events` `status_changed` con `case_id=<nuevo>` y `payload.disclosure_prefs_snapshot` (ya definido en lost-and-found spec).
3. UPDATE `pets.status='lost'`, `pets.last_known_location_*` desde payload.
4. Lookup `organization_coverage` para barrios que matchean la `lost_location` o `pet.jurisdiction_locality` → notification broadcast a verified `refugio | rescue_network` orgs del scope; ya implementado en lost-and-found Fase 6.
5. Notification al owner: caso creado, lista de refugios alertados, link al caso.

**Manual open:** no permitido. Si un govt cree que un pet está perdido pero el dueño no marcó, abren un `welfare_denuncia` (subject_kind=`registered_pet`), no un lost_pet_episode.

### 6.4 Avance — open → match_proposed

Trigger: INSERT de `custody_transfer_proposed` con `from_role='shelter_custody'`, `to_user_id=<owner>`, `matched_against_pet_id=<primary_pet_id>` Y existe `lost_pet_episode` abierto sobre esa pet (modo `attaches-when-open` del attachment spec §7.10 — opens si standalone, attaches si hay lost_pet_episode).

Side effects:

1. `case_id` del transfer_proposed = el del lost_pet_episode abierto.
2. Notification al owner severity `urgent` con CTA "Un refugio cree haberlo encontrado. Confirmá que es tu mascota."
3. Notification al refugio confirmación de propuesta enviada.

No flippeo de `pets.status` mientras esté en match_proposed — sigue `lost` hasta el accept.

### 6.5 Cierre

**Cierres automáticos (cron):**

| Cron route | Schedule | Condición | Event que emite | closed_reason |
|---|---|---|---|---|
| `/api/cron/close-stale-lost-episodes` | diario 04:00 UTC | `status='open'` Y `opened_at < now() - 180 days` Y sin events nuevos en últimos 60 días (sin scans, sin proposes, sin notes) | `note_added` con `payload.category='system'`, `text='Caso cerrado automáticamente por inactividad. La mascota sigue marcada perdida; el dueño puede reactivar reportándola encontrada o marcándola nuevamente como perdida.'` | `auto_expired` |

El cron NO cambia `pets.status`. La denormalización sigue `lost` porque no sabemos si volvió. El caso se cierra para liberar el broadcast y vías de coordinación; si el dueño la encuentra después, hace `status_changed(to=active)` directo sin caso.

**Cierres manuales:**

| Quién | Vía | Event emitido | closed_reason |
|---|---|---|---|
| Owner | `/mis-mascotas/[token]/devolucion` o "Encontré mi mascota" en `/mis-mascotas/[token]/perdida` | `status_changed(to=active)` (modo `requires-open` del attachment) | `resolved` |
| Owner accept de propuesta | accept en notification → server action `acceptReturnProposalAction` | `custody_transferred` (cierra el handshake) + cascade `status_changed(to=active)` (cierra el episode) | `resolved` |
| Owner | "Cancelar episodio" en `/mis-mascotas/[token]/perdida` (sin marcar encontrado) | `note_added(category='system', text='Episodio cancelado por dueño')` + manual UPDATE status | `cancelled` |
| Admin | `/admin/perdidas/[publicCode]` (futuro) override | `note_added` describiendo motivo + UPDATE | `cancelled` |

Side effects atómicos en cualquier cierre:

1. INSERT event de cierre + `case_id`.
2. UPDATE `cases.status='closed'`, `closed_reason`, `closed_at=now()`, `closed_by_user_id=actor`.
3. Si `closed_reason='resolved'`: UPDATE `pets.status='active'`, clear `last_known_location_*`.
4. Notification al owner (incluso si lo cerró él — confirmación) + a refugios que estaban targeting del broadcast (info: "el caso de [pet] se cerró").

### 6.6 Reapertura

No permitida (L4). Si vuelve a perderse, nuevo caso.

### 6.7 Normativas aplicables

Ninguna ley nacional o provincial específica gobierna el flujo lost/found. El lookup `lib/case-normatives.ts` devuelve array vacío para este kind. La UI del caso muestra una nota: "Este tipo de caso no tiene marco legal específico — es un flujo operativo interno de MiMAR para coordinar la devolución."

(Si en algún momento se quiere referenciar Ord. CABA 9.111/77 sobre tenencia responsable, o decretos provinciales sobre microchipping y devolución, agregar entries acá. Por ahora limpio.)

### 6.8 Visibility tweaks

Heredado del attachment spec §9 (matriz `lost_pet_episode`). Único tweak adicional:

- **Public anon en la credencial Tier-1**: cuando `pets.status='lost'`, la página pública `/p/[publicToken]` muestra info ampliada (Tier 1 del privacy tiers de AGENTS.md). Ese render es proyección sobre el pet, no sobre el caso — pero la "vida" del Tier 1 está bound al lifecycle del caso: una vez `status_changed(to=active)`, Tier 1 vuelve a Tier 0. Materializa la conexión: el componente público lee `pets.status` (ya hace eso); el cierre del caso garantiza que `pets.status` se flippea. Coherente.

### 6.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Caso open | owner | `info` | `lost_episode_opened_owner` |
| Caso open broadcast | refugios verified en coverage zone | `info` | `lost_episode_broadcast_refugio` |
| `custody_transfer_proposed` (refugio cree haberlo encontrado) | owner | `urgent` | `lost_episode_match_proposed_owner` |
| Caso closed `resolved` (encontrado) | owner | `success` | `lost_episode_resolved_owner` |
| Caso closed `resolved` | refugios del broadcast | `info` | `lost_episode_resolved_broadcast` |
| Caso closed `auto_expired` (cron 180d) | owner | `warning` | `lost_episode_auto_expired_owner` |
| Caso closed `cancelled` | owner | `info` | `lost_episode_cancelled_owner` |

### 6.10 Decisiones específicas

| # | Decisión | Razón |
|---|---|---|
| LP1 | El cron de inactividad cierra solo el caso, no flippea `pets.status`. La mascota sigue marcada perdida hasta acción explícita del owner | El sistema no puede asumir que un pet sin novedades en 6 meses está "encontrado". Lo opuesto es más probable |
| LP2 | El threshold de inactividad es 180 días, calculado desde el último event significativo (scan, propose, note). Sin scans tampoco "cuenta" como actividad para el threshold — el pet puede no haber sido escaneado nunca | Balance entre dar tiempo razonable de búsqueda y no acumular casos zombies en `/gob/perdidas` dashboard |
| LP3 | El broadcast no se vuelve a disparar al reabrir un caso nuevo si la coverage zone es la misma — solo se notifica a refugios que no habían sido notificados antes O cuyo último broadcast tiene > 30 días | Anti-spam para refugios que ya saben del caso. El throttle vive en `lib/lost-pet-broadcast.ts` (a crear/refactor) |
| LP4 | `credential_scanned` durante `lost_pet_episode` open Y con scanner authenticated (no anonymous) → atrás del scenes notifica al owner "alguien interesado escaneó tu mascota cerca de [aprox location]". La info de location es la del scan, redactada a barrio | Coherente con disclosure_prefs_snapshot del lost-and-found spec. PII nunca cruzado |

### 6.11 Open questions específicas

- **Reactivación rápida tras cierre por inactividad** — si el dueño quiere reabrir 30 días después del cierre cron, ¿debería ser un caso nuevo o re-uso del viejo? L4 dice nuevo. Validar UX: el flujo de "marcarla perdida de nuevo" desde la pet page funciona idéntico a la primera vez, así que el caso nuevo es transparente para el usuario.
- **Multi-jurisdicción** — pet con jurisdiction CABA que se pierde en Mendoza. ¿El broadcast usa CABA o el `lost_location`? Tendencia: el `lost_location` cuando está, fallback a `pet.jurisdiction_locality`. Concretar el helper.
- **Pet sin chip y sin distinguishing features** — modelo enriched del lost-and-found spec ya cubre el form, ¿el caso debe forzar attachment de fotos antes de open? Tendencia: NO — el caso se puede abrir con lo que sea; las fotos hacen al broadcast más útil pero no son requeridas para arrancar.

---

## 7. Lifecycle — `welfare_denuncia`

### 7.1 Sujeto y unicidad

- `primary_subject_kind` polimórfico: `'registered_pet' | 'unowned_animal' | 'location' | 'general'` (espeja `welfare_reports.subjectKind`).
- UNIQUE: ninguno cross-pet — múltiples denuncias sobre el mismo pet o location son válidas (caso típico: varios vecinos denuncian la misma situación). El bookkeeping deduplica más tarde (welfare_report.status='duplicate' o caso `merged`).
- Linkage table: **`welfare_reports`** vía `cases.welfare_report_id` (1:1 obligatorio para este kind — no hay welfare_denuncia sin welfare_report). FK con ON DELETE RESTRICT.

### 7.2 Estados y phases

`status` admitido: `open`, `closed`, `merged`. (Sin `escalated` — la severidad ya vive en `welfare_reports.severity` y se computa en queries; no requiere flippeo de status del caso.)

Phases observables (sincronizadas con `welfare_reports.status` para minimizar duplicación):

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `awaiting_triage` | `cases.status='open'` Y `welfare_reports.status='open'` Y `flagged_at IS NULL` | Recién creada, esperando welfare-officer asignación |
| `awaiting_moderation` | `cases.status='open'` Y `welfare_reports.status='open'` Y `flagged_at IS NOT NULL` Y `moderation_resolved_at IS NULL` | Denuncia anónima auto-flagged, esperando admin |
| `triaged` | `welfare_reports.status='triaged'` | Welfare officer revisó, marcó como válida, asignó para investigación |
| `in_progress` | `welfare_reports.status='in_progress'` | Investigación activa. Eventos clínicos / inspección / contacto con denunciado |
| `closed_resolved` | `cases.status='closed'` Y `closed_reason='resolved'` | Outcome de fondo: sanción, traslado de animal, archivo justificado, etc. Detalle en `resolution_notes` |
| `closed_duplicate` | `cases.status='merged'` Y `superseded_by_case_id IS NOT NULL` | Se identificó como duplicado de otro caso. Cierre + merge |
| `closed_invalid` | `cases.status='closed'` Y `closed_reason='cancelled'` Y `welfare_reports.status='invalid'` | Determinada como inválida / mal intencionada / sin sustento |
| `closed_spam` | `cases.status='closed'` Y `closed_reason='cancelled'` Y existe event `welfare_report_confirmed_spam` | Anonymous spam confirmado por admin moderation |

Diagrama:

```
                  welfare_report INSERT (form público, anon o auth)
                          │
                          ▼ (server action atómico)
              ┌─────────────────────┐                ┌──────────────────────────┐
              │ awaiting_triage     │  (anon flag)  │  awaiting_moderation     │
              │ (welfare_report     │  ──────────►  │  (flagged_at != null)    │
              │  .status='open')    │               └──────────────────────────┘
              └─────────────────────┘                  │                │
                          │                            │ unflag         │ confirm_spam
                          │ welfare_report_triaged     │ (admin)        │ (admin)
                          ▼                            ▼                ▼
              ┌─────────────────────┐         ┌─────────────────────┐  ┌──────────────┐
              │ triaged             │         │ awaiting_triage     │  │ closed_spam  │ *[FIN]
              └─────────────────────┘         │ (back to start)     │  └──────────────┘
                          │                   └─────────────────────┘
                          │ welfare_report_started
                          ▼
              ┌─────────────────────┐
              │ in_progress         │
              └─────────────────────┘
            │     │       │       │
            │     │       │       │ duplicate identified
            │     │       │       ▼
            │     │       │   ┌────────────────────┐
            │     │       │   │ closed_duplicate   │ *[FIN] (merged + superseded_by)
            │     │       │   └────────────────────┘
            │     │       │
            │     │       │ invalid determined
            │     │       ▼
            │     │   ┌──────────────────┐
            │     │   │ closed_invalid   │ *[FIN]
            │     │   └──────────────────┘
            │     │
            │     │ welfare_report_closed (outcome=resolved)
            │     ▼
            │  ┌──────────────────┐
            │  │ closed_resolved  │ *[FIN]
            │  └──────────────────┘
            │
            │ auto cron: 365 días en in_progress sin eventos → forzar cierre
            ▼
          (notification al officer asignado, no auto-close — solo escalación visible en /gob/maltrato)
```

### 7.3 Apertura

**Auto (vía estándar):** INSERT de `welfare_reports` (form `/denuncias/nueva`, autenticado o anon). Server action `submitWelfareReportAction` ejecuta atómicamente:

1. INSERT `welfare_reports` con `reference_code='DEN-XXXX-XXXX'`.
2. INSERT `cases` con kind=`welfare_denuncia`, `welfare_report_id=<wr.id>`, primary_subject_kind = `welfare_reports.subjectKind`, primary_pet_id si aplica, primary_location_* si aplica, jurisdiction_* heredada de welfare_reports.
3. UPDATE `welfare_reports.case_id=<case.id>` (único UPDATE excepción al "no UPDATE" de welfare_reports, ya documentado en attachment §10.2).
4. INSERT bridge events sobre pet_events si `subjectKind='registered_pet'`: `maltreatment_reported`, `abandonment_reported`, `symptom_observed` con `case_id=<case.id>` cada uno (server action ya existe `app/actions/welfare.ts`; el refactor es agregar el `case_id`).
5. Routing notification a govt scope-matching (welfare officers de la localidad). Severity = mapping de `welfare_reports.severity` (`low→info`, `medium→info`, `high→warning`, `critical→urgent`).
6. Si `reporterUserId` no es null, notif de confirmación al reporter con código DEN- y link al caso.

**Manual open:** permitido. Welfare officer puede crear caso manualmente desde `/gob/maltrato/nueva` cuando recibe denuncia por canal externo (mail, presencial, llamada). En ese flujo:

1. Officer llena el form que internamente hace lo mismo que el form público.
2. `opened_by_user_id = officer.id`, `opened_reason='manual: recibido por <canal>, denunciante <nombre o anónimo>'`.
3. El `welfare_reports.reporter_user_id` puede ser null (anónimo externo) o el officer (proxy).

### 7.4 Avance

Cada transición de phase es un event audit-log nuevo (los 5 que ya existen en `AUDIT_LOG_ACTIONS`):

| Phase de origen | Phase destino | Event audit | Actor | Side effects |
|---|---|---|---|---|
| awaiting_moderation | awaiting_triage | `welfare_report_unflagged` | admin | UPDATE welfare_reports.moderation_resolved_at, flag_reasons stays; notif al officer scope |
| awaiting_moderation | closed_spam | `welfare_report_confirmed_spam` | admin | UPDATE welfare_reports.status='invalid', UPDATE cases.status='closed' closed_reason='cancelled' |
| awaiting_triage | triaged | `welfare_report_triaged` | govt | UPDATE welfare_reports.status='triaged', triagedAt, triagedByUserId; notif al officer (self-confirm) y opcionalmente al reporter ("tu denuncia fue revisada") |
| triaged | in_progress | `welfare_report_started` | govt | UPDATE welfare_reports.status='in_progress'; no notif del reporter (privacidad del proceso interno) |
| in_progress | closed_resolved | `welfare_report_closed` con payload outcome=resolved | govt | UPDATE welfare_reports.status='closed', closedAt, resolutionNotes; UPDATE cases.status='closed', closed_reason='resolved'; notif al reporter con resolución (texto curado) |
| in_progress | closed_duplicate | `welfare_report_closed` con payload outcome=duplicate, superseded_by_case_id | govt | UPDATE welfare_reports.status='duplicate'; UPDATE cases.status='merged', closed_reason='merged', superseded_by_case_id; notif al reporter "tu denuncia fue unificada con [DEN-Y]" |
| in_progress | closed_invalid | `welfare_report_closed` con payload outcome=invalid | govt | UPDATE welfare_reports.status='invalid'; UPDATE cases.status='closed', closed_reason='cancelled'; notif al reporter con motivo (curado) |

### 7.5 Cierre

(Detallado en §7.4 — los cierres son siempre transiciones desde `in_progress` o desde `awaiting_moderation`.)

**Cierre automático**: NO hay auto-close por cron. Las denuncias son sensibles legalmente, no se cierran solas. SÍ hay **escalación visible**: cron `/api/cron/escalate-stale-welfare-cases` (diario 04:00 UTC) que computa denuncias en `in_progress` desde >90 días sin events y emite notification al officer asignado + lista en `/gob/maltrato` con badge "stale". El cron NO modifica nada del caso.

### 7.6 Reapertura

No permitida (L4). Si una situación reaparece, es una denuncia nueva. La denuncia vieja queda como referencia histórica accesible desde la nueva via `note_added(category='reference', text='Posiblemente relacionada con DEN-X / CAS-Y')` insertado por el officer.

### 7.7 Normativas aplicables

```ts
{
  kind: 'welfare_denuncia',
  jurisdiction: { country: 'AR' },
  laws: [
    { id: 'ley_nacional_14346_1954', label: 'Ley Nacional 14.346 (1954)', scope: 'malos tratos y actos de crueldad contra animales' },
  ],
},
{
  kind: 'welfare_denuncia',
  jurisdiction: { country: 'AR', province: 'Ciudad Autónoma de Buenos Aires' },
  laws: [
    { id: 'caba_mpf_pipeline', label: 'MPF CABA — Unidad Fiscal de Maltrato Animal', scope: 'pipeline de denuncia formal — referencia operativa, no marco legal' },
  ],
},
```

(Provincias adicionales se agregan cuando se implementen export templates específicos.)

### 7.8 Visibility tweaks

Heredado del attachment spec §9. Tweaks adicionales:

- **Subject owner NUNCA recibe notification ni visibility** del caso mientras está abierto. La denuncia es muchas veces *contra* el dueño; notificarlo arruina el due process. Esto refuerza el ❌ del attachment spec §9 row "subject_owner (si pet registrada)" en `welfare_denuncia`.
- **Cuando el outcome cruza un threshold de obligatoriedad notif** (e.g., decisión judicial cierra el expediente con sanción), el caso sí emite notification al owner — pero por el outcome legal, no por el caso en sí. La política exacta queda como open question §7.11.
- **`note_added` con scope='internal_govt'** — la welfare officer puede agregar notas internas que solo otros govt/admin ven. Requiere el mismo `payload.scope` field que el internal_org de adoption (ver attachment §12). Implementación shared con adoption.

### 7.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Caso open (vía form) | reporter (si autenticado) | `info` | `welfare_denuncia_received_reporter` |
| Caso open | govt scope-match (welfare officers) | mapping de severity | `welfare_denuncia_received_officer` |
| Caso flagged (anon) | admin moderation queue | `info` | `welfare_denuncia_flagged_admin` |
| Caso triaged | reporter | `info` | `welfare_denuncia_triaged_reporter` |
| Caso closed_resolved | reporter | `info` | `welfare_denuncia_resolved_reporter` (con outcome curado) |
| Caso closed_invalid | reporter | `info` | `welfare_denuncia_invalid_reporter` (con motivo curado) |
| Caso closed_duplicate | reporter | `info` | `welfare_denuncia_duplicate_reporter` (con DEN- del unificado) |
| Caso stale (cron escalation) | officer asignado | `warning` | `welfare_denuncia_stale_officer` |

Anonymous reporters (sin `reporter_user_id`) no reciben notificaciones — su único canal de status es el código `DEN-XXXX-XXXX` en `/denuncias/codigo/[code]`.

### 7.10 Decisiones específicas

| # | Decisión | Razón |
|---|---|---|
| WD1 | Una pet puede tener N `welfare_denuncia` simultáneas (vecinos distintos denuncian situaciones distintas, o la misma desde ángulos distintos). El UNIQUE constraint del attachment spec §4.1 NO aplica a este kind | Cada denuncia es un derecho ciudadano independiente. Deduplicar a nivel de pet violaría ese derecho |
| WD2 | El subject_owner JAMÁS ve la denuncia mientras está open. Tampoco la ve en la libreta sanitaria del pet (los bridge events `maltreatment_reported`/`abandonment_reported` se filtran del owner-facing libreta — RLS específica para este event_type) | Due process. Si las viera, podría coordinar coartadas, atacar al denunciante, etc. |
| WD3 | Si la pet figura como `in_custody_dispute=true`, una nueva welfare_denuncia abre normalmente pero la severity de la notif al officer es bumpeada un nivel | Coexistencia de dispute civil + denuncia penal por maltrato es escenario realista y crítico |
| WD4 | El cron stale dispara solo `notification`, no UPDATE de status. Las denuncias en `in_progress` pueden necesitar 6-12 meses de investigación legítima; cerrarlas por cron sería borrar evidencia | Sensibilidad de la materia |
| WD5 | El export template a MPF CABA (open question del welfare spec) cuando se implemente, vive como un button en el detail page del caso para officers — produce PDF con todos los events + attachments + identificación de partes. La generación del PDF usa la skill `pdf` (ver `skills/pdf`) | Materialización del case-as-export |

### 7.11 Open questions específicas

- **Notificación al owner post-cierre con sanción** — ¿el sistema notifica al owner que fue denunciado y sancionado? Tendencia: NO en v1; la notificación de la sanción la maneja el canal legal (MPF), no MiMAR. MiMAR sí puede registrar el outcome en `note_added(scope=public)` del pet para que vet/govt futuros vean el antecedente.
- **Cross-jurisdiction routing** — denuncia anónima sin jurisdiction explícita, ¿a qué govt va? Tendencia: si subject=registered_pet, usa `pet.jurisdiction_locality`; si subject=location, usa la del location; si subject=general/unowned_animal sin geo, queda en `/admin/maltrato/sin-asignar` para admin route manual.
- **Bridge a símil-eventos del pet cuando el denunciado NO es el dueño actual** — la denuncia es contra el cuidador previo, pero el pet ya cambió de dueño. ¿Los bridge events se siguen creando? Tendencia: SÍ, pero con `author_role='system'` y `payload.about_previous_custody=true`. El owner actual los ve en libreta como historia heredada.
- **Anonymous reporters spam-resistant tracking** — el tracking `/denuncias/codigo/[code]` hoy es público (cualquiera con el código accede). ¿Mantenerlo abierto o agregar email-based gating? Tendencia: mantenerlo abierto (UX prima); el código es de baja entropía pero la info expuesta es muy limitada.

---

## 8. Lifecycle — `adoption_listing` (org-side)

### 8.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'`.
- UNIQUE: `(primary_pet_id, case_kind, opened_by_organization_id) WHERE status IN ('open', 'escalated')`. Una pet puede estar listada simultáneamente por **múltiples orgs** solo si la custody está distribuida (raro; vive como exception). La regla normal: 1 org = 1 listing por pet.
- Linkage table: ninguna directa, pero `cases.adoption_application_id` queda null para este kind (es per applicant, no per listing). Posible linkage futura a una tabla `adoption_listings` si la implementación post-spec adoption-listing-public la introduce — por ahora, todo el estado vive en events + denormalizaciones `pets.adoption_eligible*`.

### 8.2 Estados y phases

`status` admitido: `open`, `closed`. (Sin `escalated`.)

Phases observables:

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `published` | `status='open'` Y no hay `adoption_application_submitted` hijas aún | Listing publicada, esperando postulaciones |
| `receiving_applications` | `status='open'` Y existe ≥1 `adoption_application` hija con status `open` | Recibiendo y reviewando postulaciones |
| `winner_selected` | `status='open'` Y existe `adoption_application_resolved(outcome='approved')` Y no `adoption_finalized` aún | Org eligió ganador, esperando finalización formal |
| `finalized_in_followup` | `status='open'` Y existe `adoption_finalized` Y `now() < adoption_finalized.payload.followup_until` | En período de checkins (12 meses default) |
| `closed_completed` | `status='closed'` Y closed_reason='resolved' Y existe `adoption_finalized` | Followup expirado, pet integrada |
| `closed_withdrawn` | `status='closed'` Y closed_reason='cancelled' Y existe `adoption_eligibility_set(eligible=false)` | Org retiró la listing antes de adoptar |
| `closed_reversed` | (estado transitorio) `status='closed'` después de `adoption_reversed` cierre final — el case puede haber reabierto y vuelto a cerrar | Adopción revertida; pet usualmente vuelve a `custody_episode` para reorganizar |

Diagrama:

```
              adoption_eligibility_set(eligible=true)
                          │
                          ▼
              ┌───────────────────────┐
              │ published             │
              └───────────────────────┘
                          │
                          │ adoption_application_submitted (hijo)
                          ▼
              ┌────────────────────────────┐
              │ receiving_applications      │
              └────────────────────────────┘
                  │           │
                  │           │ adoption_eligibility_set(eligible=false)
                  │           │   (cascade: rechaza todas las apps open)
                  │           ▼
                  │      ┌──────────────────┐
                  │      │ closed_withdrawn │ *[FIN]
                  │      └──────────────────┘
                  │
                  │ adoption_application_resolved(outcome=approved)
                  │   (org elige a uno)
                  ▼
              ┌───────────────────────┐
              │ winner_selected        │
              └───────────────────────┘
                          │
                          │ adoption_finalized
                          │   (cascade: cierra ganadora con won, rechaza losers,
                          │    foster_ended si activo, custody_transferred a owner)
                          ▼
              ┌──────────────────────────────┐
              │ finalized_in_followup         │
              └──────────────────────────────┘
                  │                       │
                  │ post_adoption_checkin │ adoption_reversed
                  │ (no transición, anota) │   → reabre temporalmente
                  ▼                       ▼
              (loop hasta cron expiry)  (manage reversal, cierra de nuevo)
                          │
                          │ cron: now() > followup_until
                          │ (auto: emite note_added system + UPDATE)
                          ▼
              ┌────────────────────┐
              │ closed_completed   │ *[FIN]
              └────────────────────┘
```

### 8.3 Apertura

**Auto:** `adoption_eligibility_set` con `payload.eligible=true` Y org tiene `shelter_custody` activa sobre el pet (chequeo en server action). Cascade del attachment §7.10:

1. INSERT `cases` con kind=`adoption_listing`, primary_pet_id, opened_by_organization_id=org, jurisdiction de la org HQ o de la pet (TBD config), `opened_reason='auto: adoption_eligibility_set.eligible=true'`.
2. INSERT `pet_events` `adoption_eligibility_set` con `case_id`.
3. UPDATE `pets.adoption_eligible=true`, `adoption_eligibility_set_at`, `adoption_eligibility_set_by_user_id`.
4. Notification org members con capability `adoption.write`: "Listing publicada para [pet]. Cuando reciba postulaciones aparecerán acá."

**Manual open:** no permitido. Para abrir la listing, hay que emitir el event de eligibility.

### 8.4 Avance

| De phase | A phase | Trigger | Side effects |
|---|---|---|---|
| published | receiving_applications | Primera `adoption_application_submitted` hija | Notif al org coordinator(s) con CTA review |
| receiving_applications | winner_selected | `adoption_application_resolved(outcome='approved')` (un solo applicant queda approved) | Pets.adoption_eligible permanece true hasta finalize; otros applicants approved (raro pero válido) coexisten — la org puede cambiar opinión hasta finalize |
| winner_selected | finalized_in_followup | `adoption_finalized` (cascade del attachment spec §8) | UPDATE pets.adoption_eligible=false, `adoption_finalized_at`, ownership flip (cascade); cierre de foster_placement si activo; cascade-rechazo de losing applications |
| finalized_in_followup | finalized_in_followup | `post_adoption_checkin` (no cambia phase, solo agrega event) | Notif al adopter agradeciendo el checkin; notif al refugio con el checkin nuevo |
| finalized_in_followup | finalized_in_followup (continuación) | `adoption_reversed` reabre case temporalmente, vuelve a cerrar | Ver §8.6 reapertura |

### 8.5 Cierre

**Cierre automático (cron):**

| Cron route | Schedule | Condición | Event que emite | closed_reason |
|---|---|---|---|---|
| `/api/cron/close-followup-expired-adoptions` | diario 04:00 UTC | `status='open'` Y existe `adoption_finalized` con `payload.followup_until < now()` | `note_added(category='system', text='Adopción completada — ventana de seguimiento finalizada. La pet queda integrada al hogar adoptante.')` con `case_id` | `resolved` |

**Cierres manuales:**

| Trigger | Vía | closed_reason |
|---|---|---|
| `adoption_eligibility_set(eligible=false)` desde `published` o `receiving_applications` | server action `setAdoptionEligibilityAction` con cascade-reject | `cancelled` |
| `adoption_reversed` desde `finalized_in_followup` | server action a definir post adoption-listing-public spec | reabre + cierra con `cancelled` (reason en payload) |

Side effects atómicos en cualquier cierre desde phase finalized_in_followup (cron o reversal):

1. INSERT event correspondiente (note system o adoption_reversed) con case_id.
2. UPDATE cases.status='closed', closed_reason, closed_at.
3. Notif al adopter (subject_owner) "Tu período de seguimiento con [refugio] terminó. ¡Gracias por darle un hogar a [pet]!" (cierre cron) o "La adopción fue revertida — el refugio se contactó contigo." (cierre reversal).
4. Notif al refugio.
5. Si reversal: las apps que se reabrieron por la lógica del adoption_reversed se cierran también con un cascade `adoption_application_resolved(outcome='rejected', auto_generated=true, reason='listing_reversed')`.

### 8.6 Reapertura (única excepción del L4)

Trigger: `adoption_reversed` mientras `status='closed'` Y closed dentro de la ventana de followup que estaba activa al cierre. La server action:

1. UPDATE `cases.status='open'`, `closed_at=NULL`, `closed_reason=NULL`, `closed_by_user_id=NULL`. Logueado como `note_added(category='system', text='Caso reabierto por adoption_reversed event_id=X')` con `case_id`.
2. INSERT `pet_events` `adoption_reversed` con `case_id`.
3. Reabre la `adoption_application` ganadora original (mismo UPDATE) + emite cierre nuevo con outcome=rejected en ella.
4. Reabre el `custody_episode` del refugio (que estaba cerrado por el finalize) o emite uno nuevo dependiendo del outcome del reversal.
5. UPDATE pets.adoption_eligible reset según outcome.
6. Cierre subsiguiente del caso (mismo flow) con `closed_reason='cancelled'` (o `'resolved'` si el reversal es por otro motivo organizado).

### 8.7 Normativas aplicables

Sin marco legal específico nacional. Los contratos de adopción son privados entre refugio y adopter; lo que sí existen son normas provinciales sobre tenencia responsable que aplican al post-adoption. Lookup:

```ts
{
  kind: 'adoption_listing',
  jurisdiction: { country: 'AR' },
  laws: [
    { id: 'contractual_privado', label: 'Contrato privado de adopción', scope: 'Acuerdo bilateral refugio/adopter; no rige norma específica nacional' },
  ],
},
```

Si en algún futuro provincia/ciudad legisla sobre adopciones (Mendoza tiene movimientos), agregar entries jurisdicción-específicas.

### 8.8 Visibility tweaks

Heredado del attachment spec §9 matrix de `adoption_listing`. Implementación de la **asimetría** (org ve todo, applicant ve nada del listing) requiere RLS que filtre `pet_events` por case_id Y kind:

```sql
-- Function visible signature
create or replace function can_read_adoption_listing_event(case_id uuid, uid uuid) returns boolean ...
-- regla: si user es miembro de cases.opened_by_organization_id → true
--         si user es subject_owner del pet POST adoption_finalized → true (ve su followup)
--         else → false
```

`note_added` con `payload.scope='internal_org'` se filtra para no-org-members siempre, independiente del kind.

### 8.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Caso open | org members con capability `adoption.write` | `info` | `adoption_listing_published_org` |
| Primera `adoption_application_submitted` hija | org members con capability `adoption.review` | `info` | `adoption_listing_first_app_org` |
| Nueva `adoption_application_submitted` adicional | org members con capability `adoption.review` | `info` | `adoption_listing_app_received_org` |
| `adoption_finalized` | adopter + org members | `success` | `adoption_listing_finalized_*` |
| `post_adoption_checkin` | adopter (confirmación) + org members | `info` | `adoption_listing_checkin_*` |
| Caso closed (followup expired cron) | adopter + org members | `info` | `adoption_listing_followup_expired_*` |
| Caso closed (withdrawn) | applicants pendientes (cascade reject), org | `info` / `warning` para applicants | `adoption_listing_withdrawn_*` |

### 8.10 Decisiones específicas

| # | Decisión | Razón |
|---|---|---|
| AL1 | El caso vive durante toda la ventana de followup (12 meses default). No se cierra al `adoption_finalized` — recién al expirar followup_until | El refugio sigue siendo legítimamente parte del caso durante checkins. Cerrar al finalize obligaría a un caso nuevo para los checkins, fragmentando la historia |
| AL2 | `adoption_eligibility_set(eligible=false)` con caso open hace cascade-reject de TODAS las applications hijas open, sin importar phase. Las apps en `winner_selected` también se rechazan | Si la org retira la listing, no puede haber applications en limbo. Es trato uniforme |
| AL3 | El `followup_until` se setea al insertar `adoption_finalized` desde `payload.post_adoption_followup_months` (default 12). NO se puede modificar después; si la org quiere extender, hace `note_added` y queda como acuerdo informal | Determinismo legal del contrato. Modificar post-hoc complica audit |
| AL4 | El cron de followup-expired NO notifica al adopter para no resultar invasivo ("te están vigilando"); SÍ notifica al refugio. La notif al adopter llega solo si se quiere agradecer / dar info adicional | Sensibilidad UX. El adopter ya no está bajo seguimiento; las notifs cron pueden percibirse como vigilancia |
| AL5 | El caso es "del refugio" pero el subject_owner del pet (adopter post-finalize) tiene visibilidad sobre los events post-finalización propios + meta del caso. NO ve la deliberación pre-finalización del refugio | Privacy del proceso interno + Transparencia del followup que lo involucra a él |

### 8.11 Open questions específicas

- **Múltiples orgs custody / listings paralelas** — caso edge: una pet en doble custody (refugio + foster con capacidades plenas) listada por dos partes simultáneamente. ¿Se permite? La constraint UNIQUE del §8.1 ya lo permite (incluye `opened_by_organization_id`). Decidir: ¿la app debería bloquear este escenario o tolerarlo? Tendencia: tolerar — el v1 lo trata como caso normal con 2 listings y cada una opera independiente. UX edge resuelto cuando aparezca.
- **Approval cross-org** — adopter se postula a una listing, pero el approval final lo hace una persona del govt local (caso futuro de "adopciones gubernamentales"). ¿El case sigue siendo "org-side"? Tendencia: SÍ, la org sigue siendo opened_by; el govt es `case_participant`.
- **Extensión de followup** — refugio quiere extender 6 meses adicionales. Hoy no se permite (AL3). ¿Vale la pena un event `adoption_followup_extended` o lo dejamos como UX papel-y-lapiz? Tendencia: cuando aparezca el use case real, agregar event.

---

## 9. Lifecycle — `adoption_application` (applicant-side)

### 9.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'`. El subject es la pet a la que se postula.
- UNIQUE: `(primary_pet_id, case_kind, applicant_user_id) WHERE status IN ('open', 'escalated')`. Un mismo applicant no puede tener dos `adoption_application` abiertas sobre la misma pet — duplicación de postulación.
- Constraint adicional implícito: `parent_listing_case_id` debe apuntar a una `adoption_listing` open al momento del INSERT (validado en server action).
- Linkage table: ninguna. Toda la data vive en events.

### 9.2 Estados y phases

`status` admitido: `open`, `closed`. (Sin `escalated` ni `merged`.)

Phases observables:

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `submitted` | `status='open'` Y no hay `adoption_application_resolved` | Postulación enviada, esperando review del refugio |
| `under_review` | (igual a submitted desde el punto de vista del case; la "in review" es un status field interno de la application table, no del caso) | Sinónimo de submitted hasta que llega resolve |
| `approved_pending_finalize` | `status='open'` Y `adoption_application_resolved(outcome='approved')` Y no hay `adoption_finalized` ni cierre cascade del finalize | Aprobado por refugio, esperando finalización formal del contrato |
| `closed_won` | `status='closed'` Y closed_reason='resolved' Y el applicant es el `adopter_user_id` del `adoption_finalized` parent | Ganador |
| `closed_rejected` | `status='closed'` Y closed_reason='resolved' Y `adoption_application_resolved(outcome='rejected', auto_generated=false)` | Rechazo directo por refugio |
| `closed_cascade_rejected` | `status='closed'` Y closed_reason='resolved' Y `adoption_application_resolved(outcome='rejected', auto_generated=true)` | Rechazo automático porque otro applicant ganó, o porque la listing se retiró, o porque la pet murió |
| `closed_withdrawn` | `status='closed'` Y closed_reason='cancelled' (el applicant retiró su postulación) | El postulante se bajó voluntariamente |

Diagrama:

```
              adoption_application_submitted
                          │
                          ▼
              ┌──────────────────────┐
              │ submitted            │
              └──────────────────────┘
                  │                  │
                  │ resolved=rejected│ resolved=approved
                  ▼                  ▼
              ┌──────────────┐    ┌────────────────────────┐
              │ closed_      │    │ approved_pending_       │
              │  rejected    │    │  finalize               │
              │  *[FIN]      │    └────────────────────────┘
              └──────────────┘                │           │
                                              │           │ applicant_withdrew
                                              │           │  (note + manual close)
                                              │           ▼
              parent listing's                │      ┌──────────────────┐
              adoption_finalized              │      │ closed_withdrawn │ *[FIN]
              (cascade)                       │      └──────────────────┘
                  │                           │
                  │ ganador               losers
                  ▼                           ▼
              ┌──────────────┐         ┌──────────────────────────┐
              │ closed_won   │         │ closed_cascade_rejected   │ *[FIN]
              │  *[FIN]      │         │  (auto_generated=true)    │
              └──────────────┘         └──────────────────────────┘
```

### 9.3 Apertura

**Auto:** `adoption_application_submitted` (modo `opens` del attachment spec §7.10). Server action `submitAdoptionApplicationAction` (a crear cuando se implemente el spec adoption-listing-public):

1. Valida: existe `adoption_listing` abierta para `(primary_pet_id, related_organization_id)`. Si no, error.
2. Valida: no existe `adoption_application` abierta del mismo applicant para la misma pet. Si sí, error.
3. INSERT `cases` kind=`adoption_application`, primary_pet_id, applicant_user_id (campo nuevo en `cases` table? — alternativa: vive en payload del event y se computa, ver §9.11), parent_listing_case_id=<listing>, jurisdiction heredada de la listing, `opened_reason='auto: adoption_application_submitted'`.
4. INSERT `pet_events` `adoption_application_submitted` con case_id.
5. Notification al applicant: confirmación.
6. Cascade notification al parent listing (notif a org members con capability `adoption.review`).

**Manual open:** no permitido. No tiene sentido — la postulación es declarativa.

### 9.4 Avance

| De phase | A phase | Trigger | Side effects |
|---|---|---|---|
| submitted | approved_pending_finalize | `adoption_application_resolved(outcome='approved', auto_generated=false)` | Notif al applicant "Tu postulación fue aprobada. Esperando finalización formal del contrato." |
| approved_pending_finalize | closed_won | Cascade from parent listing's `adoption_finalized` con `adopter_user_id=applicant_user_id` | INSERT cierre marker (`adoption_application_resolved` con marker — ver attachment §12 — o evento nuevo, TBD); UPDATE case.status='closed', closed_reason='resolved'; notif applicant "Adopción finalizada! [pet] es oficialmente parte de tu hogar." |
| approved_pending_finalize | closed_cascade_rejected | Cascade from parent listing's `adoption_finalized` con `adopter_user_id != applicant_user_id` | Caso edge: applicant fue aprobado pero otro fue elegido finalmente. El cascade emite `adoption_application_resolved(outcome='rejected', auto_generated=true, reason='another_finalized')`. Notif "Otro postulante fue elegido para [pet]" |

### 9.5 Cierre

(Detallado en §9.4 — todos los cierres son cascade desde parent listing o resolve directo.)

**Cierres manuales del applicant:**

| Trigger | Vía | closed_reason | Event |
|---|---|---|---|
| Applicant withdraws | botón en `/adoptar/[token]/mi-postulacion` (UX) | `cancelled` | `note_added(category='applicant_withdrew', text='El postulante retiró su postulación.')` con case_id, + UPDATE manual de status |

**Cierre automático**: no hay cron específico — cierres siempre vienen del parent listing o del propio applicant.

### 9.6 Reapertura

No permitida (L4). Si applicant quiere re-postularse a la misma listing (rara vez tiene sentido pero podría: rechazo, esperó 3 meses, condiciones cambiaron), abre `adoption_application` nueva.

### 9.7 Normativas aplicables

Mismo lookup que `adoption_listing` (sin marco legal nacional).

### 9.8 Visibility tweaks

Heredado del attachment spec §9 matrix de `adoption_application`. La clave RLS:

- `applicant_user_id = auth.uid()` → ve full su caso
- `auth.uid()` es miembro de la org del parent listing → ve full (review)
- Otros applicants a la misma listing → ❌ (la asimetría del attachment spec materializada como RLS).

### 9.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Caso open | applicant | `info` | `adoption_app_submitted_applicant` |
| Cascade: notif al parent listing | org members | (cubierto por `adoption_listing_app_received_org`) | — |
| `adoption_application_resolved(approved)` | applicant | `success` | `adoption_app_approved_applicant` |
| `adoption_application_resolved(rejected, manual)` | applicant | `info` | `adoption_app_rejected_applicant` (con motivo opcional curado) |
| `closed_won` (cascade del finalize) | applicant | `success` | `adoption_app_won_applicant` |
| `closed_cascade_rejected` (otro ganó) | applicant | `info` | `adoption_app_other_won_applicant` |
| `closed_cascade_rejected` (listing withdrew) | applicant | `info` | `adoption_app_listing_withdrew_applicant` |
| `closed_cascade_rejected` (pet died — caso muy delicado) | applicant | `info` con copy sensible específica | `adoption_app_pet_died_applicant` |
| `closed_withdrawn` (applicant retiró) | applicant (confirmación) | `info` | `adoption_app_withdrawn_applicant` |

### 9.10 Decisiones específicas

| # | Decisión | Razón |
|---|---|---|
| AA1 | El `applicant_user_id` queda en una columna del caso (`cases.applicant_user_id`, nullable, populated solo para kind=adoption_application). Razón: el unique constraint del §9.1 lo necesita en la key; recomputar de events cada vez es ineficiente | Pragmatismo SQL. La columna es write-once al open |
| AA2 | El cierre del ganador NO usa un event_type nuevo. Reusa `adoption_application_resolved` con payload `{ outcome: 'approved', finalized: true, triggered_by_event_id: <finalize_id> }`. Es la resolución acá del open question §12 del attachment spec | Evita inflar el catálogo. El marker `finalized=true` distingue won-cascade de approved-not-yet-finalized |
| AA3 | El cierre `closed_cascade_rejected` con `reason='pet_died'` lleva copy específica empática. Hardcoded en `lib/notification-templates.ts` con tono distinto al rechazo standard | UX. Recibir "fuiste rechazado" cuando la mascota murió es brutal |
| AA4 | Withdraw del applicant es manual + irreversible (L4). Si se arrepiente y la listing sigue abierta, abre app nueva (limpio) | Sin chance de re-orden complejo |

### 9.11 Open questions específicas

- **`cases.applicant_user_id` columna nueva** — agregar el campo en el schema de `cases` o derivar del primer event de la app. Tendencia: agregar (AA1). Mínimo invasivo, claro en intent.
- **Visibility post-cierre del ganador** — el applicant ganador, una vez `closed_won`, ¿sigue viendo su `adoption_application` case? Tendencia: SÍ, indefinidamente — es su record histórico de la postulación. Lo ve desde `/cuenta/mis-postulaciones`.
- **Visibility post-cierre del perdedor** — un applicant `closed_cascade_rejected`, ¿debería poder ver el `closed_completed` final del listing (años después)? Tendencia: NO en v1 — su acceso termina al cierre de su app; el listing ya no le concierne.
- **Multiple listings, misma pet, mismo applicant** — escenario edge: pet listada por 2 orgs simultáneamente, applicant se postula a las dos. Las constraints lo permiten (UNIQUE incluye applicant_user_id Y la primary_pet_id pero NO la parent_listing). Tendencia: aceptarlo — son procesos independientes.

---

## 10. Lifecycle — `custody_dispute`

### 10.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'`.
- UNIQUE: `(primary_pet_id, case_kind) WHERE status IN ('open', 'escalated')`. A lo sumo 1 dispute abierto por pet — coherente con `pets.in_custody_dispute=true` flag bookend.
- Linkage table: **`custody_disputes`** vía `cases.custody_dispute_id`. 1:1 obligatorio. Las `custody_dispute_parties` cuelgan de la dispute, no del caso, pero la UI las trae como "actores de este caso".

### 10.2 Estados y phases

`status` admitido: `open`, `closed`. (Sin `escalated`. Una dispute es de por sí escalada; agregarle otro nivel sería redundante.)

Phases observables (sincronizadas con `custody_disputes.status`):

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `raised` | `cases.status='open'` Y `custody_disputes.status='open'` | Dispute activa, workflows normales suspendidos por la flag |
| `closed_ownership_confirmed` | `cases.status='closed'` Y `custody_disputes.resolution='ownership_confirmed'` | El owner pre-existente queda confirmado |
| `closed_ownership_transferred` | `cases.status='closed'` Y `custody_disputes.resolution='ownership_transferred'` | Ownership transferida a otra parte (cascade `custody_transferred`) |
| `closed_case_dismissed` | `cases.status='closed'` Y `custody_disputes.resolution='case_dismissed'` | Caso desestimado sin cambios |
| `closed_other` | `cases.status='closed'` Y `custody_disputes.resolution='other'` | Resoluciones no encuadradas en los enum standard, detalle en `resolution_summary` |

Diagrama:

```
              custody_dispute_raised (req-prof: admin o govt)
                          │
                          ▼
              ┌──────────────────────┐
              │ raised                │  ←─ workflows normales SUSPENDIDOS
              │  (in_custody_dispute  │     mientras la flag está activa
              │   =true on pets)      │
              └──────────────────────┘
                  │     │     │     │
                  │     │     │     │
                  │     │     │     │ outcome=other
                  │     │     │     ▼
                  │     │     │   ┌────────────────────┐
                  │     │     │   │ closed_other        │ *[FIN]
                  │     │     │   └────────────────────┘
                  │     │     │ outcome=case_dismissed
                  │     │     ▼
                  │     │   ┌───────────────────────────┐
                  │     │   │ closed_case_dismissed     │ *[FIN]
                  │     │   └───────────────────────────┘
                  │     │ outcome=ownership_transferred (cascade custody_transferred)
                  │     ▼
                  │   ┌───────────────────────────────────┐
                  │   │ closed_ownership_transferred       │ *[FIN]
                  │   └───────────────────────────────────┘
                  │ outcome=ownership_confirmed
                  ▼
              ┌───────────────────────────────┐
              │ closed_ownership_confirmed     │ *[FIN]
              └───────────────────────────────┘

  (todas las transiciones → custody_dispute_resolved con outcome correspondiente)
```

### 10.3 Apertura

**Auto:** `custody_dispute_raised` (modo `opens` del attachment spec §7.10). El event solo lo puede emitir admin o govt (capability gating).

Server action `raiseCustodyDisputeAction` (existe parcial post admin-page Fase 14):

1. INSERT `custody_disputes` con `petId`, `raisedByRole`, `external_proceeding_reference` opcional, status='open'.
2. INSERT `cases` kind=`custody_dispute`, primary_pet_id, custody_dispute_id=<nuevo>, jurisdiction de `custody_disputes` (province/locality required), `opened_reason='manual: raised by <role>'`.
3. INSERT `pet_events` `custody_dispute_raised` con `case_id`. Update `custody_disputes.raising_event_id` con el id del event.
4. UPDATE `pets.in_custody_dispute=true`.
5. INSERT `custody_dispute_parties` para las partes identificadas (current owner, claimant, etc.).
6. Notification al current owner: severity `urgent`, copy formal "Tu mascota ha sido marcada como sujeto de proceedings legales externos por <role>. Mientras la disputa esté activa, no podrás modificar custodia, marcarla como adoptable, ni transferirla. Para detalles, contactá <govt office>."
7. Notification al actor que la abrió + admin con visibilidad.

**Manual open:** todos los opens son manuales por naturaleza del kind (no hay cascade que abra disputes). Pero el flow técnico va por el event, no por un "manual open" sin event.

### 10.4 Avance

No hay transiciones intermedias dentro de `raised`. El estado se mantiene hasta `custody_dispute_resolved`.

**Side effect crítico durante `raised`:** la flag `pets.in_custody_dispute=true` actúa como gate en los siguientes flujos (chequeo defensivo en server actions, ya parcialmente implementado):

- `setAdoptionEligibilityAction` rechaza si flag=true (cross-spec guard del adoption-listing-public v1.3 D21)
- `markPetLostAction` permitido (lost-and-found es ortogonal a dispute) pero notif extra al admin que lo levantó
- `createPetEventAction` para events clínicos: permitido (la mascota sigue viva, necesita cuidado)
- `custodyTransferAction` rechazado: hay un proceso judicial corriendo; ningún transfer civil válido
- `fosterAssignAction` rechazado por la misma razón
- `recordDeathAction` permitido pero notif urgent a admin + govt (cambia drásticamente la dispute)

### 10.5 Cierre

**Único trigger de cierre:** `custody_dispute_resolved` con `payload.outcome IN {ownership_confirmed, ownership_transferred, case_dismissed, other}` (modo `requires-open`). Solo lo emite admin o govt scope-matching.

Server action `resolveCustodyDisputeAction`:

1. INSERT `pet_events` `custody_dispute_resolved` con `case_id`, payload outcome + resolution_summary.
2. UPDATE `custody_disputes.status='closed'`, `resolution`, `resolution_summary`, `resolution_event_id`, `resolved_by_user_id`, `resolved_at`.
3. UPDATE `cases.status='closed'`, `closed_reason='resolved'`, `closed_at`, `closed_by_user_id`.
4. UPDATE `pets.in_custody_dispute=false`.
5. Si outcome=`ownership_transferred`: cascade `custody_transferred` con from/to derivado de las parties (la lógica precisa la define el server action; payload del dispute resolved puede incluir `to_user_id` o `to_organization_id`).
6. Notification a current owner (que puede haber cambiado por (5)) con outcome curado y next steps si aplica.
7. Notification al previous owner si ownership_transferred — copy específica empática.
8. Notification al actor resolver + admin.

**Cierre automático**: no hay cron. Las disputes legales no se cierran solas; pueden tomar años. Hay sí un cron de **escalation visible**: `/api/cron/escalate-stale-disputes` que después de 365 días sin events emite notif a admin + govt asignado "Custody dispute on [pet] has been open for 1 year. Consider follow-up with legal authority."

### 10.6 Reapertura

No permitida (L4). Si después de un `closed_case_dismissed` el caso judicial se reabre legalmente, se abre `custody_dispute` nueva con referencia al case_id viejo en `opened_reason`.

### 10.7 Normativas aplicables

No hay marco legal específico genérico — cada dispute tiene su propio `external_proceeding_reference`. Lookup:

```ts
{
  kind: 'custody_dispute',
  jurisdiction: { country: 'AR' },
  laws: [
    { id: 'codigo_civil_y_comercial', label: 'Código Civil y Comercial', scope: 'Animales como bienes / cosas; régimen de copropiedad y guarda' },
    { id: 'caso_por_caso', label: 'Proceeding judicial específico', scope: 'Detalle en `external_proceeding_reference` del dispute. Cada caso tiene su propia carátula y juzgado' },
  ],
},
```

### 10.8 Visibility tweaks

(Heredado del attachment spec §9 — el spec no detalla custody_dispute en su matriz preliminar; agregar acá.)

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| subject_owner (current) | ✅ | redacted (resolution_summary visible pero detail de external_proceeding NO; partes opuestas anonimizadas si admin lo marca) | ✅ (incluyendo partes opuestas con nivel de detalle config) | ✅ | ✅ (los suyos) |
| parties opuestas (otras del `custody_dispute_parties`) | ✅ | redacted (idem) | ✅ | ✅ | ✅ (las suyas) |
| govt_in_scope (que la abrió o tiene assignment en la jurisdicción) | ✅ | full | full | ✅ | ✅ |
| admin | ✅ | full | full | ✅ | ✅ |
| anon_public | ❌ | ❌ | ❌ | ❌ | ❌ |

### 10.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Caso open | current owner | `urgent` | `custody_dispute_raised_owner` |
| Caso open | parties opuestas identificadas | `urgent` | `custody_dispute_raised_party` |
| Caso open | govt scope + admin que lo abrió | `info` (auto-confirmación) | `custody_dispute_raised_internal` |
| Cualquier intento de action bloqueada por flag | actor que intentó (notif inline en server action error, no en notification table) | n/a | n/a |
| Caso closed por outcome | current owner + parties | `info` con outcome curado | `custody_dispute_resolved_*` |
| Cron escalation 365d | govt + admin | `warning` | `custody_dispute_stale` |

### 10.10 Decisiones específicas

| # | Decisión | Razón |
|---|---|---|
| CD1 | Solo admin o govt pueden raise. Owner / vet / refugio JAMÁS. El raise representa proceedings legales externos; ningún actor civil tiene la capacidad legal de "declarar" eso unilateralmente sobre la plataforma | Trust / due process |
| CD2 | El cierre requiere mismo nivel (admin o govt). El owner no puede "rendir" su dispute, ni el refugio "retirar" | Idem |
| CD3 | La flag `pets.in_custody_dispute` es el real source of truth operativo. El caso es metadata de coordinación; los guards de los demás flujos chequean la flag, no el case status | Mantiene la flag útil para queries fast, ya implementadas; el case agrega visibility |
| CD4 | Cuando outcome=ownership_transferred, el cascade `custody_transferred` se emite atómico al resolved. No hay handshake — la orden judicial NO requiere accept del receiver | Naturaleza compulsoria |
| CD5 | Notification al previous owner cuando pierde ownership lleva referencia al `resolution_summary` curado por el admin/govt que cerró. NO al `external_proceeding_reference` raw, que puede ser sensible | Privacy + claridad para usuario no-legal |

### 10.11 Open questions específicas

- **Anonimización de partes opuestas para el owner** — admin puede flaggear "esta parte no debe revelarse al owner por orden judicial". ¿Es un column en `custody_dispute_parties` (`hide_from_owner: bool`)? Tendencia: SÍ, agregar columna.
- **Multi-dispute sequential** — pet pasa por dispute, se cierra ownership_confirmed, después aparece otra dispute por otro motivo. Ambas tienen su own case con FK al `custody_disputes` row distinto. La UI de la pet muestra historial.
- **Integración con causas judiciales reales** — el `external_proceeding_reference` hoy es texto libre. ¿Tiene sentido un día estructurarlo (carátula + juzgado + número de expediente + url judicial.gob.ar)? Tendencia: cuando aparezca demanda real de export a sistema judicial, sí.

---

## 11. Lifecycle — `foster_placement`

### 11.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'`.
- UNIQUE: `(primary_pet_id, case_kind, foster_user_id) WHERE status IN ('open', 'escalated')`. Un mismo foster no puede tener dos placements abiertos para la misma pet. Pero **una pet puede tener N foster_placements paralelos** si la org permite co-foster (D17 del foster pool spec) — cada foster es su propio placement case.
- Linkage table: opcional `foster_volunteers.id` cuando la placement vino del pool (caso normal). No FK formal en `cases` table; se computa de events.

### 11.2 Estados y phases

`status` admitido: `open`, `closed`. (Sin `escalated` ni `merged`.)

Phases observables:

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `active` | `status='open'` Y existe `foster_assigned` Y no `foster_ended` | Foster cuidando al animal |
| `active_co_foster_allowed` | `status='open'` Y existe `foster_co_foster_allowed` event | El primer foster aceptó compartir custody. Una placement nueva paralela puede abrirse para co-foster |
| `closed_returned` | `status='closed'` Y `foster_ended.payload.ended_by='foster_returned'` | El foster decidió devolver el animal a la org |
| `closed_by_shelter` | `status='closed'` Y `foster_ended.payload.ended_by='shelter'` | La org terminó el foster (e.g., decisión administrativa) |
| `closed_to_adoption` | `status='closed'` Y `foster_ended.payload.reason='adoption'` (cascade desde adoption_finalized) | El foster eventualmente adoptó O la pet fue adoptada por un tercero |
| `closed_pet_died` | `status='closed'` Y `foster_ended.payload.reason='pet_died'` (cascade desde death_recorded) | |
| `closed_other` | `status='closed'` Y `foster_ended.payload.reason='other'` | Detalle en payload |

Diagrama:

```
              foster_assigned (cascade desde foster_proposal_resolved=accepted, o direct)
                          │
                          ▼
              ┌───────────────────────┐
              │ active                 │
              └───────────────────────┘
                          │
                          │ foster_co_foster_allowed (opcional, opt-in del foster)
                          ▼
              ┌───────────────────────────────┐
              │ active_co_foster_allowed       │
              │  (otra placement paralela      │
              │   puede abrirse)               │
              └───────────────────────────────┘
                  │      │      │      │
                  │      │      │      │ foster_ended (any path)
                  │      │      │      ▼
              ┌────────────────────────────────┐
              │ closed_{returned|by_shelter    │ *[FIN]
              │  |to_adoption|pet_died|other}  │
              └────────────────────────────────┘
```

### 11.3 Apertura

**Dos vías:**

**Vía A — cascade desde `foster_proposal_resolved(accepted)`:** la única vía "blessed" via pool. El cascade del attachment spec §8 lo cubre:

1. Server action `acceptFosterProposalAction` (ya existe) emite `foster_proposal_resolved(outcome=accepted)`.
2. Cascade-emit: `foster_assigned` con `triggered_by_event_id=<resolved>` Y abre `cases` kind=`foster_placement`. Atómico.
3. INSERT `ownerships` row role=`foster`, `owner_user_id=foster_user_id`, started_at=now() (parallel a shelter_custody existente).
4. Notification al foster (welcome, expectations); notif a org coordinator.

**Vía B — direct foster_assigned sin pool:** flow externo (refugio asigna a un voluntario que no entró por el pool, e.g., asignación interna). server action `assignFosterDirectAction`:

1. INSERT `foster_assigned` con `case_id=<nuevo>`, abre case mismo flow.
2. (Sin pool linkage; el `foster_proposal` case no existe.)

**Manual open:** no permitido — la apertura siempre va por event.

### 11.4 Avance

| De phase | A phase | Trigger | Side effects |
|---|---|---|---|
| active | active_co_foster_allowed | `foster_co_foster_allowed` (modo `requires-open` del attachment §7.10) | UPDATE `ownerships.allow_co_foster=true` en la row del foster; notif a org coordinator que pueden agregar co-foster |
| (cualquier active*) | (cualquier active*) | `note_added` | Sin transición de phase |

No hay `escalated` para este kind. La escalación de un foster que va mal (foster no responde, animal en peligro) se maneja como welfare_denuncia separada.

### 11.5 Cierre

**Único trigger:** `foster_ended` (modo `requires-open` del attachment §7.10).

Server action `endFosterAction` (existe, refactor para case_id):

1. INSERT `pet_events` `foster_ended` con `case_id`, payload `ended_by` + `reason` + `foster_assigned_event_id` opcional.
2. UPDATE `cases.status='closed'`, `closed_reason='resolved'` (mostly) o `'cancelled'` (si ended_by=shelter sin motivo definido), `closed_at`, `closed_by_user_id`.
3. UPDATE `ownerships.ended_at` del foster row.
4. Si reason=`adoption` (cascade desde adoption_finalized): no notif adicional (la del finalize ya cubre).
5. Si reason=`pet_died` (cascade desde death_recorded): no notif adicional (la del death ya cubre).
6. Si ended_by=`foster_returned`: notif al org coordinator + opcionalmente notif al foster confirmación.
7. Si ended_by=`shelter`: notif al foster con motivo + notif al coordinator.
8. Si la placement vino del pool (Vía A): UPDATE `foster_volunteers.available_slots += 1` (devolver slot al pool — patrón D16 single-use del foster pool spec); prompt "¿volver al pool?" notif al foster.

**Cierre automático**: NO hay cron. Las placements deben cerrarse por acción explícita (la org o el foster).

### 11.6 Reapertura

No permitida (L4). Si un mismo foster vuelve a cuidar al mismo animal después del cierre, abre placement nueva.

### 11.7 Normativas aplicables

Sin marco legal específico. Lookup retorna array vacío con nota informativa.

```ts
{
  kind: 'foster_placement',
  jurisdiction: { country: 'AR' },
  laws: [
    { id: 'sin_norma_especifica', label: 'Sin norma específica nacional', scope: 'Acuerdo bilateral org/foster. Aplican normas generales de tenencia responsable de la jurisdicción donde reside el foster' },
  ],
},
```

### 11.8 Visibility tweaks

(El attachment spec §9 no detalló `foster_placement` en su matriz preliminar; agregar acá.)

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| foster (= owner_user_id en el ownership row del placement) | ✅ | full | reducido (org coordinator + co-foster si existe) | ✅ | ✅ |
| org_custody_holder (org que mantiene shelter_custody en paralelo) | ✅ | full | full | ✅ | ✅ |
| co_foster (si existe paralelo) | ✅ (de SU placement) | full de SU placement; meta-only del otro foster | reducido | ✅ | ✅ (los suyos) |
| subject_owner (adopter post-finalización) | ✅ (su historia previa) | full retro pero solo del placement que terminó con su adoption | reducido | ✅ | ✅ (públicos) |
| govt_in_scope | ❌ | ❌ | ❌ | ✅ | ❌ |
| admin | ✅ | full | full | ✅ | ✅ |

### 11.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Caso open (cascade desde proposal accept o direct) | foster | `info` | `foster_placement_started_foster` |
| Caso open | org coordinator | `info` | `foster_placement_started_org` |
| `foster_co_foster_allowed` | org coordinator | `info` | `foster_co_foster_allowed_org` |
| Co-foster placement nueva paralela | first foster | `info` | `foster_co_foster_joined_first_foster` |
| Caso closed (ended_by=foster_returned) | org coordinator | `info` | `foster_placement_returned_org` |
| Caso closed (ended_by=shelter) | foster | `info` | `foster_placement_ended_by_shelter_foster` |
| Caso closed (reason=adoption, foster adoptó) | foster | `success` | `foster_placement_to_adoption_foster_adopted` |
| Caso closed (reason=adoption, otro adoptó) | foster | `info` | `foster_placement_to_adoption_third_party_foster` |
| Caso closed (reason=pet_died) | foster | `info` con copy empática | `foster_placement_pet_died_foster` |
| Prompt "¿volver al pool?" post-cierre | foster (si vino del pool) | `info` con CTA | `foster_volunteer_rejoin_pool_prompt` |

### 11.10 Decisiones específicas

| # | Decisión | Razón |
|---|---|---|
| FP1 | Vía A (cascade desde pool) y Vía B (direct) producen el mismo case y la misma estructura. Diferencia: presence/absence de `triggered_by_event_id` en el `foster_assigned` payload. UI puede mostrar "Voluntario del pool" o "Asignado directo" basado en eso | Simetría — un placement es un placement |
| FP2 | El co-foster opt-in (D17 foster pool) abre placements **paralelas**, no anexa al primer placement. Cada foster tiene su propio caso. La UI de la pet muestra ambos placements como abiertos | Trazabilidad individual de cada foster |
| FP3 | El cierre por cascade desde death_recorded NO notifica al adopter (no hay adopter), solo al foster con copy empática | UX sensibilidad |
| FP4 | El prompt de "¿volver al pool?" es solo notification — el foster decide. Sin auto-rejoin | Respeto al ciclo del voluntario (D16 single-use) |

### 11.11 Open questions específicas

- **Foster-to-adopt es el mismo person** — el `adoption_finalized.payload.foster_user_id=adopter_user_id`. La UI debería celebrar este caso (very common, exitoso). Tendencia: copy especial para este escenario (FP3 ya lo aborda).
- **Co-foster termination cascade** — si el primer foster termina, ¿el co-foster sigue solo o también termina? Tendencia: sigue solo. Su placement es independiente. (Validar UX cuando se construya.)
- **Voluntary suspension del foster sin terminar** — foster necesita irse 2 semanas, ¿cómo se modela? Tendencia: no se modela en v1 — termina y vuelve a abrirse después si retoma. KISS.

---

## 12. Cron jobs consolidados

Resumen de los crones que el sistema de casos requiere. Todos siguen el patrón `cron_runs` table (admin page Fase 14) — idempotente, autenticado con `CRON_SECRET`, lockable.

| Cron route | Schedule | Kind afectado | Acción | Cierra caso? |
|---|---|---|---|---|
| `/api/cron/close-rabies-observations` (ya existe — refactor para emitir case_id) | cada 12h | `bite_incident` | Emite `rabies_observation_ended(outcome=negative)` para casos con período cumplido sin escalación | sí — `auto_expired` |
| `/api/cron/close-stale-lost-episodes` (nuevo) | diario 04:00 UTC | `lost_pet_episode` | Emite `note_added(system)` y cierra casos inactivos >180d | sí — `auto_expired` |
| `/api/cron/escalate-stale-welfare-cases` (nuevo) | diario 04:00 UTC | `welfare_denuncia` | Emite notif al officer asignado para casos `in_progress` sin events >90d | NO (solo escalation visible) |
| `/api/cron/close-followup-expired-adoptions` (nuevo) | diario 04:00 UTC | `adoption_listing` | Emite `note_added(system)` y cierra cuando `followup_until < now()` | sí — `resolved` |
| `/api/cron/escalate-stale-disputes` (nuevo) | diario 04:00 UTC | `custody_dispute` | Emite notif al admin/govt para casos >365d | NO (solo escalation visible) |
| `/api/cron/expire-foster-proposals` (ya existe) | diario 04:00 UTC | `foster_proposal` (deferred kind) | Emite `foster_proposal_resolved(outcome=expired)` para proposals >7d sin response | sí — `resolved` (kind no-v1) |

**Patrón compartido** (a abstraer en `lib/case-cron.ts`):

```ts
async function runCaseCron({ name, kind, scanQuery, emitFn }: CaseCronInput) {
  await beginCronRun(name);
  const candidates = await scanQuery();
  for (const caseRow of candidates) {
    try {
      await db.transaction(async (tx) => {
        const event = await emitFn(tx, caseRow);
        // El emitFn opcionalmente flippea case status si es terminal
      });
    } catch (e) {
      logCronError(name, caseRow.id, e);
    }
  }
  await endCronRun(name);
}
```

**Vercel cron config** (`vercel.json`): registrar 4 nuevos crones + ajustar el de rabies a 12h en lugar de daily.

---

## 13. Tabla consolidada de normativas (`lib/case-normatives.ts`)

Estructura del módulo (sketch):

```ts
// lib/case-normatives.ts
export interface LawReference {
  id: string;            // slug estable, e.g. 'decreto_4669_1973_pba'
  label: string;         // display name "Decreto 4669/1973 (PBA)"
  scope: string;         // qué cubre, 1-line description
  fullTextUrl?: string;  // link a infoleg.gob.ar o equivalente cuando exista
}

export interface CaseNormativesEntry {
  kind: CaseKind;
  jurisdiction: {
    country: string;
    province?: string;
    locality?: string;
  };
  laws: LawReference[];
}

export const CASE_NORMATIVES: CaseNormativesEntry[] = [
  // bite_incident — ver §5.7
  ...,
  // welfare_denuncia — ver §7.7
  ...,
  // adoption_listing / adoption_application — ver §8.7 / §9.7
  ...,
  // custody_dispute — ver §10.7
  ...,
  // foster_placement — ver §11.7
  ...,
  // lost_pet_episode — array vacío (§6.7)
  ...,
];

export function getNormativesForCase(kind: CaseKind, jurisdiction: Jurisdiction): LawReference[] {
  // Merge: country-level + province-level + locality-level matches
  const matches = CASE_NORMATIVES.filter(e =>
    e.kind === kind &&
    e.jurisdiction.country === jurisdiction.country &&
    (e.jurisdiction.province === undefined || e.jurisdiction.province === jurisdiction.province) &&
    (e.jurisdiction.locality === undefined || e.jurisdiction.locality === jurisdiction.locality)
  );
  const allLaws = matches.flatMap(m => m.laws);
  // dedupe by law.id
  return uniqBy(allLaws, l => l.id);
}
```

**Cobertura test** (`__tests__/case-normatives.test.ts`):

```ts
import { CASE_KINDS } from "@/lib/case-kinds";
import { CASE_NORMATIVES, getNormativesForCase } from "@/lib/case-normatives";

it('every case_kind has at least one CASE_NORMATIVES entry (even empty laws array)', () => {
  for (const kind of CASE_KINDS) {
    const entry = CASE_NORMATIVES.find(e => e.kind === kind);
    expect(entry).toBeDefined();
  }
});

it('AR jurisdiction always resolves', () => {
  for (const kind of CASE_KINDS) {
    const laws = getNormativesForCase(kind, { country: 'AR' });
    expect(laws).toBeDefined();
  }
});

it('CABA bite_incident includes Ord. 41.831', () => {
  const laws = getNormativesForCase('bite_incident', {
    country: 'AR',
    province: 'Ciudad Autónoma de Buenos Aires',
  });
  expect(laws.find(l => l.id === 'ord_caba_41831_1987')).toBeDefined();
});
```

---

## 14. Matrix consolidada de notifications

Resumen cross-kind (referencia rápida). Cada cell apunta al template id documentado en su sección:

| Trigger | Owner | Foster | Org members | Govt scope | Admin | Reporter (welfare) | Otros |
|---|---|---|---|---|---|---|---|
| `bite_incident` open | warning | — | — | warning | — | — | — |
| `bite_incident` escalated | urgent | — | — | urgent | — | — | — |
| `bite_incident` closed positive | urgent | — | — | urgent | urgent | — | — |
| `lost_pet_episode` open | info | — | — | — | — | — | broadcast a refugios verified (info) |
| `lost_pet_episode` match_proposed | urgent | — | — | — | — | — | refugio que propuso (info confirm) |
| `lost_pet_episode` closed resolved | success | — | — | — | — | — | refugios broadcast (info) |
| `welfare_denuncia` open | ❌ | — | — | severity-mapped | — | info (si auth) | — |
| `welfare_denuncia` closed_resolved | ❌ | — | — | — | — | info | — |
| `adoption_listing` open | — | — | info | — | — | — | — |
| `adoption_listing` finalized | success (adopter) | — | success | — | — | — | applicants perdedores (info) |
| `adoption_listing` followup expired | — | — | info | — | — | — | — |
| `adoption_application` open | — | — | (cubre listing) | — | — | — | applicant (info confirm) |
| `adoption_application` won | — | — | — | — | — | — | applicant (success) |
| `adoption_application` cascade rejected (pet died) | — | — | — | — | — | — | applicant (info, copy empática) |
| `custody_dispute` open | urgent | — | — | info confirm | — | — | parties opuestas (urgent) |
| `custody_dispute` closed | info | — | — | info | — | — | parties (info) |
| `foster_placement` open | — | info | info | — | — | — | — |
| `foster_placement` closed (any) | — | varies | varies | — | — | — | — |

Implementación: tabla `lib/notification-templates.ts` (a crear/extender) mapea cada template_id a `{ title, body, severity, ctaLabel?, ctaUrl? }`. La función `emitCaseNotification(templateId, recipients, vars)` resuelve y INSERT en bulk.

---

## 15. Open questions cross-kind

Concentro acá las que no son de un kind específico. Las kind-specific viven en cada sección.

- **`cases.applicant_user_id` column** — necesaria para el unique constraint de `adoption_application` (AA1). ¿La agregamos genérica (nullable, solo populated para kinds que la usan) o creamos otra columna por kind? Tendencia: una sola, nullable, documentada como "context-dependent on case_kind".
- **`note_added` con `payload.scope: 'public' | 'internal_org' | 'internal_govt'`** — necesario para welfare_denuncia (§7.8) y adoption_application (§9.8 cross-ref attachment spec §12). ¿Lo agregamos antes que el sistema de casos, como retrofit a `note_added`, o juntos? Tendencia: juntos — son interdependientes y un single PR es más limpio.
- **`emitCaseNotification` vs reuso de `createNotification` existente** — ¿abstracción nueva o helper sobre la actual? Tendencia: helper, evita capas innecesarias. El abstrai ya existe; los templates son data.
- **Backfill retroactivo** — para datos productivos preexistentes (denuncias abiertas, disputes abiertos, observaciones rábicas abiertas) cuando la migration corra, ¿hacemos backfill creando cases retroactivamente o asumimos clean slate post-wipe? Tendencia: backfill mínimo para los 3 mencionados (los más críticos), skip todo lo demás.
- **UI navigation cross-case** — un pet puede tener varios casos abiertos simultáneos (e.g., en followup de adopción + bite_incident abierto). La pet page necesita un "Casos abiertos: 2" badge. ¿Order display: más recientes primero, o priorizado por kind (e.g., bite_incident > adoption_listing followup)? Tendencia: more recent first; el operador puede filtrar.
- **Audit log integration** — la tabla `audit_log` ya existe y tiene 17 acciones registradas. ¿Los transitions de cases deberían loguearse ahí también, o el event log (que ya es append-only) es suficiente? Tendencia: events alcanzan. El audit_log queda para acciones de superusuario que NO emiten events (approvals/revokes, bulk ops, etc.).

---

## 16. Out of scope (de este doc)

- **Los 6 kinds deferidos** (`custody_episode`, `custody_transfer_handshake`, `foster_proposal`, `outbreak_investigation`, `microchip_remediation`, `rabies_observation_followup`) — el attachment spec ya los nombra; sus lifecycles se escriben cuando su workflow envolvente lo demande. El attachment spec §6 ya documenta su propósito de una línea, suficiente como holding.
- **UI mocks de `/casos/[publicCode]`** — el spec menciona la ruta y su shape conceptual (timeline + actores + normativas + pending approvals). Mocks visuales / componentes Tailwind exactos van en spec UI separada cuando se decida implementar.
- **Performance / indexing strategy** — los index parciales sugeridos a lo largo del doc cubren los queries críticos. Tuning fino (cuándo materializar vs query, cuándo agregar índices compuestos) va en el plan ejecutable según se mida en runtime.
- **Sistema de templates de notification i18n-ready** — los `template_id` se referencian acá pero los textos exactos en español rioplatense vienen en el plan, no en este spec.
- **Export PDF de casos** (mencionado en welfare WD5) — depende de la `skill pdf` y del flujo de export a MPF CABA, ambos pendientes en sus propias specs.
- **Integration con Mi Argentina cuando lande** — los casos como expediente son la abstracción que va a hablar con expedientes de Mi Argentina, pero el bridge concreto vive en spec separada de la integración.

---

## 17. Resumen rápido para revisión

| Sección | Kind | Estados | Auto-close cron | Reapertura | Manual open |
|---|---|---|---|---|---|
| §5 | `bite_incident` | open / escalated / closed | sí (12h, día 11) | NO | NO |
| §6 | `lost_pet_episode` | open / closed | sí (180d inactividad) | NO | NO |
| §7 | `welfare_denuncia` | open / closed / merged | NO (solo escalation visible) | NO | SÍ (govt/admin) |
| §8 | `adoption_listing` | open / closed | sí (followup expired) | SÍ (única — adoption_reversed) | NO |
| §9 | `adoption_application` | open / closed | NO | NO | NO |
| §10 | `custody_dispute` | open / closed | NO (solo escalation 365d) | NO | NO |
| §11 | `foster_placement` | open / closed | NO | NO | NO |

7 lifecycles, 1 reapertura permitida, 3 crones de cierre automático, 2 crones de escalation visible.

---

**Next step para implementación:** ver `docs/superpowers/plans/2026-05-19-cases-system.md` (plan ejecutable mismo día). El plan toma este spec + el attachment spec como inputs únicos y produce schema + lib + actions + UI + tests + RLS en fases A-G.
