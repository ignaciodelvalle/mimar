# EventCatcher fixes — Claude Code execution plan

**2026-05-20 · scope: `components/EventCatcher.tsx` + `app/(app)/mis-mascotas/[publicToken]/anotar/CaptureBox.tsx`**

Companion to `docs/owner-home-plan-2026-05-20.md`. That doc explained *why* the
catcher exists; this one is the worklist for fixing the rough edges found in
the design critique on 2026-05-20.

Four PRs, sequential. PR 1 is a real bug (silently eats user input), PR 2 is
the highest-leverage clarity fix, PR 3 cleans up a11y debt, PR 4 is polish.
Ship 1–3, watch real owners use it for a week, then triage PR 4 from
telemetry rather than guesswork.

Each PR section ends with a self-contained prompt you can paste into a fresh
Claude Code session — it should be enough context to land the change without
re-reading the critique.

---

## Pre-flight finding (informs every PR below)

`CaptureBox` does **not** currently read `?text=` or `?kind=` query params.
EventCatcher already builds URLs like `/anotar?text=…` and `/anotar?kind=vacuna`,
but on landing, `CaptureBox` ignores both — the textarea always starts empty
and the quick-chip path renders the same identify form as the free-text path.

The `owner-home-plan` spec assumed this wiring existed. It doesn't. PR 1
adds it.

Second mismatch: EventCatcher uses short codes (`vacuna|peso|vet|medicacion|nota`)
but `CaptureBox.QUICK_ACTIONS` uses full `EventType` strings
(`vaccination_administered`, `weight_recorded`, `vet_visit_logged`, `note_added`, …).
And `medicacion` has **no** matching entry in `QUICK_ACTIONS` at all. PR 1
unifies the contract on the full `EventType` strings and either adds a
medication entry or drops the chip.

---

## PR 1 — Wire the EventCatcher → CaptureBox handoff and stop discarding text

**Why:** Today, if an owner types "vacunamos a Roma" in the home catcher and
then taps the **Vacuna** chip, the text is silently thrown away — the URL
sent is `/anotar?kind=vacuna`, and `CaptureBox` doesn't read it anyway, so
the owner lands on a generic identify screen and has to retype. This is the
only finding in the critique that loses user input.

**Files**

- `components/EventCatcher.tsx`
- `app/(app)/mis-mascotas/[publicToken]/anotar/CaptureBox.tsx`
- `app/(app)/mis-mascotas/[publicToken]/anotar/page.tsx` (to forward `searchParams`)

**Changes**

1. **`EventCatcher.tsx`** — change `QuickKind` from short codes to the
   actual `EventType` strings the matcher uses. Update `QUICK_LABELS`
   keys accordingly. Either add a medication entry (`medication_administered`
   if it exists in `EVENT_CAPTURE_REGISTRY`; otherwise drop the `medicacion`
   chip from the row — `CaptureBox` already lacks one).

   In `onQuick`, append `text` to the URL when it's non-empty:

   ```ts
   function onQuick(kind: EventType) {
     if (!active) return;
     const trimmed = text.trim();
     const params = new URLSearchParams({ kind });
     if (trimmed) params.set("text", trimmed);
     go(`/mis-mascotas/${active.publicToken}/anotar?${params.toString()}`);
   }
   ```

2. **`anotar/page.tsx`** — accept `searchParams` and forward to `CaptureBox`:

   ```ts
   export default async function CapturePage({
     params,
     searchParams,
   }: {
     params: Promise<{ publicToken: string }>;
     searchParams: Promise<{ text?: string; kind?: string }>;
   }) {
     const { publicToken } = await params;
     const { text, kind } = await searchParams;
     // … existing guard …
     return (
       // …
       <CaptureBox
         petPublicToken={pet.publicToken}
         petName={pet.name}
         initialText={text}
         initialKind={kind}
       />
       // …
     );
   }
   ```

3. **`CaptureBox.tsx`** — accept `initialText` and `initialKind`. On mount:

   - If `initialKind` matches a `QUICK_ACTIONS` entry, build the deeplink
     for that event type with `text` (if present) appended as a slot —
     specifically, set the form's `note` slot (or whichever slot the
     registry entry treats as free-text) to `text`, then `router.replace`
     to the kind form. The owner skips the identify step entirely.
   - If only `initialText` is present, seed `useState(text, …)` with it
     and submit on mount (call `identify`) so the matcher runs and the
     owner lands on the right form without an extra tap. Show a small
     "Identificando…" intermediate state.
   - If neither is present, behavior is unchanged.

   For the slot wiring: inspect `EVENT_CAPTURE_REGISTRY[eventType].prefillSlots`
   and pick the most note-like slot (probably `note` or `description`). If no
   such slot exists, append `text` as a generic `note` query param and let
   the kind form decide whether to display it.

**Acceptance**

- Typing "Roma tos seca" + tapping `Vacuna` lands on the vaccination form
  with the note field prefilled with "Roma tos seca". (Yes, the owner mis-
  categorized — but the text survives so they can re-route without retyping.)
- Typing "vacuna antirrábica hoy" + tapping `Anotar →` lands on the
  vaccination form prefilled via the matcher (existing behavior, just
  verifies regression-free).
- Tapping `Vacuna` with an empty textarea behaves exactly as today
  (kind form, no text).
- The `medicacion` chip is either wired to a real event type or removed.
  Decide based on whether `medication_administered` exists in the registry.

**Tests**

Add `__tests__/event-catcher-handoff.test.ts`:

- URL builder: empty text + kind → `?kind=…`
- URL builder: typed text + kind → `?kind=…&text=…`
- URL builder: typed text + Anotar → `?text=…`
- `CaptureBox` query-param parsing: `?text=…` seeds textarea
- `CaptureBox` query-param parsing: `?kind=vaccination_administered&text=foo`
  produces the right deeplink with note slot populated

**Claude Code prompt**

```
Read docs/eventcatcher-fixes-plan-2026-05-20.md, section "PR 1". Implement
exactly what it specifies — no scope creep. Before you touch CaptureBox,
read lib/event-capture-registry.ts to confirm which slot key holds free-text
notes for each event type (vaccination_administered, weight_recorded,
vet_visit_logged, note_added, and medication_administered if present). Use
that real key, not a guess. Run `pnpm test` after — the new
event-catcher-handoff suite should be green and nothing else regresses.
```

---

## PR 2 — Active-pet visibility + chip semantic differentiation

**Why:** Once the owner starts typing, the only "which pet?" signal is a
24×24 chip in a scrolling row above, and the placeholder ("Roma — ¿qué pasó?")
disappears. For an app whose entire premise is "what happened to which pet,"
that's a real risk — especially in a foster household. Separately, pet chips
and quick-action chips look identical (both `rounded-full`) but mean very
different things (radio vs. navigation), which invites conflation.

**Files**

- `components/EventCatcher.tsx`

**Changes**

1. Add a persistent active-pet line between the chip row and the textarea:

   ```tsx
   {active && (
     <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">
       Anotando para <span className="font-medium text-neutral-900 dark:text-neutral-100">{active.name}</span>
     </p>
   )}
   ```

2. Differentiate the quick-action chips from the pet chips visually:

   - Pet chips: keep `rounded-full` (radio semantics, "pill" look)
   - Quick-action chips: change to `rounded-md`, drop `text-neutral-700`
     to `text-neutral-600`, keep border

3. Replace `opacity-50` on disabled Anotar with a distinct disabled style:

   ```tsx
   className="rounded-md bg-blue-700 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-800 disabled:bg-neutral-200 disabled:text-neutral-500 dark:bg-blue-500 dark:hover:bg-blue-600 dark:disabled:bg-neutral-800 dark:disabled:text-neutral-500"
   ```

   (The `opacity-50` approach drops `text-white on blue-700` to ~2.1:1, which fails WCAG AA. The new style is unambiguously non-actionable and well above 4.5:1.)

**Acceptance**

- Selecting a pet shows "Anotando para {name}" immediately and persistently;
  switching pets updates the name without a flash.
- Quick-action chips visually read as "secondary" — square corners, lighter
  text — without losing tappability.
- Disabled Anotar is grey, not faded blue. Hovering does nothing.

**Tests**

Snapshot or simple DOM assertions in `__tests__/event-catcher.test.tsx`
(create if absent) to verify the active-pet line renders the right name
and updates on selection change.

**Claude Code prompt**

```
Read docs/eventcatcher-fixes-plan-2026-05-20.md, section "PR 2". Make the
three changes specified. The "Anotando para {name}" line goes between the
PetChipRow render and the textarea — not above the chip row, not below the
textarea. Use the exact disabled-button classes given (don't use opacity).
Run `pnpm test` after.
```

---

## PR 3 — Accessibility: touch targets, keyboard nav, mobile-aware tip

**Why:** Three discrete a11y debts. Quick chips and Anotar are below WCAG's
44×44 recommendation. The pet chip row has `radiogroup` semantics but no
arrow-key navigation — screen-reader users will try and fail. The
`Ctrl/⌘ + Enter` tip renders on touch devices that have no Ctrl key, which
is small but cumulative noise.

**Files**

- `components/EventCatcher.tsx`

**Changes**

1. Bump touch targets:

   - Quick chips: `px-3 py-1 text-xs` → `px-3 py-2 text-sm`
   - Anotar: `py-1.5` → `py-2`
   - (Pet chips already include a 24×24 avatar so they clear ~36px height; leave alone.)

2. Add arrow-key navigation to the pet chip radiogroup. On the `<ul>`, add
   an `onKeyDown` handler that moves selection (and focus) on
   `ArrowRight`/`ArrowLeft`, wrapping at the ends:

   ```tsx
   function onChipRowKey(e: React.KeyboardEvent) {
     if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
     e.preventDefault();
     const idx = visiblePets.findIndex((p) => p.id === activeId);
     const next =
       e.key === "ArrowRight"
         ? (idx + 1) % visiblePets.length
         : (idx - 1 + visiblePets.length) % visiblePets.length;
     setActiveId(visiblePets[next].id);
     // focus the newly active chip
   }
   ```

   Use a ref map to focus the right chip button. Add `tabIndex={active ? 0 : -1}`
   to each chip so Tab only enters the group at the active item (roving tabindex).

3. Hide the `Ctrl + Enter` tip on touch devices:

   ```tsx
   <p className="mt-2 hidden text-[11px] text-neutral-500 dark:text-neutral-500 [@media(hover:hover)]:block">
     Tip: Ctrl + Enter para anotar. El texto se parsea en la próxima pantalla.
   </p>
   ```

**Acceptance**

- Quick chips and Anotar measure ≥38px tall (you'll get there with `py-2`).
- Keyboard-only user can Tab into the chip row once, then Arrow between
  pets, then Tab out into the textarea.
- The tip is invisible on mobile (DevTools mobile emulation; or real touch).

**Tests**

Add keyboard interaction test using `@testing-library/user-event`:
focus first chip, press `{ArrowRight}`, assert the second pet is selected
and focused.

**Claude Code prompt**

```
Read docs/eventcatcher-fixes-plan-2026-05-20.md, section "PR 3". Three
changes: touch target sizing, roving-tabindex arrow-key nav for the pet
chip radiogroup, and a hover-only media query on the Ctrl+Enter tip. Use
@testing-library/user-event for the keyboard test — not fireEvent. Run
`pnpm test` after.
```

---

## PR 4 — Polish + consolidation

**Why:** None of these are blockers. Group them in one PR or split as
preferred. Each is small.

**Files**

- `components/EventCatcher.tsx`
- `components/ui/InitialAvatar.tsx` (new — extracted)
- `app/(app)/inicio-v2/page.tsx` (uses InitialAvatar)

**Changes**

1. **Drop `pets.slice(0, 8)`.** Horizontal scroll already handles 9+ pets.
   Silent truncation is worse than a long scroll. If you keep a cap, render
   a final `+N más` chip that routes to `/mis-mascotas`.

2. **Submit threshold 3 → 1 char.** Owners legitimately type "tos", "pis",
   "ok". The matcher downstream handles ambiguity. Change
   `text.trim().length < 3` → `text.trim().length < 1`.

3. **Drop or rename the "Nota" chip.** Free-text → matcher already defaults
   to `note_added` when nothing else matches, so the chip is redundant. Either
   remove it, or rename to "Otro" with a clearer intent ("structured form for
   things the matcher won't recognize").

4. **Empty-state CTA: black → blue.** In the zero-pets branch, change
   `bg-neutral-900 … dark:bg-neutral-50 dark:text-neutral-900` →
   `bg-blue-700 … dark:bg-blue-500 …` so the "one affirmative blue button"
   rule holds in the empty state too.

5. **Extract `InitialAvatar` primitive.** The `Avatar` inner component and
   `inicio-v2/page.tsx`'s 40×40 letter circle are the same pattern. Pull into
   `components/ui/InitialAvatar.tsx` with `size: 'sm' | 'md'` and a
   `photoUrl: string | null` prop. Replace both call sites.

6. **(Optional, defer if PR is getting big)** Add a deterministic
   color-hash to `InitialAvatar` so each pet's fallback gets a stable but
   distinct background (hash `pet.id` to a palette of 6 muted tones). Helps
   owners visually distinguish pets in the chip row at a glance.

**Acceptance**

- An owner with 12 pets sees all 12 in the chip row (horizontal scroll).
- Typing "tos" enables the Anotar button.
- "Nota" chip is either gone or labeled "Otro".
- Zero-pet empty state CTA is blue.
- `InitialAvatar` is imported in both `EventCatcher` and `inicio-v2/page.tsx`;
  no duplicated inline avatar markup remains.

**Tests**

Light. Update existing snapshots; add a single `InitialAvatar.test.tsx`
verifying the photo-vs-initial branching.

**Claude Code prompt**

```
Read docs/eventcatcher-fixes-plan-2026-05-20.md, section "PR 4". Six small
changes. Do all six unless something feels out of scope when you get to it —
in which case stop, leave a note in the PR description explaining why, and
I'll pick it up. Skip change 6 (color hashing) for now; it's marked
optional.
```

---

## Out of scope (deliberately)

- **Matcher color scheme.** `CaptureBox` uses `bg-emerald-600` for its
  Identify CTA, which violates the "one blue button" rule at app level.
  Fix is one line but it ripples — out of scope here, worth its own pass
  alongside the rest of the design-system color audit.
- **Unifying `QUICK_ACTIONS` between EventCatcher and CaptureBox.** The
  catcher's 5 chips and the matcher's 8 chips are independent lists today.
  PR 1 partially aligns them via shared `EventType` strings, but a single
  source of truth (e.g. `lib/quick-actions.ts` exporting the canonical
  ordered list with labels) would prevent drift. Plan separately.
- **`medication_administered` event type.** If the registry doesn't have
  one, adding it is its own design pass (regimens, schedules, partial
  doses). PR 1 drops the `medicacion` chip if missing rather than inventing
  a half-implemented form.

---

## Suggested order

1. Land PR 1 first — it's the only one fixing a real bug, and PRs 2–4
   layer on top of the same files cleanly.
2. PR 2 and PR 3 can be parallel; they touch different parts of the
   component.
3. PR 4 last, once the structural changes are settled.

After PR 1–3 ship, leave the redesign in place for ~1 week of real owner
use before committing PR 4. Polish is hard to prioritize from a critique
alone; telemetry is much cheaper.
