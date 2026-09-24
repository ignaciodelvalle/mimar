# Unified App Shell — executable plan (Item 7)

> **Spec (contract):** `docs/superpowers/specs/2026-06-18-unified-app-shell-design.md` (D1–D13, all closed)
> **Depends on:** Item 1 (operator nav data) — already merged to `develop` (PR2 `1be75c9`).
> **Strategy:** strangler in 4 PRs (A→D). Build the shell, migrate surfaces one tier
> at a time, delete the three legacy chromes last. No data/route/capability changes.

This plan replaces the **three chrome systems** (`LnOwnerNav` owner masthead +
`AppHeader` public header + `OpShell` operator rail) with one role-variant
`AppShell`. The single highest-value behavior it ships is the **stranded-user
fix** (D3/D4): a logged-in owner who lands on a public surface keeps their role
nav and a 1-click return, instead of being dumped onto `PUBLIC_NAV` with only a
truncated name chip as the way back.

## Nav-source reality on `develop` (post Item 1)

Item 1 already merged the grouped operator nav. `components/layout/nav-presets.ts`
on `develop` therefore exposes:

- `OWNER_NAV` / `PUBLIC_NAV` — flat `NavItem[]` (already present; **not** added by
  this item). `OWNER_NAV` already includes "Denuncias" — the reconciliation D2
  called for is effectively done.
- `GOB_NAV_SECTIONS` / `ADMIN_NAV_SECTIONS` — grouped `NavSection[]` (the rail
  render source). `GOB_NAV` / `ADMIN_NAV` remain as flat `NavItem[]` aliases
  derived from the sections, for callers (and `shell-nav`) that want a flat list.
- `buildOrgNav(orgToken, opts) → NavSection[]`; `buildOrgNavFlat(...) → NavItem[]`.

`lib/shell-nav.ts` consumes the **flat** exports (`OWNER_NAV` / `PUBLIC_NAV` /
`GOB_NAV` / `ADMIN_NAV`, and a caller-supplied flat org nav). The sectioned
`NavSection[]` are wired into the operator rail render in Phase B.

## Quick path (what lands, in order)

| PR | Phase | Delivers | Touches the 3 old chromes? | Rollback boundary |
|----|-------|----------|----------------------------|-------------------|
| 1 | **A** | `AppShell` (3 variants) + `lib/shell-nav.ts` + tests; adopt `landing` on the `/r/invite` surface only | No (coexist) | Revert PR; nothing else depends on it yet |
| 2 | **B** | Migrate operators (gob / admin / org) `OpShell` → `AppShell variant=operator` | Stops *using* `OpShell` (not deleted) | Revert PR; layouts fall back to `OpShell` |
| 3 | **C** | Migrate owner `(app)` + public `(public)` → `variant=citizen`; fix stranded-user; migrate `/p` + `/libreta/compartir` → `landing` | Stops *using* `LnOwnerNav` + `AppHeader` | Revert PR; layouts fall back to legacy chromes |
| 4 | **D** | Delete `LnOwnerNav`, `LnOwnerSubBar`, `AppHeader`, `OpShell`/`OpRail`/`OpRailNav`/`OpTopbar`/`OpMobileDrawer`, `NAV_ITEMS`, `DEFAULT_NAV`; docs; flip README row | Deletes them | Revert PR; restores the files |

Each phase is one PR to `develop`. Each ships its own tests and docs. The repo is
fully working after any single phase — that is the strangler invariant.

---

## Architecture decisions folded in

| ID | Decision | Where it lands |
|----|----------|----------------|
| D1 | One `AppShell`, `variant: citizen \| operator \| landing` | A (component) |
| D2 | Single nav source in `nav-presets.ts`; delete `NAV_ITEMS` / `DEFAULT_NAV` | already `PUBLIC_NAV`/`OWNER_NAV` on develop; D deletes legacy literals |
| D3 | Nav chosen by **auth state**, not route-group | A (`resolveShellNav`); C wires it |
| D4 | Guaranteed role-return on every public surface | A (`showReturn`/`returnHref`); C wires it |
| D5 | "Inicio" disambiguated: brand→`/`, role item→role home | A (`roleHome` in resolver); C wires it in the masthead |
| D6 | Single context switcher, entitlement-filtered | A (`buildSwitcher`, exported); B/C add `ContextSwitcher` and wire |
| D7 | Visual identity per variant (stripe in citizen, navy in operator) | A (component); B/C |
| D8 | One mobile drawer parametrized by variant | A defines slot; B/C consolidate the 3 drawers |
| D9 | Minimal footer in citizen, none in operator | A (component) |
| D11 | a11y preserved (`#main-content`, focus-trap, `aria-current`, contrast) | every phase; A keeps `#main-content` in all 3 variants |
| D12 | Item 7 consumes Item 1's operator nav as render layer | B |
| D13 | Third `landing` variant for token-landing surfaces | A (variant + resolver rule + `/r/invite` adoption); C migrates `/p` + `/libreta/compartir` |

---

## Phase A — foundation (THIS PR)

**Goal:** land the shell, the pure auth-aware decision, and a single isolated
adoption that proves they render end-to-end — without disturbing the three
legacy chromes.

### Files

| File | Change |
|------|--------|
| `lib/shell-nav.ts` | **new** — pure `resolveShellNav(input)` → `{ variant, nav, showReturn, returnHref, switcher }`; `isTokenLandingPath`; exported `buildSwitcher`. The auth-aware core (D3/D4/D6/D13). No React, no DB. Consumes the flat nav exports from `nav-presets`. |
| `lib/shell-nav.test.ts` | **new** — test-first unit coverage of every decision branch (~28 cases). |
| `components/layout/AppShell.tsx` | **new** — presentational compositor, 3 variants (`citizen` / `operator` / `landing`). Exhaustive discriminated union; each variant keeps `#main-content` (D11). Reuses `GobStripe` + `AppFooter`. |
| `components/layout/index.ts` | export `AppShell` from the barrel (additive). |
| `app/r/invite/[token]/layout.tsx` | **new** — wraps the invite token surface in `AppShell variant=landing`; computes the variant via `resolveShellNav`; renders a discreet "← Volver a mi app" return for logged-in viewers (D13). |
| `app/r/invite/[token]/page.tsx` | drop the page-owned `<main className="min-h-screen">` (4 states → `<div>`); the landing shell now owns `#main-content` + min-height. Content unchanged. |
| `AGENTS.md` | append the AppShell convention under "Design rules (UI conventions)" + a Feature-inventory note (🔵 in migration). |
| `docs/superpowers/plans/2026-06-18-unified-app-shell.md` | this plan. |

> **Note:** `PUBLIC_NAV` already exists on `develop` (it predates this item).
> Phase A **consumes** it rather than seeding it — there is no `nav-presets.ts`
> change in this PR.

### Why `/r/invite` for the adoption

All three token-landing surfaces (`/p`, `/libreta/compartir`, `/r/invite`) today
render their own full-screen `<main id="main-content" class="min-h-screen">` and
have NO shell layout. `/r/invite` is the smallest blast radius (a single token
page) and the page's own `<main>` is purely structural, so it is the one surface
we can adopt onto `landing` in Phase A without a content refactor. `/p` and
`/libreta/compartir` carry data-fetch + rate-limit complexity and nest their own
`<main>` inside richer markup, so they migrate in Phase C alongside the citizen
work.

### Rollback boundary

Revert PR 1. Nothing else imports `AppShell` / `shell-nav` yet; the only behavior
change is that `/r/invite` gains the minimal trust chrome (and loses its bespoke
full-screen `<main>`). The three legacy chromes are untouched.

### Tests (Phase A, pure)

`lib/shell-nav.test.ts` — see "Test plan" below. All pure, no Postgres.

---

## Phase B — migrate operators (1 PR)

**Goal:** repoint gob / admin / org layouts from `OpShell` to `AppShell
variant=operator`, consuming Item 1's `NavSection[]` rail. Paridad 1:1 (lowest
risk — same rail, same items, same topbar). Replace the ad-hoc `/admin` ↔ `/gob`
↔ `← Salir` linkcitos with the `ContextSwitcher` (D6).

### Files

| File | Change |
|------|--------|
| `components/layout/ContextSwitcher.tsx` | **new** — client switcher; renders `resolveShellNav(...).switcher` (built by the exported `buildSwitcher`); sits in the topbar `actions` slot. |
| `components/layout/AppShellDrawer.tsx` | **new** — the operator mobile drawer, variant-parametrized (consolidates `OpMobileDrawer`). |
| `app/gob/layout.tsx` | render `<AppShell variant=operator rail=… topbar=…>`; rail consumes `GOB_NAV_SECTIONS`; switcher replaces the `Ir a Admin →` / `← Salir` links. |
| `app/admin/layout.tsx` | same, `ADMIN_NAV_SECTIONS` + outbox/breach badge preserved. |
| `app/org/[orgToken]/layout.tsx` | same, `buildOrgNav(orgToken, {granted})` + org breadcrumbs preserved. |
| `lib/shell-nav.ts` | thread real `orgMemberships` / `govtAssignments` for the switcher (read in layouts, passed in). |

### Tests

- Operator-parity snapshot: gob/admin/org render the same nav items as with `OpShell` (no href dropped) — extend the existing `nav-presets.test.ts` invariants if needed.
- `ContextSwitcher`: lists only entitled destinations; single-context → not rendered (D6).

### Rollback boundary

Revert PR 2 → the operator layouts fall back to `OpShell`. `AppShell` (from A)
stays; citizen/public unaffected.

---

## Phase C — migrate citizen (owner + public) + fix the stranded user (1–2 PRs)

**Goal:** the payoff. Migrate owner `(app)` and public `(public)` to
`variant=citizen`, fix the stranded-user (D3/D4), disambiguate "Inicio" (D5), and
migrate `/p` + `/libreta/compartir` onto `landing` (D13).

### Files

| File | Change |
|------|--------|
| `components/layout/AppCitizenMasthead.tsx` | **new** — the citizen masthead (brand→`/`, role-or-public nav, switcher, bell, user). Ports the `LnOwnerNav` masthead layout. |
| `app/(app)/layout.tsx` | call `resolveShellNav` with the owner session; render `<AppShell variant=citizen masthead=…>`; drop `LnOwnerNav` + `LnOwnerSubBar`. |
| `app/(public)/layout.tsx` | call `resolveShellNav`; **anon → PUBLIC_NAV; logged-in → role nav** (the fix). Render `<AppShell variant=citizen>`; drop `AppHeader`. |
| `app/p/[publicToken]/layout.tsx` | **new** — `AppShell variant=landing`; the `/p` page drops its own nested `<main>`. |
| `app/libreta/compartir/[shareToken]/layout.tsx` | **new** — `AppShell variant=landing`; page drops its own nested `<main>`. |

> ⚠️ Split into 1–2 PRs if the changed-line count approaches ~400. Natural seam:
> PR C1 = owner `(app)`; PR C2 = public `(public)` + `/p` +
> `/libreta/compartir` landing migration.

### Tests

- **Stranded invariant** (integration/e2e): owner on `/adoptar`, `/refugios`, `/denuncias` always sees the role "Inicio" + a ≤1-click return. Direct regression of the reported bug.
- `/p`, `/libreta/compartir/*` resolve to `landing` with no `PUBLIC_NAV` (already asserted in `shell-nav.test.ts`; add a render-level check).
- a11y (`axe`): masthead + drawer, focus-trap, `#main-content` present in both variants (Track E).

### Rollback boundary

Revert the relevant PR → owner/public fall back to `LnOwnerNav` / `AppHeader`.

---

## Phase D — delete the old chromes (1 PR)

**Goal:** remove the strangled code once every surface is migrated. **This is the
phase that closes Item 7** (flip the README row to ✅ here, not before).

### Files (delete)

`components/ui/LnOwnerNav.tsx`, `components/ui/LnOwnerSubBar.tsx`,
`components/layout/AppHeader.tsx` (+ `DEFAULT_NAV`), `components/ui/dashboard/OpShell.tsx`,
`OpRail.tsx`, `OpRailNav.tsx`, `OpTopbar.tsx`, `OpMobileDrawer.tsx`, the
`NAV_ITEMS` literal — and prune the barrel exports.

### Also

- `AGENTS.md` "Portal surfaces" note: all portals share `AppShell` (variant per role).
- Item 1 spec note: its render layer (`OpRailNav sections=`) is absorbed by `AppShell variant=operator`; Item 1 remains the **data** source.
- `docs/superpowers/README.md`: flip the Item 7 row to ✅ + SHA (only here — after Phase D).

### Rollback boundary

Revert PR 4 → restores the deleted files. By this point nothing imports them, so
the revert is purely additive.

---

## Test plan (test-first, per the umbrella's strict-TDD mandate)

Phase A (pure, no Postgres — `lib/shell-nav.test.ts`):

- [x] anon + `/adoptar` → `citizen` + `PUBLIC_NAV`, no return.
- [x] anon + token-landing (`/p/...`) → `landing`, empty nav, no return (D13).
- [x] owner + `/inicio` → `citizen` + `OWNER_NAV`, no return (home).
- [x] owner + `/adoptar` (public) → **still** `citizen` + `OWNER_NAV` (not stranded; not `PUBLIC_NAV`).
- [x] owner + `/denuncias` → `showReturn=true`, `returnHref=/inicio` (D4).
- [x] owner + token-landing → `landing` with a discreet return to `/inicio` (D13 auth-independent).
- [x] govt + `/gob/vigilancia` → `operator` + `GOB_NAV`; admin + `/admin/cola` → `operator` + `ADMIN_NAV`.
- [x] operator + public surface → stays `operator` with a return to `/mis-mascotas`.
- [x] org member + `/org/.../mascotas` → `operator` + the built (flat) org nav.
- [x] switcher: owner→empty; admin+assignments→offers gob, never re-lists admin; operator always offers "volver a ciudadano"; never exposes gob/admin to an owner.
- [x] `isTokenLandingPath`: matches `/p/*`, `/libreta/compartir/*`, `/r/invite/*`; does NOT match `/libreta`, `/adoptar`, `/`.

Phases B–D add: operator-parity snapshots, `ContextSwitcher` entitlements,
stranded-invariant integration test, `axe` a11y, and a grep/import test that
`NAV_ITEMS` / `DEFAULT_NAV` no longer exist (D2).

---

## What this plan does NOT do

- No visual redesign of tokens/palette (citizen stays warm/blue, operator navy).
- No route, data, or capability changes — it is chrome only.
- No change to screen *content* (pet profile = Item 6, dashboards = Items 2–4).
- No bottom tab bar — mobile drawers stay lateral.

## Next step

Phase A ships in this PR. After it merges, run Phase B (operators, 1:1, lowest
risk), then Phase C (the citizen payoff + stranded-user fix), then Phase D
(delete + README flip — only Phase D closes Item 7).
