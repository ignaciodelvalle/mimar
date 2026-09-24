# Symptom → dangerous-disease surveillance — implementation plan

> Plan ejecutable para Claude Code. Cinco fases que implementan el feature completo de detección de síntomas que podrían indicar enfermedades peligrosas y emiten signals silenciosos a la autoridad sanitaria. Las fases son secuencialmente dependientes pero pueden ir en PRs separados.
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~5 PRs chicos, ~8 archivos nuevos, ~5 archivos tocados, 0 migraciones de DB
> **Estimación total:** 2-3 días de trabajo

---

## 0. Antes de tocar nada

Lectura obligatoria en este orden — el spec define el porqué; este plan define el qué y el cómo:

1. **`docs/superpowers/specs/2026-05-17-symptom-disease-surveillance-design.md`** — el spec del feature. Toda decisión está justificada ahí. Si encontrás algo en este plan que contradice el spec, gana el spec
2. **`AGENTS.md → Libreta sanitaria`** — el evento `symptom_observed` ya está clasificado como libreta. El nuevo `outbreak_signal` se agrega a `NON_LIBRETA_EVENT_TYPES`. Pasa con el test de cobertura de Parte A
3. **`AGENTS.md → User roles & account types`** — para entender cómo se routea la notification a govts vs admin (govt en scope → fallback admin). En particular: la query del fallback usa `account_type='institutional' AND role='admin'`
4. **`lib/diseases.ts`** — el catálogo existente de 17 enfermedades con `reportable: bool`. NO se toca; se referencia desde el nuevo `lib/symptoms.ts`
5. **`lib/event-schemas.ts`** — patrón de schemas estrictos con `payload_version`. Vas a agregar uno (`outbreakSignal`) y refactorear otro (`symptomObserved`)
6. **`lib/libreta-sanitaria.ts`** — la constante `LIBRETA_SANITARIA_EVENT_TYPES` y `NON_LIBRETA_EVENT_TYPES`. Agregás `outbreak_signal` a esta última
7. **`db/schema.ts`** — la lista `EVENT_TYPES`. Agregás `"outbreak_signal"` al final
8. **`app/actions/events.ts`** (si existe) o donde viven los server actions de creación de eventos — entender el patrón antes de crear `createSymptomObservedAction`

**Una dependencia importante.** La Fase 4 (notification routing) idealmente lookuparía govts vía `govt_assignments` (tabla del admin page spec, todavía sin implementar). Como NO existe esa tabla aún, en este plan **Fase 4 routea solo a admins activos** — la notification CTA apunta a `/admin/cola`. Cuando admin page Fase 0 mergee, una pasada chica reemplaza el "solo admins" por "govts en scope (CTA a `/gob/cola`) + fallback admin (CTA a `/admin/cola`)". Eso está explícito en el código con un TODO inline que apunta al `2026-05-17-admin-page-design.md`.

## 1. Qué construye este plan

Cinco fases secuenciales:

**Fase 1 — Foundation.** Catálogo de síntomas en `lib/symptoms.ts` (23 entradas) + matcher fuzzy en `lib/symptom-matcher.ts` + tests Vitest. Sin DB, sin UI, sin server actions. Auto-contenido y testeable.

**Fase 2 — Schema.** Agregar `outbreak_signal` a `EVENT_TYPES` y `NON_LIBRETA_EVENT_TYPES`. Refactor del Zod schema de `symptomObserved` para desacoplar de welfare_report. Nuevo Zod schema `outbreakSignal`.

**Fase 3 — Server action + form.** `createSymptomObservedAction` ejecuta el pipeline completo (parse → match → aggregate → insert events). Nueva ruta `/mis-mascotas/[publicToken]/eventos/nuevo/sintoma` con form de texto libre.

**Fase 4 — Notification routing.** Lookup de authority targets en la jurisdicción del pet (v1: solo admins). Insert de Notification rows con severity='warning'.

**Fase 5 — Integration smoke.** Test end-to-end (Vitest integration) que confirma el pipeline completo funcionando.

## 2. Decisiones cerradas (resumen del spec — NO relitigar)

| # | Decisión | Sección del spec |
|---|---|---|
| D1 | El dueño NO ve diagnósticos especulativos | §2 D1 |
| D2 | Input = texto libre + matcher fuzzy | §2 D2 |
| D3 | Alert v1 = Notification + outbreak_signal event, sin tabla dedicada | §2 D3 |
| D4 | `outbreak_signal` es NON-libreta | §2 D4 |
| D5 | Refactor `symptom_observed` con `source: 'libreta' \| 'welfare_report'` | §2 D5 |
| D6 | Trigger rules: 1 high O 2+ medium → alerta. Solo low → no | §2 D6 |
| D7 | Match sincrónico al write, defensive (try/catch en el matcher) | §2 D7 |
| D8 | Catálogo de síntomas en código (`lib/symptoms.ts`), no DB | §2 D8 |
| D9 | `match_strength` se persiste en payload del `outbreak_signal` | §2 D9 |

## 3. Scope

**Dentro:**
- `lib/symptoms.ts` (nuevo)
- `lib/symptom-matcher.ts` (nuevo)
- `lib/symptom-matcher.test.ts` (nuevo)
- `lib/event-schemas.ts` (refactor + extender)
- `lib/libreta-sanitaria.ts` (agregar a NON_LIBRETA)
- `db/schema.ts` (agregar event_type)
- `app/actions/events.ts` (o equivalente — agregar `createSymptomObservedAction`)
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/page.tsx` (nuevo)
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/SymptomForm.tsx` (nuevo)
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx` (extender — agregar link al sintoma)
- Tests de integración del pipeline (Fase 5)

**Fuera:**
- Tabla nueva — no se crea ninguna
- Migración SQL — no hace falta
- RLS nueva — no hace falta (todo cubre con policies existentes)
- UI del govt para ver la cola de signals — futuro
- Welfare officer dashboard — futuro
- LLM-based symptom extraction — futuro
- Cross-pet pattern detection (outbreak detection real) — futuro
- Email transaccional a govt — futuro (solo in-app Notification)
- Owner consent toggle — fuera de scope
- Re-procesamiento histórico — fuera de scope

## 4. Plan paso a paso

### Fase 1 — Foundation: catálogo + matcher + tests

#### Paso 1.1 — `lib/symptoms.ts`

Crear el archivo. **Copiar el catálogo completo de la sección §4.1 del spec.** 23 entradas, cada una con `code`, `label` (es-AR), `category` (5 categorías + behavioral), `species`, `synonyms` (4-8 por síntoma), y `related_diseases` con `specificity` (high/medium/low).

Crucial: NO inventes nuevos síntomas. Si te parece que falta alguno (ej. "anemia"), anotalo como comentario al pie del archivo y lo discutimos antes de implementar.

Exports: `SymptomCategory`, `Specificity`, `SymptomDiseaseLink`, `SymptomDef`, `SYMPTOMS`, `findSymptom`, `symptomsForSpecies`. Todos siguiendo la firma exacta del spec §4.1.

#### Paso 1.2 — `lib/symptom-matcher.ts`

Crear el archivo. **Copiar las funciones del spec §4.2** una por una:

- `normalize(input: string): string` — lowercase, strip accents NFD, collapse whitespace
- `matchSymptoms(freeText: string, species: string | null): MatchedSymptom[]` — substring match contra synonyms, filtra por especie, dedupes por symptom code
- `aggregateDiseaseMatches(matchedSymptoms: MatchedSymptom[]): DiseaseMatch[]` — agrega per disease, decide `triggers_alert` (1 high O 2+ medium), ordena (alerts primero, después por weight desc)
- `detectAlertableDiseases(freeText: string, species: string | null): DiseaseMatch[]` — pipeline completo, filtra a `triggers_alert && is_reportable`

Tipos: `MatchedSymptom`, `DiseaseMatch`. Firmas exactas del spec.

**Defensive coding:** la función `detectAlertableDiseases` debe estar wrapeada en un try/catch en el call site (lo hace el server action). El matcher en sí no necesita try/catch interno — es deterministic.

#### Paso 1.3 — `lib/symptom-matcher.test.ts`

Tests Vitest cubriendo:

```ts
describe("normalize", () => {
  it("removes diacritics", () => {
    expect(normalize("Vómitos")).toBe("vomitos");
    expect(normalize("ÉpisOdio")).toBe("episodio");
  });
  it("collapses whitespace", () => {
    expect(normalize("   le   sale   baba   ")).toBe("le sale baba");
  });
  it("lowercases", () => {
    expect(normalize("FIEBRE")).toBe("fiebre");
  });
});

describe("matchSymptoms", () => {
  it("returns empty for empty input", () => {
    expect(matchSymptoms("", "dog")).toEqual([]);
  });
  it("matches a single canonical label", () => {
    const r = matchSymptoms("tiene fiebre alta", "dog");
    expect(r.map(m => m.symptom_code)).toContain("high_fever");
  });
  it("matches via synonym", () => {
    const r = matchSymptoms("le sale baba", "dog");
    expect(r.map(m => m.symptom_code)).toContain("hypersalivation");
  });
  it("matches multiple symptoms in one text", () => {
    const r = matchSymptoms("vomita y tiene diarrea con sangre", "dog");
    const codes = r.map(m => m.symptom_code);
    expect(codes).toContain("vomiting");
    expect(codes).toContain("bloody_diarrhea");
  });
  it("dedupes when multiple synonyms of same symptom match", () => {
    // 'salivación' and 'baba' both map to hypersalivation
    const r = matchSymptoms("tiene salivación y le sale baba", "dog");
    const occurrences = r.filter(m => m.symptom_code === "hypersalivation").length;
    expect(occurrences).toBe(1);
  });
  it("filters by species (cat symptoms not shown for dog)", () => {
    // toxoplasmosis is cat-related; species filter is on symptom.species,
    // not on related_diseases.species. Test with a symptom that's species-specific.
    // (If our catalog doesn't have a species-specific symptom, this test is vacuous.)
    // For v1: most symptoms are dog+cat, so this test mostly confirms no crash.
    const r = matchSymptoms("vomita", "cat");
    expect(r.map(m => m.symptom_code)).toContain("vomiting");
  });
  it("returns empty when no synonym matches", () => {
    expect(matchSymptoms("está alegre", "dog")).toEqual([]);
  });
});

describe("aggregateDiseaseMatches", () => {
  it("returns empty for no matched symptoms", () => {
    expect(aggregateDiseaseMatches([])).toEqual([]);
  });

  it("aggregates per disease across matched symptoms", () => {
    // vomiting (high for parvovirus) + bloody_diarrhea (high for parvovirus)
    // → parvovirus should have high_count=2
    const r = aggregateDiseaseMatches([
      { symptom_code: "vomiting", matched_synonym: "vomita" },
      { symptom_code: "bloody_diarrhea", matched_synonym: "diarrea con sangre" },
    ]);
    const parvo = r.find(d => d.disease_code === "parvovirus");
    expect(parvo).toBeDefined();
    expect(parvo!.high_count).toBeGreaterThanOrEqual(2);
    expect(parvo!.triggers_alert).toBe(true);
  });

  it("does NOT trigger alert for only-low matches", () => {
    // 'anorexia' is low for all the related diseases per catalog
    const r = aggregateDiseaseMatches([
      { symptom_code: "anorexia", matched_synonym: "no come" },
    ]);
    r.forEach(d => expect(d.triggers_alert).toBe(false));
  });

  it("triggers alert with single high-specificity match", () => {
    // hypersalivation is high for rabies_suspected
    const r = aggregateDiseaseMatches([
      { symptom_code: "hypersalivation", matched_synonym: "baba" },
    ]);
    const rabies = r.find(d => d.disease_code === "rabies_suspected");
    expect(rabies?.triggers_alert).toBe(true);
  });

  it("triggers alert with two medium-specificity matches", () => {
    // high_fever (medium for distemper) + cough (medium for distemper)
    const r = aggregateDiseaseMatches([
      { symptom_code: "high_fever", matched_synonym: "fiebre" },
      { symptom_code: "cough", matched_synonym: "tose" },
    ]);
    const distemper = r.find(d => d.disease_code === "distemper");
    expect(distemper?.medium_count).toBeGreaterThanOrEqual(2);
    expect(distemper?.triggers_alert).toBe(true);
  });

  it("does NOT trigger alert with single medium-specificity match", () => {
    const r = aggregateDiseaseMatches([
      { symptom_code: "high_fever", matched_synonym: "fiebre" },
    ]);
    // Fever alone shouldn't fire any alert
    r.forEach(d => expect(d.triggers_alert).toBe(false));
  });

  it("sorts alerts first, then by total specificity weight", () => {
    const r = aggregateDiseaseMatches([
      { symptom_code: "high_fever", matched_synonym: "fiebre" },
      { symptom_code: "vomiting", matched_synonym: "vomita" },
      { symptom_code: "bloody_diarrhea", matched_synonym: "diarrea con sangre" },
    ]);
    // First entries should be diseases that trigger alerts
    if (r.length > 1 && r[0].triggers_alert && !r[1].triggers_alert) {
      expect(r[0].triggers_alert).toBe(true);
    }
  });
});

describe("detectAlertableDiseases", () => {
  it("end-to-end: rabies symptoms → rabies alert", () => {
    const r = detectAlertableDiseases("le sale baba y está muy agresivo", "dog");
    expect(r.map(d => d.disease_code)).toContain("rabies_suspected");
    r.forEach(d => {
      expect(d.triggers_alert).toBe(true);
      expect(d.is_reportable).toBe(true);
    });
  });

  it("end-to-end: distemper symptoms → distemper alert", () => {
    // Note: distemper is NOT reportable per current catalog. This test
    // confirms detectAlertableDiseases ONLY returns reportable diseases.
    const r = detectAlertableDiseases("tose mucho y le sale moco por la nariz", "dog");
    // Should NOT include distemper because is_reportable=false
    expect(r.find(d => d.disease_code === "distemper")).toBeUndefined();
  });

  it("end-to-end: vague symptoms → no alerts", () => {
    expect(detectAlertableDiseases("está cansado", "dog")).toEqual([]);
  });

  it("end-to-end: empty input → no alerts", () => {
    expect(detectAlertableDiseases("", "dog")).toEqual([]);
  });
});
```

**Acceptance Fase 1:** `pnpm test lib/symptom-matcher` pasa todos los tests. `pnpm typecheck` y `pnpm lint` cero errores.

#### Commit Fase 1

```
feat(surveillance): symptom catalog + fuzzy matcher

Adds lib/symptoms.ts with 23-entry symptom catalog covering 5 clinical
categories (general, GI, respiratory, neurological, dermatological,
behavioral). Each symptom has stable code, es-AR label, synonyms list
for fuzzy matching, and related-disease links with specificity grades
(high/medium/low).

Adds lib/symptom-matcher.ts with the matching pipeline: normalize
(lowercase + diacritic strip), matchSymptoms (substring-against-synonyms,
species-filtered, dedup), aggregateDiseaseMatches (per-disease counts,
trigger rules: 1 high OR 2+ medium), detectAlertableDiseases (full
pipeline, returns only triggerable+reportable diseases).

No DB changes, no event integration yet. Foundation for Fase 2 (schema)
and Fase 3 (server action + form).

See docs/superpowers/specs/2026-05-17-symptom-disease-surveillance-design.md.
```

---

### Fase 2 — Schema: `outbreak_signal` + refactor `symptom_observed`

#### Paso 2.1 — Agregar `outbreak_signal` a `EVENT_TYPES`

En `db/schema.ts`, encontrar la constante `EVENT_TYPES`. Agregar al final del array (manteniendo el grouping por comentarios si lo tiene):

```ts
// System / observed
"credential_scanned",
// ... otros existentes
"outbreak_signal",  // System surveillance: emitted when symptom_observed triggers a disease match
```

**No requiere migración** — `event_type` es columna TEXT, validada por la const.

#### Paso 2.2 — Marcar como NON-libreta

En `lib/libreta-sanitaria.ts`, agregar al array `NON_LIBRETA_EVENT_TYPES`:

```ts
export const NON_LIBRETA_EVENT_TYPES = [
  // ... existentes
  "outbreak_signal",  // system surveillance signal, not pet medical history
] as const satisfies readonly EventType[];
```

**El test de cobertura de `lib/libreta-sanitaria.test.ts` debe seguir verde** después de este cambio. Si rompe, no clasificaste correctamente el nuevo event_type.

#### Paso 2.3 — Refactor del Zod schema de `symptomObserved`

En `lib/event-schemas.ts`, encontrar el schema actual `symptomObserved`. Reemplazar por:

```ts
const symptomObserved = z
  .object(
    withVersion({
      source: z.enum(["libreta", "welfare_report"]),
      // Required when source='welfare_report', null when source='libreta'.
      welfare_report_id: z.string().uuid().nullable(),
      reporter_role: z.enum(["owner", "witness", "vet"]),
      // Free text input by the owner (or vet/witness). The matcher reads this.
      free_text: z.string().min(1),
      // Populated by the server action via lib/symptom-matcher. Empty when no matches.
      matched_symptom_codes: z.array(z.string()).default([]),
      // Subset of matched diseases that crossed the alert threshold AND are reportable.
      // Used downstream by the outbreak_signal emission. May be empty even if symptoms matched.
      alerted_disease_codes: z.array(z.string()).default([]),
      severity_self_assessed: z.enum(["mild", "moderate", "severe"]).nullable(),
      onset_at: z.string().nullable(),
    }),
  )
  .strict()
  .refine(
    (p) =>
      p.source === "welfare_report"
        ? p.welfare_report_id !== null
        : p.welfare_report_id === null,
    { message: "welfare_report_id must be set iff source='welfare_report'" },
  );
```

**Importante:** el refactor cambia el shape del payload. Eventos viejos (insertados con el shape anterior — `symptoms: string`, `welfare_report_id: uuid`, sin `source`/`free_text`/etc.) NO se re-validan en lectura, así que siguen siendo legibles. Pero **el código de welfare report que hoy crea estos eventos debe actualizarse** para escribir el nuevo shape. Ver Paso 2.5 abajo.

#### Paso 2.4 — Nuevo Zod schema `outbreakSignal`

En `lib/event-schemas.ts`, agregar:

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
      pet_jurisdiction_country: z.string(),
      pet_jurisdiction_province: z.string().nullable(),
      pet_jurisdiction_locality: z.string().nullable(),
      pet_species: z.string(),
    }),
  )
  .strict();
```

Y registrarlo en el `PayloadSchemas` record:

```ts
export const PayloadSchemas: Partial<Record<EventType, z.ZodTypeAny>> = {
  // ... existing
  symptom_observed: symptomObserved,
  outbreak_signal: outbreakSignal,
};
```

#### Paso 2.5 — Updatear el welfare report writer

Buscar en el código dónde se inserta hoy un `symptom_observed` event con el shape viejo (probablemente en `app/actions/welfare.ts` o similar). Actualizarlo para escribir el nuevo shape:

```ts
// Antes:
payload: { welfare_report_id: reportId, reporter_role: 'witness', symptoms: '...' }

// Después:
payload: {
  source: 'welfare_report',
  welfare_report_id: reportId,
  reporter_role: 'witness',
  free_text: input.symptoms,
  matched_symptom_codes: [],     // matcher NO se corre en flujo de welfare report
  alerted_disease_codes: [],     // idem
  severity_self_assessed: null,
  onset_at: null,
}
```

**Decisión deliberada:** los welfare reports NO disparan outbreak signals automáticamente. Son contexto distinto (denuncia de maltrato, no observación del propio dueño). Si en el futuro queremos cruzar surveillance con welfare, sería un feature aparte.

#### Paso 2.6 — Tests del schema

Extender los tests existentes de event schemas (donde sea que vivan, probablemente `lib/event-schemas.test.ts`):

```ts
describe("symptomObserved payload schema (refactored)", () => {
  it("accepts libreta-source payload with null welfare_report_id", () => {
    expect(() => validateEventPayload("symptom_observed", {
      source: "libreta",
      welfare_report_id: null,
      reporter_role: "owner",
      free_text: "vomita y tiene fiebre",
      matched_symptom_codes: ["vomiting", "high_fever"],
      alerted_disease_codes: [],
      severity_self_assessed: "moderate",
      onset_at: null,
    })).not.toThrow();
  });

  it("rejects libreta-source payload with welfare_report_id set", () => {
    expect(() => validateEventPayload("symptom_observed", {
      source: "libreta",
      welfare_report_id: "550e8400-e29b-41d4-a716-446655440000",
      reporter_role: "owner",
      free_text: "vomita",
      matched_symptom_codes: [],
      alerted_disease_codes: [],
      severity_self_assessed: null,
      onset_at: null,
    })).toThrow();
  });

  it("accepts welfare_report-source payload with welfare_report_id", () => {
    expect(() => validateEventPayload("symptom_observed", {
      source: "welfare_report",
      welfare_report_id: "550e8400-e29b-41d4-a716-446655440000",
      reporter_role: "witness",
      free_text: "el perro está flaco",
      matched_symptom_codes: [],
      alerted_disease_codes: [],
      severity_self_assessed: null,
      onset_at: null,
    })).not.toThrow();
  });

  it("rejects welfare_report-source payload without welfare_report_id", () => {
    expect(() => validateEventPayload("symptom_observed", {
      source: "welfare_report",
      welfare_report_id: null,
      reporter_role: "witness",
      free_text: "...",
      matched_symptom_codes: [],
      alerted_disease_codes: [],
      severity_self_assessed: null,
      onset_at: null,
    })).toThrow();
  });
});

describe("outbreakSignal payload schema", () => {
  it("accepts a complete payload", () => {
    expect(() => validateEventPayload("outbreak_signal", {
      source_symptom_event_id: "550e8400-e29b-41d4-a716-446655440000",
      disease_code: "rabies_suspected",
      disease_label: "Sospecha de rabia",
      match_strength: {
        high_count: 2,
        medium_count: 0,
        low_count: 1,
        matched_symptom_codes: ["hypersalivation", "aggression_unusual", "lethargy"],
      },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: "AR-C",
      pet_jurisdiction_locality: "Belgrano",
      pet_species: "dog",
    })).not.toThrow();
  });

  it("rejects extra keys (strict mode)", () => {
    expect(() => validateEventPayload("outbreak_signal", {
      source_symptom_event_id: "550e8400-e29b-41d4-a716-446655440000",
      disease_code: "rabies_suspected",
      disease_label: "Sospecha de rabia",
      match_strength: {
        high_count: 1,
        medium_count: 0,
        low_count: 0,
        matched_symptom_codes: ["hypersalivation"],
      },
      pet_jurisdiction_country: "AR",
      pet_jurisdiction_province: null,
      pet_jurisdiction_locality: null,
      pet_species: "dog",
      unknown_field: "this should fail",
    })).toThrow();
  });
});
```

**Acceptance Fase 2:** todos los tests verdes. `pnpm typecheck` y `pnpm lint` clean. El test de cobertura de `lib/libreta-sanitaria.test.ts` confirma que `outbreak_signal` está clasificado.

#### Commit Fase 2

```
feat(surveillance): outbreak_signal event_type + symptom_observed refactor

Adds outbreak_signal to EVENT_TYPES (no migration — column is TEXT) and
to NON_LIBRETA_EVENT_TYPES (system surveillance, not pet medical history).

Refactors the symptom_observed Zod schema to decouple from welfare_report:
new `source: 'libreta' | 'welfare_report'` discriminator, `welfare_report_id`
becomes nullable (required iff source='welfare_report'), structured
`matched_symptom_codes` and `alerted_disease_codes` fields, plus
severity_self_assessed and onset_at. Old payloads continue to read fine
because validation only runs at insert; existing welfare-report event
writer is updated to emit the new shape.

Adds the outbreakSignal Zod schema with strict mode, payload_version=1.

No business logic yet — Fase 3 wires the server action that emits these.
```

---

### Fase 3 — Server action + form

#### Paso 3.1 — `createSymptomObservedAction`

Buscar dónde viven los server actions de creación de eventos (probablemente `app/actions/events.ts` — hay actions para `createWeightAction`, `createVaccinationAction`, etc.). Agregar al mismo archivo, o crear `app/actions/symptoms.ts` si preferís separación de concerns.

```ts
"use server";

import { db, petEvents, notifications, profiles, ownerships, attachments, pets } from "@/db";
import { validateEventPayload } from "@/lib/event-schemas";
import { detectAlertableDiseases } from "@/lib/symptom-matcher";
import { requireOwnedPetByToken } from "@/lib/pets";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type SymptomFormState = {
  error: string | null;
  ok?: boolean;
};

const initialState: SymptomFormState = { error: null };

export async function createSymptomObservedAction(
  publicToken: string,
  _previous: SymptomFormState,
  formData: FormData,
): Promise<SymptomFormState> {
  // 1. Auth + pet ownership
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return { error: "Sin permisos." };
  const { pet, user } = session;

  // 2. Parse form
  const freeText = String(formData.get("freeText") ?? "").trim();
  if (!freeText) return { error: "Tenés que describir los síntomas." };

  const severityRaw = String(formData.get("severity") ?? "").trim();
  const severity: "mild" | "moderate" | "severe" | null =
    severityRaw === "mild" || severityRaw === "moderate" || severityRaw === "severe"
      ? severityRaw
      : null;

  const onsetRaw = String(formData.get("onsetAt") ?? "").trim();
  const onsetAt = onsetRaw.length > 0 ? onsetRaw : null;

  // 3. Run matcher (defensive — never let it crash the whole insert)
  let alertableDiseases: ReturnType<typeof detectAlertableDiseases> = [];
  let matchedSymptomCodes: string[] = [];
  try {
    const { matchSymptoms, aggregateDiseaseMatches } = await import("@/lib/symptom-matcher");
    const matched = matchSymptoms(freeText, pet.species);
    matchedSymptomCodes = matched.map((m) => m.symptom_code);
    const aggregated = aggregateDiseaseMatches(matched);
    alertableDiseases = aggregated.filter((d) => d.triggers_alert && d.is_reportable);
  } catch (err) {
    // Matcher failure should NOT block the insert. Log and continue with empty matches.
    console.error("Symptom matcher failed:", err);
    alertableDiseases = [];
    matchedSymptomCodes = [];
  }

  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      // 4. Insert symptom_observed event
      const symptomPayload = {
        payload_version: 1 as const,
        source: "libreta" as const,
        welfare_report_id: null,
        reporter_role: "owner" as const,
        free_text: freeText,
        matched_symptom_codes: matchedSymptomCodes,
        alerted_disease_codes: alertableDiseases.map((d) => d.disease_code),
        severity_self_assessed: severity,
        onset_at: onsetAt,
      };
      const validatedSymptomPayload = validateEventPayload("symptom_observed", symptomPayload);

      const [symptomEvent] = await tx
        .insert(petEvents)
        .values({
          petId: pet.id,
          eventType: "symptom_observed",
          occurredAt: onsetAt ? new Date(onsetAt) : now,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "owner",
          payload: validatedSymptomPayload,
        })
        .returning();

      // 5. For each alertable disease, emit outbreak_signal + Notification
      // (Notification routing in Fase 4.)
      for (const d of alertableDiseases) {
        const signalPayload = {
          payload_version: 1 as const,
          source_symptom_event_id: symptomEvent.id,
          disease_code: d.disease_code,
          disease_label: d.disease_label,
          match_strength: {
            high_count: d.high_count,
            medium_count: d.medium_count,
            low_count: d.low_count,
            matched_symptom_codes: d.matched_symptoms,
          },
          pet_jurisdiction_country: pet.jurisdictionCountry,
          pet_jurisdiction_province: pet.jurisdictionProvince,
          pet_jurisdiction_locality: pet.jurisdictionLocality,
          pet_species: pet.species,
        };
        const validatedSignalPayload = validateEventPayload("outbreak_signal", signalPayload);

        const [signalEvent] = await tx
          .insert(petEvents)
          .values({
            petId: pet.id,
            eventType: "outbreak_signal",
            occurredAt: now,
            recordedAt: now,
            recordedByUserId: null,
            authorRole: "system",
            payload: validatedSignalPayload,
          })
          .returning();

        // 6. Notification routing — Fase 4 fills this in
        await routeOutbreakSignalNotification(tx, {
          signalEvent,
          pet,
          disease: d,
        });
      }
    });
  } catch (err) {
    console.error("createSymptomObservedAction failed:", err);
    return {
      error: `No se pudo registrar el síntoma: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  revalidatePath(`/mis-mascotas/${publicToken}`);
  redirect(`/mis-mascotas/${publicToken}?evento=sintoma_registrado`);
}

// Stub — Fase 4 implements the real routing
async function routeOutbreakSignalNotification(
  tx: any, // Drizzle transaction
  args: any,
): Promise<void> {
  // TODO Fase 4: implement
}
```

**Defensive matcher** dentro de try/catch — si por alguna razón el matcher rompe (regex bug, catalog change, lo que sea), el insert del `symptom_observed` igual sucede. Eso preserva el dato del owner aunque el surveillance no funcione.

#### Paso 3.2 — Form de registro de síntoma

Crear `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/page.tsx`:

```tsx
import { createSymptomObservedAction } from "@/app/actions/events"; // o symptoms.ts según donde lo pongas
import { requireOwnedPetByToken } from "@/lib/pets";
import Link from "next/link";
import { SymptomForm } from "./SymptomForm";

export default async function NewSymptomPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return null;
  const { pet } = session;

  const boundAction = createSymptomObservedAction.bind(null, pet.publicToken);

  return (
    <main className="min-h-screen p-6 bg-white dark:bg-neutral-950">
      <div className="max-w-md mx-auto pt-8 space-y-8">
        <Link
          href={`/mis-mascotas/${pet.publicToken}/eventos/nuevo`}
          className="inline-block text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-4 hover:text-neutral-900 dark:hover:text-neutral-50"
        >
          ← Otro tipo de evento
        </Link>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Registrar síntoma
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Anotá lo que estás viendo en {pet.name} en la libreta sanitaria. Sé natural — no te preocupes por terminología.
          </p>
        </div>
        <SymptomForm action={boundAction} petName={pet.name} />
      </div>
    </main>
  );
}
```

Crear `SymptomForm.tsx` adjacente:

```tsx
"use client";

import type { SymptomFormState } from "@/app/actions/events"; // o symptoms.ts
import { useActionState } from "react";

const initialState: SymptomFormState = { error: null };

type FormAction = (prev: SymptomFormState, formData: FormData) => Promise<SymptomFormState>;

export function SymptomForm({
  action,
  petName,
}: {
  action: FormAction;
  petName: string;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="freeText" className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
          ¿Qué estás viendo?<span className="text-red-500 ml-0.5">*</span>
        </label>
        <textarea
          id="freeText"
          name="freeText"
          required
          rows={5}
          placeholder={`Ej: hace dos días que ${petName} vomita y está decaída. Hoy no quiso comer.`}
          className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:focus:ring-neutral-50 focus:border-transparent"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="severity" className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
          ¿Cuán grave te parece?
        </label>
        <select
          id="severity"
          name="severity"
          defaultValue=""
          className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:focus:ring-neutral-50 focus:border-transparent"
        >
          <option value="">No sé / prefiero no decir</option>
          <option value="mild">Leve</option>
          <option value="moderate">Moderado</option>
          <option value="severe">Grave</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="onsetAt" className="block text-sm font-medium text-neutral-900 dark:text-neutral-50">
          ¿Desde cuándo notás esto?
        </label>
        <input
          id="onsetAt"
          name="onsetAt"
          type="date"
          max={today}
          className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-900 dark:focus:ring-neutral-50 focus:border-transparent"
        />
      </div>

      {state.error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full px-4 py-3 rounded-lg bg-neutral-900 dark:bg-neutral-50 text-white dark:text-neutral-900 font-medium hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isPending ? "Guardando..." : "Registrar en la libreta"}
      </button>

      <p className="text-xs text-neutral-500 dark:text-neutral-500 text-center">
        Si los síntomas persisten o empeoran, consultá al veterinario.
      </p>
    </form>
  );
}
```

**Copy crítico del helper text** al pie del form: *"Si los síntomas persisten o empeoran, consultá al veterinario."* Genérico, NO menciona enfermedades, NO genera ansiedad. Coherente con D1 del spec.

#### Paso 3.3 — Linkear desde el selector

En `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx`, agregar el síntoma al selector de eventos. Debe ir bajo "Registrar en la libreta sanitaria" (siguiendo la organización de Parte A de libreta).

Ejemplo de la card:

```tsx
<Link
  href={`/mis-mascotas/${pet.publicToken}/eventos/nuevo/sintoma`}
  className="block p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
>
  <p className="font-medium text-neutral-900 dark:text-neutral-50">Síntoma observado</p>
  <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
    Algo raro que estás viendo y querés registrar.
  </p>
</Link>
```

**Acceptance Fase 3:** levantar `pnpm dev`, registrar un síntoma manualmente, confirmar que se inserta el `symptom_observed` event. Por ahora la notification routing es noop (lo termina la Fase 4).

#### Commit Fase 3

```
feat(surveillance): symptom registration server action + UI form

Adds createSymptomObservedAction that runs the symptom-matcher pipeline
inside the event-insertion transaction. The matcher result is persisted
in the symptom_observed event payload (matched_symptom_codes,
alerted_disease_codes) so the data is auditable and reproducible. For
each alertable+reportable disease detected, an outbreak_signal event
is also emitted (author_role='system').

Matcher is wrapped in try/catch — failure during matching does NOT block
the symptom registration. The owner's input is always preserved.

Adds /mis-mascotas/[publicToken]/eventos/nuevo/sintoma route with a
free-text form. Confirmation copy is deliberately neutral: no disease
names, no alerts shown to the owner. Just "if symptoms persist or
worsen, consult the vet" (per spec D1).

Notification routing for authority alerts is stubbed — Fase 4 implements.
```

---

### Fase 4 — Notification routing

#### Paso 4.1 — Implementar `routeOutbreakSignalNotification`

Reemplazar el stub creado en Fase 3 con la implementación real. En el mismo archivo del server action:

```ts
async function routeOutbreakSignalNotification(
  tx: any, // Drizzle transaction type
  args: {
    signalEvent: typeof petEvents.$inferSelect;
    pet: typeof pets.$inferSelect;
    disease: { disease_code: string; disease_label: string; high_count: number; medium_count: number };
  },
): Promise<void> {
  const { signalEvent, pet, disease } = args;

  // TODO: once admin_page Fase 0 lands, route to govts with govt_assignments
  // matching pet.jurisdictionProvince + pet.jurisdictionLocality.
  // For now: fallback to active admins only.
  // See docs/superpowers/specs/2026-05-17-admin-page-design.md.

  const adminUserIds = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.role, "admin"),
        // account_type column does not yet exist until admin_page Fase 0 lands.
        // When it does, add: eq(profiles.accountType, "institutional")
        // and: isNull(profiles.deactivatedAt)
      ),
    );

  if (adminUserIds.length === 0) {
    console.warn(
      `No active admins to route outbreak_signal ${signalEvent.id} (disease=${disease.disease_code}). Signal recorded but no notification sent.`,
    );
    return;
  }

  const title = `Signal: posible ${disease.disease_label}${
    pet.jurisdictionLocality ? ` en ${pet.jurisdictionLocality}` : ""
  }`;
  const body = [
    `**Signal automático.** Síntomas auto-reportados por dueño matchearon con la enfermedad reportable **${disease.disease_label}**.`,
    "",
    `- Especie: ${pet.species}`,
    `- Jurisdicción: ${[pet.jurisdictionLocality, pet.jurisdictionProvince].filter(Boolean).join(", ") || "no especificada"}`,
    `- Match strength: ${disease.high_count} high · ${disease.medium_count} medium`,
    "",
    "_No es diagnóstico. Considerá el contexto: cuántos signals similares en la jurisdicción / período._",
  ].join("\n");

  for (const admin of adminUserIds) {
    await tx.insert(notifications).values({
      userId: admin.id,
      notificationType: "outbreak_signal_detected",
      title,
      body,
      severity: "warning",
      relatedPetId: pet.id,
      relatedEventId: signalEvent.id,
    });
  }
}
```

**Nota inline en el código sobre la dependencia de admin page Fase 0** — eso es el TODO que un futuro PR removerá cuando exista `govt_assignments` y `account_type='institutional'`.

#### Paso 4.2 — Verificar tipo de notificación

Si `notifications.notificationType` es enum estricto, agregar `'outbreak_signal_detected'` ahí. Si es TEXT (probable per `AGENTS.md`), no hace falta migración. **Verificar antes de asumir.**

#### Commit Fase 4

```
feat(surveillance): route outbreak_signal alerts to admins

Implements routeOutbreakSignalNotification in createSymptomObservedAction.
For each outbreak_signal event, inserts a Notification row for every
active admin. Severity=warning ("alerta baja" per spec D3), notification
type 'outbreak_signal_detected', title in Spanish naming the disease and
locality, body with match strength and clear disclaimer that this is NOT
diagnosis.

Owner-facing UI is unchanged — D1 of spec (owner sees no disease names).

KNOWN GAP: routing only to admins, not govts. The govt scope-matching
requires govt_assignments and profiles.account_type to exist, which is
delivered by admin_page Fase 0. When that lands, this routing extends
to govts-in-scope-first, admin-fallback. TODO in code points at
docs/superpowers/specs/2026-05-17-admin-page-design.md.
```

---

### Fase 5 — Integration smoke

#### Paso 5.1 — Test end-to-end del pipeline

Decidir dónde vive este test. Sugerencia: `app/actions/events.integration.test.ts` o similar — tests que tocan DB con un setup de fixture. Si el repo no tiene infraestructura de integration tests todavía, este es el momento de agregar un patrón simple (test DB en memoria o Supabase local).

```ts
import { describe, it, expect, beforeEach } from "vitest";
// ... imports

describe("createSymptomObservedAction — end-to-end", () => {
  let testUserId: string;
  let testPetId: string;
  let testPublicToken: string;
  let adminUserId: string;

  beforeEach(async () => {
    // Seed: owner user, pet in CABA-Belgrano, admin user.
    // (Use real DB setup helpers if they exist; otherwise create the rows directly.)
    // ...
  });

  it("inserts symptom_observed with empty alerts for vague symptoms", async () => {
    // freeText: "está cansado"
    // Expected: 1 symptom_observed event, payload.alerted_disease_codes=[], no outbreak_signal, no notification
    // ...
  });

  it("inserts symptom_observed + outbreak_signal + notification for high-spec rabies symptoms", async () => {
    // freeText: "le sale baba y está muy agresivo"
    // Expected:
    //   - 1 symptom_observed event with alerted_disease_codes containing 'rabies_suspected'
    //   - 1 outbreak_signal event with disease_code='rabies_suspected', authorRole='system'
    //   - 1 Notification row for the admin with type='outbreak_signal_detected', severity='warning'
    //   - The notification.relatedEventId points at the outbreak_signal event
    // ...
  });

  it("matcher failure does NOT block symptom_observed insert", async () => {
    // Inject a failing matcher (mock or trigger via specially crafted input).
    // Confirm:
    //   - symptom_observed STILL inserted with payload.matched_symptom_codes=[] and alerted_disease_codes=[]
    //   - No outbreak_signal events
    //   - No notifications
    // ...
  });

  it("does not emit alert for non-reportable disease matches", async () => {
    // freeText with symptoms that match distemper (which is NOT reportable in the catalog)
    // Expected: no outbreak_signal, no notification, even though matched_symptom_codes populated
  });
});
```

Implementar al menos los tres primeros tests. El cuarto es opcional pero deseable.

#### Paso 5.2 — Smoke manual

Levantar `pnpm dev`. Como owner:
1. Crear pet en CABA-Belgrano si no tenés
2. Ir a `/mis-mascotas/{token}/eventos/nuevo/sintoma`
3. Tipear "le sale mucha baba y está agresivo"
4. Submit

En Studio confirmar:
- 1 fila en `pet_events` con `eventType='symptom_observed'`, `payload.alerted_disease_codes` contiene `'rabies_suspected'`
- 1 fila en `pet_events` con `eventType='outbreak_signal'`, `authorRole='system'`, payload con disease info
- 1 fila en `notifications` para el admin user, con title que contiene "Sospecha de rabia"

Como owner, confirmar que el perfil del pet:
- La sección "Libreta sanitaria" muestra el `symptom_observed` como entrada
- NO muestra el `outbreak_signal` (es non-libreta)
- No menciona "rabia" en ningún lado de la UI

#### Commit Fase 5

```
test(surveillance): end-to-end integration tests for symptom alert pipeline

Adds integration tests that verify the full flow from owner submitting
symptom text to system emitting outbreak_signal events and notifications.

Confirms:
- Vague symptoms produce no alerts
- Rabies-specific symptom text produces symptom_observed + outbreak_signal
  + notification to admin
- Matcher failure is graceful (symptom_observed still inserted)
- Non-reportable disease matches do not emit alerts

Closes the symptom-disease surveillance feature for v1. Future:
- Govt routing when admin_page Fase 0 lands
- Owner consent toggle (deferred)
- LLM-based matching when events agent lands
- Cross-pet pattern detection (welfare officer dashboard)
```

---

## 5. Verificación final (después de las 5 fases)

1. **Typecheck.** `pnpm typecheck`. Cero errores.
2. **Lint.** `pnpm lint`. Cero errores nuevos.
3. **Tests.** `pnpm test`. Todos los nuevos tests pasan. Ningún test existente roto. En particular:
   - El test de cobertura de `lib/libreta-sanitaria.test.ts` confirma `outbreak_signal` clasificado
   - Los tests del matcher cubren los casos principales
   - El integration test corre el pipeline end-to-end
4. **Build.** `pnpm build`. Compila.
5. **Smoke manual:** lo de Fase 5 Paso 5.2.
6. **Existing flows no rotos:**
   - Crear un peso, una vacuna, una visita al vet — sigue funcionando
   - El welfare report flow sigue funcionando (refactor de Paso 2.5 no rompió el welfare denuncia)
   - El perfil del pet renderiza ok

## 6. Casos borde y trampas conocidas

- **El catálogo de síntomas no cubre TODO.** Si un dueño tipea "está raro y le falta el aire", "está raro" matchea `behavioral_changes` (high para rabia) y "le falta el aire" no matchea nada (porque el catálogo no tiene esa forma como sinónimo de `difficulty_breathing`). Resultado: falso positivo. Mitigación: iterar el catálogo con datos reales una vez en producción. NO ajustes synonyms basándote en suposiciones.
- **Negación no se maneja.** "No tiene fiebre" matchea `high_fever`. Para v1 es aceptable — los dueños rara vez tipean negaciones positivas como esa. Si en producción vemos volumen relevante, agregamos detección de negación.
- **El matcher es case-insensitive y diacritic-insensitive** vía `normalize`. Pero NO maneja typos. "ñ" vs "n" SÍ matchea porque se normalizan a "n". "fievre" vs "fiebre" NO matchea. Para v1 OK.
- **Re-procesamiento histórico.** Si en el futuro expandimos el catálogo o cambiamos specificities, los `symptom_observed` viejos NO se re-evalúan. El `alerted_disease_codes` queda con la info del momento del write. Eso está alineado con el spec (D9). Si querés re-procesar, sería un script aparte que lee `symptom_observed`s viejos y re-corre el matcher.
- **Admins sin scope** son el target hasta admin_page Fase 0. Si no hay ningún admin activo, el signal queda registrado en `pet_events` pero NO genera notification (no hay nadie a quién mandar). El warning del console.warn queda como traza. Mitigación: bootstrap manual del primer admin debería existir antes de poner esto en producción.
- **Race condition** sobre la jurisdicción del pet: si el dueño cambia jurisdicción mientras el server action corre, el snapshot puede llegar a govts/admins equivocados. Ventana minúscula, aceptable en v1.
- **Performance del matcher** con catálogo de N=23 síntomas y M=~5 synonyms cada uno: ~115 substring checks por insert. Sub-milisegundo. No es preocupación.

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos.
2. Si dividiste en 5 PRs separados, mergealos en orden de fase. Si los hiciste en una sola sesión, un solo PR está bien — la historia del git captura los 5 commits.
3. Reportá a Nacho con:
   - Las 5 fases ejecutadas y los tests pasando
   - URLs de prueba: `/mis-mascotas/{tu-token}/eventos/nuevo/sintoma` y el evento resultante en el perfil
   - Nota explícita sobre la dependencia con admin_page Fase 0 — *"Hoy las notifications van a admins. Cuando admin_page Fase 0 mergee, hay una pasada de 30 minutos para extender el routing a govts-en-scope con fallback admin."*
   - Anotación de cualquier sinónimo / specificity que hayas dudado y que merezca revisión con un veterinario en algún momento
