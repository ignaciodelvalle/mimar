# miMAR — Mi Mascota Argentina

[![CI](https://github.com/ignaciodelvalle/mimar/actions/workflows/ci.yml/badge.svg)](https://github.com/ignaciodelvalle/mimar/actions/workflows/ci.yml)

**miMAR** is a digital pet credential and health record for Argentina. Every
pet gets a verifiable identity — a credential with a QR code that confirms the
pet is registered, lets whoever finds it contact the owner, and, with the
owner's consent, shares its vaccination and medical history. The same record
feeds aggregate, privacy-preserving dashboards for the local authorities that
work on animal health and welfare.

> **Codename.** `DIM` is the internal codename. It stays in the code, the
> database schema, the public tokens (`DIM-XXXX-XXXX`) and the audit log;
> **miMAR** is the name users see.

## Who this README is for

Someone arriving from outside: the technical team of a municipality evaluating
the system, an auditor, or a contributor. It tells you what the project is,
where it stands, and where to read next.

## Status

- **Pilot preparation.** The system runs end-to-end on a **staging
  environment** with seeded demonstration data. There is no production
  deployment with real users yet.
- **Not an official government service.** No agreement with any public body
  exists today. The architecture is designed to federate in the future with
  Mi Argentina, the national digital-identity platform; that integration has
  not started.
- Maintained by one person on a best-effort basis (see [SECURITY.md](./SECURITY.md)).

## Why the code is public

The code is public so it can be **audited**: an institution asked to rely on a
pet credential, an append-only event log and a set of privacy controls should
be able to read how they work. Internal operational material (deployment
playbooks, review results, plans, pilot material) lives in a private companion
repository; the boundary is written down in
[`docs/agents/public-private-boundary.md`](./docs/agents/public-private-boundary.md)
and enforced by `pnpm lint:public-boundary`.

## How it works, in four ideas

1. **The pet is the credential.** A globally unique public token resolves to a
   QR-verifiable public page that shows the minimum by default.
2. **Events are append-only.** Every medical or custody fact is an immutable
   event; corrections are new events. Those facts live only in the event log;
   operational caches (current owner, status columns) are written alongside
   it on purpose and checked against it for drift, never the other way round.
3. **Privacy by construction.** DNI numbers are never stored in plaintext
   (peppered hashes, last four digits for display); aggregates are
   k-anonymized, with the exceptions declared in
   [`docs/architecture/privacy-controls.md`](./docs/architecture/privacy-controls.md);
   Row Level Security backs the application-layer authorization.
4. **Four kinds of users.** Owners (and vets through their clinic), organisations
   (shelters, clinics, rescue networks), local-authority operators scoped to
   their jurisdiction, and administrators.

The full design — data model, event catalog, roles, privacy checklist, legal
framework — is in [`AGENTS.md`](./AGENTS.md) (start with its slim index) and
[`docs/architecture/`](./docs/architecture/).

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS |
| Mobile | Expo / React Native (`apps/mobile/`), sharing a typed contract (`packages/contract/`) |
| Data | Postgres on Supabase (Auth, Storage, Row Level Security), Drizzle ORM |
| Quality | Biome, Vitest, Playwright, and <!-- fact:verify_fences -->83<!-- /fact --> repository fences (`pnpm verify`) |
| Hosting (staging) | Vercel + Supabase Cloud |
| Locale | Spanish (es-AR) UI, English code |

## Running it locally

Everything runs on your machine with Docker; you never need access to a
deployed environment. You need Node 22 (the exact range is in
[CONTRIBUTING.md](./CONTRIBUTING.md)), pnpm and Docker Desktop.

```bash
pnpm install
pnpm db:start        # local Supabase (Postgres + Auth + Storage) in Docker
# copy .env.local.example to .env.local and fill it from `pnpm db:status`
pnpm db:bootstrap    # schema, migrations, triggers, RLS, storage, seed accounts
pnpm dev             # http://localhost:3000
```

Details and troubleshooting: [`docs/ops/local-dev-runbook.md`](./docs/ops/local-dev-runbook.md)
and [`docs/ops/db-bootstrap-runbook.md`](./docs/ops/db-bootstrap-runbook.md).
The mobile app: [`docs/mobile/emulator-runbook.md`](./docs/mobile/emulator-runbook.md).

## Repository layout

```
app/              Next.js routes: owner app, /org, /gob, /admin, public pages, API
src/modules/      domain-sliced backend (Hexagonal-lite): domain · application · infrastructure
lib/              shared helpers, bucketed by role (domain, infra, metrics, ui, …)
components/       shared UI
db/               Drizzle schema, forward-only SQL migrations, triggers, storage policies
apps/mobile/      the Expo app
packages/contract the typed contract shared by web and mobile
scripts/          fences (check-*.ts), seeds, local tooling
__tests__/ e2e/   Vitest suites and Playwright specs
docs/             architecture, specs and plans, agent contracts, user guides
```

The backend architecture, with diagrams:
[`docs/architecture/hexagonal-lite.md`](./docs/architecture/hexagonal-lite.md).
Specs and plans the code descends from: [`docs/superpowers/README.md`](./docs/superpowers/README.md).
User guides (Spanish): [`docs/onboarding/`](./docs/onboarding/).

## Contributing, security, license

- **Contributing:** outside pull requests are **not accepted at this time**.
  [CONTRIBUTING.md](./CONTRIBUTING.md) documents how the code is worked on —
  setup, the gate (`pnpm verify` + `pnpm test:verified`), commit convention,
  spec-first rule — for anyone running it locally.
- **Security:** reports are welcome — send them privately as described in
  [SECURITY.md](./SECURITY.md). Never test against a deployed environment.
- **License:** **not** open source; all rights reserved. You may read the code,
  and run and modify it on your own computer to evaluate or audit it, research
  its security or prepare a report. Production use, anything done on behalf of
  a third party, and copying or distributing it require prior written
  permission. See [LICENSE](./LICENSE). The aggregate open data the system
  publishes at `/transparencia` is licensed separately under CC BY 4.0.

miMAR began as a 2021 university project (UTN) and was rebuilt in 2026.
