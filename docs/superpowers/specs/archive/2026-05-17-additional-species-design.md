# Additional Species — Design

**Date:** 2026-05-17
**Surface:** `components/PetForm.tsx`, `lib/format.ts`
**Status:** Approved — ready for implementation plan

## Context

DIM currently supports three species values: `dog`, `cat`, and `other`. The `species` column is free-text in `db/schema.ts`, but every catalog (`lib/breeds.ts`, `lib/diseases.ts`, `lib/vaccines.ts`, `lib/drugs.ts`) and every species-aware form branch is hard-keyed on `"dog" | "cat"`. Choosing `Otra` today produces a working but catalog-less profile.

We want a low-risk first step that adds a handful of additional companion species without touching the legal-framework / wildlife-under-custody work, which is deferred (see "Future work" below).

The three species added in this iteration — **conejo (rabbit)**, **cobayo (guinea pig)** and **hurón (ferret)** — are domesticated mammals whose owner-facing form needs are nearly identical to dogs and cats: name, sex, date of birth, weight, microchip (optional), allergies, foods, observations. They reuse the existing `PetForm` shape without modification.

This is the smallest unit that delivers value: dropdown only, no new catalogs, no PPP changes, no schema migration. Vaccine / disease / medication catalogs for these species are intentionally **out of scope** for this iteration and will be filled in once we wire each species to its real sanitary regime.

## User-facing behavior

The species select in `PetForm.tsx` stays a single visible field with three top-level options:

```
Especie:  [ Perro ▾ ]
          - Perro
          - Gato
          - Otra
```

When the user picks **Otra**, a second `<select>` appears immediately below it:

```
Especie:        [ Otra ▾ ]
Tipo de "otra": [ Elegí una ▾ ]
                - Conejo
                - Cobayo
                - Hurón
                - Otro / no listado
```

Behavior:

- The visible value submitted in `formData.species` is the *resolved* species: `rabbit`, `guinea_pig`, `ferret`, or `other`.
- Picking **Otro / no listado** falls back to today's behavior — the stored species is `other` and we render the same `Otra` label everywhere.
- The two selects are wired together with local React state; switching the top select away from `Otra` clears the sub-select.
- On edit, if the stored species is `rabbit | guinea_pig | ferret`, the top select shows `Otra` and the sub-select preselects the right value.
- No new validation rules. Both selects are required when species = `Otra`; the sub-select having no value blocks the form with the existing "Falta la especie." message.

`lib/format.ts` `speciesLabel` adds three new cases (`rabbit → "Conejo"`, `guinea_pig → "Cobayo"`, `ferret → "Hurón"`) so every read site renders the right Spanish label without any other change.

## Permanent conditions ("Condición permanente")

Owners frequently identify their pet by a permanent condition before they identify it by breed: *"el gato ciego", "la perra de tres patas", "el conejo sordo"*. Today DIM has no first-class field for this; owners type it into `distinguishing_features` (free text) and the data is unsearchable. The conversational event agent has the same problem: when the user says "mi perra que no escucha bien", the agent can't match the pet by anything other than name + fuzzy text.

This iteration adds a structured, multi-select list of permanent conditions to the pet record. The list is intentionally short, functional (what the animal *can't* do), and worded the way an owner would say it — not a clinical diagnosis.

### Why "permanente" matters as a separate concept

DIM already models three adjacent things that are NOT this:

- **`pet_events` of type `disease_diagnosed`** — an acute or chronic clinical diagnosis with onset, treatment and remission. This is a *clinical* axis: who diagnosed it, when, what therapy. Many diseases resolve.
- **`acceptsChronicConditions` (foster volunteers) / `hasChronic` (pets in foster-matching)** — opaque boolean used to gate matching. Says "this pet is high-maintenance" without saying what's wrong.
- **`service_dog` block (Ley 26.858)** — describes the *human's* disability indirectly. The dog is healthy; the credential is the asset.

The new field describes a **permanent functional state of the animal itself** (sensory loss, missing limb, paralysis, viral status that doesn't clear). It is durable — owners do not "cure" their pet's deafness — and it is exactly the axis the owner uses to describe the animal in conversation.

### Legal framework — what regulates this in Argentina

Short answer: **nothing directly**. Long answer, recorded here for the same reason the species section recorded its legal scaffolding:

- **Ley 14.346 (1954) — malos tratos.** Protects the animal generically. Doesn't enumerate conditions, but reinforces that *abandoning a pet because it became disabled* is an actionable maltrato. The presence of the field in DIM is a quiet adoption-incentive lever (shelters can filter `permanent_conditions IS NOT NULL` and surface special-needs pets).
- **Proyecto Ley de Bienestar Animal — Bs As Legislatura 210182** + national projects. Expand Ley 14.346 with the *cinco libertades* (FAWC 1979): libre de hambre y sed, de disconfort, de dolor/lesión/enfermedad, de miedo y angustia, libre para expresar comportamiento normal. None of the in-trámite drafts enumerates a disability taxonomy; if any are sanctioned, our list is the natural place to map their language. Not binding today.
- **SENASA — Auto-Gestión Mascotas** (`mascotas.senasa.gob.ar`). Captures `Especie / Raza / Edad / Sexo / Condición: Entero-Castrado / Peso / Microchip`. The word "Condición" there is *reproductive* status — entero vs. castrado — **not** disability. No SENASA registry of permanent conditions exists today. If SENASA ever extends, our list will need to map onto theirs.
- **Ley 25.326 — PDP, Art. 7 (datos sensibles).** Esto sí es vinculante. *Los datos de salud son sensibles.* La salud del animal no es dato sensible del animal (los animales no son sujetos de la ley) pero **revelar condiciones permanentes específicas en la credencial pública puede inferir información del titular** (un dueño de perro guía con CUD es lectura directa; un dueño que sólo adopta animales seropositivos también revela posicionamiento personal). Tratamiento: el campo es **Tier 1 por defecto** — visible al dueño y a profesionales autorizados, **NO** visible en `/p/[publicToken]` salvo opt-in explícito por condición. Mismo patrón que `service_dog.public_visibility`.
- **Ley 26.858 + Decreto 792/2019.** Tangencial: la sección service-dog ya define un perfil con condiciones higiénico-sanitarias. La lista de "condición permanente" del animal NO se solapa con la discapacidad del titular — son ejes distintos. Documentado acá para que el día de mañana no se mezclen.

No hay base de datos pública nacional ni provincial que enumere taxonomía de discapacidades animales. La elección de items abajo se basa en la práctica clínica veterinaria estándar y en los formularios de refugios (special-needs adoption forms).

### The list (v1)

Each item has a stable code (used in `permanent_conditions` array on `pets` and in `pet_registered` payload), an es-AR owner-facing label, and the species it can apply to. The form is multi-select; an animal can be `ciego` *and* `sordo` *and* `tres_patas` simultaneously — common combination after trauma.

| Code | Label (es-AR) | Applies to | Notes |
|---|---|---|---|
| `ciego` | Ciego (no ve) | all | Bilateral total. Use `vision_reducida` for partial. |
| `vision_reducida` | Visión reducida (ve poco) | all | Catarata, glaucoma, atrofia. |
| `sordo` | Sordo (no oye) | all | Bilateral total. Use `audicion_reducida` for partial. |
| `audicion_reducida` | Audición reducida | all | |
| `tres_patas` | Le falta una pata | all | Amputación, generic. |
| `miembro_no_funcional` | Tiene un miembro que no usa | all | Parálisis localizada, lesión nerviosa, malformación congénita — la pata está pero no la usa. |
| `paralisis_posterior` | Parálisis del tren posterior | dog, cat, rabbit, guinea_pig, ferret | Megacolon felino, mielopatía, post-trauma. Suele acompañarse de carrito. |
| `usa_carrito` | Usa silla / carrito | dog, cat, rabbit, ferret | UI hint — derivable de parálisis pero útil declararlo explícito. |
| `incontinencia_urinaria` | Incontinencia urinaria | dog, cat, rabbit, ferret | |
| `incontinencia_fecal` | Incontinencia fecal | dog, cat, rabbit, ferret | |
| `epilepsia` | Epilepsia | dog, cat, ferret | Manejada con medicación de por vida — durable, no episódica. |
| `diabetes` | Diabetes | dog, cat, ferret | Insulino-dependiente de por vida. |
| `fiv_positivo` | FIV positivo | cat | "Sida felino". Vive bien con manejo. |
| `felv_positivo` | FeLV positivo | cat | Leucemia felina. |
| `cardiopatia` | Cardiopatía crónica | dog, cat, ferret | Cualquier patología cardíaca diagnosticada que requiera manejo de por vida. |
| `cognitiva` | Deterioro cognitivo (CDS) | dog, cat | Disfunción cognitiva canina/felina senior. |
| `otra` | Otra condición permanente | all | Free-text en `permanent_conditions_other`. |

Picking `otra` reveals a free-text input — same pattern as `acquisition_method = "other"`.

### Datamodel changes

```ts
// db/schema.ts → pets table, new columns
permanentConditions: text("permanent_conditions").array().notNull().default(sql`'{}'::text[]`),
permanentConditionsOther: text("permanent_conditions_other"),
// Privacy posture for the public credential. Mirrors the "discloseXWhenLost"
// pattern. Defaults to false — Tier 1 by default per PDP Art. 7 reasoning above.
discloseConditionsPublicly: boolean("disclose_conditions_publicly").notNull().default(false),
```

No new event type. Updates to permanent conditions flow through the existing `pet_profile_updated` event (already a `changes[]` array — the field name appears as `permanent_conditions`).

Adding to `pet_registered` payload (event-schemas.ts):

```ts
permanent_conditions: z.array(z.string()),
permanent_conditions_other: z.string().nullable(),
```

Both are validated against the catalog at write time in the action, not at the schema layer — same posture as `species` (free-text in DB, catalog-validated in app).

### Catalog file

New file `lib/permanent-conditions.ts`:

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
  label: string;
  species: ReadonlyArray<string>; // ["*"] = all
};

export const PERMANENT_CONDITIONS: ReadonlyArray<PermanentConditionDef> = [
  // ...as in the table above
];

export function permanentConditionsForSpecies(species: string): ReadonlyArray<PermanentConditionDef>;
export function permanentConditionLabel(code: string): string;
```

`speciesLabel` lives in `lib/format.ts`; `permanentConditionLabel` mirrors that pattern.

### UI

In `PetForm.tsx`, below the existing `distinguishingFeatures` textarea, add a new fieldset:

```
Condición permanente (opcional, podés elegir varias):
  [ ] Ciego
  [ ] Sordo
  [ ] Le falta una pata
  [ ] Tiene un miembro que no usa
  ...
  [ ] Otra → [ free text ]
```

Items are filtered by `permanentConditionsForSpecies(formData.species)` so a cobayo doesn't see `fiv_positivo`. If species changes mid-form to one where a checked condition doesn't apply (e.g. user picked `fiv_positivo`, then switched species from `cat` to `dog`), the form silently drops the now-invalid codes on submit — same posture as breed when switching species.

Below the list, a single privacy toggle:

```
[ ] Mostrar esta información en mi credencial pública (/p/...)
    Por defecto la condición sólo es visible para vos y profesionales autorizados.
```

Maps to `discloseConditionsPublicly`.

### Public credential

When `discloseConditionsPublicly = true` AND the array is non-empty, render under the photo:

> **Condición permanente:** Ciego, le falta una pata.

No banner styling — plain inline text. We're describing the animal, not making a claim about access rights.

When false, nothing renders. The field is still visible to the owner on `/mis-mascotas/[publicToken]` and to authorized professionals via the org portal.

## How the pet is registered and described in the datamodel — for the Conversational event agent

This section is here because the conversational event agent (see `AGENTS.md → Open questions / future work → "Conversational event-capture agent"` and the operational registry in `lib/event-agent-registry.ts`) needs an unambiguous answer to two questions every time the user opens it:

1. **"What pet are we talking about?"** — disambiguation when the owner has more than one.
2. **"What does the agent know about this pet so it can prefill the right slots?"** — i.e. which fields on the pet row are part of the agent's working memory.

Both answers depend on the *shape* of the pet record, not on the event being captured. This section freezes that shape so the agent has a stable contract regardless of which species + condition combination the owner registers.

### Where the pet lives

The pet is a row in the `pets` table (`db/schema.ts`, ≈ line 360). The canonical handle the agent uses is `publicToken` (the short URL-safe token like `DIM-3K4F-9P2X`), **not** the UUID `id` — every deeplink built by `buildAgentDeeplink(eventType, publicToken, slots)` interpolates `publicToken` into the route. The UUID is internal.

The registration event itself is `pet_registered` in `pet_events`, whose payload is validated by `petRegistered` in `lib/event-schemas.ts`. The payload mirrors the pets-row shape at registration time; subsequent owner edits flow through `pet_profile_updated` events (`changes[]` array of `{field, old, new}` records). The pet row is the *projection* of these events for the agent's purposes.

### The fields the agent sees

The agent should treat the following columns as its working set when describing or disambiguating a pet. Grouped by purpose. Field names below are the **camelCase Drizzle names**; the DB columns are snake_case (`speciesLabel` ↔ `species`).

**Identity (used to find the right pet in conversation):**

- `publicToken` — primary handle. Always present.
- `name` — what the owner calls the pet. Always present.
- `species` — `dog | cat | rabbit | guinea_pig | ferret | other`. After this iteration, the agent must accept all six values. Render via `speciesLabel()` in `lib/format.ts`.
- `breed` — free text, nullable. Optional disambiguator.
- `sex` — `male | female | unknown`.
- `color` — free text, nullable. Disambiguator.
- `dateOfBirth` + `birthDateIsEstimated` — for age inference. Agent computes age relative to *today*, not registration day.
- `microchipId` + `microchipCountryCode` — fully qualified chip number. ISO 11784/11785 (15 digits, `microchipCountryCode` typically `858` for AR). Useful for "el chip de Luna" intent matching.

**Description (used to describe the pet back to the user, and as context for slot prefill):**

- `distinguishingFeatures` — free text. Lives alongside `permanentConditions` but is *appearance*, not *function* (markings, scars, coat).
- `permanentConditions` — `text[]`, values from `PERMANENT_CONDITIONS` in `lib/permanent-conditions.ts`. **NEW THIS SPEC.** Render via `permanentConditionLabel()`. The agent uses these to (a) recognize when the owner says "mi perra ciega", (b) avoid suggesting incompatible events (e.g. don't propose "agregar entrenamiento avanzado" to an animal with `paralisis_posterior`).
- `permanentConditionsOther` — free-text complement when the array contains `"otra"`. **NEW THIS SPEC.**
- `estimatedWeightKg` — last reported weight. Cached projection of `weight_recorded` events. The agent prefills the `kg` slot of the weight form with this value when the user says "registrar pesaje" without giving a number.
- `trainingLevel` — `none | basic | intermediate | advanced | professional`.
- `favouriteFoods` / `knownAllergies` — free-text arrays. Agent should NOT autocomplete these from the catalog; they're owner-known facts.

**Status (used to gate which events make sense to propose):**

- `status` — `active | lost | deceased | transferred | …`. If `deceased`, agent refuses every event except read-only history.
- `deceasedAt` — timestamp when `status = deceased`.
- `inCustodyDispute` — boolean. Agent should warn the user and not propose transfers/adoption when true.
- `rabiesObservationStatus` — non-null when a 10-day rabies observation is active. Agent surfaces this prominently.

**Compliance flags (used for warnings, never for hiding):**

- `potentiallyDangerousBreed` — boolean (PPP, Ley CABA 4078 / Bs As 14.107). Agent should remind on relevant events (microchip implant, insurance update) but never refuse.
- `adoptionEligible` / `adoptionIneligibleReason` — for adoption-flow disambiguation. Out of scope for owner agent, in scope for org agent.

**Privacy preferences (read-only for the agent; never a slot it prefills):**

- `emergencyInfoVisible`
- `discloseFirstNameWhenLost` / `disclosePhoneWhenLost` / `discloseEmailWhenLost` / `discloseLastLocationWhenLost` / `allowFinderFormWhenLost`
- `discloseConditionsPublicly` — **NEW THIS SPEC.** Set via the owner-facing toggle in PetForm, never via the agent.

The agent **must not** propose events that would flip privacy flags. Those are UI preferences, not events.

### What the agent receives at conversation boot

When the owner opens the agent on their pet (entry from `/mis-mascotas/[publicToken]/agente`, future surface), the server passes a `PetAgentContext` shaped exactly like the field list above. Concretely:

```ts
// lib/event-agent-registry.ts (extension this spec implies)
export type PetAgentContext = {
  // Identity
  publicToken: string;
  name: string;
  species: "dog" | "cat" | "rabbit" | "guinea_pig" | "ferret" | "other";
  speciesLabel: string;             // pre-resolved via lib/format.ts
  breed: string | null;
  sex: "male" | "female" | "unknown";
  color: string | null;
  ageYears: number | null;          // computed from dateOfBirth
  birthDateIsEstimated: boolean;
  microchipId: string | null;
  microchipCountryCode: string | null;

  // Description
  distinguishingFeatures: string | null;
  permanentConditions: ReadonlyArray<PermanentConditionCode>;
  permanentConditionsOther: string | null;
  permanentConditionsLabel: string; // pre-rendered "Ciego, le falta una pata"
  estimatedWeightKg: string | null;
  trainingLevel: string | null;
  favouriteFoods: ReadonlyArray<string>;
  knownAllergies: ReadonlyArray<string>;

  // Status
  status: string;
  isDeceased: boolean;
  inCustodyDispute: boolean;
  rabiesObservationActive: boolean;

  // Flags (warnings only)
  potentiallyDangerousBreed: boolean;
};
```

This shape is **not** a new event type. It is a server-rendered context object passed alongside the registry from a new helper (`buildPetAgentContext(petId)`). The registry stays the same; the context is what tells the agent *which pet* it is reasoning about so `buildAgentDeeplink` can be called with the right `publicToken`.

Adding `permanentConditions` to the context is the deliverable that ties this spec to the agent's contract.

### Disambiguation rule

If the owner has more than one pet and refers to one ambiguously ("mi perra"), the agent disambiguates in this order, stopping at the first unique match:

1. `name` (case-insensitive, normalized).
2. `species`.
3. `permanentConditions` (e.g. "mi gata ciega" → unique if only one cat has `"ciego"`).
4. `breed`.
5. `color`.
6. Microchip last 4 digits if the user volunteered them.

If still ambiguous, the agent asks. It does **not** guess.

### Forward-compat note

Two predictable next species (`ave_jaula`, `pez_ornamental`, `tortuga`) and any future condition (`obesidad_morbida`, `hipotiroidismo_cronico`) will plug into this shape without breaking the agent contract. The contract is the *names of the fields*, not their value sets. Add new species/condition codes to the catalogs; the agent inherits them for free.

## Out of scope (explicitly deferred)

- **Breed catalogs** for the new species. Rabbits and cobayos do have breeds (Belier, Toy, Peruano, Abisinio…), but the breed field stays free-text for now. Hurones effectively have no breed.
- **Vaccine catalog entries** for the new species (myxomatosis + RHDV2 for conejo; distemper + rabies for hurón). The vaccine form's "vaccinesForSpecies" will return `[]` and the owner sees a free-text vaccine name field. Acceptable.
- **Disease catalog entries** for reportable zoonoses (rabbit hemorrhagic disease, leptospirosis in rodents, canine distemper in hurón). Death-record form's catalog will return `[]`; free-text path still works.
- **Medication catalog entries** — same reasoning.
- **PPP / dangerous-breed logic.** `isPotentiallyDangerousBreed` already returns `false` when `species !== "dog"`. No change.
- **Schema constraint.** `species` stays free-text. A CHECK constraint / enum is intentionally deferred until the full species list stabilises after the three-bucket work below.
- **Three-bucket model** (companion / regulated criadero / wildlife under custody) — deferred to a separate plan. The selection of `rabbit | guinea_pig | ferret` here implicitly treats them as companion animals, which is correct under Argentine law (see "Legal framework" below).
- **SENASA RENSPA bridge** for livestock species (llama, alpaca, equino, gallina). Out of scope — those are not companion animals and belong on a different ingestion path when the time comes.
- **Fauna silvestre as "pet"** (carpincho, coatí, mono, yacaré, tortuga terrestre autóctona, loro hablador sin anillado, etc.). Explicitly excluded — adding any of these to the *owner* portal would normalize illegal possession. The right home for those is a future `wildlife_custody` capability on the org portal (`refugio`).

## Architecture

### File changes

| File | Status | Role |
|---|---|---|
| `components/PetForm.tsx` | modified | Adds local state for sub-species. Renders the conditional second `<select>`. Resolves the final value passed in `formData.species`. Renders the new `permanent_conditions` multi-select fieldset below `distinguishing_features`. |
| `lib/format.ts` | modified | Adds three new cases to `speciesLabel`. Adds `permanentConditionLabel`. |
| `lib/permanent-conditions.ts` | new | Catalog + `permanentConditionsForSpecies(species)` helper. See "Permanent conditions" section above. |
| `db/schema.ts` | modified | Adds `permanentConditions`, `permanentConditionsOther`, `discloseConditionsPublicly` to `pets`. Generates a new Drizzle migration. |
| `lib/event-schemas.ts` | modified | Extends `petRegistered` payload with `permanent_conditions[]` + `permanent_conditions_other`. Extends `petProfileUpdated.changes` to allow `"permanent_conditions"` field name (the schema already accepts any `field: string`, no change there — only the writer needs to populate it). |
| `lib/event-agent-registry.ts` | modified | Exports `PetAgentContext` type and `buildPetAgentContext(petId)` helper as defined in the agent-contract section above. Existing `EVENT_AGENT_REGISTRY` table is untouched. |

The DB migration is the one new file under `db/migrations/`. No new tests are required beyond the existing PetForm coverage, but four targeted unit tests are added: (1) field-resolution: selecting `Otra → Conejo` submits `species = "rabbit"`; (2) `permanentConditionsForSpecies("cat")` includes `fiv_positivo` and excludes nothing dog-specific; (3) `permanentConditionsForSpecies("guinea_pig")` excludes `fiv_positivo`; (4) `buildPetAgentContext` returns the agent-context shape with `permanentConditionsLabel` correctly pre-rendered.

### Stored value mapping

| Top select | Sub-select | `formData.species` |
|---|---|---|
| Perro | (n/a) | `dog` |
| Gato | (n/a) | `cat` |
| Otra | Conejo | `rabbit` |
| Otra | Cobayo | `guinea_pig` |
| Otra | Hurón | `ferret` |
| Otra | Otro / no listado | `other` |

The catalog helpers (`vaccinesForSpecies`, etc.) keep their current switches; the three new values simply hit the default branch and return `[]`. This is acceptable for v1.

## Legal framework — pointers for future work

These are intentionally **not** enforced in code yet, but recorded here so that when we move beyond the "everything is a companion animal" assumption we know exactly where to look. None of this changes behavior in this iteration.

### National

- **Ley 22.421 (1981) — Conservación de la Fauna Silvestre.** Defines what counts as fauna silvestre and regulates tenencia, posesión, tránsito, comercio. The spine of the legal regime for everything that isn't a domesticated species. Companion species in this iteration (conejo, cobayo, hurón, perro, gato) are *not* fauna silvestre under this law — no permit needed.
- **Decreto 666/1997** — reglamento of Ley 22.421. Defines criaderos comerciales, zoocriaderos, anillado/marcado, *certificado de origen* and *guía de tránsito*. The mechanism we'd integrate against if we ever add "regulated criadero" species (loro hablador, iguana, boa, tortuga de criadero).
- **Ley 22.344 (1980) — CITES (Convenio de Washington).** Restricts international trade in listed species. Will matter the day we model anything with international provenance.
- **Ley 14.346 (1954) — malos tratos.** Penal protection of all animals. Tangential to species selection but in scope for cruelty-related event types (already covered conceptually).
- **SENASA — Auto-Gestión Mascotas** (`mascotas.senasa.gob.ar`). National sanitary authority. Owns dog/cat import/export and rabies surveillance. The natural integration target for a future Mi Argentina bridge.
- **SENASA — RENSPA.** Productive-animal registry. Llamas, alpacas, equinos, gallinas live here — *not* in the pet registry. Relevant if we ever extend DIM to camelids or equinos.
- **Dirección Nacional de Biodiversidad (Ministerio de Ambiente).** Wildlife authority. CITES national focal point. Counterparty for any future `wildlife_custody` flows.

### Provincial (PPP already enforced)

- **Ciudad Autónoma de Buenos Aires — Ley 4.078** (perros potencialmente peligrosos). Already enforced in `lib/breeds.ts` via `isPotentiallyDangerousBreed`.
- **Provincia de Buenos Aires — Ley 14.107** (PPP provincial). Same.

### Provincial (not yet enforced, future work)

Each province has its own *Ley de Fauna* and fauna authority. Listed here for future reference, not for v1:

- Buenos Aires — Ley 10.081 (Código Rural) + reglamentos sobre fauna.
- Mendoza — Ley 4.602 (Fauna Silvestre).
- Córdoba — Ley 7.343.
- Salta — Ley 5.513.
- Misiones — Ley XVI Nº 28.
- Santa Fe — Ley 4.830.
- (Remaining provinces to be filled in when the wildlife-custody flow is designed.)

### Why the three species we're adding are safe under this framework

- **Conejo doméstico (Oryctolagus cuniculus, forma doméstica)** — domesticated, not fauna silvestre, no permit required, allowed nationally.
- **Cobayo / cuy (Cavia porcellus)** — domesticated for ~3 000 years, not fauna silvestre, allowed nationally.
- **Hurón doméstico (Mustela putorius furo)** — domesticated form, allowed nationally as companion animal (a few municipalities have specific rules but no national prohibition).

All three reuse the dog/cat-shaped owner form without legal friction.

## Service and assistance roles (Ley 26.858)

Orthogonal to species: a dog can carry the legal status of *perro guía* or *perro de asistencia*, which grants its user the right to enter and remain with the dog in any public space, private space of public access, and public transport. This is the only animal-status category in Argentine law that creates an enforceable access right, and it deserves a small block in DIM because the credential page (`/p/[publicToken]`) is the natural surface to display it.

### Legal stack

- **Ley 26.858 (2013) — Derecho de acceso, deambulación y permanencia de personas con discapacidad acompañadas por perro guía o de asistencia.** National. Establishes the access right (Arts. 1–7), sanitary conditions the dog must meet (Art. 8), and sanctions for breaches.
- **Decreto 792/2019** — reglamentario de la Ley 26.858. Designates **ANDIS (Agencia Nacional de Discapacidad)** as autoridad de aplicación. Replaces the earlier Decreto 1.578/2014. Creates the *Comité Técnico de Perros Guía y de Asistencia* dentro de ANDIS.
- **Resolución ANDIS 2588/2022** — crea el **RUPGA (Registro de Usuarias y Usuarios de Perros de Guía o de Asistencia)**. Public registry. Source of truth for credentialed user–dog pairs.
- **Ley 26.378 (2008)** — ratifica la Convención sobre los Derechos de las Personas con Discapacidad (ONU). Anclaje internacional del derecho de acceso (Arts. 9, 20).
- **Ley 24.901 (1997)** — Sistema de Prestaciones Básicas. Define el CUD (Certificado Único de Discapacidad), requerido para inscribirse en el RUPGA.
- **Ley 25.326 — Protección de Datos Personales.** Crítica acá: marcar un perro como "de asistencia" implica revelar discapacidad del titular — dato sensible bajo Art. 7. La visibilidad pública debe ser opt-in.

RUPGA requirements per Art. 8 Ley 26.858 + Decreto 792/2019 + Resolución 2588/2022:

1. DNI del usuario.
2. CUD vigente.
3. Certificado emitido por un Centro de Entrenamiento aprobado por ANDIS — el centro debe ser miembro pleno o temporario de **IGDF (International Guide Dog Federation)** o **ADI (Assistance Dogs International)**.
4. Condiciones higiénico-sanitarias: vacunación al día, antiparasitarios, libreta sanitaria.
5. Identificación electrónica vía microchip bajo norma **ISO 11784/11785**.

ANDIS-recognized categories: **guía** (discapacidad visual), **asistencia motriz**, **alerta médica** (diabetes, epilepsia), **señal** (auditiva), **asistencia TEA** (autismo).

### What DIM models (v1 of this block)

A nullable `service_dog` sub-record on the pet, only allowed when `species = 'dog'`:

| Field | Type | Notes |
|---|---|---|
| `service_type` | enum: `guia` \| `asistencia_motriz` \| `alerta_medica` \| `senal_auditiva` \| `asistencia_tea` \| `otro` | Mirrors ANDIS categories. |
| `credential_status` | enum: `en_entrenamiento` \| `vigente` \| `vencida` \| `revocada` | Drives the banner copy on `/p/[publicToken]`. |
| `rupga_credential` | text (nullable) | ANDIS credential number once issued. |
| `training_center` | text | Free-text + suggested list of ANDIS-approved IGDF/ADI centers. |
| `training_cert_date` | date | When the centro emitted the certificado. |
| `credential_issue_date`, `credential_expiry_date` | date | RUPGA dates. |
| `in_service` | boolean | Active vs. retired. Retired service dogs lose access rights. |
| `public_visibility` | enum: `full_banner` \| `private_only` | Opt-in for the public credential banner. Defaults to `private_only` because PDP. |

The existing `microchip` block on `pets` carries the ISO chip ID — no new column.

### Public credential banner

When `service_dog.credential_status = 'vigente'`, `in_service = true`, and `public_visibility = 'full_banner'`, the public credential page renders a prominent block:

> **Perro de Asistencia — Ley 26.858**
> Esta persona tiene derecho a ingresar, deambular y permanecer con su perro en este establecimiento y en el transporte público. Credencial RUPGA vigente.

This banner is the real product. Owners will show it on their phone when challenged at a door; without it the rest is just data hygiene.

### Notification triggers (reuse existing scheduler)

- Rabies vaccine within 60 days of expiry → "Tu credencial RUPGA depende de mantener al día la vacunación antirrábica (Art. 8, Ley 26.858)."
- `credential_expiry_date` within 90 days → "Renovación de credencial RUPGA en ANDIS."
- Health check overdue → similar copy tied to Art. 8.

Same notification plumbing as PPP reminders; only the copy changes.

### File changes

| File | Status | Role |
|---|---|---|
| `db/schema.ts` | modified | Sibling table `pet_service_dog` keyed on `pet_id`. Sibling rather than columns on `pets` because most pets won't have it. |
| `lib/format.ts` | modified | `serviceTypeLabel()`, `credentialStatusLabel()`. |
| `components/PetForm.tsx` | modified | Collapsed section "¿Es perro de asistencia o guía? (Ley 26.858)" that expands when species = `dog`. |
| `app/p/[publicToken]/page.tsx` | modified | Conditional access-rights banner. |
| Notification scheduler | modified | Add the three triggers above. |

### Adjacent categories — *not* modeled in the owner portal

These come up in conversations about "service animals" but each has a different legal posture, and none belongs in this v1 block:

- **Service cats / service animals other than dogs.** No legal status in Argentina. Ley 26.858 is dog-specific. If a user wants to record a cat as emotionally important, they can use the `observaciones` field — no banner, no credential.
- **Animales de Apoyo Emocional (ESA).** *No tienen reconocimiento legal en Argentina.* Hay proyectos de ley pendientes (3344-D-2024 entre otros) pero ninguno sancionado. Sin derecho de acceso, sin credencial. Si DIM agrega un flag puramente informativo más adelante, debe dejar explícito que **no otorga derechos de acceso** bajo Ley 26.858.
- **TACA / IACA — Terapia Asistida con Animales.** Regulación provincial fragmentaria: Mendoza, Salta, Santa Cruz, Río Negro, Chubut, Tucumán, Santa Fe, Corrientes. CABA tiene el Programa de Intervenciones Asistidas con Animales (IACA). El animal de TACA es propiedad de la *organización terapéutica*, no del paciente. Pertenece a una futura capacidad `therapy_provider` en el portal `org`, no al portal de dueño.
- **Equinoterapia / Hipoterapia.** Leyes provinciales: Santa Cruz Ley 3.547, Misiones Ley XIX-74, además de Salta, Tucumán, Chubut, Río Negro, Santa Fe, Corrientes. Proyectos nacionales pendientes para incorporarla al PMO (Ley 24.901). El caballo pertenece al centro de equinoterapia. Mismo patrón que TACA: pertenece al portal `org`, no al portal de dueño.
- **Animales de fuerzas de seguridad** (caninos de Policía, Gendarmería, PSA, Bomberos, Defensa Civil). Animales de trabajo de instituciones del Estado. Fuera de alcance de DIM por completo.

## Compliance checklist (current state)

Cross-cutting obligations that already apply to DIM today, beyond the species and service-dog frameworks already covered above. Each row notes the current state in the codebase and the concrete gap.

| Marco legal | Qué exige | Estado en DIM hoy | Gap a cerrar |
|---|---|---|---|
| **Ley 25.326 — Protección de Datos Personales** (Hábeas Data) + Disposiciones AAIP | Inscribir el responsable del tratamiento y cada base con datos personales en el Registro Nacional de Bases de Datos vía AAIP (plataforma TAD). Garantizar derechos ARCO (acceso, rectificación, cancelación, oposición). Tratamiento reforzado para datos sensibles (salud, discapacidad — Art. 7). | Prácticas privacy-by-design implícitas. No hay inscripción formal. No hay UI de derechos ARCO. | (1) Inscribir DIM como responsable + las bases personales en AAIP cuando salga a producción. (2) Agregar UI de "Mis datos" con export + eliminación. (3) Marcar internamente el bloque `service_dog` como dato sensible (afecta logging y permisos). |
| **Ley 26.743 — Identidad de Género** | El sistema debe permitir y respetar el nombre y género autopercibidos sin exigir documentación. El DNI puede coexistir como dato registral pero no se usa para la presentación. | Sin verificar; revisar campos de perfil de `profiles`. | Agregar `chosen_name` + `chosen_pronoun` opcionales en `profiles`. Usar `chosen_name` en toda UI (notificaciones, credencial pública del vínculo dueño-mascota, etc.). DNI sólo para integraciones oficiales. |
| **Ley 14.346 — Malos Tratos** | Protección penal de todos los animales. Profesionales (veterinarios, refugios) con deber moral / institucional de denunciar maltrato observado. | Existe `app/denuncias/*` para perdido/encontrado. No hay tipo de denuncia de maltrato. | Agregar tipo de evento `cruelty_report` en el event log y un flujo de denuncia desde `/org/[orgToken]` y `/profesional`. Tier-3 (govt) recibe la denuncia escalada. |
| **CABA Ley 4.078 / Bs As Ley 14.107 — PPP** | Inscripción en registro municipal/provincial, microchip por veterinario habilitado, seguro de responsabilidad civil, bozal y correa en vía pública. | `lib/breeds.ts` detecta razas PPP y dispara notificación. | (1) Hacer `microchip` obligatorio cuando PPP=true. (2) Agregar campo `insurance_policy` (compañía + póliza + vencimiento) en bloque PPP. (3) Cuando un convenio con CABA / Bs As exista, hacer atestación T3 = inscripción municipal/provincial. |
| **Ley 22.421 + Decreto 666/97 — Fauna Silvestre** | No facilitar la tenencia de fauna silvestre como mascota. | Catálogo actual sólo contiene especies domesticadas (perro, gato, conejo, cobayo, hurón). | Compliant. La regla a mantener: cualquier futura especie no domesticada va por bucket de *criadero comercial* o `wildlife_custody`, nunca como mascota libre. |
| **Ley 26.858 + Decreto 792/2019 + Res. ANDIS 2588/2022 — Perros Guía / de Asistencia** | Reconocer la credencial RUPGA; cumplir condiciones higiénico-sanitarias del Art. 8; respetar derecho de acceso. | No modelado todavía. | Implementar el bloque `service_dog` y la banner en `/p/[publicToken]` según se define más arriba en este spec. |
| **Ley 15.465 + Res. MS 2827/2022 — Enfermedades de Notificación Obligatoria** | Notificación de enfermedades infecciosas — Grupos A (inmediata), B, C, D. Incluye zoonosis. La lista vigente está en el Anexo I de la Res. 2827/2022. | `lib/diseases.ts` ya tiene flag `reportable` en cada enfermedad relevante para muerte/diagnóstico. | (1) Auditar el catálogo contra el Anexo I de la Res. 2827/2022. (2) Cuando exista el portal govt, rutear los eventos `reportable=true` al destinatario sanitario correspondiente (SISA / SNVS / autoridad provincial). |
| **Ley 24.240 — Defensa del Consumidor** | Términos claros, transparencia, no prácticas engañosas. | No hay ToS público ni política de privacidad. | Publicar ToS + Política de Privacidad antes de abrir signup público. Ambos deben mencionar Ley 25.326 expresamente. |
| **Ley 25.326 Art. 11 — Cesión de datos** | Cualquier transferencia de datos personales requiere consentimiento informado del titular, salvo excepciones legales. | Compartir con vet / refugio / govt es opt-in vía share tokens. | Asegurar que cada flujo de compartir muestre exactamente qué datos se ceden y registre el consentimiento como evento. |

### Compliance items NOT yet binding but worth anticipating

- **Ley 26.653 — Accesibilidad Web (WCAG 2.0 por Disposición ONTI 6/2019).** Hoy obliga al Estado, sus organismos descentralizados, empresas concesionarias de servicios públicos, contratistas del Estado y organizaciones beneficiarias de subsidios estatales. **No obliga directamente a DIM como proyecto privado**, pero pasa a obligar el día que DIM se integre con Mi Argentina o firme convenio con una autoridad provincial/municipal. Práctica recomendada hoy: apuntar a **WCAG 2.1 AA** desde el principio para no tener deuda técnica cuando ese día llegue.
- **Ley 25.506 — Firma Digital.** Relevante para que las atestaciones de veterinarios y govt tengan validez legal plena. Hoy no es obligatoria, pero diseñar el bloque de atestación de forma que pueda llevar firma digital (firma del veterinario con su CUIT + certificado X.509 de AFIP / ONTI) ahorra trabajo después.
- **Mi Argentina (Decreto 1.063/2016 + sucesivos).** Cuando se concrete la integración, dispara automáticamente: WCAG completo, identidad federada con RENAPER, accesibilidad, transparencia activa (Ley 27.275).

## Pending legislation — watch list

Bills currently in trámite parlamentario o jurisprudencia emergente que cambiarían el panorama si se sancionan. Cada uno se rastrea como una *posible* spec futura, no como trabajo confirmado.

- **Animales de Apoyo Emocional (ESA).** Proyecto **3344-D-2024** (HCDN) y proyectos previos. Si se sanciona, abre un tier intermedio entre owner self-declared y perro guía Ley 26.858. *Impacto en DIM:* nueva categoría en `service_type` (`apoyo_emocional`) con derechos de acceso más limitados que la Ley 26.858. Hasta entonces, no modelar.
- **Ley Nacional de Equinoterapia.** Proyectos **5367-D-2020**, **3932-D-2021**, **0194-D-2020**. Buscan incorporar la equinoterapia al PMO vía Ley 24.901. *Impacto en DIM:* gatilla la implementación de la capacidad `therapy_provider` en el portal org y abre la puerta a equinos como categoría especial.
- **Ley Nacional de TACA / Intervenciones Asistidas con Animales.** Proyecto **6925-D-2024**. Unificaría el patchwork provincial (Mendoza, Salta, Santa Cruz, Río Negro, Chubut, Tucumán, Santa Fe, Corrientes + IACA CABA). *Impacto en DIM:* misma capacidad `therapy_provider`, vocabulario alineado.
- **Ley de Bienestar Animal.** Proyecto **210182** de la Legislatura de Buenos Aires + proyectos nacionales paralelos. Expande Ley 14.346 con un marco moderno de bienestar (cinco libertades, prohibiciones específicas, sanciones administrativas además de penales). *Impacto en DIM:* enriquece el catálogo de tipos de evento de bienestar y de denuncia.
- **DNI Mascota / Registro Nacional de Mascotas.** Múltiples proyectos a lo largo de los años, ninguno sancionado. *Impacto en DIM:* si se crea, DIM podría *ser* ese registro, integrarse, o quedar desplazado. Posicionarse pre-emptivamente alineando vocabulario y estructura con SENASA y ANDIS reduce riesgo de desplazamiento.
- **Personalidad jurídica de animales no humanos.** Declaración de la Provincia de Buenos Aires (2024). Antecedentes jurisprudenciales: *Sandra* (orangutana, CABA 2014), *Cecilia* (chimpancé, Mendoza 2016), fallo Jujuy 2025. Empuja la reforma del Código Civil y Comercial (Art. 227) para sacar a los animales del régimen de cosas. *Impacto en DIM:* refuerza el peso legal de cualquier atestación dueño-mascota, no requiere cambios técnicos inmediatos.
- **Reforma Ley 22.421 — Fauna Silvestre.** Proyectos de modernización pendientes desde hace años. *Impacto en DIM:* afectará el bucket de fauna silvestre bajo custodia que ya está en el roadmap. Hasta que se sancione, mantener Decreto 666/97 como referencia.

## Future work (referenced, not done here)

When we revisit species after this iteration, the larger design that this spec defers is the **three-bucket model**:

1. **Animales de compañía domésticos** (current scope — perro, gato, conejo, cobayo, hurón, plus ave de jaula, pez ornamental, erizo africano, etc.). Owner self-registration, no paperwork.
2. **Animales con criadero comercial habilitado** (loro hablador, iguana, boa de criadero, tortuga de criadero, etc.). Owner registration *plus* required criadero number + ring band, validated against Decreto 666/1997 paperwork model.
3. **Fauna silvestre bajo custodia** (carpincho, coatí, mono, yacaré, ñandú rescatado, etc.). Org-portal only, behind a new `wildlife_custody` capability. Framed as rehabilitation, not pet keeping.

The order in which we'd add catalogs once we start filling them:

1. Vaccines + diseases for conejo (myxomatosis, RHDV2; lepto for rodents).
2. Vaccines + diseases for hurón (distemper, rabies).
3. Aves de jaula (canario, periquito, agapornis, ninfa) — psittacosis is the public-health hook.
4. Tortuga (de agua y de tierra de criadero) — salmonella reservoir.
5. Equinos and camélidos via RENSPA bridge (separate plan).
6. Wildlife custody (`refugio` capability extension).
