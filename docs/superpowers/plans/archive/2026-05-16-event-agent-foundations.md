# Event-agent foundations — registry + reference URL-prefill

> Plan de implementación para Claude Code. Auto-contenido. Pequeño, alto leverage, paga la pena AHORA aunque el agente conversacional llegue en seis meses o nunca.
>
> **Fecha:** 2026-05-16
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~3 archivos nuevos, ~2 archivos tocados, 0 migraciones, 0 schema changes

---

## 0. Contexto — por qué este plan existe ahora

El event-sourcing hardening (prompt original archivado en `dim-interno:docs/archive/event-sourcing-hardening-prompt.md`; implementación viva en `lib/event-schemas.ts` + triggers DB) cerró la mayor parte de los gaps que hacían riesgoso construir un agente conversacional encima de DIM:

- Items 1, 2, 4 y 6 **están implementados** (projection rebuild script, Zod schemas estrictos por event_type, trigger append-only, filtro server-side de self-scans)
- Item 3 **está parcialmente implementado** (`payload_version: z.literal(1).default(1)` está en cada schema; el upcaster registry no existe todavía pero tampoco hay nada para upcastear — la fundación está)
- Item 5 (UUIDv7) **no está hecho** — irrelevante para el agente, queda esperando a que llegue el primer projector / stream consumer

Esto deja **una sola pieza realmente crítica** para que el agente conversacional sea barato de construir cuando llegue: **la disciplina de URL-prefill en los forms de creación de evento**, capturada en el bullet "Conversational event-capture agent" que ya está en `AGENTS.md → Open questions / future work`.

Hacer el retrofit completo de los ~13 forms existentes hoy es trabajo tedioso para una feature deferred. Pero hacer **cero** hoy es dejar la regla del AGENTS.md como aspiracional, no ejecutable. Este plan es el punto medio inteligente: **establecer el patrón con una implementación de referencia + una registry central**, para que cualquier form futuro (y eventualmente el agente) tenga un único lugar al cual apuntar.

## 1. Qué construye este plan

1. **`lib/event-agent-registry.ts`** (nuevo) — single source of truth que mapea cada `event_type` con `(a)` su ruta de creación, `(b)` una descripción breve en es-AR para intent matching, `(c)` la lista de slots que el form acepta vía `searchParams`
2. **Retrofit del form de peso** como **implementación de referencia** del patrón URL-prefill (más simple del repo: 3 campos)
3. **Test de cobertura** que garantiza que cada entrada en `event-agent-registry` corresponde a un `EventType` válido — el día que renombres un event_type, el test rompe
4. **Update menor a AGENTS.md** apuntando al registry como mapping canónico
5. **Comentario header en `WeightForm.tsx`** que documenta el patrón "este es el form-template para URL-prefill" para que el próximo form se copie de acá

## 2. Decisiones cerradas

| # | Decisión | Por qué |
|---|---|---|
| D1 | El registry vive en `lib/event-agent-registry.ts`, no en `lib/events.ts`, no en `db/schema.ts` | `events.ts` es de read paths (proyecciones, summaries); `schema.ts` es de Drizzle. El registry es de **UX/UI mapping + intent**, dominio distinto. Mantener separación de concerns |
| D2 | Solo se registran event_types que tienen ruta `/eventos/nuevo/*` hoy. `credential_scanned`, `pet_profile_updated`, las welfare events, las custody/adoption events deferred, etc. **no entran al registry** | El registry es "event_type → form URL". Sin form, sin entrada. Los system-emitted no tienen UX |
| D3 | El form de **peso** es el reference implementation, no `nota` ni otro | Peso tiene 3 campos (`kg`, `occurredAt`, `notes`), el `occurredAt` defaultea a hoy, y `kg` es numérico — cubre los tres casos típicos de slot que el agente va a extraer (numérico, fecha, texto libre). Es el ejemplo canónico |
| D4 | El retrofit acepta `searchParams` en el page server component y los pasa como prop `defaults` al form client component. **No usar URL params para lecturas extra ni para state — solo prefill inicial** | Server components leen `searchParams`; client components no deberían tocar `useSearchParams()` para el caso prefill — es estado inicial, no reactivo. Mantiene la separación limpia |
| D5 | El form sigue siendo el mismo componente — agregamos prop opcional `defaults?: WeightFormDefaults`. **No hacemos un componente nuevo "AgentWeightForm"** | Una sola implementación, agente y humano comparten exactamente el mismo path de validación y submit. Si difieren, drift es inevitable |
| D6 | El test de cobertura es Vitest y vive con los otros tests del proyecto. **NO bloquea el build si un event_type del registry no tiene route** — solo verifica que existe en `EventType` | El registry puede tener entradas para routes que aún no se construyeron (planning forward). El test garantiza correctness, no completitud |
| D7 | Las "frases ejemplo" de intent (e.g., "le di la vacuna", "pesa X kilos") **NO entran al registry hoy**. Solo route + descripción semántica corta | Esas frases las va a generar el prompt del LLM en su día. Agregarlas hoy es premature; el registry tiene que ser estable, y las frases evolucionan rápido. Mantener mínimo |

## 3. Scope

**Dentro:**
- `lib/event-agent-registry.ts` (nuevo)
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/page.tsx` (retrofit con `searchParams`)
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/WeightForm.tsx` (acepta `defaults` opcional)
- Test nuevo: `lib/event-agent-registry.test.ts` (o donde vivan los tests de `lib/`)
- Update menor de `AGENTS.md` ("Conversational event-capture agent" entry → puntero al registry)

**Fuera:**
- Retrofit de los otros ~12 forms — se hacen cuando se toquen para otra razón (amortización oportunista, ver §6)
- Cualquier código de agente, LLM, transcripción, function-calling
- UUIDv7 default switch (item 5 del hardening)
- Upcaster registry para `payload_version` (item 3 del hardening — la fundación está; el resto cuando una shape cambie)
- Schemas / migraciones / RLS — nada se toca

## 4. Plan paso a paso

Hacé los pasos en orden. Después de cada paso, `pnpm typecheck` + `pnpm lint` para no acumular errores.

### Paso 1 — Crear `lib/event-agent-registry.ts`

Mirá primero `lib/event-schemas.ts` para entender el patrón de `Partial<Record<EventType, ...>>` y reusarlo. Importá `EventType` de `@/db/schema`.

**Estructura del registry:**

```ts
// lib/event-agent-registry.ts

import type { EventType } from "@/db/schema";

/**
 * Maps a pet_events event_type to the UI surface a future conversational
 * agent would deeplink to. Single source of truth for:
 *
 *  - which form route handles an event_type
 *  - the slot names the form accepts as `searchParams` for prefill
 *  - a short Spanish-language description for LLM intent matching
 *
 * See AGENTS.md → Open questions / future work → "Conversational
 * event-capture agent" for the forward-compat rules this registry
 * operationalizes.
 *
 * Adding a new event-creation form? Add its registry entry in the same
 * PR. Lib-level test enforces every entry has a valid EventType key.
 */
export type EventAgentEntry = {
  /** Route relative to /mis-mascotas/{publicToken}. */
  route: string;
  /**
   * One-line Spanish description for LLM intent matching. Describe what
   * the *user said* that maps here (NOT what the system does). Examples:
   *   - "El usuario está registrando una vacunación administrada a su mascota"
   *   - "El usuario está reportando el peso actual de su mascota"
   * Keep under 120 chars. Avoid jargon — the LLM uses this directly.
   */
  description: string;
  /**
   * Query-param names the form accepts via `searchParams` for prefill.
   * MUST match the actual `name=""` attributes in the form. The agent
   * builds the deeplink from these; if they drift, the prefill silently
   * stops working.
   */
  prefillSlots: readonly string[];
};

export const EVENT_AGENT_REGISTRY: Partial<Record<EventType, EventAgentEntry>> = {
  weight_recorded: {
    route: "/eventos/nuevo/peso",
    description: "El usuario está reportando el peso actual de su mascota",
    prefillSlots: ["kg", "occurredAt", "notes"],
  },
  // Add other event types as their forms gain URL-prefill support.
  // See app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/ for the
  // canonical reference implementation.
};

/**
 * Build a fully-qualified deeplink to the creation form for an event_type,
 * given a pet's publicToken and an optional slot payload. Returns null if
 * the event_type has no registry entry yet.
 *
 * Usage (future agent):
 *   const url = buildAgentDeeplink('weight_recorded', 'DIM-3K4F-9P2X', {
 *     kg: '12.5', occurredAt: '2026-05-16'
 *   });
 *   // → '/mis-mascotas/DIM-3K4F-9P2X/eventos/nuevo/peso?kg=12.5&occurredAt=2026-05-16'
 */
export function buildAgentDeeplink(
  eventType: EventType,
  publicToken: string,
  slots: Record<string, string | number | null | undefined> = {},
): string | null {
  const entry = EVENT_AGENT_REGISTRY[eventType];
  if (!entry) return null;
  const base = `/mis-mascotas/${publicToken}${entry.route}`;
  const params = new URLSearchParams();
  for (const slot of entry.prefillSlots) {
    const value = slots[slot];
    if (value !== null && value !== undefined && value !== "") {
      params.set(slot, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
```

**Detalle importante:** `prefillSlots` es **readonly** y el array es la lista *exacta* de query params que el form lee. Si agregás un campo nuevo al form y lo querés agent-prefillable, lo agregás acá también. Si no está en `prefillSlots`, el agente no lo va a enviar.

### Paso 2 — Retrofit del form de peso (page.tsx)

Cambiá `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/page.tsx` para que acepte `searchParams` y los pase como `defaults` a `WeightForm`.

**Estructura nueva:**

```ts
export default async function NewWeightPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicToken } = await params;
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return null;
  const { pet } = session;

  const sp = await searchParams;
  // Only single-value strings — searchParams can be arrays when a key
  // repeats, but for prefill we want the simple case.
  const pick = (k: string): string | undefined =>
    typeof sp[k] === "string" ? (sp[k] as string) : undefined;

  const defaults = {
    kg: pick("kg") ?? null,
    occurredAt: pick("occurredAt") ?? null,
    notes: pick("notes") ?? null,
  };

  const boundAction = createWeightAction.bind(null, pet.publicToken);

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
            Peso
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Registrá el peso actual de {pet.name}. Actualizamos también el peso de su perfil.
          </p>
        </div>
        <WeightForm action={boundAction} defaults={defaults} />
      </div>
    </main>
  );
}
```

**Important:** Next.js 15 `searchParams` es **async** (es una `Promise`). Usá `await searchParams`. Si el lint del proyecto se queja, mirá los otros pages async — el patrón está usado en `params`.

### Paso 3 — `WeightForm` acepta `defaults` opcional

Agregá la prop al component y un header comment que sirva de plantilla para los próximos forms.

**Header del archivo (importante — esto es el "template" para futuros forms):**

```tsx
"use client";

/**
 * Weight-recording form — REFERENCE IMPLEMENTATION for URL-prefill.
 *
 * Future event-creation forms should copy this pattern:
 *
 *  1. Accept an optional `defaults` prop that mirrors the form fields.
 *  2. Use `defaultValue={defaults?.fieldName ?? ...}` on every input.
 *  3. The page's server component reads `searchParams`, builds the
 *     `defaults` object, and passes it down.
 *  4. The form name="..." attributes MUST match the keys in
 *     `lib/event-agent-registry.ts → EVENT_AGENT_REGISTRY[event_type].prefillSlots`
 *     — that registry is the contract the future conversational agent
 *     will deeplink against.
 *
 * Why prop and not useSearchParams: server components own search-param
 * reading. The form is client-side; keeping it stateless re: URLs means
 * exactly one place owns "where do defaults come from" (the page).
 */

import type { EventFormState } from "@/app/actions/events";
// ...
```

**Component signature change:**

```tsx
export type WeightFormDefaults = {
  kg: string | null;
  occurredAt: string | null;
  notes: string | null;
};

export function WeightForm({
  action,
  defaults,
}: {
  action: FormAction;
  defaults?: WeightFormDefaults;
}) {
  const [state, formAction, isPending] = useActionState(action, initialState);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form action={formAction} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="kg" className="...">
          Peso (kg)<span className="text-red-500 ml-0.5">*</span>
        </label>
        <input
          id="kg"
          name="kg"
          type="number"
          step="0.1"
          min="0"
          required
          defaultValue={defaults?.kg ?? undefined}
          placeholder="Ej: 12.5"
          className="..."
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="occurredAt" className="...">
          Fecha<span className="text-red-500 ml-0.5">*</span>
        </label>
        <input
          id="occurredAt"
          name="occurredAt"
          type="date"
          required
          defaultValue={defaults?.occurredAt ?? today}
          className="..."
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="notes" className="...">
          Notas
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={defaults?.notes ?? undefined}
          className="..."
        />
      </div>

      <AttachmentField />

      {/* ... rest unchanged */}
    </form>
  );
}
```

(Conservá los `className` que están en el archivo actual — los recorté arriba con `"..."` por brevedad.)

**Sanity check:** después del cambio, una visita a `/mis-mascotas/{token}/eventos/nuevo/peso?kg=12.5&occurredAt=2026-05-10&notes=control+anual` debe abrir el form con esos tres campos pre-llenados. La fecha por default sigue siendo hoy cuando `occurredAt` no viene en la URL.

### Paso 4 — Test de cobertura del registry

Buscá dónde viven los tests del proyecto. Si hay `lib/*.test.ts` o `lib/__tests__/`, agregá ahí. Si no, creá `lib/event-agent-registry.test.ts` al lado del registry — `vitest` los va a recoger automáticamente.

```ts
// lib/event-agent-registry.test.ts

import { describe, expect, it } from "vitest";

import { EVENT_TYPES, type EventType } from "@/db/schema";
import { EVENT_AGENT_REGISTRY, buildAgentDeeplink } from "./event-agent-registry";

describe("EVENT_AGENT_REGISTRY", () => {
  it("only contains keys that are valid EventTypes", () => {
    const validTypes = new Set<string>(EVENT_TYPES);
    for (const key of Object.keys(EVENT_AGENT_REGISTRY)) {
      expect(validTypes.has(key)).toBe(true);
    }
  });

  it("every entry has a non-empty route, description, and prefillSlots", () => {
    for (const [eventType, entry] of Object.entries(EVENT_AGENT_REGISTRY)) {
      if (!entry) continue;
      expect(entry.route, `route for ${eventType}`).toMatch(/^\/eventos\/nuevo\//);
      expect(entry.description.length, `description for ${eventType}`).toBeGreaterThan(10);
      expect(entry.description.length, `description for ${eventType}`).toBeLessThan(120);
      expect(entry.prefillSlots.length, `prefillSlots for ${eventType}`).toBeGreaterThan(0);
    }
  });
});

describe("buildAgentDeeplink", () => {
  it("returns null for an event_type with no registry entry", () => {
    // pet_profile_updated has no form; should be null.
    expect(buildAgentDeeplink("pet_profile_updated" as EventType, "DIM-XXXX-YY")).toBeNull();
  });

  it("builds a basic URL with no slots", () => {
    expect(buildAgentDeeplink("weight_recorded" as EventType, "DIM-XXXX-YY")).toBe(
      "/mis-mascotas/DIM-XXXX-YY/eventos/nuevo/peso",
    );
  });

  it("encodes provided slots as query params", () => {
    const url = buildAgentDeeplink("weight_recorded" as EventType, "DIM-XXXX-YY", {
      kg: "12.5",
      occurredAt: "2026-05-10",
    });
    expect(url).toContain("kg=12.5");
    expect(url).toContain("occurredAt=2026-05-10");
  });

  it("skips null/undefined/empty slot values", () => {
    const url = buildAgentDeeplink("weight_recorded" as EventType, "DIM-XXXX-YY", {
      kg: "12.5",
      occurredAt: null,
      notes: undefined,
    });
    expect(url).toBe("/mis-mascotas/DIM-XXXX-YY/eventos/nuevo/peso?kg=12.5");
  });

  it("ignores slot keys not declared in prefillSlots", () => {
    const url = buildAgentDeeplink("weight_recorded" as EventType, "DIM-XXXX-YY", {
      kg: "12.5",
      // biome-ignore lint/suspicious/noExplicitAny: testing unknown key
      randomKey: "should not appear" as any,
    });
    expect(url).not.toContain("randomKey");
  });
});
```

### Paso 5 — Update menor a AGENTS.md

Buscá la entrada "Conversational event-capture agent" en la sección "Open questions / future work". Al final de la cláusula `(a)` (donde habla de URL-addressable routes), agregá:

> *El registry canónico vive en `lib/event-agent-registry.ts` con la función `buildAgentDeeplink(eventType, publicToken, slots)`. La implementación de referencia del patrón URL-prefill es el form de peso (`app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/`); copiarla cuando se agreguen nuevos forms.*

No tocar nada más de esa entrada. El resto sigue siendo aspiracional / futuro.

## 5. Verificación

Después de aplicar todos los cambios:

1. **Typecheck.** `pnpm typecheck` o equivalente. Cero errores.
2. **Lint.** `pnpm lint`. Cero errores nuevos.
3. **Tests.** `pnpm test`. Los tests nuevos del registry pasan. Ningún test existente rompe.
4. **Build.** `pnpm build`. Compila.
5. **Smoke manual:**
   - Levantá `pnpm dev`, autenticate, andá a una mascota tuya.
   - Visitá `/mis-mascotas/{tu-token}/eventos/nuevo/peso` — el form abre normal, fecha = hoy, otros campos vacíos.
   - Visitá `/mis-mascotas/{tu-token}/eventos/nuevo/peso?kg=12.5&occurredAt=2026-05-10&notes=test` — el form abre con esos tres campos pre-llenados.
   - Submit el form — el evento se inserta correctamente (esto valida que `defaults` no rompió nada de la lógica de submit, que sigue siendo la misma).
   - En la consola de Node, hacé un quick check de `buildAgentDeeplink`:
     ```ts
     import { buildAgentDeeplink } from '@/lib/event-agent-registry';
     buildAgentDeeplink('weight_recorded', 'DIM-XXXX-YY', { kg: '15.2' });
     // → '/mis-mascotas/DIM-XXXX-YY/eventos/nuevo/peso?kg=15.2'
     ```

Si cualquiera falla, no marques el plan como completo.

## 6. Cómo se "amortizan" los otros forms

**No retrofittees los ~12 forms restantes ahora.** Cuando vayas a tocar uno (por bugfix, mejora, lo que sea), aprovechá ese touch para:

1. Aplicarle el mismo patrón URL-prefill (page lee `searchParams`, pasa `defaults` al form).
2. Agregar su entrada al `EVENT_AGENT_REGISTRY`.

Cada form retrofitteado así toma 10-15 minutos al pasar. En seis meses, sin un sprint dedicado, vas a tener el registry completo como side-effect de mantenimiento normal. Esa es la estrategia óptima de costo amortizado.

## 7. Cuando termines

1. Marcá los chequeos del paso 5.
2. Commit con mensaje:
   ```
   feat(agent): event-agent registry + reference URL-prefill

   Adds lib/event-agent-registry.ts as the canonical mapping from
   event_type to creation route + Spanish-language description + accepted
   prefill slots. Retrofits the weight (peso) form as the reference
   implementation of the URL-prefill pattern — searchParams in the page
   server component, defaults prop on the form client component, no
   useSearchParams. Adds buildAgentDeeplink() so the future conversational
   agent has a single API to construct prefilled deeplinks against any
   registered event type.

   No agent code yet. This plan operationalizes the "Conversational
   event-capture agent" forward-compat rules from AGENTS.md → Open
   questions / future work, so the rules are executable (a working
   reference + a test) rather than aspirational.

   Other event-creation forms gain URL-prefill opportunistically when
   they're touched for other reasons.
   ```
3. Reportá a Nacho: qué quedó implementado, qué tests corren, y el URL de prueba (`/mis-mascotas/{token}/eventos/nuevo/peso?kg=12.5`).
