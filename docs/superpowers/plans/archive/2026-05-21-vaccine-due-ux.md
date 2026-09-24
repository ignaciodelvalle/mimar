# Vaccine-due UX — plan ejecutable (Chunk C)

> **Fecha:** 2026-05-21
> **Owner:** Ignacio Del Valle
> **Audiencia:** Claude Code (input directo)
> **Estimación:** ~3 días (C0 incluido en este doc)
> **Origen:** `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` §Chunk C
> **Design spec:** `dim-interno:docs/design/06-vaccine-due.md`
> **Decisiones cerradas:** `docs/superpowers/plans/2026-05-21-pending-decisions-resolved.md` §Chunk C + §CX-1

---

## Resumen ejecutivo

Chunk C construye la capa de recordatorios de vacunas visible al owner: cinco variantes visuales de `<ReminderCard>`, lógica de throttling por variante en el cron existente, y las superficies `/inicio`, `/mis-mascotas`, `/mis-mascotas/[publicToken]`, `/mis-mascotas/[publicToken]/vacunas` y `/notificaciones`. También define el helper puro `lib/vaccine-reminder-state.ts` con la lista hardcodeada de vacunas reportables (C-D2) y construye `<Badge>` como primitiva compartida (C-D1, ya shippeada en PR #93). El DoD completo se define al final del documento.

---

## Decisiones cerradas (copia verbatim del owner)

### C-D1. Build `<Badge>` now

**Q:** Build `<Badge>` as part of Chunk C, or compose inline and extract later?
**A:** Build now.
**Implications:**
- Add `components/poncho/Badge.tsx` to Chunk C's file list (already noted as conditional in `dim-interno:docs/design/06-vaccine-due.md` §G).
- Use the shape confirmed in C-D4 below: pill with optional icon + `variant` prop (`info | success | warning | danger | neutral`).
- Export from `components/poncho/index.ts` so Chunk E + Tier 7 specs can import without a follow-up extraction PR.
- Cost: ~30-45 min added to Chunk C; amortized across at least 5 downstream consumers.

✅ Shippeada en PR #93 (Chunk A.5). No se re-implementa — se importa.

### C-D2. `isReportable` lookup — hardcoded now

**Q:** Hardcoded list in `lib/vaccine-reminder-state.ts` with TODO toward the future ENO catalog, or wait for ENO spec to land?
**A:** Build now (hardcoded).
**Implications:**
- `lib/vaccine-reminder-state.ts` includes a `const REPORTABLE_VACCINES_BY_SPECIES` map (dog: rabia, parvo, distemper; cat: rabia, panleucopenia) with a comment linking to AGENTS.md zoonosis registry.
- Add a TODO above the constant referencing `2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md` so the future ENO PR knows to swap this for a `getReportableVaccines(species, jurisdiction)` import from `lib/disease-public-alert-catalog.ts`.
- Public API stays a function — call sites pass `(species, jurisdiction)` even though jurisdiction is unused today, so the future swap is non-breaking.

### Primitivas disponibles (PR #93 / Chunk A.5)

Asumir PR #93 mergeado antes de iniciar C1.

| Primitiva | Uso en Chunk C |
|---|---|
| `<Badge>` | `<PetCard>` badge de estado + `<ReminderCard>` badge de variant |
| `<EmptyState>` | Vacunas history vacía en `/mis-mascotas/[publicToken]/vacunas` |
| `<Panel>` / `<PanelHeader>` / `<PanelBody>` | Wrapper de `<RemindersSection>` y `<VacunasTimeline>` |
| `<Tabs>` / `<TabsContent>` | Filtro por categoría en `/notificaciones` |
| `<Alert>` | Aviso sobre `overdue_critical` en `<ScheduleReminderForm>` |

---

## Hallazgo de implementación: gaps de schema para C2

Antes de ejecutar C2, el schema tiene dos gaps respecto al spec:

1. **`notifications.category` no existe.** El spec §B.1 define `category: 'health'` para las notifs de vacunas. La tabla `notifications` solo tiene `notificationType` (free text). C2 requiere una migración que agregue `category text` nullable — o bien usar el prefijo del `notificationType` (e.g. `'vaccine_due'` → categoría inferida en la query) para el filtro de tabs. Decisión tomada aquí: **agregar columna `category` en la migración de C2** para no acoplar la UI a string matching sobre `notificationType`.

2. **`reminders` no tiene columnas de throttling.** La tabla no tiene `lastNotifiedAt`, `snoozeCount`, ni `snoozedUntil`. El cron actual deduplica una sola vez por `relatedEventId`. Los throttling rules del spec (weekly para `upcoming`, daily→cada-3d para `due_soon`, daily→weekly para `overdue`, daily indefinido para `overdue_critical`) requieren consultar el timestamp de la última notif emitida por reminder. Solución en C2: **leer `MAX(created_at)` de `notifications WHERE related_reminder_id = $id`** sin nueva columna, ya que `notifications.relatedReminderId` existe y es indexable. El campo `snoozedUntil` (posponer) sí requiere una columna en `reminders` — ver C2.

---

## Pre-work (C0) — completado al escribir este doc

- [x] Spec leída y resumida arriba.
- [x] Decisiones C-D1 y C-D2 copiadas verbatim.
- [x] Primitivas de PR #93 confirmadas como dependencia.
- [x] Cron `app/api/cron/vaccine-due/route.ts` leído — llama a `runVaccineDueScan()` en `lib/notifications.ts`.
- [x] `runVaccineDueScan()` leída — dedupe actual via `relatedEventId` + `notificationType = 'vaccine_due'`, ventana fija 7d ahead + 1d backward grace. No tiene throttling por variante.
- [x] Gaps de schema identificados (ver sección anterior).
- [ ] Próximo paso: ejecutar C1.

---

## C1 — Componente core: `<ReminderCard>` + helper de estado (~0.5d)

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `lib/vaccine-reminder-state.ts` | NEW | Helper puro: dado `daysUntilDue` + `vaccineName` + `species`, retorna `variant` + `isReportable`. |
| `components/poncho/ReminderCard.tsx` | NEW | 5 variantes (upcoming/due_soon/overdue/overdue_critical/success). Usa `<Panel>`, `<Badge>` de PR #93. |
| `components/poncho/index.ts` | MODIFY | Exportar `ReminderCard`. |
| `__tests__/vaccine-reminder-state.test.ts` | NEW | Unit tests del helper (lógica pura, sin DOM). |

> **Nota sobre testing de componentes:** El repo no tiene `@testing-library/react` ni jsdom/happy-dom. Todos los tests existentes son integration contra Postgres. Para `<ReminderCard>` y todos los demás componentes nuevos de Chunk C, **no** se escriben render tests — la verificación visual queda en checks manuales documentados en el DoD de cada fase. Si en el futuro se setea infra de component testing (decisión fuera del alcance de Chunk C), retroactivamente se pueden agregar. Misma convención que `Button.tsx` (sin tests).

### Variantes de `<ReminderCard>` (spec §A.1)

| Variant | Threshold `daysUntilDue` | Border | `<Badge>` variant | Status text (ejemplo) | `role` |
|---|---|---|---|---|---|
| `upcoming` | 8–14d | `border-l-gob-info` | `info` | "Próxima — vence en 12 días" | (ninguno) |
| `due_soon` | 1–7d | `border-l-gob-warning` | `warning` | "Vence pronto — quedan 5 días" | (ninguno) |
| `overdue` | 0 a -30d | `border-l-gob-danger` | `danger` | "Vencida hace 8 días" | (ninguno) |
| `overdue_critical` | < -30d AND reportable | `border-l-gob-danger bg-gob-danger/5` | `danger` | "Vencida hace 45 días — obligatoria" | `alert` |
| `success` | (completada) | `border-l-gob-success` | `success` | "✓ Registrada" | (ninguno) |

> **Nota spec §A.1:** `overdue_critical` requiere que la vacuna sea reportable (`isReportable = true`). Si está vencida >30d pero NO es reportable, sigue siendo `overdue`. La distinción impacta el CTA ("Reservar urgente" vs "Reservar urgente") y el `role="alert"`.

> **Accesibilidad spec §A.1 y §F:** `<ReminderCard>` es un `<article>` con `aria-labelledby` al título. `overdue_critical` agrega `role="alert"`. "Posponer" button lleva `aria-label="Posponer recordatorio 7 días"`. Animación de pulse en critical vive en el consumer (ver C3 §PetCard badge), NO dentro de `<ReminderCard>` — consistente con E-D4 (Badge sin animación bakeada).

### `lib/vaccine-reminder-state.ts` — shape

```ts
// Shared helper: pure functions to derive ReminderCard display state.
// No DB access — all inputs are pre-loaded by the call site.

export type ReminderVariant =
  | "upcoming"
  | "due_soon"
  | "overdue"
  | "overdue_critical"
  | "success";

/**
 * Derive the display variant from days until due.
 * daysUntilDue < 0 means overdue.
 * Pass isReportable=true only for vaccines in REPORTABLE_VACCINES_BY_SPECIES.
 */
export function getReminderVariant(
  daysUntilDue: number,
  isReportable: boolean,
): ReminderVariant {
  if (daysUntilDue >= 8) return "upcoming";
  if (daysUntilDue >= 1) return "due_soon";
  if (daysUntilDue > -30) return "overdue";
  // > 30 days overdue
  return isReportable ? "overdue_critical" : "overdue";
}

// TODO(eno): swap for getReportableVaccines(species, jurisdiction) imported
// from lib/disease-public-alert-catalog.ts once
// docs/superpowers/specs/2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md ships.
// Public API already accepts jurisdiction so the swap is non-breaking (C-D2).
const REPORTABLE_VACCINES_BY_SPECIES: Record<string, readonly string[]> = {
  dog: ["rabia", "parvo", "distemper"],
  cat: ["rabia", "panleucopenia"],
};

export function getReportableVaccines(
  species: string,
  _jurisdiction: string,
): readonly string[] {
  return REPORTABLE_VACCINES_BY_SPECIES[species] ?? [];
}

export function isVaccineReportable(
  vaccineName: string,
  species: string,
  jurisdiction: string,
): boolean {
  const reportable = getReportableVaccines(species, jurisdiction);
  return reportable.some((v) =>
    vaccineName.toLowerCase().includes(v.toLowerCase()),
  );
}
```

### Tests — C1

Unit `__tests__/vaccine-reminder-state.test.ts` (lógica pura, sin DOM):

- `getReminderVariant(14, false)` → `"upcoming"`.
- `getReminderVariant(7, false)` → `"due_soon"`.
- `getReminderVariant(-1, false)` → `"overdue"`.
- `getReminderVariant(-30, false)` → `"overdue"` (boundary — -30d todavía es overdue, no critical).
- `getReminderVariant(-31, true)` → `"overdue_critical"`.
- `getReminderVariant(-31, false)` → `"overdue"` (no reportable → no critical).
- `getReportableVaccines("dog", "CABA")` → incluye `"rabia"`.
- `getReportableVaccines("fish", "CABA")` → `[]`.
- `isVaccineReportable("Antirrábica", "dog", "CABA")` → `true` (substring match case-insensitive).

Verificación visual de `<ReminderCard>` (manual durante C3 cuando se integre en `/inicio`):
- Cada variante muestra el border-color esperado.
- `overdue_critical` tiene `role="alert"` (inspeccionar en DevTools).
- `success` no muestra botones de acción.

### DoD — C1

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test -- vaccine-reminder-state` pasan.
- [ ] `<ReminderCard>` exportado desde `components/poncho/index.ts` sin errores de typecheck.

---

## C2 — Cron logic con throttling por variante (~0.75d)

### Archivos a crear / modificar

| Path | Acción | Razón |
|---|---|---|
| `db/migrations/XXXX_add_reminders_snooze_and_notifications_category.sql` | NEW | Columna `snoozed_until timestamptz` + `snooze_count int default 0` en `reminders`; columna `category text` en `notifications`. |
| `db/schema.ts` | MODIFY | Agregar `snoozedUntil`, `snoozeCount` en `reminders`; `category` en `notifications`. |
| `lib/notifications.ts` | MODIFY | Reescribir `runVaccineDueScan()` con throttling por variante. Mantener `runPostAdoptionCheckinScan()` intacta. |
| `app/api/cron/vaccine-due/route.ts` | NO CHANGE | Ya delega a `runVaccineDueScan()` — no necesita cambios si la firma se mantiene. |
| `__tests__/vaccine-due-scan.test.ts` | NEW | Tests de throttling por variante + anti-spam keys. |

### Migración — columnas nuevas

```sql
-- Reminders: snooze support (spec §E: cap 3×7d, luego 30d cooldown)
ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS snooze_count integer NOT NULL DEFAULT 0;

-- Notifications: category for tab filtering (spec §D)
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS category text;

-- Index para la query de tabs en /notificaciones
CREATE INDEX IF NOT EXISTS notifications_user_category_idx
  ON notifications (user_id, category)
  WHERE archived_at IS NULL;
```

> Drizzle migration: `pnpm drizzle-kit generate` después de editar `db/schema.ts`.

### Reglas de throttling por variante (spec §B.1)

| Variante del reminder | Throttle rule | Derived from |
|---|---|---|
| `upcoming` (8–14d ahead) | 1 notif por semana (7d entre notifs) | spec §B.1 anti-spam bullet 1 |
| `due_soon` (1–7d ahead) | 1 notif/día primeros 3 días desde que entra en due_soon; luego cada 3 días | spec §B.1 bullet 2 |
| `overdue` (0–30d vencida) | 1 notif/día primeras 2 semanas; luego semanal | spec §B.1 bullet 3 |
| `overdue_critical` (>30d vencida, reportable) | 1 notif/día indefinido hasta `completedAt` o snooze | spec §B.1 bullet 4 |

### Anti-spam key pattern

La deduplicación usa `notifications.relatedReminderId` (ya existe en schema). La lógica de throttling consulta:

```sql
SELECT MAX(created_at) AS last_notif_at
FROM notifications
WHERE related_reminder_id = $reminderId
  AND notification_type LIKE 'vaccine_%'
  AND archived_at IS NULL
```

Con ese `last_notif_at` y la variante computada por `getReminderVariant()`, el cron evalúa si `now - last_notif_at >= minIntervalForVariant`.

### `runVaccineDueScan()` — nueva firma y comportamiento

La función mantiene la misma firma externa `(dbInstance?, options?) => Promise<VaccineDueScanResult>` para que `route.ts` no cambie. Internamente:

1. Ampliar la ventana de query: de `[now-1d, now+7d]` a `[now-∞, now+14d]` — todos los reminders activos sin `completedAt`, incluyendo overdue indefinidamente. Los que llevan más de 30d vencidos se clasifican como `overdue_critical` si son reportables.
2. Para cada candidate, computar `daysUntilDue` y `variant` via `getReminderVariant()`.
3. Consultar `MAX(created_at)` de notifs relacionadas (anti-spam query arriba).
4. Aplicar throttle rule de la tabla de arriba. Skip si `now - last_notif_at < minInterval`.
5. Si pasa el throttle:
   - Insertar `notifications` con `notificationType = 'vaccine_due'`, `category = 'health'`, `severity` según variante (tabla abajo), y `relatedReminderId`.
   - CTA: `ctaUrl = /mis-mascotas/${publicToken}`, `ctaLabel = ctaLabelForVariant`.

### Severity por variante

| Variant | `notifications.severity` |
|---|---|
| `upcoming` | `info` |
| `due_soon` | `warning` |
| `overdue` | `urgent` |
| `overdue_critical` | `urgent` |
| `success` | (no emite notif) |

### Snooze server action

El botón "Posponer" del `<ReminderCard>` llama a `snoozeReminderAction(reminderId)`.

**Archivo nuevo:** `app/actions/reminders.ts`

```ts
"use server";
// Max 3 snoozes of 7d each. On the 4th call, snooze extends 30d (spec §E).
export async function snoozeReminderAction(reminderId: string): Promise<void>
```

Lógica:
- `snooze_count < 3` → set `snoozed_until = now + 7d`, increment `snooze_count`.
- `snooze_count >= 3` → set `snoozed_until = now + 30d` (no increment — cap está alcanzado).
- El cron excluye reminders donde `snoozed_until > now`.

### Tests — C2

- `__tests__/vaccine-due-scan.test.ts`:
  - Reminder `upcoming`: si ya hay notif de hace 3d, el cron NO emite otra (< 7d threshold).
  - Reminder `upcoming`: si ya hay notif de hace 8d, el cron SÍ emite.
  - Reminder `due_soon`: primeros 3 días emite diario.
  - Reminder `due_soon`: después de 3 días, emite cada 3d.
  - Reminder `overdue`: emite diario las primeras 2 semanas.
  - Reminder `overdue`: después de 2 semanas, emite semanal.
  - Reminder `overdue_critical` (rabia, dog, >30d): emite diario independientemente del tiempo transcurrido.
  - Reminder con `snoozed_until` en el futuro: el cron no lo procesa.
  - Reminder con `completedAt`: el cron no lo procesa (ya existe, no regresa).
  - `category = 'health'` en todas las notifs emitidas.
  - Race condition (spec §E): owner registra vacuna mientras cron genera notif → `completedAt` set → notif queda en inbox como resuelta; no se generan más.

### DoD — C2

- [ ] Migración generada y aplicada en staging.
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test -- vaccine-due-scan` pasan.
- [ ] Cron manual smoke: `curl -H "Authorization: Bearer $CRON_SECRET" $URL/api/cron/vaccine-due` → `ok: true`.

---

## C3 — Surfaces (~1d)

### `/inicio` — `<RemindersSection>`

**Archivo nuevo:** `app/(app)/inicio/_components/RemindersSection.tsx`

Regla de aparición (spec §A.2): visible si hay ≥1 `overdue` O ≥3 `due_soon`/`upcoming`. Muestra max 3 `overdue_critical` siempre visibles; el resto en `<details>` colapsado (spec §E edge case: owner con 8 pets).

```tsx
// Loads reminders server-side via a query helper; renders <ReminderCard> per item.
// Uses <Panel> / <PanelHeader> / <PanelBody> from PR #93.
```

**Archivo modificado:** `app/(app)/inicio/page.tsx` — integrar `<RemindersSection>` arriba del fold si hay reminders activos.

**Query helper nuevo:** `lib/queries/reminders.ts` (o en `lib/reminders-queries.ts` si el archivo no existe)

```ts
// loadActiveRemindersForUser(userId: string): Promise<ReminderWithPet[]>
// Returns reminders with completedAt IS NULL and snoozed_until < now,
// ordered by variant priority (overdue_critical first).
```

### `/mis-mascotas/[publicToken]` — `<PetReminders>`

**Archivo nuevo:** `app/(app)/mis-mascotas/[publicToken]/_components/PetReminders.tsx`

Scoped al pet. Usa `<Panel>` con link "Ver libreta de vacunas →" (spec §A.2). Siempre visible cuando `petReminders.length > 0`.

**Archivo modificado:** `app/(app)/mis-mascotas/[publicToken]/page.tsx` — integrar `<PetReminders>` arriba de la sección actual.

### `/mis-mascotas` — badge en `<PetCard>`

**Archivo a identificar:** buscar `PetCard` en `app/(app)/mis-mascotas/` y agregar badge.

| Estado del pet | `<Badge>` variant | Short label | `aria-label` |
|---|---|---|---|
| Hay `upcoming` | `info` | "Vacunas próximas" | "Tiene vacunas a programar en próximos 14 días" |
| Hay `due_soon` | `warning` | "Vacuna pronto" | "Tiene una vacuna que vence pronto" |
| Hay `overdue` | `danger` | "Vacuna vencida" | "Tiene una vacuna vencida" |
| Hay `overdue_critical` | `danger` (con pulse en wrapper) | "URGENTE" | "Tiene una vacuna obligatoria vencida" |
| Sin pendientes | (sin badge) | — | — |

Pulse: `<span className="animate-pulse motion-reduce:animate-none"><Badge variant="danger">URGENTE</Badge></span>`. No bakes animation en `<Badge>` — consistente con E-D4 (decisión del owner: el consumer envuelve, no se hornea en la primitiva).

### Archivos involucrados en C3

| Path | Acción |
|---|---|
| `app/(app)/inicio/_components/RemindersSection.tsx` | NEW |
| `app/(app)/inicio/page.tsx` | MODIFY |
| `app/(app)/mis-mascotas/[publicToken]/_components/PetReminders.tsx` | NEW |
| `app/(app)/mis-mascotas/[publicToken]/page.tsx` | MODIFY |
| `app/(app)/mis-mascotas/_components/PetCard.tsx` (o path equivalente) | MODIFY |
| `lib/queries/reminders.ts` | NEW |

> **TBD durante C3:** verificar path exacto de `<PetCard>` haciendo `grep -r "PetCard" app/` antes de editar.

### Tests — C3

Integration test sobre el query helper (`__tests__/reminders-queries.test.ts`):

- `loadActiveRemindersForUser`: excluye reminders con `completedAt IS NOT NULL`.
- `loadActiveRemindersForUser`: excluye reminders con `snoozed_until > now`.
- `loadActiveRemindersForUser`: ordena por prioridad de variante (overdue_critical primero).
- `loadActiveRemindersForUser`: scope correcto por `userId` (no devuelve reminders de otros owners).

Verificación visual manual (documentar en el PR de C3):

- `<RemindersSection>`: con solo `upcoming` reminders → `<details>` colapsado.
- `<RemindersSection>`: con ≥1 `overdue_critical` → `<details>` abierto.
- `<PetCard>` badge: sin reminders → no aparece badge.
- `<PetCard>` badge: con `overdue_critical` → badge `danger` con `animate-pulse` (verificar `prefers-reduced-motion: reduce` en DevTools — el pulse debe desaparecer).

### DoD — C3

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test -- reminders-queries` pasan.
- [ ] Visual check en staging: badge aparece en `/mis-mascotas` para pet con vacuna vencida; `prefers-reduced-motion: reduce` desactiva pulse.
- [ ] `<RemindersSection>` aparece en `/inicio` cuando hay reminders activos del owner.

---

## C4 — Libreta + `/notificaciones` (~0.5d)

### `<VacunasTimeline>` + `<VacunaTimelineDot>`

**Archivo a modificar:** `app/(app)/mis-mascotas/[publicToken]/vacunas/page.tsx` — reemplazar lista actual con layout del spec §A.3.

**Archivo nuevo:** `app/(app)/mis-mascotas/[publicToken]/vacunas/VacunasTimeline.tsx`

Combina reminders activos (próximas) + historial de `vaccination_administered` events. Layout completo per spec §A.3: dos `<Panel>`, uno de próximas y uno de histórico con `<EmptyState>` cuando no hay historial.

**Archivo nuevo:** `app/(app)/mis-mascotas/[publicToken]/vacunas/VacunaTimelineDot.tsx`

Timeline item vertical (spec §A.4): dot 16×16 coloreado por freshness, fecha, nombre vacuna + marca, administrado por + lote, próxima dosis.

**Archivo existente:** `app/(app)/mis-mascotas/[publicToken]/vacunas/programar/page.tsx` — refinar con el form de spec §A.5 si hay divergencia. Verificar antes de tocar.

### `/notificaciones` con `<Tabs>` por categoría

**Archivo a modificar:** `app/(app)/notificaciones/page.tsx`

Agregar `<Tabs>` con searchParam persistence (ya soportado por el `<Tabs>` de PR #93). Categorías (spec §D):

| Tab | `?cat=` | Badge count |
|---|---|---|
| Todas | `all` | `total` |
| Salud | `health` | `healthCount` (vacunas + futuras health notifs) |
| Custodia | `custody` | `custodyCount` |
| Adopciones | `adoption` | `adoptionCount` |
| Denuncias | `welfare` | `welfareCount` |
| Sistema | `admin` | `adminCount` |

El filtro usa `notifications.category` (columna agregada en C2). Las notifs que no tienen `category` set caen en "Todas" pero no en ninguna tab específica.

Agrupamiento visual (spec §D): cuando hay ≥3 notifs del mismo `relatedPetId` + `notificationType`, mostrar un grupo colapsable con header `"{pet.name}: N recordatorios de {vaccineName}"`.

### Archivos involucrados en C4

| Path | Acción |
|---|---|
| `app/(app)/mis-mascotas/[publicToken]/vacunas/page.tsx` | MODIFY |
| `app/(app)/mis-mascotas/[publicToken]/vacunas/VacunasTimeline.tsx` | NEW |
| `app/(app)/mis-mascotas/[publicToken]/vacunas/VacunaTimelineDot.tsx` | NEW |
| `app/(app)/mis-mascotas/[publicToken]/vacunas/programar/page.tsx` | MODIFY (si difiere del spec §A.5) |
| `app/(app)/notificaciones/page.tsx` | MODIFY |

### Tests — C4

Integration tests sobre el query helper de notificaciones (`__tests__/notifications-by-category.test.ts`):

- Filtro `category = 'health'` retorna solo las notifs de salud.
- Notifs sin `category` set aparecen en "Todas" pero no en tabs específicas.
- Agrupamiento: con ≥3 notifs del mismo `relatedPetId` + `notificationType`, la query devuelve un agrupamiento (o el componente lo computa client-side; decisión durante C4).
- Scope por `userId`.

Verificación visual manual (documentar en el PR de C4):

- `<VacunasTimeline>`: pet sin historial → muestra `<EmptyState>` con CTA.
- `<VacunasTimeline>`: sección "Próximas" solo visible cuando hay reminders activos.
- `/notificaciones` con `?cat=health` → solo notifs de vacunas + futuras notifs `health`.
- Tabs persisten en URL al hacer click (verificar searchParams).

### DoD — C4

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test -- notifications-by-category` pasan.
- [ ] Visual check en staging: `/notificaciones` filtra correctamente por tab; `/mis-mascotas/[token]/vacunas` muestra timeline o `<EmptyState>`.

---

## Definition of Done — Chunk C completo

- [ ] **Race test:** owner registra vacuna mientras cron genera notif → ambos eventos completan; notif queda como resuelta (server action de `createVaccinationAction` marca `notifications` relacionadas como `readAt + archivedAt` en el mismo tx).
- [ ] **Anti-spam:** thresholds por variante verificados con tests (ver C2 §Tests).
- [ ] **Snooze cap:** después de 3 posponer-7d, el botón muestra "Posponer 30 días" (spec §E).
- [ ] **`prefers-reduced-motion`** respetado: pulse en `overdue_critical` PetCard badge usa `motion-reduce:animate-none`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm rls:smoke` green.
- [ ] **Coverage** no regresa (umbrales de Chunk A1 se mantienen).
- [ ] **Inventory** `docs/feature-inventory-2026-05-20.md` entrada 7.4 → ✅.
- [ ] **Plan** movido a `docs/superpowers/plans/archive/`.

---

## Diferidos (fuera de scope de Chunk C)

| Item | Dónde vive |
|---|---|
| Email para `overdue_critical` >30d (1 email/semana) | spec §B.2 — integración con servicio de email, plan aparte |
| PWA push notifications | spec §B.3 — requiere push subscription, plan aparte |
| `<ScheduleReminderForm>` refinamiento completo | `app/(app)/mis-mascotas/[publicToken]/vacunas/programar/page.tsx` — verificar al iniciar C4 si difiere materialmente del spec §A.5; si no difiere, no tocar |
| `getReportableVaccines(species, jurisdiction)` dinámica | ENO spec `2026-05-19-eno-vet-direct-report-and-owner-alerts-design.md` |
| Pet muerto con reminders activos → auto-close | `death_recorded` cron; spec §E edge case — plan separado de lifecycle cron |
| Reminder con `next_due_at` >1 año → solo en libreta | El cron ya lo maneja (solo dispara dentro de 14d); la libreta los muestra sin notif — no requiere trabajo adicional |

---

## Ambigüedades del spec flaggeadas

1. **Spec §A.1 `variant` computation:** el spec nombra las variantes `upcoming | due_soon | overdue | overdue_critical | success`, pero en `lib/notifications.ts` el cron actual usa la ventana `[now-1d, now+7d]`. El plan expande la ventana a `[now-∞, now+14d]` para incluir `upcoming` (8–14d). Verificar que esta expansión no impacte performance con muchos reminders futuros — agregar `LIMIT` o paginar si el scan supera los 500 rows.

2. **Spec §B.1 `due_soon` throttle:** "1 notification nueva diaria los primeros 3 días, después cada 3 días" — no queda claro si los "3 días" se cuentan desde que el reminder entra en `due_soon` o desde la primera notif. El plan interpreta: desde la primera notif emitida en la ventana `due_soon`.

3. **Spec §A.2 `RemindersSection` en `/inicio`:** "aparece arriba si hay 1+ overdue o 3+ due_soon/upcoming" — el "3+" no especifica si es por pet o global. El plan interpreta: total de reminders del usuario (no por pet).

4. **Resolución de vacuna al registrar manual:** spec §E dice "notif legacy queda en inbox como 'Resuelta' con check verde" pero el schema actual no tiene campo `resolvedAt` en `notifications`. El plan usa `archivedAt` como proxy de "resuelta" — verificar durante C2 si se quiere un estado visual diferenciado.

---

## Referencias

- `dim-interno:docs/design/06-vaccine-due.md` — design spec completa (fuente de verdad).
- `dim-interno:docs/superpowers-private/plans/archive/2026-05-21-consolidated-cc-plan.md` — sequencing parent.
- `docs/superpowers/plans/2026-05-21-pending-decisions-resolved.md` — decisiones cerradas §Chunk C + §CX-1.
- PR #93 — `feat(poncho): design-system primitives (Chunk A.5)` — dependencia de primitivas.
- `app/api/cron/vaccine-due/route.ts` — cron stub a extender (vía `lib/notifications.ts`).
- `lib/notifications.ts` — `runVaccineDueScan()` actual a reescribir en C2.
- `db/schema.ts` — tablas `reminders` y `notifications` (columnas existentes).
