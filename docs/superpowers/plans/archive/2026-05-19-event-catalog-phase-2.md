# Event catalog cleanup — Phase 2: collapse redundant lifecycle events + move telemetry out

> Plan ejecutable para Claude Code. Segunda fase de cleanup del catálogo `EVENT_TYPES`, después del cleanup del 2026-05-18 que colapsó lab/imaging/surgery/allergy en `clinical_info_logged`. Cinco cambios independientes: se retiran **10 event_types** del catálogo, se agregan **3 resolvers nuevos**, se mueve una telemetría que no era hecho clínico fuera de `pet_events`. Net del catálogo: 48 → 41 (el header de AGENTS.md hoy dice "39" pero está desactualizado — se corrige). Cero rewrite de filas históricas; una migración SQL chica para la tabla nueva `share_telemetry`.
>
> **Fecha:** 2026-05-19
> **Owner:** Ignacio Del Valle
> **Tamaño:** 1 migración SQL chica (`share_telemetry`), ~10 archivos de código tocados, 2 tests nuevos, AGENTS.md refresh
> **Estimación:** ~1 día / 6-8 horas
> **Predecesor:** `docs/superpowers/plans/2026-05-18-event-catalog-cleanup.md`

---

## 0. Antes de tocar nada

Lectura obligatoria:

1. **`docs/superpowers/plans/2026-05-18-event-catalog-cleanup.md`** — el cleanup anterior. Lee D1 (filas históricas se preservan) y D10 (CI coverage test). Las mismas reglas aplican acá.
2. **`AGENTS.md → Event catalog — 39 types`** (línea ~455) — la lista actual. Header desactualizado (el const real tiene 48). Vas a borrar 10 filas, agregar 3.
3. **`AGENTS.md → Deprecated event types`** (línea ~557) — la sección que documenta eventos retirados. Vas a sumar 10 filas (una por cada event_type que sale de `EVENT_TYPES`).
4. **`AGENTS.md → Pattern: umbrella event_type con discriminator`** (línea ~597+) — el patrón que vas a aplicar tres veces (foster proposal resolved, adoption application resolved, adoption reversed).
5. **`db/schema.ts → EVENT_TYPES`** (línea ~220) — la const con los strings.
6. **`lib/event-schemas.ts`** — Zod schemas + `PayloadSchemas` registry.
7. **`lib/libreta-sanitaria.ts`** — `LIBRETA_SANITARIA_EVENT_TYPES` y `NON_LIBRETA_EVENT_TYPES`. Vas a tener que reclasificar.
8. **`__tests__/event-catalog-coverage.test.ts`** (si no existe con ese nombre, está en otro test del lib — buscá `EVENT_TYPES ↔ PayloadSchemas`). Sigue siendo no-negociable que pase verde.

**Antes de empezar**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes en main. Si hay rojos pre-existentes, parar y avisar.

## 1. Qué construye este plan

Cinco cambios, cinco commits. Cada cambio es independiente — si uno se complica podés mergear los otros cuatro solos.

**Cambio 1 — Foster proposal lifecycle: 5 → 2 event_types.**
- Mantener: `foster_proposed`
- Agregar: `foster_proposal_resolved` con `outcome: 'accepted' | 'rejected' | 'cancelled' | 'expired'`
- Borrar del catálogo: `foster_proposal_accepted`, `foster_proposal_rejected`, `foster_proposal_cancelled`, `foster_proposal_expired`
- Net: -3 event_types

**Cambio 2 — Adoption reversal: 2 → 1 event_type.**
- Agregar: `adoption_reversed` con `actor: 'shelter' | 'adopter' | 'court'`
- Borrar del catálogo: `adoption_revoked`, `adoption_withdrawn`
- Net: -1 event_type

**Cambio 3 — Adoption application resolution: 3 → 2 event_types.**
- Mantener: `adoption_application_submitted`
- Agregar: `adoption_application_resolved` con `outcome: 'approved' | 'rejected'`
- Borrar del catálogo: `adoption_application_approved`, `adoption_application_rejected`
- Net: -1 event_type

**Cambio 4 — Telemetría afuera de `pet_events`.**
- Nueva tabla `share_telemetry` con columnas `pet_id`, `share_token_id`, `viewed_at`, `viewer_ip_hash`, `user_agent`.
- Borrar del catálogo: `libreta_shared_viewed`.
- Reescribir el writer en `app/actions/libreta-share.ts` para insertar en `share_telemetry` en vez de `pet_events`.
- Net: -1 event_type, +1 tabla.

**Cambio 5 — `microchip_revoked` absorbido por `microchip_replaced`.**
- Modificar el schema de `microchip_replaced` para que `new_chip_number` sea nullable (null = revocación, no hay nuevo chip).
- Unión de `reason` enums; agregar campos opcionales de audit (`actor_role`, `actor_user_id`) que sólo se setean en branch de revocación.
- Borrar del catálogo: `microchip_revoked`.
- Net: -1 event_type.

**Total: -10 + 3 = -7 event_types netos. El catálogo `EVENT_TYPES` tiene 48 entries hoy (verificado: `wc -l` sobre el bloque del const); queda en 41 después de este plan. El header de AGENTS.md actualmente dice "Event catalog — 39 types" pero está desactualizado — el Paso 7a corrige ambos en un solo touch.**

Más:
- CI coverage test (existente) actualizado.
- AGENTS.md → Event catalog refresh (count + filas) + Deprecated section + Notes.
- Tests nuevos: payload shape de los 3 resolvers nuevos + un test de "old event_type strings still render in format.ts catch-all" para garantizar que filas históricas no rompen el timeline.

## 2. Decisiones cerradas

| # | Decisión | Por qué |
|---|---|---|
| D1 | **Filas históricas en `pet_events` con los 7 event_types borrados se preservan.** No rewrite, no migración de datos | Misma regla que el cleanup del 2026-05-18 (D1 de aquel plan). Events son inmutables; sólo borramos del const + Zod. `eventPayloadSummary` ya tiene catch-all, los timelines siguen renderizando filas viejas |
| D2 | **No re-emitir los eventos nuevos sobre filas viejas.** Cuando borrás `foster_proposal_accepted` del catálogo, las filas históricas de ese tipo NO se duplican como `foster_proposal_resolved` | Sería rewrite encubierto del log inmutable. Las proyecciones que necesiten "todas las propuestas resueltas" leen ambos: `IN ('foster_proposal_resolved', 'foster_proposal_accepted', ...)` durante la transición. Eventualmente cuando no queden filas viejas se simplifica — pero no urgente |
| D3 | **El branch de revocación de chip se distingue por `new_chip_number IS NULL`.** No hay enum `mode: replace \| revoke` | Más simple — un sólo campo distingue. El reader hace `if (payload.new_chip_number === null) … // revocation` |
| D4 | **`share_telemetry` vive en su propia tabla, no extiende `pet_events` con un flag `is_telemetry`** | El motivo de mover esto era *sacarlo* del log clínico, no marcarlo. Una tabla aparte significa que `SELECT * FROM pet_events WHERE pet_id = X` no devuelve ruido nunca más |
| D5 | **`share_telemetry.pet_id` es FK sin cascade.** Si una mascota se borra (hard delete) la fila de telemetría queda huérfana | Hard delete de mascotas no existe en DIM — todo es soft delete vía `pets.status`. Si llegara a existir, la fila huérfana es ruido analytics, no riesgo legal |
| D6 | **`share_telemetry` lleva `viewer_ip_hash`, no `viewer_ip`.** Mismo posture que el schema actual de `libreta_shared_viewed` | PDP — la IP es dato personal. Hashear con el secreto que ya use el resto del proyecto |
| D7 | **`adoption_application_resolved` con `outcome='rejected'` requiere `reason`** (string). Con `outcome='approved'`, `reason` es opcional | El schema de `adoption_application_rejected` actual ya pedía `reason` requerido y `auto_generated: boolean`. Esos campos pasan al resolver pero sólo aplican si `outcome='rejected'` |
| D8 | **`foster_proposal_resolved` lleva campos opcionales discriminados por outcome.** `rejection_reason` sólo cuando `outcome='rejected'`; `cancellation_reason` + `auto_cancelled` sólo cuando `outcome='cancelled'`. El Zod no enforcea esa correlación — la valida el server action que escribe | El strict object enforcea claves; la correlación valor↔valor es responsabilidad del writer. Mismo posture que el resto de event-schemas. Test cubre el caso |
| D9 | **`adoption_reversed.reverted_finalization_event_id` es opcional**, no requerido | El finalize puede no estar registrado todavía (datos viejos pre-event-sourcing). Cuando esté, se referencia; cuando no, queda null y la UI describe el reverso por contexto |
| D10 | **CI coverage test es no-negociable**, igual que en cleanup anterior (D10 de aquel plan) | Cualquier event_type nuevo necesita schema. Si removemos algo, el test verifica que también sale de `PayloadSchemas` y de `LIBRETA_SANITARIA_EVENT_TYPES` / `NON_LIBRETA_EVENT_TYPES` |

## 3. Scope

**Dentro:**
- `db/schema.ts` — `EVENT_TYPES` (borrar 10 strings, agregar 3) + nueva tabla `share_telemetry`
- `db/migrations/000X_share_telemetry.sql` (nuevo, Drizzle-generated)
- `lib/event-schemas.ts` — borrar los schemas que existan para los 10 retirados (algunos pueden no tener schema todavía si eran UI-deferred), agregar 3 (resolvers), modificar 1 (`microchipReplaced`); actualizar `PayloadSchemas` registry
- `lib/libreta-sanitaria.ts` — reclasificar (sacar los 10 retirados; agregar los 3 nuevos)
- `app/actions/foster-proposals.ts` — actualizar 3 writers (accepted, rejected, cancelled)
- `app/actions/foster-volunteers.ts` — actualizar 1 writer (cancelled)
- `lib/foster-proposal-expirer.ts` — actualizar 1 writer (expired)
- `app/actions/adoption-applications.ts` — actualizar 2 writers (approved, rejected)
- `app/actions/adoption.ts` — actualizar 1 writer (rejected, auto-cascade)
- `app/actions/libreta-share.ts` — reescribir el writer (`pet_events` → `share_telemetry`)
- `lib/format.ts` — agregar cases para los 3 resolvers nuevos + actualizar `microchip_replaced`; los 10 retirados ya caen al catch-all (no había case dedicado para ninguno, verificado en pre-research)
- `__tests__/event-catalog-coverage.test.ts` (o donde esté el test de cobertura) — sincronizar
- `lib/event-schemas.test.ts` — tests nuevos de payload shape de los 3 resolvers
- Test nuevo: `__tests__/event-timeline-historical-rows.test.ts` (o name equivalente) — verifica que strings de event_type retirados todavía renderizan vía catch-all en `eventPayloadSummary`
- `AGENTS.md` → Event catalog section (header count actual está desactualizado: dice 39, real son 48 → quedan 41 post-cleanup; borrar 10 filas; agregar 3 filas; reescribir la fila de `microchip_replaced` con el shape merged)
- `AGENTS.md` → Deprecated event types (agregar 10 filas, una por cada retirado)
- `docs/superpowers/README.md` — marcar este plan como done cuando termine

**Fuera:**
- Backfill de filas históricas (D1 + D2 cerradas)
- Cualquier UI nueva — no hay flows nuevos, sólo refactor de los existentes
- Borrar physically filas históricas con event_types deprecated — events son inmutables
- Adicional patterns documentation en AGENTS.md más allá del refresh — el cleanup anterior ya dejó la sección "Pattern: umbrella event_type con discriminator", este plan la *aplica* tres veces. Si algo nuevo sale del refactor, documentar; si no, no inventar
- Cambios al `event-capture-registry.ts` — los event_types borrados no estaban registrados ahí (sólo `weight_recorded`, `death_recorded` están, verificado en pre-research)

## 4. Plan paso a paso

Después de cada paso: `pnpm typecheck && pnpm lint`. Tests al final de cada commit.

### Paso 1 — `foster_proposal_resolved` y borrar los 4 viejos

**1a.** En `db/schema.ts → EVENT_TYPES`, borrar las 4 filas:

```
"foster_proposal_accepted",
"foster_proposal_rejected",
"foster_proposal_cancelled",
"foster_proposal_expired",
```

Reemplazarlas con:

```
"foster_proposal_resolved",
```

`foster_proposed` queda igual.

**1b.** En `lib/event-schemas.ts`, borrar los 4 const `fosterProposalAccepted`, `fosterProposalRejected`, `fosterProposalCancelled`, `fosterProposalExpired`. Agregar:

```ts
const fosterProposalResolved = z
  .object(
    withVersion({
      proposal_public_token: z.string(),
      outcome: z.enum(["accepted", "rejected", "cancelled", "expired"]),
      // Optional fields, semantically gated by outcome (server action enforces).
      response_notes: z.string().nullable().optional(),
      // outcome === "rejected" only:
      rejection_reason: z
        .enum(["capacity", "health_mismatch", "timing", "distance", "household", "other"])
        .nullable()
        .optional(),
      // outcome === "cancelled" only:
      cancellation_reason: z.string().nullable().optional(),
      auto_cancelled: z.boolean().default(false).optional(),
    }),
  )
  .strict();
```

En el `PayloadSchemas` registry, borrar las 4 entries y agregar `foster_proposal_resolved: fosterProposalResolved`.

**1c.** Actualizar los writers. En `app/actions/foster-proposals.ts` buscar cada uno de los tres lugares donde se escribe `eventType: "foster_proposal_accepted" | "foster_proposal_rejected" | "foster_proposal_cancelled"` y reemplazar por `eventType: "foster_proposal_resolved"` con el payload nuevo. Mapeos:

| Antes | Después |
|---|---|
| `{ proposal_public_token, response_notes }` con type `foster_proposal_accepted` | `{ proposal_public_token, outcome: "accepted", response_notes }` |
| `{ proposal_public_token, rejection_reason, response_notes }` con type `foster_proposal_rejected` | `{ proposal_public_token, outcome: "rejected", rejection_reason, response_notes }` |
| `{ proposal_public_token, cancellation_reason, auto_cancelled }` con type `foster_proposal_cancelled` | `{ proposal_public_token, outcome: "cancelled", cancellation_reason, auto_cancelled }` |

En `app/actions/foster-volunteers.ts` hay un cuarto writer de `foster_proposal_cancelled` — mismo refactor.

En `lib/foster-proposal-expirer.ts` el cron escribe `foster_proposal_expired` con sólo `proposal_public_token`. Cambiar a:

```ts
eventType: "foster_proposal_resolved",
payload: { proposal_public_token, outcome: "expired" }
```

**1d.** En `lib/libreta-sanitaria.ts`, borrar las 4 entries y agregar `foster_proposal_resolved` en el grupo que corresponda (custody/system — el mismo grupo donde estaban los 4 viejos).

**1e.** En `lib/format.ts → eventPayloadSummary`, agregar case para `foster_proposal_resolved` que renderiza string según `outcome`:

```ts
case "foster_proposal_resolved": {
  const outcome = payload.outcome as string;
  const label = {
    accepted: "Propuesta de tránsito aceptada",
    rejected: "Propuesta de tránsito rechazada",
    cancelled: "Propuesta de tránsito cancelada",
    expired: "Propuesta de tránsito expirada",
  }[outcome] ?? "Propuesta de tránsito resuelta";
  return label;
}
```

(No agregar cases para los 4 viejos — el catch-all del switch ya devuelve algo razonable, y la idea es que las filas viejas sigan renderizando sin código nuevo).

**1f.** Commit: `refactor(events): collapse foster_proposal_{accepted,rejected,cancelled,expired} into foster_proposal_resolved`.

### Paso 2 — `adoption_reversed`

**2a.** En `db/schema.ts → EVENT_TYPES`, borrar `"adoption_revoked"` y `"adoption_withdrawn"`. Agregar:

```
"adoption_reversed",
```

**2b.** En `lib/event-schemas.ts`, borrar los schemas que correspondan a `adoption_revoked` / `adoption_withdrawn` si están (si no existen porque eran UI-deferred, no hace falta borrar nada — sólo asegurarse que `PayloadSchemas` no los referencie). Agregar:

```ts
const adoptionReversed = z
  .object(
    withVersion({
      actor: z.enum(["shelter", "adopter", "court"]),
      reason: z.string().nullable(),
      // Optional reference to the adoption_finalized event being undone. Null
      // when the finalize predates event-sourcing or is otherwise unknown.
      reverted_finalization_event_id: z.string().uuid().nullable().optional(),
    }),
  )
  .strict();
```

Agregar `adoption_reversed: adoptionReversed` al `PayloadSchemas`.

**2c.** Ningún writer en `app/actions/` — pre-research confirmó cero writers para `adoption_revoked` y `adoption_withdrawn`. No hay refactor de código de acción. Si alguna parte de la app *lee* esos event_types (por ej. timeline filters), seguirá funcionando porque las filas históricas, si existen, no se tocan.

**2d.** En `lib/libreta-sanitaria.ts`, borrar las dos entries y agregar `adoption_reversed` en el grupo custody (NON-libreta).

**2e.** En `lib/format.ts → eventPayloadSummary`, agregar case:

```ts
case "adoption_reversed": {
  const actor = payload.actor as string;
  const by = { shelter: "el refugio", adopter: "el adoptante", court: "orden judicial" }[actor] ?? "alguien";
  return `Adopción revertida por ${by}`;
}
```

**2f.** Commit: `refactor(events): collapse adoption_{revoked,withdrawn} into adoption_reversed`.

### Paso 3 — `adoption_application_resolved`

**3a.** En `db/schema.ts → EVENT_TYPES`, borrar `"adoption_application_approved"` y `"adoption_application_rejected"`. Agregar:

```
"adoption_application_resolved",
```

`adoption_application_submitted` queda.

**3b.** En `lib/event-schemas.ts`, borrar los const `adoptionApplicationApproved` y `adoptionApplicationRejected`. Agregar:

```ts
const adoptionApplicationResolved = z
  .object(
    withVersion({
      application_event_id: z.string().uuid(),
      reviewer_user_id: z.string().uuid(),
      outcome: z.enum(["approved", "rejected"]),
      // Required when outcome === "rejected"; optional otherwise. Server
      // action enforces; Zod stays permissive.
      reason: z.string().nullable().optional(),
      // outcome === "rejected" only — the auto-cascade flag from finalize.
      auto_generated: z.boolean().default(false).optional(),
      notes: z.string().nullable().optional(),
    }),
  )
  .strict();
```

Borrar las dos entries de `PayloadSchemas`, agregar `adoption_application_resolved: adoptionApplicationResolved`.

**3c.** Writers. En `app/actions/adoption-applications.ts`:

| Antes | Después |
|---|---|
| `eventType: "adoption_application_approved"`, payload `{ application_event_id, reviewer_user_id, notes }` | `eventType: "adoption_application_resolved"`, payload `{ application_event_id, reviewer_user_id, outcome: "approved", notes }` |
| `eventType: "adoption_application_rejected"`, payload `{ application_event_id, reviewer_user_id, reason, auto_generated, notes }` | `eventType: "adoption_application_resolved"`, payload `{ application_event_id, reviewer_user_id, outcome: "rejected", reason, auto_generated, notes }` |

En `app/actions/adoption.ts` hay un segundo writer de `adoption_application_rejected` (cascade rejection al finalizar otra application — `auto_generated: true`). Mismo refactor.

**3d.** En `lib/libreta-sanitaria.ts`, borrar las dos entries y agregar `adoption_application_resolved` en el grupo custody.

**3e.** En `lib/format.ts`, agregar case:

```ts
case "adoption_application_resolved": {
  const outcome = payload.outcome as string;
  return outcome === "approved" ? "Solicitud de adopción aprobada" : "Solicitud de adopción rechazada";
}
```

**3f.** Commit: `refactor(events): collapse adoption_application_{approved,rejected} into adoption_application_resolved`.

### Paso 4 — `share_telemetry` table, retirar `libreta_shared_viewed`

**4a.** En `db/schema.ts`, agregar la tabla nueva. Ubicarla cerca de `petEvents` (mismo bloque temático):

```ts
export const shareTelemetry = pgTable(
  "share_telemetry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id").notNull().references(() => pets.id),
    shareTokenId: uuid("share_token_id").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
    // SHA-256 hash of the viewer IP using the project-wide secret. Plain IP is
    // PDP-sensitive; hash lets us count uniques without keeping the value.
    viewerIpHash: text("viewer_ip_hash"),
    userAgent: text("user_agent"),
  },
  (table) => ({
    petIdx: index("share_telemetry_pet_idx").on(table.petId),
    tokenIdx: index("share_telemetry_token_viewed_idx").on(table.shareTokenId, table.viewedAt),
  }),
);
```

Generar la migración: `pnpm db:generate`. Inspeccionar el SQL bajo `db/migrations/` — debe ser un `CREATE TABLE` + dos `CREATE INDEX`. Sin RLS por ahora (privado, server-only — coincide con cómo se accede hoy desde `app/actions/libreta-share.ts`).

**4b.** En `db/schema.ts → EVENT_TYPES`, borrar `"libreta_shared_viewed"`.

**4c.** En `lib/event-schemas.ts`, borrar el const `libretaSharedViewed` y la entry del `PayloadSchemas`.

**4d.** En `app/actions/libreta-share.ts`, encontrar el writer que hace `insert(petEvents)` con `eventType: "libreta_shared_viewed"`. Reemplazarlo por:

```ts
await db.insert(shareTelemetry).values({
  petId: pet.id,
  shareTokenId,
  viewerIpHash,
  userAgent,
});
```

(Mantener exactamente el mismo cálculo de `viewerIpHash` y `userAgent` que ya hace; sólo cambia el destino.)

**4e.** En `lib/libreta-sanitaria.ts`, borrar la entry de `libreta_shared_viewed`. No agregar nada — la tabla nueva no es del catálogo de events.

**4f.** Si hay alguna proyección/query que lee `pet_events WHERE event_type = 'libreta_shared_viewed'` para mostrar "X personas vieron tu libreta", redirigirla a `SELECT count(*) FROM share_telemetry WHERE pet_id = ?`. Hacer `grep -rn "libreta_shared_viewed"` antes y después del cambio para confirmar que no quedan referencias en código (los strings históricos pueden seguir apareciendo en seeds o docs, ignorarlos).

**4g.** Commit: `refactor(events): move libreta_shared_viewed telemetry to share_telemetry table`.

### Paso 5 — `microchip_replaced` absorbe `microchip_revoked`

**5a.** En `db/schema.ts → EVENT_TYPES`, borrar `"microchip_revoked"`. `microchip_replaced` queda.

**5b.** En `lib/event-schemas.ts`, borrar el const `microchipRevoked` y la entry del `PayloadSchemas`. Modificar `microchipReplaced`:

```ts
const microchipReplaced = z
  .object(
    withVersion({
      previous_chip_number: z.string(),
      // null means the chip was revoked without a replacement (fraud,
      // duplicate, device failure). Non-null is the standard replacement case.
      new_chip_number: z.string().nullable(),
      reason: z.enum([
        // Replacement reasons (carry-over).
        "damaged",
        "unreadable",
        "duplicate_detected",
        // Revocation reasons (carry-over from microchip_revoked).
        "fraud_detected",
        "owner_request",
        "device_failure",
        "other",
      ]),
      // Replacement branch: free-text vet/clinic.
      replaced_by: z.string().nullable(),
      // ISO date when the operation was performed.
      replaced_at: z.string(),
      // Audit context — only set when the operation was institutional (vet,
      // admin, govt). Owner-initiated owner_request revocations omit these.
      actor_role: z.enum(["owner", "vet", "admin", "govt"]).default("owner"),
      actor_user_id: z.string().uuid().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
  )
  .strict();
```

**5c.** Ningún writer en `app/actions/` ni para `microchip_revoked` ni para `microchip_replaced` — pre-research confirmó cero writers. Schema-ready, UI deferred. Cuando se construya la UI seguirá el shape merged.

**5d.** En `lib/libreta-sanitaria.ts`, borrar la entry de `microchip_revoked`. `microchip_replaced` queda donde estaba (libreta-sanitaria, microchip group).

**5e.** En `lib/format.ts`, actualizar el case de `microchip_replaced` para manejar el branch null:

```ts
case "microchip_replaced": {
  return payload.new_chip_number === null
    ? "Microchip revocado"
    : "Microchip reemplazado";
}
```

(No hay case para `microchip_revoked` que borrar — verificado en pre-research que no había case dedicado.)

**5f.** Commit: `refactor(events): fold microchip_revoked into microchip_replaced with nullable new_chip_number`.

### Paso 6 — CI coverage test + tests nuevos

**6a.** Encontrar el test de cobertura `EVENT_TYPES ↔ PayloadSchemas` (creado en el cleanup anterior, paso 1 de aquel plan). Después de los 5 commits, el test debe seguir pasando — si no, alguna entry quedó desbalanceada. Corregir hasta verde.

**6b.** Agregar tests en `lib/event-schemas.test.ts` para los 3 resolvers nuevos:

```ts
describe("foster_proposal_resolved", () => {
  it("accepts outcome=accepted with response_notes", () => { ... });
  it("accepts outcome=rejected with rejection_reason", () => { ... });
  it("accepts outcome=cancelled with cancellation_reason and auto_cancelled", () => { ... });
  it("accepts outcome=expired with only proposal_public_token", () => { ... });
  it("rejects extra keys (strict)", () => { ... });
});

describe("adoption_application_resolved", () => {
  it("accepts outcome=approved with notes only", () => { ... });
  it("accepts outcome=rejected with reason + auto_generated", () => { ... });
  it("rejects unknown outcome value", () => { ... });
});

describe("adoption_reversed", () => {
  it("accepts each actor value", () => { ... });
  it("allows reverted_finalization_event_id null", () => { ... });
});

describe("microchip_replaced (merged with revoked)", () => {
  it("accepts new_chip_number string (replacement branch)", () => { ... });
  it("accepts new_chip_number null (revocation branch)", () => { ... });
  it("accepts reason values from both legacy enums", () => { ... });
});
```

**6c.** Test nuevo de retro-compat — `__tests__/event-timeline-historical-rows.test.ts` (o el nombre que convenga al patrón del repo):

```ts
import { eventPayloadSummary } from "@/lib/format";

const RETIRED_TYPES = [
  "foster_proposal_accepted",
  "foster_proposal_rejected",
  "foster_proposal_cancelled",
  "foster_proposal_expired",
  "adoption_application_approved",
  "adoption_application_rejected",
  "adoption_revoked",
  "adoption_withdrawn",
  "libreta_shared_viewed",
  "microchip_revoked",
];

describe("eventPayloadSummary catch-all keeps historical rows readable", () => {
  for (const t of RETIRED_TYPES) {
    it(`${t} produces a non-empty string via catch-all`, () => {
      const s = eventPayloadSummary({ eventType: t, payload: {} } as any);
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    });
  }
});
```

Este test protege contra el escenario donde alguien futuro toque el catch-all y rompa el render de filas viejas.

**6d.** Commit: `test(events): coverage for phase-2 resolvers + historical-row readability regression`.

### Paso 7 — AGENTS.md refresh

**7a.** En `AGENTS.md`, encontrar la sección "Event catalog — 39 types" (línea ~455). El header está desactualizado: la const `EVENT_TYPES` tiene 48 entries hoy, no 39. Después de este plan quedan 41. Cambiar el header a **"Event catalog — 41 types"**. Si Claude Code prefiere verificarlo localmente antes de escribir, correr `grep -cE '^\s+"' db/schema.ts | head -1` sobre el bloque de la const (ajustando para que sólo cuente líneas dentro del array).

**7b.** En la lista, borrar las **10 filas** correspondientes (`foster_proposal_accepted`, `_rejected`, `_cancelled`, `_expired`, `adoption_application_approved`, `_rejected`, `adoption_revoked`, `adoption_withdrawn`, `libreta_shared_viewed`, `microchip_revoked`). Agregar 3 filas nuevas:

```
| `foster_proposal_resolved`        | v1    | `{ proposal_public_token, outcome: accepted\|rejected\|cancelled\|expired, response_notes?, rejection_reason?, cancellation_reason?, auto_cancelled? }` — umbrella event for all terminal states of the foster proposal lifecycle |
| `adoption_application_resolved`   | v1    | `{ application_event_id, reviewer_user_id, outcome: approved\|rejected, reason?, auto_generated?, notes? }` — umbrella for approve/reject decisions on adoption applications |
| `adoption_reversed`               | v1    | `{ actor: shelter\|adopter\|court, reason, reverted_finalization_event_id? }` — replaces both adoption_revoked and adoption_withdrawn |
```

Para `microchip_replaced`, reemplazar la fila existente para reflejar el shape merged:

```
| `microchip_replaced`              | v1    | `{ previous_chip_number, new_chip_number: string\|null, reason: damaged\|unreadable\|duplicate_detected\|fraud_detected\|owner_request\|device_failure\|other, replaced_by?, replaced_at, actor_role, actor_user_id?, notes? }` — `new_chip_number=null` means revocation (replaces microchip_revoked) |
```

**7c.** En la sección "Deprecated event types" (línea ~557), agregar 10 filas siguiendo el formato existente:

```
| `foster_proposal_accepted`     | Collapsed into `foster_proposal_resolved` with `outcome='accepted'` | 2026-05-19 |
| `foster_proposal_rejected`     | Collapsed into `foster_proposal_resolved` with `outcome='rejected'` | 2026-05-19 |
| `foster_proposal_cancelled`    | Collapsed into `foster_proposal_resolved` with `outcome='cancelled'` | 2026-05-19 |
| `foster_proposal_expired`      | Collapsed into `foster_proposal_resolved` with `outcome='expired'` | 2026-05-19 |
| `adoption_application_approved`| Collapsed into `adoption_application_resolved` with `outcome='approved'` | 2026-05-19 |
| `adoption_application_rejected`| Collapsed into `adoption_application_resolved` with `outcome='rejected'` | 2026-05-19 |
| `adoption_revoked`             | Collapsed into `adoption_reversed` with `actor='shelter'\|'court'` | 2026-05-19 |
| `adoption_withdrawn`           | Collapsed into `adoption_reversed` with `actor='adopter'` | 2026-05-19 |
| `libreta_shared_viewed`        | Moved out of pet_events — now lives in `share_telemetry` table | 2026-05-19 |
| `microchip_revoked`            | Folded into `microchip_replaced` with `new_chip_number=null` | 2026-05-19 |
```

(Son 10 filas: 4 foster_proposal_* + 2 adoption_application_* + 2 reversal (revoked + withdrawn) + 1 libreta + 1 microchip = 10. 48 actual - 10 + 3 = **41 final**.)

**7d.** En la sección "Pattern: umbrella event_type con discriminator" (línea ~597+), agregar al párrafo de ejemplos:

> *Aplicaciones del patrón en el catálogo: `clinical_info_logged` (sub_kind), `incident_reported` (incident_type), `foster_proposal_resolved` (outcome), `adoption_application_resolved` (outcome), `adoption_reversed` (actor), `microchip_replaced` (branch implícita por nullability de new_chip_number).*

**7e.** Commit: `docs(agents): refresh event catalog for phase-2 cleanup`.

### Paso 8 — README touch

En `docs/superpowers/README.md`, marcar este plan como done (mismo patrón que se usó en cleanups anteriores).

Commit: `docs: mark event-catalog phase-2 plan as done`.

## 5. Tests (consolidado)

Lo de Paso 6, sin novedad. `pnpm test` debe quedar verde después del Paso 6.

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Una proyección/scanner lee `event_type IN ('foster_proposal_accepted', ...)` y rompe cuando esos types salen de `EVENT_TYPES` | El type `EventType` es derivado de la const. TypeScript va a marcar como error cualquier caller que tipechee contra él. Si hay strings literales sueltos (sin tipo), el test de retro-compat del Paso 6c los preserva renderizando. Plus: la transición es de 30 minutos — durante el deploy, queries que mencionan ambos types siguen funcionando |
| Hay filas históricas con los types borrados y los timelines las muestran mal | Test 6c lo previene. `eventPayloadSummary` cae al catch-all y devuelve un string razonable. Visual smoke-test después del merge en un pet con timeline largo |
| El cron de `foster_proposal_expirer` deja proposals "colgadas" durante el deploy si se rompe el writer | Pre-deploy: parar el cron. Post-deploy: arrancar. El cron es idempotente (corre cada N minutos, no acumula) |
| `share_telemetry` queda sin RLS y un acceso indirecto la expone | No tiene endpoint público en este plan. El único writer está en `app/actions/libreta-share.ts` (server-only). Si alguna vez se expone vía API, agregar RLS en el plan que la exponga |
| El header de AGENTS.md ("39 types") no coincide con el const real (48) | Pre-research confirmó la inconsistencia. Paso 7a corrige el header al valor post-cleanup (41), no al "39 - 7". Si Claude Code encuentra el const con un count distinto a 48 (porque algún PR entre tanto agregó algo), recalcular: nuevoCount = currentCount - 10 + 3 |

## 7. Out of scope (recordatorio explícito)

- Backfill de filas históricas con los types nuevos (no se reescriben).
- RLS sobre `share_telemetry` (se diseña cuando se exponga).
- Cualquier UI nueva sobre los resolvers (cuando se construyan los flows de adoption / foster portal).
- Métricas de adopción de cada `outcome` value — out of scope de este refactor.

## 8. Commit messages (consolidado)

```
refactor(events): collapse foster_proposal_{accepted,rejected,cancelled,expired} into foster_proposal_resolved
refactor(events): collapse adoption_{revoked,withdrawn} into adoption_reversed
refactor(events): collapse adoption_application_{approved,rejected} into adoption_application_resolved
refactor(events): move libreta_shared_viewed telemetry to share_telemetry table
refactor(events): fold microchip_revoked into microchip_replaced with nullable new_chip_number
test(events): coverage for phase-2 resolvers + historical-row readability regression
docs(agents): refresh event catalog for phase-2 cleanup
docs: mark event-catalog phase-2 plan as done
```

Las 8 commits se mergean en orden. Si alguno se complica, los anteriores quedan mergeados — no hay interdependencia entre los cinco refactors de catálogo.
