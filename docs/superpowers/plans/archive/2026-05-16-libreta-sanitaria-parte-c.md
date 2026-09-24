# Libreta Sanitaria — Parte C: Tier-2 shareable

> Plan de implementación para Claude Code. Crea la ruta pública gateada por share token al que el dueño puede mandarle el link a un vet o subir a un trámite. Es el feature que materializa "Owner-issued share link" de `AGENTS.md → Privacy tiers`. Depende de Partes A y B.
>
> **Fecha:** 2026-05-16
> **Owner:** Ignacio Del Valle
> **Tamaño:** ~1 tabla nueva, ~1 migración, ~1 RLS file extendido, ~3 server actions, ~2 rutas nuevas, ~2-3 componentes nuevos
> **Estimación:** 2-3 días
> **Depende de:** Parte A (`2026-05-16-libreta-sanitaria-parte-a.md`) y Parte B (`2026-05-16-libreta-sanitaria-parte-b.md`) mergeadas en main

---

## 0. Antes de tocar nada

Lectura obligatoria:

1. **`AGENTS.md` — sección "Libreta sanitaria"**, especialmente "UI surfaces" #3 (Tier-2 público gateado) y "Tokens" (la separación entre `publicToken` y share token)
2. **`AGENTS.md` — sección "Privacy tiers (the public surface)"** — Tier 2 referencia esta implementación
3. **`db/rls.sql`** — patrón canónico de owner-facing RLS (lectura). Vas a agregar política para `libreta_share_tokens` siguiendo el mismo estilo
4. **`db/migrations/0000_orgs_foundation.sql`** y otras migraciones — patrón de migración (idempotent, comentarios SQL, etc.)
5. **`lib/publicToken.ts`** — entender cómo se generan tokens (formato `DIM-XXXX-XXXX`). Acá generamos `LBR-XXXX-XXXX` con el mismo helper, prefijo distinto
6. **Parte B**: la page de `/libreta` y los componentes `LibretaIdentityHeader` y `LibretaSanitariaView` — los reusamos casi tal cual
7. **`app/p/[publicToken]/page.tsx`** — el patrón existente de ruta pública gateada por token (Tier 0 público). Modelamos la nuestra parecido pero con auth distinto

## 1. Qué es este feature

Una superficie pública (sin auth) accesible vía `/libreta/compartir/{shareToken}` que muestra la libreta sanitaria completa de una mascota — pero gateada por un share token que el dueño generó explícitamente y que **es distinto** del `pets.publicToken`.

**Why distinto.** `publicToken` es Tier-0 y vive para siempre (es la identidad pública de la mascota). El share token es Tier-2 y es:
- **Revocable** en un click
- **Time-limited** (default 30 días, configurable)
- **Bearer credential** — quien tiene el link tiene acceso, sin auth adicional, igual que un share link de Google Docs
- **Per-share** — el dueño puede tener múltiples shares activos al mismo tiempo (uno por vet, etc.)

El dueño obtiene shares desde `/mis-mascotas/{publicToken}/libreta` → botón "Compartir libreta" → modal con opciones de duración, genera el link, copy-to-clipboard. También puede ver sus shares activos y revocarlos desde una sección dedicada.

## 2. Decisiones cerradas (no relitigar)

| # | Decisión | Razón |
|---|---|---|
| D1 | Tabla nueva `libreta_share_tokens` separada de `pets`. **No** se agrega un campo `pets.share_token` | Una mascota puede tener N shares activos a la vez, cada uno con su expiry y revoked state |
| D2 | Token formato `LBR-XXXX-XXXX` (12 chars URL-safe, prefijo distinto del `DIM-` y `PRV-`) generado con el helper existente `generatePublicToken` (se generaliza el helper, ver Paso 1) | Misma resolución de unicidad y misma robustez al brute-force; prefijo distinto hace los logs y debugging instantáneamente identificables |
| D3 | Default expiry 30 días. Opciones predefinidas en la UI: **7 días, 30 días, 90 días, sin vencimiento**. "Sin vencimiento" exige checkbox explícito | Sin vencimiento es legítimo para integraciones con un vet de cabecera, pero la fricción del checkbox previene el accidental forever-share |
| D4 | Hard cap de **5 shares activos por mascota**. Al alcanzar el límite, el form sugiere revocar uno antes de crear nuevo | Limita superficie de ataque sin frenar use cases reales (1 por vet, 1 para guarda canina, 1 para grooming, 1 para emergencia, 1 spare = 5) |
| D5 | El share **NO** es one-shot. Múltiples views por el mismo link son legítimas (WhatsApp screenshot, vet bookmarks el link) | Una libreta no es un secreto absoluto — es un documento que mostrás. One-shot tendría friction sin beneficio |
| D6 | El registro de **cada view** del share token se persiste como `pet_event` de tipo nuevo `libreta_shared_viewed` con payload `{ share_token_id, viewer_ip_hash?, user_agent? }`. Esto es trazabilidad — el dueño puede ver "tu libreta fue vista 4 veces en los últimos 7 días" | Append-only del log inmutable. **El event_type nuevo se declara explícitamente como NON_LIBRETA** — es un event de sistema, no médico, igual que `credential_scanned` |
| D7 | RLS para `libreta_share_tokens`: el owner lee y escribe (genera/revoca) las filas de sus mascotas. **La ruta pública NO lee de la tabla via RLS** — lee via service-role / Drizzle, igual que `/p/{publicToken}` resuelve el pet hoy. Patrón ya establecido en el repo | RLS para PostgREST = solo owner. Server-side reads van por Drizzle bypass intencional. Mismo razonamiento que `AGENTS.md → Aggregation & privacy policy` ya lockea |
| D8 | El share token resolution **valida tres condiciones server-side**: `revoked_at IS NULL`, `expires_at IS NULL OR expires_at > now()`, y que el pet no esté en `status='deceased'` (death silencia los shares) | Death silencia shares para evitar que un link sobreviva al animal y revele historial médico de un ex-pet a un tercero |
| D9 | La página renderizada Tier-2 reusa `LibretaIdentityHeader` y `LibretaSanitariaView` de Parte B **sin modificar nada**. El único cambio visual: header secundario que dice "Generada por MiMAR · {timestamp} · vence {expiry}" y un watermark sutil | Single source of rendering: si Parte B mejora la libreta, Parte C lo hereda gratis |

## 3. Scope

**Dentro:**
- `db/migrations/0007_libreta_share_tokens.sql` (nuevo) — tabla
- `db/schema.ts` (extender) — Drizzle model para `libretaShareTokens` + new event type `libreta_shared_viewed` en `EVENT_TYPES`
- `db/rls.sql` (extender) — policies para `libreta_share_tokens`
- `lib/event-schemas.ts` (extender) — Zod schema para payload de `libreta_shared_viewed`
- `lib/libreta-sanitaria.ts` (extender) — agregar `libreta_shared_viewed` a `NON_LIBRETA_EVENT_TYPES` (mantiene el test verde)
- `lib/publicToken.ts` (extender) — `generateLibretaShareToken()`
- `app/actions/libreta-share.ts` (nuevo) — server actions `createLibretaShareAction`, `revokeLibretaShareAction`, `listOwnerLibretaSharesAction`
- `app/libreta/compartir/[shareToken]/page.tsx` (nuevo) — ruta pública
- `app/libreta/compartir/[shareToken]/ViewLogger.tsx` (nuevo, client component que dispara el log de view via server action `logLibretaShareViewAction`)
- `app/(app)/mis-mascotas/[publicToken]/libreta/SharesManager.tsx` (nuevo) — UI de gestión de shares del owner
- `app/(app)/mis-mascotas/[publicToken]/libreta/page.tsx` (Parte B → tocar) — agregar el botón "Compartir libreta" y montar `<SharesManager>`

**Fuera:**
- Email transaccional / SMS al generar el share (v1 muestra el link copyable; el dueño lo envía donde quiera)
- Customización del link (vanity URLs)
- Analítica más rica que el contador básico de views
- Re-generar el mismo share (siempre se crea uno nuevo; revocar + nuevo, no hay "rotate")
- Tier 0+ (emergency info flag) — eso es un sistema aparte
- QR del share (puede venir en una iteración futura — el copy-link cubre el caso primario)

## 4. Plan paso a paso

### Paso 1 — Generalizar `lib/publicToken.ts`

Hoy `lib/publicToken.ts` tiene `generatePublicToken()` (formato `DIM-XXXX-XXXX`). Generalizar:

```ts
// lib/publicToken.ts

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // unambiguous

function randomChunk(len: number): string {
  // existing implementation, kept
}

/**
 * Generate a prefixed, URL-safe identifier in the format `PREFIX-XXXX-XXXX`.
 * Used for:
 *  - DIM: pet credential public token (pets.public_token)
 *  - PRV: service provider public token (when scheduling lands)
 *  - LBR: libreta share token (Parte C)
 *  - APT: appointment public token (when scheduling lands)
 *
 * Each prefix has its own uniqueness scope (its own table's unique index).
 */
export function generatePrefixedToken(prefix: string): string {
  return `${prefix}-${randomChunk(4)}-${randomChunk(4)}`;
}

// Backward-compat thin wrappers
export function generatePublicToken(): string {
  return generatePrefixedToken("DIM");
}

export function generateLibretaShareToken(): string {
  return generatePrefixedToken("LBR");
}
```

Asegurarse de que cualquier import existente de `generatePublicToken` siga funcionando (no rompemos nada).

### Paso 2 — Migración: tabla `libreta_share_tokens`

```sql
-- db/migrations/0007_libreta_share_tokens.sql
--
-- Tier-2 share tokens for the libreta sanitaria. Each row is one
-- shareable surface created by an owner; revocation is a flag flip,
-- expiry is a timestamp, and views are tracked via the pet_events log
-- (event_type='libreta_shared_viewed') so the share-token table itself
-- stays small.

create table if not exists "public"."libreta_share_tokens" (
  "id"                    uuid primary key default gen_random_uuid(),
  "share_token"           text not null unique,
  "pet_id"                uuid not null references "public"."pets"("id") on delete cascade,
  "created_by_user_id"    uuid not null references "public"."profiles"("id") on delete cascade,
  "label"                 text,                          -- owner-supplied note (e.g. "Para Dra. Pérez")
  "expires_at"            timestamptz,                   -- null = no expiration
  "revoked_at"            timestamptz,
  "revoked_by_user_id"    uuid references "public"."profiles"("id"),
  "view_count_cached"     int not null default 0,        -- denormalized cache of libreta_shared_viewed events for this token
  "last_viewed_at_cached" timestamptz,                   -- ditto
  "created_at"            timestamptz not null default now()
);

create index if not exists "libreta_share_tokens_pet_idx"
  on "public"."libreta_share_tokens" ("pet_id")
  where revoked_at is null;

create index if not exists "libreta_share_tokens_token_idx"
  on "public"."libreta_share_tokens" ("share_token");

-- Reverse rollback (documented, not executed):
-- drop table public.libreta_share_tokens;
```

Aplicar via Supabase Studio. **No `pnpm db:push`** — RLS y triggers viven aparte por el patrón ya documentado.

### Paso 3 — Drizzle model en `db/schema.ts`

Agregar el modelo Drizzle para `libreta_share_tokens` siguiendo el patrón de las otras tablas (camelCase en TS, snake_case en SQL). Y agregar `"libreta_shared_viewed"` al final del array `EVENT_TYPES`.

**Importante:** el test de Parte A va a fallar al agregar el nuevo event_type si no lo clasificás. Agregalo a `NON_LIBRETA_EVENT_TYPES` en `lib/libreta-sanitaria.ts` en el mismo paso.

### Paso 4 — Zod schema del nuevo event type

En `lib/event-schemas.ts`:

```ts
const libretaSharedViewed = z
  .object(
    withVersion({
      share_token_id: z.string().uuid(),
      viewer_ip_hash: z.string().nullable(),
      user_agent: z.string().nullable(),
    }),
  )
  .strict();

// agregar en el record PayloadSchemas:
libreta_shared_viewed: libretaSharedViewed,
```

### Paso 5 — RLS en `db/rls.sql`

Agregar al final del archivo:

```sql
-- libreta_share_tokens — owner reads and writes their own shares only
alter table public.libreta_share_tokens enable row level security;

create policy "owner can read own libreta shares"
  on public.libreta_share_tokens for select
  using (
    created_by_user_id = auth.uid()
    or pet_id in (
      select pet_id from public.ownerships
      where owner_user_id = auth.uid() and ended_at is null
    )
  );

create policy "owner can insert libreta shares for their pets"
  on public.libreta_share_tokens for insert
  with check (
    created_by_user_id = auth.uid()
    and pet_id in (
      select pet_id from public.ownerships
      where owner_user_id = auth.uid() and ended_at is null
    )
  );

create policy "owner can update (revoke) own libreta shares"
  on public.libreta_share_tokens for update
  using (created_by_user_id = auth.uid())
  with check (created_by_user_id = auth.uid());

-- No delete policy: revocation is soft (revoked_at), never hard delete.
```

**Importante:** la **resolución de share_token desde la ruta pública** NO usa estas policies — va por Drizzle (bypass de RLS), igual que `/p/{publicToken}` ya resuelve pets. Las policies son defense-in-depth contra PostgREST.

Aplicar via Studio. Después correr `pnpm rls:smoke` si el repo lo tiene, para validar.

### Paso 6 — Server actions

```ts
// app/actions/libreta-share.ts

"use server";

import { db, libretaShareTokens, ownerships, pets, petEvents } from "@/db";
import { validateEventPayload } from "@/lib/event-schemas";
import { generateLibretaShareToken } from "@/lib/publicToken";
import { createClient } from "@/lib/supabase/server";
import { and, count, eq, isNull, or, gt } from "drizzle-orm";
import { revalidatePath } from "next/cache";

const MAX_ACTIVE_SHARES_PER_PET = 5;

export type CreateShareInput = {
  petPublicToken: string;
  expiresInDays: number | null; // null = no expiration (requires explicit opt-in in UI)
  label: string | null;
};

export type CreateShareResult = { error: string } | { shareToken: string };

export async function createLibretaShareAction(input: CreateShareInput): Promise<CreateShareResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  // Verify pet ownership
  const [petRow] = await db
    .select({ id: pets.id })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, input.petPublicToken),
        eq(ownerships.ownerUserId, user.id),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada o sin permisos." };

  // Check active share cap
  const [{ activeCount }] = await db
    .select({ activeCount: count() })
    .from(libretaShareTokens)
    .where(
      and(
        eq(libretaShareTokens.petId, petRow.id),
        isNull(libretaShareTokens.revokedAt),
      ),
    );
  if (activeCount >= MAX_ACTIVE_SHARES_PER_PET) {
    return { error: `Ya tenés ${MAX_ACTIVE_SHARES_PER_PET} compartidos activos para esta mascota. Revocá uno antes de crear otro.` };
  }

  const shareToken = generateLibretaShareToken();
  const expiresAt = input.expiresInDays === null
    ? null
    : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  await db.insert(libretaShareTokens).values({
    shareToken,
    petId: petRow.id,
    createdByUserId: user.id,
    label: input.label,
    expiresAt,
  });

  revalidatePath(`/mis-mascotas/${input.petPublicToken}/libreta`);
  return { shareToken };
}

export async function revokeLibretaShareAction(shareTokenRowId: string): Promise<{ error: string } | { ok: true }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada." };

  // Drizzle bypasses RLS, so verify ownership manually.
  const [row] = await db
    .select({ petId: libretaShareTokens.petId, createdByUserId: libretaShareTokens.createdByUserId })
    .from(libretaShareTokens)
    .where(eq(libretaShareTokens.id, shareTokenRowId))
    .limit(1);
  if (!row) return { error: "Compartido no encontrado." };

  // Either the creator, or a current owner of the pet, can revoke.
  if (row.createdByUserId !== user.id) {
    const [ownership] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, row.petId),
          eq(ownerships.ownerUserId, user.id),
          isNull(ownerships.endedAt),
        ),
      )
      .limit(1);
    if (!ownership) return { error: "Sin permisos para revocar este compartido." };
  }

  await db
    .update(libretaShareTokens)
    .set({ revokedAt: new Date(), revokedByUserId: user.id })
    .where(eq(libretaShareTokens.id, shareTokenRowId));

  // Find publicToken to revalidate
  const [pet] = await db.select({ publicToken: pets.publicToken }).from(pets).where(eq(pets.id, row.petId)).limit(1);
  if (pet) revalidatePath(`/mis-mascotas/${pet.publicToken}/libreta`);

  return { ok: true };
}

/**
 * Called from the client component on the public Tier-2 page on mount.
 * Idempotently records a view (one event per page load is fine — the
 * counter is cosmetic, not anti-abuse). The token's row update is best-
 * effort; if the share has been revoked between resolution and this
 * call, the update is a no-op.
 */
export async function logLibretaShareViewAction(input: {
  shareToken: string;
  userAgent: string | null;
}): Promise<void> {
  const [row] = await db
    .select({ id: libretaShareTokens.id, petId: libretaShareTokens.petId, revokedAt: libretaShareTokens.revokedAt, expiresAt: libretaShareTokens.expiresAt })
    .from(libretaShareTokens)
    .where(eq(libretaShareTokens.shareToken, input.shareToken))
    .limit(1);
  if (!row) return;
  if (row.revokedAt !== null) return;
  if (row.expiresAt !== null && row.expiresAt < new Date()) return;

  const now = new Date();

  const payload = validateEventPayload("libreta_shared_viewed", {
    share_token_id: row.id,
    viewer_ip_hash: null,        // not collecting IP for now; placeholder for future use
    user_agent: input.userAgent,
  });

  await db.transaction(async (tx) => {
    await tx.insert(petEvents).values({
      petId: row.petId,
      eventType: "libreta_shared_viewed",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: null,
      authorRole: "system",
      payload,
    });

    await tx
      .update(libretaShareTokens)
      .set({
        viewCountCached: tx.$count(libretaShareTokens, eq(libretaShareTokens.id, row.id)) /* placeholder — use raw SQL to atomically increment */,
        lastViewedAtCached: now,
      })
      .where(eq(libretaShareTokens.id, row.id));
    // NOTE: the atomic increment of view_count_cached should use:
    //   set("view_count_cached", sql\`view_count_cached + 1\`)
    // Adapt with the exact Drizzle idiom in this repo.
  });
}
```

**Importante:** verificá la idiom exacta de Drizzle para "increment column" en este repo (busca otros casos de `sql\`... + 1\``). El pseudocódigo arriba es ilustrativo.

### Paso 7 — Ruta pública `/libreta/compartir/[shareToken]/page.tsx`

```tsx
// app/libreta/compartir/[shareToken]/page.tsx

import { db, libretaShareTokens, pets, petEvents, attachments } from "@/db";
import { excludeSelfScansClause } from "@/lib/events";
import { groupLibretaEvents, libretaSanitariaClause } from "@/lib/libreta-sanitaria";
import { petPhotoUrl } from "@/lib/storage";
import { and, desc, eq, isNull, or, gt } from "drizzle-orm";
import { notFound } from "next/navigation";
import { LibretaIdentityHeader } from "@/app/(app)/mis-mascotas/[publicToken]/libreta/LibretaIdentityHeader";
import { LibretaSanitariaView } from "@/app/(app)/mis-mascotas/[publicToken]/libreta/LibretaSanitariaView";
import { ViewLogger } from "./ViewLogger";

export default async function PublicLibretaPage({
  params,
}: {
  params: Promise<{ shareToken: string }>;
}) {
  const { shareToken } = await params;

  // Resolve share token (Drizzle bypasses RLS by design)
  const [share] = await db
    .select({
      id: libretaShareTokens.id,
      petId: libretaShareTokens.petId,
      expiresAt: libretaShareTokens.expiresAt,
      revokedAt: libretaShareTokens.revokedAt,
    })
    .from(libretaShareTokens)
    .where(eq(libretaShareTokens.shareToken, shareToken))
    .limit(1);
  if (!share || share.revokedAt) return <RevokedView />;
  if (share.expiresAt && share.expiresAt < new Date()) return <ExpiredView />;

  // Load pet (including deceased check — D8)
  const [pet] = await db.select().from(pets).where(eq(pets.id, share.petId)).limit(1);
  if (!pet) notFound();
  if (pet.status === "deceased") return <DeceasedView />;

  // Photo
  let photoUrl: string | null = null;
  if (pet.primaryPhotoId) {
    const [a] = await db.select().from(attachments).where(eq(attachments.id, pet.primaryPhotoId)).limit(1);
    photoUrl = petPhotoUrl(a?.storagePath);
  }

  // Libreta events
  const events = await db
    .select()
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), excludeSelfScansClause(), libretaSanitariaClause()))
    .orderBy(desc(petEvents.occurredAt));
  const grouped = groupLibretaEvents(events);

  return (
    <main className="min-h-screen p-6 bg-white">
      <div className="max-w-2xl mx-auto pt-6 pb-20 space-y-6">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 print:hidden">
          Estás viendo la libreta sanitaria de <strong>{pet.name}</strong> con permiso del dueño.
          {share.expiresAt && ` Este enlace vence el ${share.expiresAt.toLocaleDateString("es-AR")}.`}
        </div>

        <LibretaIdentityHeader pet={pet} photoUrl={photoUrl} ownerFirstName={null} />

        <LibretaSanitariaView groupedEvents={grouped} publicToken={pet.publicToken} vista="agrupada" />

        <footer className="text-xs text-neutral-500 pt-8 border-t border-neutral-200">
          <p>Generada por MiMAR · {new Date().toLocaleString("es-AR")}</p>
          {share.expiresAt && <p>El enlace vence el {share.expiresAt.toLocaleString("es-AR")}.</p>}
          <p className="font-mono text-[10px] mt-1">Token: {shareToken}</p>
        </footer>

        <ViewLogger shareToken={shareToken} />
      </div>
    </main>
  );
}

function RevokedView() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-white">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-semibold">Este enlace fue revocado</h1>
        <p className="text-sm text-neutral-600">El dueño desactivó este compartido. Si lo necesitás de nuevo, pedile uno nuevo.</p>
      </div>
    </main>
  );
}

function ExpiredView() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-white">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-semibold">Este enlace venció</h1>
        <p className="text-sm text-neutral-600">El compartido tenía fecha de expiración y ya pasó. Pedile al dueño uno nuevo.</p>
      </div>
    </main>
  );
}

function DeceasedView() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-white">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-2xl font-semibold">Libreta no disponible</h1>
        <p className="text-sm text-neutral-600">Esta libreta sanitaria ya no se comparte públicamente.</p>
      </div>
    </main>
  );
}
```

Y el client component para loggear la view:

```tsx
// app/libreta/compartir/[shareToken]/ViewLogger.tsx
"use client";

import { useEffect } from "react";
import { logLibretaShareViewAction } from "@/app/actions/libreta-share";

export function ViewLogger({ shareToken }: { shareToken: string }) {
  useEffect(() => {
    // Fire once on mount. Doesn't block render. Errors swallowed —
    // this is best-effort telemetry.
    logLibretaShareViewAction({
      shareToken,
      userAgent: navigator.userAgent ?? null,
    }).catch(() => {});
  }, [shareToken]);

  return null;
}
```

### Paso 8 — UI del owner para gestionar shares

En la página `/mis-mascotas/{publicToken}/libreta` (creada en Parte B), agregar un botón "Compartir libreta" en el header y montar `<SharesManager>` debajo (o como modal). El detalle de componente:

```tsx
// app/(app)/mis-mascotas/[publicToken]/libreta/SharesManager.tsx
"use client";

// State local: lista de shares activos del pet (server-fetched and passed as prop),
// botón "Crear compartido nuevo" abre un form con:
//   - Label opcional ("Para Dra. Pérez")
//   - Duración: radios [7 días / 30 días / 90 días / Sin vencimiento]
//   - Si "Sin vencimiento" → checkbox de confirmación
// On submit: server action createLibretaShareAction → success muestra el URL + copy button
// Para cada share existente: nombre/label, fecha de creación, expira / sin vencimiento,
// view_count_cached + last_viewed_at_cached, botón "Revocar" con confirmación.
```

(Implementación canónica, sigue patrón shadcn/tailwind del resto del repo. Te detallo el contrato; la UI fina la armás siguiendo lo que existe.)

Pasos del componente:
1. Recibe `shares: LibretaShare[]` como prop, pasado desde la page server component.
2. Estado `creating: boolean` para el form abierto.
3. `useActionState` para `createLibretaShareAction` y `revokeLibretaShareAction`.
4. Después de crear, mostrar el URL en un `<input readonly>` con un botón "Copiar" usando `navigator.clipboard.writeText`.
5. URL armada client-side: `${window.location.origin}/libreta/compartir/${result.shareToken}`.

## 5. Verificación

1. **Typecheck / lint / build / tests.** Todo verde.
2. **Migración aplicada en local.** En Studio, `select * from libreta_share_tokens` no falla.
3. **RLS smoke.** `pnpm rls:smoke` (si existe) pasa. Si no, manual: con dos cuentas, owner A crea un share de su pet; owner B (otra cuenta) no puede leer `libreta_share_tokens` via PostgREST.
4. **Test de cobertura de Parte A sigue pasando.** El `libreta_shared_viewed` está en `NON_LIBRETA_EVENT_TYPES`.
5. **Smoke manual end-to-end:**
   - Owner crea un share desde `/libreta` → URL aparece → copiar al portapapeles.
   - Abrir URL en una pestaña incógnito (sin auth) → la libreta carga, con el banner amarillo del top.
   - Recargar la pestaña incógnito → en el log del pet aparece un segundo `libreta_shared_viewed` event.
   - Volver a la cuenta del owner → la lista de shares muestra `view_count = 2`, `last_viewed_at` reciente.
   - Owner revoca el share → recargar la pestaña incógnito → ve "Este enlace fue revocado".
   - Crear un share con 7 días → en Studio, set `expires_at = now() - interval '1 day'` para forzar expiración → recargar incógnito → ve "Este enlace venció".
   - Marcar la mascota como deceased (via flujo normal) → recargar incógnito de un share válido → ve "Libreta no disponible".
   - Crear 5 shares, intentar crear un 6to → server action devuelve error explicando el cap.
6. **Owner ve un nuevo evento "libreta_shared_viewed" en `/historial`** (no en `/libreta` — lo declaramos non-libreta). Hay un copy en el historial que describe el evento de forma legible (extender `eventPayloadSummary` si hace falta).

## 6. Casos borde

- **Mascota transferida (custody change) después de generar share.** El share queda asociado al pet, no al user. Si el pet pasa a otro dueño:
  - Por D7 del plan (UPDATE policy con `created_by_user_id = auth.uid()`), el dueño nuevo no puede revocar shares creados por el dueño anterior **vía PostgREST**. Pero el server action `revokeLibretaShareAction` valida ownership current (no solo creator) — el dueño nuevo SÍ puede revocar shares heredados.
  - Considerar: ¿auto-revocar todos los shares al transferir custodia? Mi recomendación: **sí**, en el server action de transferencia de custodia, marcar `revoked_at` con razón "Transferencia de custodia". Eso evita que la libreta del dueño viejo siga visible para terceros bajo el nuevo dueño. **Anotar como follow-up post-MVP, no implementar en este plan** — la transferencia formal de custodia no existe en UI todavía.
- **Mascota lost.** Status sigue `active`, share funciona. Bien.
- **Share creado por el owner A, owner A pierde acceso (DB-side hack o cambio de email).** El owner B (current) ya puede revocar por la lógica de D7 expuesta arriba.
- **Race condition al alcanzar el cap de 5.** Dos shares creados simultáneamente cuando hay 4 activos podrían pasar ambos. **Aceptable** — el cap es soft (UX, no security). Si en producción se ve abuso, agregar un constraint o lock advisory.
- **Share token leaked y vencido pero aún apunta a una mascota.** El handler devuelve `ExpiredView`. La info de la mascota nunca se carga porque el guard está antes del fetch. Bien.
- **Share token a una mascota deceased.** `DeceasedView` se muestra. **No** se loggea la view en `pet_events` — el guard está antes del logger. Bien.

## 7. Cuando termines

1. Marcá los chequeos del paso 5.
2. Commit:
   ```
   feat(libreta): Tier-2 shareable surface — Parte C

   Owner-issued, revocable, time-limited share tokens for the libreta
   sanitaria. Materializes the "Owner-issued share link" tier from
   AGENTS.md → Privacy tiers and the Tier-2 surface from AGENTS.md →
   Libreta sanitaria.

   - New table libreta_share_tokens with RLS for owner read/write
   - New EVENT_TYPES entry libreta_shared_viewed (NON_LIBRETA classified
     to keep coverage test green)
   - Zod schema for the new event payload
   - generateLibretaShareToken() (refactored publicToken generator)
   - Server actions: create / revoke / log-view
   - Public route /libreta/compartir/{shareToken} with proper guards
     (revoked / expired / deceased)
   - Owner-side SharesManager UI in /libreta page
   - 5-share active cap per pet, default 30-day expiry, "sin vencimiento"
     option behind an explicit checkbox

   Reuses LibretaIdentityHeader and LibretaSanitariaView from Parte B
   unchanged — single source of rendering.
   ```
3. Reportá a Nacho:
   - URL del share generado en el smoke test (copyable, abrible en incógnito).
   - Confirmá que la libreta de una mascota deceased no se serve via share.
   - Próximos pasos: ya está toda la libreta sanitaria. Lo siguiente del roadmap es event-agent foundations y/o el piloto de scheduling.
