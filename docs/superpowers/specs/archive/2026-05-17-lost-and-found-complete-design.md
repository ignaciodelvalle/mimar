# Lost & Found completo — design spec

> Cierra el loop de reunión perdida↔encontrada en DIM. Cinco features integradas que se construyen juntas porque dependen entre sí: microchip cross-check al intake, devolución refugio→dueño con two-phase handshake y auto-cancel lazy, broadcast a refugios cuando un pet se marca como perdido, **owner controla qué información expone en la credencial pública**, y **flujo enriquecido de descripción para pets sin chip**. Reusa entidades existentes (`custody_transfer_proposed` / `custody_transferred` events ya en `EVENT_TYPES`, `organization_coverage` ya implementado, `shelter_custody` role ya enforcado). Auto-contenido; el plan de implementación va aparte.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.1 — owner-controlled disclosure, unchipped pet enrichment, auto-cancel de proposals stale. Reemplaza v1.0.

---

## 1. Por qué este documento existe

DIM hoy tiene **la mitad del loop construida** pero falta lo que cierra el círculo:

- Dueño marca pet como perdida → ✓ funciona (`/perdida`, evento `status_changed → lost`)
- Credencial pública muestra estado lost → ✓ Tier 1 reveal (pero hardcoded — sin control del owner)
- Finder anónimo notifica al dueño → ✓ (`FoundPetForm` → `Notification` urgente)
- Dueño marca como encontrada → ✓ (`setPetFoundAction`)
- Refugio toma intake → ✓ (`/org/[orgToken]/intake`, `shelter_custody` ownership)
- Vecino con mascota en tránsito → ✓ (`acquisitionMethod='found_stray'`)

Lo que **falta**, y sin lo cual el sistema no honra su promesa central de microchip y reunión:

🔴 **Microchip cross-check al intake.** El refugio o vecino que registra un stray con chip NO chequea si ese chip ya está en DIM. Crea un pet duplicado en silencio. El owner queda con su pet marcada `lost` para siempre.

🔴 **Devolución refugio→owner.** Si el refugio se da cuenta manualmente que el animal es de alguien, no hay UI para devolverlo. El `custody_transferred` event existe en `EVENT_TYPES` pero no tiene flow cliente.

🔴 **Broadcast on lost.** Marcar pet perdida no notifica a refugios en la jurisdicción. Es 100% pull-from-finder. Refugios que tienen `organization_coverage` declarada en el barrio del pet **no se enteran**.

🟡 **Owner no controla disclosure.** Hoy el Tier 1 expone teléfono automáticamente si está cargado. El owner no puede elegir granularmente qué mostrar — y el espectro de qué quiere exponer varía: algunos quieren teléfono, otros prefieren email, otros solo el form de finder.

🟡 **Pets sin chip son ciegas en el broadcast.** Sin chip y sin descripción rica, un voluntario de refugio que ve un pet en la calle no puede matchearlo contra el broadcast. Necesitamos capturar más detalle identificatorio cuando se marca perdida.

Este doc cierra los cinco huecos como un feature único porque están interdependientes: el cross-check te lleva al match, el match dispara el flow de devolución (con auto-cancel si el contexto cambia), el broadcast pre-posiciona refugios para que sean los que hacen el match, las disclosure preferences gobiernan qué ven todos los que llegan a la credencial pública (incluido el refugio que recibe broadcast), y la descripción rica hace que pets sin chip sean identificables. Un solo loop.

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | **Cross-check obligatorio al intake** si el chip viene cargado. Sin opción "skip" | Si tenés el dato del chip, no chequear es bug. La fricción de chequear es cero (un SQL). El bug de duplicar pets cuando había match es alto |
| D2 | **Match handling por status del pet existente.** `lost` → BLOCK + open match flow. `active` → WARN (puede ser legitimate re-chipping). `deceased` → BLOCK + require admin review | Cada status tiene un significado distinto y merece tratamiento distinto. `deceased` con chip nuevo es suspechoso → admin |
| D3 | **Devolución refugio→owner = two-phase handshake**: refugio propone vía `custody_transfer_proposed` event, owner acepta vía UI, ejecuta `custody_transferred` | Reusa el patrón ya implementado para org-to-org transfers. Two-phase porque la devolución es alta confianza |
| D4 | **Broadcast on lost = notification fanout a refugios cuya `organization_coverage` matchea la jurisdicción del pet.** Solo verified refugios. Severity `warning`, no `urgent` | Verified = `organizations.verified=true`. Matching por jurisdicción exacta. Warning porque el orgs reciben muchos signals |
| D5 | **Owner controla qué expone en la credencial pública** vía disclosure preferences (per-field toggles). El broadcast notification a refugios linkea a la credencial pública — los refugios ven exactamente lo que el owner decidió exponer, ni más ni menos | Refleja la realidad: profesionales que ya interactúan con la mascota tienen contacto offline. Los demás ven lo que el owner explícitamente quiso compartir. Una sola fuente de verdad ("la credencial pública") con un solo gating ("qué quiso el owner") — sin lógica de "audiencia privilegiada vs anónima" |
| D6 | **El "vecino" también participa del cross-check.** Cuando alguien crea pet con `acquisitionMethod='found_stray'` Y `microchipId` set, mismo flow que el refugio | Coherencia: cualquier intake-style flow chequea el chip |
| D7 | **El match flow crea un `shelter_custody` paralelo al `owner` ownership existente.** Mientras se coordina la devolución, AMBOS records están activos | Es la realidad — alguien tiene físicamente al animal mientras el owner viene a buscarlo. El esquema ya soporta múltiples ownerships con la regla "máximo un `owner` activo, pero múltiples `shelter_custody`/`foster` pueden coexistir" |
| D8 | **El broadcast es defensive**: si falla por cualquier razón, el `setPetLostAction` igual termina exitosamente | Marcar perdido NUNCA se bloquea por error de broadcast |
| D9 | **Pets sin chip activan un flujo enriquecido al marcar como perdidas.** El form se expande para capturar descripción identificatoria (foto, color, marcas, accesorios al momento, comportamiento, última actividad). Algunos campos actualizan el `pets` row directamente; otros viven en el payload del lost event como snapshot | Sin chip + sin descripción rica, el broadcast es inservible — nadie puede matchear lo que no puede describir. Aprovechamos el momento ansiogénico del "se me perdió" para extraer info que mejora identificabilidad |
| D10 | **Auto-cancel lazy de proposals stale.** Cuando el owner clickea aceptar y los preconditions ya no se cumplen (pet found por otra vía, custody ya transferida, etc.), el server auto-cancela el proposal con notification clara al actor | Más simple que triggers DB. El proposal pendiente que ya no aplica se cierra al primer touch. Si el owner no responde nunca, queda pending — y el actor puede cancelar manualmente. Sin sweep job en v1 |
| D11 | **Disclosure preferences viven en `pets` (no en event payload).** Cinco columnas booleanas explícitas (per-field opt-in/opt-out), editables en cualquier momento mientras la mascota esté perdida | El owner puede arrepentirse y cambiar exposure sin tener que marcar found + lost de nuevo. Editar booleans en la table es trivial; chasing event-level snapshots para "el state actual" es ruido |

## 3. Glosario

| Término | Qué es |
|---|---|
| **Cross-check** | Lookup automático del chip number contra `pets` al intake |
| **Match flow** | Flow que el cross-check abre cuando encuentra un pet existente |
| **Reunion** | Proceso de devolver un pet desde shelter_custody al owner original |
| **Broadcast** | Notification fanout a refugios verified cuya `organization_coverage` matchea la jurisdicción del pet |
| **Two-phase handshake** | Patrón en dos pasos: propose → accept → execute, con auto-cancel si stale |
| **Disclosure preferences** | Per-field booleans en `pets` que el owner controla — qué info aparece en la credencial pública cuando está perdida |
| **Enriched lost flow** | Flow extendido cuando el pet no tiene chip: captura descripción rica para que el broadcast sirva |

## 4. Domain model

### 4.1 Lo que ya existe (no se toca)

- `custody_transfer_proposed` y `custody_transferred` están en `EVENT_TYPES` (agregados por el org portal plan)
- `organization_coverage` table con `(organization_id, province, locality, is_primary)`
- `organizations.verified`
- `Ownership` polimórfica con `owner_user_id | owner_organization_id` XOR
- `Ownership.role` enum incluye `shelter_custody`, `owner`, `foster`, etc.
- `Notification` con severity, related_pet_id, related_event_id
- Múltiples ownerships activas permitidas (1 `owner` máximo, N otras)

### 4.2 Lo nuevo / extender

**Disclosure preferences en `pets`:**

```sql
alter table pets
  add column disclose_first_name_when_lost   boolean not null default true,
  add column disclose_phone_when_lost        boolean not null default true,
  add column disclose_email_when_lost        boolean not null default false,
  add column disclose_last_location_when_lost boolean not null default true,
  add column allow_finder_form_when_lost     boolean not null default true;
```

Defaults reflejan el comportamiento actual aproximado de la credencial pública (Tier 1 hoy expone primer nombre + teléfono + última ubicación, no email, y el finder form siempre está). Owners que quieran restringir se mueven por opt-out. Owners que quieran abrir email se mueven por opt-in.

**Sin migración de data existente** — todas las filas de `pets` arrancan con los defaults. La credencial pública v1.1 lee estas columnas en lugar de hardcodear el Tier 1.

**Index sobre `pets.microchip_id`** (defensive, si no existe ya por el unique constraint):

```sql
create index if not exists pets_microchip_lookup_idx
  on pets (microchip_id)
  where microchip_id is not null;
```

**Extender Zod schema de `custody_transfer_proposed`** para soportar `to_user_id` (devolución a citizen). Verificar el shape actual en `lib/event-schemas.ts` y agregar:

```ts
const custodyTransferProposed = z
  .object(
    withVersion({
      from_user_id: z.string().uuid().nullable(),
      from_organization_id: z.string().uuid().nullable(),
      to_user_id: z.string().uuid().nullable(),         // NEW
      to_organization_id: z.string().uuid().nullable(),
      reason: z.enum([
        "org_to_org_handoff",
        "return_to_original_owner",                     // NEW
        "citizen_to_org_handoff",
        "other",
      ]),
      notes: z.string().nullable(),
      matched_against_pet_id: z.string().uuid().nullable(), // NEW — links to the matched pet
    }),
  )
  .strict()
  .refine(
    (p) => (p.to_user_id !== null) !== (p.to_organization_id !== null),
    { message: "exactly one of to_user_id / to_organization_id must be set" },
  );
```

Mismo refactor para `custody_transferred`.

**Extender Zod schema de `status_changed`** para incluir disclosure prefs snapshot en el lost transition + enriched fields:

```ts
const statusChanged = z
  .object(
    withVersion({
      from_status: petStatus,
      to_status: petStatus,
      location_description: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
      // NEW: snapshot of disclosure prefs at the moment of marking lost.
      // Captured in the event for historical audit ("what was exposed when X
      // was marked lost"). Source of truth for current state lives on `pets`.
      disclosure_prefs_snapshot: z
        .object({
          first_name: z.boolean(),
          phone: z.boolean(),
          email: z.boolean(),
          last_location: z.boolean(),
          finder_form: z.boolean(),
        })
        .optional(),
      // NEW: enriched description fields captured at the moment of marking
      // lost (for unchipped pets). Optional — only present when the owner
      // filled them in.
      lost_description: z
        .object({
          accessories_when_lost: z.string().nullable(),
          behavior_notes: z.string().nullable(),
          last_seen_context: z.string().nullable(),
        })
        .nullable()
        .optional(),
    }),
  )
  .strict();
```

**Nuevos `notification_type` values** (TEXT, sin migración):

- `lost_pet_broadcast` → al member de refugio en la jurisdicción
- `chip_match_notification_owner` → al owner cuando un refugio/vecino detectó match vía chip
- `custody_transfer_proposal_owner` → al owner cuando refugio/vecino propone devolver
- `custody_transfer_accepted_owner_side` → al actor cuando el owner acepta la devolución
- `custody_transfer_auto_cancelled` → al actor cuando un proposal se cancela automáticamente por stale state

## 5. Feature 1: Microchip cross-check

### 5.1 Cuándo se dispara

Al submit de:
- `createIntakeAction` (refugio en `/org/[orgToken]/intake`) cuando `microchipId` se cargó
- `createPetAction` (`/mis-mascotas/nueva`) cuando `acquisitionMethod='found_stray'` Y `microchipId` se cargó

**No se dispara** en:
- Registro normal de pet propio (no es lost-found)
- Form sin chip cargado

### 5.2 Lookup logic

```ts
// Inside the server action, BEFORE the new pet insert:

if (parsed.microchipId) {
  const [existingMatch] = await db
    .select({
      pet: pets,
      activeOwnership: ownerships,
      ownerProfile: profiles,
    })
    .from(pets)
    .leftJoin(
      ownerships,
      and(eq(ownerships.petId, pets.id), isNull(ownerships.endedAt), eq(ownerships.role, "owner")),
    )
    .leftJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(eq(pets.microchipId, parsed.microchipId))
    .limit(1);

  if (existingMatch) {
    return handleChipMatch(existingMatch, parsed, actor);
  }
}

// No match — normal flow proceeds
```

### 5.3 Match handling por status

```ts
function handleChipMatch(match, parsed, actor) {
  const { pet, ownerProfile } = match;

  if (pet.status === "lost") {
    // BLOCK + redirect to match-confirmation flow
    redirect(`/org/[orgToken]/intake/match/${pet.publicToken}` /* or vecino path */);
  }

  if (pet.status === "active") {
    // WARN — owner may be re-chipping, or this is duplicate. Allow override.
    return {
      error: null,
      warning: {
        kind: "chip_active_match",
        message: `El chip ${parsed.microchipId} ya está registrado en DIM bajo otra mascota. Si esta es la misma, contactá al dueño antes de continuar.`,
        existing_pet_token: pet.publicToken,
        existing_owner_first_name: ownerProfile?.displayName?.split(" ")[0] ?? null,
        force_create_token: generateConfirmationToken(parsed),  // expires in 15min
      },
    };
  }

  if (pet.status === "deceased") {
    return {
      error: `Este chip está asociado a una mascota registrada como fallecida en DIM. Pedile a un admin que revise el caso.`,
    };
  }
}
```

### 5.4 Match confirmation flow

Ruta compartida refugio/vecino con el pet existente mostrado:

```
Header: "Posible coincidencia detectada"

Card con info del pet existente (la misma que renderiza la credencial pública,
respetando las disclosure preferences del owner — ver §7):
  - Foto (si tiene)
  - Nombre, especie, sexo, raza, color, distinguishing features
  - Microchip: {chip} (matched)
  - Status: Perdida desde {fecha}
  - Última ubicación conocida (si el owner la expone)
  - Dueño: {first name si lo expone}
  - Contacto (teléfono / email / form) según las prefs del owner

Dos botones grandes:
  [Es la misma mascota] — primary, verde
  [No es la misma]      — secondary, ámbar
```

**Si "Es la misma mascota"** → `confirmChipMatchAction`:

```
Atomic transaction:
  1. NO crea nuevo pet. El existente sigue siendo la verdad.
  2. Crea Ownership nuevo para el actor (refugio o vecino):
     pet_id = existingPet.id
     owner_organization_id = actor.org.id (refugio)  OR
     owner_user_id = actor.user.id (vecino)
     role = 'shelter_custody'
     started_at = now()
  3. Emite shelter_intake_recorded event con context del match
  4. Inserta Notification al original owner:
     - type='chip_match_notification_owner'
     - severity='urgent'
     - title="Te encontraron a {pet.name}"
     - body builds from actor name + (refugio name if org, 'un vecino' if user)
     - cta_label="Coordinar devolución"
     - cta_url=/mis-mascotas/{token}/devolucion
  5. pet.status sigue 'lost' — el owner es quien confirma found cuando lo
     recibe físicamente
Commit.
```

**Si "No es la misma"** → server requiere `force_create_token` explícito y procede con la intake normal (crea duplicado por chip number). El override queda en audit.

## 6. Feature 2: Devolución refugio→owner + auto-cancel

### 6.1 Punto de entrada

Después del match flow (§5.4), el actor tiene `shelter_custody` paralela. El owner ya recibió notification.

**Path A — Refugio inicia.** Refugio abre `/org/[orgToken]/mascotas/{petToken}` → "Devolver al dueño original" → form con motivo + notas → submit → `proposeReturnToOwnerAction`.

**Path B — Owner inicia coordinación.** Owner abre la notification → CTA → `/mis-mascotas/{token}/devolucion`. Si todavía no hay proposal, el owner ve "Esperando que {actor} la marque lista". Si hay proposal, ve los botones de aceptar/rechazar.

### 6.2 Phase 1 — Propose (refugio o vecino)

```
proposeReturnToOwnerAction(publicToken, notes):
  Atomic transaction:
    1. requireCapability('custody.transfer') OR vecino con shelter_custody activa
    2. Verificar Ownership activa role='shelter_custody' del actor sobre este pet
    3. Verificar Ownership activa role='owner' de otra persona (el dueño original)
    4. Verificar que NO existe proposal pendiente del mismo actor sobre este pet
       (anti-doble-proposal)
    5. Insertar event custody_transfer_proposed:
       payload: {
         from_user_id?: actor.user.id (vecino),
         from_organization_id?: actor.org.id (refugio),
         to_user_id: original_owner.id,
         to_organization_id: null,
         reason: 'return_to_original_owner',
         notes,
         matched_against_pet_id: pet.id,
       }
    6. Insertar Notification al original_owner:
       - type='custody_transfer_proposal_owner'
       - severity='urgent'
       - title="Devolución propuesta de {pet.name}"
       - body="{actor name} está listo para devolverte a {pet.name}.
              Confirmá cuando la tengas físicamente."
       - cta_url=/mis-mascotas/{token}/devolucion
  Commit.
```

### 6.3 Phase 2 — Accept (owner) + lazy auto-cancel

```
ownerAcceptReturnAction(publicToken):
  Atomic transaction:
    1. requireOwnedPetByToken(publicToken) — session user is active owner
    2. Buscar último custody_transfer_proposed del pet con to_user_id=session.user.id
       que no tenga custody_transferred posterior cerrandolo
    3. Validar PRECONDITIONS del proposal contra el state actual:
       a. El actor (from_user_id / from_organization_id) sigue teniendo
          shelter_custody activa sobre el pet
       b. El pet sigue siendo del owner (no transferido a otro mientras tanto)
       c. El pet no está deceased
       d. No hay otro custody_transferred POSTERIOR al proposal que ya lo
          haya cerrado (idempotency)
       e. El owner del proposal (to_user_id) sigue activo
       Si CUALQUIERA falla → AUTO-CANCEL:
         · Insertar note_added event con category='custody_transfer_proposal_auto_cancelled',
           payload {proposal_event_id, reason: 'precondition_failed:{which}'}
         · Notification al actor type='custody_transfer_auto_cancelled' con razón
         · Retornar al owner con mensaje claro: "Esta propuesta ya no es válida
           porque {razón legible}. {Acción sugerida}."
         · NO crear custody_transferred
    4. Si preconditions OK:
       · Crear event custody_transferred con payload completo
         (referenciando proposal_event_id)
       · End the active shelter_custody Ownership (ended_at = now)
       · pet.status flip 'lost' → 'active' si era 'lost'
       · Insertar Notification al actor type='custody_transfer_accepted_owner_side'
  Commit.
```

### 6.4 Cancellation paths

**Owner rechaza explícitamente** (raro): `ownerRejectReturnAction` con motivo. Inserta `note_added` con category='custody_transfer_rejected' + reason. Notifica al actor. El shelter_custody sigue activo.

**Actor cancela su propio proposal** antes del accept: `actorCancelProposalAction`. Similar.

**Auto-cancel lazy** (descripto arriba): solo dispara cuando el owner intenta aceptar y el estado actual lo invalida. Sin sweep job en v1.

### 6.5 Trampas conocidas con auto-cancel lazy

- **Notifications zombies**: el actor podría tener notification "tu proposal fue aceptado" pendiente que ya no aplica (porque pasó otra cosa entre medio). Mitigación: la notification text es declarativa del momento ("X aceptó"), no instructiva ("hacé Y"). Si el state cambió, el actor lo descubre cuando intenta operar.
- **Proposal queda pending para siempre**: si el owner nunca toca el CTA, el proposal queda pending. Aceptable en v1. Long term: cron job que cierra proposals con >90 días pending con notificación a ambas partes.

## 7. Feature 3: Owner disclosure preferences

### 7.1 Qué controla

Cinco campos en `pets` que el owner setea (default values en §4.2). Cada uno aparece o no en la credencial pública cuando el pet está perdida:

| Campo `pets.*` | Qué expone en Tier 1 | Default |
|---|---|---|
| `disclose_first_name_when_lost` | Primer nombre del dueño | `true` |
| `disclose_phone_when_lost` | Teléfono (`profiles.phone`) con botón `tel:` | `true` |
| `disclose_email_when_lost` | Email (`auth.users.email`) con `mailto:` | `false` |
| `disclose_last_location_when_lost` | Última ubicación conocida del último `status_changed → lost` event | `true` |
| `allow_finder_form_when_lost` | El `FoundPetForm` está disponible o no | `true` |

**Independencia entre campos.** Owner que quiera "solo email + form" puede setear phone=false, email=true, finder_form=true. Owner que prefiere "anonimato máximo" deja todos en false (la credencial pública muestra solo nombre del pet + foto + status='lost'). Owner full-open deja todos true.

### 7.2 Dónde se configura

**Al marcar como perdida** — el form `/perdida` se extiende con una sección "¿Qué info querés que vean quienes la encuentren?". Checkboxes con los cinco campos y descripción corta de cada uno. Defaults pre-marcados según las prefs actuales del pet (que arrancan en los defaults de §4.2).

**Después, en cualquier momento** — `/mis-mascotas/{token}/editar` (o pestaña dedicada `/mis-mascotas/{token}/credencial`) tiene la misma sección, editable mientras la pet esté lost. Cambios en estos toggles son edits del pet row, **no generan event** (son preferences de UI, no facts médicos — análogo a `emergencyInfoVisible` que ya tiene el patrón).

### 7.3 Cómo se renderiza en la credencial pública

`/p/[publicToken]/page.tsx` cuando `pet.status='lost'`:

```tsx
{pet.disclose_first_name_when_lost && lostContext?.ownerFirstName && (
  <p>Dueño: {lostContext.ownerFirstName}</p>
)}

{pet.disclose_phone_when_lost && lostContext?.phone && (
  <a href={`tel:${lostContext.phone}`}>📞 Llamar al dueño · {lostContext.phone}</a>
)}

{pet.disclose_email_when_lost && lostContext?.email && (
  <a href={`mailto:${lostContext.email}`}>✉️ {lostContext.email}</a>
)}

{pet.disclose_last_location_when_lost && lostContext?.locationText && (
  <p>Última ubicación: {lostContext.locationText}</p>
)}

{pet.allow_finder_form_when_lost && (
  <FoundPetForm publicToken={publicToken} />
)}
```

Si **ninguno** está activo, la credencial muestra el banner "Esta mascota está perdida" + foto + datos básicos del pet, pero sin canales de contacto. Edge case pero válido — algunos owners querrán solo el badge visual sin ser contactables públicamente (probablemente coordinan vía redes sociales).

### 7.4 Snapshot en el event

El `status_changed → lost` event payload guarda `disclosure_prefs_snapshot` con los valores al momento de marcar perdida (§4.2). Esto es **audit-friendly**: si el owner cambia las prefs después y vuelve a marcar, queda historial. La verdad **operacional** sigue en `pets` row — el credencial pública lee de ahí, no del payload.

## 8. Feature 4: Enriched description for unchipped pets

### 8.1 Cuándo se dispara

Al submit de `/perdida`, si `pet.microchipId IS NULL`, el form **se expande** con una sección extra antes del submit final: "Tu mascota no tiene microchip cargado. Para ayudar a quien la encuentre, completá la mayor cantidad de info posible:"

### 8.2 Campos del flujo enriquecido

Tres grupos:

**(a) Identidad permanente** (actualizan `pets` row, persisten):

- **Foto principal** — si `pet.primaryPhotoId IS NULL`, file upload requerido (o muy fuertemente sugerido). Si ya hay foto, mostrar la actual con opción "Reemplazar".
- **Color / marcas** — input pre-llenado con `pet.color`, editable. El owner refina (era "marrón" → ahora "marrón con manchas blancas en el pecho").
- **Características distintivas** — input pre-llenado con `pet.distinguishingFeatures`, editable. Texto libre.

**(b) Snapshot incident-específico** (al payload del lost event, no a `pets`):

- **Accesorios al momento de perderse** — text libre. "Collar negro con chapita roja". Si más adelante encuentran un perro sin collar, el contexto importa.
- **Comportamiento / temperamento** — text libre. "Huidiza", "sociable con extraños", "tiene miedo de motos", "responde a su nombre".
- **Último contexto de avistaje** — text libre. "Salió del jardín por la calle Cerviño cuando abrimos el portón", "estaba durmiendo en la cama y desapareció", "se asustó con los fuegos artificiales".

**(c) Updates al pet row** (opcional, low-friction):

- **Cargar microchip ahora** — si el owner se acaba de acordar que tiene chip pero nunca lo cargó. Si lo carga acá, automáticamente se dispara el cross-check (no como block — solo informativo, "si alguien lo lleva a un refugio con este chip, te vamos a contactar").

### 8.3 Cómo se aplica

Server action `setPetLostAction` se extiende:

```ts
// In addition to the existing logic (status_changed event, pet.status='lost'):

if (parsed.lostDescription) {
  const { accessoriesWhenLost, behaviorNotes, lastSeenContext } = parsed.lostDescription;

  // (a) Update pets if owner refined identity fields
  if (parsed.color !== pet.color || parsed.distinguishingFeatures !== pet.distinguishingFeatures) {
    await tx.update(pets).set({
      color: parsed.color,
      distinguishingFeatures: parsed.distinguishingFeatures,
      updatedAt: now,
    }).where(eq(pets.id, pet.id));
  }

  // (b) New photo if uploaded — same flow as createPetAction's photo handling
  if (uploadedPhotoPath) {
    // insert attachment, set as primaryPhotoId
  }

  // (c) Snapshot into the lost event payload
  eventPayload.lost_description = {
    accessories_when_lost: accessoriesWhenLost,
    behavior_notes: behaviorNotes,
    last_seen_context: lastSeenContext,
  };
}
```

### 8.4 Cómo se renderiza en la credencial pública

Cuando `pet.status='lost'`, la credencial pública muestra (después del header del pet):

- Foto (siempre)
- Color, marcas, distinguishing features (siempre, son identidad del pet)
- Si hay `lost_description.accessories_when_lost` en el último lost event: "Cuando se perdió, tenía: {text}"
- Si hay `behavior_notes`: "Cómo es: {text}"
- Si hay `last_seen_context`: "Última vez vista: {text}"

Esto es **siempre visible si está cargado** — no hay disclosure pref para esto (son detalles del pet, no contact info del owner).

## 9. Feature 5: Broadcast on lost (simplificado)

### 9.1 Trigger y recipient lookup

Dentro de `setPetLostAction`, después del status_changed event y todo el enrichment de §8, ANTES del commit del transaction:

```ts
try {
  await broadcastLostPet(tx, pet);
} catch (err) {
  console.error("Lost pet broadcast failed:", err);
  // Do NOT throw — marking as lost succeeded regardless (D8)
}
```

Lookup:

```ts
async function broadcastLostPet(tx, pet) {
  const coveringOrgs = await tx
    .select({
      orgId: organizations.id,
      orgName: organizations.displayName,
    })
    .from(organizations)
    .innerJoin(organizationCoverage, eq(organizationCoverage.organizationId, organizations.id))
    .where(
      and(
        eq(organizations.verified, true),
        eq(organizations.status, "active"),
        eq(organizationCoverage.jurisdictionCountry, pet.jurisdictionCountry),
        eq(organizationCoverage.jurisdictionProvince, pet.jurisdictionProvince),
        eq(organizationCoverage.jurisdictionLocality, pet.jurisdictionLocality),
        inArray(organizations.orgType, ["shelter", "rescue_network"]),
      ),
    );

  if (coveringOrgs.length === 0) return;

  for (const org of coveringOrgs) {
    const members = await tx
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, org.orgId),
          eq(organizationMemberships.receivesBroadcasts, true),
          isNull(organizationMemberships.leftAt),
        ),
      );

    for (const member of members) {
      await tx.insert(notifications).values({
        userId: member.userId,
        notificationType: "lost_pet_broadcast",
        severity: "warning",
        title: `Mascota perdida en ${pet.jurisdictionLocality}`,
        body: buildBroadcastBody(pet),
        relatedPetId: pet.id,
        ctaLabel: "Ver credencial",
        ctaUrl: `/p/${pet.publicToken}`,
      });
    }
  }
}
```

### 9.2 Notification body — minimal, link to credencial pública

```ts
function buildBroadcastBody(pet) {
  // The body is intentionally minimal and PII-free. The CTA goes to the public
  // credential, where the owner's disclosure preferences govern what contact
  // info (if any) is visible. The org receiving this broadcast sees the same
  // credential as anyone scanning the QR — no privileged view.

  const parts = [
    `**${pet.name}** — ${speciesLabel(pet.species)}${pet.breed ? `, ${pet.breed}` : ""}.`,
    pet.color ? `Color: ${pet.color}.` : null,
    `Tocá "Ver credencial" para detalles y contacto.`,
  ];
  return parts.filter(Boolean).join("\n");
}
```

Crucial: **el body NO incluye teléfono, email, ni último known location**. Esos viven en la credencial pública y son gobernados por las prefs del owner. El refugio que recibe el broadcast clickea CTA → llega a `/p/{token}` → ve exactamente lo mismo que cualquier persona que escanee el QR.

Esto significa que un mismo refugio:
- Si el owner expuso teléfono: lo ve y puede llamar
- Si el owner expuso solo email: lo ve y puede emailear
- Si el owner solo dejó form de finder: usa el form
- Si el owner cerró todo: ve nombre + foto + status pero no canal de contacto → puede actuar igual (mantener al animal, buscarlo el día siguiente con más data) pero no contactar directo

### 9.3 Performance — sin cambios

Mismo análisis que v1.0: hasta cientos de notifs por lost-mark es OK. Cuando escale, mover a queue async + dedup + rate-limit per member.

## 10. End-to-end happy path

Visualización del loop completo con los 5 features:

```
T+0    Owner abre /mis-mascotas/{token}/perdida
       → form: ubicación + motivo (existing)
       → form expanded: pet sin chip, captura color refinado, marcas,
         accesorios cuando se perdió ("collar negro con chapita roja"),
         comportamiento ("huidiza"), último contexto ("escapó del jardín")
         (NEW §8)
       → form expanded: ¿qué exponer en credencial pública? Owner
         desmarca "email" pero deja teléfono y form de finder activos
         (NEW §7)
       → submit → setPetLostAction
         · status_changed event (existing)
         · pet.disclosure_*_when_lost columns update (NEW)
         · disclosure_prefs_snapshot in event payload (NEW)
         · lost_description in event payload (NEW)
         · pet.color / distinguishingFeatures updated (NEW)
         · broadcast fanout to 3 verified refugios in Belgrano (NEW §9)

T+0.5h Volunteer de "Refugio Belgrano Animales" recibe el broadcast.
       → Ve notification "Mascota perdida en Belgrano · Negrita, perra,
         marrón con manchas blancas"
       → Click "Ver credencial" → /p/{negrita-token}
       → La credencial muestra: foto, Negrita, perra, color refinado,
         dueño Nacho, teléfono (porque está expuesto), última ubicación,
         "tenía collar negro con chapita roja", form de finder activo
       → Email NO se muestra (owner desmarcó esa exposición)

T+2h   Volunteer va a la zona, ve un perro con collar negro y chapita
       roja. Reconoce a Negrita.

T+2.2h Volunteer la lleva al refugio. Coordinator entra a /org/[orgToken]/intake,
       carga el chip de Negrita (que el owner cargó hace meses pero nunca
       lo usamos como criterio principal).
       → cross-check (NEW §5) detecta match: pet.status='lost'
       → BLOCK creación → redirect a /org/[orgToken]/intake/match/{negrita-token}
       → ve a Negrita en pantalla → "Es la misma mascota"
       → confirmChipMatchAction: shelter_custody paralela + Notification al owner

T+2.5h Owner ve la notification, llama al refugio (teléfono está expuesto).
       Coordina pickup.

T+3h   Owner llega al refugio, recibe a Negrita físicamente.
       Refugio coordinator clickea /org/[orgToken]/mascotas/{petToken} → "Devolver al
       dueño original" → proposeReturnToOwnerAction
       → custody_transfer_proposed event con to_user_id=owner
       → Notification al owner

T+3.1h Owner abre /mis-mascotas/{token}/devolucion → clic "Marcar como recibida"
       → ownerAcceptReturnAction
       → PRECONDITIONS check (§6.3): refugio sigue con shelter_custody ✓,
         owner sigue activo ✓, no hay custody_transferred posterior ✓ → OK
       → custody_transferred event
       → shelter_custody del refugio: ended_at=now
       → pet.status flip lost → active
       → Notification al refugio "Nacho confirmó la devolución. Caso cerrado."

T+3.1h Estado final:
       · Negrita.status = active
       · Disclosure preferences se mantienen (siguen siendo válidas para la
         próxima vez que se pierda, esperemos que nunca)
       · Libreta sanitaria tiene timeline limpio del incidente: status_changed,
         shelter_intake_recorded, custody_transfer_proposed, custody_transferred
       · Refugio sin Negrita en su lista, sin pendientes
       · Owner con Negrita de vuelta en /mis-mascotas, badge active
```

## 11. Edge cases

- **Pet sin chip se pierde y owner no quiere exponer nada.** Toggles todos OFF + sin chip = credencial pública muestra solo nombre/foto/color y status=lost. Sin canales de contacto. Aceptable; el owner asume el riesgo de no ser contactable.
- **Owner cambia las disclosure prefs mientras la pet está perdida.** El credencial pública refleja el cambio inmediatamente (lee `pets` columns en cada render). Sin necesidad de re-emitir event. Si el cambio es relevante para auditoría (raro), agregamos un event opcional `disclosure_prefs_updated` — fuera de scope v1.
- **Chip cargado retroactivamente durante el flujo enriquecido.** El owner se acuerda que hay chip y lo carga en el form de `/perdida`. Server action emite `microchip_implanted` event (mismo que createPetAction) + status_changed. El chip queda en `pets.microchip_id`. Si después alguien hace intake, el cross-check va a matchear correctamente.
- **Owner intenta aceptar proposal cuando ya marcó found por otra vía.** Auto-cancel lazy: el accept action chequea state, ve que pet.status='active' y no hay shelter_custody activa, → auto-cancel del proposal. Notificación clara al refugio: "El owner ya recuperó a {pet}. Caso cerrado por otra vía. No hace falta más acción de tu parte."
- **Dos shelter_custody simultáneos sobre el mismo pet (refugio A y refugio B).** Mismo edge que v1.0. Block en el segundo intake con mensaje claro. Coordination offline.
- **Refugio archiva el proposal y olvida.** Owner queda con notification urgente. Si el owner clickea más tarde, el accept funciona normalmente (siempre que preconditions sigan). Si nunca clickea, el proposal queda pending. Sin time-bomb v1.
- **Vecino marca pet como perdida en CABA donde no hay refugios verified que cubran su locality.** Broadcast no manda a nadie. La pet queda con `status=lost` y la credencial pública sirve como surface de discovery. Aceptable — el broadcast es enrichment, no precondition.
- **El owner expone email pero `auth.users.email` está vacío** (raro pero posible). Render la sección como si el toggle estuviera OFF — no hay email para mostrar. Sin error.
- **Pet con chip pero owner desactivó la disclosure de teléfono y nunca cargó email.** Credencial pública para el lost pet muestra solo el form de finder (si está activo) o nada. Refugio que reciba broadcast tiene que confiar en el chip-match flow para conectar.

## 12. RLS y security

**Disclosure preferences (`pets.disclose_*_when_lost`):**
- SELECT: pública (la credencial pública lo lee anonymously). Las prefs en sí mismas no son sensitive — son el filtro de lo que es público.
- UPDATE: solo el owner del pet (via server action o RLS de pets)

**Cross-check:**
- Lookup vía Drizzle (server-side bypass RLS)
- Response al actor incluye PII mínima respetando las disclosure prefs del owner (sí, incluso el match flow respeta lo que el owner decidió)

**Auto-cancel:**
- Lazy validation server-side. El owner que clickea accept es el que dispara el check. No hay nadie más con permisos para forzar cancellation.

**Broadcast:**
- Notification body PII-free (D5)
- El refugio member que ve la notification tiene RLS scope solo a sus propias notifications

**Enriched description:**
- Los campos van al pet row (que es públicamente leíble en Tier 1) y/o al event payload (que tiene visibility según RLS de events)
- No hay PII extra — son descripciones del animal, no del owner

## 13. Phasing

**Fase 1 — Schema foundation (1 PR).**
- Migración: `pets` agrega 5 columnas de disclosure prefs
- Migración: index sobre `pets.microchip_id` (defensive)
- Extender Zod: `custody_transfer_proposed`, `custody_transferred`, `status_changed` (snapshot + lost_description)
- `notification_type` nuevos valores (TEXT, no migration — solo doc)

**Fase 2 — Microchip cross-check + match flow (1-2 PRs).**
- `createIntakeAction` y `createPetAction` agregan cross-check
- Match confirmation UI (compartida refugio/vecino): `/org/[orgToken]/intake/match/{token}` y `/mis-mascotas/nueva/match/{token}`
- `confirmChipMatchAction` que crea shelter_custody paralela y notifica owner
- Tests cubrindo todos los status cases

**Fase 3 — Owner disclosure preferences (1 PR).**
- Sección nueva en `/perdida` form con los 5 toggles
- Sección equivalente en `/mis-mascotas/{token}/editar` (o ruta dedicada `/credencial`)
- `/p/[publicToken]/page.tsx` lee los toggles de pet row al renderizar Tier 1
- Tests del toggle behavior

**Fase 4 — Enriched description para unchipped (1 PR).**
- `/perdida` form expande cuando `pet.microchipId IS NULL`
- `setPetLostAction` recibe + persiste los nuevos campos (pets updates + event payload snapshot)
- Credencial pública renderiza la sección de descripción cuando hay datos
- Tests del flujo enriquecido

**Fase 5 — Return-to-owner two-phase + auto-cancel (1 PR).**
- `proposeReturnToOwnerAction` (actor side)
- `ownerAcceptReturnAction` + `ownerRejectReturnAction` con lazy auto-cancel
- `actorCancelProposalAction`
- UI: `/org/[orgToken]/mascotas/{petToken}` botón + form (devolver al dueño)
- UI: `/mis-mascotas/{token}/devolucion` con CTA
- Tests del two-phase + auto-cancel scenarios

**Fase 6 — Broadcast on lost (1 PR).**
- `broadcastLostPet` helper en `setPetLostAction`
- Lookup por `organization_coverage` + verified + active
- Fanout a members con `receivesBroadcasts=true`
- Tests cubrindo: orgs covering vs not, opt-in vs opt-out, no-orgs-in-jurisdiction case

**Fase 7 — Polish (1 PR opcional).**
- Validación format chip (15 dígitos ISO)
- Rate-limit del FoundPetForm (1 submission por IP+publicToken cada 5min)
- Confirmación de doble-click en setPetFoundAction

Total: ~6-7 PRs chicos, ~1.5 semanas de trabajo. Cada fase es entregable de forma independiente.

## 14. Lo que NO está en este diseño

- **Reverse-lookup público "estoy buscando mi pet sin chip"** — fuera de scope. La credencial pública del pet es el surface canónico para discovery; un finder que no tiene el QR pero piensa que el pet podría estar en DIM debe buscar por otros medios (preguntar en refugios, redes sociales).
- **Broadcast a vecinos (no orgs)** — sin `organization_coverage` no hay forma controlada. Feature futuro con su propio opt-in model.
- **WhatsApp / Instagram share-intent** para distribuir lost-pet poster — outside-DIM.
- **Animales BA integration** — diplomatic, deferred.
- **Time-bomb / cron auto-cancel** de proposals viejos sin touch — manual via admin en v1.
- **Multi-chip detection** — edge case sin demanda real.
- **Map-based discovery de lost pets** — proyección welfare officer dashboard, fuera de scope.
- **Reward economy** — fuera de scope.
- **Sweep job de stale state** — lazy validation cubre el 99% de casos.
- **Re-broadcast cuando el owner edita las prefs** — la primera mande define el envío. Sin re-fanout.
- **Audit-log de cambios de disclosure prefs** — comparable a `emergencyInfoVisible` que tampoco emite event. Si el dato lo justifica, lo agregamos como event `disclosure_prefs_updated` en una iteración posterior.

---

## Próximo paso

Cuando este diseño tenga OK final, partimos en planes de implementación. Las Fases 1, 2 y 5 son las críticas (foundation + cross-check + return). Las Fases 3, 4 y 6 mejoran sustancialmente el feature pero pueden ir en paralelo o secuenciales. Fase 7 es polish opcional.

Si querés ajustar algo (defaults de disclosure prefs, campos del enriched flow, criterios de auto-cancel, copy de cualquier notification), **decímelo antes de los planes** — cambiar después cuesta más.
