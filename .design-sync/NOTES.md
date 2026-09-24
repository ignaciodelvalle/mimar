# design-sync NOTES — DIM/MiMAR

- The repo is a Next.js APP, not a component package: no dist, no Storybook.
  The sync builds from a curated barrel `.design-sync/entry.ts` — pass
  `--entry .design-sync/entry.ts` to every converter/driver run. Expand that
  barrel (plus `componentSrcMap` and `dtsPropsFor`) to grow the synced set.
- `.design-sync/process-shim.ts` MUST stay the first import of entry.ts:
  LnPetPhoto pulls next/image whose module scope reads `process.env.*`, and
  browser IIFEs have no `process`. Import order is the fix (module-scope
  statements in the entry run too late).
- `.d.ts` auto-extraction emits `[key: string]: unknown` for this repo's
  `export type XProps =` aliases in synth-entry mode — every component's
  props are hand-written in `cfg.dtsPropsFor` with resolved unions. Update
  them when a component's props change.
- `cssEntry` points at the compiled Tailwind output `.next/static/css/<hash>.css`
  — the hash CHANGES on every `pnpm build`. Before a re-sync: `pnpm build`,
  then update `cssEntry` to the largest file in `.next/static/css/`.
- Known render warns (triaged legitimate):
  - `[FONT_MISSING] "Cambria" (--font-serif)` — system-font stack by design;
    PO accepted system substitutes (2026-07-04). Nothing to ship.
  - `[RENDER_THIN]`-ish tiny cards for LnStatusDot (dots are 8-12px tall).
- Grades: all 15 components / 21 cells graded `good` on the absolute rubric
  (2026-07-04 first sync).

## Re-sync risks

- `cssEntry` hash goes stale on every app build (see above) — the most likely
  silent-rot: previews would render unstyled if the file vanishes.
- `dtsPropsFor` is a hand-maintained mirror of 5 source files
  (StatusFlag/Chip/Field/RegRow/Badge + OpKpi) — prop changes there need a
  config update or the design agent gets stale contracts.
- Curated preview content references demo pets (Firulais, Michi, Rocco) —
  cosmetic only, nothing breaks if the demo data changes.
- Build assumed node 24 + pnpm-installed repo `node_modules` and the
  converter deps in `.ds-sync/` (playwright@1.60.0 pinned to the repo's
  chromium-1223 cache — keep versions aligned).
