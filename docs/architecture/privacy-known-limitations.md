# Privacy — known, accepted limitations

> Snapshot: `c10f4ff03` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-02
> Verified against code on 2026-09-02 by writer D (sonnet subagent) · Status: reviewed
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.

> Register of privacy findings the PO reviewed and **deliberately accepted** instead of fixing,
> with the reasoning and the triggers that would reopen them. Companion to the k-anonymity
> architecture (`lib/metrics/anonymity.ts`, the panorama cube) and the privacy checklist in
> `AGENTS.md#privacidad-y-manejo-de-datos`. Every entry needs: what, attack, why accepted,
> revisit triggers.

## KA1 + KA2 — differencing via the raw provincial density marginal

**Accepted by PO decision, 2026-07-11.**

- **What:** `complementarySuppress` promotes exactly one sibling cell and does not widen to a
  feasible interval ≥k (`lib/metrics/anonymity.ts:107-138`), while per-province density is
  published RAW — without k-anonymization (`src/modules/panorama/infrastructure/repository.ts:940-962`).
- **Attack:** an adversary combining the raw province total with the visible (non-suppressed)
  sibling cells can recover a suppressed cell's value by subtraction — e.g. `{A:1, B:5}`: A is
  suppressed, but `total(6) − B(5) = 1` reveals it. Related: KA4 — a narrow scrubber window on
  the `mortalidad` layer can expose an individual death's date + `disposition_method` under an
  otherwise ≥k cell.
- **Why accepted:** exploiting it requires a motivated attacker deliberately cross-referencing
  two separate surfaces (the density marginal + the suppressed choropleth) on operator-gated,
  jurisdiction-scoped screens — not public pages. The affected data is aggregate pet-event
  counts, not direct human PII. The fix (interval-widening complementary suppression +
  k-anonymizing the density marginal) hides additional legitimate cells and was judged not
  worth the utility loss at this stage.
- **Reopen if any of these happen:**
  1. Any of these surfaces (density marginal, choropleth, trend buckets) becomes **public** or
     reachable by lower-trust roles.
  2. A **federal audit / Mi Argentina federation review** asks for the differencing analysis —
     this entry is the disclosure; the fix should then be implemented rather than argued.
  3. Cell semantics change from pet-event counts to anything closer to human PII (e.g. joins
     with owner attributes).
  4. The `mortalidad` scrubber gains finer-than-daily granularity (sharpens KA4).

**Where the fix is specified if reopened:** `dim-interno:docs/plans/panorama-v2-polish.md` Part B item 4 +
`dim-interno:docs/reviews/2026-07-11-cowork-panorama-adversarial-qa.md` §5 (KA1/KA2/KA4 with file anchors).

## KA5 — per-offering campaign enrollment differencing vs geo-reach k-anon

**Accepted by PO decision, 2026-07-12 (as operational data, not PII).**

- **What:** the campaign **geo-reach** surface is now k-suppressed (F1 fix — `lib/analytics/campaign-metrics.ts`
  `suppressGeoReach`, folds sub-k localities into an "Otras localidades (privacidad)" rollup). But the sibling
  **per-offering** list + CSV still disclose `jurisdictionLocality` + `enrollment` + `completionRate` at full
  precision (`app/gob/campanas/page.tsx` offerings table + `app/gob/campanas/export/route.ts`).
- **Attack:** for a locality whose only campaign is small, `attended ≈ enrollment × completitud` reconstructs
  the attendance count that geo-reach suppresses — differencing across the two campaign surfaces.
- **Why accepted:** per-offering enrollment/completion is treated as **operational data the org owns about its
  own campaigns in its own jurisdiction**, not human PII — it counts bookings/attendance, identifies no
  individual, and a funcionario sees their own jurisdiction's campaign operations by design. Suppressing it
  would hide legitimate operational data an operator needs to run their (often small) campaigns. Judged
  operational-not-PII; the geo-reach suppression (which aggregates ACROSS campaigns) stays as the k-anon
  boundary.
- **Reopen if any of these happen:**
  1. The per-offering list/CSV becomes **public** or reachable by lower-trust roles (today: admin/govt,
     jurisdiction-scoped).
  2. Offering rows gain **attendee-identifying attributes** (names, DNIs, per-person joins) — then it stops
     being aggregate operational data.
  3. A **federal audit / Mi Argentina federation review** flags the cross-surface differencing.
  4. Campaigns shrink to routinely single-digit enrollments where the offering row itself becomes
     effectively individual-level.

**Where the fix is specified if reopened:** apply the same `suppressSmallCells` + rollup used by
`suppressGeoReach` to the per-offering list and its CSV (task #68; the geo-reach fix is the template).

## PD1 — `/gob/analytics/export` is a row-level padrón, declared OUTSIDE the k-anon policy

**Accepted by PO decision, 2026-08-23 (D2). This entry is the declaration, not a note about one.**

- **What:** `/gob/analytics/export` emits ROW-LEVEL CSV/JSON — one row per pet, case, organization
  and event — and the k-anonymity policy is simply not applied to it. `anonymizeRows`
  (`lib/analytics/govt-exports.ts:87-106`) parses each row through a Zod schema, which STRIPS
  undeclared fields; it suppresses no cell, ever. An `rg` over the four files of the export path
  returns zero mentions of suppression. The four fetchers live in
  `lib/analytics/dashboards/exports.ts:37-232`; the action is
  `app/gob/analytics/export/actions.ts`.
- **Attack:** `SELECT locality, count(*) … GROUP BY 1` in Excel over the CSV reconstructs every
  cell the dashboards suppress. **Measured 2026-08-22: 2.144 of 2.186 mortality-by-locality cells
  (98 %) are under the threshold** — i.e. nearly every cell the board hides is recoverable from the
  file with one spreadsheet formula. Worse, and not mentioned by the original finding: the event
  rows carry the same key as the pet rows, so a **per-animal timeline** (registration, vaccination,
  sterilization, death) can be assembled in localities that frequently hold exactly one pet. That
  one does not fall out of any aggregate.
- **Why accepted:** an official needs the **padrón of their own territory**; suppressing cells
  breaks the purpose of the export rather than hardening it. The trust envelope is the same one
  under which KA1/KA2 were already accepted: an admin or a govt operator **bounded to their own
  jurisdiction**, no direct identifiers in the file, 24 h signed URL, audit-logged. What was
  dishonest was never that the export existed — it was that `AGENTS.md#aggregation--privacy-policy`
  claimed one thing while this CSV did another, and that the operator-facing notice said the file
  was "anonimizado". Both are corrected in the same change as this entry.
- **The two properties this acceptance RESTS on — verified against the code on 2026-08-23, not
  assumed. If either stops holding, this entry is void and reopens immediately:**
  1. **Jurisdiction scoping — HOLDS.** All four fetchers apply a scope clause
     (`petsScopeClause` / `petsCurrentJurisdictionClause` / `casesScopeClause` /
     `organizationsScopeClause`) and every one of them **fails closed**:
     `actor.role === "govt" && jurisdictions.length === 0` returns `[]` before any query is built.
     The form's JurisdictionSwitcher narrows further (`resolveJurisdictionScope`). Admin is
     universal by role — that is the definition of admin, not a leak in this surface.
  2. **Audit logging — HOLDS.** `app/gob/analytics/export/actions.ts` writes one
     `analytics_export_generated` row carrying actor, schema version, slices, format, the resolved
     period, the jurisdiction, the storage path and per-slice row + rejected counts.
     **Residual, small and named:** the row is inserted at step 8, AFTER the file is uploaded and
     the signed URL minted, so a crash in between leaves a downloadable file with no trail. Not a
     blocker for this acceptance; the file path is still user-scoped and the bucket is locked down
     (migration `0172_export_buckets_lockdown.sql`).
- **Reopen if any of these happen:**
  1. Either verified property above stops holding — a fetcher loses its scope clause or stops
     failing closed, or the audit insert is removed, made best-effort, or moved behind a branch.
  2. The export becomes reachable by a role that is **not** bounded to its own jurisdiction, or by
     a non-operator role.
  3. The row schemas gain an attribute that identifies a **person** (owner name, DNI, contact,
     precise coordinates). Today they carry none; the Zod schemas in `lib/analytics/govt-exports.ts`
     are the enforcement point and the test file `__tests__/govt-exports.test.ts` pins them.
  4. A **federal audit / Mi Argentina federation review** asks for the re-identification analysis —
     this entry is the disclosure; at that point aggregate it or gate it, do not argue it.
  5. The export is offered to anyone outside a state organism (an NGO portal, an open-data feed).
     Datos abiertos is a DIFFERENT surface and the k-anon policy governs it without exception.
- **What was explicitly NOT done, and why:** the repro recommended suppressing the locality on
  sub-threshold rows at province level. The PO chose declaration over suppression: a padrón with
  holes in it is not a padrón, and the operator would work around it by asking for the data another
  way — which is the same disclosure with no trail.

**Where the fix is specified if reopened:** the suppression variant is `lib/metrics/anonymity.ts`
→ `suppressSmallCells` applied to the fetchers' output before `anonymizeRows`, with the locality
column blanked (never the row dropped) for sub-k localities — the sibling censo / población exports
are the template. The operator notice lives in `app/gob/analytics/export/privacy-notice.ts` and is
asserted by `__tests__/govt-exports.test.ts`; change both together.
