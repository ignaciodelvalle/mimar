# Tatuaje como identificador secundario — design spec

> Sumar **tatuaje** como segundo identificador estructurado del pet, al lado del microchip. Hoy un tatuaje (típico en pets registrados antes de 2010, rescates, criaderos FCA, y campañas masivas de castración) sólo cabe como texto libre en `pets.distinguishing_features`. Eso lo deja invisible para el flujo lost-and-found: el credencial público no lo muestra como identificador, no se puede adjuntar foto del tatuaje, y no entra en ningún matching. Este spec convierte al tatuaje en un identificador de primera clase con la misma arquitectura que ya usamos para microchip: columnas denormalizadas en `pets`, evento append-only en `pet_events`, formulario propio en `eventos/nuevo/`, y un bloque de captura retroactiva en `MarkLostForm` para owners en pánico que recién se acuerdan que su mascota tiene tatuaje.
>
> **Fecha:** 2026-05-21
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Shipped 2026-05-22 — D1-D4 cerradas y ejecutado contra `docs/superpowers/plans/2026-05-21-tattoo-identifier.md` (Chunks A-G). Migration 0045 + tabla pets.tattoo_* + 2 event types + UI completa.
> **Versión:** 1.0

---

## 1. El gap que cierra

DIM modela la identidad de cada pet como un combo (microchip ISO 11784/11785 + `publicToken` interno + foto). El microchip es la pieza fuerte: globalmente único, escaneable por cualquier veterinaria o refugio con lector RFID, y es el factor que cruza el matching anti-duplicados de la tabla `pets`.

Pero el universo real de pets argentinos tiene una capa pre-chip que sigue viva:

- **Pets registrados antes de 2010**, cuando el tatuaje era el estándar en clubes y criaderos.
- **Razas FCA con pedigree**, donde el tatuaje en la oreja con código de criadero es práctica estándar incluso hoy.
- **Gatos y perros castrados en campañas masivas** (Mascotas CABA y similares en otras provincias), donde el tatuaje en la oreja es la marca de "ya fue castrado".
- **Rescates de la calle** donde el tatuaje es la única pista sobre la historia previa del animal.

Para todos esos casos, hoy la única opción es escribir "tatuaje en oreja izquierda: K-9-2014" en `pets.distinguishing_features`. Eso significa:

1. **Credencial público de pet perdido no lo muestra como identificador.** Aparece sepultado en "marca distintiva" si el owner escribió ahí. El finder no entiende que es un código de identificación.
2. **No se puede adjuntar foto del tatuaje.** La foto es el único factor que un finder común puede usar para confirmar visualmente que el animal que tiene en frente es el del credencial — los tatuajes son borrosos, viejos, con tinta corrida. Sin foto, el código solo es ruido.
3. **Ningún flujo de matching lo considera.** Si alguien lleva al animal a una veterinaria que reporta a DIM, no hay forma de cruzar el código del tatuaje con los pets de la base.
4. **No queda en el timeline del pet.** Cuándo se tatuó, quién, dónde — todo se pierde.

El owner que está usando MiMAR en el peor momento de su vida (perdió la mascota) tiene que poder cargar el tatuaje rápido, con foto, y verlo aparecer en el credencial público al lado del microchip (o en lugar de, si no hay chip).

## 2. Decisiones abiertas (pendientes de Nacho)

Hasta que estas estén cerradas, NO se escribe el plan ejecutable. Cada una afecta scope concreto del primer chunk.

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D1 | **Registry catalog** — ¿modelamos el origen del tatuaje? | (a) campo libre `tattoo_registry text`; (b) lookup cerrado `FCA / kennel / spay_neuter_campaign / other`; (c) omitir en v1, el owner pone el origen en notas | (b) lookup cerrado. Sin estructura no podemos agregar después (ej: dashboards "% de tatuajes de campaña vs criadero"); con lookup el dato sirve también para señalar a un govt analyst que esa zona tuvo campaña masiva. Costo: 5 líneas en `lib/lookups.ts` + un `<select>` |
| D2 | **Cross-check en el flow de lost** — ¿buscamos coincidencias por código de tatuaje cuando alguien marca un pet como encontrado? | (a) sí, paralelo a `app/actions/chip-match.ts` con normalización (uppercase + strip whitespace) y surface "posible coincidencia, verificá con foto"; (b) no, defer hasta tener volumen de datos | (b) defer. El espacio de códigos de tatuaje es chico y muy colisional (muchos criaderos comparten convenciones); sin volumen el ratio falsos-positivos a verdaderos sería penoso. Implementar la columna ahora, ahorrar el matching para una iteración posterior cuando haya datos para ajustar |
| D3 | **Visibilidad pública del código del tatuaje cuando el pet NO está perdido** | (a) siempre visible como hoy con el chip; (b) gated por status lost (el código aparece sólo cuando el pet está marcado perdido); (c) configurable por owner con un toggle de `disclose_tattoo_when_lost` análogo a los del chip | (a) siempre visible. Coherente con cómo tratamos al microchip; un tatuaje es información menos identificable que un número de chip único. La **foto** del tatuaje sí merece protección extra — propuesta: la foto se muestra siempre que el pet esté perdido O cuando el owner abre el credencial; al público en estado normal solo aparece el código + ubicación, no la foto |
| D4 | **Backfill / migración de `distinguishing_features`** — ¿escaneamos los rows existentes en busca de "tatuaje" y proponemos migrarlos? | (a) script que detecta `~* 'tatuaje'` y crea una notificación al owner "encontramos esto en tu mascota, ¿es un tatuaje?"; (b) no hacer nada, ir prospectivo | (b) prospectivo. El volumen actual de DIM es chico (still dev/beta); cualquier match real lo va a redescubrir el owner cuando vea el nuevo flow. El esfuerzo de escribir + testear el detector no vale la pena para los <100 pets actuales. Cuando llegue volumen institucional, sí. Por ahora, queda como TODO en notas |

**Posibles otras decisiones** que aparecieron durante el survey pero que el spec resuelve por adopción del patrón de chip, no requieren input del owner:

- Formato del código: `text` libre, sin validación de length. No usamos regex. Los códigos varían demasiado.
- Unique constraint: no. A diferencia del chip, los códigos de tatuaje colisionan entre registros distintos. Sin DB-level uniqueness.
- Event lifecycle: dos eventos — `tattoo_recorded` (alta) y `tattoo_updated` (correcciones). Append-only. No `tattoo_replaced` — los tatuajes no se reemplazan, se hacen más legibles o se documentan mejor.
- Storage de la foto: usa el bucket `pet-photos` existente, con `attachments.pet_id` poblado y `attachments.event_id` poblado al evento `tattoo_recorded`. El `pets.tattoo_photo_id` apunta a la attachment "canónica" actual (la última registrada).

## 3. Glosario

| Término | Qué es | Vive en |
|---|---|---|
| **Tatuaje** | Marca alfanumérica permanente en la piel del pet (típico: oreja interna o muslo interno). Identificador secundario | `pets.tattoo_*` columns + evento `tattoo_recorded` |
| **`tattoo_id`** | Código del tatuaje, alfanumérico, free-form. Sin formato impuesto | `pets.tattoo_id` (text) |
| **`tattoo_registry`** | Origen del tatuaje. Lookup cerrado: `fca / kennel / spay_neuter_campaign / other` | `pets.tattoo_registry` |
| **`tattoo_location`** | Lugar del cuerpo donde está el tatuaje. Lookup cerrado: `inner_ear_left / inner_ear_right / inner_thigh / belly / other` | `pets.tattoo_location` |
| **`tattoo_photo_id`** | FK-by-convention a `attachments.id` con la foto canónica. Mismo patrón loose-FK que `primary_photo_id` | `pets.tattoo_photo_id` |
| **`tattoo_recorded`** | Evento append-only de alta del tatuaje | `pet_events.event_type` enum |
| **`tattoo_updated`** | Evento append-only de corrección (re-foto, código más preciso, ubicación recalibrada) | `pet_events.event_type` enum |
| **Bloque de captura retroactiva** | Sección dentro de `MarkLostForm` que aparece cuando `!petHasChip && !petHasTattoo`, paralela al "Microchip (opcional)" existente | `MarkLostForm.tsx` group D |

## 4. Domain model

### 4.1 Columnas nuevas en `pets`

```sql
alter table public.pets
  add column tattoo_id        text,
  add column tattoo_registry  text,
  add column tattoo_location  text,
  add column tattoo_recorded_at date,
  add column tattoo_recorded_by text,
  add column tattoo_photo_id  uuid;

alter table public.pets
  add constraint pets_tattoo_registry_valid
    check (
      tattoo_registry is null
      or tattoo_registry in ('fca','kennel','spay_neuter_campaign','other')
    );

alter table public.pets
  add constraint pets_tattoo_location_valid
    check (
      tattoo_location is null
      or tattoo_location in ('inner_ear_left','inner_ear_right','inner_thigh','belly','other')
    );

-- No uniqueness on tattoo_id — collisions across registries are expected.

create index pets_tattoo_id_idx
  on public.pets (tattoo_id)
  where tattoo_id is not null;
```

**Mirroring decisions con chip**: cada `tattoo_*` columna corresponde 1:1 a un `microchip_*` columna excepto:

- Sin `tattoo_country_code` — los tatuajes no son globales.
- Sin uniqueness constraint — los códigos colisionan.
- `tattoo_photo_id` es nueva — el chip no tenía foto canónica, el tatuaje sí (es central para verificación visual).

### 4.2 Eventos nuevos en `EVENT_TYPES` (TS const, no es pgEnum)

`pet_events.event_type` es TEXT en la DB — el catálogo vive en el array `EVENT_TYPES` en `db/schema.ts` y se valida en app code. Esto fue una decisión consciente (ver comentario sobre `EVENT_TYPES`: *"adding a new event type does not require a database migration"*).

Cambio: insertar en el array, justo después de `"microchip_replaced"`, bajo el comentario `// Identification & legal`:

```ts
"tattoo_recorded",
"tattoo_updated",
```

Ninguna migration adicional para esto. La migration de §4.1 solo agrega las columnas de `pets`.

### 4.3 Payload schemas (`lib/event-schemas.ts`)

```ts
const tattooRecorded = z
  .object(
    withVersion({
      tattoo_code: z.string().min(1),
      registry: z.enum(["fca", "kennel", "spay_neuter_campaign", "other"]).nullable(),
      location_on_body: z.enum([
        "inner_ear_left",
        "inner_ear_right",
        "inner_thigh",
        "belly",
        "other",
      ]).nullable(),
      recorded_by: z.string().nullable(),
      // Mirrors the performed-by autocomplete pattern from microchip.
      recorded_by_organization_id: z.string().uuid().nullable().optional(),
      recorded_by_user_id: z.string().uuid().nullable().optional(),
      // Whether the date is the actual tattoo date (true) or just registration in DIM (false).
      tattoo_date_known: z.boolean().optional(),
    }),
  )
  .strict();

const tattooUpdated = z
  .object(
    withVersion({
      previous_tattoo_code: z.string().nullable(),
      new_tattoo_code: z.string(),
      // Free-text reason: "código corregido tras revisar la foto", "foto re-tomada con mejor luz", etc.
      reason: z.string().nullable(),
    }),
  )
  .strict();
```

Both registered in the `eventPayloadSchemas` map at the bottom of `lib/event-schemas.ts`.

### 4.4 Lookup constants (`lib/lookups.ts`)

```ts
// Registry of origin for the tattoo. Free text NOT allowed — kept tight for
// future aggregation (e.g. govt dashboards: "% of CABA dogs with spay/neuter
// campaign tattoos by year").
export const TATTOO_REGISTRIES = [
  { value: "fca", label: "FCA — Federación Cinológica Argentina" },
  { value: "kennel", label: "Criadero" },
  { value: "spay_neuter_campaign", label: "Campaña de castración" },
  { value: "other", label: "Otro" },
] as const;

// Where on the body the tattoo is. Closed lookup to match the chip pattern.
export const TATTOO_LOCATIONS = [
  { value: "inner_ear_left", label: "Oreja interna izquierda" },
  { value: "inner_ear_right", label: "Oreja interna derecha" },
  { value: "inner_thigh", label: "Muslo interno" },
  { value: "belly", label: "Panza" },
  { value: "other", label: "Otra ubicación" },
] as const;
```

## 5. Surfaces (UI)

### 5.1 Event creation entry — picker

`app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx` agrega a `LIBRETA_OPTIONS` justo después de `microchip-reemplazo`:

```ts
{
  slug: "tatuaje",
  label: "Tatuaje registrado",
  description: "Código del tatuaje y foto. Identificador secundario al microchip.",
  enabled: true,
},
```

### 5.2 Event form — nueva carpeta

`app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/tatuaje/`:

- `page.tsx` — server component, sigue exactamente la forma de `microchip/page.tsx`
- `TattooForm.tsx` — client component basado en `MicrochipForm.tsx`, con estos cambios:
  - Reemplaza `chipNumber` text input por `tattooCode` text input (sin placeholder de 15 dígitos)
  - Saca `countryCode`
  - Reemplaza `locationOnBody` text input por `<select>` con `TATTOO_LOCATIONS`
  - Agrega `<select>` para `registry` con `TATTOO_REGISTRIES` + opción "Sin especificar"
  - `AttachmentField` queda **`required`** (no opcional como en chip) — la foto es central
  - Botón: "Registrar tatuaje"

### 5.3 Lost form — bloque de captura retroactiva

En `app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx`, dentro de la blue card "Información adicional para ayudar a identificar a tu mascota":

- Agregar un nuevo Group D después de Group C "Microchip (opcional)"
- Visibilidad: aparece sólo si `!petHasChip && !petHasTattoo`. Si ya tiene cualquiera de los dos, no se nag al owner
- Campos:
  - `enriched_tattoo_code` (text)
  - `enriched_tattoo_location` (select con `TATTOO_LOCATIONS`)
  - `<AttachmentField name="enriched_tattoo_photo" />` para la foto
- Tip: "Si tu mascota tiene tatuaje pero nunca lo cargaste, esto ayuda mucho a quien la encuentre. Subí también una foto donde se vea claro."

El handler en `app/actions/events.ts` (función `setPetLostAction` o equivalente, ver §5.5) registra estos campos como un evento `tattoo_recorded` adicional, paralelo al de chip retroactivo que ya existe.

### 5.4 Libreta header — identificador secundario

`app/(app)/mis-mascotas/[publicToken]/libreta/LibretaIdentityHeader.tsx`:

Hoy el header muestra una sola línea de identificador (chip si existe). Cambio: extender a una lista de identificadores. Si el pet tiene chip + tatuaje, render apilado:

```tsx
{pet.microchipId && (
  <p className="text-xs font-mono text-neutral-500 dark:text-neutral-500">
    <span className="sr-only">Microchip: </span>
    Microchip {pet.microchipId}
  </p>
)}
{pet.tattooId && (
  <p className="text-xs font-mono text-neutral-500 dark:text-neutral-500">
    <span className="sr-only">Código de tatuaje: </span>
    Tatuaje {pet.tattooId}
    {pet.tattooLocation && ` · ${tattooLocationLabel(pet.tattooLocation)}`}
  </p>
)}
```

El header acepta `tattooId` y `tattooLocation` en su prop `pet`. El parent (`libreta/page.tsx`) los pasa.

### 5.5 Server action

`app/actions/tattoo.ts` (nueva):

- `createTattooAction(formData)` — invocada desde `TattooForm`. Server action que:
  1. Valida ownership del pet vía `requirePetAccess`
  2. Sube la foto al bucket `pet-photos` y crea una `attachments` row con `pet_id` + `event_id` (el evento se crea primero)
  3. Inserta evento `tattoo_recorded` con payload validado
  4. Actualiza `pets.tattoo_id / tattoo_registry / tattoo_location / tattoo_recorded_at / tattoo_recorded_by / tattoo_photo_id`
  5. Devuelve `EventFormState` (`{ error: null }` en éxito o `{ error: string }`)

- `updateTattooAction(formData)` — placeholder para v1.1, no requerido en este chunk.

El handler de `MarkLostForm` (en `app/actions/events.ts`, función `setPetLostAction`) llama a la lógica interna compartida `createTattooForUser` cuando los campos `enriched_tattoo_*` están presentes, igual que hace hoy con el chip retroactivo.

## 6. Edge cases y reglas

| Situación | Comportamiento |
|---|---|
| Owner intenta registrar tatuaje sin foto | El form lo bloquea (`required`). Mensaje: "Subí una foto del tatuaje — es la mejor forma de que quien encuentre a tu mascota la reconozca". |
| Owner registra tatuaje, luego edita pet desde `/editar` | El form de edit NO incluye campos de tatuaje en v1 (mismo que con chip: la edición de identificadores pasa por el evento, no por el form genérico). |
| Pet tiene chip Y tatuaje | Ambos visibles en el header del libreta, ambos visibles en el credencial público (Tier 0). El bloque retroactivo en `MarkLostForm` no aparece. |
| Owner sube foto borrosa | No validamos calidad — confiamos en el owner. Si quiere actualizar, dispara un `tattoo_updated` (placeholder, no en v1). |
| Pet pasa por refugio que escanea chip negativo pero ve tatuaje | Fuera de scope de este spec — esto requiere flow de "encontrar pet por tatuaje" que es D2 diferido. |
| Pet adoptado de refugio, refugio ya cargó tatuaje | El tatuaje viaja con el pet a través del flow de transferencia de ownership (sin cambios — las columnas viven en `pets`, no en `ownerships`). |

## 7. Privacy

Tier model per `AGENTS.md → Privacy tiers`:

- **Código del tatuaje + ubicación corporal**: Tier 0, siempre visible en credencial público (igual que el chip).
- **Foto del tatuaje**: Tier 1 — visible cuando el pet está marcado `lost` OR cuando el viewer es el owner. Razón: una foto del cuerpo del animal es más identificable que el código pelado, y aparece en el credencial público sólo cuando hay razón operativa (búsqueda activa).
- **Quién registró el tatuaje** (`recorded_by` + FKs): Tier 2, sólo en el timeline del owner. No expuesto en credencial.

No agrega nuevos toggles de `disclose_*_when_lost` — el tatuaje sigue la misma lógica que el chip por simplicidad de UI.

## 8. Telemetry y eventos para el dashboard govt

Cuando el chunk de govt dashboards (Tier 7) se construya, este spec aporta:

- Contador de pets con tatuaje por jurisdicción (filtrable por `tattoo_registry`).
- Detección de campañas masivas: clusters de `tattoo_recorded` con `registry='spay_neuter_campaign'` en una jurisdicción específica + ventana temporal → señal de que una campaña terminó y deja huella.

Nada de esto se construye en este spec — sólo se asegura que el schema lo soporta gratis.

## 9. Open items para iteraciones futuras

- **v1.1**: `tattoo_updated` event y form de edición (re-foto, corrección de código).
- **v1.2**: Cross-check de coincidencias por código de tatuaje en el flow de lost (D2 diferido).
- **v1.3**: Backfill de `distinguishing_features` que mencionen "tatuaje" (D4 diferido).
- **v2**: Si surge demanda, separar el modelo a tabla `pet_identifiers` con múltiples filas tipo `{kind: 'microchip' | 'tattoo' | 'collar_tag' | ...}`. Por ahora las columnas dedicadas son más simples y suficientes — `microchip` y `tattoo` cubren el 100% de los casos conocidos. La migración a tabla genérica es no-breaking si se hace después (UNION view sobre las columnas).

---

## Próximo paso

Una vez Nacho confirma las decisiones de §2 (D1-D4), se escribe `docs/superpowers/plans/2026-05-21-tattoo-identifier.md` con la división en chunks ejecutables.
