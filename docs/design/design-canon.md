# The Design Canon — data-screen invariants (C1–C10)

> Ten invariants every DIM/MiMAR **data screen** must pass: gob analytics, admin
> dashboards, org panels — any surface that shows a number, a table, a map, a
> chart, or a queue to a funcionario/operator. Distilled from four panorama QA
> rounds; each one is a bug we actually shipped and had to walk back. Use this as
> the checklist for new screens and as the rubric for reviews.
>
> Companion audit of the current screens: `dim-interno:docs/reviews/2026-07-12-design-canon-audit.md`.
> Provenance of each invariant: `dim-interno:docs/plans/panorama-campaign-2026-07-12.md` §"The design canon".

## How to use this

- **Building a data screen?** Walk C1→C10 before you open the PR. Each has a
  one-line "check" you can run against your own diff.
- **Reviewing one?** Every number, column, empty state, and tap target on the
  screen must survive its relevant Cx. A single C2/C3 miss on a government-facing
  surface is a blocker, not a nit.
- **Two tiers of fix.** Most violations are **bounded** — a label, a wording
  change, a disabled state, a default view — fixable in the screen itself.
  A few are **structural** (C8 derive-don't-store, C9 one-shared-primitive): don't
  patch them inline, route them to the shared-primitive work
  (`dim-interno:docs/plans/jurisdiction-scope-primitive.md`, viz-suite #33).

---

## C1 — Every number, column, and list names its metric and unit

**Statement.** No bare number reaches the screen. A value carries its label, its
unit, and — for a percentage — what it is a percentage *of*. A table column has a
header that says what the cells mean. A KPI carries a definition (ideally the
formula) an operator can read.

**Failure mode.** The reader invents the meaning. Panorama shipped a bare `−49`
(it was "points below the 70% sterilization target", but nothing on screen said
so) and a "Valor 204%" with no denominator — a funcionario cannot act on a number
whose meaning they have to guess, and will guess wrong.

**How to check.** Point at any number on the screen and ask "unit? of what?". If
the answer isn't visible next to it (label, `sub`, column header, or an `info`
tooltip), it fails. `12345` with no `.toLocaleString("es-AR")` and no unit is a C1
smell even when technically labeled.

---

## C2 — Coherence: label = number = map = table, always

**Statement.** Every surface on a screen that describes the same thing agrees.
The KPI total equals the sum of the rows that explain it. The map, the table, and
the caption tell one story. An aggregate never contradicts the detail beneath it.

**Failure mode.** The screen contradicts itself and loses all authority. Panorama
showed a card reading "64,4%" above a map reading "sin datos" for the same layer,
and a "Registros: 0" header above five populated rows. On a government dashboard,
one visible contradiction means the operator trusts *none* of the numbers.

**How to check.** For each aggregate, find the detail it summarizes and confirm
they're computed from the **same source** with the **same filters** (scope,
period, status, role). Two independently-written queries for "the same" metric is
the classic C2 trap — they drift. A delta chip must describe the *same* quantity
as the value it sits on (a `+100%` volume delta next to a flat `72%` rate is a C2
break).

---

## C3 — Suppressed ≠ "sin datos"

**Statement.** When an aggregate exists but the per-unit detail is withheld for
k-anonymity (k<5), the UI says so — "protegido / suprimido por privacidad
(k-anonimato)" — and never renders it as "sin datos", "vacío", or a silent hole.
Suppressed rows are still counted in totals (or the total's caveat discloses the
exclusion), so numbers reconcile.

**Failure mode.** Two different lies. (1) An operator reads "sin datos" and
concludes there is no problem in their locality, when really there *is* data —
it's just protected. (2) A KPI silently sums only the un-suppressed rows, so the
"national total" is an undercount with no warning, and it disagrees with the table
below that *does* disclose the suppression. This is the single highest-yield bug
class on k-anon surfaces — the panorama 64,4%/"sin datos" split was exactly this.

**How to check.** On any surface aggregated with `suppressSmallCells` (k=5): does
the empty/hole state distinguish *true zero* from *suppressed*? Does every
group-by-locality query that ships counts to the UI route through the suppression
primitive? Does the headline total disclose what suppression removed? If a peer
screen suppresses the same query shape and this one doesn't, it's a leak.

---

## C4 — Clickable things look — and behave — clickable

**Statement.** An interactive control looks like what it does and commits to one
mental model. A one-of-a-set selector reads as a radio group; a multi-toggle reads
as checkboxes. A read-only tile is visibly not a button. Hover is not the only
cue that something is tappable.

**Failure mode.** The operator can't tell what they can touch or what tapping
does. Panorama's KPI cards looked like passive readouts but acted as
radio-exclusive layer switchers, and read-only cards were pixel-identical to
clickable ones — so the map changed when nobody expected it to.

**How to check.** For every clickable element: is there a rest-state affordance
(cursor, control glyph, border) visible *without* hover? Does the a11y role match
the behavior (`role="radio"` for radio-exclusive, not bare `aria-pressed`)? Can a
read-only tile be told apart from an actionable one at a glance?

---

## C5 — Disable + explain; never error-on-tap

**Statement.** An action or filter that isn't valid in the current context is
**disabled with a visible reason**, not left live to fail. Tapping never produces
an error, a dead-end, or a 404. A count badge that would lead to a screen with no
matching rows is itself a C5/C2 smell.

**Failure mode.** The operator taps, gets an error or an empty screen, and learns
nothing about why or what to do instead. Panorama's province-only coverage chip
errored on tap in national scope instead of disabling with "requires a province".

**How to check.** For every button, chip, filter, and queue action: what happens
when it's not applicable? If the answer is "error" or "empty dead-end" rather than
"disabled + tooltip explaining why / what to select first", it fails. Especially
scrutinize queue actions on empty or ineligible items.

---

## C6 — Progressive disclosure: the collapsed state is useful alone

**Statement.** The default/collapsed state answers the primary question by itself.
Expanding (a tooltip, a "ver detalle", a legend) adds *more*, never *the point*.
Nothing essential is hidden behind a disclosure.

**Failure mode.** The reader must expand something to understand what they're
looking at — so the screen fails for everyone who doesn't. Panorama hid the scale
legend and the metric's meaning behind a Simple/Detalle toggle the operator didn't
know to flip.

**How to check.** Collapse everything collapsible. Can an operator still read the
screen correctly? If a legend, unit, or the definition of the active metric only
appears on expand, promote it.

---

## C7 — One uniform update model — no jarring full reloads

**Statement.** All the controls on a screen commit changes the same way. If ten
filters update the view shallowly (URL + client refetch), the eleventh doesn't do
a full-document reload. State changes feel like one system.

**Failure mode.** One control blinks the whole page white while the others don't —
the operator perceives it as breakage, loses scroll position and in-flight
context. Panorama's custom-período picker full-reloaded while every other control
refetched shallowly.

**How to check.** List every control that mutates the view. Do any use
`window.location.assign` / full navigation while their siblings use shallow
commit + refetch? (Note the documented Next 15.5.x router-drop exception exists —
but it should be the *consistent* mechanism on a screen, not one odd control out.)

---

## C8 — Don't store what you can derive *(structural)*

**Statement.** A value that can be computed from source-of-truth state is
derived at read time, not stored in a second place. Two surfaces reading one
canonical value cannot disagree; two surfaces each storing "their copy" will.

**Failure mode.** The copies drift and you get a C2 contradiction that no amount
of UI polish can fix, because it's a state-architecture bug. Panorama stored a
derived preset and let the URL `layers` param rewrite itself, so links didn't
reproduce the view.

**How to check.** For each piece of view state: is it stored, or derived from
scope/period/filters? If two components each hold their own copy of "the same"
value, that's the defect. **Do not fix inline** — route to the jurisdiction-scope
primitive / ViewState work.

---

## C9 — One job = one shared primitive *(structural)*

**Statement.** One job is done by one component, everywhere, with one look. Tables
that tabulate per-unit data share a table primitive. Empty states share one
`LnEmptyState`. Suppression wording, sort behavior, and CSV export have one
implementation each. "Better dashboards" means *parameterizing* a primitive, never
hand-writing another bespoke one.

**Failure mode.** N bespoke components doing ~the same job drift apart: three
column vocabularies, two suppression idioms, four empty-state implementations —
each an independent surface where C1/C2/C3 can regress separately. Panorama had
three hand-wired tables and two switchers for one underlying view.

**How to check.** Does this screen render a table / empty state / switcher / KPI
by reaching for the shared primitive, or by inlining its own `<table>` /
`<p>vacío</p>`? An admin screen that's meant to be a superset of its gob sibling
but silently drops or reimplements a panel is a C9 break. **Route duplication to
the shared-primitive work** — don't just copy the good one.

---

## C10 — The initial/empty state must not read as "vacío" when data exists

**Statement.** A screen's default view lands where the data is. It never opens on
a zero/empty tab, filter, or panel while real data sits one filter away. An honest
empty state says *why* it's empty and where the data might be.

**Failure mode.** The operator opens the screen, sees "0 / sin resultados", and
leaves believing there's nothing — when the very next tab is full. Panorama opened
on "Registros 0" while the map and Estadísticas were populated.

**How to check.** Load the screen with a fresh/default filter set. Does it show
the most-populated meaningful view, or an incidental empty one? When a panel *is*
empty, does its copy distinguish "genuinely zero" from "no data loaded" from
"filtered out" from "suppressed" (see C3)?

---

## Quick reference

| # | Invariant | One-line check | Fix tier |
|---|---|---|---|
| C1 | Numbers/columns name metric + unit | Point at a number — unit? of what? | bounded |
| C2 | Label = number = map = table | Same source + same filters for aggregate and detail? | bounded |
| C3 | Suppressed ≠ "sin datos" | k<5 said as "privacidad", not "vacío"; totals reconcile? | bounded |
| C4 | Clickable looks/behaves clickable | Rest-state affordance? role matches behavior? | bounded |
| C5 | Disable + explain, never error-on-tap | Inapplicable action disabled with a reason? | bounded |
| C6 | Collapsed state useful alone | Collapse all — still legible? | bounded |
| C7 | One uniform update model | Any control full-reloads while siblings refetch? | bounded |
| C8 | Don't store what you can derive | Two copies of one value that can drift? | **structural** |
| C9 | One job = one shared primitive | Bespoke table/empty-state instead of the shared one? | **structural** |
| C10 | Initial/empty ≠ "vacío" when data exists | Default view lands where the data is? | bounded |
