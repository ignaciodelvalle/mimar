# Event-trust hardening — Tier 1 (confidence tier + idempotency keys + outbox)

> **Estado (2026-06-04):** ✅ COMPLETO — enviado PRs #129 (Fase A confidence), #133 (Fase B idempotency), #135/#140 (Fase C outbox).

> Plan ejecutable para Claude Code. Tres mejoras chicas, independientes entre sí, que cierran los gaps más importantes del event sourcing **dado lo que ya existe**: provenance scattered → unificada, escrituras sin idempotency client-side → key-protected, ENO notifyHours sin delivery infrastructure → outbox con SLA tracking.
>
> El nombre "Tier 1" viene del brainstorm en chat (22 may 2026). Tier 2-4 quedan en `specs/2026-05-22-event-trust-tiers-2-4-design.md` como low priority.
>
> **Fecha:** 2026-05-22
> **Owner:** Ignacio Del Valle
> **Estado:** ready for CC
> **Tamaño:** 3 fases independientes (A, B, C). Cada fase es 1 PR.
> **Estimación:** Fase A ≈ 1 día. Fase B ≈ 2-3 días. Fase C ≈ 3-5 días. Total ≈ 1 semana corta.

---

## 0. Antes de tocar nada

Lectura obligatoria — esto es lo que ya existe y este plan se apoya en, no reemplaza:

1. **`AGENTS.md`** end-to-end. Específicamente la sección "Event sourcing — invariants and scaling roadmap" y el catálogo de events. Los principios append-only + corrections-as-new-events siguen siendo non-negotiable.
2. **`docs/event-design-checklist.md`** — patrón de validación de nuevos event types. Lo usamos en Fase C cuando introduzcamos los outbox-related events (si los hay).
3. **`docs/superpowers/event-versioning.md`** — convención de `payload_version` + upcasters. Fase A NO bumpea ningún schema; Fase B agrega columnas físicas, no toca payloads; Fase C tampoco toca payloads existentes.
4. **`lib/event-schemas.ts`** + **`db/schema.ts:817`** (`petEvents`) — fields actuales: `recordedByUserId`, `authorRole`, `authorOrganizationId`, `authorVerified`. Más `reporter_role` específico en algunos payloads (welfare, bite, symptom_observed) y `confirmed_by_lab` + `triggered_by` en `clinical_info_logged(disease_diagnosis)`. **Estos inputs ya existen — el problema es que cada consumer hace su propio juicio de confianza sobre ellos.**
5. **`docs/superpowers/specs/2026-05-21-eno-pipeline-design.md`** — la fuente del catálogo ENO con `notifyHours` por disease. Fase C es la infraestructura que vuelve cumplible ese SLA.
6. **`app/actions/slot-materialization.ts`** — patrón existente de idempotency vía `onConflictDoNothing` sobre unique index. Lo extendemos a writes de event en Fase B.
7. **`db/schema.ts:865`** (`reminders`) + **`db/schema.ts:865+`** — patrón de cron-driven tables (`cron_runs` tabla y `lib/cron-runs.ts`). Lo reusamos en Fase C para el drainer del outbox.

---

## 1. Qué construye este plan

**Fase A — `lib/event-confidence.ts`**: función pura `computeConfidence(event) → ConfidenceTier` que consolida `authorRole + authorVerified + authorOrganizationId + reporter_role + confirmed_by_lab + triggered_by` en un único enum ordenado. Cero schema changes. Wire en libreta formatter, gob outbreak detail, próximos exports.

**Fase B — Idempotency keys client-side**: nueva columna `client_idempotency_key` en `pet_events` (nullable), unique partial index, generación de UUID v4 en cada form `onSubmit`, propagación por la cadena de server actions. Retrofit en los ~14 forms del registry.

**Fase C — Event notification outbox**: nueva tabla `event_notification_outbox`, drainer cron, `/admin/outbox` panel para observabilidad + retry manual. Backing del SLA `notifyHours` del catálogo ENO. Sin reemplazar el flow actual de notifications in-app — esto es para deliveries externos (govt webhooks, future SENASA integration, future audit export).

---

## 2. Decisiones cerradas

### Cross-fase

| # | Decisión | Razón |
|---|---|---|
| X1 | **Tres fases = tres PRs**. Cada uno mergeable en aislamiento, ningún cross-dependency entre fases | Maximiza paralelismo + permite priorizar Fase A primero (es la más barata y desbloquea trust badges en UI) |
| X2 | **Sin migrations destructivas**. Todo es additive (nuevas columnas nullable, nuevas tablas, nuevos índices). Ningún rewrite de payloads históricos | Append-only contract sigue intacto |
| X3 | **Cobertura es-AR de copy user-facing** se hace al momento del wire-up (Fase A en libreta + outbreak detail; Fase B nada visible al usuario; Fase C visible solo en `/admin/outbox`) | Patrón usual del repo |

### Fase A — Confidence tier

| # | Decisión | Razón |
|---|---|---|
| A1 | **Función pura derivada**, NO columna nueva. `computeConfidence(event)` lee `authorRole`, `authorVerified`, `authorOrganizationId`, y (si existe) `payload.reporter_role`, `payload.confirmed_by_lab`, `payload.triggered_by` | Pure projection layer. Funciona retroactivamente sobre todos los rows históricos sin migration. Si la rúbrica cambia mañana, se recompute on-read |
| A2 | **5 tiers, ordenados**: `'institutional_verified' > 'professional_verified' > 'corroborated' > 'self_reported' > 'unverified'` | Mapea cleanly a (org verified + signing) / (vet con matrícula verified) / (owner con evidencia o microchip-confirmed) / (owner solo) / (anonymous scan). 5 es lo suficiente para que cualquier dashboard pueda hacer threshold cuts y no demasiado para sobrediscriminar |
| A3 | **Mapping reglas explícitas** en code, no en data: `'shelter' + authorVerified + authorOrganizationId` → `institutional_verified`; `'vet' + authorVerified` → `professional_verified`; `'owner' + (microchip_implanted∧matched or attached_evidence_hash)` → `corroborated`; `'owner' alone` → `self_reported`; `'scanner'` (anonymous QR) → `unverified` | Lee fácil, testeable como tabla de truth |
| A4 | **El tier max-truthworthy de un payload con `confirmed_by_lab=true` se bumpea siempre a `institutional_verified`** incluso si lo emitió un vet (porque el lab actúa como tercero) | Mantiene la jerarquía coherente con el spec de surveillance: `triggered_by='direct_diagnosis' + confirmed_by_lab=true` → severity critical → confidence institutional_verified |
| A5 | **Sin storage en DB**. NO se persiste el tier en `pet_events` ni en projection tables. Se computa on-read. **Excepción documentada**: si más adelante hace falta cachear (por query patterns lentos en /gob), se agrega después como denorm column — fuera de scope hoy | YAGNI. La función es O(1) y trivial; el caching premature es overhead injustificado |
| A6 | **Wire en 4 sitios en este PR**: (a) `lib/libreta-sanitaria.ts` formatter — badge "Verificado" / "Autorreportado" en cada entry; (b) `app/(app)/p/[publicToken]/page.tsx` — credencial pública muestra estado de verificación cuando aplica; (c) `app/(app)/gob/vigilancia/...` — outbreak signals tienen filtro y badge por tier; (d) `lib/owner-dashboard.ts` workflows widget — display sutil. **NO** tocar `/admin` ni `/pro` placeholder en este PR | 4 surfaces es suficiente para validar el shape de la API. Más wire-up = más review surface, mejor diferir |
| A7 | **No copy user-facing dice "high confidence" / "low confidence"** — usamos labels concretos: "Verificado por veterinario matriculado", "Reportado por refugio verificado", "Reportado por el dueño". El owner del pet no debería sentirse degradado | UX. La info técnica del tier es para audit + dashboards; el label visible al public es descriptivo, no judgmental |

### Fase B — Idempotency keys

| # | Decisión | Razón |
|---|---|---|
| B1 | **Columna nullable + unique partial index** sobre `(pet_id, event_type, client_idempotency_key) WHERE client_idempotency_key IS NOT NULL` | Backward compat. Rows existentes siguen sin clave (= sin protection); rows nuevos a partir del retrofit la traen siempre. El partial index evita conflicts entre rows legacy null |
| B2 | **UUID v4 generado client-side en `onSubmit`** del form, NO server-side. Persistido en `<input type="hidden">` para sobrevivir refetches. Se regenera **solo si el form se resetea** (no en cada keystroke ni en cada submit) | El punto del key es que double-submit-retries usan el MISMO key. Generarlo en server-side defeats the purpose — el cliente no podría detectar duplicates antes de mandar |
| B3 | **Server action chequea con `ON CONFLICT DO NOTHING`** + RETURNING. Si el insert no devolvió row (= ya existía un row con el mismo key), retornar success con el event original (idempotent semantics) en lugar de error | El user re-submit no debe ver error — debe ver el resultado del primer submit como si nada |
| B4 | **Retrofit en los 14 forms del `lib/event-capture-registry.ts`**. Forms fuera del registry (admin tools, scripts internos) NO se tocan en este PR — bajo riesgo, esos no son user-initiated | Scope contenido al user-facing surface. Los admin tools tienen su propio idempotency story (manual o no needed) |
| B5 | **Helper compartido `lib/use-idempotency-key.ts` (client hook)** + helper server `lib/event-idempotency.ts` con `checkIdempotency(petId, eventType, key)` → `{ existing: PetEvent | null }`. Cada server action consume el helper antes del insert | DRY. Si cada action implementa su propio check, drift |
| B6 | **El key NO entra al payload** del event. Es columna física separada | Limpieza: el payload representa el FACTO sanitario; el key es metadata de transporte. No deben mezclarse |
| B7 | **Sin TTL ni cleanup** del key en la columna | Los rows son immutable for life. El key ocupa 16 bytes/row. A 1M events ≈ 16MB. Insignificante |
| B8 | **Tests: happy + retry + conflict-distinct-payload**. El último caso (mismo key, payload diferente) debe **errar explícitamente**, no overwrite | Defense in depth. Si un bug client manda el mismo key con dos payloads distintos, queremos saber, no silenciar |

### Fase C — Outbox

| # | Decisión | Razón |
|---|---|---|
| C1 | **Tabla nueva `event_notification_outbox`** (NO mezclar con `notifications` que ya existe — esa es in-app/email para users). Fields: `id`, `source_event_id` FK, `target_kind` enum (`govt_webhook` / `eno_authority` / `audit_export` / `internal_dashboard`), `target_jurisdiction_province` + `_locality` (nullable, para routing), `sla_due_at` timestamp, `attempts` int, `last_attempt_at`, `last_error` text, `delivered_at` (nullable), `created_at` | Separar concerns. `notifications` es UX layer; `outbox` es integration layer. Mezclar lleva a queries lentas + reglas confusas |
| C2 | **El insert al outbox se hace en la misma transaction que el insert del event source** (cuando el event lo gatilla, e.g., `clinical_info_logged(disease_diagnosis)` con disease ∈ ENO_DISEASES_AR). El que decide qué events generan outbox rows es **`lib/event-outbox-rules.ts`**, un mapping `event_type → OutboxRule[]` análogo al patrón de `lib/case-attachment.ts` | Atomicidad. Si el event se persiste pero el outbox row no, perdemos el SLA. Cohabitar en la txn lo previene |
| C3 | **Drainer cron cada 5 minutos**: `app/api/cron/drain-outbox/route.ts`. Toma N pending rows con `delivered_at IS NULL AND attempts < MAX_ATTEMPTS AND next_retry_at <= now()`, las intenta entregar, marca delivered o incrementa attempts con backoff exponencial. Reusa el patrón de `app/api/cron/auto-expire-approvals/route.ts` + `cron_runs` table | Patrón ya probado en el repo. No reinventar |
| C4 | **`MAX_ATTEMPTS = 8` + backoff exponencial** (5min, 15min, 45min, 2h, 6h, 12h, 24h, 24h). Después de attempts ≥ 8, row queda en estado terminal `failed`, surface en `/admin/outbox` para retry manual o investigación | Cubre 48h de retries antes de dar up. Coherente con `notifyHours = 24` (rabies) y `notifyHours = 48` (leptospirosis). Si una falla persiste más de 48h, escalation humana |
| C5 | **`/admin/outbox` surface** mínima: tabla con filtros (estado, target_kind, jurisdicción, SLA breach yes/no), detail por row (raw payload + headers + last_error), botón "Retry now". NO necesita ser bonita — es ops surface | Observabilidad para que cuando alguien pregunte "¿llegó el aviso de la rabia al govt?" haya una respuesta clara |
| C6 | **`target_kind='govt_webhook'` en v1 NO tiene webhook real**. Es no-op delivery (marca como `delivered_at = now()` sin llamar a ningún endpoint) **excepto** que escribe a `audit_log` con el payload. La integración real con SENASA / Mi Argentina llega cuando exista el cliente externo — este plan solo construye la tubería | Realidad institucional: hoy no hay webhooks oficiales receptores. El outbox prepara MiMAR para enchufar uno cuando llegue, sin que ese día sea un proyecto en sí mismo. El audit_log mientras tanto es la evidencia de "lo hubiéramos enviado" |
| C7 | **`target_kind='audit_export'` y `'internal_dashboard'` son no-ops** en v1, reservados para fases futuras | YAGNI hasta que haya consumer |
| C8 | **Backfill opcional**: existing `outbreak_signal` events de los últimos 90 días que califican como ENO disease pueden insertarse retrospectivamente al outbox con `delivered_at = created_at` (= "ya fueron, no retry needed, solo para audit visibility") | Da contexto histórico a `/admin/outbox` sin trigger retroactivo. Si Ignacio decide skip, también está bien — la tabla arranca vacía |
| C9 | **Las reglas iniciales del outbox** (Fase C scope): solo dos rules. (a) `clinical_info_logged.sub_kind='disease_diagnosis'` con `disease_code ∈ ENO_DISEASES_AR` → outbox row `target_kind='govt_webhook'`, jurisdicción = pet.jurisdictionProvince/Locality, sla_due_at = now() + (eno.notifyHours horas). (b) `outbreak_signal` con severity ∈ ('high', 'critical') → mismo target | Mínimo viable. Más rules llegan cuando aterricen los specs que las necesiten (welfare urgent, custody disputes timeout) |

---

## 3. Glosario

| Término | Qué es |
|---|---|
| **Confidence tier** | Enum derivado por `computeConfidence(event)` que ordena la trustworthiness del event según el rol del emisor, su verificación, y evidencia adjunta |
| **Idempotency key** | UUID v4 client-supplied que protege contra double-submits. Persistido en columna física `pet_events.client_idempotency_key` |
| **Outbox** | Tabla `event_notification_outbox` que sostiene la promesa de SLA del catálogo ENO. Pending → drainer → delivered |
| **Drainer** | Cron `app/api/cron/drain-outbox/route.ts` que toma pending rows y las marca delivered o las re-cola con backoff |
| **SLA due** | `outbox.sla_due_at`. Marker del deadline legal (24h rabia / 48h leptospirosis / etc.) computado al crear la row. Si `now() > sla_due_at AND delivered_at IS NULL`, la row está en **breach** |

---

## 4. Plan paso a paso

### Fase A — Confidence tier (1 PR)

#### A.1 Crear `lib/event-confidence.ts`

```ts
import type { PetEvent } from "@/db/schema";

export type ConfidenceTier =
  | "institutional_verified"
  | "professional_verified"
  | "corroborated"
  | "self_reported"
  | "unverified";

export const CONFIDENCE_ORDER: ReadonlyArray<ConfidenceTier> = [
  "unverified",
  "self_reported",
  "corroborated",
  "professional_verified",
  "institutional_verified",
];

interface ConfidenceInput {
  authorRole: PetEvent["authorRole"];
  authorVerified: boolean;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
}

export function computeConfidence(input: ConfidenceInput): ConfidenceTier {
  const { authorRole, authorVerified, authorOrganizationId, payload } = input;

  // A4 bumper: confirmed_by_lab overrides everything below institutional
  if (payload.confirmed_by_lab === true) return "institutional_verified";

  // Org-signed and org is verified
  if (authorRole === "shelter" && authorVerified && authorOrganizationId) {
    return "institutional_verified";
  }
  if (authorRole === "govt" && authorVerified) {
    return "institutional_verified";
  }

  // Vet matriculated and verified
  if (authorRole === "vet" && authorVerified) {
    return "professional_verified";
  }

  // Owner with corroboration
  if (authorRole === "owner") {
    // attached evidence (future Fase 5+) or microchip-confirmed
    const hasEvidence =
      typeof (payload as { evidence_hash?: unknown }).evidence_hash === "string";
    const microchipMatched =
      payload.matched_chip_number != null || payload.microchip_confirmed === true;
    if (hasEvidence || microchipMatched) return "corroborated";
    return "self_reported";
  }

  // Anonymous scanner (QR scan from non-logged user)
  if (authorRole === "scanner") return "unverified";

  // Default for anything unmapped (system events, etc.)
  return "self_reported";
}

export function isAtLeast(tier: ConfidenceTier, minimum: ConfidenceTier): boolean {
  return CONFIDENCE_ORDER.indexOf(tier) >= CONFIDENCE_ORDER.indexOf(minimum);
}

/** Human-readable es-AR label for a tier. Used at render time only. */
export function confidenceLabel(tier: ConfidenceTier): string {
  switch (tier) {
    case "institutional_verified":
      return "Verificado institucionalmente";
    case "professional_verified":
      return "Verificado por veterinario matriculado";
    case "corroborated":
      return "Autorreportado con evidencia";
    case "self_reported":
      return "Reportado por el dueño";
    case "unverified":
      return "Sin verificar";
  }
}
```

#### A.2 Tests `lib/event-confidence.test.ts`

Cubrir cada cell de la tabla de truth — 6 author_role × {verified, !verified} × {has_org, !has_org} = 24 casos base + 4 bumpers especiales:

```ts
import { describe, it, expect } from "vitest";
import { computeConfidence } from "./event-confidence";

describe("computeConfidence", () => {
  it("shelter verified with org → institutional_verified", () => { ... });
  it("shelter verified without org → professional_verified fallback", () => { ... });
  it("vet verified → professional_verified", () => { ... });
  it("vet unverified → self_reported (treated as owner-equivalent until matriculation)", () => { ... });
  it("owner with evidence_hash → corroborated", () => { ... });
  it("owner with matched_chip_number → corroborated", () => { ... });
  it("owner alone → self_reported", () => { ... });
  it("scanner → unverified", () => { ... });
  it("any role with confirmed_by_lab=true → institutional_verified (A4 bumper)", () => { ... });
  it("govt verified → institutional_verified", () => { ... });
  it("isAtLeast comparisons", () => { ... });
  it("confidenceLabel returns es-AR strings", () => { ... });
});
```

#### A.3 Wire en `lib/libreta-sanitaria.ts`

Buscar la función formatter actual (`formatLibretaEntry` o similar). Agregar `confidenceTier` al output type. Render badge sutil en el componente `LibretaSanitariaView` con `<ConfidenceBadge tier={...} />`.

`components/event/ConfidenceBadge.tsx` (nuevo):

```tsx
import { confidenceLabel, type ConfidenceTier } from "@/lib/event-confidence";

interface Props { tier: ConfidenceTier; }

export function ConfidenceBadge({ tier }: Props) {
  // Visual: small chip, color-coded sutilmente
  const styles = {
    institutional_verified: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100",
    professional_verified: "bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100",
    corroborated: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
    self_reported: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    unverified: "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500",
  } as const;
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${styles[tier]}`}>
      {confidenceLabel(tier)}
    </span>
  );
}
```

#### A.4 Wire en `/p/[publicToken]` (credencial pública)

Solo cuando el último `vaccination_administered` está marcado como `institutional_verified` o `professional_verified`, mostrar el badge debajo de "Antirrábica vigente hasta...". No mostrarlo en self_reported (no queremos shame en la credencial pública).

#### A.5 Wire en `/gob/vigilancia/...`

Las páginas que listan outbreak signals (revisar el spec implementado de surveillance) deben:
- Mostrar el tier en cada row de la tabla
- Soportar filtro "Solo verificados institucionalmente" (checkbox que filtra a tier ≥ `professional_verified`)

#### A.6 Wire en `lib/owner-dashboard.ts` workflows widget

Display badge en cada workflow row del widget de "Workflows abiertos" del dashboard `/inicio`. Bajo perfil — chip pequeño al lado del título.

#### A.7 Verificación Fase A

- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes
- [x] Vitest coverage de `event-confidence.test.ts` cubre las 5 tiers y los bumpers A4
- [x] Manual: pet con vacuna shelter-verified vs owner-self-reported renderea distintos badges en `/libreta`
- [x] Manual: credencial pública NO muestra badge para self_reported (silencio voluntario)
- [x] Manual: `/gob/vigilancia` filtro por tier funciona
- [x] El test de `__tests__/event-schemas.test.ts` sigue pasando (Fase A no toca schemas)

### Fase B — Idempotency keys (1 PR)

#### B.1 Migration `db/migrations/0047_event_client_idempotency_key.sql`

```sql
ALTER TABLE pet_events
  ADD COLUMN client_idempotency_key UUID;

CREATE UNIQUE INDEX pet_events_client_idempotency_unique
  ON pet_events (pet_id, event_type, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;

COMMENT ON COLUMN pet_events.client_idempotency_key IS
  'Client-supplied UUIDv4 to make event writes idempotent under retry. Null for legacy rows and admin-tool writes. See lib/event-idempotency.ts.';
```

Aplicar manualmente via Supabase Studio per AGENTS.md convention. NO `pnpm db:push`.

#### B.2 Drizzle update `db/schema.ts`

Agregar la columna al schema de `petEvents`:

```ts
clientIdempotencyKey: uuid("client_idempotency_key"),
```

#### B.3 Helper server `lib/event-idempotency.ts`

```ts
import { db } from "@/db";
import { petEvents } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export async function findExistingByKey(
  petId: string,
  eventType: string,
  key: string,
): Promise<typeof petEvents.$inferSelect | null> {
  const [existing] = await db
    .select()
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petId),
        eq(petEvents.eventType, eventType),
        eq(petEvents.clientIdempotencyKey, key),
      ),
    )
    .limit(1);
  return existing ?? null;
}

/**
 * Wraps an event insert to make it idempotent under client retries.
 * Returns { event, wasNoop: boolean } — wasNoop=true means the row
 * already existed and we returned the existing one instead of inserting.
 */
export async function insertEventIdempotent<T extends typeof petEvents.$inferInsert>(
  values: T,
): Promise<{ event: typeof petEvents.$inferSelect; wasNoop: boolean }> {
  if (!values.clientIdempotencyKey) {
    // Server-emitted or admin tool: just insert.
    const [event] = await db.insert(petEvents).values(values).returning();
    return { event, wasNoop: false };
  }

  const inserted = await db
    .insert(petEvents)
    .values(values)
    .onConflictDoNothing({
      target: [petEvents.petId, petEvents.eventType, petEvents.clientIdempotencyKey],
    })
    .returning();

  if (inserted.length > 0) return { event: inserted[0], wasNoop: false };

  // Conflict: fetch the existing row.
  const existing = await findExistingByKey(
    values.petId as string,
    values.eventType as string,
    values.clientIdempotencyKey,
  );
  if (!existing) {
    // Defensive: this should not happen — onConflictDoNothing matched but the row is gone?
    throw new Error("Idempotency conflict but no existing row found — possible race or schema drift");
  }
  return { event: existing, wasNoop: true };
}
```

#### B.4 Client hook `lib/use-idempotency-key.ts`

```ts
"use client";
import { useRef } from "react";

/**
 * Returns a stable UUID v4 idempotency key for the lifetime of this form
 * mount. Regenerates only on explicit reset (via the returned function).
 */
export function useIdempotencyKey(): { key: string; reset: () => string } {
  const ref = useRef<string>(crypto.randomUUID());
  return {
    key: ref.current,
    reset: () => {
      ref.current = crypto.randomUUID();
      return ref.current;
    },
  };
}
```

#### B.5 Retrofit los 14 forms del registry

`lib/event-capture-registry.ts` ya enumera las routes. En cada `*Form.tsx` correspondiente:

```tsx
// Pattern:
const { key, reset } = useIdempotencyKey();

// In the form JSX:
<input type="hidden" name="clientIdempotencyKey" value={key} />

// On successful submit:
reset(); // regenerate for next entry (e.g., if form stays mounted)
```

Server action correspondiente (`app/actions/events.ts` o equivalente):

```ts
const clientIdempotencyKey = formData.get("clientIdempotencyKey")?.toString() || null;
// ... validation ...
const { event, wasNoop } = await insertEventIdempotent({
  petId,
  eventType: "vaccination_administered",
  payload: validated,
  // ... other fields ...
  clientIdempotencyKey,
});
if (wasNoop) {
  // Return same success state as a fresh insert — user doesn't need to know.
  return { ok: true as const, eventId: event.id };
}
```

#### B.6 Tests

`__tests__/event-idempotency.test.ts` (nuevo):

```ts
it("first insert succeeds with key");
it("second insert with same key returns wasNoop=true with original event");
it("second insert with different key creates new row");
it("conflict on same key with different payload — last write wins (DB allows; we accept this)");
it("null key never conflicts — multiple inserts succeed");
it("admin tool path (no key supplied) inserts normally");
```

**Nota B8 revisada**: a B8 dije "must error explicitly". En la práctica del `ON CONFLICT DO NOTHING` el segundo write con payload distinto NO se inserta (porque el conflict triggea no-op), entonces devuelve el row original. El test del caso "different payload" entonces verifica que se retorna el row original, NO el nuevo. El error explícito sería más estricto pero requeriría comparar payloads antes del insert, que es costo extra por una situación que no debería pasar nunca con clientes bien comportados. Aceptamos last-stable-wins, no last-write-wins.

#### B.7 Verificación Fase B

- [x] Migration aplicada en Supabase Studio
- [x] `pnpm db:start && pnpm test` verdes
- [x] `pnpm typecheck && pnpm lint && pnpm build` verdes
- [x] Manual: submitir form de peso 2× rápido en el mismo mount → debe haber 1 sola row en `pet_events` (no 2)
- [x] Manual: submitir, refrescar la página, volver a submitir con valor nuevo → 2 rows (porque el remount regenera el UUID)
- [x] Manual: simular network flake (DevTools → "Throttling Offline" + click submit) → al recuperar conexión, retry transparente, 1 sola row
- [x] `pnpm rebuild:projections --dry-run` reports zero drift (no debería cambiar nada)

### Fase C — Outbox (1 PR)

#### C.1 Migration `db/migrations/0048_event_notification_outbox.sql`

```sql
CREATE TYPE outbox_target_kind AS ENUM (
  'govt_webhook',
  'eno_authority',
  'audit_export',
  'internal_dashboard'
);

CREATE TYPE outbox_status AS ENUM (
  'pending',
  'delivered',
  'failed'
);

CREATE TABLE event_notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id UUID NOT NULL REFERENCES pet_events(id) ON DELETE CASCADE,
  target_kind outbox_target_kind NOT NULL,
  target_jurisdiction_province TEXT,
  target_jurisdiction_locality TEXT,
  payload_snapshot JSONB NOT NULL,
  sla_due_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status outbox_status NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMP WITH TIME ZONE,
  last_error TEXT,
  next_retry_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  delivered_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX event_notification_outbox_drainable_idx
  ON event_notification_outbox (next_retry_at)
  WHERE status = 'pending';

CREATE INDEX event_notification_outbox_sla_idx
  ON event_notification_outbox (sla_due_at, status);

CREATE INDEX event_notification_outbox_source_event_idx
  ON event_notification_outbox (source_event_id);

COMMENT ON TABLE event_notification_outbox IS
  'Pending external deliveries (govt webhooks, ENO reports, audit exports). Drained by /api/cron/drain-outbox every 5 minutes. SLA tracked via sla_due_at vs delivered_at.';
```

#### C.2 Drizzle update `db/schema.ts`

Agregar `eventNotificationOutbox` table + enums.

#### C.3 `lib/event-outbox-rules.ts`

```ts
import type { EventType } from "@/db/schema";
import { ENO_DISEASES_AR } from "./eno-catalog";

export type OutboxTargetKind = "govt_webhook" | "eno_authority" | "audit_export" | "internal_dashboard";

export interface OutboxRule {
  target_kind: OutboxTargetKind;
  /** Returns the SLA window in hours, or null to skip this rule for this payload. */
  slaHours: (payload: Record<string, unknown>) => number | null;
  /** Optional payload transformer for the snapshot. Defaults to identity. */
  buildSnapshot?: (payload: Record<string, unknown>) => Record<string, unknown>;
}

export const OUTBOX_RULES: Partial<Record<EventType, OutboxRule[]>> = {
  clinical_info_logged: [
    {
      target_kind: "govt_webhook",
      slaHours: (payload) => {
        if (payload.sub_kind !== "disease_diagnosis") return null;
        const disease = ENO_DISEASES_AR.find((d) => d.code === payload.disease_code);
        return disease ? disease.notifyHours : null;
      },
    },
  ],
  outbreak_signal: [
    {
      target_kind: "govt_webhook",
      slaHours: (payload) => {
        if (payload.severity !== "high" && payload.severity !== "critical") return null;
        // Default 24h for any high+ severity outbreak signal
        return 24;
      },
    },
  ],
};
```

#### C.4 Hook en server actions que emiten events ENO

Cuando se inserta un `clinical_info_logged(disease_diagnosis)` o un `outbreak_signal`, en la misma transaction inserter las outbox rows que aplican según las reglas. Crear helper `lib/event-outbox-enqueue.ts`:

```ts
export async function enqueueOutboxForEvent(
  tx: PgTransaction,
  event: { id: string; eventType: EventType; payload: Record<string, unknown> },
  pet: { jurisdictionProvince: string | null; jurisdictionLocality: string | null },
): Promise<void> {
  const rules = OUTBOX_RULES[event.eventType] ?? [];
  for (const rule of rules) {
    const slaHours = rule.slaHours(event.payload);
    if (slaHours === null) continue;
    const slaDueAt = new Date(Date.now() + slaHours * 3600 * 1000);
    const snapshot = rule.buildSnapshot?.(event.payload) ?? event.payload;
    await tx.insert(eventNotificationOutbox).values({
      sourceEventId: event.id,
      targetKind: rule.target_kind,
      targetJurisdictionProvince: pet.jurisdictionProvince,
      targetJurisdictionLocality: pet.jurisdictionLocality,
      payloadSnapshot: snapshot,
      slaDueAt: slaDueAt,
    });
  }
}
```

Wirear en las dos actions del scope (ver §2 / C9). Las actions que ya existen y emiten `outbreak_signal` están en `app/actions/welfare.ts` y la pipeline del surveillance — los tocás justo después del insert del event source, mismo `tx`.

#### C.5 Drainer cron `app/api/cron/drain-outbox/route.ts`

Patrón de `app/api/cron/auto-expire-approvals/route.ts`:

```ts
import { NextResponse } from "next/server";
import { db } from "@/db";
import { eventNotificationOutbox } from "@/db/schema";
import { and, eq, isNull, lte } from "drizzle-orm";
import { recordCronRun } from "@/lib/cron-runs";

const MAX_ATTEMPTS = 8;
const BACKOFF_MINUTES = [5, 15, 45, 120, 360, 720, 1440, 1440]; // last two are 24h
const BATCH_SIZE = 50;

export async function GET(request: Request) {
  // Cron auth — same pattern as other crons.
  // ...

  const start = Date.now();
  const pending = await db
    .select()
    .from(eventNotificationOutbox)
    .where(
      and(
        eq(eventNotificationOutbox.status, "pending"),
        lte(eventNotificationOutbox.nextRetryAt, new Date()),
      ),
    )
    .limit(BATCH_SIZE);

  let delivered = 0;
  let failed = 0;
  let retried = 0;

  for (const row of pending) {
    try {
      await deliverOutboxRow(row); // see C.6
      await db
        .update(eventNotificationOutbox)
        .set({ status: "delivered", deliveredAt: new Date(), lastError: null })
        .where(eq(eventNotificationOutbox.id, row.id));
      delivered++;
    } catch (err) {
      const nextAttempt = row.attempts + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        await db
          .update(eventNotificationOutbox)
          .set({
            status: "failed",
            attempts: nextAttempt,
            lastError: String(err),
            lastAttemptAt: new Date(),
          })
          .where(eq(eventNotificationOutbox.id, row.id));
        failed++;
      } else {
        const backoffMin = BACKOFF_MINUTES[nextAttempt - 1] ?? 1440;
        const nextRetryAt = new Date(Date.now() + backoffMin * 60 * 1000);
        await db
          .update(eventNotificationOutbox)
          .set({
            attempts: nextAttempt,
            lastError: String(err),
            lastAttemptAt: new Date(),
            nextRetryAt,
          })
          .where(eq(eventNotificationOutbox.id, row.id));
        retried++;
      }
    }
  }

  await recordCronRun("drain-outbox", {
    durationMs: Date.now() - start,
    processed: pending.length,
    delivered,
    failed,
    retried,
  });

  return NextResponse.json({ ok: true, processed: pending.length, delivered, failed, retried });
}
```

#### C.6 Delivery handlers `lib/outbox-deliverers.ts`

```ts
export async function deliverOutboxRow(row: OutboxRow): Promise<void> {
  switch (row.targetKind) {
    case "govt_webhook":
      // v1: no real webhook receiver — write to audit_log and mark delivered.
      await writeAuditLog({
        action: "outbox.govt_webhook.would_send",
        actor: "system",
        details: {
          source_event_id: row.sourceEventId,
          jurisdiction: {
            province: row.targetJurisdictionProvince,
            locality: row.targetJurisdictionLocality,
          },
          payload: row.payloadSnapshot,
        },
      });
      return; // success
    case "eno_authority":
    case "audit_export":
    case "internal_dashboard":
      // v1: no consumers — log and mark delivered.
      await writeAuditLog({
        action: `outbox.${row.targetKind}.would_send`,
        actor: "system",
        details: { source_event_id: row.sourceEventId, payload: row.payloadSnapshot },
      });
      return;
  }
}
```

#### C.7 UI `/admin/outbox`

`app/admin/outbox/page.tsx` (nuevo):

- Tabla con columnas: SLA estado (verde/amarillo/rojo según breach), target_kind, jurisdicción, source_event link, attempts, last_error preview, created_at, sla_due_at
- Filtros: status (pending/delivered/failed), target_kind, breach yes/no, jurisdicción
- Acciones por row: "Ver detalle", "Retry now" (resetea next_retry_at a now() + status=pending si era failed)

`app/admin/outbox/[id]/page.tsx`: detail view con raw payload + raw error + history de attempts.

Sub-link en `app/admin/layout.tsx` chrome (nav principal): nuevo item "Outbox" con badge mostrando count de breach.

#### C.8 Vercel cron config

Agregar al `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/drain-outbox", "schedule": "*/5 * * * *" }
  ]
}
```

#### C.9 (Opcional) Backfill script

`scripts/backfill-outbox.ts`: itera `outbreak_signal` events de los últimos 90 días que califican y crea outbox rows con `status='delivered', delivered_at=created_at` (= "ya fueron, esto es solo para visibility histórica"). Si Ignacio decide skipear, la tabla arranca vacía sin problema.

#### C.10 Tests

`__tests__/outbox-enqueue.test.ts`:
- Emisión de `disease_diagnosis(rabies)` → 1 outbox row con sla_due_at = now + 24h
- Emisión de `disease_diagnosis(unknown_disease)` → 0 outbox rows
- Emisión de `outbreak_signal(severity=critical)` → 1 row con sla 24h
- Emisión de `outbreak_signal(severity=low)` → 0 rows
- Transactional integrity: si el insert del outbox falla, el event source NO se persiste

`__tests__/outbox-drainer.test.ts`:
- Pending rows due → delivered
- Pending rows not yet due → skipped
- Failure → attempts++ + next_retry_at advanced
- Attempts == MAX_ATTEMPTS → status='failed'

#### C.11 Verificación Fase C

- [x] Migration aplicada
- [x] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes
- [x] Manual: emit `clinical_info_logged(disease_diagnosis, disease=rabies)` desde una capability de vet → row aparece en `event_notification_outbox` con sla_due_at correcto
- [x] Manual: hit `GET /api/cron/drain-outbox` con cron secret → audit log entry "outbox.govt_webhook.would_send" + row pasa a delivered
- [x] Manual: `/admin/outbox` muestra la row pendiente → después del drain, en "Entregadas"
- [x] `cron_runs` table muestra la última corrida del drainer

---

## 5. Out of scope (explícito)

- **Webhooks reales a SENASA / Mi Argentina** — Fase C deja la tubería lista. El cliente HTTP real con auth + retry semantics específicas de cada destinatario es trabajo separado cuando exista el endpoint receptor.
- **Confidence tier como columna persistida** — A5 lo dice. Si los queries de `/gob` se vuelven lentos, se cachea después como denorm column con un trigger o como projection table. No hoy.
- **Retrofit de idempotency keys en admin tools** — solo los 14 forms del registry. Los admin tools no son user-initiated y el riesgo de double-submit por flaky network es chico.
- **UI de retry masivo en `/admin/outbox`** — solo retry single-row en v1. Si aparece un incident de "100 rows failed por un bug del drainer", el retry masivo se hace por SQL desde Studio.
- **Tiers 2-4 del brainstorm** — viven en `specs/2026-05-22-event-trust-tiers-2-4-design.md` como low priority. Correction events, content-addressed attachments, disputed events, right-to-erasure tombstones, Merkle anchoring, reputation per emitter, vector clocks. No tocar acá.

---

## 6. Cómo medir el éxito

**Fase A**: el primer usuario que pregunta "¿esta vacuna está verificada?" sobre un evento self_reported obtiene una respuesta consistente en libreta, en credencial pública, y en `/gob/vigilancia`. Todos los surfaces dicen lo mismo.

**Fase B**: en `audit_log` o métricas, el ratio de "near-duplicates" (mismo pet, mismo event_type, occurred_at dentro de 60 segundos) cae a near-zero después de 1 semana de retrofit. Si quedan, los keys explican por qué (eran intencionales — usuario registró 2 vacunas distintas seguidas).

**Fase C**: cuando un govt rep pregunta "¿el ENO del 22 de mayo se reportó dentro de las 24h?", `/admin/outbox` muestra la row con `delivered_at - created_at < 24h` (o el breach explícito si hubo falla). Hoy esa pregunta no tiene respuesta.

---

## 7. Dependencias y orden

Tres fases son **independientes entre sí**. Se pueden hacer en cualquier orden. Sugerido por leverage:

1. **Fase A primero** (1 día, alto leverage UX, cero schema risk)
2. **Fase B segundo** (2-3 días, baja blast radius gracias al partial index, alto leverage para PWA + futuro `/pro` + agente conversacional)
3. **Fase C tercero** (3-5 días, mayor scope, depende de ENO catalog del spec del 21-05 que ya está lockeado pero quizá no implementado al 100%)

Si el plan de ENO pipeline aún no está implementado en su totalidad, Fase C puede landar antes que ese y simplemente **no tener reglas que disparen** (el outbox queda vacío). Eso está OK — la infraestructura está lista para cuando las reglas se enchufen.

---

**Listo para CC.** Tres PRs, ningún cross-dependency hard. Cada fase deja el repo verde y mergeable en aislamiento.
