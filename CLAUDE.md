# DIM / MiMAR — Claude Code project memory

> Thin session bootstrap. Deep context lives in `AGENTS.md` — its slim index maps every deep section to an anchor; load sections on demand, never the whole file.

## What this is

**DIM / MiMAR** — Argentina's digital pet credential system. Internal codename **DIM** (code, schema, `DIM-XXXX-XXXX` tokens); user-facing brand **MiMAR**. Owner: **Ignacio Del Valle** (non-technical PO) — Claude writes the code, Ignacio drives product decisions and runs commands locally on Windows.

Stack: Next.js 15 (App Router) + React 19 + TypeScript, Supabase (Postgres + RLS + Auth), Drizzle, Tailwind + shadcn/ui, Vitest, Biome, **pnpm**, Supabase CLI (Docker) for local dev.

## Invariants (never break)

1. **The pet is the credential** — globally-unique public token resolving to a QR-verifiable public page.
2. **Events are append-only** — never edit or delete; corrections are new events.
3. **Facts are event-sourced; caches declare themselves** — medical/custody lifecycle facts live only in the append-only event spine; operational caches (`pets.*` columns, ownerships) and curated metadata are dual-written **by design**, with explicit boundaries and drift detection (`rederivePetCache`). No cache ever outranks the spine; no dashboard reads pretend a cache is the log. (Honest-hybrid rewording, PO 2026-07-24 — the old "every view is a projection" slogan overclaimed.)
4. **Spanish (es-AR) UI, English code** — identifiers, comments, and docs in English.
5. **No DNI in plaintext** — `lib/utils/dni-hash.ts` (`hashDni()` for equality, `dniLast4()` for display).
6. **Mi Argentina federation is the premise** — no decision may harm that path.

## Definition of Done

`pnpm verify` + **`pnpm test:verified`** green (paste actual output as evidence) AND committed. Conventional commits, no AI attribution.

> **Not `pnpm test`.** Its exit code lies in both directions, and the repo says so in `scripts/check-suite-coverage.ts`: a worker dying mid-run takes its whole FILE with it, and the summary still reads like a pass — `1333 passed | 1 skipped (1336)` is a green-looking line with two files that never executed. `test:verified` runs the same suite, ignores vitest's exit code on purpose, and fails when any discovered file is missing from the report. Never give it a positional file filter; it detects that and skips the verdict loudly.
>
> **What counts as passing, exactly.** The evidence you paste is the verdict line, not the exit code:
>
> - `reported N file(s); N discovered; 0 failing test(s); 0 broken file(s)` → **passes.** Every file ran and nothing failed.
> - Any file short, any failing test, or any broken file → **fails.** No judgement call, no re-roll to get a nicer number.
>
> A **broken file** is one that reported with an error OUTSIDE any test, or with a test still **pending** (never finished) — it is named under the verdict line with its message. A mock/collection/import error there (`No "x" export is defined on the "@/db" mock`) is a real failure with zero failing tests: the file never ran. Four consecutive runs on 2026-08-22, three of them on CI, were exactly that and were misread as the teardown crash because the old verdict counted only tests. **A broken file carrying a mock/collection/import error may NOT be committed.**
>
> The **third signature, measured 2026-08-23**: the worker dies WHILE a file is running. That file reports `passed` with some of its assertions still `pending`, the verdict names it as a broken file, and `Worker exited unexpectedly` is in the log. Gate #26 over `bcb4b984f`: `0 failing test(s); 1 broken file(s)`, victim `__tests__/gob-pet-subview-jurisdiction-fence.test.ts`, 4 tests never finished — a file with no relation whatsoever to the change being gated. The immediate re-run was clean and ran **16834** tests against the broken run's **16830**: exactly the four. So the rule for this one is neither of the other two: **re-run once.** Clean re-run + a victim unrelated to the change = the open worker defect, and it may be committed with BOTH verdict lines quoted. Reproduces, or the victim is in your change's blast radius = treat it as your failure until proven otherwise. Never re-run more than once to get a nicer number — that is the re-roll this file forbids.
>
> **Refinement, 2026-08-28: WHICH file breaks is itself a signal, and a different victim each run points AWAY from you.** The paragraph above was written from one instance where the same victim recurred and the re-run was clean. The uploads-firmados gate hit a third case it does not describe: three runs over one tree, `0 failing test(s); 1 broken file(s)` every time, and a DIFFERENT unrelated victim on each — `finalize-ends-caretaker-grant.test.ts`, then `lib/metrics/deworming.test.ts`, then `adoption-review.test.ts`. A fault a change introduces is deterministic about which file it kills; a fork that dies at run level lands on whatever happened to be in flight. **Same victim twice = look at that file. Different victim each time = look at the run.**
>
> The proof that clause asks for ("until proven otherwise") is then a **baseline control**, not another draw from your own tree: `git worktree add <dir> <base-commit>`, `pnpm install --frozen-lockfile`, run the suite there. That is not the re-roll this file forbids — a re-roll is another sample of the same tree hoping for a nicer number; a control is a different tree answering a different question. Two Windows gotchas: `cp` of `.env.local` may be permission-blocked, so write one from `npx supabase status -o env` (DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY is all the suite needs, and the local values are the standard demo keys); and `git worktree remove --force` fails with "Filename too long", so `rm -rf` the directory then `git worktree prune`.
>
> **RUN THE CONTROL TWICE. A single clean control run is not evidence of absence, and this nearly went the wrong way because of it.** Control run 1 at the untouched baseline came back fully clean and the conclusion drawn was "the crash is mine". Control run 2, same commit, same database, same machine, produced `reported 1434 file(s); 1434 discovered; 0 failing test(s); 0 broken file(s)` with `Worker exited unexpectedly` and exit 1 — the teardown signature, on code nobody had touched. One clean sample of a nondeterministic failure says nothing; it just resets the coin.
>
> The pending-assertion rule that catches this was written the day before as a purely DEFENSIVE guard: the reviewer who proposed it could only demonstrate it with a synthetic report, because the real 1373-file report had zero pending assertions. It fired on its own the next day. A false-green channel you cannot currently observe is not the same as one that cannot happen.
>
> **A fourth kind of red was seen on 2026-08-30, and it was NOT a fourth signature — it was a defect in a test, and it is CLOSED.** Two `test:verified` runs over one tree answered differently (`0 failing` then `1 failing`), with **no** `Worker exited unexpectedly` and **no** broken file, so none of the three rules above applied and none of them should have been stretched to cover it. The cause: assertions that took `const since = new Date()` in **Node** and compared it against a column defaulted from **Postgres's** `now()` inside a Docker container. When the container clock sits behind the host — which a Docker VM on macOS does without warning after a resync — a row that really exists falls outside `performed_at >= since` and the test fails on a tree that is correct. It was two tests across three files, failing in opposite directions: one window too narrow to see its own row, two too wide and admitting the previous run's. **The rule, which is the part worth keeping: no assertion may compare a clock read on the host against a column with `defaultNow()`.** Take the instant from the database (`select now()`, see `__tests__/_helpers/db-now.ts`) where a window is genuinely needed, or drop the window and match on the payload where it is not. Never widen the comparison with a tolerance — a tolerance sets a drift budget nobody measured, and the drift here is unbounded. This is not a red you may commit and not a red you may re-run: a suite that answers differently twice over one tree does not meet the Definition of Done, whatever the second answer is.
>
> The **teardown crash** has a different signature, and it is the only red that may be committed: the verdict line is clean (`0 failing test(s); 0 broken file(s)`), `run-verified-suite` still exits 1 ("the coverage verdict passed but vitest itself exited 1"), and the log carries `Worker exited unexpectedly`. In vitest 4.1.6 that error is run-level — the JSON reporter drops it, so it never becomes a broken file; the file it killed had already reported green. The script re-folds vitest's exit code on purpose so nobody normalises a crashing run, and that is correct: this is an **open defect**, not a tolerated condition — it must be fixed, not papered over. Until it is, a run with THAT signature may be committed — say so in the commit, with the verdict line quoted. Three signatures, three rules; do not let one borrow another's. Migrations are forward-only and immutable (`db/migrations/NNNN_*.sql`); recount the next free integer at write time — never hardcode one from a plan. Writing a migration file is agent work; applying it to a remote DB is Ignacio-gated.

**e2e is a separate gate** — Playwright is NOT in `pnpm verify`; it runs as CI's own job (and nightly vs staging, from the private companion repo — `dim-interno:.github/workflows/`, where every staging-facing scheduled job lives since 2026-09-24). Touching a browser-facing flow means checking that job, not just the local suite. Conventions and the hard-won traps live in `e2e/README.md` — read it before writing or fixing a spec.

## Delivery strategy (decided — do not re-ask)

`delivery_strategy: single-pr` with `size:exception` is the project default (PO decision, three consecutive changes: pet-document-redesign #593, admin-rules-console #604, jurisdiction-compliance 2026-07-03). When an SDD forecast recommends chained PRs, note it in the summary but do not stop to ask. Still structure work-unit commits so a later split remains possible.

## Working norms

- **Every agent gets a one-page contract** — `docs/agents/README.md` is the hub (read-only auditors, mutating QA agents, subagents). Briefing ANY agent? Point it at its page. Delegating via the Agent tool? The call carries an explicit `model` (mechanical → sonnet).
- **spec → plan → PR** — code descends from documents (`docs/superpowers/README.md` is the index). If a change feels in tension with what's written, raise it before coding around it.
- **Engram is the SDD artifact store** — topic keys `sdd/{change}/*`; session summaries are mandatory.
- **Poll every background child within your own turn** (STRUCTURAL — the first line of every agent brief) — after launching any background child, poll its output within your turn: loop on `Read` of its output file, or re-run it synchronously. A turn may not end with a live child unpolled; that stalls the pipeline until manually resumed (recurred 3× in one day despite prompt warnings).
- **A fresh-context reviewer is a standard pre-push step** — before pushing a commit range, run a read-only adversarial pass over it with a reviewer that did not write the code. The instrument is a **read-only subagent** (PO decision 2026-08-08; cursor-agent is gone). `/code-review ultra` is the deeper, billed, Ignacio-launched pre-deploy pass — not this one. A green gate is not a substitute: it proves the code matches its author's belief, not that the belief was right.
- **Parallel writers only in worktrees** — N read-only agents in parallel is free; a 2nd writer runs ONLY in its own git worktree with disjoint file territory + targeted tests (local Supabase is shared), landing through a serial integration merge gate (full `pnpm verify` + parity where applicable). **A fresh worktree has no `.env.local`** — it is gitignored, so it never comes with the checkout, and the six `__tests__/rls/*` files that need it then report as BROKEN with credential-shaped errors that read like real policy failures. That is a FOURTH red signature, and unlike the three worker-crash ones above it is environmental rather than vitest's: cure it with `supabase status -o env` before treating a worktree gate as evidence of anything.
- **Spec-conflict rule: validated code beats design-handoff tables** — when a tested constant disagrees with a handoff's token table, the code wins (case study: the CVD teal near-regression, `viz-scales.ts` `COLOR_DIVERGENT_ABOVE` vs the v2C README's pre-fix `#0d9488`).
- **QA environment bootstrap**: `pwsh scripts/qa-up.ps1` — checks Supabase containers, build freshness vs HEAD, starts the production server on :3000, smoke-tests key routes, and verifies seed accounts.
- **Public code, private operations — fenced** — this repo is public; reviews, handoffs, plans, pilot/outreach material and deploy/cutover/incident runbooks go to `dim-interno` (`dim-interno:<path>`). Policy: `docs/agents/public-private-boundary.md`; enforced by `pnpm lint:public-boundary`.

## AGENTS.md deep sections (load on demand)

| Need | Anchor |
|---|---|
| Data model / schema / migrations | `#data-model` |
| Event catalog (55 types) | `#event-catalog--55-types` |
| Roles, account types, capabilities | `#user-roles--account-types` |
| RLS / authorization | `#authorization-architecture-wave-5-item-26` |
| Privacy checklist (any public route or PII field) | `#privacidad-y-manejo-de-datos` |
| UI conventions (forms, CTAs, AppShell, location capture) | `#design-rules-ui-conventions` |
| Feature inventory ("does X exist?") | `#feature-inventory` |
| Legal framework (AR laws, SENASA) | `#legal-framework` |
