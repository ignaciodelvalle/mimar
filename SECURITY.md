# Security Policy

miMAR (internal codename DIM) is a digital pet-credential system for Argentina. It handles personal
data protected by Ley 25.326 and is built on a path toward Mi Argentina
federation, so security is a launch gate, not an afterthought.

**This code is public by design.** The repository is open so that anyone —
citizens, municipalities, auditors, researchers — can inspect how the credential,
the event log and the privacy controls actually work. Publishing the code is not
an invitation to attack the running service; please read "What not to do" below.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security
vulnerability.**

Report it privately through GitHub's private vulnerability reporting:

**<https://github.com/ignaciodelvalle/mimar/security/advisories/new>**

(Or: the repository's **Security** tab → **Report a vulnerability**.)

Please include:

- what the issue is and why it matters (the impact);
- the affected file(s), route(s), table(s) or policy — a commit hash helps;
- steps to reproduce, ideally against a local stack (`docs/ops/local-dev-runbook.md`);
- any suggested fix, if you have one.

## Scope

In scope:

- the code in this repository: the Next.js web app (`app/`, `components/`, `lib/`,
  `src/`), the database schema, migrations and Row Level Security policies
  (`db/`, `supabase/`), the mobile app (`apps/mobile/`), the shared contract
  (`packages/`), scripts and CI workflows;
- authorization and privacy defects: access to another person's pet, custody,
  medical or contact data; DNI handling; leaks through public pages, QR
  verification, exports or aggregates; audit-log bypasses;
- secrets or personal data committed to the repository.

Out of scope:

- findings that require a compromised device, browser or maintainer account;
- denial-of-service or volumetric testing;
- social engineering of maintainers, municipalities, veterinarians or users;
- reports generated only by automated scanners, without a demonstrated impact;
- third-party services (Supabase, Vercel, Expo, GitHub) themselves — report those
  to their vendors.

## What not to do

- **Do not test against any deployed environment** (production, staging or a
  pilot). There are no production users yet, but deployed environments are
  shared, and a pilot may hold real personal data.
  Everything in this repository runs locally (Supabase CLI + Docker);
  reproduce there.
- Do not access, modify, download or delete data that is not yours, and do not
  keep any personal data you come across by accident — stop and report.
- Do not publish or share the details of a vulnerability until it has been fixed
  and you have been told it is safe to disclose.

## What to expect

This is a small project maintained on a **best-effort** basis. We aim to
acknowledge a report within a few days, keep you informed while we investigate,
and credit you in the advisory if you wish. There is no bug bounty.

## Supported versions

Only the latest commit on `main` is supported. There are no back-ported patch
releases.

## Automated scanning

The repository runs, in CI (`.github/workflows/`):

- **CodeQL** (`codeql.yml`) — static analysis over JS/TS.
- **Dependency audit** (`ci.yml` → `dep-audit`) — fails on HIGH/CRITICAL
  advisories; the triage/allowlist process is in `docs/ops/advisory-allowlist.md`.
- **Dependabot** (`.github/dependabot.yml`) — weekly npm and GitHub Actions updates.
- **Secret fence** (`pnpm lint:secrets`) — fails the build on a committed
  credential of any recognised shape.
- **Public/private boundary fence** (`pnpm lint:public-boundary`) — fails the
  build on internal material, personal mailboxes, pasted logins or valued `.env`
  files in the tree (`docs/agents/public-private-boundary.md`).

## Privileged surface and data protection

- The Supabase service-role key bypasses Row Level Security. It lives only in the
  deployment's environment variables (and a git-ignored `.env.local`), is read by
  a single `server-only` module (`lib/supabase/admin.ts`), and is never logged or
  shipped to the client. RLS is a defense-in-depth backstop; the primary
  authorization gate is the server-action / route boundary (`AGENTS.md` →
  Authorization architecture). Privileged operations write an `audit_log` entry.
- DNI numbers are never stored in plaintext: they are peppered hashes
  (`lib/utils/dni-hash.ts`), with only the last four digits kept for display.
- The privacy checklist every change touching a public route, token or PII field
  must follow is in `AGENTS.md` (**Privacidad y manejo de datos**).
