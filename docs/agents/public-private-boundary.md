# Policy: what is public, what is private

One page. It applies to every person and every agent that writes a file to this
repository. The fence that enforces it is `pnpm lint:public-boundary`
(`scripts/check-public-boundary.ts`), in `pnpm verify` and in CI.

## Why the code is public

miMAR is meant to be adopted by municipalities and, eventually, federated with
Mi Argentina. An institution asked to trust a pet credential, an append-only
event log and a set of privacy controls must be able to **read how they
work**. The code is therefore public so that it can be audited by the state
bodies that would use it, and by citizens, researchers and contributors. That
is the only reason, and it sets the rule: **what makes the system auditable is
public, and how the project is run internally is not.**

## The two repositories

| | This repository (public) | `dim-interno` (private) |
|---|---|---|
| Holds | Code, schema, migrations, RLS, tests, fences, CI; architecture and design docs; specs and plans the code descends from; agent contracts; user guides; open-data methodology | Deploy and cutover playbooks; incident runbooks and remediation notes; review and audit **results**; working plans, boards and session handoffs; pilot, demo and outreach material; presentations; design handoffs; the historical archive |
| Examples | `docs/architecture/privacy-controls.md`, `docs/superpowers/specs/…`, `docs/ops/local-dev-runbook.md`, `docs/onboarding/guia-funcionario.md` | `dim-interno:docs/ops/cutover-playbook.md`, `dim-interno:docs/handoff/…`, `dim-interno:docs/plans/PENDIENTES.md`, `dim-interno:docs/reviews/…` |

`dim-interno` mostly mirrors this repository's relative paths, with one
exception: specs and plans that left `docs/superpowers/` live under
`docs/superpowers-private/` (so `dim-interno:docs/superpowers-private/specs/…`).
A reference from here to there is written **`dim-interno:<path>`**, with no space
after the colon (for example `dim-interno:docs/ops/cutover-debts.md`). It does
not resolve from this repository, on purpose; it tells a maintainer where to
look.

Scheduled workflows that need a staging secret live there as well
(`dim-interno:.github/workflows/`): they check this repository out and run its
commands, so no workflow in this repository holds a staging secret.

Also never in this repository, whatever the directory: a personal mailbox (use a
role address or `<email>`), a real password or key (use an env-var name or a
placeholder), a pasted `email / password` pair, a `.env` file with values, or
personal data of any real person.

## A published secret is neutralised by ROTATION, not by moving the file

Moving a file to `dim-interno`, or deleting it, removes it from the tree and
**leaves it in history**, which anyone with access can clone. The development
history before this public repository was created lives in a private
repository, and history is not rewritten in either one. So when a credential, a token or a password has ever been committed, the fix
is to rotate it at its source (Supabase, Vercel, GitHub secrets, the account
itself) and then remove it. Moving it without rotating it is not a fix.

## How the fence enforces it

`scripts/check-public-boundary.ts` scans every tracked file and fails on:

1. **An undeclared docs category.** `docs/` is an allowlist:
   `PUBLIC_DOC_CATEGORIES` names each public category with its reason.
   `docs/ops/` is declared file by file, because it is where deploy and cutover
   runbooks would naturally land. A file anywhere else under `docs/` fails with
   "declare it public on purpose … or move it to dim-interno".
2. **A private path shape**: a `reviews/`, `handoff/`, `pilotos/`, `outreach/`
   or `presentation(s)/` directory; a document under a `demo/`, `pilot(s)/`,
   `piloto/`, `critique/` or `backlog/` directory; or a document named
   `cutover-*`, `*incident*`, `*remediation*`, or with `handoff`, `demo`,
   `pilot`/`piloto`, `critique`, `backlog`, `sell`, `pitch` or `venta(s)` as a
   word of its name. The document-scoped shapes apply to documents only
   (Markdown, text, SQL, office/PDF, anything under `docs/`, a non-code file
   under `ops/`), so code such as `bite-incident.ts`, the decomiso `*handoff*`
   modules, `scripts/ops/*.ts` or `e2e/demo/*.spec.ts` is not affected. The
   name shapes skip `db/migrations/`: a migration's name describes its schema
   change, and migrations are immutable.
3. **The maintainer's personal mailbox or the test Gmail**, in any `+alias`
   form or casing. The fence holds only SHA-256 digests of the two normalized
   local parts and hashes every e-mail-shaped token it reads, so neither
   address appears in this repository in any form — not even in the fence.
4. **An e-mail next to a password-looking literal** in docs or config, on the
   same line or as a `password:` line right after the e-mail line. A value
   counts as a placeholder only when the WHOLE value is one (`<x>`, `${X}`,
   `$X`, `%X%`, `changeme`, `your-…`, an env-var name); a password that merely
   contains `$` or `%` is still a password. Secret *shapes* such as keys and
   JWTs are `pnpm lint:secrets`' job.
5. **A tracked `.env*` file with a value** other than a placeholder or a
   loopback local-stack default.

Exceptions live in `EXCEPTIONS`, one kind and one path per entry, each with a
reason. A category or exception that matches nothing fails the run, so the
lists cannot rot into blankets.

## Declaring a new public category

Before adding a new kind of document, ask: *does an outside reader need this
to audit or run the system?* If yes, add an entry to `PUBLIC_DOC_CATEGORIES`
with a one-line reason, add a row to the table in `docs/README.md`, and commit
both together with the document. If not, write it in `dim-interno` and link to
it as `dim-interno:<path>`.
