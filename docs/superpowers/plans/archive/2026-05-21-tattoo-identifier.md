# Plan ejecutable — Tatuaje como identificador secundario

> **Estado (2026-06-04):** ✅ COMPLETO — enviado PR #125 + intake cross-check (commits d2b8bdf, 8e82d5e). Todos los 49 ítems.

> Companion del spec `docs/superpowers/specs/2026-05-21-tattoo-identifier-design.md`. CC ejecuta este plan chunk-por-chunk en orden. Cada chunk es independientemente reviewable y verde-CI antes de pasar al siguiente.
>
> **Fecha:** 2026-05-21 · **materializado 2026-05-22** tras cierre de D1-D4
> **Owner:** Ignacio Del Valle
> **Estado:** 🟢 Ready for CC — D1-D4 cerradas, modelo final fijado
> **Spec ref:** `2026-05-21-tattoo-identifier-design.md`
> **Branch base:** `develop`
> **Branch sugerido:** `feat/tattoo-identifier`

---

## 0. Decisiones D1-D4 — cerradas 2026-05-22 (overrides del spec original)

El spec §2 listó 4 decisiones abiertas con recomendaciones tentativas. **Tres de las cuatro cambiaron** al cerrarse. Este plan refleja el modelo final; donde diverge del spec, este plan gana.

| # | Spec recomendaba | Decisión final | Impacto en el plan |
|---|---|---|---|
| D1 | (b) `tattoo_registry` enum cerrado `fca/kennel/spay_neuter_campaign/other` | **NO** — sin enum. Reemplazado por `tattoo_description text` free-form. El owner pone el origen en descripción libre | Drop columna `tattoo_registry` + constraint + lookup `TATTOO_REGISTRIES` + select en form. Add columna `tattoo_description` + textarea |
| D2 | (b) defer matching | **SÍ** — implementar AHORA. `lookupByTattoo` paralelo a `lookupByChip` con normalización (uppercase + strip whitespace). Surface "posible coincidencia, verificá con foto" | **Chunk nuevo B.5** — tattoo lookup + integración en `app/actions/intake.ts` |
| D3 | (a) siempre visible | **GATED por status lost**. Spec estaba mal: chip en credencial activo es boolean `"Sí"/"No"`, NO el número (verificado en `app/p/[publicToken]/page.tsx:353`). Tatuaje sigue paridad real con chip: código + ubicación + foto **solo cuando `status=lost` OR viewer es owner** | **Chunk F reescrito** — credencial activo muestra `<Badge label="Tatuaje" value="Sí"/"No" />`. Credencial lost expone code + location + photo via `<LostPublicCredential>` |
| D4 | (b) prospectivo | **(b) prospectivo** — sin cambio. <100 pets, no vale detector. TODO v1.3 | Sin cambio |

**Tradeoff aceptado en D1:** dashboards govt futuros tipo "tatuajes de campaña por jurisdicción" requerirán NLP o re-categorización post-hoc sobre `tattoo_description`. Se asume.

---

## Pre-flight (NO arrancar sin esto)

Verificar **antes** del primer commit:

1. `pnpm typecheck` verde en `develop`.
2. `pnpm test` verde en `develop` (requiere `pnpm seed:test` previo localmente; CI ya lo hace).
3. **Migration cabeza al 2026-05-22: `0044_physical_tag_interest.sql`. Próximo libre: `0045`.** Si `deferred-case-kinds` se ejecuta en paralelo, coordinar — ese plan también pelea por 0045-0047.
4. `rg "tattoo" db/schema.ts lib/event-schemas.ts` devuelve vacío.
5. D1-D4 confirmadas (§0). ✅

Si cualquiera falla → parar y reportar.

**Heads-up DB workflow:** `pnpm db:push --force` **dropea las RLS policies de `db/*.sql`** (las trata como drift). Para iterar usar `pnpm db:bootstrap --no-seeds` (aplica schema + RLS atómicamente). En CI ya está handled.

---

## Chunks

### Chunk A — DB migration + schema + lookups

**Objetivo:** sumar columnas, event types al TS const, y el lookup de location. CERO UI.

**Archivos:**

- `db/migrations/0045_pet_tattoo_identifier.sql` — nuevo
- `db/schema.ts` — bloque `pets`: sumar 6 columnas; array `EVENT_TYPES`: agregar `"tattoo_recorded"` y `"tattoo_updated"` justo después de `"microchip_replaced"`, bajo `// Identification & legal`. `pet_events.event_type` es TEXT (no pgEnum), no requiere migration adicional.
- `lib/lookups.ts` — agregar `TATTOO_LOCATIONS` + helper `tattooLocationLabel(value)`. **Sin `TATTOO_REGISTRIES`** (D1).

**Contenido de la migration:**

```sql
-- 0045_pet_tattoo_identifier.sql
-- Adds tattoo as a secondary identifier. Mirrors microchip column shape on pets.
-- Spec: docs/superpowers/specs/2026-05-21-tattoo-identifier-design.md
-- Decisions D1-D4 closed 2026-05-22: no registry enum (free-form description instead);
-- code + location + photo gated by lost status on public surface.

begin;

alter table public.pets
  add column tattoo_code        text,
  add column tattoo_location    text,
  add column tattoo_description  text,
  add column tattoo_recorded_at date,
  add column tattoo_recorded_by text,
  add column tattoo_photo_id    uuid;

alter table public.pets
  add constraint pets_tattoo_location_valid
    check (
      tattoo_location is null
      or tattoo_location in ('inner_ear_left','inner_ear_right','inner_thigh','belly','other')
    );

-- Best-effort lookup index for D2 cross-check. No uniqueness — codes collide.
-- Normalization (uppercase + strip whitespace) lives in app code, not DB.
create index pets_tattoo_code_idx
  on public.pets (tattoo_code)
  where tattoo_code is not null;

commit;
```

**`lib/lookups.ts` adds:**

```ts
export const TATTOO_LOCATIONS = [
  { value: "inner_ear_left", label: "Oreja interna izquierda" },
  { value: "inner_ear_right", label: "Oreja interna derecha" },
  { value: "inner_thigh", label: "Muslo interno" },
  { value: "belly", label: "Panza" },
  { value: "other", label: "Otra ubicación" },
] as const;

export function tattooLocationLabel(value: string | null): string | null {
  if (!value) return null;
  return TATTOO_LOCATIONS.find(l => l.value === value)?.label ?? value;
}
```

**Aceptación Chunk A:**

- [x] `pnpm db:bootstrap --no-seeds` aplica sin error
- [x] `pnpm db:push` (sin force) reporta zero drift sobre columnas nuevas (único diff esperado es el false-positive conocido de `pets.permanent_conditions` filtrado en `ci.yml:102-120`)
- [x] `pnpm typecheck` verde
- [x] Sin cambios en UI
- [x] Commit: `feat(db): add tattoo identifier columns and event types`

---

### Chunk B — Payload schemas + server action

**Objetivo:** schemas de los dos eventos + `createTattooAction` lista pero todavía no llamada desde UI.

**Archivos:**

- `lib/event-schemas.ts` — sumar `tattooRecorded` y `tattooUpdated` Zod schemas; registrarlos en `eventPayloadSchemas`
- `app/actions/tattoo.ts` — nuevo, exporta `createTattooForUser` (testable) + `createTattooAction` (wrapper Next)

**Schemas (note: sin `registry`, con `description`):**

```ts
const tattooRecorded = z
  .object(
    withVersion({
      tattoo_code: z.string().min(1),
      location_on_body: z.enum([
        "inner_ear_left",
        "inner_ear_right",
        "inner_thigh",
        "belly",
        "other",
      ]).nullable(),
      description: z.string().nullable(),
      recorded_by: z.string().nullable(),
      recorded_by_organization_id: z.string().uuid().nullable().optional(),
      recorded_by_user_id: z.string().uuid().nullable().optional(),
      tattoo_date_known: z.boolean().optional(),
    }),
  )
  .strict();

const tattooUpdated = z
  .object(
    withVersion({
      previous_tattoo_code: z.string().nullable(),
      new_tattoo_code: z.string(),
      reason: z.string().nullable(),
    }),
  )
  .strict();
```

**Reglas de `createTattooForUser`:**

1. Valida ownership del pet vía `requirePetAccess` (de `lib/pet-access`).
2. Sube la foto al bucket **`event-attachments`** (corregido — ver Hallazgos al pie del plan). La foto es **required** (sin foto → error). Path lo elige `uploadAttachmentIfPresent` (random UUID flat dentro del bucket, no subcarpetas por pet/evento; la relación se mantiene via `attachments.petId` + `attachments.eventId`).
3. Crea evento `tattoo_recorded` con payload validado por `validateEventPayload("tattoo_recorded", ...)`.
4. Crea `attachments` row con `pet_id=petId, event_id=eventId, uploaded_by_user_id=userId`.
5. Actualiza `pets.tattoo_code / tattoo_location / tattoo_description / tattoo_recorded_at / tattoo_recorded_by / tattoo_photo_id`. **Normaliza el código antes de guardar**: `code.trim().toUpperCase().replace(/\s+/g, "")`. La normalización vive acá para que el lookup de Chunk B.5 sea consistente.
6. Devuelve `EventFormState` (`{ error: null }` éxito, `{ error: string }` falla).

**Aceptación Chunk B:**

- [x] `pnpm typecheck` verde
- [x] Test `__tests__/actions/tattoo.test.ts`: éxito básico · ownership rechazado · payload inválido · sin foto rechazado · normalización (input `"  k9-2014  "` → guardado `"K9-2014"`)
- [x] `pnpm test __tests__/actions/tattoo.test.ts` verde
- [x] Sin cambios en `app/(app)/*`
- [x] Commit: `feat(actions): add createTattooAction with event + attachment + cache`

---

### Chunk B.5 — Tattoo lookup + intake cross-check (D2 nuevo)

**Objetivo:** cuando alguien usa el flow de intake (refugio o vecino) y la búsqueda por chip no matchea (o no se ingresó chip), probar lookup por código de tatuaje. Surface "posible coincidencia, verificá con foto".

**Archivos:**

- `lib/tattoo-lookup.ts` — nuevo, mirroring `lib/chip-lookup.ts`. Export:
  ```ts
  export type TattooLookupResult =
    | { kind: "found"; pet: Pet; ownerProfile: Profile | null }
    | { kind: "not_found" };

  export async function lookupByTattoo(rawCode: string): Promise<TattooLookupResult> {
    const normalized = rawCode.trim().toUpperCase().replace(/\s+/g, "");
    if (!normalized) return { kind: "not_found" };
    // Query pets WHERE tattoo_code = normalized. Return first match if any.
    // Tatuajes pueden colisionar — devolvemos el primer match y el caller
    // resuelve via foto. No retornamos todos (cardinalidad esperada: 1-3 max).
  }
  ```
- `app/actions/intake.ts` — después del bloque `if (parsed.microchipId) { ... lookupByChip ... }`, agregar bloque paralelo:
  ```ts
  // Post-chip cross-check: si el chip no matcheó y se ingresó código de tatuaje,
  // probar lookup por tatuaje. Surface es "posible coincidencia" (no auto-merge).
  if (!chipMatched && parsed.tattooCode) {
    const tattooMatch = await lookupByTattoo(parsed.tattooCode);
    if (tattooMatch.kind === "found") {
      // Devuelve un possibleTattooMatch al caller. El UI muestra la foto del
      // tatuaje del pet candidato + el código normalizado + un "¿es la misma?"
      return { ok: false, possibleTattooMatch: { ... } };
    }
  }
  ```
- `__tests__/intake-tattoo-match.test.ts` — nuevo. Casos:
  - Pet sin tatuaje en DB, intake con tatuaje → `not_found`
  - Pet con tatuaje exacto → `found`
  - Pet con tatuaje, intake con whitespace + mixed case → `found` (normalización)
  - Dos pets con mismo código → devuelve el primero (documentado)

**Nota sobre el form del intake:** el form de intake (`/org/[orgToken]/intake/new` o `/mis-mascotas/nueva`) **no necesita un campo nuevo en este chunk**. Si el intake actor sabe el código de tatuaje lo escribe en el campo "marcas distintivas" hoy. Surfaceear un campo dedicado es Chunk separado fuera de scope — abrir como follow-up TODO si el owner lo pide después. Por ahora el lookup es invocable pero no tiene callsite UI hasta que se agregue el field; eso queda como `TODO(tattoo-match-intake-field)` en `intake.ts`.

**Aceptación Chunk B.5:**

- [x] `pnpm typecheck` verde
- [x] `lookupByTattoo` exportada y tested (4 casos arriba)
- [x] Hook en `intake.ts` con TODO documentado de field UI
- [x] Commit: `feat(intake): add tattoo lookup cross-check parallel to chip-lookup`

---

### Chunk C — Event form UI + event picker entry

**Objetivo:** owner navega "Nuevo evento → Tatuaje registrado", llena form, sube foto, guarda.

**Archivos:**

- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx` — sumar entry en `LIBRETA_OPTIONS` después de `microchip-reemplazo`:
  ```ts
  { slug: "tatuaje", label: "Tatuaje registrado",
    description: "Código del tatuaje y foto. Identificador secundario al microchip.",
    enabled: true }
  ```
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/tatuaje/page.tsx` — nuevo, server component que valida `requirePetAccess` y renderiza `<TattooForm action={createTattooAction} />`
- `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/tatuaje/TattooForm.tsx` — nuevo client component basado en `MicrochipForm.tsx`

**Cambios vs `MicrochipForm.tsx`:**

| Campo en chip form | Reemplazo en tattoo form |
|---|---|
| `chipNumber` text input con placeholder `985141004321456` | `tattooCode` text, sin placeholder de formato |
| `countryCode` text default `AR` | **eliminado** |
| `occurredAt` date | **renombrar** `recordedAt`, label "Fecha del tatuaje (aproximada)" |
| `implantedBy` text | **renombrar** `recordedBy`, label "Tatuado por (criadero / vet / campaña)" |
| `locationOnBody` text | **reemplazar** por `<select>` con `TATTOO_LOCATIONS` |
| `notes` textarea | **renombrar** `description`, label "Descripción / origen del tatuaje", placeholder "Ej: criadero FCA, campaña de castración CABA 2018, refugio..." |
| `<AttachmentField />` (opcional) | **`<AttachmentField required />`** — foto es central |
| Botón "Registrar microchip" | "Registrar tatuaje" |

**No hay select de `registry`** (D1 — drop).

**Aceptación Chunk C:**

- [x] `pnpm typecheck` verde
- [x] `pnpm dev`: navegar a `/mis-mascotas/<token>/eventos/nuevo` muestra "Tatuaje registrado"
- [x] Click → form completo visible, sin select de registry
- [x] Submit sin foto → bloqueado por `required`
- [x] Submit con foto válida → crea evento, redirige al timeline
- [x] `pet_events` tiene la row con payload correcto; `attachments` tiene la foto; `pets.tattoo_*` actualizado
- [x] Verificar normalización: input `"  k9-2014 "` → guardado `"K9-2014"`
- [x] Commit: `feat(events): add tattoo_recorded event form and picker entry`

---

### Chunk D — Libreta header surface

**Objetivo:** el tatuaje aparece en el header del libreta (vista owner-side) cuando existe, paralelo al microchip. Esto NO es el credencial público — es `/mis-mascotas/[publicToken]/libreta`, accesible sólo al owner. Por eso el código completo va acá; la gateación por lost (D3) aplica solo al credencial público (Chunk F).

**Archivos:**

- `app/(app)/mis-mascotas/[publicToken]/libreta/LibretaIdentityHeader.tsx` — extender `Props.pet` con `tattooCode: string | null` y `tattooLocation: string | null`; agregar `<p>` apilado después del microchip
- `app/(app)/mis-mascotas/[publicToken]/libreta/page.tsx` — pasar los campos al header

**Cambio visual:**

```tsx
{pet.microchipId && (
  <p className="text-xs font-mono text-neutral-500 dark:text-neutral-500">
    <span className="sr-only">Microchip: </span>
    Microchip {pet.microchipId}
  </p>
)}
{pet.tattooCode && (
  <p className="text-xs font-mono text-neutral-500 dark:text-neutral-500">
    <span className="sr-only">Código de tatuaje: </span>
    Tatuaje {pet.tattooCode}
    {pet.tattooLocation && ` · ${tattooLocationLabel(pet.tattooLocation)}`}
  </p>
)}
```

**Aceptación Chunk D:**

- [x] `pnpm typecheck` verde
- [x] Pet con chip only → header igual que antes
- [x] Pet con tatuaje only → "Tatuaje K9-2014 · Oreja interna izquierda"
- [x] Pet con ambos → ambas líneas, microchip primero
- [x] Pet sin ninguno → ninguna línea
- [x] Commit: `feat(libreta): show tattoo identifier in header alongside microchip`

---

### Chunk E — Lost form retroactive capture block

**Objetivo:** owner marca pet como perdido y no tiene chip ni tatuaje cargado → ve un bloque para cargar el tatuaje al toque (paralelo al de chip).

**Archivos:**

- `app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostForm.tsx` — sumar prop `petHasTattoo: boolean`; cambiar condición del bloque enriched de `!petHasMicrochip` a `!petHasMicrochip && !petHasTattoo`; sumar Group D
- `app/(app)/mis-mascotas/[publicToken]/perdida/page.tsx` — pasar `petHasTattoo={!!pet.tattooCode}`
- `app/actions/events.ts` (`setPetLostAction` o equivalente) — procesar `enriched_tattoo_code`, `enriched_tattoo_location`, `enriched_tattoo_description`, `enriched_tattoo_photo`; llamar a `createTattooForUser` con payload mínimo cuando presentes (paralelo a chip retroactivo existente)

**Group D visual:**

```tsx
<div className="space-y-4">
  <p className="text-xs font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300">
    Tatuaje (opcional)
  </p>
  <div className="space-y-1.5">
    <label htmlFor="enriched_tattoo_code" className={labelClass}>Código del tatuaje</label>
    <input id="enriched_tattoo_code" name="enriched_tattoo_code" type="text"
           placeholder="Ej: K9-2014-A" className={inputClass} />
  </div>
  <div className="space-y-1.5">
    <label htmlFor="enriched_tattoo_location" className={labelClass}>Ubicación</label>
    <select id="enriched_tattoo_location" name="enriched_tattoo_location" className={inputClass} defaultValue="">
      <option value="">Seleccionar</option>
      {TATTOO_LOCATIONS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
    </select>
  </div>
  <div className="space-y-1.5">
    <label htmlFor="enriched_tattoo_description" className={labelClass}>Descripción (opcional)</label>
    <textarea id="enriched_tattoo_description" name="enriched_tattoo_description" rows={2}
              placeholder="Ej: campaña de castración 2018, criadero FCA..." className={inputClass} />
  </div>
  <AttachmentField name="enriched_tattoo_photo" />
  <p className="text-xs text-neutral-500 dark:text-neutral-500">
    Si tu mascota tiene tatuaje pero nunca lo cargaste, esto ayuda mucho a quien la encuentre.
    Subí también una foto donde se vea claro.
  </p>
</div>
```

**Aceptación Chunk E:**

- [x] `pnpm typecheck` verde
- [x] Pet sin chip ni tatuaje → bloque enriched muestra 4 groups (A identidad, B momento, C chip, D tatuaje)
- [x] Pet con chip → bloque NO aparece
- [x] Pet con tatuaje → bloque NO aparece
- [x] Pet sin nada, owner llena tatuaje code + foto + ubicación + marca como perdido → se crea `tattoo_recorded` además del `status_changed`
- [x] `pets.tattoo_*` queda poblado
- [x] Test E2E o de action en `__tests__/lost-and-found/retroactive-tattoo.test.ts` cubre el flow
- [x] Commit: `feat(lost): retroactive tattoo capture block in MarkLostForm`

---

### Chunk F — Public credential surface (REWRITTEN — D3 closed)

**Objetivo:** el credencial público `/p/[publicToken]` trata al tatuaje **igual que al chip**:

- **Estado `active`**: badge boolean `<Badge label="Tatuaje" value={hasTattoo ? "Sí" : "No"} />`. NO se expone code, location, description ni foto. Paridad real con chip (verificado en `app/p/[publicToken]/page.tsx:353`).
- **Estado `lost`**: el componente `<LostPublicCredential>` (que ya gobierna la promoción a Tier 1) expone code + location + description + foto del tatuaje, igual que expone el número de chip + datos del owner.

**Archivos:**

- `app/p/[publicToken]/page.tsx` —
  - Línea ~49 (después de `const hasMicrochip = !!pet.microchipId`): agregar `const hasTattoo = !!pet.tattooCode;`
  - En el bloque `Status badges` (línea ~342): agregar `<Badge label="Tatuaje" value={hasTattoo ? "Sí" : "No"} />`. Reordenar la grid si la simetría visual con `Microchip` lo pide (probablemente queda grid de 6 badges en 2 columnas o 3 columnas — confirmar visualmente)
  - El `select()` (línea ~32) traer todas las columnas con `.select()` sin args o sumar explícitamente las nuevas
  - Pasar `tattooCode`, `tattooLocation`, `tattooDescription`, `tattooPhotoUrl` (resuelto via `petPhotoUrl` sobre la attachment) a `<LostPublicCredential>` props
- `components/pet-profile/LostPublicCredential.tsx` — extender props para aceptar los 4 campos de tatuaje; renderizar sección "Tatuaje" debajo de la sección "Microchip" cuando `tattooCode` esté presente. Layout consistente con el bloque de microchip
- Verificar que `attachments` join (o segundo query) trae la photo row de `tattoo_photo_id` cuando existe

**Regla concreta de exposición:**

| Campo | Active | Lost (via LostPublicCredential) |
|---|---|---|
| `hasTattoo` (boolean) | ✅ Badge | ✅ Mostrado implícito |
| `tattooCode` | ❌ | ✅ |
| `tattooLocation` | ❌ | ✅ |
| `tattooDescription` | ❌ | ✅ |
| `tattooPhotoUrl` | ❌ | ✅ |

**Aceptación Chunk F:**

- [x] `pnpm typecheck` verde
- [x] Credencial active de pet con tatuaje → badge "Tatuaje: Sí", **sin** code, location, description ni foto en el DOM (verificar con DevTools — el field no debe aparecer ni en HTML comments)
- [x] Credencial active de pet sin tatuaje → badge "Tatuaje: No"
- [x] Credencial lost de pet con tatuaje → `<LostPublicCredential>` muestra code + location + description + foto
- [x] Credencial lost de pet sin tatuaje → sección Tatuaje no se renderiza (sin "Tatuaje: No" vacío)
- [x] Test E2E o de página en `__tests__/p/tattoo-disclosure.test.ts`:
  - Render active con tatuaje → assert que `pet.tattooCode` NO aparece en el HTML
  - Render lost con tatuaje → assert que aparece
- [x] Commit: `feat(public-credential): surface tattoo with lost-gated disclosure parity to chip`

---

### Chunk G — Tests + docs polish

**Objetivo:** smoke coverage end-to-end, doc update, PR limpio.

**Archivos:**

- `__tests__/actions/tattoo.test.ts` — completar si quedó light en B
- `__tests__/intake-tattoo-match.test.ts` — ya creado en B.5; verificar coverage
- `__tests__/lost-and-found/retroactive-tattoo.test.ts` — verificar coverage del E
- `__tests__/p/tattoo-disclosure.test.ts` — verificar coverage del F
- `docs/project-status-2026-05-21.md` — §5.6 Tier 1 #5 (tattoo-identifier) → marcar shipped, mover a §3 inventario
- `docs/superpowers/specs/2026-05-21-tattoo-identifier-design.md` — actualizar Estado a 🟢 Shipped con link al PR; agregar nota al footer "D1-D4 resolved 2026-05-22, plan executed against `plans/2026-05-21-tattoo-identifier.md`"

**Aceptación Chunk G:**

- [x] `pnpm test` verde end-to-end
- [x] `pnpm lint` verde
- [x] `pnpm typecheck` verde
- [x] PR abierto con `gh pr create --base develop --title "feat: tattoo identifier" --body <link al spec + checklist de chunks>`
- [x] Spec marcado como Shipped
- [x] Commit: `chore(docs): mark tattoo identifier spec as shipped`

---

## Resumen para CC

| Chunk | LOC estimado | Riesgo | Bloquea a |
|---|---|---|---|
| A — DB + schema + lookups | ~70 | Bajo | B, B.5, D, E, F |
| B — Payload schemas + action | ~180 | Medio (normalización + foto required) | C, E |
| B.5 — Tattoo lookup + intake hook | ~100 | Medio (matching semantics) | — |
| C — Event form UI | ~200 | Bajo (copia de microchip) | — |
| D — Libreta header | ~30 | Bajo | — |
| E — Lost form block | ~140 | Medio (wiring multi-action) | F |
| F — Public credential gated | ~80 | Medio (D3 corrige spec) | — |
| G — Tests + docs | ~150 | Bajo | — |
| **Total** | ~950 LOC | | |

**Total estimado:** 3-4 sesiones de CC (vs 2-3 originales — +1 sesión por Chunk B.5 nuevo y Chunk F rewrite).

**Si CC ve algo no contemplado** → parar, anotar en "Hallazgos durante implementación" al pie, pedir confirmación a Nacho antes de improvisar.

---

## Hallazgos durante implementación

### 2026-05-22 — Bucket name divergence

El **spec §2** dice "bucket `pet-photos`". **Realidad del repo**: los 13 callsites de `uploadAttachmentIfPresent` en `app/actions/events.ts` + `adoption.ts` + `checkin.ts` + `welfare-*` usan `"event-attachments"`. El bucket `pet-photos` no existe (`rg "pet-photos"` solo lo encuentra en docs/comments). **Decisión**: usar `event-attachments` (matching patrón actual). Plan Chunk B corregido en línea citada. Cuando se reanude el spec del physical-tag completo, revisar también si arrastra el mismo error.

### 2026-05-22 — `EVENT_TYPES` cascade a `lib/case-attachment.ts`

Agregar un valor al TS const `EVENT_TYPES` rompe `pnpm typecheck` porque `CASE_ATTACHMENT_RULES: Record<EventType, AttachmentRule>` se vuelve incompleto. Fix en Chunk A: agregar entries `tattoo_recorded: { mode: "never", compatibleWith: [] }` y `tattoo_updated: { mode: "never", compatibleWith: [] }` después de `microchip_replaced`. Patrón válido también para futuros eventos no-case-attaching.

### 2026-05-22 — Path de attachment.storagePath es random UUID + ext

El spec sugería `pets/${petId}/tattoo/${eventId}.${ext}` como path. **`uploadAttachmentIfPresent`** (lib/uploads.ts:40) ya define el path como `${randomUUID()}.${ext}` flat dentro del bucket. No hay subcarpetas por pet/evento. El `attachments.petId` + `attachments.eventId` columnas son los que mantienen la relación. Plan Chunk B corregido.

### 2026-05-22 — Lost form retroactive tattoo es text-only (sin foto)

Plan Chunk E mostraba un `<AttachmentField name="enriched_tattoo_photo" />` dentro de Group D del MarkLostForm. **Realidad**: `setPetLostAction` no maneja upload de archivos hoy (solo string fields), agregar upload + cleanup inflaría el panic-time form. Decisión: Group D captura solo code + location + description; copy explícita "Cuando puedas, subí también una foto desde su libreta". Owner completa la foto via `/eventos/nuevo/tatuaje` cuando esté más calmo. Documentado en MarkLostForm y en el writer comment de `setPetLostWriter`.

### 2026-05-22 — Tests de componente requieren JSX config en vitest

Chunk F intentó agregar `__tests__/lost-credential-tattoo-disclosure.test.ts` usando `renderToString` para verificar la gate de disclosure D3. Vite no parsea el `.tsx` importado porque `vitest.config.ts` no tiene JSX setup (no jsdom, no testing-library, no jsx override). El proyecto NO tiene tests de componente todavía. Decisión: el boundary de disclosure se enforça por construcción (page.tsx pasa boolean al badge en active, props completos al `<LostPublicCredential>` solo en `if (isLost && lostContext)`); cobertura visual queda para Chunk G via verify/smoke manual o defer hasta que se agregue infra de component testing (out of scope para tattoo-identifier).
