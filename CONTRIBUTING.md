# Contributing to miMAR

> **Outside pull requests are not accepted at this time.** The code is public so
> it can be read, run locally and audited under the terms in [LICENSE](./LICENSE);
> changes are made by the maintainer. **Security reports are welcome** — send
> them privately as described in [SECURITY.md](./SECURITY.md).

miMAR (internal codename DIM, which stays in code, schema and tokens) is a Next.js + Drizzle + Postgres / Supabase app, event-sourced where it matters. This file is how the code is worked on: setup, the gate, conventions. It is also what you need to run the system locally to evaluate it.

## Quickstart

Requires **Node 22.23.0 – 22.x** (`.nvmrc` pins 22.23.2; `fnm use` / `nvm use`
picks it up), **pnpm**, and **Docker Desktop** running. The range is closed at
both ends and `pnpm lint:node-version` enforces it — four separate things break
outside it:

| below | what breaks |
|---|---|
| 22.15.0 | `node:module` has no `registerHooks` → every `seed:*` dies on import |
| 22.18.0 | no type stripping → `verify:mobile` cannot read `@dim/contract`'s raw `.ts` |
| 22.23.0 | ICU < 78 decodes windows-1252 `0x97` as U+0097, not an em dash → the fiscalía PDF tests |
| — | **on 23+**: Node's built-in Web Storage shadows jsdom's and ~125 suites fail for reasons that are not yours |

```bash
pnpm install
pnpm db:start          # local Supabase via Docker
# copy .env.local.example → .env.local, fill values from `pnpm db:status`
pnpm db:bootstrap      # schema + migrations + triggers + RLS + storage + seeds (one command)
pnpm dev               # http://localhost:3000
```

`db:bootstrap` is idempotent and localhost-only. Prefer it for a fresh setup — it applies the triggers, RLS, and storage policies that `db:push` alone does not. (Granular alternative: `pnpm db:push` + `pnpm seed:test`, then paste `db/triggers.sql` / `db/storage.sql` into Studio.)

If any of these fail, fix that first — they're the floor everything else builds on.

## Reading order for new contributors

There is a lot of context in this repo. Read in this order:

1. **[AGENTS.md](./AGENTS.md)** — lectura obligatoria. Load the slim index at the top first (always-load, ~1.5k tokens), then follow the anchor links to the deep sections relevant to your task. Before touching a public route, a token, or a PII field, load the [§ Privacidad y manejo de datos](./AGENTS.md#privacidad-y-manejo-de-datos) section — it is the per-task privacy gate.
2. **[docs/superpowers/README.md](./docs/superpowers/README.md)** — index of feature specs and plans. Browse the existing ones before designing anything new — the patterns you need have probably been argued through already.
3. **The spec for the area you're working in** — anything under `docs/superpowers/specs/`. Each spec maps to a code area.

Code is descended from these documents, not the other way around. If a change feels in tension with what's written, raise that in the PR before coding around it.

## Branching model

- **`main`** — the trunk, and the branch the staging environment deploys from.
  (`develop` and the `integration/*` branches are historical; do not branch
  from them.)
- **Feature / fix branches** — short-lived, branched from `main`, named by intent:
  - `feat/<short-slug>` for new functionality
  - `fix/<short-slug>` for bug or security fixes (use `fix/sec-*` for items from a security review)
  - `chore/<short-slug>` for hygiene (refactors, scaffolding, dependency bumps)
  - `docs/<short-slug>` for docs-only changes

Don't push directly to `main`: open a pull request from your branch.

## Commit convention

Conventional Commits, scoped to the area touched. **The description and body are written in Spanish** (es-AR) — the type and scope stay as Conventional Commits spells them. The body says *why*, not only what. Common scopes already in use (the development history before this public repository was created lives in a private repository, so this list is the reference, not `git log`):

`auth`, `cases`, `events`, `org`, `admin`, `welfare`, `foster`, `adoption`, `bite`, `db`, `schema`, `triggers`, `tokens`, `notifications`, `forms`, `libreta`, `docs`, `agents`, `superpowers`, `infra`, `seguridad`.

If you need a new scope, check the list above first so we don't accumulate near-duplicates, and add the new one to that list in the same change.

Examples:

```
feat(cases): handshake de transferencia entre organizaciones (#10, parte 1)
fix(seguridad): la contrasena semilla no viaja a un entorno remoto (R8)
chore(db): endurece ON DELETE de las FK e indexa las FK
docs(agents): politica escrita de la frontera publico/privado
```

Don't add `Co-Authored-By` trailers. Don't include AI attribution (no "Generated with…" lines, no AI co-author trailers) in commits or PR descriptions.

## Pre-PR checklist

Run these locally before pushing. Don't outsource this to CI:

```bash
pnpm verify            # one shot: typecheck + every lint:* fence + build
pnpm test:verified     # Vitest, both projects — not `pnpm test`, whose exit code lies when a worker dies mid-file (db project needs db:start)
pnpm test:unit         # parallel no-DB project only (~30s, no Docker needed)
pnpm test:e2e:smoke    # Playwright smoke (public routes + owner lost-mode flow)
```

`pnpm test:e2e:smoke` runs only `e2e/public-smoke.spec.ts` and
`e2e/crisis-owner-lost-flow.spec.ts` (builds + serves on :3333; needs the
local Supabase stack + `pnpm db:bootstrap`, like any e2e run). It is expected
before pushing feature ranges that touch **public or lost-mode surfaces**
(`/p/[token]`, `/encontre`, `/perdidas`, mark-lost, landing). The full suite
also runs nightly against staging (`dim-interno:.github/workflows/e2e-nightly.yml`).

`pnpm verify` is the static gate: tsc + Biome + the full fitness-fence chain (design tokens, UI invariants, authz guards, dep-direction, RLS coverage, file-size/uuid/plural/eyebrow ratchets, jscpd duplication ceiling, and the rest of the `lint:*` scripts in package.json — that list is the source of truth) + `next build`. **`next build` is non-negotiable** — it catches `"use server"` export, `server-only`, and module-level-evaluation errors that `tsc` and Vitest do *not*. Then run `pnpm test:verified`, not `pnpm test`: it runs the same Vitest suite (the `unit` project in parallel with no database; the serial `db` project via the local Supabase stack, `pnpm db:start`) but fails loudly instead of reporting green when a worker dies mid-file.

If a step fails on your branch but passes on `main`, your branch is the source. Fix it before opening the PR.

## Adding a scheduled workflow (nightlies, crons, health probes)

> **A scheduled fence must check out the code it is meant to guard, and a
> workflow that is not on the default branch does not run at all.**

Both halves are properties of GitHub's `schedule:` trigger and both fail
silently, so read them before adding a `cron:` to anything.

**A scheduled job that needs a staging secret does not go here.** Since
2026-09-24 every staging-facing scheduled job (`e2e-nightly`, the synthetic
monitor, `db-doctor-staging`, `authz-audit-staging`) and the panorama QA nightly
are scheduled from the private companion repository
(`dim-interno:.github/workflows/`): they check this repository out and run the
same commands, and their alerts open issues there. This public repository keeps
only scheduled jobs that carry no secret — `codeql.yml`, `mobile-export-nightly.yml`
and the `/api/health` poll in `staging-health.yml`. The rules below apply to
both repositories; `pnpm lint:sched-refs` checks only this one.

1. **`schedule:` is read only from the default branch.** A workflow file that
   lives on a feature or integration branch has no schedule. Not a late
   schedule — none. It sits in `.github/workflows/` looking exactly like a
   fence and has never executed once. The only fix is a merge to `main`;
   nothing you can write in the file changes it. Precedent: a commit titled
   *"el cron nocturno necesita vivir en main"* learned this for db-doctor
   and did not generalise it, so the next two nightlies repeated it. (Commits
   cited in this file predate the public repository; that history lives in a
   private repository, so their SHAs do not resolve here.)
2. **A schedule run checks out the default branch too.** Staging deployed from
   `integration/all-*` at the time, and on 2026-08-27 `main` was **3876 commits** behind
   it. Every nightly was therefore grading three-week-old code against a live
   app. Give each scheduled checkout an explicit
   `ref: <the branch staging ships from>`.
3. **A schedule run also executes the default branch's *copy* of the workflow
   file.** Not just its presence — its content. The `ref:` you add here, the
   alert job you wire, the lint step you put in `ci.yml`: on a timer, none of it
   exists until the branch is merged. `git show origin/main:.github/workflows/e2e-nightly.yml`
   on 2026-08-28 contained zero occurrences of `ref:` and zero of `red-streak`,
   three weeks *after* both were written. `pnpm lint:sched-refs` prints this as a
   named list under its pass line — it warns rather than fails, because nothing
   you can do in your branch clears it, but a green line that stayed quiet about
   it would be the same false safety the rest of this section is about.

What this actually cost, before anyone looked (all four were in this repository
then; three of them live in dim-interno now):

| Workflow | Runs | Green | Cause |
|---|---|---|---|
| `e2e-nightly.yml` | 20 | **0** | Ran `main`'s `loginAs`, which the `/login` → `/iniciar-sesion` 308 broke. Fixed 2026-08-10 (in the pre-public history); the nightly never checked that commit out. |
| `db-doctor-staging.yml` | 12 | **0** | Compared `main`'s `db/migrations/` (stops at 0170) against staging's ledger (0202) and reported the gap as drift. Sections B and C, which query the DB directly, passed in the same run. |
| `mobile-export-nightly.yml` | **0** | — | Not on `main`. |
| `panorama-qa-nightly.yml` | **0** | — | Not on `main`. |

`pnpm lint:sched-refs` (`scripts/check-scheduled-fence-refs.ts`, in `verify` and
in CI) enforces both halves and is the **single place** the deploy branch name is
decided — rename or merge the branch and it fails naming every workflow line to
change. Exemptions live there too, each with the argument that justifies it, and
are checked in both directions so one cannot outlive its reason. `codeql.yml` is
the standing exemption: its SARIF is attributed to the ref that triggered the
run, so a schedule must keep scanning the default branch or it files alerts
against `main` for code not in `main`.

**Also give it an alarm — and this is enforced, not requested.** GitHub's
failed-workflow email fires on the green → red *transition*. A fence whose first
run is already red never transitions, so it never mails anybody — which is how 32
consecutive failures across two workflows went unannounced. Wire the
`.github/actions/red-streak-alert` composite action into any new scheduled gate:
it keys on the consecutive-failure **streak**, opens one issue, keeps it current,
and closes it on recovery. It uses the per-run `GITHUB_TOKEN` and needs no secret
— deliberately, because an absent secret would turn alerting back into a silent
no-op.

`pnpm lint:sched-refs` fails any scheduled workflow with no alert wiring unless
it is in `ALERT_EXEMPT` with the argument for why, checked in both directions
like the ref exemptions. Two standing exemptions: `staging-health.yml` (588 runs,
3 failures — the one fence with enough green history that GitHub's transition
mail genuinely fires, and a `*/15` cron where an alert job would cost ~96 extra
checkouts a day) and `codeql.yml` (also runs on every push to `integration/**`,
so a break is red the same day). Until 2026-08-28 this paragraph was advice and
the test asserted the wiring only for the two workflows that already had it —
enforcement exactly where it was already followed.

**If the job can no-op-skip, say so.** A job whose steps are all skipped by a
guard reports `success`, and the alert action reads a success as recovery: it
would close the open issue with *"Green again"* on the strength of a run that
audited nothing. Publish the guard as a job output and pass it —
`audited: ${{ needs.<job>.outputs.audited }}` — so the action neither opens nor
closes on that run. `db-doctor-staging.yml` (now in dim-interno) is the worked example; the fence
requires it of any workflow that combines an `if: steps.<id>…` guard with the
alert. (The guard has to be a *step*, not a job-level `if:`: `secrets` is not in
the context available to `jobs.<id>.if`.)

## Writing a new event type

Event-sourced state changes (anything that mutates `pet_events`, opens a `case`, or emits a `notification`) are the hot path. Walk through **[docs/event-design-checklist.md](./docs/event-design-checklist.md)** before writing any code — it covers cross-cutting pattern selection, projection target, auto-close cron + idempotency, payload Zod schema with `schemaVersion`, libreta vs non-libreta, dashboard consumers, and the required test surface. If you can't answer one of those questions, the design isn't ready — write the spec first.

## Spec-first culture

**Any change that adds a new event type or modifies the schema requires a spec in `docs/superpowers/specs/` first.** Pattern:

1. Open `docs/superpowers/specs/YYYY-MM-DD-<feature>-design.md` and write the spec.
2. Iterate on it (with maintainers, with Claude Code, with yourself overnight — whatever it takes).
3. Only then open the code PR. The spec link goes in the PR description.

This is not bureaucracy; the patterns in this codebase are dense enough that fresh code without a spec usually misses the cross-cutting concern. Spend the hour writing it down first.

## Getting help

- Questions about running or auditing the code: open an issue (vulnerabilities never — see below). Outside pull requests are not accepted at this time.
- For domain-language questions, search `AGENTS.md` before asking.
- For event-sourcing questions, look at how the closest existing event handles it — see `src/modules/events/actions.ts` (thin actions) and `src/modules/events/application/` (use-cases) for the canonical patterns. This is the one fully-migrated action file; the remaining ~61 files in `app/actions/` are fat actions pending the strangler migration (see [`docs/architecture/hexagonal-lite.md`](./docs/architecture/hexagonal-lite.md#strangler-migration-status--appactions-as-of-2026-06-26)).

## Public repository, private operations

This repository is public so that the code can be audited. Before you add a
document, read **[docs/agents/public-private-boundary.md](./docs/agents/public-private-boundary.md)**:
reviews, handoffs, plans, pilot and outreach material, and deploy/cutover/incident
runbooks belong in the private companion repository, never here. Personal
e-mail addresses, real passwords or keys, and `.env` files with values never
belong here either. `pnpm lint:public-boundary` (part of `pnpm verify`) fails
the gate when they do. If you ever commit a secret, say so in the PR: the fix
is to rotate it, because removing the file does not remove it from history.

## Security issues

Do not open a public issue or PR for a vulnerability. Follow [SECURITY.md](./SECURITY.md).
