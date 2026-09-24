# Vecino con mascota en tránsito — núcleo mínimo

> Plan de implementación para Claude Code. Auto-contenido: leé este archivo, leé los anchors que cita, y ejecutá. Sin ambigüedad de scope.
>
> **Fecha:** 2026-05-16
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~5 archivos tocados, 0 migraciones, 0 cambios de schema, 0 cambios de RLS

---

## 0. Antes de tocar nada — leé esto

Lectura obligatoria en este orden:

1. **`AGENTS.md`** completo, prestando atención específica a:
   - "Core principles" (eventos son la spina, append-only, projections first-class)
   - "Organizations" → el párrafo que arranca con *"Shelter custody is temporary by definition"* y la frase clave: *"The vecino-helps-stray case is explicit and intentional. An existing DIM owner can register a found animal and have it appear in their pet list with a 'tránsito' badge, with no requirement to be a member of any organization."*
   - "Data model" → `Ownership` → enum role (`owner | co_owner | shelter_custody | foster | caretaker`) y las semánticas anotadas
2. **`db/schema.ts`** — confirmá que `shelter_custody` está en el enum `ownership_role` y que la columna `pets.acquisitionMethod` ya existe
3. **`app/actions/pets.ts`** — entendé `createPetAction` y `parsePetForm`; vas a tocar los dos
4. **`components/PetForm.tsx`** — entendé `compact` mode y la sección "Identificación y raza" donde vive hoy `acquisitionMethod`
5. **`app/(app)/mis-mascotas/page.tsx`** — la query de `ownedPets` y el `PetCard`
6. **`app/(app)/mis-mascotas/[publicToken]/page.tsx`** — la query principal del perfil y la zona del hero

No empieces a tipear código hasta haber leído esto. El feature es chiquito justamente porque el modelo de datos ya lo soporta; el riesgo está en romper alguna invariante que está documentada y no es obvia mirando solo el código.

## 1. Qué es este feature

Un usuario DIM puede registrar una mascota que **está cuidando** sin reclamarse como dueño/a legal. La mascota aparece en su libreta con un badge "En tránsito", su `Ownership` queda como `shelter_custody` (no `owner`), y toda la libreta sanitaria funciona igual. El feature descansa enteramente sobre infraestructura ya construida — no toca DB.

Es la primera materialización en UI del caso "vecino-helps-stray" que el `AGENTS.md` declara como decisión cerrada. Hasta hoy, el form deja elegir `acquisition_method='found_stray'` pero la consecuencia estructural (custody role) no se está escribiendo. Este plan cierra ese gap.

## 2. Decisiones cerradas (no relitigar)

Estas decisiones fueron tomadas con Nacho. Si encontrás algo en el código que las contradice, asumí que el código está desactualizado, no la decisión.

| # | Decisión | Por qué |
|---|---|---|
| D1 | El form de alta agrega **una pregunta nueva, separada del campo `acquisitionMethod`**: "¿Es tu mascota o la estás cuidando?". Es la decisión dominante; `acquisitionMethod` queda como dato secundario sobre el origen | Sacar la pregunta del campo "cómo llegó" la vuelve explícita y desacopla "estado actual de custodia" de "origen histórico" |
| D2 | El campo nuevo se llama `custodyKind` con valores `'owner' \| 'foster_in_transit'`. Default `'owner'`. **En modo `compact` (signup) no se renderiza y se asume `'owner'`** | El típico signup no es para registrar un animal en tránsito; quien lo necesite va a `/mis-mascotas/nueva` después |
| D3 | En **modo edición** (`isEdit`) el toggle tampoco se renderiza. La conversión `shelter_custody → owner` (o viceversa) no se hace editando el form; es una acción separada que queda como "próximamente" en el perfil | Editar el form no debería flipear el role del ownership — eso es un cambio de custodia, no una corrección de datos |
| D4 | Cuando `custodyKind === 'foster_in_transit'`, el insert de `ownerships` usa `role: 'shelter_custody'` y `pet_registered.payload` lleva además `custody_kind: 'shelter_custody_by_citizen'` | El payload field le da agarradera a las proyecciones futuras sin tener que joinear `ownerships` |
| D5 | **No bloqueamos ninguna acción en el perfil de la mascota en tránsito.** Vacunas, peso, vet visit, marcar como perdida, fallecimiento, atestación PPP — todo queda habilitado. El badge "en tránsito" en el header da el contexto y confiamos en el usuario | UX más simple para v1; si surgen datos raros lo reconsideramos |
| D6 | **La notificación de registro PPP sí se suprime** cuando `custodyKind === 'foster_in_transit'`. Es la única excepción al D5 | La obligación legal de inscribir en el registro provincial es del dueño legal, no del cuidador transitorio. Mandarle la notificación al vecino es desinformación |
| D7 | En la pet list, las mascotas en tránsito **conviven en la misma lista** que las propias, con un pill discreto "En tránsito" al lado del nombre | No separamos en secciones; el badge basta. Lenguaje visual sobrio, mismo tono que el resto, no rojo de alarma |
| D8 | En el perfil, un **banner persistente** arriba del hero dice *"Estás cuidando a [Nombre] en tránsito"* con dos botones secundarios **deshabilitados** con copy "Próximamente": **"Convertir en mi mascota"** y **"Buscar nuevo hogar"** | Cierra el modelo mental desde el día uno — el tránsito no es un estado terminal |
| D9 | La credencial pública (`/p/{publicToken}`) **se queda como está** | Out of scope para este núcleo |

## 3. Scope

**Dentro:**
- Cambio en `components/PetForm.tsx` (toggle nuevo arriba de "Lo básico")
- Cambio en `app/actions/pets.ts` (`parsePetForm` + `createPetAction`)
- Cambio en `app/(app)/mis-mascotas/page.tsx` (traer role + pasar al PetCard + badge)
- Cambio en `app/(app)/mis-mascotas/[publicToken]/page.tsx` (traer role + banner condicional + botones disabled)
- Actualización de `AGENTS.md` reflejando el feature como cerrado

**Fuera:**
- Conversión `shelter_custody → owner` (botón "Convertir en mi mascota") — implementar como **disabled** con tooltip "Próximamente"
- Transferencia a refugio (botón "Buscar nuevo hogar") — implementar como **disabled** con tooltip "Próximamente"
- Credencial pública Tier 0 — sin cambios
- Búsqueda activa del dueño original (cruce con microchip, denuncias cercanas)
- Schema / migraciones / RLS — **nada de esto se toca**
- `updatePetAction` — sin cambios (D3)
- Form `compact` de signup — sin cambios (D2)

## 4. Plan paso a paso

Hacé los pasos en este orden. Después de cada paso, corré `pnpm typecheck` (o `pnpm tsc --noEmit`) para no acumular errores de tipos.

### Paso 1 — `components/PetForm.tsx`: agregar el toggle `custodyKind`

**Dónde insertar.** El `<form>` empieza renderizando `hiddenFields` y la sección "Lo básico". Insertá el toggle **entre `hiddenFields` y la sección "Lo básico"**, condicionado a `!compact && !isEdit`.

**Cómo se ve.** Dos radio-as-cards grandes, una al lado de la otra (o apiladas en mobile), con labels claros. Usá el mismo lenguaje visual del resto del form — bordes `border-neutral-200 dark:border-neutral-800`, radios nativos con `focus:ring-neutral-900`. Estado controlado con `useState<'owner' | 'foster_in_transit'>('owner')` en el componente.

**Copy exacto:**

- Card 1 (`value="owner"`, default seleccionado):
  - Título: **"Es mi mascota"**
  - Descripción: *La adoptaste, te la regalaron, la compraste, o ya vive con vos como tuya.*
- Card 2 (`value="foster_in_transit"`):
  - Título: **"La estoy cuidando"**
  - Descripción: *La encontraste, te la pasó alguien, o la tenés en tránsito mientras buscás dueño o un refugio.*

Cuando se selecciona "La estoy cuidando", aparece **abajo del toggle** un bloque informativo sutil (no alerta), con copy:

> *Vas a poder llevarle la libreta sanitaria mientras la cuidás. La información viaja con la mascota si aparece su familia o pasa a un refugio. Si más adelante la adoptás formalmente, vas a poder convertirla en tuya desde su perfil.*

**Nombre del input.** `name="custodyKind"`. Server action lo lee del `FormData` por ese nombre.

**Acceso a `compact` y `isEdit`.** `compact` viene por props; `isEdit` ya se calcula como `!!existingPet`. Trivial.

### Paso 2 — `app/actions/pets.ts`: parsear `custodyKind` y aplicarlo en `createPetAction`

**Cambio 2a — extender el tipo `ParsedPet` y `parsePetForm`:**

Agregar al tipo:
```ts
custodyKind: 'owner' | 'foster_in_transit';
```

Agregar al parser, después del bloque que parsea `acquisitionMethod`:
```ts
const custodyKindRaw = String(formData.get('custodyKind') ?? 'owner').trim();
const custodyKind: 'owner' | 'foster_in_transit' =
  custodyKindRaw === 'foster_in_transit' ? 'foster_in_transit' : 'owner';
```

Y agregarlo al objeto retornado `parsed`.

**Cambio 2b — usar `custodyKind` en `createPetAction`:**

Hoy el insert de `ownerships` es:
```ts
await tx.insert(ownerships).values({
  petId: newPet.id,
  ownerUserId: user.id,
  role: 'owner',
  startedAt: now,
});
```

Cambiar a:
```ts
const ownershipRole = parsed.custodyKind === 'foster_in_transit' ? 'shelter_custody' : 'owner';
await tx.insert(ownerships).values({
  petId: newPet.id,
  ownerUserId: user.id,
  role: ownershipRole,
  startedAt: now,
});
```

**Cambio 2c — enriquecer el payload de `pet_registered`:**

En el `insert` del evento `pet_registered`, agregar al `payload`:
```ts
custody_kind: parsed.custodyKind === 'foster_in_transit' ? 'shelter_custody_by_citizen' : 'owner',
```

Para que sea trivial filtrar más adelante sin joinear `ownerships`.

**Cambio 2d — suprimir notificación PPP en tránsito (D6):**

El bloque `if (parsed.potentiallyDangerousBreed) { ... insert notification ... }` debe agregar la condición:
```ts
if (parsed.potentiallyDangerousBreed && parsed.custodyKind !== 'foster_in_transit') {
  // ... insert PPP reminder notification
}
```

**Cambio 2e — `updatePetAction` no se toca.** El campo `custodyKind` no entra en `diffPet` y no se incluye en el update. Si por alguna razón llega en el `FormData` durante un edit (no debería, porque el form no lo renderiza en `isEdit`), el parser lo lee pero `createPetAction` es el único que lo consume.

### Paso 3 — `app/(app)/mis-mascotas/page.tsx`: traer role del ownership y badge en `PetCard`

**Cambio 3a — extender la query.** Hoy la query es:
```ts
const ownedPets = await db
  .select({ pet: pets, photo: attachments })
  .from(pets)
  .innerJoin(ownerships, eq(ownerships.petId, pets.id))
  .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
  .where(and(eq(ownerships.ownerUserId, user.id), isNull(ownerships.endedAt)));
```

Cambiar a:
```ts
const ownedPets = await db
  .select({ pet: pets, photo: attachments, ownershipRole: ownerships.role })
  .from(pets)
  .innerJoin(ownerships, eq(ownerships.petId, pets.id))
  .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
  .where(and(eq(ownerships.ownerUserId, user.id), isNull(ownerships.endedAt)));
```

**Cambio 3b — pasar `ownershipRole` a `PetCard` y renderizar badge.**

```tsx
<PetCard
  key={pet.id}
  pet={pet}
  photoUrl={petPhotoUrl(photo?.storagePath)}
  ownershipRole={ownershipRole}
/>
```

En `PetCard`, agregar la prop `ownershipRole: string` y renderizar un pill chiquito al lado del nombre cuando `ownershipRole === 'shelter_custody'`:

```tsx
{ownershipRole === 'shelter_custody' && (
  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-900">
    En tránsito
  </span>
)}
```

Tono sobrio, no rojo de alarma (D7). Amber funciona porque es "atención" sin gritar "peligro".

### Paso 4 — `app/(app)/mis-mascotas/[publicToken]/page.tsx`: banner condicional + botones disabled

**Cambio 4a — extender la query principal.** Hoy carga el pet con su foto via join con `ownerships` para el chequeo de permisos. Agregale `ownerships.role` al select para usarlo abajo. Hay que mirar la query alrededor de las líneas 195-205 — hace `select({ pet: pets, photo: attachments })` con `.innerJoin(ownerships, ...)` filtrando por `ownerUserId = user.id` y `endedAt IS NULL`. Extender a `select({ pet: pets, photo: attachments, ownershipRole: ownerships.role })` y desestructurar `ownershipRole` del result.

**Cambio 4b — banner.** Insertarlo **entre el link "← Mis mascotas" (línea ~280) y la sección hero (línea ~287)**, renderizado condicionalmente:

```tsx
{ownershipRole === 'shelter_custody' && (
  <section className="rounded-xl border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
    <p className="text-sm text-amber-900 dark:text-amber-200">
      Estás cuidando a <strong>{pet.name}</strong> en tránsito. La libreta sanitaria que armes acá viaja con la mascota.
    </p>
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled
        title="Próximamente"
        className="px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200 opacity-60 cursor-not-allowed"
      >
        Convertir en mi mascota
      </button>
      <button
        type="button"
        disabled
        title="Próximamente"
        className="px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200 opacity-60 cursor-not-allowed"
      >
        Buscar nuevo hogar
      </button>
    </div>
  </section>
)}
```

**Cambio 4c — no bloqueamos nada más.** Por D5 todas las acciones existentes en el perfil (registrar eventos, marcar perdida, fallecimiento, atestar PPP, editar) siguen habilitadas igual. **No agregues lógica de bloqueo en ningún botón existente** — el banner es la única señal de UI.

**Cambio 4d — `DeceasedView`.** Si la mascota está `deceased` se renderiza una vista distinta antes del `return` principal. El banner de tránsito **no necesita aparecer ahí** — es un caso raro y la vista in-memoriam tiene su propia identidad. Dejarla como está.

### Paso 5 — Actualizar `AGENTS.md`

Después de los cuatro pasos anteriores, agregar al `AGENTS.md` una nota corta cerrando la decisión. Buscá la sección **"Organizations"**, encontrá el párrafo que dice *"The vecino-helps-stray case is explicit and intentional..."*, y agregale al final una línea:

> **Implementado en v1.** El alta en `/mis-mascotas/nueva` pregunta "¿Es tu mascota o la estás cuidando?" como decisión explícita (campo `custodyKind`). Cuando se elige "la estoy cuidando", el `Ownership` se inserta con `role='shelter_custody'`, la mascota aparece en la pet list con badge "En tránsito", y el perfil muestra un banner persistente con accesos "próximamente" a conversión y derivación. La notificación de registro PPP se suprime para custodios transitorios — la obligación legal es del dueño.

No tocar otras secciones. Mantener el resto de los `Open questions / future work` como está (la transferencia a refugio sigue siendo "futuro" porque depende del portal de orgs).

## 5. Verificación

Después de aplicar todos los cambios, hacé **en este orden**:

1. **Typecheck.** `pnpm typecheck` (o `pnpm tsc --noEmit`). Cero errores.
2. **Lint.** `pnpm lint` o `pnpm biome check`. Cero errores nuevos.
3. **Build.** `pnpm build`. Tiene que compilar.
4. **Smoke manual via Studio o vía `pnpm dev`:**
   - Crear un usuario nuevo, ir a `/mis-mascotas/nueva`, elegir "La estoy cuidando", completar campos mínimos, submitear.
   - Verificar en Studio que: el `pets` row existe, el `ownerships` row tiene `role = 'shelter_custody'`, el `pet_events` `pet_registered` payload tiene `custody_kind: 'shelter_custody_by_citizen'`.
   - Volver a `/mis-mascotas`: ver la mascota con badge "En tránsito".
   - Click en la mascota: ver el banner arriba, botones disabled con tooltip "Próximamente".
   - Confirmar que el resto del perfil (registrar eventos, editar, marcar perdida) sigue habilitado.
   - Crear otra mascota con "Es mi mascota" → confirmar que **no** sale badge ni banner.
   - Crear una mascota PPP (ej. Pitbull) con "La estoy cuidando" → confirmar que **no** se generó la notificación PPP en `notifications` para ese pet.
   - Crear una mascota PPP con "Es mi mascota" → confirmar que **sí** se generó la notificación PPP.
5. **Si existe `pnpm rls:smoke` o equivalente:** corré los smoke tests de RLS para confirmar que no rompimos aislamiento. **No deberías haber tocado nada de RLS, pero más vale verificar.**

Si cualquiera de estos chequeos falla, **no marques el feature como completo**. Reportá el problema con detalle.

## 6. Casos borde y trampas

- **No incluir `custodyKind` en `diffPet`.** Aunque el form no lo renderiza en edit mode, si alguien llamara a `updatePetAction` con `custodyKind` en el formData, **debe ser ignorado**. La custodia se cambia con eventos `custody_transferred` / `adoption_finalized`, no editando el pet.
- **El compact form de signup no se toca.** El `<SignupForm>` usa `<PetForm compact />`; el toggle no debe renderizarse ahí y el default `'owner'` aplica.
- **Default en `parsePetForm` es `'owner'`.** Si el campo no llega (porque el form fue compact o porque es un edit), el parser asume `'owner'` y todo sigue funcionando como hoy.
- **No agregar columnas a `pets`.** `custodyKind` **no es un campo del pet**; es una decisión del momento del alta que determina el role del ownership. Ese role ya vive en `ownerships.role`. No hace falta nada más.
- **No tocar el enum `ownership_role`.** `shelter_custody` ya está. Verificalo en `db/schema.ts` y `db/migrations/0000_orgs_foundation.sql` antes de empezar.
- **No tocar el `pet_registered` event_type.** Solo enriquecemos el `payload`. La forma del evento no cambia.
- **Spanish UI, English code.** Todos los strings user-facing en es-AR (Argentina); nombres de variables, tipos, comentarios en inglés. Ver `AGENTS.md` → "How Claude should work in this repo".

## 7. Cuando termines

1. Marcá todos los chequeos del paso 5 como hechos.
2. Hacé un commit con mensaje:
   ```
   feat(custody): vecino con mascota en tránsito

   Adds explicit custody-kind question to pet registration form. When a
   user picks "la estoy cuidando", the resulting Ownership row uses
   role='shelter_custody' instead of 'owner', the pet shows an "En
   tránsito" badge in the pet list, and the profile renders a banner
   with future-action stubs. PPP attestation notifications are
   suppressed for foster-in-transit custodians since that's a legal
   owner obligation.

   Implements the vecino-helps-stray case from AGENTS.md → Organizations
   on top of the existing shelter_custody role — no schema change.
   ```
3. Reportá a Nacho con un resumen corto (en español) de qué quedó implementado y qué quedó deferred. Si pediste algo fuera del scope declarado en §3, justificá por qué.
