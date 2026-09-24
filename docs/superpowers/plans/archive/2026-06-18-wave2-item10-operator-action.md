# Wave 2 — Item 10 — Operator action layer: global search (omnibox) + bulk-select

> **Spec:** `dim-interno:docs/superpowers-private/specs/archive/2026-06-18-wave2-ux-hardening-handoff.md` → Item 10
> **Branch:** `feat/wave2-item10-operator-action` (base `develop` @ `1be75c9`)
> **Constraint:** NO new tables / events / migrations. Read-only search, reuse of existing bulk server actions.

## Goal

Close the gap from "operator dashboards show aggregates" to "operator can jump to a single record and act in bulk":

- **10.1 Global search (omnibox)** — a jurisdiction-scoped, PII-logged search box in the operator topbar that finds pets, persons and cases.
- **10.2 Bulk select** — a reusable sticky bulk-action bar + a checkbox column in the operator queues, wired to the existing `bulkRevokeAction`.

## Design decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Omnibox search is **read-only** and lives in `lib/omnibox-search.ts` (pure scoped queries) + `app/actions/omnibox-search.ts` (auth gate + PII log). | Mirrors `lib/admin-search.ts` / `app/actions/decomiso-pet-lookup.ts`. Keeps the security boundary (auth + logging) in the action and the scoping in the lib. |
| D2 | **Jurisdiction scope** reuses the audited patterns: pets filtered by `pets.jurisdiction_province ∈ assignments`; persons delegated verbatim to `searchUsers()` (ownerships→pets semi-join); cases by `(province, locality)` pair. Admin = universal (empty `jurisdictions`). govt with **zero assignments → empty, no DB hit**. | Do not re-invent or weaken the P1-2 scoping already reviewed for `/gob/usuarios` and `decomiso-pet-lookup`. |
| D3 | **PII-query logging** reuses `logPiiQueryForAuthority` with a new `surface` value `"omnibox"`. `surface` is a free-form JSONB payload field, NOT a schema column — no migration. The `pii_queried` audit action already exists. | Satisfies "log like `/gob/usuarios`" without any data-model change. |
| D4 | `OpBulkBar { count, actions[] }` is a **generic presentation primitive**: it owns no selection state and calls no server action. Each action supplies `onRun(reason)`. Destructive actions declare `requireReason` + `minReasonLength` and open the shared `ConfirmDialog`. | The spec asks for one reusable bar; the existing `BulkRevokeList` / `BulkApprovalQueueList` were bespoke. |
| D5 | The **reason minimum matches the real server action**, not a hardcoded 5: `bulkRejectRequestsAction` ≥ 5, `bulkRevokeAction` ≥ 30 (+ evidence). The revoke wiring keeps the existing evidence-upload modal (a reason-only confirm cannot collect attachments); `OpBulkBar` opens that modal via `onRun`. | Spec says "matching the server actions"; the actual `bulkRevokeAction` contract is ≥30 chars + ≥1 attachment. |
| D6 | The **selection state machine** is extracted into pure helpers in `lib/bulk-select.ts` (`toggleSelection`, `toggleSelectPage`, `isPageFullySelected`, `isReasonValid`, `selectionSummary`) so the logic is unit-testable without a DOM. | Repo has no jsdom/RTL; pure helpers + SSR structural tests are the established pattern. |
| D7 | Header checkbox = **select page** only. "Select all N in query" for revoke is intentionally NOT a blind query-wide action: every revoke needs shared evidence + ≥30-char motivo, so a query-wide revoke would be unsafe. | Safety over convenience for an irreversible, notifying action. |

## Components / files

### New
- `lib/omnibox-search.ts` — `searchOmnibox(query, scope)`; scoped pet/person/case lookups, `OmniboxResults` shape.
- `app/actions/omnibox-search.ts` — `searchOmniboxAction(query)`; auth gate + PII log + delegates to the lib.
- `lib/bulk-select.ts` — pure selection-state helpers.
- `components/ui/dashboard/OpOmnibox.tsx` — combobox input + grouped dropdown, keyboard nav, `/` + ⌘K shortcut, 250ms debounce, 4 states.
- `components/ui/dashboard/OpBulkBar.tsx` — generic sticky bulk-action bar.

### Modified
- `app/actions/admin-proposals.ts` — widen `logPiiQueryForAuthority` `surface` to include `"omnibox"`.
- `components/ui/ConfirmDialog.tsx` — add optional `children` slot (for the reason textarea).
- `components/ui/dashboard/index.ts` — export `OpOmnibox`, `OpBulkBar`, `OpBulkAction`.
- `app/gob/layout.tsx`, `app/admin/layout.tsx` — mount `<OpOmnibox />` in the topbar `actions` slot.
- `components/BulkRevokeList.tsx` — add a header "select page" checkbox; replace the bespoke sticky bar with `OpBulkBar`; use the shared selection helpers. (`/gob/usuarios`, `/admin/usuarios`, `/gob/organizaciones`, `/admin/organizaciones` consume this.)

## States

### Omnibox
| State | Behaviour |
|-------|-----------|
| empty | placeholder "Buscar mascota, persona o caso…" + `/` shortcut hint, no dropdown |
| typing | 250ms debounce; inline spinner ("Buscando…") while the request is in flight |
| no results | "Sin coincidencias en tu jurisdicción" |
| results | grouped by Mascotas / Personas / Casos; `role=option` rows |

### Bulk bar
| State | Behaviour |
|-------|-----------|
| none selected | bar hidden (`count === 0`) |
| ≥1 selected | "N seleccionados" + actions + "Limpiar" |
| header checkbox | selects/clears the revocable rows on the page |
| destructive | `ConfirmDialog` with a mandatory reason (≥ min); revoke keeps evidence modal |

## A11y
- Omnibox: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant`; dropdown `role="listbox"` + `role="option"`. ↑/↓/Enter/Escape.
- Bulk bar: `role="region" aria-label="Acciones en lote"`; count `aria-live="polite"`; header checkbox has `aria-label`.

## Tests
- `__tests__/bulk-select.test.ts` — selection state machine + reason gate (default 5, revoke 30).
- `__tests__/omnibox-search.test.ts` — **integration vs local Postgres**: pet/case jurisdiction scoping (govt CABA vs Mendoza, admin universal, govt-zero-assignment empty), token + chip + name match, and `searchOmniboxAction` writes exactly one `pii_queried` row with `surface=omnibox` and the real result count.
- `__tests__/op-omnibox.test.tsx` — SSR structural: empty / no-results / loading / grouped-results states + a11y roles.
- `__tests__/op-bulk-bar.test.tsx` — SSR structural: hidden at 0, `role=region`/`aria-live`, singular/plural, action + clear buttons.

## Gate
`biome format --write` → `pnpm typecheck && pnpm lint && pnpm test && pnpm build`, all FOREGROUND. Integration tests run against local Postgres (`supabase start`).

## Out of scope / not done
- No data changes (no tables/events/migrations).
- Maltrato/cola welfare-report bulk operations beyond the existing approve/reject/revoke (no welfare bulk server action exists; not in this slice).
- "Select all N in query" blind revoke (D7).
