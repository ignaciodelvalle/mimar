# components/ — design system map

Compact orientation for contributors and agents touching UI. Read this before
adding a new primitive or reaching for a raw HTML element.

## Two skins, never mixed per screen

- **Ln\* — citizen skin.** Warm paper palette (`--color-ln-paper`, `--color-ln-card`),
  used on public/citizen surfaces (pet profiles, wizards, forms under the
  citizen app).
- **Op\* — operator skin.** Navy/teal rail chrome for `app/gob`, `app/admin`,
  `app/org` consoles (`components/ui/dashboard/*`).

A single screen renders with exactly one skin. Do not import `Op*` components
into a citizen page or `Ln*` components into an operator console — the two
palettes are not designed to sit side by side.

## Where tokens live

- `app/globals.css` — the single source of truth for design tokens.
  - `--color-ln-*` — citizen palette (azul, celeste, ink, mute, paper, ok/warn/err,
    rosa, violeta, plus `-050/-100/-bg/-bd` tint/border variants).
  - `--color-ln-op-*` / `--color-ln-tl-*` — operator rail palette (navy for
    gob/admin, teal for org).
  - `--color-st-*` — **semantic status indirection layer.** Status components
    (badges, pills, KPIs) must read tone from `--color-st-ok/warn/err/info`
    (+ `-bg`/`-bd`), never a raw `ln-ok`/`ln-op-ok` class directly. The
    `.op-surface` block remaps `--color-st-*` to the operator equivalents at
    the shell root, so the *same* component renders the correct skin's tone
    automatically — this is what keeps a status pill from rendering "green"
    on an operator surface that expects amber/red.
  - `--text-*`, `--space-*`, `--radius-*`, `--shadow-*` — scale tokens for
    font size, spacing, radius, and elevation. Prefer these over Tailwind
    arbitrary values (`text-[13px]`, `p-[10px]`, `rounded-[6px]`).

## Key primitives (one line each)

Citizen (`components/ui/*`):

| Component | Purpose |
|---|---|
| `LnButton` (`Button.tsx`) | Primary/secondary/ghost button, citizen skin. |
| `LnField` / `LnInput` / `LnSelect` / `LnTextarea` (`Field.tsx`) | Form field wrapper + controls with validation styling. |
| `LnChip` / `LnChipGroup` / `LnStatusDot` / `LnPetPill` (`Chip.tsx`) | Selectable chips and small status dots/pills. |
| `LnBadge` (`Badge.tsx`) | Generic label badge (non-status decoration). |
| `LnStatusFlag` / `LnVstamp` / `LnMemorialChip` (`StatusFlag.tsx`) | Pet-status flag banner, verification stamp, "en memoria" chip. |
| `LnRegRow` / `LnRegistry` / `LnPetPhoto` (`RegRow.tsx`) | Registry list row and photo thumbnail for pet listings. |
| `LnCard` / `LnCardHead` / `LnCardBody` / `LnSheet*` (`Card.tsx`) | Card surface and its header/body/sheet variants. |
| `LnWizardShell` (`WizardShell.tsx`) | Multi-step wizard chrome (back button, progress bar, step slot). |
| `Sheet` (`VaulSheet.tsx`) + `LnSheet*` (`Sheet.tsx`) | Bottom-sheet modal (Vaul-backed) and its content building blocks. |

Operator (`components/ui/dashboard/*`):

| Component | Purpose |
|---|---|
| `OpButton` | Primary/secondary/danger button, operator skin. |
| `OpKpi` / `OpKpiSm` | KPI tile (full and compact) for dashboard headers. |
| `OpPill` | Status pill for case/event states; delegates to `OpStatusPill` + `st-*` tones. |
| `CaseStatusBadge` | Case-status badge (open/escalated/closed/merged grammar). |
| `OpRailNav` | Left-rail navigation links inside `OpRail`. |
| `OpCard` / `OpCardHead` / `OpCardBody` | Dashboard card surface. |
| `OpField` / `OpInput` / `OpSelect` / `OpTextarea` / `OpSubmitButton` | Operator form field set — the ONLY source of the `ln-op-*` control chrome (`lint:op-controls` holds hand-rolled copies at zero). Density via `size="md|sm|xs"`, width via `block`. |

## Rules

1. **Prefer existing primitives over raw elements.** A raw `<button>` skips
   focus-ring, disabled/loading, and touch-target handling that `LnButton`/
   `OpButton` already solve. `pnpm lint:buttons` (`scripts/check-raw-buttons.mjs`)
   ratchets the raw `<button>` count in `app/gob`, `app/admin`, `app/org` —
   it fails if the count goes up, so new code must use `LnButton`/`OpButton`.
2. **Design tokens over hex/arbitrary values.** `pnpm lint:tokens`
   (`scripts/check-design-tokens.ts`) blocks raw Tailwind palette utilities,
   `dark:` prefixes, arbitrary hex, and (via ratchet) arbitrary
   text/spacing/radius/shadow values. Use the `--color-ln-*` / `--text-*` /
   `--space-*` / `--radius-*` / `--shadow-*` tokens instead.
3. **`st-*` semantic tones for status colors.** Any component rendering the
   open/escalated/closed/merged (or ok/warn/err/info) grammar must source
   color from `--color-st-*`, not a raw `ln-ok`/`ln-op-warn` class, so the
   tone auto-remaps between citizen and operator skins.
