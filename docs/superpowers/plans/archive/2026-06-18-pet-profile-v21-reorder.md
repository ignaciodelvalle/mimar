# Pet profile v2.1 — reorder + action-hub consolidation — executable plan

> **Item 6** of the metrics-IA handoff · **Date:** 2026-06-18
> · Spec (contract): `docs/superpowers/specs/2026-06-18-pet-profile-v21-reorder-and-action-consolidation-design.md` (§9 closed)
> · Umbrella (do not edit): `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md`
> · Antecesor: `docs/superpowers/specs/2026-05-19-pet-profile-v2-design.md`

File-level plan. NO data/schema/event-type/migration changes (D1). Test-first where feasible.

## Scope recap (from spec §9)

1. Reorder the owner profile: **hero first**, a single prioritized `<PetAlertStrip>` **below** the hero, then quick actions, then tabs. (D2/D3)
2. Move PPP + service-dog from full-width banners to **credential cards inside Resumen**; move **achievements to the end of Resumen**. (D4/D5)
3. Collapse the 3 action hubs: `/anotar` is the **single canonical capture surface**; `/eventos/nuevo` (the catalog index) becomes a **permanent redirect to `/anotar`**; the profile has **one way to annotate**. (D7)
4. Consolidate reminders to a single component (`PetReminders`); delete the dead `PetVaccineReminders`. (D6)
5. Tabs stay the final timeline model; the Lost cockpit keeps access to the normal profile. (D8/D9)
6. Docs in the same PR: `AGENTS.md` 5th UI convention, `page.tsx` header, README row flip, antecesor v2 spec note.

## Grounding facts discovered in code (load-bearing)

- **`/eventos/nuevo` has two layers.** The **index** `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx` is the duplicate catalog (`LIBRETA_OPTIONS` + `OTHER_OPTIONS`, ~16 rows) → this is what redirects. The **sub-routes** `eventos/nuevo/{vacuna,embarazo,microchip,…}/` are the actual form pages and are public contract referenced by `lib/event-capture-registry.ts`, `lib/event-capture-matcher.ts`, and `lib/notifications.ts`. **They are NOT touched.** Same shape as `/libreta` (index redirects to `?tab=libreta`, sub-pages keep working).
- **`/anotar` already is the canonical hub.** `EventCatcher` falls back to `/anotar?text=…`; chips use `buildAnotarUrl → /anotar?kind=…`; `ALL_CAPTURE_OPTIONS` (in `anotar/handoff.ts`) already groups every loggable event + management flow by category. The `/eventos/nuevo` index adds nothing `/anotar` lacks, so no catalog content needs porting.
- **`PetVaccineReminders.tsx` is dead code** — referenced only in the `page.tsx` top comment ("v2 components NOT used"), never imported. `PetReminders` (`_components/PetReminders.tsx`) carries the `deleteVaccineReminderAction` wiring and is the canonical surface. Delete the dead one (D6).
- **`PetActionsMenu.helpers.ts` `deriveActionItems`** today emits `anotar` (label "Anotar algo" → `/anotar`) **and** `new-event` (label "Todos los eventos" → `/eventos/nuevo`). Two logging entry points. Per D7 the profile keeps **one**: the `anotar` item, relabeled per rule #2; `new-event` is removed.
- **Page is a server component.** No colocated profile `.test.*` exists. We rely on focused unit/route tests + the existing `PetActionsMenu.test.ts` staying green.
- **`LostCockpit.tsx`** has a "Ver credencial pública" footer but **no link back to the normal profile** — D9 requires one.

## Phases

### Phase 1 — `PetAlertStrip` + profile reorder (page.tsx)

- **NEW** `components/pet-profile/PetAlertStrip.tsx`: single container that renders the conditional alerts ordered by urgency (rabies `urgent` → transit `warning` → open-cases `warning` → pregnancy `info`). Empty input → renders nothing. Reuses existing tones; no new chrome tokens. Each alert is a slot (the page passes already-built nodes / flags) so the strip owns ordering, not data fetching.
- **EDIT** `app/(app)/mis-mascotas/[publicToken]/page.tsx`:
  - Move the JSX so the **hero block (`data-section="hero"`) is the first content block** after the back-link / org notice. Remove the standalone `TransitBanner`, `RabiesObservationBanner`, `PetOpenCasesSection`, `PregnancyInProgressCard`, `PpPCard`, `ServiceDogCredentialCard` from **above** the hero.
  - Insert `<PetAlertStrip>` **directly below the hero** (above the vitals/quick-actions), wiring rabies/transit/open-cases/pregnancy into it in urgency order.
  - Inside **Resumen**: reorder so achievements render **last** ("Logros", only when present); add a **Credenciales** sub-section (`03`) that hosts the PPP card (+ CABA export button) and the service-dog credential card, only when applicable.
  - Update the `page.tsx` header comment block to describe the v2.1 order (identity → strip → actions → tabs; credentials/achievements inside Resumen) instead of the old "hybrid swap" wall-of-banners description.

### Phase 2 — collapse action hubs

- **EDIT** `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page.tsx`: replace the whole catalog with `permanentRedirect(\`/mis-mascotas/${publicToken}/anotar\`)`. Preserve any incoming `searchParams` defensively by appending them to the `/anotar` URL (the index carried none today, but a forwarded `?text=`/`?kind=` must survive). Keep the file header explaining the redirect (mirrors `libreta/page.tsx`).
- **EDIT** `components/PetActionsMenu.helpers.ts`:
  - Rename the `anotar` item label `Anotar algo` → **`Registrar evento`** (rule #2: verb + object; `/anotar` href unchanged).
  - **Remove** the `new-event` item ("Todos los eventos" → `/eventos/nuevo`). One way to annotate from the profile (D7). The remaining management actions (edit, tier2, service-dog, transfer, confirm-return) stay — that is the "Gestión" group.
- **EDIT** `components/PetActionsMenu.test.ts`: migrate the `new-event` assertion (the "core actions always present" test currently asserts `new-event`). Assert instead that `anotar` is present with label `Registrar evento` and href `/anotar`, and that `new-event` is **absent** (single annotate path).

### Phase 3 — consolidate reminders + close antecesor spec

- **DELETE** `components/pet-profile/PetVaccineReminders.tsx` (dead; D6). Remove its mention from the `page.tsx` header comment.
- **EDIT** `docs/superpowers/specs/2026-05-19-pet-profile-v2-design.md`: add a short v2.1 closing note — "timeline = tab (closed by v2.1)", PPP/service-dog are credential cards inside Resumen.

### Phase 4 — D9 + docs

- **EDIT** `app/(app)/mis-mascotas/[publicToken]/LostCockpit.tsx`: add a "Ver perfil completo" link (alongside the existing "Ver credencial pública" footer) that points to `/mis-mascotas/${token}?fromLost=1` so the owner can reach the normal profile while the pet is lost (D9). The link does not change lost-mode data.
- **EDIT** `AGENTS.md` → Design rules: add **5th convention** — "Pet profile order: identity → alerts (prioritized strip) → actions → tabs; credentials and achievements live inside Resumen".
- **EDIT** `docs/superpowers/README.md`: flip the Item 6 status cell `🟢 Ready for CC (§9 cerrado)` → `✅ (#PR)` (master doc; only that cell).

## Tests (test-first where feasible)

1. **`__tests__/eventos-nuevo-redirect.test.ts`** (NEW): asserts the `/eventos/nuevo` index page calls `permanentRedirect` to `/anotar`, and that forwarded query params are preserved. Mock `requirePetAccess` + `next/navigation`.
2. **`components/pet-profile/PetAlertStrip.test.tsx`** (NEW): urgency ordering (rabies before transit before open-cases before pregnancy); empty → renders nothing.
3. **`components/PetActionsMenu.test.ts`** (EDIT): single annotate path — `anotar` present (label `Registrar evento`, href `/anotar`), `new-event` absent.

Existing green-keepers: `lib/event-capture-registry.test.ts`, `__tests__/event-catcher-handoff.test.ts`, `__tests__/event-capture-matcher.test.ts` (the redirect must not break `/eventos/nuevo/*` sub-route deeplinks).

## Out of scope

No data/schema/event-type/projection changes. No visual token / hero redesign. No memorial/lost-logic rewrite beyond the D9 profile link. No Item 5 `/inicio` nudges (D10 — Item 6 owns the profile detail only). `docs/planning/*` untouched. Umbrella/kickoff untouched.

## Contradictions for owner list

None blocking. One nuance recorded: the spec §3.1 sketch lists "PetQuickActions" between strip and tabs; the live page renders `LnVitals` then `PetQuickActions`. The vitals strip is identity metadata (weight/age/last-visit), not an alert, so it stays with the hero block — no spec conflict.
