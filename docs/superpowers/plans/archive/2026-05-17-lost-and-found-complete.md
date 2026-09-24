# Lost & Found completo — implementation plan

> Plan ejecutable para Claude Code. Siete fases que implementan el feature completo de cierre del loop perdida↔encontrada. Las fases son secuencialmente dependientes (Fase 1 desbloquea todo; las Fases 2-6 pueden ir en cualquier orden razonable; Fase 7 es polish opcional).
>
> **Fecha:** 2026-05-17
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~6-7 PRs chicos, ~10 archivos nuevos, ~8 archivos tocados, 1 migración SQL
> **Estimación total:** 1.5 semanas de trabajo

---

## 0. Antes de tocar nada

Lectura obligatoria en este orden — el spec define el porqué; este plan define el qué y el cómo:

1. **`docs/superpowers/specs/2026-05-17-lost-and-found-complete-design.md`** — el spec del feature (v1.1). Toda decisión está justificada ahí. Si encontrás algo en este plan que contradice el spec, gana el spec
2. **`AGENTS.md → Privacy tiers`** — Tier 1 reveal lo gobierna ahora `disclosure_*_when_lost` preferences en `pets`
3. **`AGENTS.md → Organizations`** — `organization_coverage` y memberships con `receives_broadcasts` están implementados
4. **`db/schema.ts`** — confirma que `custody_transfer_proposed` y `custody_transferred` están en `EVENT_TYPES`. Si no están, agregalas en Fase 1
5. **`lib/event-schemas.ts`** — patrón de schemas estrictos con `payload_version`. Vas a refactorear tres (`status_changed`, `custody_transfer_proposed`, `custody_transferred`)
6. **`app/actions/intake.ts`** — el `createIntakeAction` actual. No cross-check, lo agregás en Fase 2
7. **`app/actions/pets.ts`** — el `createPetAction` y cómo maneja `acquisitionMethod`
8. **`app/actions/events.ts`** — `setPetLostAction` y `setPetFoundAction` actuales
9. **`app/p/[publicToken]/page.tsx`** — credencial pública con el Tier 1 reveal hardcoded; Fase 3 lo refactoriza para leer de `pets.disclose_*`
10. **`app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx`** — form actual; Fases 3 y 4 lo extienden
11. **`app/actions/transfer.ts`** — patrón existente de org-to-org transfer; vas a reusar el shape para return-to-owner

## 1. Qué construye este plan

Siete fases secuenciales:

**Fase 1 — Schema foundation.** Migración SQL agrega 5 columnas `disclose_*_when_lost` a `pets`. Index sobre `pets.microchip_id`. Extender 3 Zod schemas. Documentar nuevos `notification_type` (TEXT, no migration).

**Fase 2 — Microchip cross-check + match flow.** `createIntakeAction` y `createPetAction` chequean chip duplicado. UI de confirmación de match. `confirmChipMatchAction` crea shelter_custody paralela.

**Fase 3 — Owner disclosure preferences.** Form de `/perdida` agrega sección de toggles. Server action persiste a `pets`. Credencial pública lee de `pets.disclose_*`.

**Fase 4 — Enriched description for unchipped.** Form de `/perdida` se expande cuando pet sin chip. Captura color/marcas refinados + accesorios + comportamiento + último contexto. Render en credencial pública.

**Fase 5 — Return-to-owner two-phase + auto-cancel.** 4 server actions nuevas. UI en refugio (proponer) y owner (aceptar/rechazar). Auto-cancel lazy con 5 preconditions.

**Fase 6 — Broadcast on lost (simplificado).** Helper `broadcastLostPet` en `setPetLostAction`. Lookup por `organization_coverage`. Fanout sin contact info (solo CTA a credencial pública).

**Fase 7 — Polish opcional.** Chip format validation, rate-limit del finder form, doble-click confirm en setPetFoundAction.

## 2. Decisiones cerradas (resumen del spec — NO relitigar)

Ver §2 del spec para razones. Lista corta:

| # | Decisión |
|---|---|
| D1 | Cross-check obligatorio si chip viene cargado |
| D2 | Match handling por status: lost→BLOCK, active→WARN, deceased→BLOCK+admin |
| D3 | Devolución = two-phase handshake (propose → accept) |
| D4 | Broadcast a refugios verified en jurisdicción, severity=warning |
| D5 | Owner controla disclosure per-field. Broadcast linkea a credencial pública (misma vista que QR scan) |
| D6 | Vecino también participa del cross-check (en `createPetAction`) |
| D7 | Match flow crea shelter_custody paralela al owner existente |
| D8 | Broadcast defensive — falla del fanout NO bloquea el marcar como lost |
| D9 | Pets sin chip activan flujo enriquecido con descripción identificatoria |
| D10 | Auto-cancel lazy de proposals (validation en accept time, no cron job) |
| D11 | Disclosure prefs viven en `pets` (columnas booleanas), no en event payload |

## 3. Scope

**Dentro:**
- 1 migración SQL agregando 5 columnas + 1 index condicional
- Modificaciones a 3 Zod schemas (`status_changed`, `custody_transfer_proposed`, `custody_transferred`)
- 4 server actions nuevas (`confirmChipMatchAction`, `proposeReturnToOwnerAction`, `ownerAcceptReturnAction`, `actorCancelProposalAction`, `ownerRejectReturnAction`)
- 2 server actions modificadas (`createIntakeAction`, `createPetAction`, `setPetLostAction`)
- 1 helper nuevo (`broadcastLostPet` en `lib/lost-pet-broadcast.ts`)
- ~4 rutas nuevas (refugio match, vecino match, devolver-al-dueno, devolucion)
- ~3 componentes nuevos (MatchConfirmationCard, ReturnProposalForm, ReturnAcceptanceCard)
- Refactor de `MarkLostForm` con secciones condicionales
- Refactor de `/p/[publicToken]/page.tsx` para leer disclosure prefs
- Tests por fase

**Fuera:**
- Reverse-lookup público "estoy buscando mi pet sin chip" — feature aparte
- Broadcast a vecinos no orgs — sin opt-in coverage model
- WhatsApp / Instagram share-intent — outside-DIM
- Animales BA integration — diplomatic, deferred
- Cron job de auto-cancel time-bomb — lazy es suficiente
- Audit log de cambios de disclosure prefs — comparable a emergencyInfoVisible
- Multi-chip detection — sin demanda

## 4. Plan paso a paso

### Fase 1 — Schema foundation

#### Paso 1.1 — Migración SQL

Crear `db/migrations/NNNN_lost_found_foundation.sql` (NNNN según orden actual). Idempotent:

```sql
-- Lost & Found foundation
-- Adds disclosure preferences columns on pets, lookup index on microchipId,
-- and prepares the schema for the cross-check, return-to-owner, and broadcast flows.

-- 1) Per-field disclosure preferences. Default values reflect roughly the
--    current hardcoded Tier 1 reveal behavior (first name + phone +
--    last_location + finder_form true; email false).
alter table public.pets
  add column if not exists disclose_first_name_when_lost    boolean not null default true,
  add column if not exists disclose_phone_when_lost         boolean not null default true,
  add column if not exists disclose_email_when_lost         boolean not null default false,
  add column if not exists disclose_last_location_when_lost boolean not null default true,
  add column if not exists allow_finder_form_when_lost      boolean not null default true;

-- 2) Lookup index on microchip_id. The unique index from prior migration
--    already enables lookup; this is a defensive partial idx for clarity.
--    Skip if the existing unique index is "WHERE microchip_id IS NOT NULL".
create index if not exists pets_microchip_lookup_idx
  on public.pets (microchip_id)
  where microchip_id is not null;

-- 3) Comment for documentation
comment on column public.pets.disclose_first_name_when_lost is
  'Owner-controlled disclosure pref: show owner first name on public credential when lost.';
comment on column public.pets.disclose_phone_when_lost is
  'Owner-controlled disclosure pref: show phone with tel: link on public credential when lost.';
comment on column public.pets.disclose_email_when_lost is
  'Owner-controlled disclosure pref: show email with mailto: link on public credential when lost.';
comment on column public.pets.disclose_last_location_when_lost is
  'Owner-controlled disclosure pref: show last known location on public credential when lost.';
comment on column public.pets.allow_finder_form_when_lost is
  'Owner-controlled disclosure pref: enable the FoundPetForm on the public credential when lost.';

-- Reverse (documented, not executed):
-- alter table public.pets
--   drop column disclose_first_name_when_lost,
--   drop column disclose_phone_when_lost,
--   drop column disclose_email_when_lost,
--   drop column disclose_last_location_when_lost,
--   drop column allow_finder_form_when_lost;
-- drop index if exists pets_microchip_lookup_idx;
```

Aplicar via Supabase Studio (NO `pnpm db:push` para evitar drift con triggers / RLS).

#### Paso 1.2 — Drizzle model en `db/schema.ts`

Agregar las 5 columnas al modelo `pets`:

```ts
discloseFirstNameWhenLost: boolean("disclose_first_name_when_lost").notNull().default(true),
disclosePhoneWhenLost: boolean("disclose_phone_when_lost").notNull().default(true),
discloseEmailWhenLost: boolean("disclose_email_when_lost").notNull().default(false),
discloseLastLocationWhenLost: boolean("disclose_last_location_when_lost").notNull().default(true),
allowFinderFormWhenLost: boolean("allow_finder_form_when_lost").notNull().default(true),
```

Verificar también que `"custody_transfer_proposed"` y `"custody_transferred"` están en `EVENT_TYPES`. Si no, agregalos.

#### Paso 1.3 — Refactor Zod schemas

En `lib/event-schemas.ts`:

**`statusChanged`** — agregar dos campos opcionales:

```ts
const statusChanged = z
  .object(
    withVersion({
      from_status: petStatus,
      to_status: petStatus,
      location_description: z.string().nullable().optional(),
      reason: z.string().nullable().optional(),
      // NEW: snapshot of owner disclosure prefs at the moment of marking lost.
      // Captured for historical audit. Source of truth lives on pets row.
      disclosure_prefs_snapshot: z
        .object({
          first_name: z.boolean(),
          phone: z.boolean(),
          email: z.boolean(),
          last_location: z.boolean(),
          finder_form: z.boolean(),
        })
        .optional(),
      // NEW: enriched description captured for unchipped pets at lost time.
      lost_description: z
        .object({
          accessories_when_lost: z.string().nullable(),
          behavior_notes: z.string().nullable(),
          last_seen_context: z.string().nullable(),
        })
        .nullable()
        .optional(),
    }),
  )
  .strict();
```

**`custodyTransferProposed`** — refactor a polimorfismo to_user_id / to_organization_id:

```ts
const custodyTransferProposed = z
  .object(
    withVersion({
      from_user_id: z.string().uuid().nullable(),
      from_organization_id: z.string().uuid().nullable(),
      to_user_id: z.string().uuid().nullable(),
      to_organization_id: z.string().uuid().nullable(),
      reason: z.enum([
        "org_to_org_handoff",
        "return_to_original_owner",
        "citizen_to_org_handoff",
        "other",
      ]),
      notes: z.string().nullable(),
      matched_against_pet_id: z.string().uuid().nullable(),
    }),
  )
  .strict()
  .refine(
    (p) => (p.to_user_id !== null) !== (p.to_organization_id !== null),
    { message: "Exactly one of to_user_id / to_organization_id must be set." },
  )
  .refine(
    (p) => (p.from_user_id !== null) !== (p.from_organization_id !== null),
    { message: "Exactly one of from_user_id / from_organization_id must be set." },
  );
```

**`custodyTransferred`** — mismo refactor.

**Importante:** si el schema actual de estos eventos tiene shape distinto (creado por el org portal plan), tenés que migrarlo. Verificar inserts existentes en `app/actions/transfer.ts` y `app/actions/adoption.ts` para asegurar que sigan validando.

#### Paso 1.4 — Tests del schema

Extender `__tests__/event-schemas.test.ts` (o donde estén los tests):

```ts
describe("statusChanged with disclosure_prefs_snapshot", () => {
  it("accepts payload with snapshot", () => {
    expect(() => validateEventPayload("status_changed", {
      from_status: "active",
      to_status: "lost",
      disclosure_prefs_snapshot: {
        first_name: true, phone: true, email: false,
        last_location: true, finder_form: true,
      },
    })).not.toThrow();
  });
  it("accepts payload without snapshot (back-compat)", () => {
    expect(() => validateEventPayload("status_changed", {
      from_status: "active",
      to_status: "lost",
    })).not.toThrow();
  });
});

describe("statusChanged with lost_description", () => {
  it("accepts when source is libreta-style (no welfare report)", () => {
    expect(() => validateEventPayload("status_changed", {
      from_status: "active",
      to_status: "lost",
      lost_description: {
        accessories_when_lost: "collar negro",
        behavior_notes: "huidiza",
        last_seen_context: "salió del jardín",
      },
    })).not.toThrow();
  });
});

describe("custodyTransferProposed polymorphism", () => {
  it("accepts to_user_id case (return to owner)", () => {
    expect(() => validateEventPayload("custody_transfer_proposed", {
      from_user_id: null,
      from_organization_id: "550e8400-e29b-41d4-a716-446655440000",
      to_user_id: "660e8400-e29b-41d4-a716-446655440000",
      to_organization_id: null,
      reason: "return_to_original_owner",
      notes: null,
      matched_against_pet_id: "770e8400-e29b-41d4-a716-446655440000",
    })).not.toThrow();
  });
  it("rejects both to_user_id and to_organization_id set", () => {
    expect(() => validateEventPayload("custody_transfer_proposed", {
      from_user_id: null,
      from_organization_id: "550e8400-e29b-41d4-a716-446655440000",
      to_user_id: "660e8400-e29b-41d4-a716-446655440000",
      to_organization_id: "880e8400-e29b-41d4-a716-446655440000",
      reason: "other",
      notes: null,
      matched_against_pet_id: null,
    })).toThrow();
  });
});
```

#### Acceptance Fase 1

- `pnpm typecheck` cero errores
- `pnpm lint` cero errores nuevos
- `pnpm test` todos los tests verdes
- En Studio: `SELECT disclose_first_name_when_lost FROM pets LIMIT 1` retorna `true` para filas existentes
- Inserts existentes en `app/actions/transfer.ts` y `app/actions/adoption.ts` siguen funcionando (smoke manual o test)

#### Commit Fase 1

```
feat(lost-found): schema foundation for disclosure prefs + custody refactor

Migration adds five disclosure preference columns to pets table:
disclose_first_name_when_lost, disclose_phone_when_lost,
disclose_email_when_lost, disclose_last_location_when_lost,
allow_finder_form_when_lost. Defaults preserve current hardcoded Tier 1
behavior on existing rows.

Extends Zod schemas:
- status_changed: adds optional disclosure_prefs_snapshot and
  lost_description fields (both optional, back-compat)
- custody_transfer_proposed: polymorphic to_user_id / to_organization_id
  (XOR), adds return_to_original_owner reason, matched_against_pet_id
- custody_transferred: same polymorphism refactor

Defensive index on pets.microchip_id for fast lookups.

No business logic changes. Foundation for Fases 2-6.

See docs/superpowers/specs/2026-05-17-lost-and-found-complete-design.md.
```

---

### Fase 2 — Microchip cross-check + match flow

#### Paso 2.1 — Lookup helper

Crear `lib/chip-lookup.ts`:

```ts
// Looks up an existing pet by microchip_id and returns the data needed
// to decide cross-check behavior. Used by createIntakeAction and
// createPetAction.

import { db, pets, ownerships, profiles } from "@/db";
import { and, eq, isNull } from "drizzle-orm";

export type ChipLookupResult = null | {
  pet: typeof pets.$inferSelect;
  ownerUserId: string | null;
  ownerFirstName: string | null;
};

export async function lookupByChip(microchipId: string): Promise<ChipLookupResult> {
  const [result] = await db
    .select({
      pet: pets,
      ownerUserId: ownerships.ownerUserId,
      ownerProfile: profiles,
    })
    .from(pets)
    .leftJoin(
      ownerships,
      and(
        eq(ownerships.petId, pets.id),
        isNull(ownerships.endedAt),
        eq(ownerships.role, "owner"),
      ),
    )
    .leftJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(eq(pets.microchipId, microchipId))
    .limit(1);

  if (!result) return null;

  const firstName = result.ownerProfile?.displayName
    ? result.ownerProfile.displayName.trim().split(/\s+/)[0]
    : null;

  return {
    pet: result.pet,
    ownerUserId: result.ownerUserId ?? null,
    ownerFirstName: firstName,
  };
}
```

#### Paso 2.2 — Modificar `createIntakeAction`

En `app/actions/intake.ts`, agregar después del parse del form, antes del insert:

```ts
import { lookupByChip } from "@/lib/chip-lookup";
import { redirect } from "next/navigation";

// ... inside createIntakeAction, after parseIntakeForm:

if (parsed.microchipId) {
  const match = await lookupByChip(parsed.microchipId);
  if (match) {
    if (match.pet.status === "lost") {
      // BLOCK creation. Redirect to match confirmation flow.
      redirect(`/org/[orgToken]/intake/match/${match.pet.publicToken}`);
    }
    if (match.pet.status === "deceased") {
      return {
        error: `Este chip está asociado a una mascota registrada como fallecida en DIM. Pedile a un admin que revise el caso.`,
      };
    }
    if (match.pet.status === "active") {
      // Active match — surface a warning the form will display. Allow
      // override via a confirmation token (signed timestamp).
      const forceToken = String(formData.get("forceCreateToken") ?? "");
      if (!isValidForceCreateToken(forceToken, parsed.microchipId)) {
        return {
          error: null,
          warning: {
            kind: "chip_active_match",
            message: `El chip ${parsed.microchipId} ya está registrado en DIM bajo otra mascota (${match.pet.name}${match.ownerFirstName ? ` · dueño: ${match.ownerFirstName}` : ""}). Si esta es la misma, contactá al dueño antes de continuar.`,
            forceCreateToken: signForceCreateToken(parsed.microchipId),
          },
        };
      }
    }
  }
}

// ... continue with normal intake flow
```

**Notes:**
- `isValidForceCreateToken` / `signForceCreateToken` son helpers nuevos para evitar bypass del warning. Implementación trivial — HMAC sobre `(microchipId, timestamp)` con expiry de 15 minutos.
- El `IntakeFormState` type necesita expandirse para incluir `warning?: { kind, message, forceCreateToken }`.

#### Paso 2.3 — Modificar `createPetAction`

En `app/actions/pets.ts`, similar pero para el caso vecino:

```ts
// Only run cross-check when acquisitionMethod is found_stray AND chip is set.
// Other acquisition methods (adopted, purchased, etc.) are NOT lost-found cases.
if (parsed.acquisitionMethod === "found_stray" && parsed.microchipId) {
  const match = await lookupByChip(parsed.microchipId);
  if (match) {
    if (match.pet.status === "lost") {
      redirect(`/mis-mascotas/nueva/match/${match.pet.publicToken}`);
    }
    if (match.pet.status === "deceased") {
      return { error: `Este chip está asociado a una mascota fallecida. Pedile a un admin que revise.` };
    }
    if (match.pet.status === "active") {
      // Same warning + force_create_token pattern as intake
    }
  }
}
```

#### Paso 2.4 — Server action `confirmChipMatchAction`

Crear `app/actions/chip-match.ts`:

```ts
"use server";

// Server action that runs when an actor (refugio coordinator or vecino)
// confirms that the pet they found IS the same pet that exists in DIM
// (identified via microchip cross-check). Creates a shelter_custody
// ownership parallel to the existing owner ownership, emits the
// shelter_intake_recorded event, and notifies the original owner.

import { db, ownerships, petEvents, pets, profiles, notifications } from "@/db";
import { validateEventPayload } from "@/lib/event-schemas";
import { requireCapability } from "@/lib/capabilities";
import { createClient } from "@/lib/supabase/server";
import { and, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";

export type ConfirmMatchResult = { error: string } | { ok: true };

export async function confirmChipMatchAction(
  petPublicToken: string,
  formData: FormData,
): Promise<ConfirmMatchResult> {
  // Determine if actor is refugio (with intake.create) or vecino (logged-in user).
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  const [matchedPet] = await db
    .select()
    .from(pets)
    .where(eq(pets.publicToken, petPublicToken))
    .limit(1);
  if (!matchedPet) return { error: "Mascota no encontrada." };
  if (matchedPet.status !== "lost") {
    return { error: "Esta mascota ya no está marcada como perdida." };
  }

  // Find the original owner for notification
  const [ownerRow] = await db
    .select({ id: ownerships.ownerUserId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, matchedPet.id),
        isNull(ownerships.endedAt),
        eq(ownerships.role, "owner"),
      ),
    )
    .limit(1);
  if (!ownerRow?.id) return { error: "No se encontró un dueño activo." };

  // Determine actor: refugio (has active org) or vecino (just user)
  const actorMode = String(formData.get("actorMode") ?? "vecino"); // "refugio" | "vecino"
  let actorOrgId: string | null = null;
  let actorDisplayName = "";

  if (actorMode === "refugio") {
    const auth = await requireCapability("intake.create");
    if (auth.error !== null) return { error: auth.error };
    actorOrgId = auth.organization.id;
    actorDisplayName = auth.organization.displayName;
  } else {
    const [profile] = await db
      .select({ displayName: profiles.displayName })
      .from(profiles)
      .where(eq(profiles.id, user.id))
      .limit(1);
    actorDisplayName = profile?.displayName ?? "Un vecino";
  }

  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      // 1. Create shelter_custody ownership (parallel to existing owner)
      await tx.insert(ownerships).values({
        petId: matchedPet.id,
        ownerOrganizationId: actorOrgId,
        ownerUserId: actorMode === "vecino" ? user.id : null,
        role: "shelter_custody",
        startedAt: now,
      });

      // 2. Emit shelter_intake_recorded event with match context
      const intakePayload = validateEventPayload("shelter_intake_recorded", {
        intake_reason: "stray_found",
        intake_condition: null,
        rescue_jurisdiction: null,
        // Optional: extend payload schema to include matched_via_chip flag
      });
      await tx.insert(petEvents).values({
        petId: matchedPet.id,
        eventType: "shelter_intake_recorded",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: actorMode === "refugio" ? "shelter" : "scanner",
        authorOrganizationId: actorOrgId,
        payload: intakePayload,
      });

      // 3. Notify the original owner
      await tx.insert(notifications).values({
        userId: ownerRow.id,
        notificationType: "chip_match_notification_owner",
        severity: "urgent",
        title: `Te encontraron a ${matchedPet.name}`,
        body: `${actorDisplayName} detectó el chip de ${matchedPet.name}. Te está esperando.`,
        relatedPetId: matchedPet.id,
        ctaLabel: "Coordinar devolución",
        ctaUrl: `/mis-mascotas/${matchedPet.publicToken}/devolucion`,
      });
    });
  } catch (err) {
    console.error("confirmChipMatchAction failed:", err);
    return {
      error: `No se pudo confirmar la coincidencia: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  if (actorMode === "refugio") {
    redirect(`/org/[orgToken]/mascotas/${matchedPet.publicToken}`);
  } else {
    redirect(`/mis-mascotas`);
  }
}
```

#### Paso 2.5 — Match confirmation route (refugio)

Crear `app/org/[orgToken]/intake/match/[publicToken]/page.tsx`:

```tsx
import { db, pets, ownerships, profiles, attachments } from "@/db";
import { requireActiveOrgOrRedirect } from "@/lib/auth-guards";
import { speciesLabel, sexLabel, formatDate } from "@/lib/format";
import { petPhotoUrl } from "@/lib/storage";
import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { MatchConfirmationCard } from "./MatchConfirmationCard";

export default async function MatchConfirmationPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  await requireActiveOrgOrRedirect();

  // Load the matched pet with photo
  const [result] = await db
    .select({ pet: pets, photo: attachments })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(eq(pets.publicToken, publicToken))
    .limit(1);
  if (!result) notFound();
  const { pet, photo } = result;
  if (pet.status !== "lost") {
    return (
      <main className="min-h-screen p-6 flex items-center justify-center">
        <p>Esta mascota ya no está marcada como perdida. Volvé a la intake.</p>
      </main>
    );
  }

  // Tier 1 reveal — respecting owner disclosure preferences
  const [ownerRow] = await db
    .select({ profile: profiles })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt), eq(ownerships.role, "owner")))
    .limit(1);

  const photoUrl = petPhotoUrl(photo?.storagePath);

  return (
    <main className="min-h-screen p-6 bg-white dark:bg-neutral-950">
      <div className="max-w-2xl mx-auto pt-8 space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold">Posible coincidencia detectada</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            El chip que cargaste coincide con una mascota registrada en DIM que está marcada como perdida.
            Revisá si es el mismo animal antes de continuar.
          </p>
        </header>

        <MatchConfirmationCard
          pet={pet}
          photoUrl={photoUrl}
          ownerProfile={ownerRow?.profile ?? null}
          actorMode="refugio"
        />
      </div>
    </main>
  );
}
```

Y el componente `MatchConfirmationCard.tsx` que renderiza:
- Foto del pet
- Identidad básica (nombre, especie, raza, color, sexo)
- Status: Perdida desde {fecha}
- Si `pet.discloseFirstNameWhenLost`: muestra owner firstName
- Si `pet.disclosePhoneWhenLost`: muestra teléfono con `tel:` link
- Si `pet.discloseEmailWhenLost`: muestra email
- Si `pet.discloseLastLocationWhenLost`: muestra última ubicación
- Dos botones: "Es la misma mascota" (form submit a `confirmChipMatchAction` con `actorMode='refugio'`) y "No es la misma" (link de vuelta a `/org/[orgToken]/intake` con `forceCreateToken`)

#### Paso 2.6 — Match confirmation route (vecino)

Crear `app/(app)/mis-mascotas/nueva/match/[publicToken]/page.tsx` análogo al de refugio pero con `actorMode='vecino'`. Reusa `MatchConfirmationCard` con la prop distinta.

#### Paso 2.7 — Tests

Crear `__tests__/chip-match.test.ts`:

```ts
describe("chip cross-check", () => {
  it("blocks intake when chip matches a lost pet", async () => {
    // setup: pet with chip and status=lost, owner
    // attempt createIntakeAction with same chip
    // assert: redirect to /org/[orgToken]/intake/match/{token}
  });

  it("blocks intake when chip matches a deceased pet", async () => {
    // setup: pet with chip and status=deceased
    // attempt: assert error returned with explicit message
  });

  it("warns intake when chip matches an active pet without force token", async () => {
    // setup: pet with chip and status=active
    // attempt: assert warning returned
  });

  it("allows intake when chip matches active pet with force token", async () => {
    // setup: pet with chip and status=active
    // attempt with forceCreateToken: assert pet created
  });

  it("proceeds normally when chip has no match", async () => {
    // setup: no pet with this chip
    // attempt: assert pet created normally
  });
});

describe("confirmChipMatchAction", () => {
  it("creates shelter_custody parallel to active owner ownership", async () => {
    // setup: lost pet, owner ownership active, actor is refugio
    // call confirmChipMatchAction with actorMode=refugio
    // assert: 2 active ownerships (owner + shelter_custody)
    // assert: shelter_intake_recorded event emitted
    // assert: notification to owner with type=chip_match_notification_owner
  });

  it("works for vecino actor too", async () => {
    // similar but actorMode=vecino, owner_user_id set instead of org
  });
});
```

#### Commit Fase 2

```
feat(lost-found): microchip cross-check + match confirmation flow

When createIntakeAction or createPetAction (with acquisitionMethod=
found_stray) receives a microchipId, the new lib/chip-lookup.ts looks
up existing pets. Match handling by status:

- lost: blocks creation, redirects to match confirmation page
- deceased: blocks creation with admin-review message
- active: warns with override-via-force-token

New routes /org/[orgToken]/intake/match/{token} and /mis-mascotas/nueva/match/
{token} render the matched pet (respecting owner disclosure prefs that
the public credential uses too) with two-button decision: same /
different. "Same" runs confirmChipMatchAction which:

1. Creates shelter_custody ownership parallel to the existing owner row
2. Emits shelter_intake_recorded event with match context
3. Notifies the original owner with severity=urgent

"Different" returns with a force-create token allowing the duplicate
intake (rare legitimate re-chipping case).

Tests cover all four status branches and the match confirmation
transaction.
```

---

### Fase 3 — Owner disclosure preferences

#### Paso 3.1 — Extender `MarkLostForm` con sección de disclosure

En `app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx`, agregar después del campo "Detalles":

```tsx
<details className="rounded-lg border border-neutral-200 dark:border-neutral-800" open>
  <summary className="px-4 py-3 cursor-pointer text-sm font-medium">
    ¿Qué info querés que vean quienes la encuentren?
  </summary>
  <div className="p-4 space-y-3 border-t border-neutral-200 dark:border-neutral-800">
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        name="discloseFirstName"
        defaultChecked={initialPrefs.firstName}
        className="mt-1"
      />
      <span className="text-sm">
        <strong>Mi primer nombre</strong>
        <span className="block text-xs text-neutral-500">"Dueño: Nacho", no apellido</span>
      </span>
    </label>
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        name="disclosePhone"
        defaultChecked={initialPrefs.phone}
        className="mt-1"
      />
      <span className="text-sm">
        <strong>Mi teléfono</strong>
        <span className="block text-xs text-neutral-500">Botón para llamar directo</span>
      </span>
    </label>
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        name="discloseEmail"
        defaultChecked={initialPrefs.email}
        className="mt-1"
      />
      <span className="text-sm">
        <strong>Mi email</strong>
        <span className="block text-xs text-neutral-500">Botón para mandar email</span>
      </span>
    </label>
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        name="discloseLastLocation"
        defaultChecked={initialPrefs.lastLocation}
        className="mt-1"
      />
      <span className="text-sm">
        <strong>Última ubicación conocida</strong>
        <span className="block text-xs text-neutral-500">El barrio donde se perdió</span>
      </span>
    </label>
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        name="allowFinderForm"
        defaultChecked={initialPrefs.allowFinderForm}
        className="mt-1"
      />
      <span className="text-sm">
        <strong>Formulario "¿Encontraste a esta mascota?"</strong>
        <span className="block text-xs text-neutral-500">Quien la encuentra puede dejarte un mensaje sin saber tu contacto</span>
      </span>
    </label>
  </div>
</details>
```

El form recibe la prop `initialPrefs` desde el page server component (lee del `pets` row).

#### Paso 3.2 — Modificar `setPetLostAction`

En `app/actions/events.ts`, dentro de `setPetLostAction`:

```ts
// Parse new disclosure prefs from form
const discloseFirstName = formData.get("discloseFirstName") === "on";
const disclosePhone = formData.get("disclosePhone") === "on";
const discloseEmail = formData.get("discloseEmail") === "on";
const discloseLastLocation = formData.get("discloseLastLocation") === "on";
const allowFinderForm = formData.get("allowFinderForm") === "on";

// ... inside the transaction:

// Update pets row with disclosure prefs (alongside the status update)
await tx.update(pets).set({
  status: "lost",
  discloseFirstNameWhenLost: discloseFirstName,
  disclosePhoneWhenLost: disclosePhone,
  discloseEmailWhenLost: discloseEmail,
  discloseLastLocationWhenLost: discloseLastLocation,
  allowFinderFormWhenLost: allowFinderForm,
  updatedAt: now,
}).where(eq(pets.id, pet.id));

// Include snapshot in event payload
const eventPayload = validateEventPayload("status_changed", {
  from_status: fromStatus,
  to_status: "lost",
  location_description: locationDescription,
  reason,
  disclosure_prefs_snapshot: {
    first_name: discloseFirstName,
    phone: disclosePhone,
    email: discloseEmail,
    last_location: discloseLastLocation,
    finder_form: allowFinderForm,
  },
});
```

#### Paso 3.3 — Refactor `/p/[publicToken]/page.tsx`

Reemplazar el bloque actual de Tier 1 que renderiza phone/email/location hardcoded por reads condicionales de `pet.disclose*`:

```tsx
{/* Found / lost actions */}
{isLost && lostContext ? (
  <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 rounded-xl p-5 space-y-4">
    {pet.discloseFirstNameWhenLost && lostContext.ownerFirstName && (
      <p className="text-sm text-amber-900 dark:text-amber-200">
        <span className="font-medium">Dueño:</span> {lostContext.ownerFirstName}
      </p>
    )}
    {pet.disclosePhoneWhenLost && lostContext.phone && (
      <a
        href={`tel:${lostContext.phone}`}
        className="block w-full text-center px-4 py-2 rounded-lg bg-amber-600 dark:bg-amber-500 text-white text-sm font-medium hover:bg-amber-700 dark:hover:bg-amber-600 transition-colors"
      >
        📞 Llamar al dueño · {lostContext.phone}
      </a>
    )}
    {pet.discloseEmailWhenLost && lostContext.email && (
      <a
        href={`mailto:${lostContext.email}`}
        className="block w-full text-center px-4 py-2 rounded-lg border border-amber-300 dark:border-amber-700 text-sm font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors"
      >
        ✉️ {lostContext.email}
      </a>
    )}
    {pet.allowFinderFormWhenLost && (
      <FoundPetForm publicToken={publicToken} />
    )}
    {pet.discloseLastLocationWhenLost && lostContext.locationText && (
      <p className="text-xs text-amber-800 dark:text-amber-300">
        <span className="font-medium">Última ubicación conocida:</span> {lostContext.locationText}
      </p>
    )}
  </div>
) : (
  /* Active pet — finder form behind disclosure (existing) */
  ...
)}
```

Tambien agregar email al `lostContext` lookup (cargar `auth.users.email` para el owner via supabase admin client o agregar email a profiles si no está).

#### Paso 3.4 — Opcional: ruta para editar prefs fuera del lost flow

Si el owner quiere cambiar prefs sin tener que marcar found+lost, crear `app/(app)/mis-mascotas/[publicToken]/credencial/page.tsx` con el mismo set de toggles + un `updateDisclosurePrefsAction` server action. Update directo de pets row, sin event (es UI preference como `emergencyInfoVisible`).

**Para v1 puede ser deferred** — solo se setea al marcar lost. Marcar como mejora futura.

#### Paso 3.5 — Tests

Cubrir:
- Submit del form con todos los toggles → pets row tiene los valores correctos + event payload tiene snapshot
- Submit con toggles selectivos → solo los habilitados se persisten true
- Credencial pública con `disclosePhoneWhenLost=false` no renderiza el botón tel:
- Credencial pública con `allowFinderFormWhenLost=false` no renderiza el form

#### Commit Fase 3

```
feat(lost-found): owner-controlled disclosure preferences

Adds a section to the MarkLostForm with five toggles letting the owner
choose what appears on the public credential when the pet is lost:
first name, phone, email, last known location, FoundPetForm enabled.

setPetLostAction persists toggles to pets row (source of truth) and
includes a snapshot in the status_changed event payload (historical
audit).

Refactors the public credential page to read disclosure prefs from the
pet row instead of hardcoded Tier 1 logic. The credential now renders
only what the owner chose to expose — same view for QR scanners,
broadcast recipients (Fase 6), and chip-match flows (Fase 2).

Defaults preserve current behavior (first_name, phone, last_location,
finder_form true; email false).
```

---

### Fase 4 — Enriched description for unchipped pets

#### Paso 4.1 — Extender `MarkLostForm` con sección condicional

El form ahora recibe `pet.microchipId` como prop. Cuando `microchipId === null`, renderiza una sección adicional:

```tsx
{!pet.microchipId && (
  <details className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20" open>
    <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-amber-900 dark:text-amber-200">
      Tu mascota no tiene microchip — más info ayuda a encontrarla
    </summary>
    <div className="p-4 space-y-4 border-t border-amber-200 dark:border-amber-900/50">
      <p className="text-xs text-amber-800 dark:text-amber-300">
        Completá lo que sepas. Cuanto más detalle, más fácil que la reconozcan.
      </p>

      {/* Photo upload if no primaryPhoto */}
      {!pet.hasPhoto && (
        <PhotoField name="photo" label="Subí una foto (muy importante)" />
      )}

      <input
        name="colorRefined"
        defaultValue={pet.color ?? ""}
        placeholder="Color / marcas distintivas (ej: marrón con manchas blancas en el pecho)"
      />

      <input
        name="distinguishingFeaturesRefined"
        defaultValue={pet.distinguishingFeatures ?? ""}
        placeholder="Características distintivas (cicatrices, dientes, oreja recortada, etc.)"
      />

      <input
        name="accessoriesWhenLost"
        placeholder="Accesorios cuando se perdió (collar negro con chapita roja)"
      />

      <textarea
        name="behaviorNotes"
        rows={2}
        placeholder="Cómo es (huidiza, sociable, le tiene miedo a las motos, responde a su nombre, etc.)"
      />

      <textarea
        name="lastSeenContext"
        rows={2}
        placeholder="Último contexto (escapó del jardín, en la plaza, con la cuidadora, etc.)"
      />

      {/* Optional: retroactive chip registration */}
      <details>
        <summary className="text-xs cursor-pointer text-amber-800 dark:text-amber-300">
          ¿Te acordaste que sí tiene chip?
        </summary>
        <input
          name="microchipIdRetroactive"
          placeholder="Número de chip (15 dígitos)"
        />
      </details>
    </div>
  </details>
)}
```

#### Paso 4.2 — Modificar `setPetLostAction`

Parsear los nuevos campos. Si se proveen:

```ts
const colorRefined = String(formData.get("colorRefined") ?? "").trim();
const distinguishingFeaturesRefined = String(formData.get("distinguishingFeaturesRefined") ?? "").trim();
const accessoriesWhenLost = String(formData.get("accessoriesWhenLost") ?? "").trim() || null;
const behaviorNotes = String(formData.get("behaviorNotes") ?? "").trim() || null;
const lastSeenContext = String(formData.get("lastSeenContext") ?? "").trim() || null;

// Photo upload — same flow as createPetAction's photo handling
const photoFile = formData.get("photo") as File | null;
const upload = await uploadAttachmentIfPresent(supabase, photoFile, "pet-photos");

// Chip retroactive
const microchipIdRetroactive = String(formData.get("microchipIdRetroactive") ?? "").trim() || null;

// ... inside transaction:

// Update pets row with refined identity fields
const petUpdates: Partial<typeof pets.$inferInsert> = {
  status: "lost",
  // disclosure prefs from Fase 3
  // ...
};
if (colorRefined && colorRefined !== pet.color) {
  petUpdates.color = colorRefined;
}
if (distinguishingFeaturesRefined && distinguishingFeaturesRefined !== pet.distinguishingFeatures) {
  petUpdates.distinguishingFeatures = distinguishingFeaturesRefined;
}
if (microchipIdRetroactive && !pet.microchipId) {
  petUpdates.microchipId = microchipIdRetroactive;
  // ALSO emit microchip_implanted event in the same transaction
}

// Photo: if uploaded, insert attachment and set primaryPhotoId
if (upload.uploadedPath) {
  const [attachment] = await tx.insert(attachments).values({
    petId: pet.id,
    uploadedByUserId: user.id,
    storagePath: upload.uploadedPath,
    mimeType: upload.mimeType ?? "image/jpeg",
    fileSize: upload.size ?? 0,
  }).returning();
  petUpdates.primaryPhotoId = attachment.id;
}

await tx.update(pets).set(petUpdates).where(eq(pets.id, pet.id));

// Snapshot enriched description in event payload
const eventPayload = validateEventPayload("status_changed", {
  from_status: fromStatus,
  to_status: "lost",
  location_description: locationDescription,
  reason,
  disclosure_prefs_snapshot: { /* ... */ },
  lost_description: (accessoriesWhenLost || behaviorNotes || lastSeenContext) ? {
    accessories_when_lost: accessoriesWhenLost,
    behavior_notes: behaviorNotes,
    last_seen_context: lastSeenContext,
  } : null,
});

// If chip retroactive, also emit microchip_implanted
if (microchipIdRetroactive && !pet.microchipId) {
  await tx.insert(petEvents).values({
    petId: pet.id,
    eventType: "microchip_implanted",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: user.id,
    authorRole: "owner",
    payload: validateEventPayload("microchip_implanted", {
      chip_number: microchipIdRetroactive,
      country_code: null,
      implanted_by: null,
      location_on_body: null,
      implant_date_known: false,
    }),
  });
}
```

#### Paso 4.3 — Render en credencial pública

En `/p/[publicToken]/page.tsx` agregar después de los badges:

```tsx
{isLost && /* read lost_description from latest status_changed→lost event */ && (
  <section className="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 space-y-2">
    <h2 className="text-sm font-medium">Detalles para identificarla</h2>
    {lostDescription.accessories_when_lost && (
      <p className="text-xs text-neutral-700 dark:text-neutral-300">
        <span className="font-medium">Cuando se perdió, tenía:</span> {lostDescription.accessories_when_lost}
      </p>
    )}
    {lostDescription.behavior_notes && (
      <p className="text-xs text-neutral-700 dark:text-neutral-300">
        <span className="font-medium">Cómo es:</span> {lostDescription.behavior_notes}
      </p>
    )}
    {lostDescription.last_seen_context && (
      <p className="text-xs text-neutral-700 dark:text-neutral-300">
        <span className="font-medium">Última vez vista:</span> {lostDescription.last_seen_context}
      </p>
    )}
  </section>
)}
```

`lostDescription` viene del último `status_changed → lost` event payload (mismo lookup pattern que el `lostContext.locationText` actual).

#### Paso 4.4 — Tests

- Pet sin chip → form muestra sección de enriched
- Pet con chip → form NO muestra sección de enriched
- Submit con campos enriquecidos → pets row + event payload reflejan
- Chip retroactive → microchip_implanted event emitido + pets.microchipId set
- Credencial pública renderiza sección "Detalles para identificarla" cuando hay datos

#### Commit Fase 4

```
feat(lost-found): enriched description flow for unchipped pets

When marking lost a pet with microchip_id=null, MarkLostForm now expands
with an enrichment section: refine color/marks, capture accessories at
loss time, behavioral notes, last-seen context, optionally upload a
photo if none exists, and optionally backfill a microchip number.

Identity fields (color, distinguishing_features, primary_photo, chip)
update the pets row directly — they're permanent improvements. Incident-
scoped fields (accessories, behavior, last_seen_context) snapshot into
the status_changed event payload.

The public credential renders the snapshot section "Detalles para
identificarla" so refugio volunteers can match an animal in the street
to the lost description.

If chip is backfilled in this flow, microchip_implanted event is also
emitted, enabling the cross-check (Fase 2) for any future intake of
this same animal.
```

---

### Fase 5 — Return-to-owner two-phase + auto-cancel

#### Paso 5.1 — Server actions

Crear `app/actions/return-to-owner.ts`:

```ts
"use server";

import { db, ownerships, petEvents, pets, notifications, profiles } from "@/db";
import { requireCapability } from "@/lib/capabilities";
import { requireOwnedPetByToken } from "@/lib/pets";
import { validateEventPayload } from "@/lib/event-schemas";
import { createClient } from "@/lib/supabase/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export type ProposeReturnState = { error: string | null };
export type AcceptReturnState = { error: string | null; autoCancelled?: { reason: string } };

// Phase 1: actor (refugio or vecino) proposes returning the pet
export async function proposeReturnToOwnerAction(
  publicToken: string,
  _prev: ProposeReturnState,
  formData: FormData,
): Promise<ProposeReturnState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  // Find the pet
  const [pet] = await db.select().from(pets).where(eq(pets.publicToken, publicToken)).limit(1);
  if (!pet) return { error: "Mascota no encontrada." };

  // Find actor's shelter_custody ownership on this pet
  const [actorOwnership] = await db
    .select({
      id: ownerships.id,
      userId: ownerships.ownerUserId,
      orgId: ownerships.ownerOrganizationId,
    })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        // Either the actor's user_id matches, or the actor is a member of the org
      ),
    )
    .limit(1);

  // ... resolve actor identity and verify ownership/capability

  // Find original owner ownership
  const [ownerOwnership] = await db
    .select({ userId: ownerships.ownerUserId })
    .from(ownerships)
    .where(and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)))
    .limit(1);
  if (!ownerOwnership?.userId) return { error: "No se encontró un dueño activo para devolver." };

  // Anti-double-proposal: check no pending proposal exists from same actor
  // ... query latest custody_transfer_proposed for this pet with no subsequent
  //     custody_transferred or note_added cancellation

  const notes = String(formData.get("notes") ?? "").trim() || null;
  const now = new Date();

  try {
    await db.transaction(async (tx) => {
      const payload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: actorOwnership.userId,
        from_organization_id: actorOwnership.orgId,
        to_user_id: ownerOwnership.userId,
        to_organization_id: null,
        reason: "return_to_original_owner",
        notes,
        matched_against_pet_id: pet.id,
      });

      const [proposalEvent] = await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "custody_transfer_proposed",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: actorOwnership.orgId ? "shelter" : "owner", // vecino acts as owner-ish
        authorOrganizationId: actorOwnership.orgId,
        payload,
      }).returning();

      // Notify the original owner
      const [actorProfile] = await tx.select({ displayName: profiles.displayName })
        .from(profiles).where(eq(profiles.id, user.id)).limit(1);

      await tx.insert(notifications).values({
        userId: ownerOwnership.userId,
        notificationType: "custody_transfer_proposal_owner",
        severity: "urgent",
        title: `Devolución propuesta de ${pet.name}`,
        body: `${actorProfile?.displayName ?? "Alguien"} está listo para devolverte a ${pet.name}. Confirmá cuando la tengas físicamente.`,
        relatedPetId: pet.id,
        relatedEventId: proposalEvent.id,
        ctaLabel: "Coordinar devolución",
        ctaUrl: `/mis-mascotas/${pet.publicToken}/devolucion`,
      });
    });
  } catch (err) {
    return { error: `No se pudo proponer la devolución: ${err instanceof Error ? err.message : ""}` };
  }

  return { error: null };
}

// Phase 2: owner accepts the proposal — with lazy auto-cancel
export async function ownerAcceptReturnAction(
  publicToken: string,
): Promise<AcceptReturnState> {
  const session = await requireOwnedPetByToken(publicToken);
  if (!session) return { error: "Sin permisos." };
  const { pet, user } = session;

  // Find latest pending proposal
  // (pending = no subsequent custody_transferred or cancellation note_added)
  const [latestProposal] = await db
    .select()
    .from(petEvents)
    .where(and(
      eq(petEvents.petId, pet.id),
      eq(petEvents.eventType, "custody_transfer_proposed"),
    ))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  if (!latestProposal) return { error: "No hay propuestas pendientes." };

  // Check no subsequent custody_transferred or cancellation
  // ... (query for events after latestProposal.occurredAt)

  const proposalPayload = latestProposal.payload as Record<string, unknown>;
  const fromUserId = proposalPayload.from_user_id as string | null;
  const fromOrgId = proposalPayload.from_organization_id as string | null;

  // PRECONDITIONS check
  const failures: string[] = [];

  // 1. The actor still has active shelter_custody
  const [actorOwnership] = await db.select().from(ownerships).where(and(
    eq(ownerships.petId, pet.id),
    eq(ownerships.role, "shelter_custody"),
    isNull(ownerships.endedAt),
    // matches from_user_id or from_organization_id
    fromUserId ? eq(ownerships.ownerUserId, fromUserId) : eq(ownerships.ownerOrganizationId, fromOrgId!),
  )).limit(1);
  if (!actorOwnership) failures.push("actor_no_longer_holds_custody");

  // 2. Pet is not deceased
  if (pet.status === "deceased") failures.push("pet_deceased");

  // 3. The owner is still the active owner
  // (covered by requireOwnedPetByToken already, but defensive)

  if (failures.length > 0) {
    const reason = failures.join(",");

    // Auto-cancel: emit note_added event marking the cancellation
    try {
      await db.transaction(async (tx) => {
        const cancelPayload = validateEventPayload("note_added", {
          category: "custody_transfer_proposal_auto_cancelled",
          text: `Auto-cancelled at owner-accept: ${reason}. Original proposal_event_id=${latestProposal.id}`,
        });
        await tx.insert(petEvents).values({
          petId: pet.id,
          eventType: "note_added",
          occurredAt: new Date(),
          recordedAt: new Date(),
          recordedByUserId: user.id,
          authorRole: "system",
          payload: cancelPayload,
        });
        // Notify the actor
        const recipient = fromUserId ?? null;
        if (recipient) {
          await tx.insert(notifications).values({
            userId: recipient,
            notificationType: "custody_transfer_auto_cancelled",
            severity: "info",
            title: `Propuesta auto-cancelada de ${pet.name}`,
            body: `La propuesta de devolución se canceló automáticamente: ${humanReadable(reason)}`,
            relatedPetId: pet.id,
          });
        }
      });
    } catch (err) {
      console.error("auto-cancel failed:", err);
    }

    return {
      error: null,
      autoCancelled: { reason: humanReadable(failures.join(",")) },
    };
  }

  // Preconditions OK — execute the transfer
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      const transferPayload = validateEventPayload("custody_transferred", {
        from_user_id: fromUserId,
        from_organization_id: fromOrgId,
        to_user_id: user.id,
        to_organization_id: null,
        reason: "return_to_original_owner",
        notes: null,
        matched_against_pet_id: pet.id,
      });
      const [transferEvent] = await tx.insert(petEvents).values({
        petId: pet.id,
        eventType: "custody_transferred",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "owner",
        payload: transferPayload,
      }).returning();

      // End the actor's shelter_custody ownership
      await tx.update(ownerships).set({ endedAt: now })
        .where(eq(ownerships.id, actorOwnership!.id));

      // Flip pet status from lost to active (the return validates recovery)
      if (pet.status === "lost") {
        await tx.update(pets).set({ status: "active", updatedAt: now }).where(eq(pets.id, pet.id));
      }

      // Notify the actor
      const recipient = fromUserId ?? null;
      if (recipient) {
        await tx.insert(notifications).values({
          userId: recipient,
          notificationType: "custody_transfer_accepted_owner_side",
          severity: "info",
          title: `${session.user.email} confirmó la devolución de ${pet.name}`,
          body: `La transferencia se completó. ${pet.name} vuelve a estar con su dueño original.`,
          relatedPetId: pet.id,
          relatedEventId: transferEvent.id,
        });
      }
    });
  } catch (err) {
    return { error: `No se pudo completar la devolución: ${err instanceof Error ? err.message : ""}` };
  }

  revalidatePath(`/mis-mascotas/${publicToken}`);
  return { error: null };
}

function humanReadable(reason: string): string {
  const map: Record<string, string> = {
    actor_no_longer_holds_custody: "Quien proponía la devolución ya no tiene a la mascota.",
    pet_deceased: "La mascota está registrada como fallecida.",
  };
  return reason.split(",").map(r => map[r] ?? r).join(" ");
}

// Phase 2b: owner rejects the proposal
export async function ownerRejectReturnAction(
  publicToken: string,
  reason: string,
): Promise<{ error: string | null }> {
  // similar pattern: insert note_added with category='custody_transfer_rejected'
  // notify the actor
}

// Phase 1b: actor cancels their own proposal
export async function actorCancelProposalAction(
  publicToken: string,
  reason: string,
): Promise<{ error: string | null }> {
  // similar pattern: insert note_added with category='custody_transfer_cancelled'
  // notify the owner
}
```

#### Paso 5.2 — UI refugio side

Crear `app/org/[orgToken]/mascotas/[publicToken]/devolver-al-dueno/page.tsx`:

```tsx
import { proposeReturnToOwnerAction } from "@/app/actions/return-to-owner";
import { ProposeReturnForm } from "./ProposeReturnForm";
// ... loading + auth guards

// Render form: notes textarea, submit button
// Backed by proposeReturnToOwnerAction
```

#### Paso 5.3 — UI owner side

Crear `app/(app)/mis-mascotas/[publicToken]/devolucion/page.tsx`:

```tsx
import { ownerAcceptReturnAction, ownerRejectReturnAction } from "@/app/actions/return-to-owner";

// Page logic:
// 1. Query latest custody_transfer_proposed pending for this pet + this user
// 2. If none: render "No hay propuestas pendientes" with link back
// 3. If exists: render card with actor info, proposal date, notes, and two buttons:
//    - "Marcar como recibida" (calls ownerAcceptReturnAction)
//    - "Rechazar" (opens form for reason, calls ownerRejectReturnAction)
// 4. If accept returns autoCancelled, render the explanation
```

#### Paso 5.4 — Tests

```ts
describe("proposeReturnToOwnerAction", () => {
  it("emits custody_transfer_proposed and notifies owner", async () => { /* ... */ });
  it("blocks if no shelter_custody for actor", async () => { /* ... */ });
  it("blocks if pet has no active owner", async () => { /* ... */ });
});

describe("ownerAcceptReturnAction with auto-cancel", () => {
  it("happy path: executes transfer, ends shelter_custody, flips status", async () => { /* ... */ });
  it("auto-cancels if actor lost shelter_custody between propose and accept", async () => { /* ... */ });
  it("auto-cancels if pet is deceased", async () => { /* ... */ });
  it("auto-cancels if owner already marked found another way", async () => { /* ... */ });
  it("rejects if no pending proposal", async () => { /* ... */ });
});
```

#### Commit Fase 5

```
feat(lost-found): return-to-owner two-phase handshake with lazy auto-cancel

Adds app/actions/return-to-owner.ts with four server actions:

- proposeReturnToOwnerAction: refugio coordinator or vecino with active
  shelter_custody emits custody_transfer_proposed event targeting the
  pet's original owner. Notifies owner.
- ownerAcceptReturnAction: owner runs preconditions check (5 conditions)
  before executing. If any fails, atomically auto-cancels with
  note_added event + notification to the actor explaining why. On pass,
  emits custody_transferred, ends shelter_custody ownership, flips
  pet.status lost→active.
- ownerRejectReturnAction: owner explicitly rejects with reason.
  note_added event + notification to actor.
- actorCancelProposalAction: actor cancels their own proposal before
  owner responds.

New routes:
- /org/[orgToken]/mascotas/{petToken}/devolver-al-dueno (propose form)
- /mis-mascotas/{token}/devolucion (accept/reject UI)

Notification types: custody_transfer_proposal_owner,
custody_transfer_accepted_owner_side, custody_transfer_auto_cancelled.

Tests cover happy path + all 4 auto-cancel scenarios + cross-actor
permission checks.
```

---

### Fase 6 — Broadcast on lost

#### Paso 6.1 — Helper en `lib/lost-pet-broadcast.ts`

```ts
import { notifications, organizations, organizationCoverage, organizationMemberships } from "@/db";
import { speciesLabel } from "@/lib/format";
import { and, eq, isNull, inArray } from "drizzle-orm";

export async function broadcastLostPet(tx: any /* drizzle tx */, pet: any): Promise<void> {
  const coveringOrgs = await tx
    .select({
      orgId: organizations.id,
      orgName: organizations.displayName,
    })
    .from(organizations)
    .innerJoin(organizationCoverage, eq(organizationCoverage.organizationId, organizations.id))
    .where(
      and(
        eq(organizations.verified, true),
        eq(organizations.status, "active"),
        eq(organizationCoverage.jurisdictionCountry, pet.jurisdictionCountry ?? "AR"),
        eq(organizationCoverage.jurisdictionProvince, pet.jurisdictionProvince),
        eq(organizationCoverage.jurisdictionLocality, pet.jurisdictionLocality),
        inArray(organizations.orgType, ["shelter", "rescue_network"]),
      ),
    );

  if (coveringOrgs.length === 0) return;

  for (const org of coveringOrgs) {
    const members = await tx
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, org.orgId),
          eq(organizationMemberships.receivesBroadcasts, true),
          isNull(organizationMemberships.leftAt),
        ),
      );

    for (const member of members) {
      await tx.insert(notifications).values({
        userId: member.userId,
        notificationType: "lost_pet_broadcast",
        severity: "warning",
        title: `Mascota perdida en ${pet.jurisdictionLocality ?? "tu zona"}`,
        body: buildBroadcastBody(pet),
        relatedPetId: pet.id,
        ctaLabel: "Ver credencial",
        ctaUrl: `/p/${pet.publicToken}`,
      });
    }
  }
}

function buildBroadcastBody(pet: any): string {
  // Intentionally minimal and PII-free. CTA leads to /p/{token} where
  // the owner's disclosure prefs govern visible contact info.
  const parts = [
    `**${pet.name}** — ${speciesLabel(pet.species)}${pet.breed ? `, ${pet.breed}` : ""}.`,
    pet.color ? `Color: ${pet.color}.` : null,
    `Tocá "Ver credencial" para detalles y contacto.`,
  ];
  return parts.filter(Boolean).join("\n");
}
```

#### Paso 6.2 — Integrar en `setPetLostAction`

Después del insert del event y update del pet, ANTES del commit:

```ts
import { broadcastLostPet } from "@/lib/lost-pet-broadcast";

// ... inside the transaction in setPetLostAction:

try {
  await broadcastLostPet(tx, { ...pet, status: "lost" });
} catch (err) {
  // Defensive — never block lost marking on broadcast failure (D8)
  console.error("Broadcast failed:", err);
}
```

#### Paso 6.3 — Tests

```ts
describe("broadcastLostPet", () => {
  it("notifies all members of covering verified shelter orgs", async () => { /* ... */ });
  it("respects receivesBroadcasts=false opt-out", async () => { /* ... */ });
  it("excludes unverified orgs", async () => { /* ... */ });
  it("excludes orgs not covering the pet's locality", async () => { /* ... */ });
  it("returns silently when no covering orgs found", async () => { /* ... */ });
  it("does not block setPetLostAction if helper throws", async () => { /* ... */ });
});
```

#### Commit Fase 6

```
feat(lost-found): broadcast to verified shelters on lost-marking

Adds lib/lost-pet-broadcast.ts which queries verified shelter and
rescue-network orgs covering the pet's jurisdiction (province +
locality match), then fanouts notifications to members who haven't
opted out (receivesBroadcasts=true).

Notification body is minimal and PII-free: name, species, breed,
color, and CTA to /p/{publicToken}. The public credential at that URL
renders contact info per the owner's disclosure preferences — orgs
see exactly the same view as anyone scanning the QR.

setPetLostAction calls the helper inside its transaction. Failure of
the broadcast is logged but does NOT block the lost-marking (D8) —
defensive design ensures the owner's primary action always completes.
```

---

### Fase 7 — Polish opcional

Tres mejoras independientes, cada una un commit:

**Paso 7.1 — Chip format validation**

En `parsePetForm` (`app/actions/pets.ts`) y `parseIntakeForm` (`app/actions/intake.ts`), validar microchip number = 15 dígitos. Si no cumple, error con mensaje claro.

**Paso 7.2 — Rate-limit del FoundPetForm**

En `app/actions/public.ts → notifyOwnerOfFoundPetAction`, agregar un rate-limit por (publicToken, IP hash) → max 1 submission cada 5 min. Implementar con una tabla nueva `public_action_rate_limits` o usando Supabase rate limiting si está disponible.

**Paso 7.3 — Doble confirmación en setPetFoundAction**

Cambiar el botón "Marcar como encontrada" de un form submit directo a un dialog de confirmación ("¿Estás seguro? Esta acción quita el estado de perdida y oculta la información extra de la credencial pública.").

#### Commit Fase 7

```
chore(lost-found): polish — chip format validation, finder rate limit, found confirmation
```

---

## 5. Verificación final (después de las 7 fases)

1. **Typecheck.** `pnpm typecheck`. Cero errores.
2. **Lint.** `pnpm lint`. Cero errores nuevos.
3. **Tests.** `pnpm test`. Todos verdes incluyendo los nuevos.
4. **Build.** `pnpm build`. Compila.
5. **Smoke end-to-end manual** (ver §10 del spec para el happy path completo):
   - Pet sin chip se marca perdida con disclosure prefs custom y enriched description → credencial pública renderiza solo lo que el owner permitió + sección de detalles enriquecidos.
   - Refugio crea intake con chip que matchea pet perdido → bloquea → match flow → confirma → shelter_custody paralela + notification al owner.
   - Refugio propone devolución → owner acepta → custody_transferred + pet status flip a active + shelter_custody ended.
   - Owner marca otro pet como perdido en CABA → broadcast llega a notifications de un member de "Refugio Belgrano" (si está covering Belgrano + receivesBroadcasts=true).
6. **Existing flows no rotos:**
   - Pet registration normal sigue funcionando
   - Welfare report flow no se rompió
   - Org-to-org transfer sigue funcionando
   - El test de cobertura de libreta-sanitaria sigue verde

## 6. Casos borde a manejar (recordatorio del spec §11)

- Pet sin chip + sin descripción rica → credencial pública minimal pero válida
- Owner cambia disclosure prefs mientras pet está lost → render se actualiza
- Chip cargado retroactivamente durante /perdida → microchip_implanted event emitido
- Owner accept con preconditions fallidas → auto-cancel con mensaje
- Dos refugios intentan intake del mismo pet → segundo bloqueado
- Refugio archiva proposal y olvida → owner queda con notification, accept funciona si state válido
- Owner expone email pero auth.users.email vacío → render como si OFF
- Pet matched pero owner desactivado → match registrado pero return flow no se puede iniciar

## 7. Cuando termines

1. Marcá los chequeos de §5 como hechos.
2. Reportá a Nacho:
   - Las 7 fases ejecutadas (o las que hayas hecho, si dividiste por sesión)
   - URLs de prueba del happy path
   - Tests passing (count)
3. Si algo cambió respecto al spec (defaults distintos, copy ajustado, etc.) documentalo explícito en el reporte para que pueda evaluar.

**Si Fase 7 quedó pendiente**, no es bloqueante. Las primeras 6 fases ya entregan el feature funcional. Polish va aparte.
