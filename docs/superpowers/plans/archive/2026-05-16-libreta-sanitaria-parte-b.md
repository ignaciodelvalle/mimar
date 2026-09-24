# Libreta Sanitaria — Parte B: ruta dedicada `/libreta`

> Plan de implementación para Claude Code. Crea la vista completa de la libreta sanitaria del dueño autenticado, agrupada por propósito clínico, con stylesheet print-friendly. Depende de Parte A.
>
> **Fecha:** 2026-05-16
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~1 ruta nueva, ~1 componente nuevo, ~2 archivos tocados, 0 migraciones
> **Estimación:** 1 día
> **Depende de:** Parte A (`2026-05-16-libreta-sanitaria-parte-a.md`) mergeada en main

---

## 0. Antes de tocar nada

Lectura obligatoria:

1. **`AGENTS.md` — sección "Libreta sanitaria"**, especialmente "UI surfaces" (#2: dedicated owner route)
2. **`lib/libreta-sanitaria.ts`** (creado en Parte A) — la fuente de verdad de qué es libreta
3. **`app/(app)/mis-mascotas/[publicToken]/page.tsx`** — el link "Ver libreta completa →" hoy apunta a `/historial`; lo redirigís a `/libreta` en este plan
4. **`app/(app)/mis-mascotas/[publicToken]/historial/page.tsx`** — entender qué consultas hace; nuestra `/libreta` reutiliza el patrón pero filtra a libreta
5. **`lib/format.ts`** — `formatDate`, `formatDateTime`, `eventTypeLabel`; vas a reusar todo
6. **`lib/events.ts → eventPayloadSummary`** — devuelve `primary` y `secondary` legibles por evento; lo usás en cada card

## 1. Qué es este feature

Una ruta nueva `/mis-mascotas/{publicToken}/libreta` para el dueño autenticado. Muestra la libreta sanitaria completa de su mascota agrupada por **propósito clínico** (no por fecha por default), con:

- Header de identidad como contexto (foto, nombre, especie, raza, sexo, microchip si hay, dueño first-name)
- Secciones colapsables por grupo: Vacunas, Antiparasitarios, Esterilización, Visitas, Medicación, Cirugías, Estudios, Peso, Alergias y condiciones, Microchip, Síntomas, Incidentes, Fallecimiento
- Toggle a vista cronológica (`?vista=cronologica`) para el dueño que prefiere el orden temporal puro
- Stylesheet print-friendly (que `Ctrl+P` salga decentemente, sin botones, sin nav, sin filtros)
- Empty states por sección y empty state global cuando la mascota no tiene libreta todavía

Lo que **NO** se construye acá: la versión shareable Tier-2 (Parte C), ni el form para generar share tokens. Esta vista es solo para el dueño autenticado de la mascota.

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | URL: `/mis-mascotas/{publicToken}/libreta`. Anidada bajo el pet, no top-level | El acceso ya está auth-gated por el flow del owner; reusamos `requireOwnedPetByToken` |
| D2 | Vista default: **agrupada por propósito clínico**. Toggle a cronológica via `?vista=cronologica` | El paper libreta agrupa así; los dueños buscan por "cuándo le di la antirrábica" más que por "qué pasó en marzo" |
| D3 | El componente principal se llama `<LibretaSanitariaView>` y vive en la misma carpeta de la ruta. **No** se mete en `EventTimeline` — es una vista distinta, no una variante de la timeline | El timeline es cronología + chips; la libreta es secciones agrupadas. Forzar un solo componente que haga las dos cosas lo empuja a complejidad pa' nadie |
| D4 | **Grouping logic vive en `lib/libreta-sanitaria.ts`**, no en el componente. Una función `groupLibretaEvents(events)` que devuelve `{ vacunas: [...], antiparasitarios: [...], ... }`. La UI solo renderiza | Server-side groupable, testeable, reusable en Parte C |
| D5 | `clinical_info_logged` se **subdivide por `payload.sub_kind`**: `lab_work`/`imaging`/`other` → grupo "Estudios"; `surgery` → grupo "Cirugías"; `allergy_detection` → grupo "Alergias y condiciones". Los event types standalone (`lab_work_performed`, `imaging_performed`, `surgery_performed`, `allergy_detected`) van al grupo que les corresponde por nombre | Refleja la realidad del schema: `clinical_info_logged` es el event type unificado en uso, los otros quedaron como legacy ready-to-use pero el agrupamiento debe ser por concepto, no por mecanismo |
| D6 | Print stylesheet via `@media print` en un `<style>` inline o un CSS module local. Oculta nav/botones/filters; layout vertical fluido | Print no es una segunda ruta, es un view del mismo. `Ctrl+P` o iOS Share → Print debe salir bien |
| D7 | El link del pet profile **se actualiza** para apuntar a `/libreta` (no más TODO de Parte A) | El destino existe; el link ya puede ir directo |
| D8 | El layout del header de identidad se **comparte con Parte C** vía un componente extracto (`LibretaIdentityHeader`). Misma forma visual, distinta data binding (en Parte B viene del owner-auth pet; en Parte C viene del share-token resolve) | Evita duplicación cuando Parte C se construye |

## 3. Scope

**Dentro:**
- `app/(app)/mis-mascotas/[publicToken]/libreta/page.tsx` (nuevo)
- `app/(app)/mis-mascotas/[publicToken]/libreta/LibretaSanitariaView.tsx` (nuevo — server component, fetch lo hace la page)
- `app/(app)/mis-mascotas/[publicToken]/libreta/LibretaIdentityHeader.tsx` (nuevo, reusable en Parte C)
- `app/(app)/mis-mascotas/[publicToken]/libreta/libreta-print.css` o styles inline (print stylesheet)
- `lib/libreta-sanitaria.ts` (extender con `groupLibretaEvents()`, `LIBRETA_GROUPS`)
- `lib/libreta-sanitaria.test.ts` (extender con tests del grouper)
- `app/(app)/mis-mascotas/[publicToken]/page.tsx` (cambiar href del link "Ver libreta completa →")

**Fuera:**
- Cualquier flag de "compartir" — eso es Parte C
- Tabla nueva, migración, RLS — eso es Parte C
- Editar / borrar eventos desde la libreta (el log es inmutable; corrections via new events, ya está documentado)
- Mostrar non-libreta en esta ruta (eso es `/historial`)
- Cambios al EventTimeline o al historial

## 4. Plan paso a paso

### Paso 1 — Extender `lib/libreta-sanitaria.ts` con grouping

Agregá al final del archivo:

```ts
/**
 * Logical groups that the libreta is presented as in the dedicated /libreta
 * view. The order here is the display order.
 */
export const LIBRETA_GROUPS = [
  "vacunas",
  "antiparasitarios",
  "esterilizacion",
  "visitas",
  "medicacion",
  "cirugias",
  "estudios",
  "peso",
  "alergias",
  "microchip",
  "sintomas",
  "incidentes",
  "fallecimiento",
] as const;

export type LibretaGroupKey = (typeof LIBRETA_GROUPS)[number];

export const LIBRETA_GROUP_LABELS: Record<LibretaGroupKey, string> = {
  vacunas: "Vacunas",
  antiparasitarios: "Antiparasitarios",
  esterilizacion: "Esterilización",
  visitas: "Visitas al veterinario",
  medicacion: "Medicación",
  cirugias: "Cirugías",
  estudios: "Estudios (laboratorio e imágenes)",
  peso: "Peso",
  alergias: "Alergias y condiciones",
  microchip: "Microchip",
  sintomas: "Síntomas",
  incidentes: "Incidentes",
  fallecimiento: "Fallecimiento",
};

/**
 * Map an event row to its libreta group, or null if it doesn't belong.
 *
 * `clinical_info_logged` is split by payload.sub_kind so the unified
 * event surfaces in the right conceptual group.
 */
export function libretaGroupForEvent(event: {
  eventType: string;
  payload: unknown;
}): LibretaGroupKey | null {
  const type = event.eventType;

  // Direct mappings
  switch (type) {
    case "vaccination_administered":
      return "vacunas";
    case "deworming_administered":
      return "antiparasitarios";
    case "sterilization_performed":
      return "esterilizacion";
    case "vet_visit_logged":
      return "visitas";
    case "medication_started":
    case "medication_stopped":
    case "medication_dose_taken":
      return "medicacion";
    case "weight_recorded":
      return "peso";
    case "microchip_implanted":
      return "microchip";
    case "symptom_observed":
      return "sintomas";
    case "incident_reported":
      return "incidentes";
    case "death_recorded":
      return "fallecimiento";
    case "surgery_performed":
      return "cirugias";
    case "lab_work_performed":
    case "imaging_performed":
      return "estudios";
    case "allergy_detected":
      return "alergias";
  }

  // clinical_info_logged subdivides via sub_kind
  if (type === "clinical_info_logged") {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const sub = typeof p.sub_kind === "string" ? p.sub_kind : null;
    switch (sub) {
      case "surgery":
        return "cirugias";
      case "lab_work":
      case "imaging":
      case "other":
        return "estudios";
      case "allergy_detection":
        return "alergias";
      default:
        return "estudios"; // safe default for new sub_kinds
    }
  }

  return null;
}

/**
 * Group an array of pet events by libreta group, preserving chronological
 * order within each group (newest first, same as input order is assumed
 * to be).
 *
 * Events that don't belong to the libreta (libretaGroupForEvent → null)
 * are silently dropped — the caller should already have filtered, but
 * defense in depth is cheap.
 */
export function groupLibretaEvents<E extends { eventType: string; payload: unknown }>(
  events: readonly E[],
): Record<LibretaGroupKey, E[]> {
  const groups = Object.fromEntries(
    LIBRETA_GROUPS.map((g) => [g, [] as E[]]),
  ) as Record<LibretaGroupKey, E[]>;

  for (const event of events) {
    const g = libretaGroupForEvent(event);
    if (g !== null) groups[g].push(event);
  }
  return groups;
}
```

### Paso 2 — Test del grouper

Extender `lib/libreta-sanitaria.test.ts`:

```ts
import { groupLibretaEvents, libretaGroupForEvent } from "./libreta-sanitaria";

describe("libretaGroupForEvent", () => {
  it("maps direct event types to their group", () => {
    expect(libretaGroupForEvent({ eventType: "vaccination_administered", payload: {} })).toBe("vacunas");
    expect(libretaGroupForEvent({ eventType: "weight_recorded", payload: {} })).toBe("peso");
    expect(libretaGroupForEvent({ eventType: "death_recorded", payload: {} })).toBe("fallecimiento");
  });

  it("splits clinical_info_logged by sub_kind", () => {
    expect(libretaGroupForEvent({ eventType: "clinical_info_logged", payload: { sub_kind: "surgery" } })).toBe("cirugias");
    expect(libretaGroupForEvent({ eventType: "clinical_info_logged", payload: { sub_kind: "lab_work" } })).toBe("estudios");
    expect(libretaGroupForEvent({ eventType: "clinical_info_logged", payload: { sub_kind: "allergy_detection" } })).toBe("alergias");
  });

  it("returns null for non-libreta events", () => {
    expect(libretaGroupForEvent({ eventType: "pet_registered", payload: {} })).toBeNull();
    expect(libretaGroupForEvent({ eventType: "credential_scanned", payload: {} })).toBeNull();
  });
});

describe("groupLibretaEvents", () => {
  it("groups events by clinical purpose", () => {
    const events = [
      { id: "1", eventType: "vaccination_administered", payload: { vaccine_name: "Antirrábica" } },
      { id: "2", eventType: "weight_recorded", payload: { kg: "12" } },
      { id: "3", eventType: "vaccination_administered", payload: { vaccine_name: "Triple" } },
      { id: "4", eventType: "pet_registered", payload: {} }, // dropped
    ];
    const grouped = groupLibretaEvents(events);
    expect(grouped.vacunas).toHaveLength(2);
    expect(grouped.peso).toHaveLength(1);
    expect(grouped.visitas).toHaveLength(0);
  });

  it("preserves insertion order within each group", () => {
    const events = [
      { id: "a", eventType: "weight_recorded", payload: { kg: "10" } },
      { id: "b", eventType: "weight_recorded", payload: { kg: "11" } },
      { id: "c", eventType: "weight_recorded", payload: { kg: "12" } },
    ];
    const grouped = groupLibretaEvents(events);
    expect(grouped.peso.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});
```

### Paso 3 — `LibretaIdentityHeader.tsx`

Componente puro de presentación. Tipos compatibles con lo que Parte C va a recibir desde el share-token resolve.

```tsx
// app/(app)/mis-mascotas/[publicToken]/libreta/LibretaIdentityHeader.tsx

import { sexLabel, speciesLabel } from "@/lib/format";

type Props = {
  pet: {
    name: string;
    species: string;
    breed: string | null;
    sex: string;
    microchipId: string | null;
    publicToken: string;
  };
  photoUrl: string | null;
  ownerFirstName: string | null;
};

export function LibretaIdentityHeader({ pet, photoUrl, ownerFirstName }: Props) {
  return (
    <header className="flex items-start gap-5 pb-5 border-b border-neutral-200 dark:border-neutral-800">
      {photoUrl ? (
        <img
          src={photoUrl}
          alt={pet.name}
          className="w-24 h-24 rounded-2xl object-cover shrink-0"
        />
      ) : (
        <div className="w-24 h-24 rounded-2xl bg-neutral-100 dark:bg-neutral-900 flex items-center justify-center text-3xl font-semibold text-neutral-600 dark:text-neutral-400 shrink-0">
          {pet.name.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-xs text-neutral-500 dark:text-neutral-500 uppercase tracking-wider">
          Libreta sanitaria
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 truncate">
          {pet.name}
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {speciesLabel(pet.species)}
          {pet.breed && ` · ${pet.breed}`}
          {` · ${sexLabel(pet.sex)}`}
        </p>
        {pet.microchipId && (
          <p className="text-xs font-mono text-neutral-500 dark:text-neutral-500">
            Microchip {pet.microchipId}
          </p>
        )}
        {ownerFirstName && (
          <p className="text-xs text-neutral-500 dark:text-neutral-500">
            Dueño/a: {ownerFirstName}
          </p>
        )}
        <p className="text-xs font-mono text-neutral-400 dark:text-neutral-600 tracking-wider pt-1">
          {pet.publicToken}
        </p>
      </div>
    </header>
  );
}
```

### Paso 4 — `LibretaSanitariaView.tsx`

Componente principal. Recibe events ya agrupados y los renderiza por sección.

```tsx
// app/(app)/mis-mascotas/[publicToken]/libreta/LibretaSanitariaView.tsx

import {
  type LibretaGroupKey,
  LIBRETA_GROUPS,
  LIBRETA_GROUP_LABELS,
} from "@/lib/libreta-sanitaria";
import { eventPayloadSummary } from "@/lib/events";
import { formatDate } from "@/lib/format";

type Event = {
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
  notes: string | null;
};

type Props = {
  groupedEvents: Record<LibretaGroupKey, Event[]>;
  publicToken: string;
  vista: "agrupada" | "cronologica";
};

export function LibretaSanitariaView({ groupedEvents, publicToken, vista }: Props) {
  if (vista === "cronologica") {
    return <ChronologicalView groupedEvents={groupedEvents} publicToken={publicToken} />;
  }

  // Hide empty groups; show emptyState only if every group is empty
  const nonEmpty = LIBRETA_GROUPS.filter((g) => groupedEvents[g].length > 0);
  if (nonEmpty.length === 0) return <EmptyLibreta />;

  return (
    <div className="space-y-8">
      {nonEmpty.map((group) => (
        <LibretaGroupSection
          key={group}
          group={group}
          events={groupedEvents[group]}
          publicToken={publicToken}
        />
      ))}
    </div>
  );
}

function LibretaGroupSection({
  group,
  events,
  publicToken,
}: {
  group: LibretaGroupKey;
  events: Event[];
  publicToken: string;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 mb-3">
        {LIBRETA_GROUP_LABELS[group]}{" "}
        <span className="text-sm font-normal text-neutral-500">({events.length})</span>
      </h2>
      <ul className="space-y-2">
        {events.map((event) => (
          <LibretaEntry key={event.id} event={event} publicToken={publicToken} />
        ))}
      </ul>
    </section>
  );
}

function LibretaEntry({ event, publicToken }: { event: Event; publicToken: string }) {
  const summary = eventPayloadSummary(event.eventType, event.payload);
  return (
    <li className="flex items-baseline justify-between gap-3 py-2 border-b border-neutral-100 dark:border-neutral-900 last:border-b-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          {summary.primary ?? event.eventType}
        </p>
        {summary.secondary && (
          <p className="text-xs text-neutral-600 dark:text-neutral-400">{summary.secondary}</p>
        )}
        {event.notes && (
          <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-1 italic">{event.notes}</p>
        )}
      </div>
      <time
        className="text-xs text-neutral-500 dark:text-neutral-500 tabular-nums whitespace-nowrap"
        dateTime={typeof event.occurredAt === "string" ? event.occurredAt : event.occurredAt.toISOString()}
      >
        {formatDate(event.occurredAt)}
      </time>
    </li>
  );
}

function ChronologicalView({
  groupedEvents,
  publicToken,
}: {
  groupedEvents: Record<LibretaGroupKey, Event[]>;
  publicToken: string;
}) {
  // Flatten all groups, sort by occurredAt descending
  const all = LIBRETA_GROUPS.flatMap((g) => groupedEvents[g]).sort(
    (a, b) =>
      new Date(typeof b.occurredAt === "string" ? b.occurredAt : b.occurredAt.toISOString()).getTime() -
      new Date(typeof a.occurredAt === "string" ? a.occurredAt : a.occurredAt.toISOString()).getTime(),
  );
  if (all.length === 0) return <EmptyLibreta />;
  return (
    <ul className="space-y-2">
      {all.map((event) => (
        <LibretaEntry key={event.id} event={event} publicToken={publicToken} />
      ))}
    </ul>
  );
}

function EmptyLibreta() {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 p-10 text-center">
      <p className="text-neutral-700 dark:text-neutral-300">
        Todavía no hay registros en esta libreta.
      </p>
      <p className="text-sm text-neutral-500 dark:text-neutral-500 mt-1">
        Cuando agregues una vacuna, un peso o una visita al vet, va a aparecer acá.
      </p>
    </div>
  );
}
```

### Paso 5 — Page server component

```tsx
// app/(app)/mis-mascotas/[publicToken]/libreta/page.tsx

import { attachments, db, petEvents, profiles } from "@/db";
import { excludeSelfScansClause } from "@/lib/events";
import {
  groupLibretaEvents,
  libretaSanitariaClause,
} from "@/lib/libreta-sanitaria";
import { requireOwnedPetByToken } from "@/lib/pets";
import { petPhotoUrl } from "@/lib/storage";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { LibretaIdentityHeader } from "./LibretaIdentityHeader";
import { LibretaSanitariaView } from "./LibretaSanitariaView";

export default async function LibretaPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return null;
  const { pet, user } = session;

  // Owner first name for the header.
  const [profile] = await db
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);
  const ownerFirstName = profile?.displayName?.split(" ")[0] ?? null;

  // Photo URL via the existing helper.
  const photoUrl = pet.primaryPhotoId
    ? await (async () => {
        const [row] = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, pet.primaryPhotoId!))
          .limit(1);
        return petPhotoUrl(row?.storagePath);
      })()
    : null;

  // Libreta events.
  const events = await db
    .select()
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, pet.id),
        excludeSelfScansClause(),
        libretaSanitariaClause(),
      ),
    )
    .orderBy(desc(petEvents.occurredAt));

  const grouped = groupLibretaEvents(events);

  const vista = sp.vista === "cronologica" ? "cronologica" : "agrupada";

  return (
    <main className="min-h-screen p-6 bg-white dark:bg-neutral-950 print:p-0 print:bg-white">
      <div className="max-w-2xl mx-auto pt-6 pb-20 space-y-6 print:max-w-none print:pt-0">
        <div className="flex items-center justify-between gap-4 print:hidden">
          <Link
            href={`/mis-mascotas/${pet.publicToken}`}
            className="text-sm text-neutral-600 dark:text-neutral-400 underline underline-offset-4 hover:text-neutral-900 dark:hover:text-neutral-50"
          >
            ← Volver a {pet.name}
          </Link>
          <ViewToggle publicToken={pet.publicToken} vista={vista} />
        </div>

        <LibretaIdentityHeader pet={pet} photoUrl={photoUrl} ownerFirstName={ownerFirstName} />

        <LibretaSanitariaView
          groupedEvents={grouped}
          publicToken={pet.publicToken}
          vista={vista}
        />

        <footer className="hidden print:block text-xs text-neutral-500 pt-8">
          Generada por MiMAR · {new Date().toLocaleString("es-AR")}
        </footer>
      </div>
    </main>
  );
}

function ViewToggle({
  publicToken,
  vista,
}: {
  publicToken: string;
  vista: "agrupada" | "cronologica";
}) {
  return (
    <div className="flex items-center gap-1 text-xs">
      <Link
        href={`/mis-mascotas/${publicToken}/libreta`}
        className={`px-2.5 py-1 rounded-md ${vista === "agrupada" ? "bg-neutral-900 dark:bg-neutral-50 text-white dark:text-neutral-900" : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}
      >
        Por sección
      </Link>
      <Link
        href={`/mis-mascotas/${publicToken}/libreta?vista=cronologica`}
        className={`px-2.5 py-1 rounded-md ${vista === "cronologica" ? "bg-neutral-900 dark:bg-neutral-50 text-white dark:text-neutral-900" : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}
      >
        Cronológica
      </Link>
    </div>
  );
}
```

### Paso 6 — Actualizar el link del pet profile

En `app/(app)/mis-mascotas/[publicToken]/page.tsx`, buscá el TODO que dejó Parte A:

```tsx
{/* TODO Parte B: cuando exista /libreta, cambiar href a `/mis-mascotas/${publicToken}/libreta`. */}
<Link href={`/mis-mascotas/${pet.publicToken}/historial`}>
  Ver libreta completa →
</Link>
```

Reemplazar por:

```tsx
<Link href={`/mis-mascotas/${pet.publicToken}/libreta`}>
  Ver libreta completa →
</Link>
```

Y borrá el comentario TODO.

### Paso 7 — Print stylesheet

El layout ya usa `print:hidden` y `print:p-0` en el page (Tailwind). Si querés más fineza, agregá un `<style>` global en el layout o un CSS module local con reglas adicionales:

```css
@media print {
  /* Force black on white */
  html, body { background: white !important; color: black !important; }
  /* Avoid breaking inside an entry */
  li { page-break-inside: avoid; }
  /* Slight section spacing */
  section { page-break-before: auto; margin-bottom: 1rem; }
  /* Hide all interactive */
  button, a[href]:not([href^="#"]) { display: none !important; }
}
```

Decisión sobre dónde meter esto: crear `app/(app)/mis-mascotas/[publicToken]/libreta/libreta-print.css` y `import "./libreta-print.css"` desde la page server component. Next.js lo va a empaquetar correctamente.

## 5. Verificación

1. **Typecheck.** `pnpm typecheck`. Cero errores.
2. **Lint.** `pnpm lint`. Cero errores nuevos.
3. **Tests.** `pnpm test`. Los tests del grouper pasan. Todos los existentes verdes.
4. **Build.** `pnpm build`. Compila.
5. **Smoke manual:**
   - Andá a `/mis-mascotas/{tu-token}/libreta`. La página carga.
   - El header muestra foto, nombre, especie, sexo, microchip si aplica.
   - Las secciones aparecen solo si tienen eventos (no hay empty per-section ruido).
   - Click en "Cronológica" → la URL cambia a `?vista=cronologica` y los eventos se muestran en orden de fecha sin agrupar.
   - Click en "Volver a {Pet}" → vuelve al perfil.
   - Desde el perfil, "Ver libreta completa →" ahora lleva a `/libreta`.
   - `Ctrl+P`: el preview de impresión no muestra los botones, el toggle, ni el link de volver. Sale el header de identidad + las secciones + footer con timestamp.
   - Una mascota sin libreta muestra el empty state.

## 6. Casos borde

- **Mascota fallecida.** El `death_recorded` aparece en su sección "Fallecimiento". El perfil principal redirige a la in-memoriam view antes de llegar acá; pero si alguien va directo a `/libreta` con una mascota deceased, **debe seguir cargando** (la libreta no se borra cuando la mascota muere — sigue siendo el registro). No agregues un redirect.
- **Mascota en tránsito** (shelter_custody). El owner tiene acceso (la `requireOwnedPetByToken` ya cubre ambos roles owner y shelter_custody). La libreta funciona idéntico.
- **Multiple medicación entries en curso.** El grupo "Medicación" lista `medication_started`, `medication_stopped`, `medication_dose_taken` mezclados ordenados por `occurred_at`. No agrupar por drug_name todavía — eso es un upgrade futuro (puede confundir si una mascota tomó 3 medicamentos distintos en el mismo período).
- **Muchos `weight_recorded`.** La sección Peso puede tener decenas. No paginar en v1, mostrar todo. Si en uso real se ve que es necesario, paginar después.
- **`pet_events` con `payload_version` nuevo.** El `eventPayloadSummary` ya maneja eso (es del hardening). No hay que tocar nada.
- **Idioma del header.** "Dueño/a:" — usa el género indeterminado. Si en el futuro hay preferencia de género en profile, ajustar. Por ahora ese es el copy.

## 7. Cuando termines

1. Marcá los chequeos del paso 5.
2. Commit:
   ```
   feat(libreta): dedicated /libreta route — Parte B

   New route /mis-mascotas/[publicToken]/libreta showing the dueño the
   full libreta sanitaria of their pet, grouped by clinical purpose by
   default (toggle to chronological via ?vista=cronologica). Print-
   friendly stylesheet so Ctrl+P produces a clean document.

   Adds groupLibretaEvents() and libretaGroupForEvent() to
   lib/libreta-sanitaria.ts with tests. Reuses the existing
   eventPayloadSummary for entry rendering.

   Extracts LibretaIdentityHeader as a shared component — Parte C
   (Tier-2 shareable) will reuse it with share-token-resolved pet data.

   Updates the pet-profile link "Ver libreta completa →" to point at
   the new route (was a TODO from Parte A).

   AGENTS.md → "Libreta sanitaria" is the canonical source.
   ```
3. Reportá a Nacho:
   - URL de prueba: `/mis-mascotas/{tu-token}/libreta`
   - Confirmá que `Ctrl+P` sale bien (sin botones, con timestamp en footer)
   - Próximo paso: Parte C agrega el shareable Tier-2 reusando `LibretaIdentityHeader` y `LibretaSanitariaView` desde una ruta pública gateada por share token
