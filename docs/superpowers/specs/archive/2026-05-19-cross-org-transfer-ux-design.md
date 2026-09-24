# Cross-org transfer UX — design spec

> UI completa del handshake refugio→refugio (sender-confirms / receiver-accepts) sobre los eventos `custody_transfer_proposed` + `custody_transferred` que ya existen en el catálogo. AGENTS.md lo lista explícito como open: *"refugio-to-refugio handoffs need a sender-confirms / receiver-accepts flow. Event always emitted on completion (custody_transferred)."* También activa el `custody_transfer_handshake` case_kind que estaba en el subset deferred del lifecycles spec.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0
> **Depende de:** sistema de casos (`2026-05-19-cases-event-attachment-design.md` + `2026-05-19-cases-lifecycles-design.md`). Mueve `custody_transfer_handshake` del set deferred al subset v1.

---

## 1. Por qué este documento existe

Los handoffs entre refugios son frecuentes y delicados:

- Una org pequeña que no puede cuidar más a un animal lo transfiere a una más grande.
- Una rescue network con voluntarios transitorios lo redistribuye entre refugios verificados.
- Un refugio que cierra operaciones traspasa su población.
- Un refugio que se especializa (sénior, casos médicos complejos) recibe transfers desde otros.

Hoy el schema soporta esto via `custody_transferred` event (single-phase), pero:

- **Sin handshake** — el sender emite y la pet pasa, sin que el receiver confirme aceptación. Riesgo de "transferir sin contraparte preparada" (pet llega y el receiver no tiene cama).
- **Sin UI** — el flow está implementado parcialmente en `app/org/[orgToken]/transferencias/` para handoffs, pero el AGENTS.md confirma que el spec dedicado falta.
- **Sin case envelope** — los events sueltos no se agrupan; cuando algo sale mal (acepta tarde, expira, etc.) no hay artefacto que coordine.

Este spec usa el patrón `*_proposed/*_executed` ya establecido (custody, adoption) + el case_kind `custody_transfer_handshake` para envolver el handshake en un objeto coordinador con expiry, audit, y rollback.

---

## 2. Decisiones cerradas

| # | Decisión | Razón |
|---|---|---|
| CT1 | **Two-phase handshake obligatorio** entre orgs. Sender no puede transferir sin que el receiver acepte explícitamente. El `custody_transferred` (terminal) se emite solo en el accept del receiver | Coherencia con el patrón `*_proposed/*_executed` (attachment spec §7.10). Evita transfers "huérfanos" |
| CT2 | **`custody_transfer_handshake` case_kind se mueve al subset v1** del lifecycles spec. Su lifecycle se documenta acá (no en el lifecycles spec original que lo dejaba deferred) | Activar el kind cuando hay UI real es cuando tiene sentido. El kind sin UI es deuda |
| CT3 | **Expiry default 30 días** desde el `custody_transfer_proposed`. Si el receiver no responde en ese plazo, el caso se auto-cancela con `closed_reason='auto_expired'` vía cron. Sender puede cancelar antes (`closed_reason='cancelled'`). Sender puede también RE-proponer (caso nuevo) tras una cancelación | 30 días es razonable para coordinación entre refugios (vs 7 días del foster_proposal que tiene urgencia mayor) |
| CT4 | **Reasons enum** del `custody_transfer_proposed.payload.reason`: `space_constraint | specialization_needed | network_redistribution | shelter_closing | post_adoption_failed_return | other`. Otros valores rechazados. `other` requiere `notes` no vacío | Standardiza el "por qué". Útil para analytics de network refugio + dashboards govt |
| CT5 | **Sender NO transfiere medical records** explícitamente — `pets` row sigue siendo la misma (events permanecen, libreta sigue accesible). Solo cambia `ownerships` (active row del sender se cierra, nueva row para el receiver con role='shelter_custody') | Continuidad de historia clínica. La pet es la misma; solo cambia quién la cuida |
| CT6 | **Receiver gets full visibility de la libreta del pet al accept**. Pre-accept (durante el período del handshake open), receiver tiene visibility limitada — ve metadata + summary, no full event log. Acceptance dispara expansion | Privacy gradual. El receiver decide si acepta con info suficiente; al aceptar formaliza la custody y la info se vuelve necesaria operativamente |
| CT7 | **Sender NO puede modificar el pet (incl. cancelar el proposal) mientras está pending** sin notif al receiver. Cancel: notif al receiver explicando + chance de comentar. Edit de pet data: bloqueado pre-accept o requiere reconfirm del proposal | Trust. Si el sender cambia las cartas mid-handshake, el receiver decide si sigue |
| CT8 | **Multi-pet bulk transfer** queda fuera de v1. Cada pet su propio proposal/case. El refugio que cierra operaciones y traspasa 200 pets va a tener 200 cases — UI tendrá filtros para gestionarlo, pero la unidad mínima es 1 pet | Coherencia con el modelo case-per-pet. Bulk como UI sugar después |
| CT9 | **Capability `org.transfer.propose`** granted automáticamente a org members con role IN ('admin', 'coordinator'). Capability `org.transfer.accept` mismo subset. NO se otorga a 'member'/'volunteer'/'foster' (decisión institucional sale del rol coordinator+) | Patrón ya usado en otras org actions |
| CT10 | **El case se ata a la pet** (`primary_pet_id` = la pet siendo transferida). NO se ata simultáneamente a un `custody_episode` open (que técnicamente sería el envoltorio actual del shelter_custody del sender). Razón: simplicidad — el handshake es un evento entre orgs sobre la pet, no un sub-caso del custody. Cuando el accept ocurre, el case del sender's `custody_episode` se cierra cascade (custody_transferred sale), y se abre uno nuevo del receiver | Mantiene KISS. Multi-case modeling se complica fast |
| CT11 | **Multi-receiver impossible** — un proposal apunta a UN receiver. Si el sender quiere "ver quién acepta primero" entre múltiples orgs, debe emitir N proposals (uno por org) y cancelar los demás cuando uno acepta. UI futuro puede facilitar este "bidding" workflow; v1 no | KISS + atomic transactions. "Subasta de pet" es problema de UX más complejo |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Handshake** | El par `custody_transfer_proposed` (Phase 1) + `custody_transferred` (Phase 2) que materializa un cross-org transfer |
| **Sender** | La org que actualmente tiene `shelter_custody` activa sobre la pet y propone transferir |
| **Receiver** | La org elegida como destino. Cuando acepta, asume el `shelter_custody` |
| **Case envelope** | El `cases` row con `case_kind='custody_transfer_handshake'` que contiene los 2 events del handshake + cualquier `note_added` intermedio |
| **Proposal** | El `custody_transfer_proposed` event, Phase 1 |
| **Acceptance** | Acción del receiver que dispara la emisión de `custody_transferred` (Phase 2) + materializa el cambio de ownerships |
| **Rejection** | Acción del receiver que cierra el case con `closed_reason='cancelled'` + emite `note_added` explicando |
| **Cancellation** | Acción del sender que retira el proposal antes del accept del receiver |
| **Auto-expiry** | Cron daily que cierra cases con `opened_at + 30 days < now()` y sin accept ni cancel |

---

## 4. Domain model

### 4.1 Activar `custody_transfer_handshake` en case kinds

Update `lib/case-kinds.ts` (cuando el sistema de casos esté implementado):

```ts
export const V1_CASE_KINDS: readonly CaseKind[] = [
  'bite_incident',
  'lost_pet_episode',
  'welfare_denuncia',
  'adoption_listing',
  'adoption_application',
  'custody_dispute',
  'foster_placement',
  'custody_transfer_handshake',  // ← move from deferred to v1
];
```

### 4.2 Constraint UNIQUE

Una pet puede tener a lo sumo 1 `custody_transfer_handshake` open at a time. Constraint enforced via partial unique index ya descrito en el cases system plan §A:

```sql
-- Ya cubierto por: cases_open_per_pet_kind_idx
-- create unique index cases_open_per_pet_kind_idx
--   on cases (primary_pet_id, case_kind)
--   where status in ('open', 'escalated')
--     and case_kind not in ('adoption_application', 'adoption_listing', 'welfare_denuncia', 'foster_placement');
-- → custody_transfer_handshake NO está en el except list → constraint aplica
```

### 4.3 Lifecycle del case `custody_transfer_handshake`

(Addendum al lifecycles spec — esta sección se inserta como §12 del lifecycles spec cuando se implemente.)

**§12 Lifecycle — `custody_transfer_handshake`**

#### 12.1 Sujeto y unicidad

- `primary_subject_kind = 'registered_pet'`.
- UNIQUE: 1 case open por pet (cobertura via index parcial general).
- Linkage table: ninguna directa. La info "from→to" vive en el payload del `custody_transfer_proposed` event.

#### 12.2 Estados y phases

`status` admitido: `open`, `closed`.

Phases:

| Phase | Cómo se detecta | Significado |
|---|---|---|
| `proposed_awaiting_acceptance` | `status='open'` Y existe `custody_transfer_proposed` Y no `custody_transferred` ni cancel/expiry events | Phase 1 abierta, esperando al receiver |
| `accepted_finalized` | `status='closed'` Y existe `custody_transferred` | Phase 2 cerró, ownership cambió |
| `cancelled_by_sender` | `status='closed'` Y closed_reason='cancelled' Y existe `note_added(category='system', text contiene "cancelled by sender")` | Sender retiró antes del accept |
| `rejected_by_receiver` | `status='closed'` Y closed_reason='cancelled' Y existe `note_added` con flag de rejection | Receiver dijo no |
| `auto_expired` | `status='closed'` Y closed_reason='auto_expired' | 30 días sin respuesta |

Diagrama:

```
              custody_transfer_proposed (sender + capability check)
                          │
                          ▼
              ┌──────────────────────────────┐
              │ proposed_awaiting_acceptance │
              └──────────────────────────────┘
               │       │           │           │
   accept      │       │ reject    │ cancel    │ auto-expiry (cron 30d)
   (receiver)  │       │ (recv)    │ (sender)  │
               ▼       ▼           ▼           ▼
        ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌──────────────┐
        │ accepted │ │rejected │ │cancelled │ │ auto_expired │
        │  *[FIN]  │ │ *[FIN]  │ │  *[FIN]  │ │    *[FIN]    │
        └──────────┘ └─────────┘ └──────────┘ └──────────────┘
```

#### 12.3 Apertura

Auto vía `custody_transfer_proposed`. Server action `proposeCrossOrgTransferAction`:

1. Verificar sender member con capability `org.transfer.propose`.
2. Verificar sender tiene `shelter_custody` activa sobre la pet.
3. Verificar receiver es org verified.
4. Verificar no hay `custody_transfer_handshake` open ni `custody_dispute` ni `bite_incident` escalated sobre la pet (cross-spec guards).
5. TX:
   - openCase kind=`custody_transfer_handshake`, primary_pet_id=pet, opened_by_user_id=sender_user, opened_by_organization_id=sender_org, opened_reason=`auto: custody_transfer_proposed reason={reason}`.
   - INSERT `custody_transfer_proposed` con case_id, payload (from_organization_id, to_organization_id, reason, notes, proposed_at).
   - Notification al receiver org coordinators (capability `org.transfer.accept`): "Propuesta de transferencia entrante para {pet.name}".

#### 12.4 Avance — sin transitions intermedias

Phase única hasta resolución. Puede haber `note_added` events (sender/receiver commenta) sin cambiar phase.

#### 12.5 Cierre

**Auto (cron):**

| Cron | Schedule | Condición | Event | closed_reason |
|---|---|---|---|---|
| `/api/cron/expire-cross-org-transfers` | diario 04:00 UTC | open + opened_at < now() - 30d | `note_added(category='system', text='Transfer expired without response')` | `auto_expired` |

**Manual:**

- Accept (receiver): emite `custody_transferred` → cierra case con `closed_reason='resolved'`.
- Reject (receiver): emite `note_added(category='rejection', text=motivo)` → cierra case con `closed_reason='cancelled'`.
- Cancel (sender): emite `note_added(category='cancellation', text=motivo)` → cierra case con `closed_reason='cancelled'`.

**Side effects del accept:**

1. INSERT `custody_transferred` con payload (from_organization_id, to_organization_id, from_role='shelter_custody', to_role='shelter_custody', reason, related_proposal_event_id).
2. UPDATE `ownerships` de sender: `endedAt=now()`.
3. INSERT `ownerships` para receiver: role='shelter_custody', started_at=now().
4. Notification al sender ("Tu propuesta fue aceptada por {receiver.name}").
5. Notification al receiver org members (confirmation).
6. Cierre del case del sender's `custody_episode` (cascade del attachment spec — el sender deja de tener custody, su custody_episode case se cierra).
7. Apertura del receiver's `custody_episode` (cascade — el receiver ahora tiene shelter_custody, se abre case nuevo en su scope).

#### 12.6 Reapertura: NO (L4).

#### 12.7 Normativas aplicables: ninguna específica. Tenencia transferred es decisión privada inter-organizacional.

#### 12.8 Visibility tweaks

| Relation | case_meta | events | actors_list | normatives | attachments |
|---|---|---|---|---|---|
| sender org members (capability `org.transfer.propose` o `org.transfer.accept`) | ✅ | full | full | — | ✅ |
| receiver org members (capability `org.transfer.accept`) | ✅ | full | full | — | ✅ |
| subject_owner (caso edge: pet tiene foster individual además de shelter_custody) | meta-only (sabe que se está transfiriendo) | redacted | reducido | — | — |
| govt_in_scope | meta-only (visible en analytics aggregadas, no individual) | ❌ | ❌ | — | ❌ |
| admin | ✅ | full | full | — | ✅ |
| anon | ❌ | ❌ | ❌ | ❌ | ❌ |

#### 12.9 Notifications matrix

| Evento | Destinatario | Severity | Template id |
|---|---|---|---|
| Case open / proposal | receiver coordinators | `info` | `cross_org_transfer_proposed_receiver` |
| Case open / proposal | sender (confirmation) | `info` | `cross_org_transfer_proposed_sender` |
| Accept | sender | `success` | `cross_org_transfer_accepted_sender` |
| Accept | receiver (confirmation) | `success` | `cross_org_transfer_accepted_receiver` |
| Reject | sender | `info` | `cross_org_transfer_rejected_sender` |
| Cancel by sender | receiver | `info` | `cross_org_transfer_cancelled_receiver` |
| Auto-expired | sender + receiver | `warning` | `cross_org_transfer_expired_*` |

#### 12.10 Decisiones específicas: heredadas de §2 acá (CT1-CT11).

#### 12.11 Open questions específicas

- **Receiver visualiza la libreta pre-accept** — hoy hay split: pre-accept solo metadata, post-accept full. ¿Qué exacto es "metadata" en términos de libreta? Tendencia: visible al receiver pre-accept — species, sex, age, breed, primary photo, summary de eventos (count de vaccines, last vet visit date, presence of medical conditions), pero NO los detalles individuales. Post-accept: full libreta. UX detail.
- **Sender cierra mid-handshake con outgoing reason** — sender quiere cancelar pero "por motivo X" (e.g., decidieron quedársela). ¿La notif al receiver debería ser pública o reservada? Tendencia: el motivo se pasa, pero curado.

---

## 5. UX — Sender side

### 5.1 Entry point

`/org/[orgToken]/transferencias/nueva?petToken=...` (route nueva si no existe).

Alternativa: desde `/org/[orgToken]/mascotas/[petToken]` → action "Transferir a otra organización" en el menu de acciones del refugio.

### 5.2 Form

```
Transferir {pet.name} a otra organización

[Organización destinataria] combobox + search
  - Filtros: org_type IN ('shelter', 'rescue_network', 'clinic') + verified=true
  - Sort: orgs en mi misma jurisdicción primero
  - Resultado muestra: nombre + jurisdicción + count de pets actuales + verified badge

[Motivo de la transferencia] select obligatorio
  ( ) Falta de espacio
  ( ) Especialización requerida (caso médico, comportamiento)
  ( ) Redistribución en network
  ( ) Cierre operativo del refugio
  ( ) Devolución post-adopción fallida
  ( ) Otro motivo

[Notas adicionales] textarea
  (requerido si motivo='other'; opcional si no)

[Mensaje al receiver] textarea
  (visible al receiver al recibir la propuesta — context para que evalúe)

⚠ La propuesta expira en 30 días si no recibe respuesta del destinatario.
   La pet sigue bajo tu custodia hasta que la organización destinataria acepte.

[Enviar propuesta]
```

### 5.3 Estado en `/org/[orgToken]/transferencias`

Tabla con todas las transferencias del sender (out):

| Pet | Destinatario | Motivo | Status | Días restantes |
|---|---|---|---|---|
| Roco | Refugio Patitas | Falta de espacio | Esperando respuesta | 12 días |
| Luna | Belgrano Animales | Especialización | Aceptada (2024-05-10) | — |
| Manchas | El Campito | Cierre operativo | Cancelada por receptor | — |

Click en row → case detail `/casos/[publicCode]`.

Cada pending row tiene action "Cancelar propuesta".

### 5.4 Cancel form

```
Cancelar propuesta de transferencia de {pet.name} a {receiver.name}

¿Por qué cancelás?
  ( ) Cambiamos de decisión — la pet sigue con nosotros
  ( ) Encontramos otro destinatario mejor
  ( ) Comunicación con el receptor falló
  ( ) Otro

[Mensaje al receptor] textarea opcional

⚠ Al cancelar, el receptor recibirá notificación con tu mensaje.

[Cancelar propuesta]
```

---

## 6. UX — Receiver side

### 6.1 Inbox de propuestas

`/org/[orgToken]/transferencias/recibidas` (route nueva).

Lista de propuestas entrantes:

| Pet | Origen | Motivo | Mensaje | Días restantes | Acciones |
|---|---|---|---|---|---|
| Roco (perro, macho, ~4) | Refugio Belgrano | Falta de espacio | "Buscamos un hogar especializado..." | 27 días | [Ver detalle] [Aceptar] [Rechazar] |

Click "Ver detalle" → `/org/[orgToken]/transferencias/recibidas/[publicCode]`:

```
Propuesta de transferencia entrante

Pet: {pet.name}
  [pet primary photo, max 200px]
  Species: {species}, Sex: {sex}, Edad: ~{age}, Raza: {breed}
  Microchip: {microchip_id si tiene}

Estado actual:
  - Vacunas: {vaccines_summary} ✓/⚠
  - Esterilización: {sterilization_status}
  - Salud: {health_summary curado}
  - Necesidades especiales: {permanent_conditions si hay}

Origen:
  {sender_org.name} ({sender.jurisdiction})
  Motivo: {reason_label}
  Notas: {sender_notes}
  Mensaje: {sender_message}
  Coordinador a contactar: {sender_admin.name + contact} (vía notif sólo, no se expone teléfono)

⚠ Si aceptás, la pet pasa formalmente a tu custodia. Tendrás acceso completo
   a su libreta sanitaria, podrás emitir eventos clínicos, y aparecerás como
   org responsable en su credencial pública (si así está configurado).

[Aceptar transferencia] [Rechazar transferencia] [Pedir más info]
```

### 6.2 Accept action

Click "Aceptar transferencia" → confirmación modal:

```
¿Confirmás que aceptás la custodia de {pet.name}?

Esta acción:
- Transfiere oficialmente la custodia desde {sender.name} a {receiver.name}.
- Te dará acceso completo a la libreta sanitaria histórica.
- Cierra el case del sender's custody.
- Abre tu propio case de custody para esta pet.

[Confirmar y aceptar] [Cancelar]
```

Server action `acceptCrossOrgTransferAction`:

1. Verificar receiver user con capability `org.transfer.accept`.
2. Verificar case sigue `proposed_awaiting_acceptance` (no expiró, no fue cancelado mid).
3. TX atómica (todo o nada):
   - INSERT `custody_transferred` con case_id + payload.
   - UPDATE old `ownerships` row del sender (endedAt=now()).
   - INSERT new `ownerships` row del receiver (role='shelter_custody', started_at=now()).
   - Cierre del case del sender's `custody_episode` (cascade del cases system).
   - Apertura del receiver's `custody_episode` (cascade).
   - Cierre del `custody_transfer_handshake` case (closed_reason='resolved').
4. Notif al sender (success).
5. Notif al receiver (success confirmation).
6. Redirect a `/org/[orgToken]/mascotas/[petToken]` (la pet ya es del receiver).

### 6.3 Reject action

Click "Rechazar" → form opcional con motivo:

```
Rechazar propuesta de {sender.name} para {pet.name}

¿Por qué rechazás?
  ( ) Falta de espacio actualmente
  ( ) No tenemos especialización para este caso
  ( ) Documentación insuficiente
  ( ) Otro motivo (especificar abajo)

[Mensaje al sender] textarea
  (opcional pero recomendado)

[Rechazar propuesta]
```

Server action `rejectCrossOrgTransferAction`:

1. INSERT `note_added(category='rejection', text=motivo + message)` con case_id.
2. UPDATE case status='closed', closed_reason='cancelled'.
3. Notif al sender con copy curada.

### 6.4 Pedir más info action (defer v1.1)

Click "Pedir más info" → comments thread sobre el case. Sender ve, responde. Defer — v1 usa el `notes` y messaging fuera del sistema. Si demanda real existe, agregar v1.1 con `note_added` thread visualizado como conversación.

---

## 7. Audit + analytics

- Cada transición del case se loguea en audit_log (igual que welfare denuncias). Acciones: `cross_org_transfer_proposed`, `cross_org_transfer_accepted`, `cross_org_transfer_rejected`, `cross_org_transfer_cancelled_by_sender`, `cross_org_transfer_auto_expired`.
- Govt dashboards futuros pueden agregar `/gob/transfers` con counts por motivo, network mapping (sender→receiver patterns), promedio de tiempo accept.
- KPIs útiles para refugios: pct de proposals que aceptan, tiempo promedio de respuesta, motivos más comunes.

---

## 8. Tests

```ts
// __tests__/cross-org-transfer-flow.test.ts
it('sender propone → case open + notif al receiver');
it('sender sin capability NO puede proponer');
it('sender sin shelter_custody activo NO puede proponer');
it('NO permite proposal si ya hay handshake open sobre la pet');
it('NO permite proposal si pet tiene custody_dispute');
it('receiver acepta → custody_transferred emitted + ownerships flipped atómicamente');
it('receiver rechaza → case cerrado, sender notified, ownerships NO cambian');
it('sender cancela mid-handshake → case cerrado, receiver notified');
it('cron expire 30d → case cerrado auto_expired + ambos notified');
it('accept después de cancellation del sender → falla con error');

// __tests__/cross-org-transfer-cascade.test.ts
it('accept cascade-cierra el custody_episode del sender');
it('accept cascade-abre custody_episode del receiver');
```

---

## 9. Open questions

- **Transferencias inter-jurisdicción** — refugio en CABA transfiere a uno en Mendoza. ¿Hay implicancias legales por movimiento de animales entre provincias? (SENASA tiene normas de transporte para algunas especies/condiciones.) Defer — el spec actual no bloquea, asume cumplimiento operativo del refugio.
- **Visibility de la libreta pre-accept** — el §6.1 muestra "Estado actual" summary; el detalle exacto a mostrar (cuántos eventos de cada tipo, etc.) lo define UX final cuando se construya.
- **Bulk transfer UX** — CT8 lo defiere. Posibles UX: queue de proposals "draft" + "send all" action. Mantengamos chico en v1.
- **Auto-acceptance para verified rescue networks con trust history** — si dos orgs tienen N transfers exitosos pasados, ¿UI sugiere "trust this org for future transfers"? Defer.
- **Mid-handshake edits**: CT7 dice bloquear edits del pet pre-accept. ¿Qué edits exactly bloqueamos? Tendencia: bloquear cambios estructurales (microchip, primary photo) — permitir cosmetic (favourite_foods, training_level). Detail al implementar.

---

## 10. Out of scope

- Transferencia parcial (un set de pets sí, otro no) — cada pet su caso.
- Pago / valor monetario asociado al transfer — fuera de scope.
- Garantía contractual de "el receiver mantendrá custodia por X tiempo mínimo" — fuera de scope, decisión inter-org externa.
- Transferencias a/desde govt (decomiso → refugio) — esto es scope del spec `2026-05-19-decomiso-welfare-authority-design.md` (item #4 de este batch). Cross-org de este spec es solo entre orgs civiles (refugio→refugio, refugio→clinic, etc.).

---

## 11. Implementation outline (para plan ejecutable post-OK)

1. **Fase 1** — Mover `custody_transfer_handshake` al subset v1 + addendum lifecycles spec. ~½ día.
2. **Fase 2** — Server actions `proposeCrossOrgTransferAction`, `acceptCrossOrgTransferAction`, `rejectCrossOrgTransferAction`, `cancelCrossOrgTransferAction`. ~1 día.
3. **Fase 3** — Cron `/api/cron/expire-cross-org-transfers`. ~½ día.
4. **Fase 4** — Pages: `/org/[orgToken]/transferencias/nueva`, `/org/[orgToken]/transferencias`, `/org/[orgToken]/transferencias/recibidas`, detalle. ~2 días.
5. **Fase 5** — Notifications templates + capability gates. ~½ día.
6. **Fase 6** — Tests. ~1 día.

Total ~5 días. Depende de sistema de casos estar implementado primero.
