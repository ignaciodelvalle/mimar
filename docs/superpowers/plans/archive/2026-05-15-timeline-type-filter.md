# Timeline Type Filter Implementation Plan

> **Estado (2026-06-04):** ✅ COMPLETO — enviado (commits e05978c, bebbd41).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a multi-select chip row above the per-pet event timeline that filters events by type (Vacunas / Notas / Peso / Visitas), all client-side.

**Architecture:** The pet detail page (`app/(app)/mis-mascotas/[publicToken]/page.tsx`) stays a Server Component and continues to fetch all events. The timeline `<ol>` and its `eventPayloadSummary` helper are extracted into a Client Component (`EventTimeline.tsx`) that owns `useState<Set<string>>` for filter selection. The helper is moved to `lib/events.ts` so both server and client can import it. No URL sync, no grouping, no search — those are explicitly out of scope per the spec.

**Tech Stack:** Next.js 15 (App Router, RSC), React 19 (`use client`, `useState`), Tailwind CSS (utility classes for chip styling), TypeScript, Biome (lint + format), pnpm.

**Spec reference:** [`docs/superpowers/specs/2026-05-15-timeline-type-filter-design.md`](../specs/2026-05-15-timeline-type-filter-design.md) — commit `444b237`.

**Implementation environment note:** This codebase has no test framework. Verification is `pnpm typecheck` + `pnpm lint` + a manual click-through in the dev server. Each task ends with both. The implementer should work in a git worktree (via `superpowers:using-git-worktrees`) and squash to a single feature commit at the end (matching the project's existing per-feature commit pattern), or commit per task if iterating in subagents — author's choice.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/events.ts` | **create** | Pure helper `eventPayloadSummary(eventType, payload)` — produces `{ primary, secondary }` display strings per event type. |
| `app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx` | **create** | `"use client"` component. Renders chip row + filtered `<ol>` of events. Owns `selectedTypes: Set<string>` state. |
| `app/(app)/mis-mascotas/[publicToken]/page.tsx` | **modify** | Removes inline `eventPayloadSummary` definition, replaces inline `<ol>…</ol>` block with `<EventTimeline events={events} />`. Cleans up now-unused imports (`formatDateTime`, `eventTypeLabel` move to the client component). |

The implementation order matters: Task 1 (extract helper) is a pure refactor with no behavior change. Task 2 (move timeline JSX into a client component, no filter yet) is also a pure refactor. Task 3 adds the actual filter feature. Each task leaves the app in a working state.

---

## Task 1: Extract `eventPayloadSummary` into `lib/events.ts`

**Files:**
- Create: `lib/events.ts`
- Modify: `app/(app)/mis-mascotas/[publicToken]/page.tsx` (remove lines 265–325 — the inline function; add an import; no behavior change)

- [x] **Step 1: Create `lib/events.ts`**

Write the file at `lib/events.ts` with exactly this content:

```ts
export type EventPayloadSummary = {
  primary: string | null;
  secondary: string | null;
};

export function eventPayloadSummary(
  eventType: string,
  payload: unknown,
): EventPayloadSummary {
  const p = (payload ?? {}) as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = p[k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };

  switch (eventType) {
    case "vaccination_administered": {
      const vaccine = str("vaccine_name");
      const adminBy = str("administered_by");
      const brand = str("brand");
      const tail = [adminBy, brand].filter(Boolean).join(" · ") || null;
      return {
        primary: vaccine ? `Vacuna: ${vaccine}` : null,
        secondary: tail,
      };
    }
    case "microchip_implanted": {
      const chip = str("chip_number");
      const by = str("implanted_by");
      return {
        primary: chip ? `Microchip implantado · ${chip}` : null,
        secondary: by,
      };
    }
    case "weight_recorded": {
      const kg = str("kg");
      return {
        primary: kg ? `Peso: ${kg} kg` : null,
        secondary: null,
      };
    }
    case "vet_visit_logged": {
      const reason = str("reason");
      const vetName = str("vet_name");
      const clinic = str("clinic");
      const tail = [vetName, clinic].filter(Boolean).join(" · ") || null;
      return {
        primary: reason ? `Visita: ${reason}` : null,
        secondary: tail,
      };
    }
    case "note_added": {
      const text = str("text");
      const cat = str("category");
      return {
        primary: text ? `Nota: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}` : null,
        secondary: cat ? cat.replace(/_/g, " ") : null,
      };
    }
    default:
      return { primary: null, secondary: null };
  }
}
```

This is copy-paste from the inline function currently at `page.tsx:268–325`, with an exported type alias added.

- [x] **Step 2: Update `page.tsx` — replace inline function with an import**

In `app/(app)/mis-mascotas/[publicToken]/page.tsx`:

(a) Add this import near the other `@/lib/*` imports:

```ts
import { eventPayloadSummary } from "@/lib/events";
```

(b) Delete the local `eventPayloadSummary` function definition at the bottom of the file (currently lines 265–325, including the comment block and closing brace). No other call sites change — the function name and call signature are identical.

- [x] **Step 3: Run static checks**

```
pnpm typecheck
pnpm lint
```

Expected: both exit 0. If lint fails with CRLF errors on files outside this change, that is pre-existing Windows-checkout noise (`core.autocrlf=true`) and not introduced by this task. Verify by running lint only against the touched files: `npx biome check lib/events.ts "app/(app)/mis-mascotas/[publicToken]/page.tsx"`.

- [x] **Step 4: Manual smoke check**

Dev server: `pnpm dev` (already running from earlier session — skip if so).
Open `http://localhost:3000/mis-mascotas/{publicToken}` for a pet that has at least one event of each type. Expected: timeline renders identically to before — same primary line, same secondary line, same "Ver detalle técnico" expand for every existing event. **This task is a pure refactor; any visible diff is a regression.**

- [x] **Step 5: Commit**

```bash
git add lib/events.ts "app/(app)/mis-mascotas/[publicToken]/page.tsx"
git commit -m "$(cat <<'EOF'
Extract eventPayloadSummary into lib/events.ts

Pure refactor — pulls the per-event-type display helper out of the
pet detail page so it can be reused from a client component in the
upcoming type-filter feature. No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(If squashing to a single feature commit at the end of the plan, defer the commit. See the implementation-environment note above.)

---

## Task 2: Build `EventTimeline` client component (no filter yet)

**Files:**
- Create: `app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx`
- Modify: `app/(app)/mis-mascotas/[publicToken]/page.tsx` (replace inline `<ol>` block with `<EventTimeline events={events} />`)

This is the second pure refactor: move the existing timeline JSX into a client component, no filter UI yet. The point is to isolate the move from the filter logic so any rendering regression is caught here, before chip state is introduced.

- [x] **Step 1: Create `EventTimeline.tsx`**

Write the file at `app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx`:

```tsx
"use client";

import { eventPayloadSummary } from "@/lib/events";
import { eventTypeLabel, formatDateTime } from "@/lib/format";

type Event = {
  id: string;
  eventType: string;
  payload: unknown;
  occurredAt: Date | string;
  notes: string | null;
};

type Props = {
  events: Event[];
};

export function EventTimeline({ events }: Props) {
  if (events.length === 0) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-500">Sin eventos todavía.</p>;
  }

  return (
    <ol className="space-y-3">
      {events.map((event) => {
        const summary = eventPayloadSummary(event.eventType, event.payload);
        return (
          <li
            key={event.id}
            className="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 space-y-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium text-neutral-900 dark:text-neutral-50">
                  {summary.primary ?? eventTypeLabel(event.eventType)}
                </p>
                {summary.secondary && (
                  <p className="text-xs text-neutral-500 dark:text-neutral-500">
                    {summary.secondary}
                  </p>
                )}
              </div>
              <time className="text-xs text-neutral-500 dark:text-neutral-500 shrink-0">
                {formatDateTime(event.occurredAt)}
              </time>
            </div>
            {event.notes && (
              <p className="text-sm text-neutral-700 dark:text-neutral-300">{event.notes}</p>
            )}
            <details className="text-xs text-neutral-500 dark:text-neutral-500">
              <summary className="cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-300">
                Ver detalle técnico
              </summary>
              <pre className="mt-2 p-3 rounded-lg bg-neutral-50 dark:bg-neutral-900 overflow-x-auto text-[11px] leading-relaxed">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </details>
          </li>
        );
      })}
    </ol>
  );
}
```

The JSX is copied verbatim from `page.tsx` lines 207–246 (the `<ol>` block), with the wrapping `events.length === 0 ?` ternary unwrapped into an early return. Imports for `eventTypeLabel`, `formatDateTime` move here.

- [x] **Step 2: Update `page.tsx` to use the client component**

In `app/(app)/mis-mascotas/[publicToken]/page.tsx`:

(a) Add an import at the top:

```ts
import { EventTimeline } from "./EventTimeline";
```

(b) Replace the entire `<section className="space-y-3">…</section>` block that currently holds the "Historial" header + the `events.length === 0 ?` ternary + the `<ol>` (currently lines 199–248) with:

```tsx
<section className="space-y-3">
  <h2 className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
    Historial
  </h2>
  <EventTimeline events={events} />
</section>
```

(c) Remove now-unused imports from `page.tsx`: `eventTypeLabel`, `formatDateTime` (they are now consumed inside `EventTimeline.tsx`). Confirm with typecheck.

- [x] **Step 3: Run static checks**

```
pnpm typecheck
pnpm lint
```

Expected: both exit 0 (or, for lint, no errors on touched files — see Task 1 Step 3 note about pre-existing CRLF noise).

- [x] **Step 4: Manual smoke check**

Hard-reload the pet detail page in the browser. Expected: timeline still renders, every event card looks identical (primary, secondary, time, notes, expandable JSON). Open DevTools → Network: the page is still server-rendered (no client fetch for events). Open DevTools → Console: no errors. **Still a pure refactor; any visible diff is a regression.**

- [x] **Step 5: Commit (or defer for squash)**

```bash
git add "app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx" "app/(app)/mis-mascotas/[publicToken]/page.tsx"
git commit -m "$(cat <<'EOF'
Extract timeline rendering into EventTimeline client component

Moves the per-event <ol> block from the pet detail page into a
client component as preparation for adding type-filter chips. No
behavior change yet — events render identically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add the filter chips and selection state

**Files:**
- Modify: `app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx` (add `FILTER_CHIPS`, `useState`, chip-row JSX, filtered list, new "no matches" empty state)

- [x] **Step 1: Add the chip constant and filter state**

At the top of `EventTimeline.tsx`, immediately after the imports, add:

```ts
const FILTER_CHIPS: ReadonlyArray<{ type: string; label: string }> = [
  { type: "vaccination_administered", label: "Vacunas" },
  { type: "note_added", label: "Notas" },
  { type: "weight_recorded", label: "Peso" },
  { type: "vet_visit_logged", label: "Visitas" },
];
```

Add the `useState` import:

```ts
import { useState } from "react";
```

Inside the `EventTimeline` function body (above the `events.length === 0` early return), add:

```ts
const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

function toggleType(type: string) {
  setSelectedTypes((prev) => {
    const next = new Set(prev);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    return next;
  });
}

const filteredEvents =
  selectedTypes.size === 0
    ? events
    : events.filter((e) => selectedTypes.has(e.eventType));
```

- [x] **Step 2: Replace the early return + the `<ol>` with chips + filtered list**

Replace the entire current `EventTimeline` return logic (everything after the new state declarations) with:

```tsx
if (events.length === 0) {
  return <p className="text-sm text-neutral-500 dark:text-neutral-500">Sin eventos todavía.</p>;
}

return (
  <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      {FILTER_CHIPS.map((chip) => {
        const isSelected = selectedTypes.has(chip.type);
        return (
          <button
            key={chip.type}
            type="button"
            onClick={() => toggleType(chip.type)}
            aria-pressed={isSelected}
            className={
              isSelected
                ? "px-3 py-1 rounded-full text-xs font-medium transition-colors bg-neutral-900 text-white dark:bg-neutral-50 dark:text-neutral-900"
                : "px-3 py-1 rounded-full text-xs font-medium transition-colors border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            }
          >
            {chip.label}
          </button>
        );
      })}
    </div>
    {filteredEvents.length === 0 ? (
      <p className="text-sm text-neutral-500 dark:text-neutral-500">
        Sin eventos de este tipo.
      </p>
    ) : (
      <ol className="space-y-3">
        {filteredEvents.map((event) => {
          const summary = eventPayloadSummary(event.eventType, event.payload);
          return (
            <li
              key={event.id}
              className="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium text-neutral-900 dark:text-neutral-50">
                    {summary.primary ?? eventTypeLabel(event.eventType)}
                  </p>
                  {summary.secondary && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-500">
                      {summary.secondary}
                    </p>
                  )}
                </div>
                <time className="text-xs text-neutral-500 dark:text-neutral-500 shrink-0">
                  {formatDateTime(event.occurredAt)}
                </time>
              </div>
              {event.notes && (
                <p className="text-sm text-neutral-700 dark:text-neutral-300">{event.notes}</p>
              )}
              <details className="text-xs text-neutral-500 dark:text-neutral-500">
                <summary className="cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-300">
                  Ver detalle técnico
                </summary>
                <pre className="mt-2 p-3 rounded-lg bg-neutral-50 dark:bg-neutral-900 overflow-x-auto text-[11px] leading-relaxed">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    )}
  </div>
);
```

The `<ol>` body is identical to Task 2 — only the data source changed (`filteredEvents` instead of `events`), and the empty-state branch was inverted into a ternary.

- [x] **Step 3: Run static checks**

```
pnpm typecheck
pnpm lint
```

Expected: both exit 0 (modulo pre-existing CRLF noise on untouched files — see Task 1 Step 3 note).

- [x] **Step 4: Manual smoke check — full filter behavior**

For a pet with at least one event of each filterable type (Vacunas, Notas, Peso, Visitas):

1. Load the pet detail page. Expected: all four chips render unselected. All events visible.
2. Click "Vacunas". Expected: chip turns dark; only `vaccination_administered` events remain.
3. Click "Notas". Expected: vaccines + notes visible (OR semantics). Both chips dark.
4. Click "Vacunas" again. Expected: only notes visible.
5. Click "Notas" again. Expected: all four chips unselected; all events visible.
6. Select only "Peso" on a pet that has NO weight events. Expected: chip is dark; below it, the message **"Sin eventos de este tipo."** appears; the chip row stays visible so you can clear.
7. Toggle the OS / browser to dark mode. Expected: chips swap palette — selected chip is light, unselected chips are dark-bordered.
8. Resize to 375 px viewport. Expected: chip row wraps to a second row if needed; no horizontal scroll.

Also: open a pet with **zero events**. Expected: existing "Sin eventos todavía." message; chip row NOT rendered.

- [x] **Step 5: Commit (or, if squashing, do the final feature commit now)**

```bash
git add "app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx"
git commit -m "$(cat <<'EOF'
Add type-filter chips to the per-pet event timeline

Multi-select chip row above the timeline. Vacunas / Notas / Peso /
Visitas; tap to toggle. Empty selection shows all events. Filter
state is component-local and resets on page refresh.

Spec: docs/superpowers/specs/2026-05-15-timeline-type-filter-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If squashing the three tasks into one feature commit:

```bash
# After all three tasks' edits are staged
git add lib/events.ts "app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx" "app/(app)/mis-mascotas/[publicToken]/page.tsx"
git commit -m "$(cat <<'EOF'
Add type-filter chips to the per-pet event timeline

- Extract eventPayloadSummary to lib/events.ts
- New EventTimeline client component owns chip-filter state
- Pet detail page mounts the client component, stays server-rendered
- Vacunas / Notas / Peso / Visitas; empty selection shows all events

Spec: docs/superpowers/specs/2026-05-15-timeline-type-filter-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

After all three tasks land, run from main:

```
pnpm typecheck
pnpm lint
```

Both exit 0. Reload `/mis-mascotas/{publicToken}` in the dev server one last time and run through Task 3 Step 4's full smoke checklist. If anything fails, fix in a follow-up commit rather than amending; the project's pattern is to add fresh commits, not amend (see `git log --oneline` for prior style).

## Out of scope (do not implement)

These are explicitly deferred per the spec — do not add them while you're in here:

- Grouping events by month/day
- Search box (notes only or all payload)
- URL query param sync / back-button restoration
- "Todos" master toggle chip
- "Microchip" chip
- Pagination or virtualization
- Persisting filter state across page reloads
