# Welfare reports — polish & bugfixes — implementation plan

> **Estado (2026-06-04):** ✅ COMPLETO — enviado (commit 5c643e0).

> Plan ejecutable para Claude Code. Cuatro fases pequeñas que cierran gaps operativos del sistema de denuncias ya implementado (`welfare_reports` table + `WelfareReportForm` + bridge a pet_events). Las dos primeras fases arreglan bugs reales del mapa identificados en review 2026-05-18. La tercera agrega rate-limit anti-spam para reporters anónimos (TODO explícito en `app/actions/welfare.ts`). La cuarta cierra la documentación.
>
> **Fecha:** 2026-05-18
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~1-2 PRs, ~5 archivos tocados, 0 migraciones SQL
> **Estimación total:** ~1 día de CC

---

## 0. Antes de tocar nada

Lectura obligatoria. Este plan asume conocimiento de la arquitectura actual; el código es la fuente de verdad — el spec `dim-interno:docs/archive/2026-05-18-maltreatment-reporting-design.md` quedó **superseded** (movido a `dim-interno:docs/archive/` en sprint 1 PR-007) y NO se debe seguir (proponía una arquitectura distinta de ghost_subject pets que el código no implementa).

1. **`db/schema.ts:885-983`** — definición de `welfareReports` + `welfareReportAttachments`. Polimorfismo via `subjectKind` enum (`registered_pet | unowned_animal | location | general`). Coords en `location_lat/lng` numeric(10,7) — mismo shape que `pet_events.location_*`.
2. **`app/actions/welfare.ts`** — `createWelfareReportAction`. El bridge a pet_events vive en líneas 222-312 (transacción atómica después del welfare_reports INSERT).
3. **`app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/page.tsx`** — event detail page que lee `readPoint(event)` y renderiza `<EventMap />` cuando hay coords. Patrón canónico de uso del mapa.
4. **`app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/EventMap.tsx`** — componente map agnóstico, recibe `{ lat, lng }`. Reusable.
5. **`app/(app)/denuncias/[id]/page.tsx`** — detail page autenticada de denuncia. Hoy NO renderiza mapa (solo texto con coords).
6. **`app/denuncias/codigo/[code]/page.tsx`** — detail page anónima vía reference code. Mismo gap del mapa.
7. **`lib/location.ts`** — `readPoint` y `writePoint` helpers. Reusar para serialización/deserialización consistente.
8. **`lib/welfare.ts`** — labels y enums.

## 1. Qué construye este plan

Cuatro fases secuenciales pero independientes:

**Fase 1 — Bug del bridge pet_event.** Cuando una denuncia con `subjectKind='registered_pet'` se carga, el server crea ambos: `welfare_reports` con lat/lng + `pet_events.maltreatment_reported`/`abandonment_reported` sin lat/lng. Resultado: el owner abre el evento, ve "Sin ubicación registrada" aunque la denuncia tenga coords reales. Fix: copiar `locationLat/locationLng` al `tx.insert(petEvents).values({...})` en los 2 bridges (abandonment + maltreatment) + opcionalmente al `symptom_observed` event.

**Fase 2 — Bug del mapa en detail pages.** `app/(app)/denuncias/[id]/page.tsx` y `app/denuncias/codigo/[code]/page.tsx` muestran las coords como texto monospaced pero **no renderizan el mapa**. Reusar el componente `EventMap` (renombrar a `LocationMap` para semántica honesta, ya que ahora lo usan dos surfaces).

**Fase 3 — Rate-limit para reporters anónimos.** Hoy hay TODO explícito en `welfare.ts:9-11`. Implementar el rate-limit más simple que funciona: max 3 submissions por IP por hora + max 1 submission por IP por minuto. Usar Vercel KV o tabla in-DB (decisión abajo).

**Fase 4 — Cleanup docs.** Marcar el spec `maltreatment-reporting-design.md` como **SUPERSEDED**. Actualizar `AGENTS.md → Open questions` para reflejar que non-owner reporting flow **ya está parcialmente implementado** (welfare_reports vivo; queue + bugs pendientes). Esto ya se hace en el commit que cierra este plan.

## 2. Scope

**Dentro:**
- Edición de `app/actions/welfare.ts` (Fase 1).
- Rename + reuse del componente `EventMap` (Fase 2). Decidir: rename a `LocationMap` y mover a `components/`, O dejar `EventMap` donde está y crear alias re-export. Voto: rename + move, semantic gain > rename cost.
- Update de 2 páginas de detail de denuncia (Fase 2).
- Nuevo helper de rate-limit + integración en `createWelfareReportAction` (Fase 3).
- 2-3 archivos de doc tocados (Fase 4).
- Tests.

**Fuera:**
- Welfare-officer queue (`/gob/maltrato`). Es feature separado y bigger. Plan aparte.
- Moderation queue (denuncias anónimas auto-flagged). Mismo. Plan aparte.
- Export template a fiscalía MPF CABA. Mismo. Plan aparte.
- Notifications a admins / govt cuando entra una denuncia. Hoy `signalWelfareReport` es noop intencional — queda igual hasta que welfare-officer queue lande.
- Cambios al `WelfareReportForm` (form ya funciona OK).
- Cambios al schema (`welfare_reports` table ya sirve para todos los casos del spec; ghost_subject NO se introduce — la arquitectura actual es la correcta).

## 3. Plan paso a paso

### Fase 1 — Bug del bridge pet_event location

#### Paso 1.1 — Extender el bridge en `app/actions/welfare.ts`

En el bloque del transaction (líneas 222-312), los 3 `tx.insert(petEvents).values({...})` (abandonment, maltreatment, symptom_observed) NO pasan `locationLat / locationLng`. Pero las variables `locationLat` y `locationLng` ya están en scope (líneas 99-114, vienen de `writePoint(locationPoint)`).

Cambio: agregar las 2 columnas a cada `values({...})` block:

```ts
// abandonment_reported bridge (línea ~260):
await tx.insert(petEvents).values({
  petId: subjectPetId,
  eventType: "abandonment_reported",
  occurredAt: eventOccurredAt,
  recordedAt: now,
  recordedByUserId: user?.id ?? null,
  authorRole,
  payload: abandonmentEventPayload,
  // NEW: mirror coords from the welfare report so EventMap renders correctly
  locationLat,
  locationLng,
});

// maltreatment_reported bridge (línea ~276):
await tx.insert(petEvents).values({
  petId: subjectPetId,
  eventType: "maltreatment_reported",
  occurredAt: eventOccurredAt,
  recordedAt: now,
  recordedByUserId: user?.id ?? null,
  authorRole,
  payload: maltreatmentEventPayload,
  // NEW
  locationLat,
  locationLng,
});

// symptom_observed bridge (línea ~301):
// IMPORTANTE: agregar coords también acá. El symptom_observed bridge desde
// welfare reports NO corre el matcher (welfare.ts:287-290 lo explicita), pero
// las coords del incidente son geográficamente relevantes — el `source` es
// 'welfare_report' y el resultado debe ser consistente.
await tx.insert(petEvents).values({
  petId: subjectPetId,
  eventType: "symptom_observed",
  occurredAt: eventOccurredAt,
  recordedAt: now,
  recordedByUserId: user?.id ?? null,
  authorRole,
  payload: symptomEventPayload,
  // NEW
  locationLat,
  locationLng,
});
```

**Important**: las coords se replican (denormalización deliberada). La fuente de verdad operativa de "dónde pasó esta denuncia" sigue siendo `welfare_reports.location_*`. El pet_event row carga las coords para que las proyecciones del libreta sanitaria, el timeline del pet, y el mapa del event detail funcionen sin tener que joinear `welfare_reports`.

#### Paso 1.2 — Test del bridge

`app/actions/welfare.test.ts` (crear si no existe; mirror de otros action tests):

```ts
// Test setup: create a pet owned by userA, then file a welfare report as
// userB about that pet with subjectKind='registered_pet', kind='neglect',
// coords (-34.6, -58.4).

it("bridges location_lat/lng to the maltreatment_reported pet_event", async () => {
  await createWelfareReportAction(/* ... with coords */);

  const [event] = await db
    .select()
    .from(petEvents)
    .where(eq(petEvents.eventType, "maltreatment_reported"))
    .orderBy(desc(petEvents.recordedAt))
    .limit(1);

  expect(event.locationLat).not.toBeNull();
  expect(event.locationLng).not.toBeNull();
  expect(Number(event.locationLat)).toBeCloseTo(-34.6, 5);
  expect(Number(event.locationLng)).toBeCloseTo(-58.4, 5);
});

it("bridges location to abandonment_reported", /* idem */);
it("bridges location to symptom_observed when observedSymptoms is set", /* idem */);
```

#### Paso 1.3 — Smoke verification

Probar end-to-end: cargar una denuncia con coords desde `/denuncias/nueva` contra un pet registrado. Abrir el evento generado en `/mis-mascotas/{token}/eventos/{eventId}` y verificar que **el mapa se renderiza** (no el texto "Sin ubicación registrada").

---

### Fase 2 — Bug del mapa en detail pages de denuncia

#### Paso 2.1 — Rename `EventMap` → `LocationMap` + mover a components/

Esto reconoce que el componente es agnóstico al pet_event y ahora lo van a consumir 2 surfaces más (denuncia auth + denuncia anon). Mantener el componente bajo el path del pet-event detail confunde semánticamente.

**Mover**: `app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/EventMap.tsx` → `components/LocationMap.tsx`.

**Renombrar export**: `EventMap` → `LocationMap`.

**Update consumer**: en `app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/page.tsx`:

```ts
// Antes:
const EventMap = dynamic(() => import("./EventMap"), { ... });

// Después:
const LocationMap = dynamic(() => import("@/components/LocationMap"), { ... });
```

Y el uso: `<EventMap ... />` → `<LocationMap ... />`.

Sin cambios funcionales, solo nombre + path.

#### Paso 2.2 — Renderizar el mapa en `denuncias/[id]/page.tsx`

En `app/(app)/denuncias/[id]/page.tsx`, la sección "Lugar" (líneas 188-209). Hoy:

```tsx
{locationPoint && (
  <p className="text-xs text-neutral-500 dark:text-neutral-500 font-mono">
    Coordenadas registradas: {locationPoint.lat.toFixed(6)}, {locationPoint.lng.toFixed(6)}
  </p>
)}
```

Cambio: renderizar `<LocationMap />` en lugar (o además) del texto:

```tsx
{locationPoint && (
  <>
    <LocationMap lat={locationPoint.lat} lng={locationPoint.lng} />
    <p className="text-xs text-neutral-500 dark:text-neutral-500 font-mono">
      {locationPoint.lat.toFixed(6)}, {locationPoint.lng.toFixed(6)}
    </p>
  </>
)}
```

Y agregar el import dynamic al top:

```ts
import dynamic from "next/dynamic";

const LocationMap = dynamic(() => import("@/components/LocationMap"), {
  loading: () => (
    <div className="w-full h-64 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 animate-pulse" />
  ),
});
```

#### Paso 2.3 — Mismo cambio en `denuncias/codigo/[code]/page.tsx`

La vista anónima debe ofrecer la misma experiencia. Aplicar idéntico patch a `app/denuncias/codigo/[code]/page.tsx`.

Verificar que el anonymous user puede ver el mapa también (no requiere auth — el componente es client-side puro).

#### Paso 2.4 — Tests

Snapshot del JSX output o E2E mínimo:
- Authenticated denuncia con coords → el componente `LocationMap` está en el árbol.
- Anonymous denuncia (via codigo) con coords → idem.
- Denuncia sin coords → el componente NO se renderiza (la condicional `locationPoint &&` lo cubre).

---

### Fase 3 — Rate-limit para reporters anónimos

#### Paso 3.1 — Decisión: Vercel KV vs tabla in-DB

**Opción A — Vercel KV (Redis)**. Pros: latencia mínima, TTL nativo, ya está en stack del repo (verificar). Contras: extra service.

**Opción B — Tabla in-DB `rate_limit_buckets`**. Pros: stack actual sin agregar service. Contras: race conditions con UPSERT (manejable con `ON CONFLICT`).

**Voto B** (tabla in-DB). Coherente con el principio del repo de minimizar servicios externos. El traffic anonymous esperado es bajo (decenas/día); la concurrencia no es un riesgo real.

#### Paso 3.2 — Migración `rate_limit_buckets`

Crear `db/migrations/NNNN_rate_limit_buckets.sql`:

```sql
-- Rate limit buckets — generic per-key counter with TTL semantics.
-- Used by welfare anonymous submissions; reusable for other endpoints.

create table if not exists public.rate_limit_buckets (
  bucket_key      text primary key,         -- e.g. "welfare_anon:1.2.3.4:hour:2026-05-18-15"
  count           integer not null default 1,
  first_seen_at   timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index if not exists rate_limit_buckets_expires_idx
  on public.rate_limit_buckets (expires_at);

comment on table public.rate_limit_buckets is
  'Generic counter with TTL for anti-spam. bucket_key encodes endpoint + identifier + window.';
```

Aplicar via Supabase Studio.

#### Paso 3.3 — Drizzle model

```ts
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  count: integer("count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
```

#### Paso 3.4 — Helper `lib/rate-limit.ts`

```ts
// Generic rate-limit helper.
// Usage:
//   await enforceRateLimit("welfare_anon", req.ip, { maxPerHour: 3, maxPerMinute: 1 });
// Throws { code: 'rate_limited', resetAt: Date } when exceeded.

import { db, rateLimitBuckets } from "@/db";
import { and, eq, lt, sql } from "drizzle-orm";

export type RateLimitConfig = {
  maxPerMinute?: number;
  maxPerHour?: number;
};

export class RateLimitError extends Error {
  constructor(public resetAt: Date, public reason: string) {
    super(`Rate limit exceeded: ${reason}`);
    this.name = "RateLimitError";
  }
}

export async function enforceRateLimit(
  endpoint: string,
  identifier: string,  // IP, user_id, etc.
  config: RateLimitConfig,
): Promise<void> {
  const now = new Date();

  if (config.maxPerMinute !== undefined) {
    const windowStart = Math.floor(now.getTime() / 60_000) * 60_000;
    const key = `${endpoint}:${identifier}:minute:${windowStart}`;
    await consumeOrThrow(key, new Date(windowStart + 60_000), config.maxPerMinute);
  }

  if (config.maxPerHour !== undefined) {
    const windowStart = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    const key = `${endpoint}:${identifier}:hour:${windowStart}`;
    await consumeOrThrow(key, new Date(windowStart + 3_600_000), config.maxPerHour);
  }
}

async function consumeOrThrow(
  bucketKey: string,
  expiresAt: Date,
  limit: number,
): Promise<void> {
  // UPSERT con INCR atómico
  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ bucketKey, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: rateLimitBuckets.bucketKey,
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });

  if (row.count > limit) {
    throw new RateLimitError(expiresAt, `${bucketKey} (count=${row.count}, limit=${limit})`);
  }
}

// Cleanup helper (call from a cron, optional v1):
export async function cleanupExpiredBuckets(): Promise<number> {
  const result = await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.expiresAt, new Date()))
    .returning({ key: rateLimitBuckets.bucketKey });
  return result.length;
}
```

#### Paso 3.5 — Integrar en `createWelfareReportAction`

Top del action, **antes** de la validación de campos:

```ts
// Rate-limit anonymous submissions (TODO from welfare.ts:9-11 — now implemented).
// Authenticated users are NOT rate-limited at this layer; trust the auth gate.
if (!user) {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  try {
    await enforceRateLimit("welfare_anon", ip, {
      maxPerMinute: 1,
      maxPerHour: 3,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        error: "Estás enviando demasiadas denuncias seguidas. Esperá unos minutos y volvé a intentar. Si tenés muchos casos legítimos para reportar, considerá crear una cuenta para no estar limitada.",
      };
    }
    throw err;
  }
}
```

Comentar el TODO original (líneas 9-11).

#### Paso 3.6 — Tests

`lib/rate-limit.test.ts`:
- Happy: 3 calls under limit → no throw.
- Edge: 4th call within hour window → `RateLimitError` con `resetAt` correcto.
- Minute window: 2 calls in same minute → 2do throw.
- Distinct identifiers no compiten: IP A puede hacer 3, IP B puede hacer 3 paralelo.
- Endpoint distinto no compite: welfare_anon vs login_anon son buckets separados.

`app/actions/welfare.test.ts` (extender):
- 4th anonymous submission misma IP en 1h → returns error con mensaje user-friendly.
- 4th submission de user autenticado en misma IP → OK (no rate-limited).

---

### Fase 4 — Cleanup docs

#### Paso 4.1 — Banner SUPERSEDED en maltreatment-reporting spec

Editar `dim-interno:docs/archive/2026-05-18-maltreatment-reporting-design.md` (movido a `dim-interno:docs/archive/` en sprint 1 PR-007). Reemplazar el header con:

```markdown
# Denuncia de maltrato animal — design spec ⚠️ SUPERSEDED

> ⚠️ **Este spec quedó superseded por la implementación existente** en `welfare_reports` table (ver `db/schema.ts:885-983`, `app/actions/welfare.ts`, `app/denuncias/nueva/WelfareReportForm.tsx`). La arquitectura del código real **no usa** ghost_subject pets — usa una tabla separada `welfare_reports` con `subjectKind` enum polimórfico (`registered_pet | unowned_animal | location | general`). Esta es la decisión arquitectónica correcta y se mantiene.
>
> **Este archivo se conserva solo como referencia histórica** del análisis comparativo con el form de denuncias del MPF CABA (https://denuncias.fiscalias.gob.ar/) y los gaps que se identificaron al inicio.
>
> Para la spec viva del feature, ver:
> - **Implementación actual**: código en `app/actions/welfare.ts` + schema en `db/schema.ts`
> - **Polish + bugs pendientes**: `docs/superpowers/plans/2026-05-18-welfare-reports-polish.md`
> - **Welfare-officer queue** (`/gob/maltrato`): pendiente de spec separado
>
> No seguir las decisiones de este doc para implementación nueva.

---

# Original content (para referencia)

[resto del spec original sin cambios]
```

#### Paso 4.2 — Update AGENTS.md → Open questions

En la sección `## Open questions / future work` de `AGENTS.md`, el item:

> Non-owner reporting flow for `abandonment_reported`, `maltreatment_reported`, `symptom_observed` on unregistered pets — requires schema additions for "report subject = unowned animal" plus moderation. `maltreatment_reported` ultimately wants integration with Ley Nacional 14.346 denuncia pipelines.

Reemplazar por:

> **Non-owner reporting flow — parcialmente implementado.** `welfare_reports` table con `subjectKind` enum (`registered_pet | unowned_animal | location | general`) cubre el caso del subject no registrado sin necesidad de ghost_subject pets. Form público + anonymous + 5 attachments + bridge a pet_events ya está vivo. **Pendientes:** (a) welfare-officer queue en `/gob/maltrato` para triagear casos (no spec'd todavía), (b) moderation queue para denuncias anónimas auto-flagged, (c) export template a fiscalía MPF CABA (Ley 14.346 pipeline), (d) auto-submission via API cuando exista convenio institucional. Bugs de polish en plan `2026-05-18-welfare-reports-polish.md`.

#### Paso 4.3 — Update `docs/superpowers/README.md`

Agregar este plan al índice de plans:

```md
| `2026-05-18-welfare-reports-polish.md` | 🟢 Ready for CC | — | Polish de denuncias de maltrato (welfare_reports already implemented). 4 fases: (1) bridge pet_event location bug, (2) mapa en detail page denuncia, (3) rate-limit anon, (4) cleanup docs. ~1 día. |
```

Y agregar a la tabla de specs:

```md
| `2026-05-18-maltreatment-reporting-design.md` | ⚪ Superseded | — | Quedó superseded por la implementación real en `welfare_reports` table. Mantenido como referencia histórica del análisis comparativo con fiscalía CABA. NO seguir para implementación nueva. |
```

#### Paso 4.4 — Verificar no broken-links

Grep en docs por referencias a `maltreatment_reported` o `ghost_subject` que asuman el camino superseded:

```bash
rg "ghost_subject" docs/
rg "ghost subject" docs/
```

Si emergen referencias en otros specs/plans que ya escribimos hoy (lost-and-found, foster, etc.), revisar si siguen siendo coherentes. **Probabilidad baja** — esos specs no referencian la arquitectura ghost_subject porque fueron escritos antes que la maltreatment spec.

---

## 4. Tests de integración cross-fase

Después de cada fase, correr la suite completa:

```bash
pnpm test
pnpm rls:smoke
pnpm typecheck
pnpm lint
```

Específicamente importante después de Fase 1+2:

**E2E happy path** del flow welfare report con mapa visible:
1. Crear pet registrado.
2. Como user distinto, abrir `/denuncias/nueva`, llenar form con `subjectKind='registered_pet'`, kind='neglect', coords (-34.6, -58.4), submit.
3. Verificar redirect a `/denuncias/codigo/[code]`. **El mapa se renderiza** en esa página.
4. El owner del pet abre `/mis-mascotas/{token}/eventos/{eventId}` del `maltreatment_reported` event. **El mapa se renderiza** con las mismas coords.
5. Refresh — coordenadas persistent, no cambian.

## 5. Done criteria

PR final tiene:
- [x] `welfare.ts` setea `locationLat/locationLng` en los 3 pet_event INSERTs del bridge.
- [x] `EventMap` renombrado a `LocationMap` y movido a `components/`. Consumer en `mis-mascotas/eventos/[eventId]/page.tsx` actualizado.
- [x] 2 detail pages de denuncia renderizan el mapa.
- [x] Migration `rate_limit_buckets` aplicada via Studio.
- [x] `lib/rate-limit.ts` con tests.
- [x] `createWelfareReportAction` consume el rate-limit para anonymous; TODO original removido.
- [x] Spec `maltreatment-reporting-design.md` con banner SUPERSEDED.
- [x] `AGENTS.md → Open questions` actualizado.
- [x] `docs/superpowers/README.md` actualizado.
- [x] `pnpm test && pnpm rls:smoke && pnpm typecheck && pnpm lint` todo verde.

## 6. Lo que NO está en este plan

- **Welfare-officer queue `/gob/maltrato`**. El gap operativo verdadero — sin esto las denuncias se acumulan sin que nadie las vea. Plan separado, depende de admin page Fase 0+.
- **Moderation queue separada** para denuncias anónimas auto-flagged. Igual, plan aparte.
- **Export template a fiscalía MPF CABA**. Plan aparte cuando esté el welfare-officer queue.
- **Notifications a admins/govt** cuando entra una denuncia. Hoy `signalWelfareReport` es noop intencional. Se activa cuando welfare-officer queue lande.
- **Cleanup del `EventMap` original**: si encontrás otros consumers del componente bajo `app/(app)/mis-mascotas/...`, actualizá los imports al nuevo path. Probable que no haya — el componente está casi seguro consumido en un solo lugar.

---

## Próximo paso

Ejecutar el plan en 1-2 PRs (Fase 1+2 juntas; Fase 3+4 juntas). Total ~1 día. Cuando termine, el welfare reports system queda en estado "completo para v1": bugs cerrados, anti-spam vivo, docs alineadas con el código.

Follow-up natural: levantar el spec del welfare-officer queue (`/gob/maltrato`) — ese es el gap operativo más alto que queda.
