> **IMPLEMENTED / shipped** — This spec has been fully implemented. The symptom-surveillance matcher (`lib/symptom-matcher.ts` or equivalent), `outbreak_signal` emission, and ENO outbox pipeline are all live. Archived for historical reference only.

# Symptom → dangerous-disease surveillance — design spec

> Cuando el dueño registra síntomas en su libreta sanitaria, un matcher contra el catálogo de enfermedades reportables emite señales silenciosas a la autoridad sanitaria. Sin pánico para el dueño, sin diagnóstico, sin alarma. Sumando el patrón en agregado, se vuelve la base del dashboard de zoonosis del público-health analyst.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Estado:** ready for review, no code yet
> **Versión:** 1.0

---

## 1. Por qué este documento existe

El North Star de DIM (`AGENTS.md`) dice: *"Every event a pet owner records is potentially a public-health signal."* Y la sección "Dashboards & projections" del analista de salud pública lista: *"Zoonosis indicators — aggregated `symptom_observed` + `death_recorded` patterns flagged when anomalous."*

Hoy DIM tiene **la mitad construida sin saberlo**: `lib/diseases.ts` catalogó 17 enfermedades con flag `reportable: bool` que marca las notificables a SENASA / Ministerio de Salud (rabia, leptospirosis, brucelosis canina, leishmaniasis visceral, hidatidosis, tuberculosis, ántrax, toxoplasmosis). El event_type `symptom_observed` existe pero está acoplado a denuncias de welfare, no al flujo de la libreta sanitaria. Nada conecta síntomas observados con enfermedades peligrosas.

Este doc cierra el hueco: catálogo de síntomas estructurados, matcher fuzzy que toma texto libre del dueño y produce candidatos de enfermedad, evento `outbreak_signal` que se emite automáticamente cuando match cruza umbral, notificación al govt de la jurisdicción de la mascota. El owner no ve nada de esto — el alert es interno para autoridades.

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | **El dueño no ve diagnósticos especulativos**. Cuando registra síntomas, ve confirmación neutra ("Quedó registrado en la libreta de [Pet]"). No se le sugiere enfermedad. No se le advierte alerta enviada | Evita pánico sobre falsos positivos. Evita auto-diagnóstico. Respeta el límite profesional médico (el vet diagnostica). El UX "consultá al vet si los síntomas persisten" puede existir como nudge genérico, pero sin nombrar enfermedades |
| D2 | **Input del dueño = texto libre** con matcher fuzzy contra catálogo de síntomas. NO picker estructurado | Más natural para el dueño. Cubre la mayoría de los casos donde el dueño tipea "le sale baba y está raro" sin pensar en taxonomías. El matcher hace el trabajo |
| D3 | **Alert para autoridades = `Notification` row + nuevo evento `outbreak_signal` en `pet_events`**. Sin tabla `outbreak_alerts` dedicada en v1 | Reusa infrastructure. Notification tiene severity, CTA, read state. El evento `outbreak_signal` queda en el log para agregación. Cuando exista el dashboard de govt con cola de alerts, evaluamos si justifica tabla propia con lifecycle |
| D4 | **`outbreak_signal` es NON-libreta** | Es señal de surveillance, no historial médico del pet. El owner no debería ver outbreak_signals en su libreta sanitaria (eso violaría D1). Agregar a `NON_LIBRETA_EVENT_TYPES` |
| D5 | **`symptom_observed` se desacopla de welfare_report**. Mismo event_type, payload extendido con `source: 'libreta' \| 'welfare_report'`, `welfare_report_id` opcional (requerido cuando source='welfare_report') | El AGENTS.md original lo había diseñado libreta-friendly; la implementación drifteó. Esto re-alinea sin breaking change |
| D6 | **Matching usa specificity por síntoma↔enfermedad** (high / medium / low). Reglas de trigger: 1 high → alert. 2+ medium → alert. Solo low → no alert | Single source of decision logic. Evita ruido (fiebre sola no dispara nada; salivación + agresividad sí, porque ambas son high-specificity para rabia) |
| D7 | **Match es sincrónico al write de `symptom_observed`** (server action). NO async / queue / cron | Latencia del owner submit no se afecta significativamente (text-matching es rápido). Mantiene atomicidad: si crea el evento de síntoma, también crea el outbreak_signal y la notification en la misma transacción. Reverso: si falla el matcher, falla el insert del síntoma — quizás OK, quizás no. Mitigación: el matcher es defensive (try/catch alrededor de la lógica, default a "no match" si algo falla) |
| D8 | **Catálogo de síntomas vive en código** (`lib/symptoms.ts`), no en DB. Como `diseases.ts` ya hace | Versionado con código. No migración cuando se agrega un síntoma nuevo. El día que necesitemos UI admin para editar, lo movemos a tabla — schema-ready |
| D9 | **Match strength se persiste en el evento `outbreak_signal.payload`**. Govt ve no solo "qué enfermedad podría ser" sino "qué tan fuerte fue el match" (cuántos high, cuántos medium) | Permite priorización en la futura cola del govt. Un signal con 3 high es más urgente que uno con 2 medium |

## 3. Glosario

| Término | Qué es |
|---|---|
| **Symptom** | Signo clínico observable que el dueño puede reportar (fiebre, vómitos, salivación, etc.) |
| **Symptom catalog** | Lista estructurada de síntomas con código, label es-AR, sinónimos, especies aplicables, y mapping a enfermedades con specificity |
| **Specificity** | Qué tan diagnóstico es un síntoma de una enfermedad. `high` = casi patognomónico. `medium` = sugiere fuertemente. `low` = es común pero podría ser ese |
| **Disease alert / Outbreak signal** | Evento emitido por el sistema cuando un set de síntomas observados matchea una enfermedad reportable con specificity suficiente |
| **Match strength** | Resumen numérico de cuán fuerte fue el match: `{ high_count, medium_count, low_count }` |

## 4. Domain model

### 4.1 Catálogo de síntomas (`lib/symptoms.ts`, nuevo)

```ts
import type { DiseaseSpecies } from "./diseases";

export type SymptomCategory =
  | "general"          // fiebre, decaimiento, peso
  | "gastrointestinal" // vómitos, diarrea, ictericia
  | "respiratory"      // tos, secreción nasal, disnea
  | "neurological"     // convulsiones, parálisis, salivación
  | "dermatological"   // lesiones, alopecia, sangrado
  | "behavioral";      // agresividad, cambios de conducta

export type Specificity = "high" | "medium" | "low";

export type SymptomDiseaseLink = {
  disease_code: string; // matches diseases.ts code
  specificity: Specificity;
};

export type SymptomDef = {
  code: string;                       // stable identifier, snake_case
  label: string;                       // es-AR display label
  category: SymptomCategory;
  species: DiseaseSpecies[];
  synonyms: readonly string[];         // alternative phrasings the owner might type
  related_diseases: readonly SymptomDiseaseLink[];
};

export const SYMPTOMS: readonly SymptomDef[] = [
  // ─── General ────────────────────────────────────────────────────────────
  {
    code: "high_fever",
    label: "Fiebre alta",
    category: "general",
    species: ["dog", "cat"],
    synonyms: ["fiebre", "fiebre alta", "temperatura", "caliente", "calentura"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "medium" },
      { disease_code: "distemper", specificity: "medium" },
      { disease_code: "parvovirus", specificity: "medium" },
      { disease_code: "babesiosis", specificity: "high" },
      { disease_code: "ehrlichiosis", specificity: "medium" },
      { disease_code: "feline_panleukopenia", specificity: "medium" },
    ],
  },
  {
    code: "lethargy",
    label: "Letargo / decaimiento",
    category: "general",
    species: ["dog", "cat"],
    synonyms: ["decaído", "decaida", "decaimiento", "sin energía", "apagado", "apagada", "triste", "letargo"],
    related_diseases: [
      // Many diseases, mostly low specificity
      { disease_code: "leptospirosis", specificity: "low" },
      { disease_code: "distemper", specificity: "low" },
      { disease_code: "parvovirus", specificity: "low" },
    ],
  },
  {
    code: "weight_loss",
    label: "Pérdida de peso",
    category: "general",
    species: ["dog", "cat"],
    synonyms: ["adelgazó", "adelgazo", "pierde peso", "bajó de peso", "flaco", "muy flaco"],
    related_diseases: [
      { disease_code: "visceral_leishmaniasis", specificity: "medium" },
      { disease_code: "tuberculosis", specificity: "medium" },
      { disease_code: "feline_leukemia", specificity: "medium" },
      { disease_code: "feline_immunodeficiency", specificity: "medium" },
    ],
  },
  {
    code: "anorexia",
    label: "Falta de apetito",
    category: "general",
    species: ["dog", "cat"],
    synonyms: ["no come", "no quiere comer", "falta de apetito", "anorexia", "rechaza la comida"],
    related_diseases: [
      // Common — low specificity for everything
      { disease_code: "leptospirosis", specificity: "low" },
      { disease_code: "parvovirus", specificity: "low" },
      { disease_code: "distemper", specificity: "low" },
    ],
  },

  // ─── Gastrointestinal ──────────────────────────────────────────────────
  {
    code: "vomiting",
    label: "Vómitos",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: ["vomita", "vómito", "vómitos", "está vomitando", "devuelve la comida"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "medium" },
      { disease_code: "parvovirus", specificity: "high" },
      { disease_code: "feline_panleukopenia", specificity: "high" },
    ],
  },
  {
    code: "bloody_diarrhea",
    label: "Diarrea con sangre",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: ["diarrea con sangre", "caca con sangre", "diarrea hemorrágica", "deposiciones con sangre"],
    related_diseases: [
      { disease_code: "parvovirus", specificity: "high" },
      { disease_code: "feline_panleukopenia", specificity: "high" },
    ],
  },
  {
    code: "diarrhea",
    label: "Diarrea",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: ["diarrea", "suelta", "deposiciones blandas", "caca floja"],
    related_diseases: [
      { disease_code: "parvovirus", specificity: "medium" },
      { disease_code: "feline_panleukopenia", specificity: "medium" },
      { disease_code: "distemper", specificity: "low" },
    ],
  },
  {
    code: "jaundice",
    label: "Ictericia (color amarillento)",
    category: "gastrointestinal",
    species: ["dog", "cat"],
    synonyms: ["amarillo", "amarilla", "ojos amarillos", "encías amarillas", "ictericia"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "high" },
      { disease_code: "babesiosis", specificity: "medium" },
    ],
  },

  // ─── Respiratory ────────────────────────────────────────────────────────
  {
    code: "cough",
    label: "Tos",
    category: "respiratory",
    species: ["dog", "cat"],
    synonyms: ["tose", "tos", "tosiendo"],
    related_diseases: [
      { disease_code: "tuberculosis", specificity: "medium" },
      { disease_code: "distemper", specificity: "medium" },
    ],
  },
  {
    code: "nasal_discharge",
    label: "Secreción nasal",
    category: "respiratory",
    species: ["dog", "cat"],
    synonyms: ["moco", "mocos", "secreción nasal", "le sale moco", "le moquea la nariz"],
    related_diseases: [
      { disease_code: "distemper", specificity: "high" },
    ],
  },
  {
    code: "difficulty_breathing",
    label: "Dificultad para respirar",
    category: "respiratory",
    species: ["dog", "cat"],
    synonyms: ["respira mal", "le cuesta respirar", "agitada", "agitado", "disnea"],
    related_diseases: [
      { disease_code: "tuberculosis", specificity: "medium" },
    ],
  },

  // ─── Neurological ───────────────────────────────────────────────────────
  {
    code: "seizures",
    label: "Convulsiones",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: ["convulsión", "convulsiones", "convulsiona", "ataques", "espasmos"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "medium" },
      { disease_code: "distemper", specificity: "high" },
    ],
  },
  {
    code: "paralysis",
    label: "Parálisis",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: ["paralizado", "paralizada", "no se mueve", "no puede caminar", "parálisis"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "high" },
      { disease_code: "distemper", specificity: "medium" },
    ],
  },
  {
    code: "hypersalivation",
    label: "Salivación excesiva",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: ["babea", "baba", "babea mucho", "salivación", "hipersalivación", "saliva mucho", "le cae baba"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "high" },
    ],
  },
  {
    code: "aggression_unusual",
    label: "Agresividad inusual",
    category: "behavioral",
    species: ["dog", "cat"],
    synonyms: ["agresivo", "agresiva", "muy agresivo", "agresividad", "muerde sin razón", "ataca sin razón"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "high" },
    ],
  },
  {
    code: "behavioral_changes",
    label: "Cambios de comportamiento",
    category: "behavioral",
    species: ["dog", "cat"],
    synonyms: ["raro", "rara", "está raro", "está rara", "actúa raro", "comportamiento diferente", "cambios"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "high" },
      { disease_code: "distemper", specificity: "low" },
    ],
  },
  {
    code: "hydrophobia",
    label: "Miedo al agua",
    category: "behavioral",
    species: ["dog", "cat"],
    synonyms: ["miedo al agua", "rechaza el agua", "no toma agua", "hidrofobia", "le teme al agua"],
    related_diseases: [
      { disease_code: "rabies_suspected", specificity: "high" },
    ],
  },
  {
    code: "disorientation",
    label: "Desorientación",
    category: "neurological",
    species: ["dog", "cat"],
    synonyms: ["desorientada", "desorientado", "perdido", "perdida", "se choca", "tropieza"],
    related_diseases: [
      { disease_code: "distemper", specificity: "medium" },
      { disease_code: "rabies_suspected", specificity: "medium" },
    ],
  },

  // ─── Dermatological / Hematological ─────────────────────────────────────
  {
    code: "skin_lesions",
    label: "Lesiones en la piel",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["lesiones", "heridas", "llagas", "úlceras", "costras"],
    related_diseases: [
      { disease_code: "visceral_leishmaniasis", specificity: "high" },
    ],
  },
  {
    code: "hair_loss",
    label: "Pérdida de pelo / alopecia",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["pierde pelo", "se le cae el pelo", "alopecia", "pelado", "calvicie"],
    related_diseases: [
      { disease_code: "visceral_leishmaniasis", specificity: "medium" },
    ],
  },
  {
    code: "bleeding",
    label: "Sangrado",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["sangra", "sangrado", "hemorragia", "le sangra"],
    related_diseases: [
      { disease_code: "leptospirosis", specificity: "medium" },
      { disease_code: "ehrlichiosis", specificity: "medium" },
    ],
  },
  {
    code: "nose_bleeding",
    label: "Sangrado nasal",
    category: "dermatological",
    species: ["dog", "cat"],
    synonyms: ["sangra por la nariz", "sangrado nasal", "epistaxis", "le sale sangre por la nariz"],
    related_diseases: [
      { disease_code: "visceral_leishmaniasis", specificity: "high" },
      { disease_code: "ehrlichiosis", specificity: "medium" },
    ],
  },
];

export function findSymptom(code: string): SymptomDef | null {
  return SYMPTOMS.find((s) => s.code === code) ?? null;
}

export function symptomsForSpecies(species: string | null): readonly SymptomDef[] {
  if (!species || species === "other") return SYMPTOMS;
  return SYMPTOMS.filter(
    (s) => s.species.includes("any" as DiseaseSpecies) || s.species.includes(species as DiseaseSpecies),
  );
}
```

**Sinónimos son críticos.** El matcher fuzzy depende de cubrir las formas variadas que un dueño tipea. Conviene iterar el catálogo de sinónimos en uso real cuando los datos lleguen — el día que veamos "el perro está zarpado" lo agregamos. Este catálogo inicial cubre las formas obvias en es-AR.

### 4.2 Matcher (`lib/symptom-matcher.ts`, nuevo)

```ts
import { SYMPTOMS, type SymptomDef } from "./symptoms";
import { DISEASES, type DiseaseDef, findDisease } from "./diseases";

export type MatchedSymptom = {
  symptom_code: string;
  matched_synonym: string;
};

export type DiseaseMatch = {
  disease_code: string;
  disease_label: string;
  is_reportable: boolean;
  high_count: number;
  medium_count: number;
  low_count: number;
  matched_symptoms: string[]; // symptom codes
  /** triggers alert when high>=1 OR medium>=2 */
  triggers_alert: boolean;
};

/**
 * Normalize a string for fuzzy matching: lowercase, strip accents, collapse
 * whitespace. Conservative — no stemming yet (Spanish stemming is non-trivial).
 */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match free-text input against the symptom catalog.
 *
 * For each symptom, checks whether ANY of its synonyms appears as a substring
 * of the normalized input. Multiple matches for the same symptom collapse to
 * one (uniqueness on symptom_code).
 *
 * Filters by species if provided.
 *
 * Returns an empty array if no matches.
 */
export function matchSymptoms(
  freeText: string,
  species: string | null,
): MatchedSymptom[] {
  const normalizedInput = normalize(freeText);
  if (normalizedInput.length === 0) return [];

  const matches: MatchedSymptom[] = [];
  const seenCodes = new Set<string>();

  for (const symptom of SYMPTOMS) {
    if (
      species &&
      species !== "other" &&
      !symptom.species.includes("any" as never) &&
      !symptom.species.includes(species as never)
    ) {
      continue;
    }

    for (const synonym of symptom.synonyms) {
      const normSynonym = normalize(synonym);
      if (normalizedInput.includes(normSynonym)) {
        if (!seenCodes.has(symptom.code)) {
          matches.push({ symptom_code: symptom.code, matched_synonym: synonym });
          seenCodes.add(symptom.code);
        }
        break; // one synonym match per symptom is enough
      }
    }
  }

  return matches;
}

/**
 * Aggregate matched symptoms into per-disease counts and decide which
 * diseases meet the alert threshold (1 high OR 2+ medium).
 */
export function aggregateDiseaseMatches(
  matchedSymptoms: MatchedSymptom[],
): DiseaseMatch[] {
  const perDisease = new Map<string, {
    high: number;
    medium: number;
    low: number;
    symptoms: Set<string>;
  }>();

  for (const m of matchedSymptoms) {
    const symptom = SYMPTOMS.find((s) => s.code === m.symptom_code);
    if (!symptom) continue;
    for (const link of symptom.related_diseases) {
      const agg = perDisease.get(link.disease_code) ?? {
        high: 0,
        medium: 0,
        low: 0,
        symptoms: new Set<string>(),
      };
      agg[link.specificity] += 1;
      agg.symptoms.add(m.symptom_code);
      perDisease.set(link.disease_code, agg);
    }
  }

  const results: DiseaseMatch[] = [];
  for (const [disease_code, agg] of perDisease) {
    const disease = findDisease(disease_code);
    if (!disease) continue;
    const triggersAlert = agg.high >= 1 || agg.medium >= 2;
    results.push({
      disease_code,
      disease_label: disease.label,
      is_reportable: disease.reportable,
      high_count: agg.high,
      medium_count: agg.medium,
      low_count: agg.low,
      matched_symptoms: Array.from(agg.symptoms),
      triggers_alert: triggersAlert,
    });
  }

  // Sort: alerts first, then by total specificity weight desc
  results.sort((a, b) => {
    if (a.triggers_alert !== b.triggers_alert) return a.triggers_alert ? -1 : 1;
    const wA = a.high_count * 3 + a.medium_count * 2 + a.low_count;
    const wB = b.high_count * 3 + b.medium_count * 2 + b.low_count;
    return wB - wA;
  });

  return results;
}

/**
 * Full pipeline: free text → matched symptoms → disease matches → only
 * those that trigger an alert AND are reportable. This is the canonical
 * surface used by the server action when emitting outbreak_signal events.
 */
export function detectAlertableDiseases(
  freeText: string,
  species: string | null,
): DiseaseMatch[] {
  const matched = matchSymptoms(freeText, species);
  const aggregated = aggregateDiseaseMatches(matched);
  return aggregated.filter((d) => d.triggers_alert && d.is_reportable);
}
```

**Diseño del matcher en una línea:** substring-contains de synonyms normalizados (sin acentos, lowercase). No stemming, no Levenshtein, no fuzzy regex. Es la versión más simple que cubre el 80% de casos reales sin sobreingeniería. Si en producción vemos que se pierde mucho ("vómito" sin "s" no matchea "vómitos"), agregamos las formas plurales como sinónimos antes de complicar el algoritmo.

**Importante: el matcher es deterministic y barato.** Llamarlo sincrónico al write del symptom_observed es trivial — N_symptoms × M_synonyms_per_symptom × O(input_length) = pocos miles de comparaciones de strings. Sub-milisegundo en producción.

### 4.3 Refactor de `symptom_observed`

**Zod schema actualizado** en `lib/event-schemas.ts`:

```ts
const symptomObserved = z
  .object(
    withVersion({
      source: z.enum(["libreta", "welfare_report"]),
      // Required when source='welfare_report', null when source='libreta'.
      welfare_report_id: z.string().uuid().nullable(),
      reporter_role: z.enum(["owner", "witness", "vet"]),
      // Free text input by the owner (or vet). The matcher reads this.
      free_text: z.string().min(1),
      // The matched symptom codes, populated by the server action via lib/symptom-matcher.
      // Empty array when no matches.
      matched_symptom_codes: z.array(z.string()).default([]),
      // The diseases that crossed the alert threshold. May be empty even if symptoms
      // matched (low-specificity-only matches don't trigger alerts).
      alerted_disease_codes: z.array(z.string()).default([]),
      severity_self_assessed: z.enum(["mild", "moderate", "severe"]).nullable(),
      onset_at: z.string().nullable(),
    }),
  )
  .strict()
  .refine(
    (p) => (p.source === "welfare_report" ? p.welfare_report_id !== null : p.welfare_report_id === null),
    { message: "welfare_report_id must be set iff source='welfare_report'" },
  );
```

**Importante**: agregar `matched_symptom_codes` y `alerted_disease_codes` al payload **no cambia la semántica del evento**. Sigue siendo "el dueño/witness/vet observó síntomas". Solo enriquece el payload con los resultados del matcher al momento del write — esto es información derivable (re-correr el matcher contra `free_text` da lo mismo) pero persistirla evita ambigüedad si el catálogo cambia retroactivamente.

### 4.4 Nuevo event_type `outbreak_signal`

**En `EVENT_TYPES` const** (`db/schema.ts`):

```ts
"outbreak_signal",
```

**En `NON_LIBRETA_EVENT_TYPES`** (`lib/libreta-sanitaria.ts`):

```ts
"outbreak_signal",
```

(Comentar inline el motivo: "system surveillance signal, not pet medical history".)

**Zod schema nuevo** en `lib/event-schemas.ts`:

```ts
const outbreakSignal = z
  .object(
    withVersion({
      source_symptom_event_id: z.string().uuid(),
      disease_code: z.string(),
      disease_label: z.string(),
      match_strength: z.object({
        high_count: z.number().int().nonnegative(),
        medium_count: z.number().int().nonnegative(),
        low_count: z.number().int().nonnegative(),
        matched_symptom_codes: z.array(z.string()),
      }),
      // Snapshot of pet's jurisdiction at signal time — for surveillance aggregation
      // even if the pet moves later.
      pet_jurisdiction_country: z.string(),
      pet_jurisdiction_province: z.string().nullable(),
      pet_jurisdiction_locality: z.string().nullable(),
      pet_species: z.string(),
    }),
  )
  .strict();

// Register in PayloadSchemas:
outbreak_signal: outbreakSignal,
```

### 4.5 Notification para autoridades

Reusar `Notification` existente con valores nuevos de `notification_type`:

```ts
// New notification_type values (TEXT, no migration):
"outbreak_signal_detected"
```

Cuando se inserta:
- `user_id` — el govt user en jurisdicción del pet
- `notification_type='outbreak_signal_detected'`
- `severity='warning'` (alerta baja per D3 / D6)
- `title` — algo tipo "Signal: posible Leptospirosis en Belgrano"
- `body` — markdown con el disease label, los síntomas que matchearon, y un disclaimer claro:
  > Signal automático basado en síntomas auto-reportados por dueño. **No es diagnóstico.** Considerar contexto: cuántos signals similares en la jurisdicción / período.
- `related_pet_id` — pet del evento original (read sigue siendo gateado por RLS)
- `related_event_id` — el `outbreak_signal` event row

**Si NO hay govt asignado para la localidad del pet**, fallback a admin (cualquier admin activo). Coherente con la regla de scope matching del admin page.

## 5. Flujo end-to-end

Owner abre form de "Registrar síntoma" (nuevo o existente en `/eventos/nuevo/sintoma`):

```
1. Form: textarea de síntomas (free text), severity self-assessed (opcional), onset_at (opcional)
2. Submit → createSymptomObservedAction (server action)

3. Server action transaction:
   a. Parse + validate input
   b. matched = matchSymptoms(freeText, pet.species)
   c. diseases = aggregateDiseaseMatches(matched)
   d. alertable = diseases.filter(d => d.triggers_alert && d.is_reportable)
   e. payload = {
        payload_version: 1,
        source: 'libreta',
        welfare_report_id: null,
        reporter_role: 'owner',
        free_text: freeText,
        matched_symptom_codes: matched.map(m => m.symptom_code),
        alerted_disease_codes: alertable.map(d => d.disease_code),
        severity_self_assessed, onset_at,
      }
   f. validateEventPayload('symptom_observed', payload)  // Zod, throws on fail
   g. Insert into pet_events with payload, eventType='symptom_observed', authorRole='owner'
   h. For each disease in alertable:
        - Build outbreak_signal payload (with pet's jurisdiction snapshot)
        - Insert pet_events with eventType='outbreak_signal', authorRole='system',
          recordedByUserId=null
        - Find target govt(s):
            - First: govts whose govt_assignments match pet.jurisdiction_province + locality
            - Fallback: any active admin
        - For each target authority, insert Notification with severity='warning'
   i. Commit

4. Owner sees: "Quedó registrado en la libreta de {Pet}. Si los síntomas persisten o empeoran,
                consultá al veterinario."
   — NO se nombran enfermedades. NO se menciona alert.
```

**Importante**: el matcher corre dentro de la transacción, pero los resultados son cached en el payload del `symptom_observed`. Eso significa que un downstream re-processing (cuando exista la welfare officer dashboard) puede leer `alerted_disease_codes` sin re-correr el matcher. Auditable y reproducible.

**Race condition relevante**: la pet's jurisdiction se snapshot dentro del transaction read. Si el dueño cambia jurisdicción exactamente entre el snapshot y el insert, hay una ventana minúscula donde el signal puede llegar a govts equivocados. Aceptable en v1 — la jurisdicción del pet cambia raramente y el snapshot es consistente con lo que el dueño ve.

## 6. Privacy

- **El dueño no ve qué enfermedades matchearon** (D1). El payload del `symptom_observed` SÍ tiene `alerted_disease_codes`, pero ese campo se oculta en cualquier render owner-facing.
- **El govt sí ve disease + síntomas + pet info básica** — pero NO ve owner PII (nombre, DNI, dirección exacta). La jurisdicción del pet es coarse (province + locality, no coordenadas).
- **La libreta sanitaria del pet sigue mostrando el `symptom_observed`** — coherente con que el dueño escribió eso. La presencia o ausencia de `outbreak_signal` adjunto no se muestra al dueño.
- **Aggregations** públicas no se construyen en este spec, pero la data está lista para `count(*) from pet_events where event_type='outbreak_signal' and disease_code='leptospirosis' group by jurisdiction_locality, week` — el dashboard del public-health analyst.
- **k-anonymity** ya está documentado en `AGENTS.md → Aggregation & privacy policy`. Aplica acá igual: dashboards públicos suprimen celdas < k.

## 7. UX del form de registro de síntoma

Una nueva ruta `/mis-mascotas/{publicToken}/eventos/nuevo/sintoma`:

```
Header: "Registrar síntoma en la libreta de {Pet}"

Form:
  - Textarea: "Describí lo que estás viendo en {Pet}. Sé natural — no te preocupes por terminología."
    placeholder: "Ej: hace dos días que vomita y está decaída. Hoy no quiso comer."
  - Select severity (opcional): "¿Cuán grave te parece?"
    [Leve] [Moderado] [Grave]
  - Date (opcional): "¿Desde cuándo notás esto?"

  Submit button: "Registrar en la libreta"

After submit (success):
  "Quedó registrado en la libreta de {Pet}.
  
   Si los síntomas persisten o empeoran, consultá al veterinario."
```

El copy es deliberadamente plano. Si querés agregar un CTA "Buscar vet cerca tuyo" como nudge (que linkearía al spec de scheduling cuando exista), lo agregamos — pero como nudge genérico, NO como reacción a una enfermedad detectada.

## 8. RLS

- `outbreak_signal` events: lecturas igual que cualquier otro `pet_event` — owner ve sus pets. Admin/govt ven dentro de su scope vía RLS del admin page.
- `symptom_observed` con `source='libreta'`: igual.
- `Notification` de tipo `outbreak_signal_detected`: gateada por `user_id` (el destinatario govt/admin).

Sin policies nuevas — todo cubre con lo que ya existe.

## 9. Trade-offs explícitos

- **Matcher substring vs LLM**: substring. Pros: barato, deterministic, debuggable. Cons: pierde sinónimos no listados, no entiende negación ("no tiene fiebre"). Mitigación: el catálogo de synonyms se itera con datos reales; la negación es bug aceptable en v1 (raro que el dueño tipee "no vomita" sin contexto positivo). Migración a LLM cuando exista la infrastructure del events agent.
- **Sincrónico vs async match**: sincrónico. Pros: atomicidad, simple. Cons: latency en el submit del dueño. Mitigación: el matcher es sub-ms.
- **Persistir `alerted_disease_codes` en payload vs re-derivar**: persistir. Pros: auditable, snapshot del momento de detección. Cons: si cambia el catálogo, los old payloads quedan con info "vieja". Mitigación: combine con `payload_version` del hardening — el day que el catálogo cambie meaningfully, bump version y upcast en read.
- **Notification vs tabla dedicada**: Notification. Pros: reusa infrastructure. Cons: no hay lifecycle (open/acknowledged). Mitigación: D3 declara migración cuando exista dashboard govt.
- **Symptom catalog en código vs DB**: código. Pros: versionado con git, no migration. Cons: requiere deploy para cambios. Mitigación: el catálogo cambia raro.

## 10. Phasing

**Fase 1 — Foundation (1 PR).** `lib/symptoms.ts` con catálogo inicial. `lib/symptom-matcher.ts` con las tres funciones core (normalize, matchSymptoms, aggregateDiseaseMatches, detectAlertableDiseases). Vitest unit tests del matcher cubriendo: casos sin match, casos solo-low (no alert), casos high single (alert), casos medium count 2+ (alert), filtro por especie.

**Fase 2 — Schema (1 PR).** Add `outbreak_signal` a `EVENT_TYPES` y `NON_LIBRETA_EVENT_TYPES`. Zod schemas updates: refactor `symptomObserved` + nuevo `outbreakSignal`. Test de cobertura de Parte A de libreta sanitaria sigue verde.

**Fase 3 — Server action + form (1 PR).** Crear `createSymptomObservedAction` con todo el pipeline. Crear ruta `/mis-mascotas/{publicToken}/eventos/nuevo/sintoma` y el form. Confirmation copy deliberadamente neutro.

**Fase 4 — Notification routing (1 PR).** Lookup de govts target en jurisdicción + fallback admin. Notification creation. Cuando no haya UI de govt aún, las notifs se insertan igual y son inspectables por Studio.

**Fase 5 — Integration smoke (1 PR).** End-to-end test: como owner, registrar síntomas en un pet de CABA-Belgrano que matchean rabia. Confirmar: `symptom_observed` con `alerted_disease_codes=['rabies_suspected']`, `outbreak_signal` event creado, Notification al govt de Belgrano (o admin fallback si no hay govt).

Cada fase es un PR. Total ~5 PRs chicos.

## 11. Lo que NO está en este diseño

- **Welfare officer dashboard / queue de alerts** con lifecycle — viene cuando se construya el govt portal.
- **Owner-facing nudges con nombres de enfermedades** — explícitamente excluido por D1.
- **Email transaccional al govt** — solo in-app Notification hasta que exista provider.
- **LLM-based symptom extraction** — fase futura cuando exista la infraestructura del events agent.
- **Cross-pet pattern detection** ("hay 5 signals de leptospirosis en Belgrano esta semana") — eso es projection sobre el log, no parte de este spec.
- **Owner consent toggle** para participar en surveillance — la regla de AGENTS.md es que aggregates coarse no requieren consent; el signal individual es a un govt con autoridad legítima sobre la jurisdicción. Si querés agregar opt-out por owner, lo evaluamos.
- **Re-procesamiento histórico** — cuando expandamos el catálogo, los eventos viejos no se re-evaluan. Mitigación: aceptable, el signal es para casos current.
- **Time-window de match** — todos los síntomas dentro del free_text del MISMO evento contribuyen al match. Múltiples eventos en días distintos no se agregan. Esto es por diseño: cada submission del owner es una observación independiente.
- **Severity escalation** — un signal con high_count=3 no se eleva automáticamente a "urgent". Toda alerta es "warning" en v1. La cola del govt decide priorización.

---

## Próximo paso

Cuando este diseño tenga OK, partimos en planes de implementación por fase. Fase 1 (foundation: catálogo + matcher + tests) es la más barata y entregable independiente.

Si querés ajustar el catálogo de síntomas (agregar / sacar entradas, refinar synonyms, recalibrar specificities), el umbral del alert (D6), el copy post-submit, o cualquier decisión, **decímelo antes de los planes**. El catálogo en particular conviene revisarlo con un veterinario o sanitarista en algún momento — yo lo armé razonable pero no autoritativo.
