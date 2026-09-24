# Libreta Sanitaria — Parte A: primitivas + rename del perfil

> Plan de implementación para Claude Code. Foundational: lockea el vocabulario "Libreta sanitaria" en el código antes que ningún otro feature lo necesite. Las Partes B y C dependen de esto.
>
> **Fecha:** 2026-05-16
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~1 archivo nuevo, ~3-4 archivos tocados, 0 migraciones, 0 schema changes, 0 RLS
> **Estimación:** medio día

---

## 0. Antes de tocar nada

Lectura obligatoria en este orden:

1. **`AGENTS.md` — sección "Libreta sanitaria"** (entre "Notification" y "Event catalog"). Esa sección es el contrato. Si algo en este plan la contradice, gana AGENTS.md
2. **`db/schema.ts`** — la constante `EVENT_TYPES` y el tipo `EventType`
3. **`lib/event-schemas.ts`** — para entender el patrón de `Partial<Record<EventType, ...>>` que vamos a reusar
4. **`app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx`** — el componente actual de renderizado de timeline; vamos a agregarle una prop `chips`, no a reescribirlo
5. **`app/(app)/mis-mascotas/[publicToken]/page.tsx`** — donde vive la sección "Eventos" hoy; la sección que se renombra a "Libreta sanitaria"
6. **`app/(app)/mis-mascotas/[publicToken]/historial/page.tsx`** — la página de historial completo; **NO se toca** (es el view crudo del event log, sigue siendo "todos los movimientos")

## 1. Qué es este feature

Materializar en código la decisión de nomenclatura locked en `AGENTS.md → Libreta sanitaria`. Tres cosas chiquitas con leverage enorme:

1. **Primitivas en `lib/libreta-sanitaria.ts`** — `LIBRETA_SANITARIA_EVENT_TYPES`, `isLibretaSanitariaEvent()`, helper de Drizzle para filtrar queries
2. **Sección "Eventos" del pet profile → "Libreta sanitaria"** — la card que hoy lista los eventos recientes pasa a llamarse y a filtrar solo a los event types médicos
3. **Test de cobertura** — todo `EventType` está clasificado: o pertenece a la libreta, o explícitamente declarado fuera. Sin tibios

Lo que **NO** se construye en Parte A: ni la ruta nueva `/libreta` (Parte B) ni la shareable Tier-2 (Parte C) ni nada de admin. Esta parte lockea el vocabulario y deja el camino libre.

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | El listado canónico de event types de libreta vive en `lib/libreta-sanitaria.ts`, no en `db/schema.ts` ni en `lib/events.ts` | `schema.ts` es de Drizzle (tabla); `events.ts` es de read paths genéricos; libreta-sanitaria es un concepto de UX/produto que se proyecta sobre eventos. Separación de concerns |
| D2 | `EventTimeline` se queda como rendering primitive. Le agregamos prop `chips?: ReadonlyArray<{type, label}>` con default a las chips actuales (todos los event types). Cuando se invoca desde el contexto libreta, se le pasa `LIBRETA_FILTER_CHIPS` | No queremos dos componentes paralelos. El timeline es agnóstico al subset; la decisión vive en quien lo monta |
| D3 | El filtro al subset libreta se hace **en la query** (Drizzle) usando un helper SQL nuevo `libretaSanitariaClause()`. **No** se filtra en el client component | El client component no debería saber sobre semántica de event types. Y filtrar server-side reduce el payload que viaja al browser |
| D4 | `/historial` no se toca en Parte A — sigue siendo "todos los movimientos" del pet, sin filtro de libreta | Esa es la vista de power user / admin / debug. Mostrar tanto libreta como no-libreta sigue siendo útil ahí |
| D5 | El link en el pet profile "Ver historial completo" cambia a "Ver libreta completa" pero **apunta a `/historial` por ahora** (Parte B lo redirige a `/libreta`). Nota inline en el código que esto es transitorio | Si cambiamos el copy ahora y el destino después, no rompemos nada. Si esperamos a Parte B para cambiar el copy, el rename queda incompleto |
| D6 | El selector `/eventos/nuevo/page.tsx` reagrupa las opciones en dos secciones: **"Registrar en la libreta sanitaria"** (las médicas) y **"Otros registros"** (notas) | Hace visible la jerarquía conceptual sin cambiar URLs ni forms. Los slugs de cada form quedan intactos (contrato del agente conversacional) |
| D7 | Los submit buttons de cada form de evento se quedan como están ("Registrar peso", "Guardar vacuna", etc.) — son ya específicos por tipo, no genéricos | No hay nada que renombrar acá |

## 3. Scope

**Dentro:**
- `lib/libreta-sanitaria.ts` (nuevo)
- `lib/libreta-sanitaria.test.ts` (nuevo)
- `app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx` (agregar prop `chips` opcional, backward compat)
- `app/(app)/mis-mascotas/[publicToken]/page.tsx` (filtrar query a libreta, renombrar sección y link)
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx` (reagrupar selector)

**Fuera:**
- Cualquier ruta nueva (Parte B)
- Cualquier tabla nueva o migración (Parte C)
- `/historial` (sigue como está)
- Forms individuales de creación de evento (siguen igual)
- AGENTS.md (ya está actualizado)
- Componentes de notificaciones, denuncias, custody, organizaciones

## 4. Plan paso a paso

Hacé los pasos en este orden. Después de cada paso, `pnpm typecheck` + `pnpm lint`.

### Paso 1 — Crear `lib/libreta-sanitaria.ts`

```ts
// lib/libreta-sanitaria.ts

/**
 * Libreta sanitaria — projection over pet_events filtered to medical entries.
 *
 * Canonical source of truth: AGENTS.md → "Libreta sanitaria".
 *
 * Every new EventType added to db/schema.ts → EVENT_TYPES must explicitly
 * declare whether it belongs to the libreta. The test in
 * lib/libreta-sanitaria.test.ts will fail if a new EventType is not
 * classified (either listed below as part of the libreta, or listed in
 * `NON_LIBRETA_EVENT_TYPES` as deliberate exclusion).
 */

import { sql } from "drizzle-orm";

import { EVENT_TYPES, type EventType } from "@/db/schema";

/**
 * Event types that are part of the dueño's libreta sanitaria — the
 * medical record the vet writes and the dueño carries. These are the
 * entries that appear in the libreta-sanitaria UI surfaces (the pet
 * profile section, the dedicated `/libreta` route in Parte B, and the
 * shareable Tier-2 route in Parte C).
 */
export const LIBRETA_SANITARIA_EVENT_TYPES = [
  "vaccination_administered",
  "deworming_administered",
  "sterilization_performed",
  "medication_started",
  "medication_stopped",
  "medication_dose_taken",
  "vet_visit_logged",
  "weight_recorded",
  "clinical_info_logged",
  "lab_work_performed",
  "imaging_performed",
  "surgery_performed",
  "allergy_detected",
  "microchip_implanted",
  "incident_reported",
  "symptom_observed",
  "death_recorded",
] as const satisfies readonly EventType[];

/**
 * Event types that are deliberately OUTSIDE the libreta sanitaria —
 * identity / admin / custody / welfare / system entries. This list is
 * exhaustive together with `LIBRETA_SANITARIA_EVENT_TYPES`: every
 * EVENT_TYPES value must appear in exactly one of the two.
 */
export const NON_LIBRETA_EVENT_TYPES = [
  "pet_registered",              // identity, not health
  "pet_profile_updated",         // admin
  "status_changed",              // lost/found, identity-adjacent
  "credential_scanned",          // system telemetry
  "dangerous_breed_attested",    // legal, not clinical
  "custody_transfer_proposed",   // custody, not health
  "custody_transferred",
  "shelter_intake_recorded",
  "foster_assigned",
  "foster_ended",
  "adoption_application_submitted",
  "adoption_application_reviewed",
  "adoption_application_approved",
  "adoption_application_rejected",
  "adoption_finalized",
  "post_adoption_checkin",
  "adoption_revoked",
  "abandonment_reported",        // welfare denuncia, not health
  "maltreatment_reported",
  "note_added",                  // owner annotation, lives in a separate view
] as const satisfies readonly EventType[];

const LIBRETA_SET: ReadonlySet<string> = new Set(LIBRETA_SANITARIA_EVENT_TYPES);

export function isLibretaSanitariaEvent(eventType: EventType): boolean {
  return LIBRETA_SET.has(eventType);
}

/**
 * Drizzle SQL clause that restricts a `pet_events` query to libreta
 * entries only. Use in WHERE clauses.
 *
 * Example:
 *   const events = await db
 *     .select()
 *     .from(petEvents)
 *     .where(and(eq(petEvents.petId, pet.id), libretaSanitariaClause()))
 *     .orderBy(desc(petEvents.occurredAt));
 *
 * The list is interpolated as a SQL array literal — Postgres handles the
 * `ANY()` membership efficiently and `event_type` is indexed in
 * downstream queries.
 */
export function libretaSanitariaClause() {
  const typesArray = `{${LIBRETA_SANITARIA_EVENT_TYPES.join(",")}}`;
  return sql`event_type = ANY(${typesArray}::text[])`;
}

/**
 * Filter chips for the EventTimeline when mounted in a libreta context.
 * Subset of the existing FILTER_CHIPS in EventTimeline.tsx, kept here so
 * the libreta-specific list is co-located with the libreta concept.
 */
export const LIBRETA_FILTER_CHIPS: ReadonlyArray<{ type: EventType; label: string }> = [
  { type: "vaccination_administered", label: "Vacunas" },
  { type: "deworming_administered", label: "Antiparasitarios" },
  { type: "sterilization_performed", label: "Esterilización" },
  { type: "vet_visit_logged", label: "Visitas" },
  { type: "weight_recorded", label: "Peso" },
  { type: "medication_started", label: "Medicación · inicio" },
  { type: "medication_stopped", label: "Medicación · fin" },
  { type: "medication_dose_taken", label: "Dosis dadas" },
  { type: "microchip_implanted", label: "Microchip" },
  { type: "clinical_info_logged", label: "Información clínica" },
  { type: "symptom_observed", label: "Síntomas" },
  { type: "incident_reported", label: "Incidentes" },
  { type: "death_recorded", label: "Fallecimiento" },
];
```

### Paso 2 — Test de cobertura

```ts
// lib/libreta-sanitaria.test.ts

import { describe, expect, it } from "vitest";

import { EVENT_TYPES, type EventType } from "@/db/schema";
import {
  LIBRETA_FILTER_CHIPS,
  LIBRETA_SANITARIA_EVENT_TYPES,
  NON_LIBRETA_EVENT_TYPES,
  isLibretaSanitariaEvent,
} from "./libreta-sanitaria";

describe("LIBRETA_SANITARIA_EVENT_TYPES coverage", () => {
  it("every EVENT_TYPES entry is classified exactly once", () => {
    const libretaSet = new Set<string>(LIBRETA_SANITARIA_EVENT_TYPES);
    const nonLibretaSet = new Set<string>(NON_LIBRETA_EVENT_TYPES);
    const unclassified: string[] = [];
    const doubleClassified: string[] = [];

    for (const t of EVENT_TYPES) {
      const inLibreta = libretaSet.has(t);
      const inNonLibreta = nonLibretaSet.has(t);
      if (!inLibreta && !inNonLibreta) unclassified.push(t);
      if (inLibreta && inNonLibreta) doubleClassified.push(t);
    }

    expect(unclassified, "Unclassified event types — add to LIBRETA_SANITARIA_EVENT_TYPES or NON_LIBRETA_EVENT_TYPES").toEqual([]);
    expect(doubleClassified, "Event types appear in both lists").toEqual([]);
  });

  it("LIBRETA_FILTER_CHIPS only references libreta event types", () => {
    for (const chip of LIBRETA_FILTER_CHIPS) {
      expect(
        isLibretaSanitariaEvent(chip.type),
        `Chip ${chip.type} (${chip.label}) is not in LIBRETA_SANITARIA_EVENT_TYPES`,
      ).toBe(true);
    }
  });

  it("isLibretaSanitariaEvent returns the right answer for known types", () => {
    expect(isLibretaSanitariaEvent("vaccination_administered" as EventType)).toBe(true);
    expect(isLibretaSanitariaEvent("pet_registered" as EventType)).toBe(false);
    expect(isLibretaSanitariaEvent("credential_scanned" as EventType)).toBe(false);
    expect(isLibretaSanitariaEvent("weight_recorded" as EventType)).toBe(true);
  });
});
```

**Importante:** este test es el guardrail que evita drift futuro. Si alguien agrega un `event_type` al `EVENT_TYPES` y olvida clasificarlo, este test rompe el build. Eso es exactamente lo que queremos.

### Paso 3 — Agregar prop `chips` a `EventTimeline`

Buscá `app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx`. Hoy tiene una constante `FILTER_CHIPS` hardcodeada al top. Cambios:

**Cambio 3a — exportar el default actual** para que `/historial` lo pueda referenciar explícitamente:

```ts
export const DEFAULT_FILTER_CHIPS: ReadonlyArray<{ type: string; label: string }> = [
  // ... el contenido actual de FILTER_CHIPS, sin tocarlo
];
```

Quitá la constante local `FILTER_CHIPS` y reemplazá todos sus usos en el componente con `chips ?? DEFAULT_FILTER_CHIPS`.

**Cambio 3b — agregar prop opcional `chips`** al tipo `Props` y al destructuring del componente:

```ts
type Props = {
  events: Event[];
  publicToken?: string;
  chips?: ReadonlyArray<{ type: string; label: string }>;
};

export function EventTimeline({ events, publicToken, chips }: Props) {
  // ...
  const effectiveChips = chips ?? DEFAULT_FILTER_CHIPS;
  // usar `effectiveChips` en lugar del FILTER_CHIPS hardcodeado
}
```

Esto preserva backward compat: cualquier caller que no pase `chips` sigue viendo lo mismo de antes.

### Paso 4 — Pet profile: filtrar query + renombrar sección

En `app/(app)/mis-mascotas/[publicToken]/page.tsx`:

**Cambio 4a — extender la query.** Hoy carga los eventos para la sección recent con algo tipo:

```ts
const events = await db
  .select()
  .from(petEvents)
  .where(and(eq(petEvents.petId, pet.id), excludeSelfScansClause()))
  .orderBy(desc(petEvents.occurredAt));
```

Agregar `libretaSanitariaClause()`:

```ts
import { libretaSanitariaClause, LIBRETA_FILTER_CHIPS } from "@/lib/libreta-sanitaria";

const events = await db
  .select()
  .from(petEvents)
  .where(and(
    eq(petEvents.petId, pet.id),
    excludeSelfScansClause(),
    libretaSanitariaClause(),
  ))
  .orderBy(desc(petEvents.occurredAt));
```

**Cambio 4b — pasar `chips`** al `<EventTimeline>` montado en el perfil:

```tsx
<EventTimeline
  events={eventsWithAttachments}
  publicToken={pet.publicToken}
  chips={LIBRETA_FILTER_CHIPS}
/>
```

**Cambio 4c — renombrar el header de la sección.** Buscá el texto "Eventos" (o como sea que se llame la sección donde se monta EventTimeline en el pet profile) y reemplazá por "Libreta sanitaria". Si hay un subtitulo / copy de descripción, ajustar para que diga algo tipo *"Lo que el vet le anota a {pet.name}."*

**Cambio 4d — renombrar el link** "Ver historial completo" (o similar) a **"Ver libreta completa →"**. Por ahora el href sigue apuntando a `/mis-mascotas/${publicToken}/historial` — agregar un comentario inline:

```tsx
{/* TODO Parte B: cuando exista /libreta, cambiar href a `/mis-mascotas/${publicToken}/libreta`. */}
<Link href={`/mis-mascotas/${pet.publicToken}/historial`}>
  Ver libreta completa →
</Link>
```

### Paso 5 — Reagrupar el selector de creación de evento

En `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx`, dividir el listado en dos grupos visuales:

```
─── Registrar en la libreta sanitaria ────────────
  Vacuna · Antiparasitario · Esterilización · Peso · 
  Visita al vet · Microchip · Información clínica · 
  Medicación inicio · Medicación fin · Fallecimiento

─── Otros registros ────────────────────────────
  Nota
```

Mantener los hrefs como están. La distinción es visual, no funcional. Si la página tenía un h1 genérico tipo *"Nuevo evento"*, cambialo a *"Registrar"*.

## 5. Verificación

Después de los 5 pasos:

1. **Typecheck.** `pnpm typecheck`. Cero errores.
2. **Lint.** `pnpm lint`. Cero errores nuevos.
3. **Tests.** `pnpm test`. El test nuevo `lib/libreta-sanitaria.test.ts` pasa. Todos los tests existentes siguen verdes.
4. **Build.** `pnpm build`. Compila.
5. **Smoke manual:**
   - `pnpm dev`, autenticate, andá a una mascota tuya.
   - El perfil muestra "Libreta sanitaria" como título de la sección de eventos. **No aparece** un `pet_registered` ni un `pet_profile_updated` en la lista (esos no son libreta).
   - Las filter chips muestran solo las opciones de libreta (Vacunas, Antiparasitarios, etc.). **No aparecen** chips de "Maltrato" / "Abandono".
   - El link "Ver libreta completa →" sigue funcionando (lleva a `/historial`).
   - El selector de "Registrar" muestra dos grupos: "Registrar en la libreta sanitaria" y "Otros registros".
   - El `/historial` sigue mostrando **todos** los eventos (incluyendo `pet_registered`) y todas las filter chips (incluyendo "Maltrato", "Abandono"). No se rompió nada.

Si cualquiera falla, no marques el plan como completo. Reportá el problema.

## 6. Casos borde

- **Una mascota recién creada solo tiene `pet_registered` (no es libreta).** La sección "Libreta sanitaria" del perfil aparece vacía. El empty state debería decir algo amistoso tipo *"Todavía no anotaste nada en la libreta de {pet.name}. Cuando le des una vacuna o un antiparasitario, va a aparecer acá."* — agregar este empty state explícitamente en el render condicional del EventTimeline (o en el wrapper del pet profile, donde sea más limpio).
- **Una mascota fallecida.** El `death_recorded` SÍ es libreta (lo declaramos en la lista). La sección lo muestra. Bien.
- **`microchip_implanted` se emite automáticamente al crear pet con chip.** Eso significa que el evento aparece desde el alta — bien, refleja que la microchip-implantation es un acto médico real.
- **Una mascota en tránsito** (post Parte A del feature de vecino) tiene `Ownership.role='shelter_custody'`. Su libreta sigue siendo legítima — el banner en el perfil ya dice "La libreta sanitaria que armes acá viaja con la mascota". Coherente con lo que ya está en código.
- **Un test del CI rompe porque alguien agregó un event_type sin clasificar.** Eso es el comportamiento deseado. El test del paso 2 hace exactamente eso. Quien hizo el cambio debe agregar a `LIBRETA_SANITARIA_EVENT_TYPES` o a `NON_LIBRETA_EVENT_TYPES`. No hay tercera opción.

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos.
2. Commit:
   ```
   feat(libreta): introduce Libreta Sanitaria projection — Parte A

   Adds lib/libreta-sanitaria.ts with LIBRETA_SANITARIA_EVENT_TYPES,
   NON_LIBRETA_EVENT_TYPES (exhaustive together with the former),
   isLibretaSanitariaEvent() helper, libretaSanitariaClause() Drizzle
   SQL clause, and LIBRETA_FILTER_CHIPS.

   Adds a Vitest coverage test that asserts every EVENT_TYPES value is
   classified in exactly one of the two lists — drift-blocking.

   Renames the pet-profile events section from "Eventos" to "Libreta
   sanitaria", filters its query to libreta types only, and uses
   LIBRETA_FILTER_CHIPS. The /historial route is unchanged — that's
   the all-events admin view.

   The /eventos/nuevo selector now groups options into "Registrar en la
   libreta sanitaria" and "Otros registros". No URL changes.

   Foundational for Partes B (dedicated /libreta route) and C
   (Tier-2 shareable share token surface). AGENTS.md → "Libreta
   sanitaria" is the canonical source.
   ```
3. Reportá a Nacho:
   - Qué quedó: vocabulario locked, sección renombrada, filtros aplicados, test de cobertura corriendo.
   - URL de prueba: `/mis-mascotas/{tu-token}` muestra la sección "Libreta sanitaria".
   - Próximo paso: Parte B crea `/libreta` como ruta dedicada con vista agrupada.
