# Bite reporting + 10-day rabies observation — implementation plan

> Plan ejecutable para Claude Code. Seis fases que implementan el sistema completo de reporte de mordedura → observación antirrábica de 10 días → escalación cuando hay síntomas compatibles con rabia → cierre automático negativo o manual profesional. Aprovecha la infrastructure ya implementada (`symptom_observed` matcher, libreta sanitaria, notification routing govt-scope, cron pattern).
>
> **Fecha:** 2026-05-18 (refactor 2026-05-18 post `event-catalog-cleanup`)
> **Owner:** Ignacio Del Valle
> **Tamaño:** 1 migración SQL + **2 event types nuevos** (`rabies_observation_started`, `rabies_observation_ended`) + ~4 server actions nuevos + ~6 rutas + 1 cron + 1 hook en server action existente
> **Estimación:** ~3-4 días
>
> **v1.1 nota:** los bites NO son un `event_type` propio. Viven dentro de `incident_reported` con `incident_type='bite_inflicted'`. El schema de `incident_reported` con campos bite-específicos ya está mergeado vía `event-catalog-cleanup`. Cuando esta plan diga "insert bite_inflicted", interpretar como "insert `incident_reported` con `payload.incident_type='bite_inflicted'`". Igual aplica a queries: para encontrar el bite originador del rabies_observation, filtrar por `event_type='incident_reported' AND payload->>'incident_type'='bite_inflicted'`.

---

## 0. Antes de tocar nada

Lectura obligatoria en este orden:

1. **`docs/superpowers/specs/2026-05-18-bite-rabies-observation-design.md`** — el spec del feature. Toda decisión está justificada ahí. Si encontrás algo en este plan que contradice el spec, gana el spec
2. **`docs/legal-framework-full.md` → secciones 1.2, 2.2, 3.2, 6.3** — anclaje legal. Decreto 4669/1973 PBA (10 días), Ord. CABA 41.831/1987, Res. MS 1144/2018
3. **`AGENTS.md → Libreta sanitaria`** — los tres nuevos event types son libreta. Hay que agregarlos a `LIBRETA_SANITARIA_EVENT_TYPES` en `lib/libreta-sanitaria.ts`
4. **`lib/event-schemas.ts`** — patrón Zod estricto con `payload_version`. Vas a agregar tres schemas nuevos
5. **`lib/symptoms.ts` y `lib/symptom-matcher.ts`** (ya implementados) — el matcher detecta `rabies_suspected` con specificity high. El hook de escalation se monta encima sin tocar el matcher core
6. **`app/actions/events.ts → createSymptomObservedAction`** (ya implementado) — acá va el hook de escalation. Verificá la firma actual para no romper el contrato existente
7. **`scripts/materialize-slots.ts`** y **`app/api/cron/materialize-slots/route.ts`** — patrón de cron + script idempotent que vas a replicar para el cron de cierre de observación
8. **`lib/projections/pet-status.ts`** y similares — patrón de projections para escribir `pet-rabies-observation.ts` (re-derivable de events)
9. **`app/actions/intake.ts` o similar** que ya implemente capability checks — patrón de `requireCapability('xxx')` para agregar `bite.report`

**Antes de empezar**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` verdes en main. Si hay rojos pre-existentes, parar y avisar a Nacho.

## 1. Qué construye este plan

Seis fases secuenciales:

**Fase 0 — Schema foundation.** Migración SQL: extender `EVENT_TYPES` con tres valores, agregar columna `pets.rabies_observation_status` con CHECK, agregar índice partial. Zod schemas para los tres events nuevos. Extender `LIBRETA_SANITARIA_EVENT_TYPES`. Capability `bite.report`. Notification types nuevos documentados.

**Fase 1 — Owner reporting + UI.** Server action `reportBiteAction` (owner-initiated), `ownerCloseRabiesObservationAction`. Rutas `/mis-mascotas/{token}/eventos/nuevo/mordedura` y banner de observación en el perfil. Reminder linkeado.

**Fase 2 — Surveillance escalation hook.** Modificar `createSymptomObservedAction` para detectar `rabies_observation_status='in_progress'` + `rabies_suspected` high-spec → escalation a `urgent` + notification al owner.

**Fase 3 — Cron de auto-cierre.** Script `scripts/close-rabies-observations.ts` + cron route. Idempotent. Auto-cierra solo si no hubo escalating symptoms; notifica govt para review si sí.

**Fase 4 — Org-side reporting.** Ruta `/org/{orgToken}/mordedura/nuevo` para vets/shelters que reportan bite presenciado. Capability check `bite.report`.

**Fase 5 — Death-during-observation hook.** Modificar el server action de `death_recorded` para auto-cerrar la observación con outcome `dead`, agregar flag al payload, escalada.

**Fase 6 — Govt/admin surfaces.** `/gob/incidentes`, `/gob/observaciones`, `/admin/observaciones`. Depende de admin page Fase 0 para tener routing real a govts. Hasta entonces, las notifications van a admins via fallback (mismo patrón que symptom-surveillance).

## 2. Decisiones cerradas (resumen del spec — NO relitigar)

| # | Decisión | Sección spec |
|---|---|---|
| D1 | Período exactamente 10 días, sin configurar | §2 D1 |
| D2 | Tres event types: `bite_inflicted`, `rabies_observation_started`, `rabies_observation_ended`. Todos libreta-sanitaria | §2 D2 |
| D3 | `rabies_observation_started` se emite **atómicamente** con `bite_inflicted` | §2 D3 |
| D4 | Columna `pets.rabies_observation_status` denormalizada, dual-write, re-derivable | §2 D4 |
| D5 | Surveillance escalation: durante observación activa + `rabies_suspected` high-spec → severity `urgent` + owner ve el nudge (excepción a D1 del symptom-surveillance) | §2 D5 |
| D6 | Notification routing reusa `findAuthoritiesForJurisdiction` | §2 D6 |
| D7 | Cron diario chequea vencimientos; auto-cierra solo en happy path | §2 D7 |
| D8 | Si hubo escalating symptoms, NO auto-cierre. Notifica govt para review humana | §2 D8 |
| D9 | Muerte durante observación = escalada máxima + auto-cierre con outcome=`dead` | §2 D9 |
| D10 | Owner cierra solo `negative`. Vet/govt pueden cerrar con cualquier outcome | §2 D11 |
| D11 | Snapshot `rabies_vaccine_valid_at_bite` computado al insertar | §2 D13 |
| D12 | Operación atómica: bite + rabies_observation_started + notification owner; notifications a authorities son defensive | §2 D14 |

## 3. Scope

**Dentro:**
- 1 migración SQL extendiendo `EVENT_TYPES` y agregando columna a `pets` + índice
- 3 Zod schemas nuevos en `lib/event-schemas.ts`
- Update de `lib/libreta-sanitaria.ts` agregando los 3 events a `LIBRETA_SANITARIA_EVENT_TYPES`
- Capability `bite.report` agregada al registry
- 4 server actions nuevas (`reportBiteAction`, `ownerCloseRabiesObservationAction`, `vetCloseRabiesObservationAction`, `reportBiteFromOrgAction`)
- Hook en `createSymptomObservedAction` existente (escalation)
- Hook en el server action que inserta `death_recorded` (auto-cierre dead)
- 1 script + 1 cron route para auto-cierre nocturno
- 1 projection nueva (`pet-rabies-observation.ts`) para re-derivar de events
- ~6 rutas nuevas
- Tests por fase

**Fuera (deferred per spec §11):**
- Atestación profesional de in-situ vs sede oficial (campo schema existe, no se valida operativamente)
- Vaccination follow-up automático post-observación
- Reporte a sistemas externos (SIVILA, Pasteur, SISA-Salud)
- Multi-bite incidents en un solo event (uno por víctima por ahora)
- Cuarentena preventiva sin bite
- Apelación / disputa del bite report (puede agregarse via `note_added`)
- Cross-match de víctima humana con usuarios DIM
- Dashboards epidemiológicos de govt (esa es feature de `/gob/dashboards`, separate)
- Re-observation por bite múltiple dentro del período

## 4. Plan paso a paso

### Fase 0 — Schema foundation

#### Paso 0.1 — Migración SQL

Crear `db/migrations/NNNN_bite_rabies_observation.sql` (NNNN según orden actual):

```sql
-- Bite reporting + 10-day rabies observation foundation
-- Anchored in Decreto 4669/1973 (PBA), Ord. CABA 41.831/1987,
-- Res. MS 1144/2018.

-- 1) Add denormalized column to pets for fast queries.
-- Valid values when not null: in_progress | completed_negative |
--   completed_positive_rabies | completed_dead | completed_lost_to_followup
alter table public.pets
  add column if not exists rabies_observation_status text;

alter table public.pets
  add constraint pets_rabies_observation_status_valid
  check (
    rabies_observation_status is null
    or rabies_observation_status in (
      'in_progress',
      'completed_negative',
      'completed_positive_rabies',
      'completed_dead',
      'completed_lost_to_followup'
    )
  );

-- Partial index for the cron that scans active observations daily.
create index if not exists pets_rabies_observation_in_progress_idx
  on public.pets (rabies_observation_status)
  where rabies_observation_status = 'in_progress';

-- Comments
comment on column public.pets.rabies_observation_status is
  '10-day rabies observation lifecycle state (per Decreto 4669/1973 PBA). null = no active observation. Dual-written from server actions, re-derivable from pet_events via lib/projections/pet-rabies-observation.ts.';

-- Reverse (documented, not executed):
-- alter table public.pets drop column rabies_observation_status;
-- drop index if exists pets_rabies_observation_in_progress_idx;
```

Aplicar via Supabase Studio (NO `pnpm db:push`).

#### Paso 0.2 — Extender `EVENT_TYPES` en `db/schema.ts`

Agregar al array de `EVENT_TYPES`:

```ts
"bite_inflicted",
"rabies_observation_started",
"rabies_observation_ended",
```

#### Paso 0.3 — Drizzle: agregar la columna a `pets` model

```ts
rabiesObservationStatus: text("rabies_observation_status"),
```

Y exportarlo en el infer type.

#### Paso 0.4 — Zod schemas en `lib/event-schemas.ts`

Copiar exactamente las 3 schemas del spec §4.2:

```ts
const biteInflicted = z
  .object(
    withVersion({
      occurred_at: z.string(),
      location_description: z.string().nullable(),
      victim_kind: z.enum(["human", "animal", "unknown"]),
      victim_contact_name: z.string().nullable(),
      victim_contact_phone: z.string().nullable(),
      victim_pet_id: z.string().uuid().nullable(),
      victim_age_estimate: z.string().nullable(),
      severity: z.enum(["minor", "moderate", "severe"]),
      context: z.string().nullable(),
      rabies_vaccine_valid_at_bite: z.boolean(),
      reporter_role: z.enum(["owner", "vet", "shelter", "govt", "witness"]),
    }),
  )
  .strict();

const rabiesObservationStarted = z
  .object(
    withVersion({
      bite_event_id: z.string().uuid(),
      observation_until: z.string(),
      location: z.enum(["in_situ", "official_site"]),
      official_site_organization_id: z.string().uuid().nullable(),
    }),
  )
  .strict();

const rabiesObservationEnded = z
  .object(
    withVersion({
      bite_event_id: z.string().uuid(),
      observation_started_event_id: z.string().uuid(),
      outcome: z.enum([
        "negative",
        "positive_rabies",
        "dead",
        "lost_to_followup",
      ]),
      closed_by_role: z.enum(["owner", "vet", "govt", "admin", "system"]),
      closure_notes: z.string().nullable(),
      death_event_id: z.string().uuid().nullable(),
    }),
  )
  .strict();
```

Registrarlas en `PayloadSchemas` record.

**También extender el Zod schema existente de `death_recorded`** para aceptar el nuevo flag opcional `during_rabies_observation: z.boolean().optional()`. Backwards-compatible (optional).

#### Paso 0.5 — Extender `lib/libreta-sanitaria.ts`

En la const `LIBRETA_SANITARIA_EVENT_TYPES`, agregar los tres:

```ts
"bite_inflicted",
"rabies_observation_started",
"rabies_observation_ended",
```

El test de cobertura (`lib/libreta-sanitaria.test.ts`) probablemente checa que TODO event_type esté clasificado. Si ese test rompe al agregar los tres, también tenés que clasificarlos como libreta para que pase.

#### Paso 0.6 — Capability `bite.report`

En `lib/capabilities.ts`, agregar `"bite.report"` al enum/catalog de capabilities. Asignarla a roles `admin` y `coordinator` y `vet_individual` de organization_memberships (vets de la clínica reportan bites presenciados; coordinators de refugio idem). NO a `volunteer` (un voluntario no carga un evento médico oficial).

#### Paso 0.7 — Constants

Crear (o agregar a existing) `lib/rabies-observation.ts`:

```ts
// Hardcoded per Decreto 4669/1973 (PBA), Ord. CABA 41.831/1987,
// Res. MS 1144/2018. If any jurisdiction changes this, update here.
export const RABIES_OBSERVATION_DAYS = 10;

export type RabiesObservationStatus =
  | "in_progress"
  | "completed_negative"
  | "completed_positive_rabies"
  | "completed_dead"
  | "completed_lost_to_followup";

export function computeObservationUntil(biteOccurredAt: Date): Date {
  const due = new Date(biteOccurredAt);
  due.setDate(due.getDate() + RABIES_OBSERVATION_DAYS);
  return due;
}
```

#### Paso 0.8 — Tests del schema

Tests Vitest cubriendo:
- Zod accepts valid payload for each of the 3 new events
- Zod rejects missing required fields
- `pet.rabies_observation_status` CHECK constraint rejects invalid values (probarlo con SQL directo en setup de test integration)
- `computeObservationUntil(2026-05-18)` retorna `2026-05-28`

#### Acceptance Fase 0

- `pnpm typecheck` cero errores
- `pnpm lint` cero errores nuevos
- `pnpm test` todos verdes (los 3 schemas nuevos pasan, libreta cobertura sigue OK)
- `pnpm build` compila
- En Studio: `SELECT rabies_observation_status FROM pets LIMIT 1` retorna NULL para filas existentes (ningún backfill — observación arranca null)

#### Commit Fase 0

```
feat(bite): schema foundation — 3 new event types + pets observation status

Adds bite_inflicted, rabies_observation_started, rabies_observation_ended
to EVENT_TYPES with their Zod schemas. All three classified as libreta
sanitaria events (the vet of the future needs the full clinical history).

Adds pets.rabies_observation_status text column with CHECK constraint
covering the 5 valid states (null + 4 lifecycle states + 1 edge state).
Partial index pets_rabies_observation_in_progress_idx accelerates the
cron sweep.

Anchored in Decreto 4669/1973 (PBA), Ordenanza CABA 41.831/1987,
Resolución MS 1144/2018. RABIES_OBSERVATION_DAYS=10 is hardcoded.

Capability bite.report added for vet/coordinator members in org context.

See docs/superpowers/specs/2026-05-18-bite-rabies-observation-design.md.
```

---

### Fase 1 — Owner reporting + UI

#### Paso 1.1 — `reportBiteAction` server action

Crear `app/actions/bite.ts`:

```ts
"use server";

import { db, notifications, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/event-schemas";
import { requireOwnedPetByToken } from "@/lib/pets";
import { findAuthoritiesForJurisdiction } from "@/lib/notifications-routing"; // existing from scheduling/surveillance
import { computeObservationUntil } from "@/lib/rabies-observation";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type BiteFormState = { error: string | null };

export async function reportBiteAction(
  petPublicToken: string,
  _prev: BiteFormState,
  formData: FormData,
): Promise<BiteFormState> {
  const session = await requireOwnedPetByToken(petPublicToken);
  if (!session) return { error: "Sin permisos." };
  const { pet, user } = session;

  // Block if pet is already in observation
  if (pet.rabiesObservationStatus === "in_progress") {
    return { error: "Esta mascota ya está en observación antirrábica por otra mordedura." };
  }

  // Parse form
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha del incidente inválida." };
  if (occurredAt > new Date()) return { error: "La fecha no puede ser futura." };

  const locationDescription = String(formData.get("locationDescription") ?? "").trim() || null;
  const victimKindRaw = String(formData.get("victimKind") ?? "");
  if (!["human", "animal", "unknown"].includes(victimKindRaw)) return { error: "Tipo de víctima inválido." };
  const victimKind = victimKindRaw as "human" | "animal" | "unknown";

  const severityRaw = String(formData.get("severity") ?? "");
  if (!["minor", "moderate", "severe"].includes(severityRaw)) return { error: "Severidad inválida." };
  const severity = severityRaw as "minor" | "moderate" | "severe";

  // Compute rabies_vaccine_valid_at_bite
  const [latestAntirabies] = await db
    .select()
    .from(petEvents)
    .where(and(
      eq(petEvents.petId, pet.id),
      eq(petEvents.eventType, "vaccination_administered"),
      sql`payload->>'vaccine_name' ILIKE '%antirr%bica%' OR payload->>'vaccine_name' ILIKE '%rabies%'`,
    ))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  let rabiesVaccineValidAtBite = false;
  if (latestAntirabies) {
    const payload = latestAntirabies.payload as Record<string, unknown>;
    const nextDueAt = payload.next_due_at;
    if (typeof nextDueAt === "string") {
      const due = new Date(nextDueAt);
      if (Number.isFinite(due.getTime()) && due > occurredAt) {
        rabiesVaccineValidAtBite = true;
      }
    } else {
      // If no next_due_at, assume valid for 1 year from administered date
      const administered = new Date(latestAntirabies.occurredAt);
      const oneYearLater = new Date(administered);
      oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
      if (oneYearLater > occurredAt) rabiesVaccineValidAtBite = true;
    }
  }

  const now = new Date();
  const observationUntil = computeObservationUntil(occurredAt);

  try {
    await db.transaction(async (tx) => {
      // 1. Insert bite_inflicted
      const bitePayload = validateEventPayload("bite_inflicted", {
        occurred_at: occurredAt.toISOString(),
        location_description: locationDescription,
        victim_kind: victimKind,
        victim_contact_name: String(formData.get("victimContactName") ?? "").trim() || null,
        victim_contact_phone: String(formData.get("victimContactPhone") ?? "").trim() || null,
        victim_pet_id: String(formData.get("victimPetId") ?? "").trim() || null,
        victim_age_estimate: String(formData.get("victimAgeEstimate") ?? "").trim() || null,
        severity,
        context: String(formData.get("context") ?? "").trim() || null,
        rabies_vaccine_valid_at_bite: rabiesVaccineValidAtBite,
        reporter_role: "owner",
      });
      const [biteEvent] = await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "bite_inflicted",
        occurredAt,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "owner",
        payload: bitePayload,
      }).returning();

      // 2. Insert rabies_observation_started
      const obsPayload = validateEventPayload("rabies_observation_started", {
        bite_event_id: biteEvent.id,
        observation_until: observationUntil.toISOString(),
        location: "in_situ",
        official_site_organization_id: null,
      });
      const [obsEvent] = await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "rabies_observation_started",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "owner",
        payload: obsPayload,
      }).returning();

      // 3. UPDATE pets.rabies_observation_status
      await tx.update(pets)
        .set({ rabiesObservationStatus: "in_progress", updatedAt: now })
        .where(eq(pets.id, pet.id));

      // 4. Notify owner
      await tx.insert(notifications).values({
        userId: user.id,
        notificationType: "rabies_observation_started_owner",
        severity: "warning",
        title: `Observación antirrábica iniciada — ${pet.name}`,
        body: `Por la mordedura del ${occurredAt.toLocaleDateString("es-AR")}, ${pet.name} entra en observación antirrábica de 10 días. ` +
              `Cierre estimado: ${observationUntil.toLocaleDateString("es-AR")}. ` +
              `Si ves síntomas raros (salivación excesiva, agresividad inusual, parálisis, cambio de comportamiento), consultá al vet de inmediato.`,
        relatedPetId: pet.id,
        relatedEventId: obsEvent.id,
        ctaLabel: "Ver detalle",
        ctaUrl: `/mis-mascotas/${pet.publicToken}`,
      });

      // 5. Notify authorities (defensive — failure does NOT rollback the bite)
      try {
        const authorities = await findAuthoritiesForJurisdiction({
          province: pet.jurisdictionProvince,
          locality: pet.jurisdictionLocality,
        });
        for (const authority of authorities) {
          await tx.insert(notifications).values({
            userId: authority.userId,
            notificationType: "bite_reported_authority",
            severity: severity === "severe" ? "urgent" : "warning",
            title: `Mordedura reportada — ${pet.name} (${pet.species})`,
            body: `Reportada por dueño. Víctima: ${victimKind}. Severidad: ${severity}. ` +
                  `Antirrábica vigente al momento: ${rabiesVaccineValidAtBite ? "sí" : "NO"}. ` +
                  `Observación 10 días iniciada.`,
            relatedPetId: pet.id,
            relatedEventId: obsEvent.id,
          });
        }
      } catch (err) {
        console.error("[bite] authority notification failed:", err);
        // Continue — bite is reported regardless
      }
    });
  } catch (err) {
    console.error("[bite] reportBiteAction failed:", err);
    return { error: `No se pudo reportar la mordedura: ${err instanceof Error ? err.message : "error desconocido"}` };
  }

  revalidatePath(`/mis-mascotas/${petPublicToken}`);
  redirect(`/mis-mascotas/${petPublicToken}?evento=mordedura_reportada`);
}
```

#### Paso 1.2 — `ownerCloseRabiesObservationAction`

En el mismo archivo:

```ts
export async function ownerCloseRabiesObservationAction(
  petPublicToken: string,
): Promise<{ error: string | null }> {
  const session = await requireOwnedPetByToken(petPublicToken);
  if (!session) return { error: "Sin permisos." };
  const { pet, user } = session;

  if (pet.rabiesObservationStatus !== "in_progress") {
    return { error: "No hay observación activa que cerrar." };
  }

  // Find the active rabies_observation_started event
  const [startedEvent] = await db.select()
    .from(petEvents)
    .where(and(
      eq(petEvents.petId, pet.id),
      eq(petEvents.eventType, "rabies_observation_started"),
    ))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);
  if (!startedEvent) return { error: "Inconsistencia interna: status in_progress sin evento started." };

  const startedPayload = startedEvent.payload as Record<string, unknown>;
  const observationUntil = new Date(startedPayload.observation_until as string);
  const now = new Date();

  if (now < observationUntil) {
    return { error: `Aún no se cumplieron los 10 días. Esperá hasta el ${observationUntil.toLocaleDateString("es-AR")}.` };
  }

  // Check for escalating symptoms during observation
  const escalating = await db.select()
    .from(petEvents)
    .where(and(
      eq(petEvents.petId, pet.id),
      eq(petEvents.eventType, "symptom_observed"),
      gte(petEvents.occurredAt, startedEvent.occurredAt),
      sql`payload->'alerted_disease_codes' @> '"rabies_suspected"'::jsonb`,
    ));

  if (escalating.length > 0) {
    return {
      error: "Hubo síntomas compatibles con rabia durante la observación. Este cierre requiere intervención profesional (vet o autoridad sanitaria). Contactá a tu veterinario.",
    };
  }

  // Happy path: close as negative
  try {
    await db.transaction(async (tx) => {
      const endedPayload = validateEventPayload("rabies_observation_ended", {
        bite_event_id: startedPayload.bite_event_id,
        observation_started_event_id: startedEvent.id,
        outcome: "negative",
        closed_by_role: "owner",
        closure_notes: "Cerrado por dueño tras cumplirse los 10 días sin síntomas",
        death_event_id: null,
      });
      await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "rabies_observation_ended",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "owner",
        payload: endedPayload,
      });
      await tx.update(pets)
        .set({ rabiesObservationStatus: "completed_negative", updatedAt: now })
        .where(eq(pets.id, pet.id));
      await tx.insert(notifications).values({
        userId: user.id,
        notificationType: "rabies_observation_completed_negative_owner",
        severity: "success",
        title: `Observación completada — ${pet.name}`,
        body: `La observación antirrábica de 10 días por la mordedura terminó sin incidentes. ${pet.name} sigue normal.`,
        relatedPetId: pet.id,
      });
    });
  } catch (err) {
    return { error: `Error al cerrar: ${err instanceof Error ? err.message : ""}` };
  }

  revalidatePath(`/mis-mascotas/${petPublicToken}`);
  return { error: null };
}
```

#### Paso 1.3 — Routes

Crear `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/page.tsx` y `BiteForm.tsx`:

```tsx
// page.tsx — server component
import { reportBiteAction } from "@/app/actions/bite";
import { requireOwnedPetByToken } from "@/lib/pets";
import { BiteForm } from "./BiteForm";

export default async function NewBitePage({ params }: { params: Promise<{ publicToken: string }> }) {
  const { publicToken } = await params;
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return null;
  const { pet } = session;

  if (pet.rabiesObservationStatus === "in_progress") {
    return <main className="...">
      <p>Esta mascota ya está en observación por otra mordedura. Esperá al cierre antes de reportar una nueva.</p>
    </main>;
  }

  const boundAction = reportBiteAction.bind(null, publicToken);

  return (
    <main className="...">
      <h1>Reportar mordedura</h1>
      <p className="text-sm">
        Reportar una mordedura inicia un período de observación obligatorio de 10 días por ley.
      </p>
      <BiteForm action={boundAction} petName={pet.name} />
    </main>
  );
}
```

`BiteForm.tsx` (client component) tiene:
- Date picker para `occurredAt` (max hoy, default hoy)
- Text input para `locationDescription`
- Radio para `victimKind` (human / animal / unknown)
- Conditional fields según victim_kind:
  - Si human: nombre opcional, teléfono opcional, edad estimada opcional
  - Si animal: opción "está en DIM" con search, o text libre
- Radio para `severity` (minor/moderate/severe) con tooltips de qué significa cada uno
- Textarea para `context`
- **Checkbox de confirmación obligatorio**: "Entiendo que esto inicia un período de observación obligatorio de 10 días"
- Submit button

#### Paso 1.4 — Banner en pet profile

En `app/(app)/mis-mascotas/[publicToken]/page.tsx`, detectar `pet.rabiesObservationStatus`:

```tsx
{pet.rabiesObservationStatus === "in_progress" && (
  <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-2">
    <p className="font-medium text-amber-900">Observación antirrábica en curso</p>
    <p className="text-sm text-amber-800">
      Por la mordedura reportada el {biteDate}, {pet.name} está en observación obligatoria de 10 días.
      Cierre estimado: {observationUntil}.
    </p>
    {now > observationUntil && (
      <form action={ownerCloseRabiesObservationAction.bind(null, pet.publicToken)}>
        <button type="submit" className="...">Confirmar fin de observación</button>
      </form>
    )}
    <p className="text-xs text-amber-700">
      Si {pet.name} muestra síntomas raros (salivación excesiva, agresividad inusual, parálisis),
      consultá al vet de inmediato.
    </p>
  </section>
)}
```

#### Paso 1.5 — Link al form desde /eventos/nuevo

En la selectora de eventos (`/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx`), agregar entrada "Reportar mordedura" en la sección apropiada (probablemente "Otros registros" o nueva sección "Incidentes").

#### Paso 1.6 — Tests

Tests cubriendo:
- Reportar bite atómicamente inserta dos events + actualiza pet status
- Reportar bite cuando ya está in_progress retorna error
- Reportar bite con fecha futura retorna error
- `rabies_vaccine_valid_at_bite` se computa correctamente con vacuna vigente
- `rabies_vaccine_valid_at_bite=false` cuando no hay antirábica registrada
- ownerCloseRabiesObservationAction bloquea si no pasaron 10 días
- ownerCloseRabiesObservationAction bloquea si hubo escalating symptoms
- ownerCloseRabiesObservationAction happy path actualiza status y emite event

#### Commit Fase 1

```
feat(bite): owner can report bite and close observation manually

reportBiteAction atomically inserts bite_inflicted + rabies_observation_started
events, updates pets.rabies_observation_status='in_progress', notifies owner
with start-of-period instructions, and routes notifications to authorities
(defensive — bite is recorded regardless of authority notification success).

Snapshots rabies_vaccine_valid_at_bite from the most recent
vaccination_administered event with vaccine_name matching antirrábica
(case-insensitive).

ownerCloseRabiesObservationAction allows the owner to confirm end of
observation as 'negative' after 10 days, IF there were no escalating
symptoms during the period. Otherwise blocks with clear message that
professional closure (vet/govt) is required.

UI: new /mis-mascotas/{token}/eventos/nuevo/mordedura route, banner on pet
profile, link from event creation selector.
```

---

### Fase 2 — Surveillance escalation hook

#### Paso 2.1 — Localizar el server action de `symptom_observed`

Buscar `createSymptomObservedAction` en `app/actions/events.ts` (o donde esté). Identificá:
- Dónde se invoca el matcher (`detectAlertableDiseases`)
- Dónde se inserta el `outbreak_signal` event
- Dónde se invoca `routeOutbreakSignalNotification` (o equivalente)

#### Paso 2.2 — Agregar el hook

Antes de emitir el `outbreak_signal`, chequear la observación:

```ts
// existing: detect alertable diseases
const alertableDiseases = detectAlertableDiseases(freeText, pet.species);

// NEW: escalation check
const isRabiesEscalation = (
  pet.rabiesObservationStatus === "in_progress" &&
  alertableDiseases.some(d =>
    d.disease_code === "rabies_suspected" &&
    d.high_count >= 1
  )
);

// ... when inserting the outbreak_signal:
// for each alertableDisease:
//   if (disease.disease_code === "rabies_suspected" && isRabiesEscalation) {
//     signalSeverity = "urgent";
//     signalPayload.bite_observation_active = true;
//   } else {
//     signalSeverity = "warning";
//   }
```

Y al final, si fue escalation, agregar UNA notification adicional al owner:

```ts
if (isRabiesEscalation) {
  await tx.insert(notifications).values({
    userId: user.id, // the owner
    notificationType: "rabies_observation_escalation_owner",
    severity: "urgent",
    title: `URGENTE — posible signo de rabia en ${pet.name}`,
    body: `Durante el período de observación antirrábica, registraste síntomas compatibles con rabia. ` +
          `CONSULTÁ AL VETERINARIO INMEDIATAMENTE. ` +
          `Si no podés, andá al dispensario antirrábico más cercano o llamá al 107.`,
    relatedPetId: pet.id,
    ctaLabel: "Ver mascota",
    ctaUrl: `/mis-mascotas/${pet.publicToken}`,
  });

  // Authority notification severity is also bumped to urgent (already routed
  // via the existing surveillance flow, but the severity in the existing
  // Notification insert should be 'urgent' when isRabiesEscalation).
}
```

#### Paso 2.3 — Extender el Zod schema de `outbreak_signal`

Agregar campo opcional al payload schema:

```ts
const outbreakSignal = z
  .object(
    withVersion({
      // ... existing fields
      bite_observation_active: z.boolean().optional(), // NEW
    }),
  )
  .strict();
```

#### Paso 2.4 — Tests

Tests cubriendo:
- `symptom_observed` con rabia high-spec + pet NO en observación → severity warning, no urgent escalation notification al owner
- `symptom_observed` con rabia high-spec + pet en observación → severity urgent, owner recibe escalation notification
- `symptom_observed` con otro disease + pet en observación → severity warning (no escalation, no es rabia)
- `symptom_observed` con rabia medium-spec + pet en observación → no escalation (D5 dice high specificity, no medium)

#### Commit Fase 2

```
feat(bite): escalate rabies-suspected symptoms during observation

Modifies createSymptomObservedAction to detect when pet is in active
rabies observation (pet.rabies_observation_status='in_progress') AND
the matcher returned rabies_suspected with high_count >= 1. In that
case:

1. The outbreak_signal severity bumps from 'warning' to 'urgent'.
2. The signal payload carries bite_observation_active=true for downstream
   filtering by authority dashboards.
3. The owner receives an extra notification with severity='urgent' and
   copy "consultá al veterinario inmediatamente" — explicit exception to
   the symptom-surveillance D1 (owner sees no diagnoses), justified by
   the concrete public-health risk: bite victim exists, 10-day window,
   PEP timing critical.

Extends the outbreak_signal Zod schema with bite_observation_active
as optional bool (back-compat).
```

---

### Fase 3 — Cron de auto-cierre

#### Paso 3.1 — Script

Crear `scripts/close-rabies-observations.ts`:

```ts
import { db, notifications, petEvents, pets } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/notifications-routing";
import { validateEventPayload } from "@/lib/event-schemas";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

async function main() {
  const now = new Date();

  // Find pets in observation
  const eligible = await db.select()
    .from(pets)
    .where(eq(pets.rabiesObservationStatus, "in_progress"));

  console.log(`[close-rabies] checking ${eligible.length} pets in observation`);

  for (const pet of eligible) {
    // Find the latest rabies_observation_started event
    const [startedEvent] = await db.select()
      .from(petEvents)
      .where(and(
        eq(petEvents.petId, pet.id),
        eq(petEvents.eventType, "rabies_observation_started"),
      ))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);

    if (!startedEvent) {
      console.warn(`[close-rabies] pet ${pet.publicToken}: in_progress but no started event found`);
      continue;
    }

    const startedPayload = startedEvent.payload as Record<string, unknown>;
    const observationUntil = new Date(startedPayload.observation_until as string);
    if (observationUntil > now) continue; // period not yet over

    // Check for escalating symptom_observed events during the period
    const escalating = await db.select()
      .from(petEvents)
      .where(and(
        eq(petEvents.petId, pet.id),
        eq(petEvents.eventType, "symptom_observed"),
        gte(petEvents.occurredAt, startedEvent.occurredAt),
        sql`payload->'alerted_disease_codes' @> '"rabies_suspected"'::jsonb`,
      ));

    if (escalating.length > 0) {
      console.log(`[close-rabies] pet ${pet.publicToken}: HAS escalating symptoms, blocking auto-close`);

      // Notify authorities about pending review
      try {
        const authorities = await findAuthoritiesForJurisdiction({
          province: pet.jurisdictionProvince,
          locality: pet.jurisdictionLocality,
        });
        for (const authority of authorities) {
          await db.insert(notifications).values({
            userId: authority.userId,
            notificationType: "rabies_observation_pending_review",
            severity: "urgent",
            title: `Observación vencida pendiente de revisión — ${pet.name}`,
            body: `El período de 10 días terminó pero hubo síntomas escalables. Cierre profesional requerido.`,
            relatedPetId: pet.id,
          });
        }
      } catch (err) {
        console.error("[close-rabies] authority notification failed:", err);
      }
      continue;
    }

    // Happy path: close as negative
    console.log(`[close-rabies] pet ${pet.publicToken}: auto-closing as negative`);
    try {
      await db.transaction(async (tx) => {
        const endedPayload = validateEventPayload("rabies_observation_ended", {
          bite_event_id: startedPayload.bite_event_id,
          observation_started_event_id: startedEvent.id,
          outcome: "negative",
          closed_by_role: "system",
          closure_notes: "Auto-cerrado tras 10 días sin síntomas escalables",
          death_event_id: null,
        });
        await tx.insert(petEvents).values({
          petId: pet.id,
          eventType: "rabies_observation_ended",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: null,
          authorRole: "system",
          payload: endedPayload,
        });
        await tx.update(pets)
          .set({ rabiesObservationStatus: "completed_negative", updatedAt: now })
          .where(eq(pets.id, pet.id));

        // Find owner to notify
        const [ownership] = await tx.select()
          .from(ownerships)
          .where(and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)))
          .limit(1);

        if (ownership?.ownerUserId) {
          await tx.insert(notifications).values({
            userId: ownership.ownerUserId,
            notificationType: "rabies_observation_completed_negative_owner",
            severity: "success",
            title: `Observación completada — ${pet.name}`,
            body: `La observación antirrábica de 10 días terminó automáticamente sin incidentes. ${pet.name} sigue normal.`,
            relatedPetId: pet.id,
          });
        }
      });
    } catch (err) {
      console.error(`[close-rabies] pet ${pet.publicToken}: auto-close failed:`, err);
    }
  }

  console.log(`[close-rabies] done`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Agregar al `package.json`:
```json
"close-rabies-observations": "tsx scripts/close-rabies-observations.ts",
```

#### Paso 3.2 — Cron route

Crear `app/api/cron/close-rabies-observations/route.ts` (mismo patrón que `materialize-slots`):

```ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  await closeAllEligibleObservations(); // extract main logic into reusable function
  return NextResponse.json({ ok: true });
}
```

Configurar en `vercel.json` cron schedule:
```json
{
  "path": "/api/cron/close-rabies-observations",
  "schedule": "0 3 * * *"
}
```

#### Paso 3.3 — Tests

```ts
describe("auto-close rabies observations", () => {
  it("auto-closes as negative when 10 days passed and no escalating symptoms", async () => { ... });
  it("does NOT auto-close if observation period is not over", async () => { ... });
  it("BLOCKS auto-close when escalating symptom_observed exists", async () => { ... });
  it("notifies authorities about pending review when blocked", async () => { ... });
  it("notifies owner with success when auto-closes", async () => { ... });
  it("is idempotent — second run does not re-emit events", async () => { ... });
});
```

#### Commit Fase 3

```
feat(bite): cron auto-close of rabies observations after 10 days

scripts/close-rabies-observations.ts and /api/cron/close-rabies-observations
run daily at 3am AR. For each pet with rabies_observation_status='in_progress':

1. Find the active rabies_observation_started event
2. Check observation_until <= now
3. Query for symptom_observed events during the period with
   alerted_disease_codes containing 'rabies_suspected'
4. If escalating symptoms exist → block auto-close, notify authorities
   for review with severity='urgent'
5. Otherwise → auto-close as negative, emit rabies_observation_ended
   with closed_by_role='system', update pets.rabies_observation_status,
   notify owner with severity='success'

Idempotent. Cron secret-protected. Logs grep-friendly per pet.
```

---

### Fase 4 — Org-side reporting

#### Paso 4.1 — `reportBiteFromOrgAction`

Mismo shape que `reportBiteAction` pero:
- `requireCapability("bite.report")` en lugar de owner-only check
- Recibe `petPublicToken` desde el path
- `reporter_role: "vet" | "shelter"` según el `org_type` de la org del actor
- `authorRole` y `authorOrganizationId` settear correctamente en el event insert

Crear en `app/actions/bite.ts` (mismo archivo) o split en `org-bite.ts` si preferís separar.

#### Paso 4.2 — Routes en `/org/[orgToken]/mordedura/`

```
/org/[orgToken]/mordedura/nuevo
  → form de búsqueda de pet (por publicToken o por listado de pets recientes)
  → seleccionar pet → form similar al de owner
  → submit → reportBiteFromOrgAction
```

#### Paso 4.3 — Tests

Cubrir capability check + flujo end-to-end + el caso "pet de otro owner".

#### Commit Fase 4

```
feat(bite): org-side bite reporting for vets and shelters

Vets/shelters with bite.report capability can report bites they
witnessed or learned about clinically. Same atomic transaction as
owner-side (bite_inflicted + rabies_observation_started + notifications),
but author_role='vet'|'shelter' and author_organization_id set per
the actor's active membership.

New route /org/{orgToken}/mordedura/nuevo with pet search + bite form.
Owner of the pet is notified with severity='warning'.
```

---

### Fase 5 — Death-during-observation hook

#### Paso 5.1 — Localizar el server action de `death_recorded`

Buscar dónde se inserta `death_recorded` (probablemente `setPetDeceasedAction` o equivalente en `app/actions/events.ts`).

#### Paso 5.2 — Agregar el hook

Antes del commit de la transaction que inserta `death_recorded`:

```ts
if (pet.rabiesObservationStatus === "in_progress") {
  // Find the active observation
  const [startedEvent] = await tx.select()
    .from(petEvents)
    .where(and(
      eq(petEvents.petId, pet.id),
      eq(petEvents.eventType, "rabies_observation_started"),
    ))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  if (startedEvent) {
    // Insert rabies_observation_ended with outcome=dead
    const endedPayload = validateEventPayload("rabies_observation_ended", {
      bite_event_id: (startedEvent.payload as any).bite_event_id,
      observation_started_event_id: startedEvent.id,
      outcome: "dead",
      closed_by_role: "system",
      closure_notes: "Cierre automático por fallecimiento durante observación",
      death_event_id: deathEvent.id, // assuming deathEvent was just inserted
    });
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "rabies_observation_ended",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: user.id,
      authorRole: "system",
      payload: endedPayload,
    });
    await tx.update(pets)
      .set({ rabiesObservationStatus: "completed_dead", updatedAt: now })
      .where(eq(pets.id, pet.id));

    // Add flag to death_recorded payload
    // (the death_event was just inserted; if you can update its payload pre-commit, do so;
    //  otherwise persist the during_rabies_observation flag in a follow-up update within the tx)

    // Urgent escalation to authorities
    const authorities = await findAuthoritiesForJurisdiction({
      province: pet.jurisdictionProvince,
      locality: pet.jurisdictionLocality,
    });
    for (const auth of authorities) {
      await tx.insert(notifications).values({
        userId: auth.userId,
        notificationType: "rabies_observation_completed_dead_authority",
        severity: "urgent",
        title: `Fallecimiento durante observación antirrábica — ${pet.name}`,
        body: `Causa declarada: ${cause}. Requiere revisión inmediata por riesgo de rabia.`,
        relatedPetId: pet.id,
        relatedEventId: deathEvent.id,
      });
    }
  }
}
```

#### Paso 5.3 — Tests

- Death durante observación auto-cierra con outcome=dead
- `during_rabies_observation` flag se setea en death_recorded payload
- Authorities reciben notification urgent
- Death sin observación activa: comportamiento existente intacto

#### Commit Fase 5

```
feat(bite): auto-close observation on death during the 10-day period

When death_recorded is inserted while pet.rabies_observation_status=
'in_progress', the same transaction also inserts rabies_observation_ended
with outcome='dead', updates pet status to 'completed_dead', adds
during_rabies_observation=true flag to the death_recorded payload, and
urgently escalates to authorities in jurisdiction.

Severity 'urgent' regardless of declared cause — death during rabies
observation is a public-health signal that needs immediate review.
```

---

### Fase 6 — Govt/admin surfaces

Depende de admin page Fase 0 (cuando se implemente `/gob`).

Mientras admin page Fase 0 no esté mergeado, los notifications van a admins via fallback (mismo patrón que symptom surveillance). Las routes `/gob/incidentes` etc. se construyen cuando exista el surface `/gob`.

Por ahora, **construir solo**:
- `/admin/observaciones` — lista de todas las observaciones (in_progress + completed recientes) que el admin puede revisar
- `/admin/observaciones/{petToken}` — detalle, opción de cerrar profesionalmente como `positive_rabies` o `negative`

`vetCloseRabiesObservationAction` (server action) — capability `bite.close_observation`. Inserta el ended event con outcome elegido por el actor.

#### Commit Fase 6

```
feat(bite): minimal admin surface for observation review

/admin/observaciones lists pets in active observation + recently completed.
/admin/observaciones/{petToken} shows full timeline (bite event + symptom
events during period + status) and allows professional closure with
outcome=negative or positive_rabies.

When /gob/observaciones lands (admin page Fase 0+), this surface migrates
naturally — same shape, govt-scope-filtered. Until then, admin sees all.
```

---

## 5. Verificación final

Después de Fases 0-6:

1. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` — todos verdes
2. Smoke end-to-end manual:
   - Owner reporta bite → atomic transaction inserta dos events + pet status update + notification owner + notification authorities
   - Banner aparece en pet profile
   - Owner intenta cerrar antes de 10 días → bloqueado
   - Simulación: usar Studio para mover `payload.observation_until` de algún evento started a una fecha pasada → reportar `symptom_observed` con rabia high-spec → owner ve notification urgent + outbreak_signal con severity=urgent
   - Owner intenta cerrar después de 10 días pero con escalating symptoms → bloqueado, mensaje claro
   - Owner cierra después de 10 días sin symptoms → happy path, status=completed_negative
   - Correr el cron manualmente con pnpm script → cierra automáticamente las que pasaron el período sin issue
   - Insertar death_recorded en pet con observación activa → auto-cierre con outcome=dead, notification urgent a admin
3. Existing flows no rotos:
   - Reportes de `symptom_observed` en pets sin observación → comportamiento idéntico al pre-feature
   - Tests de surveillance siguen verdes
   - Tests de libreta-sanitaria cobertura sigue verde con los 3 eventos nuevos clasificados

## 6. Casos borde

- **Owner reporta bite con fecha del pasado** (e.g., 3 días atrás): aceptado. `observation_until = bite_date + 10 días`, por lo que el período termina 7 días desde hoy
- **Bite con fecha muy antigua** (e.g., 1 mes atrás): aceptado. `observation_until` ya pasó. El cron al día siguiente lo auto-cierra (si no hubo symptoms escalables). Esto es feature, no bug — owner registra retroactivamente
- **`symptom_observed` post-cierre** (después de `completed_negative`): comportamiento idéntico al baseline — owner ve un signal warning, sin escalation. No re-abre la observación
- **Bite mientras la antirrábica está vencida**: `rabies_vaccine_valid_at_bite=false`. Notificación a autoridades incluye este flag prominente. Severity de la notificación quizás sube? Lo dejamos a discreción del govt; no hardcodeamos severity adicional por este campo
- **Pet ID en `victim_pet_id` que no existe**: el FK soft (no validamos cross-references). El frontend valida que el publicToken matche un pet real antes de enviar. Si llega null, OK
- **Múltiples bites en la misma sesión** (owner agrega dos bite events seguidos en el mismo día): segunda llamada bloquea con "ya está en observación". Si el owner quiere registrar dos víctimas distintas del mismo incidente, lo dejamos como caso borde futuro (multi-victim no en v1 per spec §11)
- **Cron corre dos veces el mismo día**: idempotent — el segundo run no encuentra observaciones in_progress que matcheen los criterios (ya las cerró)
- **Bite con jurisdicción del pet vacía** (sin province/locality cargados): authorities lookup retorna [] → solo owner es notificado. Bite igual se registra. Recomendación: forzar al owner a setear jurisdicción del pet como part del UX, pero no bloqueamos aquí

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos
2. Reportá a Nacho:
   - Cuántos archivos tocados (esperado ~15-20)
   - Tests passing count
   - Smoke manual resultados
   - Cualquier desalineamiento del spec o decisión de borde que tuviste que improvisar
   - Estado de la Fase 6 (probablemente parcial hasta admin page Fase 0)
3. Marcar en `docs/superpowers/README.md` que este plan está completo (cambiar status a ✅ Implementado)
4. **Importante para el roadmap**: este feature consume el slot de "primer feature legal-anchored" del producto. Cuando aparezca el segundo (e.g., Ley 4078 PPP registration enforcement), su patrón va a ser similar — schema + events + cron + escalation. Documentar el patrón ayudaría al futuro Claude Code que encare el siguiente.

## 8. Lo que viene después (no en este PR)

- `/gob/incidentes` y `/gob/observaciones` cuando admin page Fase 0 mergee
- Integración con sistemas externos (SIVILA, Pasteur, SISA-Salud) — API client + outbox pattern
- Multi-victim incidents en un solo bite_inflicted event
- Cuarentena preventiva (separate event type, mismo pattern de cron)
- Notification proactiva a humanos mordidos (si están en DIM como owners de otra mascota)
- Dashboards epidemiológicos: rate de bites por barrio, % completed_positive_rabies por jurisdicción, etc.
- Apelación / disputa del bite report con captura de evidencia
