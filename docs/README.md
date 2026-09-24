# docs/

Project documentation that doesn't belong in the repo root. The single source of
truth for *what we're building today* is [`AGENTS.md`](../AGENTS.md) at the repo root.

| Directory | What it holds |
| --- | --- |
| [`architecture/`](architecture/) | System context, data model, authorization, privacy controls, the conventions canon and the generated facts census. |
| [`adr/`](adr/) | Architecture decision records. |
| [`agents/`](agents/) | Standing contracts for the agents that work on this repo (start at `agents/README.md`). |
| [`superpowers/`](superpowers/) | Design specs and implementation plans (index: `superpowers/README.md`). |
| [`ops/`](ops/) | Engineering runbooks: local dev, migrations, DB bootstrap, advisory allowlist, load probe. |
| [`db/`](db/), [`testing/`](testing/), [`patterns/`](patterns/) | Database, testing and code-pattern notes. |
| [`mobile/`](mobile/) | Mobile build profiles, emulator runbook, OTA policy. |
| [`design/`](design/) | The design canon (`design-canon.md`) and the two-mode design system. |
| [`a11y/`](a11y/) | Accessibility audits. |
| [`datos-abiertos/`](datos-abiertos/) | Open-data publication notes. |
| [`onboarding/`](onboarding/) | Guides for each kind of user. |

## Internal material lives in a private companion repository

This repository is public so the code can be audited. Internal operational
material — deploy and cutover playbooks, incident runbooks, review and audit
reports, plans and handoffs, demo and pilot material, presentations, design
handoffs and the historical archive — lives in a private companion repository,
**dim-interno**, mostly under the same relative paths (for example
`dim-interno:docs/ops/cutover-playbook.md`). One exception: specs and plans that
left `docs/superpowers/` live under `docs/superpowers-private/` there. Staging-facing
scheduled workflows live there too (`dim-interno:.github/workflows/`). References
written as `dim-interno:<path>` (no space after the colon) in code comments and
docs point there; they are not resolvable from this repository by design.

The development history before this public repository was created lives in a
private repository; this repository starts from a single commit. Commit SHAs
and PR numbers cited in these docs and in code comments refer to that earlier
history: they are provenance labels and do not resolve here. Moving
material out never rewrites history anywhere, so a secret that was ever
published is neutralised by rotation, not by moving the file.

The boundary is enforced, not remembered: `pnpm lint:public-boundary`
(`scripts/check-public-boundary.ts`) fails on any file under a `docs/`
category not declared public there, on private path shapes, personal mailboxes
and valued `.env` files. The policy — and how to declare a new public category
(add it to the fence AND to the table above) — is
[`agents/public-private-boundary.md`](agents/public-private-boundary.md).
