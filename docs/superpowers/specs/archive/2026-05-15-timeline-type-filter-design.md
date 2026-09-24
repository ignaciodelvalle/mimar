# Timeline Type Filter — Design

**Date:** 2026-05-15
**Surface:** `app/(app)/mis-mascotas/[publicToken]/page.tsx` (pet detail)
**Status:** Approved — ready for implementation plan

## Context

The pet detail page shows a chronological event timeline (vaccinations, weight readings, vet visits, notes, etc.). As pets accumulate events, scanning for a specific type — "when was the last weigh-in?", "show me only the vaccines" — gets slower. This spec adds a lightweight type filter directly above the timeline so owners can narrow the view.

This is the smallest unit that delivers value: filter only, no grouping, no search, no URL persistence. Grouping/search become candidates after we see how the filter is used.

## User-facing behavior

A row of four chips sits above the existing "Historial" section:

```
[ Vacunas ] [ Notas ] [ Peso ] [ Visitas ]
```

- Default state: no chips selected → all events visible (current behavior).
- Tap a chip → that event type is included in the filter.
- Tap a selected chip → it is removed from the filter.
- Multiple chips can be active simultaneously (OR semantics — "show me vaccines AND notes").
- Filter state is component-local; refreshing the page resets to "show all".

Empty states:

- Pet has zero events: existing "Sin eventos todavía." message (chips are NOT shown — nothing to filter).
- Pet has events but the current filter matches none: "Sin eventos de este tipo." (chips remain visible so the user can clear).

## Out of scope (explicitly deferred)

- Grouping by month/day
- Search box (notes or payload text)
- URL query-param sync / back-button restoration of filter state
- A "Todos" master toggle chip — empty selection already means "show all"
- A "Microchip" chip — microchip events are typically one-time and noise as a recurring filter
- Pagination/virtualization — no current symptom

## Architecture

The pet detail page stays a Server Component and continues to fetch all events with `desc(petEvents.occurredAt)`. The filter state is purely client-side; only the timeline subtree becomes a Client Component.

### File changes

| File | Status | Role |
|---|---|---|
| `app/(app)/mis-mascotas/[publicToken]/page.tsx` | modified | Server. Fetches events, renders hero / info grid / action buttons. Replaces the inline `<ol>…</ol>` with `<EventTimeline events={events} />`. |
| `app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx` | new | Client. Holds filter state. Renders chip row + filtered `<ol>`. |
| `lib/events.ts` | new | Exports `eventPayloadSummary(eventType, payload)` (currently inline in `page.tsx`). Pure switch — used by the client component. |

### Component contract

```tsx
// app/(app)/mis-mascotas/[publicToken]/EventTimeline.tsx
"use client";

type Props = {
  events: Array<{
    id: string;
    eventType: string;
    payload: unknown;
    occurredAt: Date | string;
    notes: string | null;
  }>;
};

export function EventTimeline({ events }: Props) { … }
```

The `events` array is already JSON-serializable when it crosses the server→client boundary. No additional shaping needed.

### Filter logic

```ts
const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

const filteredEvents =
  selectedTypes.size === 0
    ? events
    : events.filter((e) => selectedTypes.has(e.eventType));
```

Toggle:

```ts
function toggleType(type: string) {
  setSelectedTypes((prev) => {
    const next = new Set(prev);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    return next;
  });
}
```

### Chip definitions

A const array, kept inside `EventTimeline.tsx`:

```ts
const FILTER_CHIPS: ReadonlyArray<{ type: string; label: string }> = [
  { type: "vaccination_administered", label: "Vacunas" },
  { type: "note_added", label: "Notas" },
  { type: "weight_recorded", label: "Peso" },
  { type: "vet_visit_logged", label: "Visitas" },
];
```

### Styling

- Chip row: `flex flex-wrap gap-2 mb-3`.
- Selected chip: `bg-neutral-900 text-white dark:bg-neutral-50 dark:text-neutral-900`.
- Unselected chip: `border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-900`.
- Shared: `px-3 py-1 rounded-full text-xs font-medium transition-colors`.

(Matches the existing minimal aesthetic — neutral palette, rounded-pill chips, dark-mode pair.)

## Data flow

1. Server (`page.tsx`) fetches all events for the pet via existing query.
2. Server renders `<EventTimeline events={events} />`. Events serialize across the boundary.
3. Client component renders the chip row + the full event list (initial filter empty).
4. User taps a chip → `setSelectedTypes` → React re-renders the `<ol>` with the filtered array. No network call.
5. Refreshing the page resets state. `useState` initializer always starts from an empty set.

## Error handling

None required — pure in-memory filter on already-fetched data. No I/O, no async, no failure modes.

## Verification (manual smoke test)

Tested by clicking through the dev server (`pnpm dev`, `/mis-mascotas/{token}`):

1. Pet with mixed event types (≥ one of each filterable type):
   - All four chips render. All events visible by default.
   - Tap "Vacunas" → only `vaccination_administered` events.
   - Tap "Notas" → vaccines + notes (OR semantics).
   - Tap "Vacunas" again → only notes.
   - Tap "Notas" again → all events visible again (empty selection).
2. Pet with zero events: existing "Sin eventos todavía." message. No chip row.
3. Pet with events but filter matches none (e.g., only weight events, filter "Vacunas"): chips render, list area shows "Sin eventos de este tipo."
4. Dark mode renders chips with the inverted palette.
5. Mobile viewport (≤ 375 px): chips wrap onto a second row without horizontal scroll.

## Open questions / risks

None blocking. Two minor non-blocking notes:

- `eventPayloadSummary` currently lives inside `page.tsx`. Extracting it to `lib/events.ts` is a small refactor; the existing import surface of `page.tsx` doesn't change for callers.
- The empty-filter message "Sin eventos de este tipo." copy is a placeholder; final Spanish copy can be tweaked in implementation if a more natural phrasing emerges.
