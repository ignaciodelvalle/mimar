# Contract: a collaborating agent joining to WRITE code

Ten rules. Each exists because its violation cost real time in this repo — the
date in parentheses is when it last bit someone. Read this page before your
first edit; read nothing else in full.

## The ten

1. **`origin/main` was rewritten on 2026-08-28. Never `git pull`.** The branch
   was force-pushed from `1a32c926d` to `a3ec504c5`; the old tip is unreachable.
   A `pull` tries to merge ~3900 divergent commits and produces ~1000 phantom
   conflicts. Sync with `git fetch origin && git reset --hard origin/main`, and
   move any unpushed work to a branch first. The 16 currently-open PRs are all
   based on the dead tip — leave them alone, they are not your task.
2. **The gate is `pnpm verify` AND `pnpm test:verified`. Never `pnpm test`.**
   `pnpm test`'s exit code lies in both directions: a worker dying mid-run takes
   its whole FILE with it and the summary still reads green. Your evidence is
   the verdict line, not the exit code:
   `reported N file(s); N discovered; 0 failing test(s); 0 broken file(s)`.
   Anything else is a fail. There are three distinct red signatures with three
   different rules — `/CLAUDE.md` spells them out. Read that section before you
   interpret any red, and never re-run to get a nicer number.
3. **Verify worktree freshness before touching anything.** `git log --oneline -1`
   on the integration tip you were told to work from, compare against your own
   `HEAD`, `git reset --hard` if they diverge. A clean `git status` proves
   nothing about freshness: an agent with a clean tree was found 2,009 commits
   behind.
4. **A fresh worktree has no `.env.local`, and the red it causes is a liar.**
   The file is gitignored, so it never arrives with a checkout, and the six
   `__tests__/rls/*` files then report BROKEN with credential-shaped errors that
   read exactly like real policy failures. Run `npx supabase status -o env` and
   write the four keys it prints BEFORE you believe any RLS red.
5. **Freeze the tree while a gate runs.** Several fences scan the repo as it is
   on disk; editing any file during `pnpm verify` poisons them and you get a red
   that belongs to nobody. Start the gate, then keep your hands off until it
   returns.
6. **Commit with an explicit pathspec. Never `git add .` or a bare
   `git commit -a`.** Parallel agents share one index — a bare add steals their
   staged files into your commit. Name your paths.
7. **Domain facts enter through flows, never raw INSERTs; events are
   append-only.** Corrections are new events, never edits. Migrations are
   forward-only and immutable (`db/migrations/NNNN_*.sql`); recount the next free
   integer at write time. **Writing a migration is your job; applying it to a
   remote DB is Ignacio's** — hand it over, do not run it.
8. **A fresh-context reviewer is a mandatory pre-push step.** Before pushing a
   commit range, a read-only subagent that did NOT write the code does an
   adversarial pass over it. The gate is not a substitute: it proves the code
   matches its author's belief, not that the belief was right. Point the reviewer
   at what you are least able to audit — your own new tests and fences.
9. **Spanish (es-AR) in the UI and in commit messages, English in the code.**
   Identifiers, comments and docs in English; user-facing copy in es-AR.
   **Commit messages are es-AR** (2026-08-29) — this page claimed English until
   that date and was the only page in the repo that did. The practice flipped on
   2026-08-05: all 867 commits since are Spanish with no exception, while
   history older than 2026-08-04 is predominantly English. Follow the recent
   end, not the bulk, and read `git log -20 --format='%s'` before writing your
   first — subjects here name the lie or the domain problem, not the file, and
   they run long. Files are UTF-8, no exceptions. No DNI in plaintext —
   `lib/utils/dni-hash.ts` (`hashDni()` to compare, `dniLast4()` to display).
10. **Stay in scope.** Touch only what your task names. Adjacent problems get
    reported, not fixed — this repo's history is full of one-line fixes that
    turned into eleven families of leak.

## Start here, in this order

| Step | What | Why |
|---|---|---|
| 1 | `/CLAUDE.md` (86 lines) | The invariants and the Definition of Done. Short, and the highest-value thing you will read. |
| 2 | This page's rule 2, again | The gate's failure modes are the single most expensive thing to learn late. |
| 3 | Run `pnpm verify`, then `pnpm test:verified`, on a clean tree | Not ceremony. You need to see a real verdict line before you can judge your own. |
| 4 | **`dim-interno:docs/agents/open-work.md`** | The board: milestones, everything still open, the declared debts, what is PO-gated and must be handed back rather than attempted. |
| 5 | `docs/agents/README.md` | The other agent contracts, and the working norms. |
| 6 | `AGENTS.md` — **the slim index only** | 1,833 lines. It has anchors mapping each topic to a section. Load the section you need; never the whole file. |

`pwsh scripts/qa-up.ps1` brings up the local QA environment (Supabase
containers, production server on :3000, smoke tests, seed accounts).

## Your first task

**It is not named here. Take it from the table in
`dim-interno:docs/agents/open-work.md`, and read that page's "Landed since this snapshot"
section before you start.**

This section used to name one ("let an owner edit their pet's data and their
emergency contacts") and it kept sending new writers at work that had shipped at
`ecc835aa4` — including the claim that "there is no edit screen of any kind",
which stopped being true in the same commit. Two consecutive integration windows
reported it and neither owned this file. **The task no longer lives on this
page, deliberately**: the board is edited by every lane that lands something, and
this page is not, so a task written down here goes stale between the moment it is
written and the moment it is read.

What the board will not tell you, and this page can:

- **Pick by what a live tester hits, not by what is largest.** The app is on
  Google Play internal testing, so a gap a tester meets today outranks a gap that
  is architecturally more interesting.
- **The web already serves what the board still lists**, so for almost anything
  you pick the server side and the guards exist. Read them and copy the guard as
  a negation of the web's own call site; do not re-derive it. Guards that were
  re-derived rather than copied are how this repo grew two rules for one act.
- **Where it lands**: `apps/mobile/app/` is expo-router — the screen files ARE
  the paths (`ajustes.tsx`, `alta.tsx`, `mascotas/`, `cuenta/`, `cuidado/`,
  `turnos/`, `transferencias/`, `notificaciones.tsx`). A route that needs a
  header title also needs a `Stack.Screen` in `app/_layout.tsx`; an unregistered
  one takes its header from the path segment, lowercase and in English-looking
  form.
- **Do NOT start with the pet photo** — row 1 on the board, and the board says so
  itself. It looks adjacent and the server side is genuinely done, but it needs a
  native image picker → a native module → an EAS build, and that pipeline cost six
  builds with five distinct root causes, three of which are invisible to every
  local gate. It is not blocked; it is just not yours on day one.

The declared debts and the list of what is PO-gated — hand those back, do not
attempt them — are on the same board page.

## Two things to hand back, not solve

- The pet photo's server design deliberately differs from the request: signed
  upload lands in a **private** bucket, and a `confirm` step re-authorizes,
  verifies magic bytes and re-encodes before writing to the public one. If you
  touch that area, read why before changing it.
- `required_linear_history` is OFF on `main` on purpose (2026-08-28). The
  integration branch carries 118 worktree merge commits; turning the rule back
  on re-blocks the next sync. Do not "restore" it.

## Where what you write may live

This repository is public. Before you create a document, read
`docs/agents/public-private-boundary.md`: reviews, handoffs, plans, pilot and
outreach material and deploy/cutover/incident runbooks go to `dim-interno`, and
`pnpm lint:public-boundary` (in `pnpm verify`) fails the gate if they land here.
