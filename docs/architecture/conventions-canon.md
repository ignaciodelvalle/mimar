# Conventions canon

> Snapshot: `d7dbf25f7` (`main`) · Facts: `docs/architecture/facts.json` generated 2026-09-26
> Verified against code on 2026-09-26 by canon v4 + blind calibration · Status: reviewed
> Numbers in this file are `<!-- fact:key -->` markers checked by `__tests__/architecture-facts.test.ts`.

Every convention this repository states about itself, with the answer to the only
question that matters about a convention: **what fails when you break it?**

## How this canon was built
The rows were harvested from the prose the project already writes about itself:
`AGENTS.md`, `CLAUDE.md`, the fence headers under `scripts/`, the `docs/agents/`
briefs, `docs/architecture/`, `e2e/README.md`, `CONTRIBUTING.md`, and the comment
blocks at the top of the tests. Anything stated as a rule became a candidate row.
Four stages turned candidates into verdicts:

1. **Extraction** — every rule-shaped sentence became a row with its source quote,
   its scope, and whatever enforcer the text itself pointed at. Near-duplicates were
   merged only when one row's requirement was fully contained in another's.

2. **Refutation** — each row's cited enforcer was OPENED and read. The question is
   never "does a fence with a matching name exist" but "can this predicate FAIL on a
   violation of this rule, over this rule's own files". Rows whose enforcer turned out
   to be a configuration line, a vacuous assertion, or a corpus that excludes the
   rule's own subject were demoted here.

3. **Judgment** — a blind reader re-derived a stratified sample of rows from the
   enforcer alone, without seeing the previous verdict. Bands whose residual error
   exceeded 1 in 6 were sent back whole.

4. **Band re-refutation** — the ENFORCED and PARTIAL bands were re-derived row by row
   under the rulebook below, drafting a verdict before reading the previous basis and
   reconciling only against evidence actually opened.

**Calibration.** A final blind pass re-derived 18 sampled rows
(6 per status band) and disagreed on
1 of 18.
The single dissent is `CANON-479`: this canon says **UNENFORCED**, the blind reader said **PARTIAL (adoption-unfenced)**. v4's verdict kept; the dissent is recorded on the row and produced the adoption convention above.

**The JSON is the source of truth.** `docs/architecture/conventions-canon.json`
carries every field; this file and its per-scope pages are a rendered view produced
by `pnpm canon:render` (`scripts/conventions-canon-render.ts`) and pinned to the JSON
by `__tests__/conventions-canon-parity.test.ts` — one table row per JSON row, same
status, same enforcer set. Hand-editing the markdown turns that fence red. Fix the
JSON and re-render instead.

**What a verdict is not.** `ENFORCED` means something in the tree fails when the rule
is broken. It does not mean the rule is a good rule, that its wording is current, or
that the enforcer covers the rule's intent beyond its literal predicate. `UNENFORCED`
means nothing fails — the rule may still be true today and may still be worth keeping.

## Status rulebook

How a row earned its verdict, in the order the rules apply:

- **R1** — Open the enforcer. It counts only if its predicate checks THIS rule's subject and predicate over THIS rule's scope; the deciding line is named in the basis.
- **R2** — Configuration is not an enforcer. A workflow trigger list, a timeout, a vercel.json/tsconfig/eas.json setting, a package.json script string — the declaration IS the mechanism and nothing fails when it is edited, so the rule is UNENFORCED. Exceptions: a CI step whose own command exits non-zero on the condition, a biome rule at level error, and a TypeScript type that makes the violation uncompilable.
- **R3** — Vacuity. An enforcer that cannot fail is no enforcer: an empty allow-list, a floor where the rule states an exact value, an anchor on text the code no longer contains, a glob matching zero files, a corpus filter that excludes the rule's own subject files, or a value assertion where the rule needs an absence or a closed set.
- **R4** — Scope subset. The enforcer covers a named PART of the rule's scope (one config of two, web but not mobile) — PARTIAL with shape "subset", and the basis names the uncovered part by path.
- **R5** — Declared limit. The fence's own header says what it does not cover and that gap is inside the rule's scope — capped at PARTIAL with shape "declared-limit", citing the header line.
- **R6** — Ratchet vs absolute. If the rule TEXT says "no new" or "must not grow", a baseline ratchet ENFORCES it. If the rule is absolute and the baseline count is 0, the ratchet is at its strictest state and the rule holds — ENFORCED. If the rule is absolute and the baseline count is above 0, PARTIAL with shape "ratchet", naming the baseline file and its live count.
- **R7** — Adoption. A helper pinned by a real test whose callers are not forced through it: if the rule's predicate is the helper's BEHAVIOUR, PARTIAL with shape "adoption-unfenced"; if the rule's predicate IS adoption ("every route must use Y"), the helper's own test proves nothing about callers — UNENFORCED, unless a fence mandates the single door, which makes it ENFORCED (structural).
- **R8** — Wiring. `wired` names the command that actually reads the enforcer: `verify` (its lint:* key is in the verify string, or it is a biome error rule or a TS type), `test:verified` (vitest discovers the file, or a mobile jest file run inside verify), `db` (a live constraint, trigger or policy), `ci` (a workflow-only step), `manual` (reachable only through a key outside verify — PARTIAL with shape "manual-wiring"), or `none`.
- **R9** — Status. ENFORCED = a non-vacuous enforcer matching subject, predicate and scope, wired into verify, test:verified, db or ci. PARTIAL = R4, R5, R6 (ratchet above 0), R7 (behaviour) or R8 (manual wiring), always with a partialShape. UNENFORCED = nothing non-vacuous can fail. The basis states evidence; the verdict lives in `status`, never in the last sentence of the prose.
- **R10** — Numbers. When a rule carries a number, the enforcer's LIVE value wins over the doc; a differing doc figure is recorded in notes as `docSays`. A header census of past incidents is a note, never the number.
- **R11** — Database rows. A CHECK, trigger, policy, FK or NOT NULL declared in db/schema.ts or a migration is an enforcer (`wired: db`) on the declaration, with a note that it was not verified against the live catalog; a later migration that DROPs the object retires it.
- **R12** — A fence's NAME is not its subject. An enforcer whose name merely resembles the rule proves nothing — the deciding line must check the rule's own predicate.

Adoption convention (from the blind calibration on CANON-479): a tested helper whose adoption is not fenced counts as PARTIAL only when at least one production path is FORCED through it. Otherwise it is UNENFORCED — a helper nobody must call is not an enforcer of a rule about callers.

## Totals

<!-- fact:canon_rows -->527<!-- /fact --> rules, of which <!-- fact:canon_enforced -->185<!-- /fact --> are ENFORCED, <!-- fact:canon_partial -->94<!-- /fact --> PARTIAL and <!-- fact:canon_unenforced -->248<!-- /fact --> UNENFORCED.

| Scope | Rules | ENFORCED | PARTIAL | UNENFORCED | Page |
| --- | --- | --- | --- | --- | --- |
| Contract (`packages/contract`) | 22 | 7 | 5 | 10 | [`contract.md`](./conventions-canon/contract.md) |
| Database, RLS and the event spine | 102 | 51 | 21 | 30 | [`db.md`](./conventions-canon/db.md) |
| Documentation | 12 | 0 | 3 | 9 | [`docs.md`](./conventions-canon/docs.md) |
| End-to-end (Playwright) | 29 | 2 | 2 | 25 | [`e2e.md`](./conventions-canon/e2e.md) |
| Mobile (`apps/mobile`) | 39 | 15 | 4 | 20 | [`mobile.md`](./conventions-canon/mobile.md) |
| Process, CI and the gate chain | 153 | 20 | 20 | 113 | [`process.md`](./conventions-canon/process.md) |
| Web application | 170 | 90 | 39 | 41 | [`web.md`](./conventions-canon/web.md) |

## Recommendations

Rows that are a review's open proposal rather than a rule the tree follows.

### CANON-118

- **Proposal:** A floor pinned with `toBeGreaterThanOrEqual` (e.g. `MIN_V1_ROUTE_FILES`, `MIN_IP_BUCKETS`) should be converted to exact equality with a recount, the way the CGNAT ceiling's `toBe` already works, since a floor loosens in silence.
- **Source:** dim-interno:docs/agents/recommendations-2026-08-30.md:77-96
- **State on this tree:** The recommendation is NOT implemented in either file it names: check-api-v1-envelope.ts:246 MIN_V1_ROUTE_FILES = 33 is still used as a floor (`files.length < MIN_V1_ROUTE_FILES`, :340) and api-v1-rate-limit-families.test.ts:336 still asserts toBeGreaterThanOrEqual(MIN_IP_BUCKETS = 38), with :161-163 explicitly noting it is a floor while the CGNAT aggregate (:754) is a toBe.
- **Note:** This row is an open RECOMMENDATION (a review's proposal), not a rule the tree follows.

## Live violations

Rules whose text is FALSE on the tree at this snapshot — not merely unenforced.

### CANON-010

- **Rule:** The panorama QA nightly report-only scripts must never turn the run red on a finding; only the surrounding setup steps (bootstrap, seed, build, start) may fail the job.
- **Scope:** process
- **Status:** UNENFORCED
- **Evidence:** No enforcer, and the rule is FALSE on the live tree: scripts/qa-panorama-chaos.ts:848 exits `summary.passed ? 0 : 1`, and the chaos step of dim-interno:.github/workflows/panorama-qa-nightly.yml (moved to the private companion repository on 2026-09-24 with every staging-facing scheduled job) runs it with no `\|\| true` and no continue-on-error — a failed chaos round turns the nightly red.

### CANON-260

- **Rule:** `packages/contract` must have zero runtime dependencies and zero framework coupling — no `next`, `react`, `drizzle-orm`, `@/*` app aliases, nothing in `dependencies`, no `@/` app-alias import anywhere in the package, and no relative import escaping the package directory.
- **Scope:** contract
- **Status:** PARTIAL
- **Evidence:** Refuter verdict reused and re-verified: the rule's 'nothing in dependencies' clause is FALSE on the live tree — packages/contract/package.json:25-27 declares zod ^4.4.3, approved at check-contract-purity.ts:130-131. Rules 1-4 and 6 (no framework, no @/ alias, no escaping relative, no undeclared bare, no by-path import) ARE enforced.

## Contradictions

Places where two documents, or a document and the code, say different things.

### Event catalog: type count and declaration site

- **The doc says:** AGENTS.md:34 says the EVENT_TYPES const IS the count ('48 at last read') and names db/schema.ts as its home; AGENTS.md:685 repeats the db/schema.ts location.
- **The tree says:** 55 entries, declared at packages/contract/src/events/event-types.ts:20 and only re-exported by db/schema.ts:277,289 (which is what the fence imports). AGENTS.md:83 and :680 already say 'Event catalog — 55 types' elsewhere in the same file.
- **Evidence:** db/schema.ts:277,289; packages/contract/src/events/event-types.ts:20; __tests__/event-catalog-count.test.ts:26,36,43 (the fence pins 'Event catalog — N types' phrasing only, so AGENTS.md:34's '(48 at last read)' phrasing escapes it)

### Definition of Done: pnpm test vs pnpm test:verified

- **The doc says:** CONTRIBUTING.md:79,90 names plain `pnpm test` twice as the pre-PR gate and never mentions test:verified.
- **The tree says:** CLAUDE.md makes `pnpm verify` + `pnpm test:verified` the DoD and forbids `pnpm test` as evidence; ci.yml:893-905 runs test:verified.
- **Evidence:** CONTRIBUTING.md:79,90 vs .github/workflows/ci.yml:893-905

### Invariant #3 wording: 'no view is source of truth' vs the honest-hybrid cache rule

- **The doc says:** AGENTS.md:22 still reads 'Projections are first-class ... No view is source of truth.'
- **The tree says:** Superseded 2026-07-24: CLAUDE.md invariant #3 and AGENTS.md:147 both say operational caches ARE dual-written by design with declared boundaries; the old slogan still lives verbatim at AGENTS.md:22 at this SHA.
- **Evidence:** AGENTS.md:22 vs AGENTS.md:147 and CLAUDE.md invariant #3

### Application-fence exemption-list count and target

- **The doc says:** AGENTS.md:1581 says 'the goal is 0' exemptions; a separate header note in the fence cites a closed 2026-08-20 historical incident (46-vs-44) as the reason the ratchet exists.
- **The tree says:** 34 exemptions today, pinned by EQUALITY (not a floor heading toward 0) — scripts/application-fence-baseline.json:2 = {"exemptions":34}; check-application-fence.ts:36-39,308 fails any count other than exactly 34. Neither 46/44 nor the stated goal of 0 is the live number.
- **Evidence:** scripts/application-fence-baseline.json:2; scripts/check-application-fence.ts:36-39,308 (affects CANON-283)

### Commit-message language

- **The doc says:** CLAUDE.md invariant #4 groups docs (commit messages by omission) as English.
- **The tree says:** docs/agents/collaborating-writer.md:50-52 declares commit messages es-AR (decided 2026-08-29); the last 8 commit subjects on the live tree are all Spanish.
- **Evidence:** docs/agents/collaborating-writer.md:50-52; git log --oneline -8 (refuter-confirmed)

### CI <-> verify gate-set parity is stated as equality

- **The doc says:** The rule (CANON-028) states the gate set in `verify` must EQUAL the set CI runs.
- **The tree says:** The fence enforces containment in one direction only (verify subset of CI); its own test declares that deliberate.
- **Evidence:** scripts/check-ci-lint-parity.ts:79-82 vs __tests__/check-ci-lint-parity.test.ts:109

### Public brand spelling: MiMAR vs miMAR

- **The doc says:** CLAUDE.md and CANON-024 spell the user-facing brand 'MiMAR'.
- **The tree says:** The live fence BANS 'MiMAR' as wrong-cased and pins 'miMAR' (lowercase m) as canonical, per the PO decision of 2026-07-18; the fence's scope excludes .md so the docs are never scanned.
- **Evidence:** scripts/check-brand-casing.ts:69-72,140 (WRONG_CASE_BRAND regex bans MiMAR/Mimar/MIMAR), :143 REMEDY

### Panorama QA nightly is 'report, not gate'

- **The doc says:** dim-interno:.github/workflows/panorama-qa-nightly.yml:9-13 — 'The scripts' own headers say nothing here can turn a run red.'
- **The tree says:** scripts/qa-panorama-chaos.ts:848 exits `summary.passed ? 0 : 1`, and the step running it carries no `\|\| true` and no continue-on-error — a failed chaos round turns the nightly red.
- **Evidence:** scripts/qa-panorama-chaos.ts:848 vs dim-interno:.github/workflows/panorama-qa-nightly.yml:228-231

### Panorama QA nightly checkout ref

- **The doc says:** dim-interno:.github/workflows/panorama-qa-nightly.yml:27-31 — 'IT MUST NOT CHECK OUT main.'
- **The tree says:** Both build jobs pin `ref: main` (:58 and the chaos job's checkout), as does the alert job (:283); the prose is stale since DEPLOY_REF became main on 2026-09-01.
- **Evidence:** dim-interno:.github/workflows/panorama-qa-nightly.yml:27-31 vs :58,:283

### CI test-job timeout comment vs live value

- **The doc says:** ci.yml:665 comment says 'timeout-minutes raised from 15 -> 20 to account for v8 coverage instrumentation overhead.'
- **The tree says:** 30
- **Evidence:** .github/workflows/ci.yml:641 vs :665 (a stale comment about the current value, not a labelled historical incident)

### How many of the three payload-evolution rules lint:events actually enforces

- **The doc says:** AGENTS.md:894 — 'Three rules, enforced by pnpm lint:events (scripts/check-event-payload-parity.ts) in the verify pipeline.'
- **The tree says:** One. check-event-payload-parity.ts:10-11 enforces only rule 2 (reader keys must be writable); :13-21 declares it a FLAT key set with no per-event-type precision.
- **Evidence:** scripts/check-event-payload-parity.ts:10-21,448; AGENTS.md:894-898 (affects CANON-256, CANON-257, CANON-258)

### packages/contract 'The One Rule': nothing in dependencies

- **The doc says:** packages/contract/README.md#the-one-rule — 'Zero runtime dependencies ... and nothing in dependencies.'
- **The tree says:** packages/contract/package.json:25-27 declares zod ^4.4.3, approved at scripts/check-contract-purity.ts:130-131 with a written rationale.
- **Evidence:** packages/contract/package.json:25-27; scripts/check-contract-purity.ts:29-33,130-131 (affects CANON-260, CANON-261)

### data-lifecycle cron purge targets

- **The doc says:** docs/architecture/retention-policy-pending-decision.md#context — purges only targets with explicit, non-PII expiry semantics, naming three (notifications, rate-limit buckets, cron_runs).
- **The tree says:** SIX targets (lib/infra/data-lifecycle.ts:3-15): purgeExpiredRateLimitBuckets, purgeExpiredNotifications, purgeRevokedPushSubscriptions, purgeOldOrgContactIps, purgeOldCronRuns, purgeAbandonedStagedUploads — the fourth nulls org_contact_messages.submitter_ip, which the same file calls 'a personal datum' (:10-13), so the 'non-PII' qualifier no longer holds either, and the sixth (added 2026-09-10) widens the gap in a second direction: it deletes storage OBJECTS, not rows, so 'expiry semantics' is not even the same kind of claim about it.
- **Evidence:** lib/infra/data-lifecycle.ts:3-15,10-13,114 (affects CANON-233, CANON-186)

### Where the native-directory .easignore listing lives

- **The doc says:** docs/mobile/eas-build-profiles.md — 'apps/mobile/.easignore must list the same two paths.'
- **The tree says:** There is no apps/mobile/.easignore. The listing is in the ROOT .easignore:188-189 (apps/mobile/android/, apps/mobile/ios/); EAS reads .easignore only from the repository root.
- **Evidence:** apps/mobile/.gitignore:42-43; <repo root>/.easignore:188-189; apps/mobile/src/release/release-config.test.ts:661-666 (affects CANON-442)

### Hexagonal-lite coverage thresholds (CANON-357)

- **The doc says:** 90% branches on domain rules, 70-75% on the module/action layer.
- **The tree says:** business-rules 80, lib/** 55, app/actions 22, app/api 8, domain 88, src/modules 55 — and coverage runs only under `pnpm test:coverage`, which is not in verify.
- **Evidence:** vitest.config.ts:136-161

### Ratchet baselines whose DESCRIPTION prose outlived their counts

- **The doc says:** scripts/seed-ids-baseline.json, scripts/brand-casing-baseline.json and check-timezone-dates.ts:20 all describe a 'grandfathered / RATCHET' regime still tolerating violations.
- **The tree says:** All three baselines are EMPTY today — {"totalViolations":0,"files":{}} for all three — so all three rules are absolutely enforced, not merely ratcheted.
- **Evidence:** scripts/seed-ids-baseline.json:3-6; scripts/brand-casing-baseline.json:3-6; scripts/timezone-dates-baseline.json:3-6

### Mortalidad count dataset and the zero value (CANON-373)

- **The doc says:** docs/datos-abiertos/metodologia.md reads as a carve-out publishing an exact 0 for rates but suppressing small counts.
- **The tree says:** The count path suppresses 0 too: suppressSmallCells treats count < k uniformly regardless of path; the density path mirrors the locality tier exactly.
- **Evidence:** lib/open-data/__tests__/province-suppression.test.ts:92-100

### Dark mode's existence (cross-fence contradiction)

- **The doc says:** scripts/check-design-tokens.ts:7-9 — dark mode is disabled at the @variant level in app/globals.css, so `dark:` classes 'never apply'.
- **The tree says:** scripts/check-op-controls.mjs:13-14 explains a real bug in terms of what --color-ln-op-card IS in dark mode (#111a2b, rendering white-on-white) — implying dark mode does apply somewhere on the live tree.
- **Evidence:** scripts/check-design-tokens.ts:7-9 vs scripts/check-op-controls.mjs:12-14

## Merged rows

Ids folded into another row during extraction. Kept so an old citation still resolves.

### CANON-026

- **Merged into:** CANON-149

### CANON-078

- **Merged into:** CANON-056

### CANON-127

- **Merged into:** CANON-114

### CANON-130

- **Merged into:** CANON-082

### CANON-120

- **Merged into:** CANON-101

### CANON-492

- **Merged into:** CANON-101

### CANON-228

- **Merged into:** CANON-202

### CANON-356

- **Merged into:** CANON-376

### CANON-011

- **Merged into:** CANON-066
- **Rule:** A permanently-red scheduled workflow must alert on a red streak via an issue, not rely solely on GitHub's green-to-red transition email, since a never-run workflow's first run has no green to transition from.
- **Reason:** One rule stated twice: 'alert on a red streak via an issue' (011) IS 'wire the .github/actions/red-streak-alert composite action' (066) — same fence, same lines (check-scheduled-fence-refs.ts:506-524 alertFindings + the bidirectional ALERT_EXEMPT). CANON-066 states it plus the `audited:` job-output clause and cites the fence's own test, so folding loses no requirement. Both ENFORCED → ENFORCED.

### CANON-167

- **Merged into:** CANON-412
- **Rule:** No seed script may write a seed-marker literal into a renderable column (displayName/description/name).
- **Reason:** Identical rule, identical enforcer (scripts/check-seed-ids.ts + scripts/seed-ids-baseline.json), split only by scope label (db vs web). CANON-412's wording carries the fourth renderable column (legalName) that the fence actually checks, and its basis is the P14 empty-baseline reading. Kept status ENFORCED — which is also the Task 2 verdict for CANON-167, so the merge is not an average.

### CANON-419

- **Merged into:** CANON-196
- **Rule:** A caller holding an ownership row on a pet whose role is caretaker may not perform a titular-only database effect (declared spine event, restricted pet column update, or restricted insert table).
- **Reason:** One prohibition, two framings of the same deny-list: the six user-facing titular-only actions (196, sourced AGENTS.md:436) and the three DB effect classes the fence enumerates (419, sourced check-titular-gate.ts:8). Same enforcer lines (check-titular-gate.ts:51,79-82,91 + db/rls.sql + migration 0199) and same status. Kept 196 as the fuller doc statement; 419's quote and sources preserved in mergedFrom.

### CANON-299

- **Merged into:** CANON-266
- **Rule:** Every design token declared in `@dim/contract/tokens` must exactly match the corresponding `@theme` declaration in `app/globals.css`.
- **Reason:** Verbatim restatement across scopes ('@dim/contract/tokens must match app/globals.css @theme'), same fence scripts/check-design-token-parity.ts, same lint:token-parity wiring. CANON-266 states the both-directions property the fence implements; CANON-299's sibling-test citation folds into enforcer[]/sources.

## Unmapped enforcers

Enforcement machinery that exists in the tree and that NO canon row cites. Every
`lint:*` key in `package.json`, every `scripts/check-*.ts`, every
`__tests__/**/*{fence,parity,coverage}*.test.ts`, and every path listed in the parity
fence's `EXTRA_FENCES` (fences whose FILENAME hides them from that glob) is either
cited by a row's enforcer or listed here. The parity fence pins this list's length
EXACTLY: growing it and shrinking it are both hand edits, and both are reviewable.

14 unmapped.

| Kind | Item | Why it is unmapped |
| --- | --- | --- |
| lint-key | `lint:place-resolver` | Runs scripts/check-place-resolver-single-entry.ts (stage B, localidades-por-id); canon row with stage E. |
| lint-key | `lint:province-map` | Runs scripts/check-province-map-single-source.ts (stage B, localidades-por-id); canon row with stage E. |
| check-script | `scripts/check-place-resolver-single-entry.ts` | Stage B of the SDD change localidades-por-id (2026-09-25): every place is resolved through lib/place/resolve-place.ts, one entry point. Its canon row lands with the change's stage E, when the name path is retired. |
| check-script | `scripts/check-province-map-single-source.ts` | Stage B of the SDD change localidades-por-id (2026-09-25): the province name/code map has one source (ar_province_code / ar_province_name). Its canon row lands with the change's stage E. |
| fence-test | `__tests__/lost-routing-web-mobile-parity.test.ts` | Stage A of the SDD change localidades-por-id (2026-09-25): a lost report from the web and from the app routes to the same authority (where the pet was lost, never its home). The canon row for place-by-id lands with the change's stage E, when the name path is retired; until then this fence is listed here. |
| fence-test | `__tests__/architecture-facts.test.ts` | Postdates the d7dbf25f7 snapshot; fences the facts markers, no canon row yet. Its filename carries none of fence/parity/coverage, so the census reaches it only through EXTRA_FENCES in __tests__/conventions-canon-parity.test.ts. |
| fence-test | `__tests__/check-function-parity.test.ts` | Pins scripts/check-function-parity.ts, which no canon row cites either: the rule it guards (a SQL function declared in a migration must match the one the app calls) was never written down in prose, so extraction had nothing to harvest. |
| fence-test | `__tests__/contact-email-domain-fence.test.tsx` | Postdates the d7dbf25f7 snapshot (added 2026-09-07 with lib/ui/contact.ts); no canon row can cite it without describing prose that did not exist when the canon was taken. It bans the class rather than a spelling: every email address a shipped file under app/ or components/ names must be at a domain in OWNED_MAIL_DOMAINS, with input placeholders and RFC 2606 example domains as the two structural exemptions. |
| fence-test | `__tests__/conventions-canon-parity.test.ts` | This canon's own fence. It postdates the d7dbf25f7 snapshot the rows were harvested from, so no row can cite it without describing a tree that did not exist when the canon was taken. |
| fence-test | `__tests__/public-hostname-fence.test.ts` | Postdates the d7dbf25f7 snapshot (added 2026-09-07 alongside __tests__/contact-email-domain-fence.test.tsx); no canon row can cite it without describing prose that did not exist when the canon was taken. Hostname half of the same class its sibling covers for mailboxes: RULE A holds every domain the product declares as its own (PUBLIC_BRAND_DOMAIN, the resolveSiteUrl fallback, the credential-QR host) against OWNED_WEB_DOMAINS in lib/infra/site-url.ts, read through the public API rather than off the constant; RULE B bans any hardcoded absolute URL into a route this app serves, with the route table derived from the app/ tree at scan time so it cannot rot. |
| fence-test | `__tests__/db-clock-window-fence.test.ts` | Added 2026-09-11. The rule it guards IS written in prose — CLAUDE.md's fourth red signature says it in one sentence, "no assertion may compare a clock read on the host against a column with defaultNow()" — but nothing enforced it, and the cure (__tests__/_helpers/db-now.ts) had exactly two importers on the day this landed. The defect it prevents has cost a gate twice: on 2026-08-30 two test:verified runs over ONE tree answered differently, with no worker crash and no broken file, because `const since = new Date()` in Node was compared against a column defaulted from Postgres's now() inside a Docker container whose clock had drifted. Two tests across three files, failing in OPPOSITE directions — one window too narrow to see its own row, two too wide and admitting the previous run's. THE RULE BANS THE SUBJECT, NOT A SPELLING, and the first draft got that wrong in a way worth recording: banning `new Date()` inside any comparison flags `gt(reminders.dueAt, new Date())` in pregnancy-flow.test.ts, which is CORRECT — dueAt carries no .defaultNow(), it is a future date the application computes, days away, where milliseconds of drift change nothing. A fence that reds a correct assertion teaches people to disable fences. So the column set is DERIVED from db/schema.ts at run time rather than hand-listed, and a new defaultNow() column is covered the day it is declared. Its own detector is exercised against a synthetic source rather than trusted, which is what caught two bugs in the detector on the first run: the fence was scanning itself and reporting its own fixtures, and the right-hand side pattern terminated on the paren inside `new Date()` so it could not match the single most common spelling of the defect. States its own limit: it cannot see a window built in a raw sql template. |
| fence-test | `__tests__/state-endorsement-fence.test.ts` | Added 2026-09-11, long after the d7dbf25f7 snapshot, and the rule it guards was never written in prose so extraction had nothing to harvest: no citizen-facing file may name an Argentine state body in a way that implies it backs, operates or issues miMAR. It came out of a live finding — the landing hero carried 'República Argentina · Ministerio de Salud' above the H1, the footer repeated it over argentina.gob.ar/salud, and worst of all the phone credential printed 'República Argentina' in a slot whose style key is literally `footAuthority`, on the screen its own header calls 'the thing a funcionario is asked to accept as identification'. No convenio exists; the Mi Argentina one is still an unstarted prerequisite. It bans the SUBJECT rather than spellings — `Ministerio de <X>` matches a ministry nobody has typed yet — over 253 files, with two structural exemptions: a norm citation in the same sentence, and an explicit pending marker. Full https:// URLs are stripped before the name scan, so linking out to argentina.gob.ar stays legal; what is banned is a bare-text .gob.ar host or one carrying our own name. Floors at 180 files / 4 namings so a broken regex cannot go quietly green, and it was mutation-tested against the real tree, not a synthetic fixture. |
| fence-test | `__tests__/gob-synthetic-exclusion-fence.test.ts` | Added 2026-09-18 with pilot item T1-P1 (PO decision D3): the pilot runs in the one environment that also holds the national demo seed, so no seed-tagged row may reach a govt or national reader of /gob. The rule lives in dim-interno:docs/handoff/rumbo-al-piloto.md, which the d7dbf25f7 snapshot does not harvest, so no row can cite a source for it without claiming a verifiedAt for a document the extraction never read. The exclusion itself lives inside the scope helpers (lib/metrics/scope.ts withoutSyntheticRows); what this fence holds is the bypass: every raw jurisdictionPairClause( call under lib/, src/ and app/ must apply the exclusion within 12 lines, carry a `synthetic: covered` tag naming a same-file function whose body is CHECKED to apply it, or a `synthetic: exempt` tag with a reason (tables with no seed marker). Floors at 30 call sites / 20 real applications and names the govt read paths it must see, so a sweep that stops matching cannot go quietly green; mutation-tested against the real tree. The behaviour is proven against the database in __tests__/gob-synthetic-exclusion.test.ts. |
| fence-test | `__tests__/schema-check-parity.test.ts` | Added 2026-09-26 with the stage C review of the SDD change localidades-por-id. db:bootstrap pushes db/schema.ts before replaying db/migrations, so on a fresh database a migration's CREATE TABLE IF NOT EXISTS is skipped for every table schema.ts declares, and a CHECK written only in the migration never lands. The fence compares, for the authority-unit and place tables (0250, 0253/0254), every live CHECK name with the ones db/schema.ts declares, and pins place_repair_preimages (0251) as migration-only, so it cannot be moved into schema.ts without its CHECKs. Its canon row lands with the change's stage E, alongside the other localidades-por-id fences listed here. |
