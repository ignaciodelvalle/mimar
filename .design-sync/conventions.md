# MiMAR design system — build conventions

MiMAR is Argentina's digital pet credential system. It ships **two skins**
sharing one token architecture:

- **LN skin** (`Ln*` components) — citizen-facing: warm paper canvas, blue
  accents, mono uppercase status pills. Use for owner/public screens.
- **Op skin** (`Op*` components) — operator dashboards (government/admin):
  denser, serif KPI values, tone-driven tiles. Use for consoles and queues.

Never mix skins on one screen: a citizen screen uses `Ln*` components only,
an operator console uses `Op*` only.

## Setup

No provider or theme wrapper is required — components are self-contained.
The look comes entirely from `styles.css` (already loaded for you): it
carries the compiled component CSS and the token custom properties.

## Styling idiom — CSS custom properties, not invented classes

Style your own layout glue with inline styles or the token variables below.
Do NOT invent utility class names; the shipped CSS only guarantees the
components' own classes plus these tokens:

- Surfaces: `var(--color-ln-canvas)` (page), `var(--color-ln-card)` (cards)
- Accents: `var(--color-ln-azul)` / `-700` / `-900`, `var(--color-ln-celeste)`
  + tints `-050`/`-100`
- Status: `var(--color-ln-ok)`, `var(--color-ln-warn)`, `var(--color-ln-err)`
  (each with `-050`/`-100` tints; err also `-bg`)
- Fonts: `var(--font-ln-sans)` (body), `var(--font-ln-serif)` (display/KPI
  values), `var(--font-ln-mono)` (codes, status pills)
- Operator palette mirrors these under `--color-ln-op-*` (e.g.
  `ln-op-card`, `ln-op-danger`, `ln-op-azul`) — used by `Op*` components
  internally; reach for them only when composing operator layout chrome.

Component APIs are prop-driven: status/tone/variant enums carry the design
language (`status="lost"`, `tone="warn"`, `variant="danger"`). Prefer a
component prop over hand-styling every time one exists.

## Where the truth lives

Read `styles.css` and each component's `.d.ts` + `.prompt.md` before
styling. Status vocabulary is shared across components:
`"ok" | "registered" | "sick" | "lost" | "pregnant"` (pets), KPI tones
`"neutral" | "danger" | "warn" | "ok" | "blue"`.

## Idiomatic example (from a verified preview)

```tsx
import { LnField, LnInput, LnRegRow, OpKpi } from "dim";

// Citizen form row (LN skin)
<LnField label="Número de microchip" error="El número debe tener 15 dígitos." required>
  {(api) => <LnInput id={api.id} mono invalid={api.invalid} defaultValue="85800010003" />}
</LnField>

// Registry row with lifecycle status
<LnRegRow name="Michi" status="lost" breed="Común europeo" species="Gato"
  nextLine="Perdida desde el 2 de julio — Recoleta" />

// Operator KPI tile (Op skin)
<OpKpi label="Cobertura antirrábica" value="72,4%" tone="ok"
  deltaV2={{ value: 3.2, period: "vs mes anterior" }} />
```

UI copy is **es-AR** (voseo: "Contanos qué pasó"); code identifiers stay
English.
