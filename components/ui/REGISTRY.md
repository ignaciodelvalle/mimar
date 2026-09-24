# UI Component Registry

## Antes de construir UI, buscá acá

**This file is mandatory reading before you add any UI.** DIM already has a
canonical primitive for almost every shape — buttons, tabs, badges, fields,
sheets, cards, KPIs, empty states. Reimplementing one by hand means: wrong
focus rings, wrong touch targets, raw palette classes that fail `lint:tokens`,
and a raw `<button>` that fails `lint:buttons`. **Find the primitive here, use
it, extend it if it's missing a prop — do not clone it.**

Two skins coexist:

- **`Ln*`** — the **citizen / owner** surface (public pages, owner PWA). Warm
  "Poncho" credential aesthetic. Files at `components/ui/*`.
- **`Op*`** — the **operator** surface (`/gob`, `/admin`, `/org` dashboards).
  Denser, cooler operator chrome. Files at `components/ui/dashboard/*`.

Pick the skin that matches the surface you're building. Never render a citizen
`Ln*` status tone on an operator surface (that was the CaseBadge regression —
see the variant-map note below).

---

## Buttons & actions — DON'T write a raw `<button>`

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnButton` | `Button.tsx` | Citizen buttons. Variants: `primary\|seal\|ghost\|ok\|warn`, sizes `sm\|md\|lg`. | No raw `<button>` on citizen surfaces. |
| `LnLinkButton` | `LinkButton.tsx` | A **link** styled as a button (`<a>`/`<Link>`). Shapes `pill\|block`, fill `filled\|outline`. | Don't wrap `LnButton` in an anchor. |
| `OpButton` | `dashboard/OpButton.tsx` | Operator buttons. Variants: `primary\|ghost\|danger\|ok`. | No raw `<button>` on `/gob`, `/admin`, `/org` — `lint:buttons` fails. |
| `IconCircleButton` | `IconCircleButton.tsx` | Icon-only round control. | Don't hand-roll a round icon button. |
| `CopyButton` | `CopyButton.tsx` | Copy-to-clipboard with feedback. | Don't reimplement clipboard + toast. |
| `ConfirmDialog` | `ConfirmDialog.tsx` | Destructive/confirm gate. Tones `danger\|warn\|neutral`. | Don't roll your own confirm modal. |
| `OpSubmitButton` | `dashboard/OpField.tsx` | Operator form submit with pending state. | Don't wire `useFormStatus` by hand. |

## Tabs & navigation — no reimplementes tabs

| Component | File | Use for | DON'T |
|---|---|---|---|
| `UrlTabs` / `UrlTabsContent` | `UrlTabs.tsx` | Tabs whose active state lives in the **URL** (`?tab=`), shareable/deep-linkable. | No reimplementes tabs. Don't sync tabs to the URL by hand. |
| `LnTabs` | `Tabs.tsx` | Tabs with **local** active state (no URL). | No reimplementes tabs. |
| `LnAccordion` / `LnAccordionGroup` | `Tabs.tsx` | Collapsible sections. | Don't build a `<details>` accordion ad hoc. |

## Badges, chips & status

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnBadge` | `Badge.tsx` | Citizen inline badge. | — |
| `LnChip` / `LnChipGroup` / `LnStatusDot` / `LnPetPill` | `Chip.tsx` | Chips, selectable chip groups, status dots, pet pills. | Don't hand-color status dots. |
| `LnStatusFlag` / `LnVstamp` / `LnMemorialChip` | `StatusFlag.tsx` | Pet status flag, vaccination stamp (`ok\|due\|over`), memorial chip. | — |
| `OpPill` / `OpStatusPill` / `OpStateBadge` / `OpCodeBadge` / `CaseStatusBadge` | `dashboard/*` | Operator pills & status badges. `OpStatusPill` is the shared status primitive (tones `st-ok\|st-warn\|st-err\|st-info\|neutral`). | Don't hardcode a status color — use the `st-*` tone so it remaps per skin. |
| `AmendedBadge` | `AmendedBadge.tsx` | "Corrected by amendment" marker. | — |

## Callouts & alerts

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnAlert` | `Alert.tsx` | Citizen inline alert/notice. | — |
| `LnCallout` | `DocElements.tsx` | Credential-doc callout (tones `azul\|warn`). | — |
| `OpCallout` | `dashboard/OpCallout.tsx` | Operator callout (title + body + icon). | — |
| `OpFormAlert` | `dashboard/OpField.tsx` | Form-level error banner in operator forms. | — |
| `HoverTip` | `HoverTip.tsx` | Lightweight HOVER/focus tooltip (WAI-ARIA, reduced-motion-safe): a glossary acronym that expands on hover, an icon-only control's label, a rich row/map preview. Skin-neutral (light card popover). | Don't hand-roll a `title=`/`onMouseEnter` tooltip. NOT the same as OpKpi's ⓘ (that's a CLICK-toggled dense info popover) — use that for KPI definitions, this for lightweight labels. v1 doesn't flip at the viewport edge or portal out of `overflow:hidden` — extend it if a call site needs that. |
| `GlossaryTerm` | `GlossaryTerm.tsx` | Wraps an operator-jargon term (ENO, SLA, PII, PPP, RUPPPA, k<5, P75, "no cohorte") in a dotted-underline + a `HoverTip` with its plain-es-AR definition (from `lib/reference/glossary.ts`). Unknown term → renders plainly. | Don't inline a definition tooltip by hand — add the term to `lib/reference/glossary.ts` and wrap it. Definitions are VERIFIED against the repo's legal/reference sources — no invented expansions. |

## Fields & forms

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnField` + `LnInput` / `LnSelect` / `LnTextarea` / `LnRow` | `Field.tsx` | Citizen form fields with label/hint/error + native validation localized to es-AR (`localizedValidationMessage`). | Don't render a bare `<input>` — you lose validation + a11y wiring. |
| `OpField` + `OpInput` / `OpSelect` / `OpTextarea` | `dashboard/OpField.tsx` | **The** operator control chrome (`/gob`, `/admin`, `/org`): border `ln-op-line`, bg `ln-op-card`, `focus-visible:ring-ln-op-azul`. Props mirror the `Ln*` side — `invalid` → `aria-invalid`, `mono`, className merges — plus `size="md"` (forms, default) / `"sm"` (filter bars, dense rows). | Don't hand-roll `border-ln-op-line bg-ln-op-card …` on a raw `<input>`/`<select>`/`<textarea>` — `lint:op-controls` fails. Don't pass `text-sm`/`px-2` through className to shrink a control: same-layer Tailwind utilities, the base may win. Use `size`. |
| `OP_CONTROL_CLASS` / `OP_CONTROL_CLASS_SM` | `dashboard/OpField.tsx` | The op control chrome as a bare class string, for a **composed** control that can't render through `OpInput` (e.g. a visible field plus a hidden twin). Operator counterpart to `LN_CONTROL_CLASS`. | Don't copy the class string into a component — import it, or the spellings drift again (they did: 35 variants across 92 sites). |
| `DateInputAr` | `DateInputAr.tsx` | Argentine date entry (dd/mm/aaaa). | Don't use a raw `<input type="date">` for AR dates. |
| `TimeInputAr` | `TimeInputAr.tsx` | Argentine time entry (HH:mm, 24 h). Pair with `DateInputAr` and compose the two halves into `"YYYY-MM-DDTHH:mm"` client-side when a flow needs a single datetime field (see `PetSightingForm`). | Don't use a raw `<input type="time">` — same browser-locale defect as `type="date"` (an en-US browser shows an AM/PM clock). And don't use `<input type="datetime-local">` on a citizen surface at all. |
| `LnCombobox` | `LnCombobox.tsx` | Autocomplete/combobox shell — WAI-ARIA APG pattern (`role="combobox"`, listbox/option, aria-activedescendant), ArrowUp/Down/Enter/Escape, blur-close-after-mousedown. Caller supplies pre-filtered `items` + `renderItem` (its OWN matching algorithm stays outside — async server search vs sync client filter are both valid) and controls `open`. Used by `LocalityPickerAcross` and the vaccine-name field in `VaccinationForm`. | Don't hand-roll another `ul`/`li`/`button` typeahead — extend this one (e.g. a new `filter`-injection shape) instead of copying its keyboard layer again. |
| `LnToggle` / `LnToggleGroup` | `Toggle.tsx` | Toggles / segmented choices (`azul\|amber`). | — |
| `WizardShell` (`LnWizardShell`) | `WizardShell.tsx` | Multi-step wizard chrome. | Don't hand-build step headers/progress. |

## Cards, sheets & surfaces

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnCard` / `LnCardHead` / `LnCardBody` | `Card.tsx` | Citizen card surface. | — |
| `LnSheet` / `LnSheetPet` | `Card.tsx` | Inline sheet-style panel (tones `azul\|verde\|warn\|violeta\|seal`). | — |
| `LnSheetPage` family (`LnSheetHeader/Body/Footer/Card/Wrap/…`) | `Sheet.tsx` | Full citizen "sheet page" layout (flow/wizard pages). | — |
| `Sheet` (Vaul) | `VaulSheet.tsx` | Bottom/right **drawer** modal (`bottom\|right`). | Don't build a portal+overlay drawer by hand. |
| `OpCard` / `OpCardHead` / `OpCardBody` | `dashboard/OpCard.tsx` | Operator card surface. | — |
| `LnHero` | `Hero.tsx` | Citizen page hero. | — |

## Lists, tables & KPIs

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnLedger` / `LnVaccineLedger` | `Ledger.tsx` | Citizen tabular ledger (typed columns). | Don't render a raw `<table>` for ledger data. |
| `LnRegRow` / `LnRegistry` / `LnPetPhoto` | `RegRow.tsx` | Registry rows + pet photo thumbnail. | — |
| `LnListRow` | `ListRow.tsx` | Minimal simple-list row: optional icon + label/meta content + optional trailing slot, optionally the whole row as a `Link`. Layout-only — icon/children/trailing are caller-styled, so it works for both `ln-*` and `ln-op-*` skins without a skin prop. Used by `CasesWidget.tsx` and `pet-profile/FutureLedgerList.tsx`. | Don't hand-roll another `<li className="flex items-center gap-3">` icon+label+meta+trailing row — use this. Don't reach for it for pet-registry rows (`LnRegRow`), typed tabular data (`LnLedger`), or an operator table with bulk-select/filters (`CaseQueue`) — those stay on their own primitives. |
| `DiscList` / `DiscRow` | `../pet-profile/DiscList.tsx` | Disc-bulleted definition lists on the pet profile. | — |
| `OpKpi` / `OpKpiSm` | `dashboard/OpKpi.tsx` | Operator KPI tile (value + tone + trend). | Don't build a KPI tile from scratch — see the `dataviz` skill for chart tiles. |
| `KpiStrip` | `dashboard/KpiStrip.tsx` | Row of KPIs. | — |
| `ResultCount` | `ResultCount.tsx` | The "cuántos veo, de cuántos" line under any capped or paginated list. Models the EPISTEMIC split explicitly: pass `total` only when it is genuinely known ("Mostrando 12 de 1.263 casos"); omit it when the query merely capped, and it renders "Mostrando los primeros 200 — hay más" instead of inventing a universe. `hint` (the escape hatch) only renders when there IS more to reach. | Don't hand-roll another "Mostrando …" string — there were ~12 wordings before this. Don't pass `total={items.length}` on a capped query: that claims the cap IS the total. |
| `AnimatedNumber` | `AnimatedNumber.tsx` | A number that eases from its previous value to a new one ON CHANGE ("conteo arriba/abajo"), so a KPI shows its delta viscerally. `format` owns rounding + es-AR. Client tween; SSR + reduced-motion render the exact value. Backed by `useCountUp` (`lib/hooks/useCountUp.ts`) + `useReducedMotion` (`lib/hooks/useReducedMotion.ts`, the shared JS-animation floor). | Don't hand-roll a RAF/setInterval counter. Pass a NUMBER, not a pre-formatted string (the tween needs the numeric value + a `format`). |

## Captura rápida

| Component | File | Use for | DON'T |
|---|---|---|---|
| `CaptureConfidenceCard` | `CaptureConfidenceCard.tsx` | Presentational confirm/edit card for a fuzzy-matched capture result (event type + fields + confidence). Shared by the atender console, the notification quick-reply, and a future OCR pipeline. ZERO matching logic inside — caller resolves the match (e.g. `lib/reference/vaccine-fuzzy-match.ts`, `lib/events/event-capture-matcher.ts`) and only passes the resolved `fields`/`confidence` in. | Don't embed matching/scoring logic in this component. Don't render confidence as color only — it always carries text (WCAG). |

## Panorama primitives

| Component | File | Use for | DON'T |
|---|---|---|---|
| `DeltaGlyph` | `../panorama/DeltaGlyph.tsx` | Up/down/flat period-delta glyph next to a KPI delta figure (`KpiDelta["direction"]`). Used by `PanoramaKpiTile` and `KpiChips`. | Don't re-inline the up/down/flat glyph switch — it was a verbatim copy-paste in both call sites before this extraction. |
| `Sparkline` (+ `sparklinePath`) | `../panorama/Sparkline.tsx` | Inline dependency-free SVG trend line for panorama KPI cards (`KpiChips`, `PanoramaKpiTile`'s `OpKpi`). `sparklinePath` is the pure, unit-testable path-math helper. | This is the panorama-specific SVG sparkline — do not confuse with `dashboard/OpKpiSparkline.tsx` (recharts-based); reconciling the two is a separate, larger migration, not a drop-in swap. |

## Empty & loading states

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnEmptyState` | `EmptyState.tsx` | Citizen empty state (icon + message + action). | Don't write a bespoke "no hay datos" block. |
| `Skeleton` / `LnCardSkeleton` | `Skeleton.tsx`, `LnCardSkeleton.tsx` | Citizen loading placeholders. | — |
| `OpCardSkeleton` / `OpKpiSkeleton` | `dashboard/*` | Operator loading placeholders. | — |
| `OpDashboardSkeleton` | `dashboard/OpDashboardSkeleton.tsx` | Shared `loading.tsx` skeleton for operator (gob/admin/org) list/dashboard segments — filter-bar strip + optional KPI row + `OpCardSkeleton` block(s), owns the `<output aria-busy>` wrapper. Use this in a new segment `loading.tsx` instead of hand-rolling the KPI grid / card list again. | Don't hand-roll another `<output aria-busy>` + KPI-grid + card-list skeleton — pass `kpis`/`cards`/`filterBar` to this one. |
| `LnPageSkeleton` | `LnPageSkeleton.tsx` | Shared `loading.tsx` skeleton for citizen (`app/(app)/*`) list segments — header + registry-row shimmer, owns the `<output aria-busy>` wrapper. Generalizes the shape already proven by `mis-mascotas/loading.tsx`. | Don't hand-roll another header+rows citizen skeleton — pass `rows`/`cta`/`avatar` to this one. |

## Partial success / bulk-result states

| Component | File | Use for | DON'T |
|---|---|---|---|
| `OpBulkResultPanel` | `dashboard/OpBulkResultPanel.tsx` | Post-bulk-action partial-success/failure feedback ("N OK · M fallaron" + per-item failure reasons + `bulk:` id footer). Replaces 3 duplicated inline `ResultPanel` functions (`components/BulkApprovalQueueList.tsx`, `components/AdoptionQueueList.tsx`, `app/org/[orgToken]/mascotas/OrgMascotasBulkList.tsx`) that had converged on the same shape independently. Takes `successLabel` (defaults to `"OK"`; pass a pluralized noun like `"vacunadas"`) and `truncateFailedIdsTo` (omit for full ids) so each caller keeps its own prior behavior. `role`/`aria-live` handled via an `<output>` wrapper (implicit "status" role — a result announcement, not a destructive alert). | Don't hand-roll another bulk-result panel — extend this one's props instead. Domain-specific success-noun computation (e.g. singular/plural "vacunada(s)") stays in the caller, not in this primitive. |

## Connectivity & availability states

| Component | File | Use for | DON'T |
|---|---|---|---|
| `LnOfflineBanner` | `OfflineBanner.tsx` | Full-width "sin conexión" notice mounted via `AppShell`'s citizen `banner` slot. Renders nothing while online — a thin wrapper around `useOnline()` (`lib/hooks/useOnline.ts`). | Don't re-implement connectivity polling — extend `useOnline()`. Don't use `role="alert"` — connectivity loss is informational (`role="status"`/`aria-live="polite"`), not destructive. |
| `OpOfflineBanner` | `dashboard/OpOfflineBanner.tsx` | Same as `LnOfflineBanner`, Op-skinned (`--color-ln-op-warn-bg`/`-bd`). Mounted via `AppShell`'s operator `banner` slot in `/gob`, `/admin` (composed with `DemoModeBanner`), `/org`. | — |
| `LnMaintenanceScreen` | `MaintenanceScreen.tsx` | Full-page "en mantenimiento" state for the citizen shell, rendered by `app/(app)/layout.tsx` BEFORE any auth/data fetch when `isMaintenanceMode()` (`lib/domain/maintenance-mode.ts`, env `NEXT_PUBLIC_MAINTENANCE_MODE`) is true. NOT wrapped in `AppShell` — no nav data exists yet at that point. | Don't add a retry/reset action — there is nothing to retry. |
| `OpMaintenanceScreen` | `dashboard/OpMaintenanceScreen.tsx` | Same as `LnMaintenanceScreen`, Op-skinned. Mounted at the top of `app/gob/layout.tsx`, `app/admin/layout.tsx`, `app/org/[orgToken]/layout.tsx`. | Don't wire it into `app/(public)/*` — out of scope for this foundation step. |

Utilities backing the two states above: `useOnline()` (`lib/hooks/useOnline.ts`,
the first file in the new `lib/hooks/` convention — SSR-safe, defaults to
`true` until a `useEffect` reads `navigator.onLine`) and `isMaintenanceMode()`
(`lib/domain/maintenance-mode.ts`, mirrors `lib/domain/demo-mode.ts`'s
server-safe pure-function shape).

## Permission / access states — full-page vs in-shell

Two patterns cover insufficient-permissions states. Pick by scope, not by feel:

- **Full-page** (`app/acceso-denegado/page.tsx` wrapping `BrandedNotFound`) —
  for portal-LEVEL mismatches, where the visitor is in the wrong portal
  entirely (e.g. a `personal` role hitting `/gob`) and no shell chrome
  (nav/rail) should render around the message.
- **In-shell** (`OpBreach`, `components/ui/dashboard/OpBreach.tsx`, ~50
  existing uses) — for scope/capability restrictions WITHIN a shell the
  visitor does otherwise belong in (nav/rail still renders; only the page
  content area is restricted). This is now also the pattern used by
  `app/org/[orgToken]/admin/layout.tsx` (previously a 3rd hand-rolled
  "Acceso restringido" card — see Track B5,
  `dim-interno:docs/reviews/results/2026-07-21-nivel-siguiente-plan.md`).

Do NOT hand-roll a third "Acceso restringido"/"restricted access" card
anywhere — use one of these two.

## Credential-document chrome

| Component | File | Use for |
|---|---|---|
| `LnGuilloche` / `LnDocCode` / `LnSeal` / `LnLabel` / `LnSectionHead` / `LnCallout` | `DocElements.tsx` | The security-document look for credential/certificate pages. |

## Icons — use the registry, not raw imports

| Component | File | Use for | DON'T |
|---|---|---|---|
| `Icon` (+ `ICON_MAP`, `iconNames`) | `../Icon.tsx` | All iconography. `ICON_MAP` is a curated `Record<string, LucideIcon>` covering every icon actually used. | Don't `import { Foo } from "lucide-react"` in a component — add the icon to `ICON_MAP` and render `<Icon name="foo" />`. |
| `Photo` | `Photo.tsx` | Pet photos with fallback. | Don't use a raw `<img>` for pet photos. |

---

## Convention: typed variant/tone maps are the single source (CVA-style)

A component's variant → className mapping lives in **one** typed lookup, keyed by
a union type, so every call site is exhaustive and the classes live in exactly
one place. This is the house version of `class-variance-authority` — the library
itself is deliberately **not** a dependency; the pattern needs no runtime.

**Canonical shape** (any `components/ui` primitive with 2+ visual variants MUST
follow this — new primitives included, no switch/ternary class branching):

```tsx
type WidgetVariant = "primary" | "secondary";

// 1. One base string: geometry, typography, focus/disabled states.
const base = "inline-flex items-center rounded-[3px] ...";

// 2. One typed Record per axis (variant, size, tone…). The union type makes
//    the map exhaustive: adding a variant without classes fails typecheck.
const variants: Record<WidgetVariant, string> = {
  primary: "bg-[var(--color-ln-azul)] text-white ...",
  secondary: "border border-[var(--color-ln-line-strong)] ...",
};

// 3. Merge with the array-filter-join idiom (the house cn(); clsx and
//    tailwind-merge are also deliberately not dependencies).
className={[base, variants[variant], className].filter(Boolean).join(" ")}
```

- **Reference implementations:** `Button.tsx` (`variants` + `sizes`, two axes),
  `SuccessScreen.tsx` (`ACTION_VARIANT_CLASSES` — converted from an ad-hoc
  `switch` to this shape as the reference refactor), `LinkButton.tsx`
  (`SHAPE_CLASSES` / `FILL_CLASSES`), `Badge.tsx`, `Alert.tsx`.
- **House example:** `OP_TONE_CLASSES` — a `Record<PetSituationTone, string>`
  mapping each situation tone to its border/background classes
  (`app/org/[orgToken]/mascotas/[publicToken]/page.tsx`). Its exhaustiveness is
  enforced by `scripts/check-ui-invariants.ts` (`lint:ui`): a new tone with no
  class entry fails CI.
- **Reusable primitive:** `TONE_CLASSES: Record<StatusTone, string>` exported
  from `dashboard/OpStatusPill.tsx` — the shared status-tone map. Prefer this
  over inlining status colors.
- **More of the same shape:** `toneTopBorder` / `toneIconBg` / `toneCtaClass`
  in `Sheet.tsx` and `Card.tsx`, `selectedClasses` in `Chip.tsx`,
  `confirmBtnClass` in `ConfirmDialog.tsx`.

When you add a variant: extend the union type **and** the map. Never scatter
`tone === "warn" ? "..." : "..."` ternaries across JSX — that's how a tone ends
up styled three different ways. Boolean modifiers (`block`, `disabled`) may stay
inline in the merge array; anything that is an enumerated visual axis goes in a
Record.

## Enforcement — fences that keep this registry honest

- **`lint:buttons`** (`scripts/check-raw-buttons.mjs`) — ratchets raw `<button>`
  count down across `/gob`, `/admin`, `/org`. New raw buttons fail; use
  `LnButton` / `OpButton`.
- **`lint:ui`** (`scripts/check-ui-invariants.ts`) — guards the situation-tone
  variant map (`OP_TONE_CLASSES`) for exhaustiveness, among other UI invariants.
- **`lint:tokens`** (`scripts/check-design-tokens.ts`) — blocks raw palette
  classes, `dark:` prefixes, arbitrary hex/px; the tone maps above must use
  `gob-*` / `ln-*` / `st-*` tokens, not raw palette utilities.
- **Tabs:** there is **no** dedicated tablist fence yet. Using `UrlTabs` /
  `LnTabs` instead of a hand-rolled tablist is convention, not CI-enforced —
  hold the line in review.

> Missing a primitive, or found one this file doesn't list? Add it here in the
> same PR. This registry is only useful if it stays complete.
