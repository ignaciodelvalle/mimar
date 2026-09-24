# Owner health-status nudges (`/inicio`) — implementation plan (Item 5)

> Executable, file-level plan for `specs/2026-06-18-owner-health-status-nudges-design.md`.
> Umbrella: `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` (§3 SDD loop, §6 privacy).
> Scope: **owner-facing only**, derived from the **owner's own events** — never
> from surveillance/authority signals. No new tables / event types / migrations.

## 0. Antes de tocar nada

Read, in order:

- The spec above (the contract) + umbrella §6 ("No owner-visible diagnoses").
- `app/(app)/inicio/page.tsx` — the live `/inicio` page (Libreta-Nacional `Ln*`
  redesign; the spec's "9-widget" description predates this redesign — the page
  layout wins, the nudges are added as a new card in the right column).
- `lib/owner-dashboard.ts` — the existing `/inicio` data layer + its conventions
  (every fetcher is owner-scoped, never throws, returns `[]` on no-data).
- `lib/projections/pet-microchip.ts` + `pet-status.ts` + `types.ts` — pure replay
  helpers reused instead of re-deriving chip status.
- `lib/event-schemas.ts` — payload shapes: `vaccination_administered.next_due_at`,
  `microchip_implanted.chip_number`, `sterilization_performed`,
  `credential_scanned.is_self_scan`.
- `__tests__/active-reminders.test.ts` — the integration-test pattern to mirror
  (Supabase admin client, `createUser`/`createPetForUser`, `withMutationOverride`
  teardown because `pet_events` is append-only).

## 1. Decisiones de implementación (alineadas al spec)

- **D1 (owner-data only).** The derivation whitelists exactly four event types —
  `vaccination_administered`, `microchip_implanted`, `sterilization_performed`,
  `credential_scanned` — all owner-authored/owner-scoped. No surveillance type is
  ever read. (Umbrella §6.)
- **D2 (derive, don't store).** Everything is computed on read. No schema.
- **D4 (encouraging copy).** Nudge labels are supportive (`"Vacuna vencida —
  agendá un turno"`), each with a direct owner action link. No alarm framing.
- **Phase boundary.** This PR ships Fase 1 (vaccine / chip / reminder) **plus**
  scan-activity + sterilization-status + the per-pet rollup summary, which the
  Item-5 task explicitly lists. Tier-2 libreta-share telemetry (spec §3 last row)
  stays deferred — it has no owner action and would widen the PR without payoff.
- **Vaccine "unknown".** A pet with no `vaccination_administered` on record (or
  one with no `next_due_at`) is `unknown`, NOT `overdue`. We do not nudge an owner
  who simply hasn't logged a vaccine — the reminder system handles that prompt;
  over-nudging erodes trust (spec D4 intent).
- **`pendingCount` vs scan activity.** Scan activity is informational (neutral
  tone) and does NOT count toward "pendientes". Only action-required nudges
  (`attention` tone) roll up into the badge.

## 2. Archivos

### `lib/owner-nudges.ts` (NEW — sibling of `lib/owner-dashboard.ts`, per spec §4)

Pure derivation + one data-layer entry point.

- Types: `VaccineStatus`, `NudgeKind`, `Nudge`, `PetHealthStatus`.
- Pure (no DB, unit-testable):
  - `deriveVaccineStatus(events, now)` — latest `vaccination_administered` wins;
    `next_due_at < now` → `overdue`, future → `up_to_date`, none → `unknown`.
  - `derivePetHealthStatus(pet, events, openReminders, now)` — builds the nudge
    list + rollup. Reuses `replayPetMicrochip(events).microchipId !== null` for
    `hasChip`; `sterilization_performed` presence for `isSterilized`; external
    `credential_scanned` (`is_self_scan=false`, last 90d) for `recentScanCount`.
- Data layer: `fetchPetHealthNudges(ownerId)` — three owner-scoped reads
  (active pets `role='owner'`, non-deceased; whitelisted events via an ownership
  join; open vaccine reminders), grouped per pet, then `derivePetHealthStatus`.
  Never throws; returns `[]` when the owner has no pets.

### `app/(app)/inicio/_components/PetHealthStatusStrip.tsx` (NEW — presentational)

Dumb component. Props: `{ pets: PetHealthStatus[] }`. Renders an `Ln*` card
("Estado sanitario") with one row per pet: name + species + status badge
("Al día" / "N pendientes") + nudge links. Returns `null` for no pets. No data
access, no business logic.

### `app/(app)/inicio/page.tsx` (EDIT — server fetch + render)

- Import `fetchPetHealthNudges` + `PetHealthStatusStrip`.
- Add `fetchPetHealthNudges(user.id)` to the existing `Promise.all` fan-out.
- Render `<PetHealthStatusStrip pets={healthStatus} />` at the top of the
  right-column stacked cards (above "Vencimientos").

## 3. Tests (test-first)

`__tests__/owner-home-nudges.test.ts` — integration, local Postgres, mirrors
`active-reminders.test.ts`. Seven describe blocks:

1. Overdue vaccine → `vaccine_overdue` nudge present + `vaccineStatus='overdue'`;
   future `next_due_at` → absent + `up_to_date`.
2. No `microchip_implanted` → `chip_missing` nudge present; chipped → absent.
3. Open reminder surfaces as `reminder_due`; completed reminder does not.
4. `credential_scanned` with `is_self_scan=true` excluded; external scan counted
   (`recentScanCount`).
5. Sterilized pet → `isSterilized=true`, no sterilization nudge.
6. Rollup: compliant pet → `pendingCount=0` / `"Al día"`; non-compliant → count.
7. Cross-owner isolation: owner A only sees A's pets; empty array for no pets.

Write the test FIRST, watch it fail (`Cannot find package '@/lib/owner-nudges'`),
then implement until green.

## 4. Docs (same PR — umbrella §3 step 6)

- `AGENTS.md` → Feature inventory › Owner-facing: add the estado-sanitario row.
- `README.md` → Status › Owner: mention the estado-sanitario nudges.
- `docs/superpowers/README.md` → flip the Item 5 row to ✅ with the merge SHA.
- File-header comments on both new files (privacy contract spelled out).

## 5. Gate

`biome format --write` → `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
The new test must pass. Conventional commit, no AI attribution.

## 6. Lo que NO está acá (spec §7 + phasing)

- No surveillance/diagnoses surfaced to owners.
- No Tier-2 libreta-share telemetry nudge (deferred — Fase 2).
- No push/email channel changes (on-page surface only).
- No Item-6 pet-profile changes (D10 coordination: Item 5 owns `/inicio`; the
  per-pet profile detail surface belongs to Item 6).
