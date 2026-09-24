# Wave 2 Item 8 — Loading & skeleton states (perceived performance)

> **Status:** ✅ Implemented · **PR:** #TBD · **Date:** 2026-06-18
> **Spec:** `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-wave2-ux-hardening-handoff.md` § Item 8
> **Branch:** `feat/wave2-item8-loading-skeletons` → `develop`

---

## Problem

`loading.tsx` count was **0** across the entire app. Nearly every page is
`force-dynamic` with a blocking Postgres round-trip, so every navigation
freezes the screen. The app is a PWA used on mobile networks; govt dashboards
add server-side aggregation on top.

---

## Solution

Instantaneous shell (Item 7 AppShell) + streaming skeleton content.

### Architecture

- **`loading.tsx` per heavy segment** — Next.js uses these for full-segment
  navigation (the user clicks a link). The shell renders immediately; the
  loading file renders inside the page boundary while the page streams.
- **Streaming pattern** — layout (shell) lives outside `<Suspense>`; heavy
  fetchers can be wrapped in `<Suspense fallback={<XSkeleton/>}>` for
  progressive hydration within a page.
- **`loading.tsx` does NOT replace `error.tsx`** — error boundaries are
  already in place per segment.

---

## New files

### Skeleton atom

| File | Props | Role |
|------|-------|------|
| `components/ui/Skeleton.tsx` | `{ w?, h?, radius?, className? }` | Base shimmer atom |

CSS lives in `app/globals.css` (`skeleton-shimmer` + `op-skeleton-shimmer`
keyframes). `prefers-reduced-motion` is handled globally (existing rule at
line ~292 collapses `animation-duration` to `0.01ms !important` — no
per-component override needed).

### Composite skeleton components

| File | Surface | Matches |
|------|---------|---------|
| `components/ui/dashboard/OpKpiSkeleton.tsx` | Operator | `OpKpi` footprint (min-h-[112px]) |
| `components/ui/dashboard/OpCardSkeleton.tsx` | Operator | `OpCard` + table/list content |
| `components/ui/LnCardSkeleton.tsx` | Owner / Public | `LnCard` (paper variant) |

### `loading.tsx` segments added

| Segment | Path |
|---------|------|
| Govt operator root | `app/gob/loading.tsx` |
| Admin operator root | `app/admin/loading.tsx` |
| Org operator root | `app/org/[orgToken]/loading.tsx` |
| Vigilancia (heavy: outbreak signals, ENO, AMR) | `app/gob/vigilancia/loading.tsx` |
| Analytics | `app/gob/analytics/loading.tsx` |
| Approval queue | `app/gob/cola/loading.tsx` |
| Govt users | `app/gob/usuarios/loading.tsx` |
| Maltrato queue | `app/gob/maltrato/loading.tsx` |
| Perdidas dashboard | `app/gob/perdidas/loading.tsx` |
| Owner home | `app/(app)/inicio/loading.tsx` |
| Pet profile | `app/(app)/mis-mascotas/[publicToken]/loading.tsx` |
| Public pet (Track D — must be fast) | `app/(public)/p/[publicToken]/loading.tsx` |
| Adoption listing | `app/(public)/adoptar/loading.tsx` |
| Adoption pet detail | `app/(public)/adoptar/[petToken]/loading.tsx` |
| Org public profile | `app/(public)/refugios/[orgToken]/loading.tsx` |
| Public case | `app/(public)/casos/[publicCode]/loading.tsx` |

---

## Design tokens

| Token | Surface | Shimmer role |
|-------|---------|-------------|
| `--color-ln-line` | Owner / Public | Base (stops) |
| `--color-ln-card` | Owner / Public | Highlight (midpoint) |
| `--color-ln-op-line` | Operator | Base (stops) |
| `--color-ln-op-card` | Operator | Highlight (midpoint) |

Gradient: `linear-gradient(90deg, line 0%, card 50%, line 100%)`, animated
`background-position` sweep at `1.5s linear infinite`.

---

## Accessibility

- Loading region: `role="status"` + `aria-busy="true"` + `aria-label="Cargando…"` + `.sr-only` inner text.
- Skeleton atoms: `aria-hidden="true"` (pure visual).
- `prefers-reduced-motion`: global CSS collapses animation to static placeholder.

---

## Tests

`__tests__/skeleton.test.tsx` — 23 assertions:

- `<Skeleton>`: aria-hidden, custom dimensions, shimmer class present.
- `<OpKpiSkeleton>`: renders, aria-hidden, operator shimmer class.
- `<OpCardSkeleton>`: default 4 rows, custom `rows` prop scaling, operator shimmer.
- `<LnCardSkeleton>`: renders, ln-line token present, no op-* tokens.
- Each `loading.tsx` (10 pages): `role="status"`, `aria-busy="true"`, SR "Cargando…" text.

---

## Edge cases

- **Empty state** — skeleton is replaced by `LnEmptyState`, never infinite.
- **Error** — existing `error.tsx` per segment handles fetch failures.
- **CLS** — `OpKpiSkeleton` matches `OpKpi` footprint (`min-h-[112px]`) exactly.
- **Slow connection** — shell paints instantly; skeleton communicates progress.

---

## What was NOT done

- No data changes, no new migrations, no new event types.
- No e2e timing tests (per spec).
- Did not edit the umbrella spec, kickoff, or `docs/planning/*`.
- Suspense wiring within individual pages is left to the page author — the
  `loading.tsx` approach covers the full-navigation case which is the most
  impactful for perceived performance without requiring page rewrites.
