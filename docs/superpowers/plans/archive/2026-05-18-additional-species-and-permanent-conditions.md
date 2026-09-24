# Additional species + permanent conditions + agent context

> Plan de implementación para Claude Code. Auto-contenido. Cierra el spec `docs/superpowers/specs/2026-05-17-additional-species-design.md` con las tres adiciones nuevas: especies adicionales (conejo / cobayo / hurón), bloque de **condición permanente**, y la exposición explícita del pet al **conversational event agent** vía `PetAgentContext`.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Tamaño:** 2 archivos nuevos, ~6 archivos tocados, 1 migración Drizzle, 0 RLS, 0 índices nuevos
> **Spec:** `docs/superpowers/specs/2026-05-17-additional-species-design.md`

---

## 0. Contexto — qué se está agregando y por qué importa

El spec original cubría sólo el dropdown de especies. Después de revisarlo:

1. La adición de especies (conejo, cobayo, hurón) sigue tal cual estaba — sigue siendo dropdown-only, sin migración. Está incluida acá porque el catálogo nuevo de condiciones permanentes filtra por especie y necesita el mismo set de valores.
2. **Condición permanente** — un nuevo array tipado en `pets` (`ciego`, `sordo`, `tres_patas`, etc.) que reemplaza el patrón actual de meter eso a mano en `distinguishing_features`. Pet-level, no event-level. Tier-1 por defecto (Art. 7 Ley 25.326). Detalle completo: spec §"Permanent conditions".
3. **`PetAgentContext`** — un shape server-rendered que el conversational event agent recibe en cada apertura. Congela la lista de campos que el agente "ve" del pet, incluyendo el nuevo `permanentConditions`. Vive en `lib/event-agent-registry.ts` junto al `EVENT_AGENT_REGISTRY` existente. Spec §"How the pet is registered and described in the datamodel — for the Conversational event agent".

Las tres piezas se hacen en un solo plan porque comparten la misma migración (3 columnas nuevas en `pets`) y el mismo touch-up en `pet_registered` payload.

## 1. Qué construye este plan

1. **`lib/permanent-conditions.ts`** (nuevo) — catálogo `PERMANENT_CONDITIONS` + `permanentConditionsForSpecies(species)` + `permanentConditionLabel(code)`.
2. **`lib/event-agent-registry.ts`** (modificado) — agrega `PetAgentContext` type y `buildPetAgentContext(petId)` helper. El `EVENT_AGENT_REGISTRY` actual no se toca.
3. **`db/schema.ts`** (modificado) — 3 columnas nuevas en `pets`: `permanent_conditions text[]`, `permanent_conditions_other text`, `disclose_conditions_publicly boolean`.
4. **`db/migrations/000X_pet_permanent_conditions.sql`** (nuevo) — generada por Drizzle.
5. **`lib/event-schemas.ts`** (modificado) — extiende `petRegistered` payload con `permanent_conditions: z.array(z.string())` y `permanent_conditions_other: z.string().nullable()`.
6. **`lib/format.ts`** (modificado) — agrega 3 cases nuevas a `speciesLabel` (`rabbit`, `guinea_pig`, `ferret`) y exporta `permanentConditionLabel` re-exportada desde `lib/permanent-conditions.ts` (o defina la suya — ver decisión D3).
7. **`components/PetForm.tsx`** (modificado) — sub-select de especie (`Otra → Conejo/Cobayo/Hurón/Otro`), fieldset multi-select de condición permanente filtrado por especie, toggle de privacidad.
8. **Acción de creación / edición de mascota** — pasa `permanent_conditions` + `permanent_conditions_other` al insert y al payload del `pet_registered`. Update emite `pet_profile_updated` con `field: "permanent_conditions"`.
9. **`app/p/[publicToken]/page.tsx`** (modificado) — render condicional de "Condición permanente: …" cuando `disclose_conditions_publicly = true` y array no vacío.
10. **Tests nuevos** — ver §5.
11. **AGENTS.md** — pequeño update apuntando a `PetAgentContext` como contrato canónico de "qué ve el agente sobre la mascota".

## 2. Decisiones cerradas

| # | Decisión | Por qué |
|---|---|---|
| D1 | `permanent_conditions` es `text[]` con default `'{}'`, no enum, no tabla aparte | Mismo patrón que `favourite_foods` / `known_allergies`. Catálogo en código, validación a nivel de acción. Permite "otra" sin migración, y permite que el día de mañana sumemos códigos sin tocar la DB. |
| D2 | Privacidad por defecto = OFF (`disclose_conditions_publicly = false`) | Art. 7 Ley 25.326 — dato sensible por proxy (puede revelar info del titular). Mismo posture que `discloseEmailWhenLost`. |
| D3 | `permanentConditionLabel` vive en `lib/permanent-conditions.ts`, no en `lib/format.ts` | El catálogo y su label-helper son lo mismo. `lib/format.ts` puede re-exportarla si conviene a callers, pero la fuente está al lado del catálogo. Mismo patrón que `lib/breeds.ts` con `breedLabel`. |
| D4 | Cambios a `permanent_conditions` van por `pet_profile_updated` existente, no por un event_type nuevo | El cambio es una edición de perfil, no un evento clínico. `pet_profile_updated.changes` ya acepta cualquier `field: string`. |
| D5 | `PetAgentContext` se construye en server (no es una columna ni un view); `buildPetAgentContext` hace un SELECT a `pets` + computa labels | Cero overhead de DB. La forma del agente puede evolucionar sin migraciones. |
| D6 | `permanentConditionsLabel` (string pre-renderizado: `"Ciego, le falta una pata"`) sí va en el context, además del array crudo | El agente lo va a usar literalmente en su respuesta al usuario. Renderizarlo del lado server evita que el LLM lo haga mal. El array crudo queda para lógica de gating. |
| D7 | El sub-select de especie usa state local de React, NO va al backend como dos campos separados | El spec original ya lo decidió así. `formData.species` sale resuelto. |
| D8 | El form NO valida que las condiciones marcadas sean válidas para la especie elegida (filtrado UI suficiente); la acción de servidor sí | Mismo patrón que breed — el UI filtra, el servidor es la línea de defensa contra request manual. |
| D9 | No se agregan índices a `permanent_conditions` en esta iteración | Aún no hay surfaces que filtren por condición. Cuando aparezca `/adoptar?condicion=ciego` en una iteración futura, se agrega `gin (permanent_conditions)` en una migración chiquita. |
| D10 | `buildPetAgentContext` no se exporta a clients — sólo se usa en server components / route handlers | El context viaja como prop o como respuesta de un route handler. Nunca se reconstruye en cliente — eso garantiza que los labels sean los del server. |

## 3. Scope

**Dentro:**

- Catálogo + helpers de condición permanente.
- 3 columnas nuevas en `pets` + migración.
- Extensión del payload de `pet_registered`.
- Sub-select de especie + fieldset de condición permanente en `PetForm`.
- Toggle de privacidad pública.
- Render condicional en credencial pública.
- `PetAgentContext` + `buildPetAgentContext` en `lib/event-agent-registry.ts`.
- Tests de catálogo, de form-resolution, y de `buildPetAgentContext`.
- AGENTS.md pointer.

**Fuera:**

- Catálogos de vacuna / enfermedad / medicación para las nuevas especies.
- Filtros de búsqueda por condición permanente en `/adoptar` u org portal (ver D9).
- Cualquier UI de agente conversacional — sólo se prepara el contrato.
- Tres-bucket model (criadero / fauna silvestre) — sigue diferido como en el spec.
- Inscripción AAIP / PDP — la decisión de marcar como sensible se cumple a nivel UI default, no a nivel registry formal.

## 4. Plan paso a paso

Después de cada paso: `pnpm typecheck` + `pnpm lint`. Tests al final.

### Paso 1 — Crear `lib/permanent-conditions.ts`

Reusar la forma de `lib/lookups.ts` (export const arrays) y de `lib/breeds.ts` (helper que toma `species`). Tipos:

```ts
export type PermanentConditionCode =
  | "ciego" | "vision_reducida" | "sordo" | "audicion_reducida"
  | "tres_patas" | "miembro_no_funcional"
  | "paralisis_posterior" | "usa_carrito"
  | "incontinencia_urinaria" | "incontinencia_fecal"
  | "epilepsia" | "diabetes"
  | "fiv_positivo" | "felv_positivo"
  | "cardiopatia" | "cognitiva"
  | "otra";

export type PermanentConditionDef = {
  code: PermanentConditionCode;
  label: string;             // es-AR, owner-facing
  species: ReadonlyArray<"dog" | "cat" | "rabbit" | "guinea_pig" | "ferret" | "other" | "*">;
};

export const PERMANENT_CONDITIONS: ReadonlyArray<PermanentConditionDef>;

export function permanentConditionsForSpecies(species: string): ReadonlyArray<PermanentConditionDef>;
export function permanentConditionLabel(code: string): string;     // returns "Otra" or original code if unknown
export function permanentConditionsLabel(codes: ReadonlyArray<string>, otherText: string | null): string; // "Ciego, le falta una pata, Otra: cojea de la derecha"
```

Items y filtrado por especie: ver tabla del spec §"The list (v1)". `"*"` significa todas las especies.

### Paso 2 — Migración de schema

Editar `db/schema.ts`, dentro del bloque de `pets`, justo abajo de `knownAllergies`:

```ts
// Permanent conditions — spec 2026-05-17 additional-species §"Permanent
// conditions". Owner-facing functional state of the animal (sensory loss,
// missing limb, chronic condition). Codes validated against
// lib/permanent-conditions.ts at write time; the column is free text[] for
// forward compatibility. "otra" → permanentConditionsOther holds the free text.
permanentConditions: text("permanent_conditions").array().notNull().default(sql`'{}'::text[]`),
permanentConditionsOther: text("permanent_conditions_other"),
// Privacy preference — Tier 1 by default per PDP Art. 7. UI preference: a flip
// does NOT emit pet_profile_updated, mirror of the disclose_*_when_lost block.
discloseConditionsPublicly: boolean("disclose_conditions_publicly").notNull().default(false),
```

Generar migración: `pnpm db:generate`. Inspeccionar el SQL generado bajo `db/migrations/`; debe ser un `ALTER TABLE pets ADD COLUMN ...` con los defaults. Si Drizzle no usa la sintaxis `'{}'::text[]`, dejarlo en lo que genere — `ARRAY[]::text[]` también es válido. No tocar a mano salvo para corregir un default que rompa.

### Paso 3 — Extender `lib/event-schemas.ts`

En `petRegistered`, después de `known_allergies`:

```ts
permanent_conditions: z.array(z.string()),
permanent_conditions_other: z.string().nullable(),
```

NO usar `z.enum` con los códigos del catálogo — el spec dice "validated against catalog at write time, schema stays free-string" (mismo posture que `species`). El strict object ya bloquea claves desconocidas, eso alcanza.

`petProfileUpdated` no necesita cambio — `changes[].field` es `z.string()`. El writer de la acción de edición pasará `field: "permanent_conditions"` cuando el array cambie.

### Paso 4 — `lib/format.ts`

Agregar a `speciesLabel`:

```ts
case "rabbit": return "Conejo";
case "guinea_pig": return "Cobayo";
case "ferret": return "Hurón";
```

Re-exportar (opcional, depende de cuántos callers haya):

```ts
export { permanentConditionLabel } from "./permanent-conditions";
```

### Paso 5 — `components/PetForm.tsx`

Dos cambios independientes en este archivo:

**A. Sub-select de especie.** Ya está descripto en el spec §"User-facing behavior". State local: `subSpecies: "rabbit" | "guinea_pig" | "ferret" | "other" | null`. Al cambiar el top-select a algo que no sea `Otra`, `setSubSpecies(null)`. Resolución a `formData.species` antes del submit. En edición, hidratar correctamente.

**B. Fieldset de condición permanente.** Debajo del textarea `distinguishingFeatures`, antes del bloque de microchip. Multi-select de checkboxes con un input de texto libre que aparece cuando `otra` está marcado. Filtrar items por `permanentConditionsForSpecies(formData.species)`. Cuando el usuario cambia la especie y deja inválido un código marcado, no avisar — silenciosamente dropear el código del state al submit (`.filter(code => allowedCodes.has(code))`).

Debajo del fieldset, un solo checkbox:

```
[ ] Mostrar esta información en mi credencial pública (/p/...)
    Por defecto la condición sólo es visible para vos y profesionales autorizados.
```

Wired a `disclose_conditions_publicly`. Sólo se muestra si hay al menos una condición marcada — evita ruido cuando no aplica.

### Paso 6 — Acción de creación / edición de mascota

Buscar dónde se crea la mascota (`createPetAction` o equivalente — el spec dice ya está normalizado para escribir el `petRegistered` shape). Sumar al insert:

```ts
permanentConditions: validateConditions(input.permanentConditions, input.species),
permanentConditionsOther: input.permanentConditions.includes("otra") ? input.permanentConditionsOther : null,
discloseConditionsPublicly: input.discloseConditionsPublicly,
```

donde `validateConditions` es un helper local: filtra contra `permanentConditionsForSpecies(species)` y descarta lo que no aplique. Garantiza que un request curl manual no meta `fiv_positivo` en un cobayo.

El payload de `pet_registered` que ya se construye al lado del insert debe sumar:

```ts
permanent_conditions: validatedConditions,
permanent_conditions_other: ...,
```

Para la edición (`updatePetAction` o equivalente), cuando el array nuevo difiere del viejo, emitir un `pet_profile_updated` con un entry en `changes`:

```ts
{ field: "permanent_conditions", old: oldArray, new: newArray }
```

`disclose_conditions_publicly` es UI preference — NO emite `pet_profile_updated`. Mismo posture que `emergency_info_visible` (ver `db/schema.ts` line ~417).

### Paso 7 — Render en credencial pública

`app/p/[publicToken]/page.tsx`. Después del bloque del nombre / foto y antes del bloque de microchip, agregar:

```tsx
{pet.discloseConditionsPublicly && pet.permanentConditions.length > 0 && (
  <p className="text-sm text-muted-foreground">
    <span className="font-medium">Condición permanente:</span>{" "}
    {permanentConditionsLabel(pet.permanentConditions, pet.permanentConditionsOther)}
  </p>
)}
```

Inline, sin banner — no es un derecho de acceso, es una descripción del animal.

### Paso 8 — `PetAgentContext` en `lib/event-agent-registry.ts`

Agregar abajo del `buildAgentDeeplink`:

```ts
import { permanentConditionsLabel } from "./permanent-conditions";
import { speciesLabel } from "./format";
import { db } from "@/db";
import { pets } from "@/db/schema";
import { eq } from "drizzle-orm";

export type PetAgentContext = {
  publicToken: string;
  name: string;
  species: "dog" | "cat" | "rabbit" | "guinea_pig" | "ferret" | "other";
  speciesLabel: string;
  breed: string | null;
  sex: "male" | "female" | "unknown";
  color: string | null;
  ageYears: number | null;
  birthDateIsEstimated: boolean;
  microchipId: string | null;
  microchipCountryCode: string | null;

  distinguishingFeatures: string | null;
  permanentConditions: ReadonlyArray<string>;
  permanentConditionsOther: string | null;
  permanentConditionsLabel: string;
  estimatedWeightKg: string | null;
  trainingLevel: string | null;
  favouriteFoods: ReadonlyArray<string>;
  knownAllergies: ReadonlyArray<string>;

  status: string;
  isDeceased: boolean;
  inCustodyDispute: boolean;
  rabiesObservationActive: boolean;

  potentiallyDangerousBreed: boolean;
};

/**
 * Server-only. Builds the working context the conversational event agent
 * receives at conversation boot for a given pet. Pre-renders labels so the
 * LLM doesn't reinvent them. The output is the stable contract between DIM
 * and the agent — adding fields here is a contract change. See spec
 * docs/superpowers/specs/2026-05-17-additional-species-design.md
 * §"How the pet is registered and described in the datamodel — for the
 * Conversational event agent".
 */
export async function buildPetAgentContext(petId: string): Promise<PetAgentContext | null> {
  const row = await db.query.pets.findFirst({ where: eq(pets.id, petId) });
  if (!row) return null;

  const ageYears = row.dateOfBirth
    ? Math.floor((Date.now() - new Date(row.dateOfBirth).getTime()) / (1000 * 60 * 60 * 24 * 365.25))
    : null;

  return {
    publicToken: row.publicToken,
    name: row.name,
    species: (row.species ?? "other") as PetAgentContext["species"],
    speciesLabel: speciesLabel(row.species),
    breed: row.breed,
    sex: row.sex,
    color: row.color,
    ageYears,
    birthDateIsEstimated: row.birthDateIsEstimated,
    microchipId: row.microchipId,
    microchipCountryCode: row.microchipCountryCode,

    distinguishingFeatures: row.distinguishingFeatures,
    permanentConditions: row.permanentConditions ?? [],
    permanentConditionsOther: row.permanentConditionsOther,
    permanentConditionsLabel: permanentConditionsLabel(
      row.permanentConditions ?? [],
      row.permanentConditionsOther,
    ),
    estimatedWeightKg: row.estimatedWeightKg,
    trainingLevel: row.trainingLevel,
    favouriteFoods: row.favouriteFoods ?? [],
    knownAllergies: row.knownAllergies ?? [],

    status: row.status,
    isDeceased: row.status === "deceased",
    inCustodyDispute: row.inCustodyDispute,
    rabiesObservationActive: row.rabiesObservationStatus !== null
      && row.rabiesObservationStatus !== ""
      && !row.rabiesObservationStatus.startsWith("completed_"),

    potentiallyDangerousBreed: row.potentiallyDangerousBreed,
  };
}
```

Notas:

- No se agrega `buildPetAgentContext` al `EVENT_AGENT_REGISTRY` — son cosas distintas (uno mapea event_types a forms, el otro proyecta el pet). Conviven en el mismo archivo porque ambos son contrato con el agente.
- Si `species` no está en la unión válida (datos viejos free-text), tipear con `as` está OK — la unión cubre los códigos que escribe la app. Render via `speciesLabel` que ya tiene fallback.

### Paso 9 — Tests

Crear o extender:

1. **`lib/permanent-conditions.test.ts`** (nuevo):
   - `permanentConditionsForSpecies("cat")` incluye `fiv_positivo` y `felv_positivo`.
   - `permanentConditionsForSpecies("guinea_pig")` no incluye `fiv_positivo`.
   - `permanentConditionsForSpecies("dog")` incluye `epilepsia`, `diabetes`, `tres_patas`.
   - `permanentConditionLabel("ciego") === "Ciego"`.
   - `permanentConditionsLabel(["ciego", "tres_patas"], null) === "Ciego, le falta una pata"`.
   - `permanentConditionsLabel(["otra"], "cojea de la derecha")` incluye `"cojea de la derecha"`.

2. **`lib/event-agent-registry.test.ts`** (extender): no tocar el test existente. Agregar:
   - Un test que con un pet seedeado vía drizzle (use el mismo helper de test que ya use el repo — ver tests existentes para el patrón), `buildPetAgentContext(petId)` retorna el shape esperado con `permanentConditionsLabel` pre-renderizado.

3. **`components/PetForm.test.tsx`** (si existe; si no, no inventes uno):
   - Seleccionar `Otra → Conejo` resuelve `formData.species === "rabbit"`.
   - Marcar `ciego` + `tres_patas` y submit envía `permanent_conditions: ["ciego", "tres_patas"]`.
   - Cambiar especie de `cat` a `dog` después de marcar `fiv_positivo` resulta en submit sin `fiv_positivo`.

Si la convención del repo es co-locar tests en `__tests__/`, seguila — ver carpeta `__tests__/` ya existente.

### Paso 10 — AGENTS.md

Buscar la entrada "Conversational event-capture agent" en "Open questions / future work". Al final agregar:

> *El contrato de **qué ve el agente sobre la mascota** vive en `lib/event-agent-registry.ts` como el type `PetAgentContext` + el helper `buildPetAgentContext(petId)`. Es la contraparte pet-side de `EVENT_AGENT_REGISTRY` (event-side). Agregar campos a `PetAgentContext` es un cambio de contrato — documentarlo en el spec correspondiente.*

## 5. Tests (consolidado)

Ya enumerados en Paso 9. `pnpm test` debe quedar verde después del último paso. Si `buildPetAgentContext` necesita una DB de test, replicar el setup que use el resto de tests del lib/ (ver `lib/libreta-sanitaria.test.ts` para el patrón).

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Owners con mascotas ya registradas no ven el nuevo campo hasta editar | Aceptable — el array empieza vacío para todos los rows viejos vía default `'{}'`. La edición sumará el campo orgánicamente. |
| El LLM del agente alucina condiciones que no están en el catálogo | El contrato del agente sólo *recibe* `permanentConditions` (lectura); las mutaciones futuras irán por el form existente vía deeplink con `buildAgentDeeplink`. No hay path por el cual el agente escriba directamente a `pets.permanent_conditions`. |
| `discloseConditionsPublicly` se prende por accidente | Default `false`, el checkbox aparece sólo cuando hay condiciones marcadas, el copy es explícito sobre qué pasa. |
| Drift entre el catálogo de condiciones y los códigos que aparecen en `pets.permanent_conditions` después de un rename | Mismo riesgo que `lib/breeds.ts` con razas PPP — convivimos. Si renombramos un código, agregamos un mapping de retrocompatibilidad en `permanentConditionLabel`. |
| Cambiar la forma de `PetAgentContext` rompe el agente cuando exista | Documentar en AGENTS.md (Paso 10) que es contrato. Cualquier cambio futuro entra por un spec. |

## 7. Out of scope (recordatorio explícito)

- Catálogos de vacuna / enfermedad / medicación para conejo / cobayo / hurón.
- Surfaces de búsqueda que filtren por condición (`/adoptar?condicion=ciego`).
- Cualquier código de UI de agente conversacional — sólo se prepara el contrato.
- Three-bucket model (criadero / fauna silvestre).
- Service-dog block (`pet_service_dog`) — el spec lo describe, pero NO entra en este plan; va en una plan-card aparte porque la complejidad (RUPGA, ANDIS, banner público, opt-in privacy) merece su propio enfoque.

## 8. Commit message

```
feat(species,agent): additional species + permanent conditions + PetAgentContext

Adds rabbit / guinea_pig / ferret as first-class species values plus the
"Condición permanente" multi-select (ciego, sordo, tres_patas, FIV+, etc.)
backed by a new catalog at lib/permanent-conditions.ts. Three new columns
on pets: permanent_conditions text[], permanent_conditions_other,
disclose_conditions_publicly. Public credential renders the conditions
only when explicitly opted in (Tier 1 by default, Art. 7 Ley 25.326).

Also exposes the pet to the future conversational event agent via the
new PetAgentContext type + buildPetAgentContext(petId) helper in
lib/event-agent-registry.ts. This is the pet-side contract that pairs
with the event-side EVENT_AGENT_REGISTRY already in place. Adding fields
to PetAgentContext is a contract change — see AGENTS.md.

Spec: docs/superpowers/specs/2026-05-17-additional-species-design.md
```
