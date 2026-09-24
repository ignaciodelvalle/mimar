# Owner home (/inicio) redesign — plan

**2026-05-20 · scope: /inicio + `EventCatcher` primitive**

## Why this plan

Today `/inicio` is a long vertical stack of eight widgets:

1. `QuickCaptureWidget` (pet chip picker → routes to `/mis-mascotas/{token}/anotar`)
2. `NotificationsWidget`
3. `PetsGridWidget` (up to 6 pets)
4. `AppointmentsWidget` + `MedicationsWidget` (side-by-side)
5. `OpenWorkflowsWidget`
6. `PreviousWorkflowsWidget`
7. `NewsPlaceholder` + `RegulationsPlaceholder` (side-by-side)

`QuickCaptureWidget` deliberately punts the actual text capture to the per-pet `/anotar` page. Its comment reads: *"Why not embed a textarea here: the matcher needs a pet context for future slot extraction, and landing on the per-pet /anotar page also unlocks the quick-action shortcuts."*

That call made sense when the matcher was new. The redesign reverses it. The owner uses /inicio to **log a thing about a pet**; making them pick a pet, navigate, then type — three steps for what should be one — is the friction we want to remove. Embedding the textarea on /inicio drops the cost of an event from three taps to one, which is the difference between the app being a habit and being a chore.

## Goals

- **Pet-first home.** Three sections, in order: event catcher, pet list, near-term commitments.
- **One affirmative blue button.** "Anotar →" on the catcher. Nothing else on the home competes with it visually.
- **Mobile-first.** Pet chips horizontally scroll; the textarea is full-width; the action row wraps.
- **Preserve the matcher.** The free-text → parsed event matcher still lives at `/mis-mascotas/{token}/anotar`. The catcher passes pet + text + (optional) quick-kind in the URL so the matcher pre-fills.

## What's new

### `components/EventCatcher.tsx`

Client component. Composition: pet chip row (horizontally scrollable, `radiogroup`) + textarea + quick-action chips (Vacuna / Peso / Vet / Medicación / Nota) + "Anotar →" submit. Ctrl/⌘ + Enter submits.

Behavior:
- Pet selection persists in component state; defaults to the first non-deceased pet.
- Submit navigates to `/mis-mascotas/{publicToken}/anotar?text=…` (the matcher receives the text and runs slot extraction on landing).
- Quick chips skip the textarea and route to `/mis-mascotas/{publicToken}/anotar?kind=vacuna|peso|vet|medicacion|nota`. The matcher reads `kind` and jumps to the pre-filled form for that event type.

Public API:

| Prop | Type | Default | Description |
|---|---|---|---|
| `pets` | `EventCatcherPet[]` | — | Pet list. Deceased pets are filtered out of the picker. |

```ts
type EventCatcherPet = {
  id: string;
  name: string;
  publicToken: string;
  photoUrl: string | null;
  status: "active" | "lost" | "deceased";
};
```

States:

| State | Behavior |
|---|---|
| Default | First pet selected, textarea empty, submit disabled. |
| Pet selected | Placeholder becomes `"{name} — ¿qué pasó?"`, focus moves to textarea. |
| Text typed (≥3 chars) | Submit enabled. |
| Submitting | Submit shows "Abriendo…", quick chips disabled. |
| Zero pets | Replaces the whole widget with an "Agregar mi primera mascota" CTA. |

Accessibility:
- Pet row uses `role="radiogroup"` with `role="radio"` + `aria-checked` on each chip.
- Textarea is a labeled `<textarea>` with a visible placeholder and `aria-label`.
- The whole section starts with a `sr-only` h2 for screen readers.
- Ctrl/⌘ + Enter shortcut is documented in the visible tip below the action row.

## Page structure (`/inicio-v2`)

```
┌─ "Hola, Ignacio"
│  "¿Qué le pasó a alguna mascota hoy?"
├─ EventCatcher
│   ├─ pet chips (Roma · Mishi · Toto · Luna →)
│   ├─ textarea
│   └─ quick chips · "Anotar →"
├─ Mis mascotas (up to 4–6 cards, with status pills)
├─ Próximos turnos (next 2–3 appointments)
└─ small caption: "Notificaciones, medicaciones y workflows se mantienen
   accesibles desde el menú."
```

What's deliberately off the home:
- Notifications panel — moves to a top-bar bell + `/notificaciones`.
- Medications list — accessible from the per-pet profile and `/mis-mascotas`.
- Open workflows / previous workflows — these are operational, not daily-glance content. Move to `/cuenta/workflows` or a "Mi actividad" tab.
- News and regulations placeholders — these are filler. Remove until there's real content.

## Migration

1. Ship `components/EventCatcher.tsx` and `app/(app)/inicio-v2/page.tsx` (done — both additive).
2. Once the working tree is sound, swap `app/(app)/inicio/page.tsx` body for the v2 layout, wire to `fetchPetsForOwner(user.id)`, retire `QuickCaptureWidget`.
3. Move displaced widgets to their new homes:
   - `NotificationsWidget` → top-bar bell + `/notificaciones` (most of `/notificaciones` already exists).
   - `OpenWorkflowsWidget` + `PreviousWorkflowsWidget` → new `/cuenta/workflows` route or fold into `/cuenta`.
   - `MedicationsWidget` → per-pet profile (where it conceptually belongs).
   - Drop the placeholders.
4. The matcher route `/mis-mascotas/{token}/anotar` needs to read `?text=…` and `?kind=…` query params on landing. Pre-fill the textarea, optionally jump to the quick-form for the kind.

## Open decisions

1. **Do quick-chips skip the matcher entirely?** Option A: route to `/anotar?kind=vacuna` and have the matcher show a kind-specific form. Option B: open a small modal/sheet on the home itself. Plan assumes A — keeps the home truly minimal.
2. **Top-bar bell.** Pulling notifications off /inicio means we need a bell somewhere. The current `(app)/layout.tsx` doesn't have one. Decision: add it. Counts come from `countUnreadNotifications`, link goes to `/notificaciones`.
3. **Workflows hierarchy.** "Open workflows" includes adoption applications, foster proposals, custody disputes — heterogeneous stuff. The split between primary and secondary surfaces deserves its own pass, but it isn't this plan's scope.
4. **Empty state for "Próximos turnos".** The current dashboard hides the section when empty. v2 should either keep the section visible with an "Agendar turno" CTA, or hide. Plan leaves this for a follow-up.

## Out of scope

- The `/anotar` matcher itself. Its query-param contract is the only thing that changes; the parsing logic stays.
- Multi-pet bulk capture ("vacuné a Roma y Mishi"). The matcher can disambiguate later; for now the chip row enforces one pet at a time.

## Suggested next step

Once the working tree is verified clean (action plan Phase 0 redux), point a Claude Code session at the live `app/(app)/inicio/page.tsx` and replace its body with the `inicio-v2/page.tsx` structure, swapping sample pets for `fetchPetsForOwner`. Then handle the displaced widgets in a follow-up PR (one per destination so review stays focused).

---

## v3 revision — 2026-05-20 afternoon (post-critique)

Critique calls from the design review:

1. *"Can we actually use Poncho?"* — Yes. `components/poncho/Button.tsx` already exists with six variants (primary / secondary / success / danger / link / tag), Encode Sans is loaded in `globals.css`, and the `bg-gob-*` Tailwind classes are wired. The previous draft used generic `bg-blue-700` — that was a miss. Updated.
2. *"Cases instead of Mis mascotas."* — Adopted. The pet picker in EventCatcher is now the only place pets appear; the second section is `Mis casos` (open workflow items across lost-pet, adoption, foster, denuncia, custody-dispute, approval-request). The data already exists via `fetchOpenWorkflows(userId)` in `lib/owner-dashboard.ts` — the migration is a rename + a `CaseRow` mapper, no new query.
3. *"Bigger pet photos, tap twice to open profile."* — Avatars went from 26px → 72px. Tap once selects; a second tap on the *same* selected chip navigates to `/mis-mascotas/{token}`. Long-press (~550ms) also opens. A small `↗ Abrir perfil` hint fades in on the selected chip so the dual-tap affordance is discoverable, and right-click opens the profile too for desktop.

### What changed in code

- `components/EventCatcher.tsx` — avatars to 72px, dual-tap behavior with `lastTapRef`, long-press with `pressTimer`, hover/active states match Poncho, submit uses `<Button variant="success" />`.
- `components/CasesWidget.tsx` — new. Takes a `CaseRow[]` (mappable from existing `WorkflowItem[]`), groups by severity tone, shows "hace N días" relative timestamps.
- `app/(app)/inicio-v2/page.tsx` — drops the old pet list section, drops in `CasesWidget`, preserves `Próximos turnos`. Switches link colors to `text-gob-azul-link`.

### Component reference — `EventCatcher` (v3)

States added:
- *Pet recently tapped* (< 600ms ago, same id) → next tap navigates instead of re-selecting.
- *Long-press in progress* (~550ms) → navigates to profile on completion.
- *Right-click on chip* → preventDefault + navigate (desktop affordance for the same intent).

Public API unchanged from v2 (`{ pets: EventCatcherPet[] }`).

### Component reference — `CasesWidget`

| Prop | Type | Default | Description |
|---|---|---|---|
| `cases` | `CaseRow[]` | — | Open cases for the owner. First `MAX_VISIBLE` (5) are rendered. |
| `totalCount` | `number?` | `cases.length` | Total open cases. Drives the `· N abiertos` suffix and the "Mostrando los X más recientes" footer. |

`CaseRow` shape:

```ts
{ id, title, subtitle, ctaUrl, since: Date,
  severity: "info" | "warning" | "danger" | "success",
  icon?: string }
```

Migration from `WorkflowItem`: title and subtitle pass through, `since` and `severity` exist already, `ctaUrl` exists. Only `icon` is new — map case kinds to emoji in v1, swap for lucide icons in v2.

### Open decisions (post-critique)

1. **Poncho scope on /inicio.** Adopting the `Button` and the `gob-*` color tokens for accents is uncontroversial. The bigger question: should the page header / layout adopt `AppHeader` + `GobStripe` from `components/poncho/Layout/`? That changes the chrome of every owner page, not just /inicio — needs its own decision. Plan currently does **not** wrap /inicio in those.
2. **What counts as a "case" for an owner.** The candidate set: lost-pet episodes, adoption applications, foster proposals, welfare denuncias, custody disputes, approval requests (own role-upgrade or org-verification). Open: should pending vaccine reminders show here too? Argument for: they're "things to do". Argument against: reminders aren't cases, they're nudges. Plan currently excludes reminders.
3. **Profile-open affordance.** Dual-tap + long-press are gesture-based. A third option is a small `↗` icon in the corner of the selected chip that explicitly says "open profile". The hint label (`↗ Abrir perfil`) is the compromise — text label visible, gesture still works. Worth a usability test after merge.
4. **Empty-state copy for `Mis casos`.** Current draft: *"Sin casos abiertos. Cualquier denuncia, postulación o pérdida que empieces va a aparecer acá."* Counterproposal: shorter — *"Todo tranquilo. Sin casos abiertos."* — feels less bureaucratic. Decide after a real-data render.

### What's now off the home (with destinations)

| Removed | Lives at | Notes |
|---|---|---|
| Pet list (`PetsGridWidget`) | `/mis-mascotas` (already exists) + the pet chip row | Dual-tap opens individual profile. |
| Notifications panel | top-bar bell + `/notificaciones` | Bell still TBD — see open decision 1 of original plan. |
| Open workflows + previous workflows | `Mis casos` + `/cuenta/casos` history | The Cases widget replaces both. |
| Medications list | per-pet profile | Conceptually belongs there. |
| News + regulations placeholders | dropped | Filler with no real content. |
