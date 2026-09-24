# Fonts vendored locally (L-21)

Why these files exist: `next/font/google` fetches from `fonts.gstatic.com` **at
build time**, so any build/CI/Vercel deploy is a network dependency on Google.
Observed live 2026-08-10 22:04 UTC: the CI "Lint, typecheck, build" job failed
whole with `Failed to fetch 'Encode Sans' from Google Fonts`, unrelated to the
commit under test (`dim-interno:docs/plans/PENDIENTES.md` L-21). Vendoring the `.woff2`
files and loading them with `next/font/local` removes that dependency: Next
still self-hosts and serves from `/_next/static/media` at runtime, exactly as
before — only the build-time fetch is gone.

## Files

All files retrieved from the Google Fonts `css2` API (`fonts.googleapis.com`),
`latin` subset only (matches the subset `app/layout.tsx` requested before this
change — `latin` covers the Latin-1 Supplement block, U+00A0–00FF, which is
where á é í ó ú ñ ü ¿ ¡ live, so es-AR text was already covered). No
`latin-ext` was requested before and none is added now. No italic styles are
loaded — none were loaded before either; the `italic` Tailwind utility used in
a couple of places (e.g. `ComplianceObligationsPanel.tsx`) was already
browser-synthesized oblique, not a real italic face, and stays that way.

| Family | Weights | Version | Directory |
|---|---|---|---|
| Encode Sans | 400, 500, 600, 700 | v23 | `app/fonts/encode-sans/` |
| IBM Plex Serif | 500, 600, 700 | v20 | `app/fonts/ibm-plex-serif/` |
| IBM Plex Sans | 400, 500, 600, 700 | v23 | `app/fonts/ibm-plex-sans/` |
| IBM Plex Mono | 400, 500, 600, 700 | v20 | `app/fonts/ibm-plex-mono/` |
| Caveat | 500, 700 | v23 | `app/fonts/caveat/` |

Weight lists are unchanged from the previous `next/font/google` config in
`app/layout.tsx` — they are a contract with the utility classes the app
actually uses, enforced by `__tests__/font-weight-contract.test.ts`. No weight
was added or dropped in this migration.

Filename pattern: `<family>-<google-fonts-version>-<subset>-<weight>.woff2`.

## Source and retrieval

Downloaded 2026-09-18 from `https://fonts.googleapis.com/css2?family=<Family>:wght@<weights>&display=swap`,
requested with an old-Chrome `User-Agent` string so Google's API returns
per-weight **static** woff2 files instead of a single variable-font file
(browsers without variable-font support get static instances; a request from a
variable-font-capable UA collapses several weights onto the *same* file and
`@font-face` blocks that differ only by `font-weight`, which is unusable with
`next/font/local`'s per-file `weight` mapping). Each resulting `@font-face`
block's `latin`-subset `src: url(...)` was fetched directly (bypassing
`fonts.gstatic.com` at build time from now on; this fetch happened once, here,
by hand).

## License

SIL Open Font License 1.1 (OFL) for all five families — Encode Sans, IBM Plex
Serif/Sans/Mono, and Caveat are all Google-Fonts-hosted OFL fonts. OFL
explicitly permits embedding, redistribution, and modification (including
subsetting), which covers committing these files to the repo and serving them
from `/_next/static/media`. Full license text:
<https://openfontlicense.org/open-font-license-official-text/>.
