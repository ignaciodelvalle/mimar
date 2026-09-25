# DIM — AGENTS.md

> Context for AI agents (and humans) working on this project.
> If you're a Claude session reading this for the first time, start here.

## Slim index (always load this, ~1.5k tokens)

Load this section every session. Load deep sections on demand via the anchors in the TOC below.

### What this project is

**DIM / MiMAR** — Argentina's digital pet credential system. Internal codename: **DIM** (stays in code, schema, tokens `DIM-XXXX-XXXX`, audit logs). User-facing brand: **MiMAR (Mi Mascota Argentina)**.

Owner: **Ignacio Del Valle** — non-technical. Claude writes the code; Ignacio drives product decisions and runs commands locally on Windows.

Ultimate trajectory: **Mi Argentina integration** — federation with the Argentine government identity platform. Every architectural decision is filtered through whether it preserves or harms that path.

### Invariants (never break these)

1. **The pet is the credential** — globally-unique `DIM-XXXX-XXXX` public token that resolves to a QR-verifiable public page.
2. **Events are append-only** — every fact about a pet's life is an immutable event. No event is ever edited or deleted. Corrections are new events.
3. **Projections are first-class** — every view (owner timeline, public credential, vet record, govt dashboard) is `(events, filters) → view`. No view is source of truth.
4. **Spanish UI, English code** — variable names, function names, comments in English. User-facing strings in Spanish (es-AR).
5. **No DNI in plaintext** — `profiles.dni_number` was dropped (migration `0106_dni_less_identity.sql`). Use `lib/utils/dni-hash.ts` `hashDni()` for equality, `dniLast4()` for display.
6. **Mi Argentina alignment** — no design decision breaks the federation premise.

### Where things live

| What | Where |
|---|---|
| Domain specs & plans index | `docs/superpowers/README.md` |
| External-agent handoffs + orientation protocol | `dim-interno:docs/design/handoffs/README.md` — auditors/proposers MUST read it; canonical checkout only, never `.claude/worktrees/` |
| Implementation plans | `docs/superpowers/plans/` |
| Event types — the `EVENT_TYPES` const IS the count (<!-- fact:event_types -->55<!-- /fact --> — generated from that const by `pnpm facts:write`, not typed by hand) | `db/schema.ts` |
| Per-event Zod schemas | `lib/events/event-schemas.ts` |
| Libreta sanitaria event filter | `lib/infra/libreta-sanitaria.ts` |
| Metrics / projection primitives | `lib/metrics/` (context, scope, period, anonymity, population, cache) |
| Supabase client helpers | `lib/supabase/` |
| DNI hashing (no plaintext) | `lib/utils/dni-hash.ts` |
| RLS policies (owner tables) | `db/migrations/` (0086 onward); `db/*_rls.sql` are reference-only, never applied |
| RLS coverage test | `__tests__/rls/coverage.test.ts` |
| Scan retention / 90d TTL purge | `lib/infra/scan-retention.ts` |
| Server actions | `app/actions/` |
| Business rules (registry + resolver + console) | `lib/domain/rule-types-registry.ts`, `lib/infra/business-rules-resolver.ts`, `/admin/reglas` |
| Nav presets + AppShell | `components/layout/nav-presets.ts`, `components/layout/AppShell.tsx` |
| Legal framework (AR laws) | `docs/legal-framework-full.md` |
| Privacy checklist (PII gate) | [§ Privacidad y manejo de datos](#privacidad-y-manejo-de-datos) |
| Public/private boundary — what may be committed here vs. `dim-interno` | `docs/agents/public-private-boundary.md` (fenced by `pnpm lint:public-boundary`) |

### The dependency rule

**spec → plan → PR → flip README status.** Code descends from documents, not the other way around. If a change feels in tension with what's written, raise it before coding around it.

### Agent collaboration contract (Cowork ⇄ Claude Code)

Two AI agents work this repo, **never in parallel** (one session at a time). They run in **different environments**, so their git/filesystem state can diverge — a lock or stale tree in one agent's sandbox may not exist in the canonical repo. Serializing sessions does NOT sync them; only a shared source of truth does.

- **Single source of truth.** The canonical repo is the one **Claude Code** operates (Ignacio's local Windows machine). Claude Code owns git (commits, branches, merges, stash) and running tests / verify / build / migration files. If the two agents disagree about repo, test, or build state, **Claude Code's live check wins — after verifying, never by assertion.**
- **Lanes.** *Claude Code* = ground truth: touches files, commits, runs the gate, writes migrations. *Cowork* = thinking: exploration, design, planning, drafting specs/PRDs, research → produces **proposals, not facts**. Cowork must not assert git/test/environment state as settled, and must not "fix" a broken-looking environment from its sandbox — it **flags it as a checkable claim** instead.
- **Handoffs carry evidence, not narrative.** Stamp every handoff with the **branch + HEAD SHA** it was written against. Separate **DONE (with commit SHA)** from **TODO (unverified)**. Back every claim with a SHA, a `file:line`, or pasted command output. Banned: "git is broken", "X is done" with nothing to check. Required: the command and its output. The receiver **verifies every claim against the live repo before acting — trust SHAs, not prose.**
- **Shared Definition of Done.** "Done" = `pnpm verify` + `pnpm test` green (with the actual output as evidence) **and committed**. No "should be fine."
- **Human-gated actions.** Agents produce artifacts; **Ignacio authorizes anything that hits prod or external services, or is hard to reverse**: applying migrations to remote Supabase, deploys, pushing to origin / opening PRs, dashboard/account toggles. Writing a migration *file* is agent work; *applying* it to a remote DB is not.
- **Shared conventions already in force** (see Invariants above): conventional commits, **no `Co-Authored-By` / AI attribution**, Spanish UI / English code, append-only events, forward-only immutable migrations.

### Event-design checklist

Before writing a new event type, walk through `docs/event-design-checklist.md`. It covers: cross-cutting pattern, projection target, auto-close cron + idempotency, Zod schema + `schemaVersion`, libreta vs non-libreta, dashboard consumers, required test surface.

### Deep sections (load on demand)

| Section | Anchor | Load when… |
|---|---|---|
| What this is | [#what-this-is](#what-this-is) | Onboarding / brand rationale |
| North Star | [#north-star](#north-star) | Prioritization / product decisions |
| Project context (CABA data) | [#project-context-why-caba-why-now](#project-context-why-caba-why-now) | Dashboard / population features |
| Core principles | [#core-principles-locked-do-not-relitigate](#core-principles-locked-do-not-relitigate) | Any design decision |
| Stack | [#stack](#stack) | Tooling / dependency questions |
| User roles & account types | [#user-roles--account-types](#user-roles--account-types) | Auth, role, institutional accounts |
| Organizations | [#organizations](#organizations) | Org portal, shelter, clinic, foster |
| Legal framework | [#legal-framework](#legal-framework) | Compliance, SENASA, Ley 25.326 |
| Data model | [#data-model](#data-model) | Schema, new tables, migrations |
| Libreta sanitaria | [#libreta-sanitaria](#libreta-sanitaria) | Medical events, UI surfaces |
| Event catalog — 55 types | [#event-catalog--55-types](#event-catalog--55-types) | New event types, payload design |
| Privacy tiers | [#privacy-tiers-the-public-surface](#privacy-tiers-the-public-surface) | Public credential, Tier 0/1/2 |
| Dashboards & projections | [#dashboards--projections-the-consumers](#dashboards--projections-the-consumers) | Govt / analyst / welfare views |
| Aggregation & privacy policy | [#aggregation--privacy-policy](#aggregation--privacy-policy) | k-anonymity, opt-in, PII rules |
| Authorization architecture | [#authorization-architecture-wave-5-item-26](#authorization-architecture-wave-5-item-26) | Adding new data paths / RLS |
| Scan privacy model | [#scan-privacy-model-wave-5-item-28](#scan-privacy-model-wave-5-item-28) | Scan events, TTL, audit |
| Identity model & DNI handling | [#identity-model--dni-handling-wave-5-item-25a](#identity-model--dni-handling-wave-5-item-25a) | Auth, DNI, Mi Argentina OIDC |
| PII baseline & subject rights | [#pii-baseline--subject-rights-ley-25326](#pii-baseline--subject-rights-ley-25326) | New PII tables, Ley 25.326 |
| SENASA reference vocabularies | [#senasa-reference-vocabularies](#senasa-reference-vocabularies) | Vet events, compliance exports |
| Feature inventory | [#feature-inventory](#feature-inventory) | "Does X exist?" before building |
| Naming (DIM vs MiMAR) | [#naming](#naming) | Copy, brand, code identifiers |
| Design rules (UI conventions) | [#design-rules-ui-conventions](#design-rules-ui-conventions) | Forms, buttons, chrome, a11y |
| Open questions / future work | [#open-questions--future-work](#open-questions--future-work) | What is deferred / out of scope |
| Test-runner conventions | [#test-runner-conventions-item-29--wave-5](#test-runner-conventions-item-29--wave-5) | Test suite setup, pool, teardown |
| **e2e (Playwright)** | `e2e/README.md` (not in this file) | Writing/fixing a browser test; CI's E2E job. Runs against the BUILT app on :3333 with a fresh `db:bootstrap` DB — NOT part of `pnpm verify`; also runs nightly vs staging from the private companion repo (`dim-interno:.github/workflows/e2e-nightly.yml`; every staging-facing scheduled job lives there). |
| **Privacy checklist** | [#privacidad-y-manejo-de-datos](#privacidad-y-manejo-de-datos) | **Any public route, token, or PII field** |
| How Claude should work | [#how-claude-should-work-in-this-repo](#how-claude-should-work-in-this-repo) | Working norms |

> End of slim index. Deep sections follow.

---

## What this is

**DIM — Documento de Identificación para Mascotas.** Argentina's digital pet credential system. A reborn 2021 university project (UTN), reimagined for 2026.

At its core: every pet has a verifiable digital identity — a credential that can be scanned via QR, displayed on a phone, printed on a tag. Owners use a PWA to maintain their pets' records (vaccinations, medications, vet visits, microchips, weight, status). The data model is designed from day one to support expansion to veterinary professionals and government health authorities, and ultimately **integration with Mi Argentina** — which is the core premise of the project, not a nice-to-have.

The user-facing brand is **MiMAR (Mi Mascota Argentina)**. The internal codename is **DIM** — it stays in code, schema, token formats, and audit logs. See the **Naming** section below for the full rationale.

The owner of the project is **Ignacio Del Valle**, part of the original 2021 team. Ignacio is **non-technical** — Claude writes the code, Ignacio drives product decisions and runs commands locally on Windows.

## North Star

The ultimate purpose of DIM is **animal health and welfare at population scale**: vaccinations reach pets who need them, treatments reach pets who need them, lost pets find their owners, and welfare problems become legible to authorities and NGOs who can act on them.

The pet owner PWA is the **data-collection layer** — it is and must be valuable on its own to drive adoption (no one will install a "feed the government data" app, but they will install a real digital libreta sanitaria). The architectural payoff sits at the population level: **high-level dashboards for sanitary authorities, public-health analysts, and animal-welfare officers**, derived from the same event log that powers individual pet records.

This North Star reframes some design choices and locks in others. Every event a pet owner records is potentially a public-health signal. Every screen — owner timeline, public credential, government dashboard, vet record — is a projection over the same source-of-truth event log.

The ultimate trajectory is **integration with Mi Argentina**. This is not a nice-to-have — it is the premise. A standalone pet-credential PWA has limited reach; a federated layer that Mi Argentina can issue and verify is what changes the system at population scale. Every architectural decision in this codebase is filtered through whether it preserves or harms that path. See **Naming** below for more on the brand rationale.

## Project context (why CABA, why now)

DIM is rooted in concrete data about the city it was designed for. Figures below come from the CABA *Encuesta Anual de Hogares 2018* (EAH) and the 2021 CONAIISI paper authored by the original team. They both ground the North Star and become the baseline DIM should eventually measure itself against.

**Population (CABA, EAH 2018):** ~475,000 dogs and ~295,000 cats in households — roughly 16 dogs and 10 cats per 100 people. **Adoption / rescue is the growing acquisition modality**; intentional purchase is shrinking. Implication: `pet_registered` payloads will eventually want an `acquisition_method` field for adoption-trend tracking.

**Vaccination gaps:** ~15% of dogs received no vaccine in the prior 12 months. ~6% of cats lacked the antirábica, ~15% lacked the triple felina. Cat vaccination *deteriorated* between surveys — 36.6% of cats unvaccinated in 2018. Implication: campaign targeting needs species-level segmentation, not just regional.

**Veterinary access by zone — validates the jurisdiction columns on `pets`:** dogs un-attended in the prior year: 22.7% in Zona Sur, 15.5% Centro, 9.7% Norte. That 13-point gap is exactly the inequity the sanitary-authority dashboard exists to surface.

**Civic awareness:** 89% of households do not help street animals. The dominant channel for government pet-health information is social media (38% in 2018, up from 17% in 2014). Implication: notifications and shareability are first-order, not optional polish.

**Mascotas CABA** — the GCBA program offering free veterinary attention — operates today but is **not digitalized**. There's no central record of who was attended, with what, where, or when. DIM is the missing data layer this program needs more than it is a competitor to it; integration is a long-term ambition, not a confrontation.

## Core principles (locked, do not relitigate)

1. **The pet is the credential.** Not "data in an app" — an identity document for an animal with a globally-unique public token that resolves to a QR-verifiable public page.
2. **Events are the spine.** Every fact about a pet's life is an immutable, append-only event. Corrections are new events that reference earlier ones. No event is ever edited or deleted.
3. **Designed for expansion.** The data model includes columns and roles for veterinary and government actors from day one. Pet owner UI ships first; other actors are activated later with no schema rewrite.
4. **Start tight, loosen later.** The public credential page exposes the minimum necessary by default; richer reveals are gated by status (lost), explicit owner action (shared link), or verified identity (future).
5. **Build it properly, bit by bit.** No throwaway prototypes. Every milestone is usable. Foundation pays off.
6. **Public code, private operations.** The code repository is public so it can be audited (PO decision 2026-09-18, superseding the 2026-07-15 private-repo decision); it stays publishable at every commit (no secrets, no plaintext PII — `lint:secrets`; nothing internal — `lint:public-boundary`, policy in `docs/agents/public-private-boundary.md`). Internal operational material (deploy/cutover playbooks, incident runbooks, reviews, plans, handoffs, demo and pilot material) lives in the private companion repository **dim-interno**, mostly under the same relative paths (specs and plans that left `docs/superpowers/` sit under `docs/superpowers-private/`; staging-facing scheduled workflows under `.github/workflows/`); references written `dim-interno:<path>`, with no space after the colon, point there. The development history before this public repository was created lives in a private repository (it is not in this one); moving a file never rewrites history, so a secret that was ever published is neutralised by rotation, not by a move. Vulnerability reports go through `SECURITY.md`. Public transparency is also delivered through open data and methodology at `/transparencia` (CC-BY 4.0).
7. **Event-sourced facts, honest hybrid runtime.** Medical and custody lifecycle facts live only in the append-only event spine; owner timeline, public credential, vet record and government dashboards derive from it. The RUNTIME is deliberately hybrid (PO 2026-07-24, honest-hybrid rewording): operational caches (`pets.*` status columns, ownerships) are dual-written for hot reads, government aggregates read denormalized columns (Pattern B, D7 — owned lag), and drift is made observable (`rederivePetCache`, CI + detect-only cron) rather than pretended away. No cache ever outranks the spine. New dashboards = new queries, not new schemas — but say which layer they read.
8. **Designed for the population, not just the pet.** Every event a pet owner records is potentially a public-health signal. Aggregation is a first-class architectural concern, with privacy preserved by k-anonymity and opt-in for granular contribution.

## Stack

| Layer            | Choice                              |
| ---------------- | ----------------------------------- |
| Frontend         | Next.js 15 (App Router) + React 19  |
| Language         | TypeScript                          |
| Styling          | Tailwind CSS + shadcn/ui            |
| Auth             | Supabase Auth                       |
| Database         | Postgres (via Supabase) + RLS       |
| ORM              | Drizzle                             |
| File storage     | Supabase Storage                    |
| Maps             | MapLibre + OpenStreetMap            |
| Tests            | Vitest (unit + db) · Playwright e2e (`e2e/`, see `e2e/README.md`) |
| Lint/format      | Biome                               |
| Package manager  | pnpm                                |
| Local dev        | Supabase CLI (Docker)               |
| Deploy           | Vercel + Supabase Cloud (when ready)|
| Repo             | GitHub, private, proprietary (open-by-design discipline) |
| Locale           | Spanish (es-AR)                     |

## Form factor

- **v1**: Progressive Web App (installs to home screen on iOS/Android)
- **Audience**: Pet owners only. Vet and government interfaces deferred.
- **Auth**: email/password. "Connect with Mi Argentina" placeholder button shown but non-functional.

## User roles & account types

DIM has **two account types** — `personal` and `institutional` — stored as `profiles.account_type`. Each account type allows a specific set of `profiles.role` (enum `user_role`) values. One user = one account type and one role.

| Account type      | Roles allowed     | Mi Argentina / DNI | Matrícula        | Pets                | Created via                              |
| ----------------- | ----------------- | ------------------ | ---------------- | ------------------- | ---------------------------------------- |
| `personal`        | `owner`, `vet`    | Yes                | Yes (vet only)   | Yes (any count)     | Self-serve signup                        |
| `institutional`   | `govt`, `admin`, `national` | No (NULL)   | No (NULL)        | **No (DB-enforced)**| Direct admin action only — no self-serve (`national`: seed script only today) |

**Why two account types.** Personal and institutional accounts serve fundamentally different purposes. A *personal* account is a human with pets and (eventually) Mi Argentina identity — owns animals, gets a libreta sanitaria, may upgrade to vet to write authoritative health events. An *institutional* account is a service-account for governance work: approving requests, verifying organizations, managing scope assignments. No mascotas, no DNI, no matrícula — none of those concepts apply to an authority entity. Modeling them as one type-of-user (e.g., promoting an owner to admin) would force every `Ownership` query, every signup screen, every Mi Argentina integration to special-case institutional users. Separating them keeps each path narrow and the constraints honest. Operationally: institutional accounts are managed from a desktop browser at `/admin`; the mobile PWA workflows are for personal users only.

### The five roles

| Role    | Account type    | Who                                                                                                                              | Primary portal           | Notes                                                                                                                                |
| ------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `national` | institutional | Read-only national analyst (ministry / SENASA desk). Country-wide READ scope on `/gob`; writes nothing.                          | `/gob`                   | Migration 0214. No `govt_assignments` — universality is decided by ROLE (`hasNationalReadScope`, `lib/domain/jurisdiction-canonical.ts`), never by an empty list. Admitted by `requireGobReadAccessOrRedirect` + the read-only API gates; refused by `requireAdminOrGovtOrRedirect` (every mutating action), by `requireDecomisoPrincipal`, and by `/admin`. Also refused on the record-level PII surfaces (Directorio registers, pet full profile, approval-request detail, omnibox) and on exports — its surface is the aggregate dashboards and queues. Created by `scripts/seed-test-users.ts` only (no admin UI writer yet). |
| `owner` | personal        | Pet owner. Default for any self-serve signup.                                                                                    | `/mis-mascotas`          | Can have unlimited pets. May apply to upgrade to `vet`.                                                                              |
| `vet`   | personal        | Veterinarian or animal-health professional. Has personal matrícula.                                                              | `/org/[orgToken]` (admin/coordinator of a clinic, **or** exactly one non-admin membership — single-membership shortcut, `6bba0af2`) **OR** `/cuenta/memberships` (2+ memberships — pick one) **OR** `/cuenta` (no memberships yet — see onboarding banner) | May still own pets like any owner. Upgrade via `/cuenta/upgrade`, approved by the `govt` of the declared locality (fallback: admin). Vets without a clinic org land on `/cuenta` with a CTA to create one via `/cuenta/crear-consultorio`. |
| `govt`  | institutional   | Government / public-health / animal-welfare authority. Approves orgs, vet upgrades, and scheduling within **assigned localities**. | `/gob`              | Multi-locality via `govt_assignments`. Created by an existing admin. Service-account model — see "Single operator" below.            |
| `admin` | institutional   | Technical-administrative user. Universal scope. Creates other institutional accounts. Approves anything outside any govt's scope. | `/admin`                 | Bootstrap admin seeded manually once via Studio; subsequent admins created by an existing admin. Cannot be self-deactivated.         |

### Lifecycle and downgrade paths

**Personal accounts** are created via self-serve signup as `role='owner'`. Vet upgrades go through the admin-page approval flow:

- *owner → vet*: applicant submits matrícula + evidence via `/cuenta/upgrade`. Creates `approval_request` of `type='role_upgrade_vet'`. Approved by the `govt` of the declared locality (fallback: admin if no govt covers that locality). On approval: `role='vet'`, `matriculaVerified=true`. **Prerequisite**: `profiles.dni_verified=true` — see [`docs/patterns/petition-prerequisites.md`](docs/patterns/petition-prerequisites.md).
- *vet → owner via self-resignation*: vet uses `/cuenta/renunciar`, confirms consequences. `role='owner'`, `matriculaVerified=false`. The `matriculaNumber` itself stays as historical data. Logged in `audit_log`.
- *vet → owner via revocation*: the govt of the relevant locality, or admin, executes the revocation flow with mandatory reason + evidence. Same end state. Logged.
- *delete account*: standard account deletion path (no admin-specific flow).

**Institutional accounts** are created exclusively by an existing admin via the admin page. The admin provides email + display name + role (govt or admin) + (for govt) the initial set of localities. System provisions an `auth.users` entry with a temporary credential (magic link or temp password). No `approval_request` involved — direct admin action, logged. **There is no path from `personal` to `institutional`.** If a person needs both an owner identity (for their pets) and an admin or govt identity (for their work), they hold two separate accounts with two separate emails.

- *govt locality adjustment*: admin assigns or revokes localities directly via the admin page. Each change is one direct action.
- *govt deactivation*: the operator may self-deactivate the account, but ONLY if every locality assigned to this govt is also covered by at least one other active govt. If any locality would be left uncovered, the action is blocked with a clear error naming the uncovered localities. On successful deactivation, pending `approval_requests` for those localities automatically fall to the admin queue (the scope-matching `NOT EXISTS` clause handles this — no manual migration). An admin can also deactivate a govt directly via the revocation flow.
- *admin deactivation*: the operator may **NEVER** self-deactivate. An admin is deactivated only by ANOTHER admin, with mandatory reason + evidence, AND never when only one active admin remains. The system always retains at least one active admin.
- *operator handoff*: when the human behind an institutional account changes (one employee leaves, another takes over), an admin resets the credentials. The account itself, its localities, its audit history persist. The operator rotates; the institutional identity does not.

### Portal access: capability-driven

A user's access to a portal is determined by whether they have at least one capability that's exercised in that portal:

- **`/mis-mascotas`** — every authenticated personal account (owner or vet). No additional capability needed; the portal lists the user's own pets.
- **`/org/[orgToken]`** — users with an active `organization_memberships` row for that specific org and at least one org-level capability (e.g., `intake.create`, `appointment.manage`, `service_offering.create`). Vets create their clinic via `/cuenta/crear-consultorio`.
- **`/gob`** — `role='govt'` users with at least one active `govt_assignments` row; `role='admin'` (universal); and `role='national'` (universal READ, no writes — the layout and read pages gate on `requireGobReadAccessOrRedirect`, every mutating action on `requireAdminOrGovtOrRedirect`, which refuses it).
- **`/admin`** — `role='admin'` users with `account_type='institutional'` and `deactivated_at IS NULL`.

Capabilities are layered: org-level (per-membership) and role-level (per-role, e.g., govt's `approve.org_verification`, admin's `account.create_institutional`). The portal layout asserts the right layer for entry; specific actions inside the portal assert finer-grained capabilities.

The `/pro` portal was removed in Sprint 1A Phase B. All vet service workflows now live exclusively under `/org/[orgToken]` (the vet's clinic org). A vet without a clinic org lands on `/cuenta` with an onboarding banner linking to `/cuenta/crear-consultorio`.

### Naming convention: `refugio` vs `org`

Internal identifiers, routes for the authenticated admin portal, DB column names, and English-language doc references are `org` — generic across all `org_type` values (`shelter`, `clinic`, `rescue_network`, `sanitary_authority`). The admin portal lives at `/org/[orgToken]`. There is no `app/refugio/` folder; the historical singular route was renamed end-to-end.

`Refugio` (singular and plural) survives in exactly three places, all deliberate:

1. **User-facing copy** in `es-AR` referring to the `shelter` org-type ("Refugio", "refugios verificados"). This is the correct Argentine Spanish noun for animal shelters and shouldn't be translated away.
2. **The public shelter-profile route** `/refugios/[orgToken]` (plural). It renders only verified `shelter | rescue_network` orgs and 404s for clinics / authorities — the URL is a public handle specifically for shelters and naming it `/refugios` matches user expectation. It is conceptually distinct from `/org/[orgToken]` (anonymous browse vs. authenticated portal).
3. **Schema comments in `db/schema.ts`** that use "refugios" as the plural domain noun ("used by refugios", "refugio coordinator"). These describe what the data represents in the real world; they aren't identifier drift.

If you find a `refugio` reference outside these three categories — a route, a column, a function name, an English doc — that's drift; rename it to `org`.

### Business rules ownership (SHIPPED — admin rules console)

Configurable business rules are live. They live in `govt_business_rules` (migration `0116_promote_business_rules.sql`) behind a declarative type registry (`GOVT_BUSINESS_RULE_TYPES` + `lib/domain/rule-types-registry.ts`), with per-type Zod validators in `lib/infra/business-rules-validators.ts`. Writes go through `app/actions/business-rules.ts` (audit-logged). The admin console is at `/admin/reglas`.

Ownership follows the layered model as designed:

- **Corrected 2026-09-18**: the line below used to say govt can configure rules within their assigned jurisdictions. That is false — writers are **admin-only**: `app/actions/business-rules.ts` gates every writer (lines ~106, 147, 182) behind `requireAdminOrRedirect`, never `requireAdminOrGovtOrRedirect`. `/gob/reglas` is read-only for govt; the page's own copy says so ("La administracion de reglas la hace el admin nacional", `app/gob/reglas/page.tsx:116`).
- **Admin** configures rules universally (Argentina-wide defaults) or in any specific jurisdiction. Admin is the only writer.
- **Govt** reads rules within their assigned jurisdictions on `/gob/reglas`; they cannot write.

When multiple rules conflict, **more specific wins**: locality > province > country > hardcoded default, resolved by `resolveBusinessRule` in `lib/infra/business-rules-resolver.ts`. A Belgrano rule overrides a CABA rule overrides an Argentina rule overrides the code default.

**In flight — rules-engine v2 (SDD change `jurisdiction-compliance`):** extends the same table and registry (never a parallel system) with legal obligation types (`rabies_vaccination`, `sterilization`, `microchip_identification`), `requirement_level` tiers + legal metadata columns (migration number TBD — 0118 is already taken by `event_amended_target_idx`; recount the next free integer at write time per the Definition of Done, never hardcode one from a plan), a versioned national legal-baseline dataset with PO sign-off gate, and jurisdiction-aware compliance metrics and nudges. Artifacts in engram under `sdd/jurisdiction-compliance/*`.

### Hard constraints

These are the invariants the schema and application writers enforce together.

1. **Account type ↔ role match.** `profiles.account_type='personal'` ⟹ `role ∈ {owner, vet}`. `profiles.account_type='institutional'` ⟹ `role ∈ {govt, admin, national}`. **Enforced in the application layer** by every writer that sets these columns (`createInstitutionalAccountForAuthority`, approval mutation handlers, the `handle_new_user` trigger). A DB-level CHECK constraint (`profiles_account_type_role_match`) was added in migration 0015 but **dropped in migration 0016** (`db/migrations/0016_drop_role_match_check.sql`) because Drizzle + postgres-js fires the constraint on the intermediate row state during a two-column UPDATE in the same statement, breaking the test suite. The invariant is intentionally enforced at the app layer only — do NOT add the CHECK back without resolving that Drizzle behavior.
2. **Institutional accounts have no personal-identity fields.** When `account_type='institutional'`, `dni_hash IS NULL`, `miarg_sub IS NULL`, `matricula_number IS NULL`, `matricula_jurisdiccion IS NULL` — **sólo estas cuatro columnas de texto** están en el CHECK (`db/schema.ts:517-520`); los booleanos `dni_verified`/`matricula_verified` y `dni_last4` quedaron FUERA a propósito (migración 0015) y son enforcement de aplicación. CHECK constraint (`profiles_institutional_no_pii`). Note: `dni_number` was dropped in migration 0106 (Wave 5 Item 25a).
3. **Institutional accounts cannot own pets.** A trigger on `ownerships` rejects any INSERT or UPDATE that would tie an institutional account to a pet via `owner_user_id`. The trigger uses `errcode='restrict_violation'` (`db/migrations/0015_admin_page_closure.sql:54-83`). El mensaje está en inglés, no en español.
4. **Last admin cannot be deactivated.** Server-action precondition counts `account_type='institutional' AND role='admin' AND deactivated_at IS NULL` and refuses if the deactivation would leave fewer than one.
5. **Govt cannot self-deactivate if any locality is uncovered.** Server-action precondition checks coverage for every `govt_assignment` of the deactivating user.
6. **`national` writes nothing, and the fence makes that structural.** The read gate (`requireGobReadAccessOrRedirect`) is deliberately absent from `scripts/check-authz-guards.ts`'s `AUTH_GUARDS` (it is listed only under `INSTITUTIONAL_GUARDS` for pages), so any `"use server"` export or `route.ts` handler that adopted it would be flagged as unguarded by `lint:authz`. Writers keep gating on `requireAdminOrGovtOrRedirect` (admin | govt), which refuses `national` at one function. Read-scope universality is decided ONLY through `hasNationalReadScope(role)` — a `role === "admin"` literal on the read path is a bug, a `role === "admin"` literal on a write/capability path is correct. Pinned by `__tests__/auth-guards.test.ts` and `__tests__/national-role-read-only.test.ts`.

### Single-operator model (v1)

Each institutional account has one set of credentials — one human operator at a time. The audit log shows the institutional account as the `actor_user_id`, not the person behind it. A future extension may add membership-style multi-operator access (mapping personal users to institutional account memberships, similar to `organization_memberships`), at which point audit entries will capture both the institutional account and the personal user. Until then: one operator, one credential, the institutional account is the accountable identity. Operator handoffs go through admin-issued credential resets.

### Role vs. event authorship

The `profiles.role` answers *"who is this user globally?"* The `pet_events.author_role` answers *"in what capacity did this user act when writing this specific event?"* They usually align (vet logs a vaccination → both `vet`) but not always (vet logs their own dog's weight while acting as owner → `profiles.role='vet'` but the event's `author_role='owner'`). Keeping these separate is what lets audit trails be honest.

Institutional accounts do not author `pet_events` in normal operation — they manage system state, not pet history. The `author_role='govt'` value is reserved for future workflows where a sanitary authority records an event during an inspection or campaign (likely via a personal vet acting under govt auspices, recorded with the institutional `author_organization_id`).

### Bootstrap

**Corrected 2026-09-18 — the old recipe here `insert`ed into `profiles` directly, which collides
with the `on_auth_user_created` trigger** (`db/triggers.sql:88-92`, wired to `handle_new_user()`,
created by migration `0134`): every `auth.users` insert already creates a `profiles` row via that
trigger, so a second manual `insert` on the same id is either a duplicate-key error or the wrong
instrument. The correct recipe, from `dim-interno:docs/ops/production-deploy-plan.md` §1.9 ("First admin
account (W6)"):

1. Have the operator sign up through the **normal** `/signup` flow, with their real email. This
   fires `handle_new_user` like every other signup and creates a `profiles` row with
   `role='owner'`, `account_type='personal'`.
2. In the Supabase Studio SQL editor (service-role context), promote that one profile:
   ```sql
   update profiles
   set role = 'admin', account_type = 'institutional', updated_at = now()
   where id = '<the new user''s auth.users.id>';
   ```
3. Do **not** repeat this manual SQL step for additional `admin`/`govt` accounts. Once one admin
   exists, use the in-app institutional-account flow
   (`createInstitutionalAccountForAuthority`, `app/actions/admin-institutional.ts`, gated by
   `requireAdminOrRedirect`) through the UI. The manual SQL flip is a one-time bootstrap.

From there, every institutional account is created via the admin page. Every personal account is created via self-serve signup. Both flows go through `auth.users` like any other Supabase auth path.

### Implementation reference

See [`docs/superpowers/specs/archive/2026-05-17-admin-page-design.md`](docs/superpowers/specs/archive/2026-05-17-admin-page-design.md) for the full spec — schema migrations, server actions, RLS policies, UI surfaces, capability matrix, and the approval / revocation / self-resignation flows in detail. The phased implementation plan lives there too.

**Organizations are not roles on `profiles`.** Clinics, refugios, rescue networks, and (eventually) sanitary authorities live in a separate `organizations` table peer to `users`. People connect to organizations through `organization_memberships`. This resolves the historical vet-vs-clinic ambiguity in one move (the individual vet keeps `profiles.role='vet'`; the clinic is an `organizations` row of type `clinic`; a membership row links them), and is the same mechanism that makes refugios and Mascotas CABA first-class without growing the `profiles.role` enum. See the **Organizations** section below for the full design.

## Organizations

Organizations (clinics, refugios, rescue networks, sanitary authorities) are first-class actors in DIM, modeled as a peer table to `users`. People and organizations both own pets, author events, and run campaigns. The connecting layer is `organization_memberships`.

| Concept | Lives on |
|---|---|
| Who a user is *globally* | `profiles.role` (owner / vet / govt) |
| Which orgs a user *belongs to* | `organization_memberships` rows |
| What kind of org something is | `organizations.org_type` (clinic / shelter / rescue_network / sanitary_authority / other) |
| Capacity in a specific event | `pet_events.author_role` and `pet_events.author_organization_id` |
| Custody of a specific pet | `Ownership` row, polymorphic between user and org |

**Why peer to users, not a subclass.** Both users and organizations own pets, author events, and run campaigns. Peer modeling lets `Ownership` and `PetEvent` carry both `*_user_id` and `*_organization_id` columns with a CHECK constraint, and dashboards filter by `org_type` cleanly. Subclassing forced fake "is_organization" flags through every read.

**Why this also resolves the vet vs. clinic question.** Individual veterinarians hold `profiles.role='vet'` (matrícula attaches to the person). The clinic is an `organizations` row of type `clinic`. A `vet_individual` membership row links them. The same vet can move between clinics without losing identity; the clinic survives staff turnover; campaigns belong to the clinic, not the vet.

**Verification — same trust ladder as user roles.** Anyone can register an organization. Status is `verified=false` until an admin reviews documents (personería jurídica for refugios, matrícula for clinics, CUIT cross-check). Unverified orgs can use the system but their events write with `author_verified=false`, their branding does not appear on public credentials, and they are excluded from broadcast-target queries.

**Shelter custody is temporary by definition.** Refugios do not become "owners" in the legal sense — they hold custody pending adoption. `Ownership.role='shelter_custody'` is the role for this, and it applies equally to:

- a refugio that rescued an animal (`owner_organization_id` set)
- a pet owner who picked up a stray on their street and is housing it while searching for the owner or a refugio (`owner_user_id` set, no org link)

The vecino-helps-stray case is explicit and intentional. An existing DIM owner can register a found animal and have it appear in their pet list with a "tránsito" badge, with no requirement to be a member of any organization. The same `shelter_custody` row transfers cleanly to a refugio or to a permanent adopter when the time comes.

**Foster is distinct from shelter_custody.** `Ownership.role='foster'` means a person physically houses an animal under an organization's institutional umbrella — the org's `shelter_custody` row stays active alongside the foster's row. A foster requires an active `organization_membership` linking them to the umbrella org. A vecino without org backing uses `shelter_custody` directly.

**Custody transfers always emit an event.** Refugio-to-refugio handoffs, citizen-to-refugio handoffs, decomiso intakes, adoption finalizations — every atomic transaction that ends prior `Ownership` rows and starts new ones emits a `custody_transferred` or `adoption_finalized` event. The event is source of truth; the `Ownership` table is the projection. The vecino who hands a stray to El Campito does not lose the record — it lives as a `custody_transferred` event with their `user_id` in the `from_user_id` field.

**Coverage zones drive the lost-pet broadcast.** Each organization declares its coverage zones in `organization_coverage` rows (often barrio-level). When a pet's status changes to `lost`, the broadcast query targets verified refugios and rescue networks whose coverage includes the lost-pet location, and through their `organization_memberships`, reaches voluntario networks who actually walk the streets. This is the Argentine-shaped version of the PawBoost broadcast model — a contextual rescue network, not random subscribers.

**Post-adoption follow-up is enforced through notifications, not credential shaming.** Missed check-ins generate notifications to both adopter and refugio. The public credential does not degrade visually. The refugio retains read access during the followup window declared on the `adoption_finalized` event.

**Bulk operations shipped for high-capacity refugios.** Refugios with 200+ animals (El Campito, Patitas Vagabundas, Proyecto 4 Patas) get multi-select bulk actions at `/org/[orgToken]/mascotas` — vaccination logging, adoption-eligibility, publish/unpublish listing (Sprint 8, #399-401).

## Legal framework

DIM must be designed around — not against — the Argentine legal landscape for animal health and welfare. Four laws bear directly on what the app supports:

| Law                              | Scope                                                                                  | What it implies for DIM                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Ley CABA 4078 (2012)**         | Registro de perros potencialmente peligrosos (dangerous-breed registry, CABA owners). | A `potentially_dangerous_breed` flag on `pets` plus an attestation event for owner registration. **Now a *measured* compliance metric (C7), not just a data field**: `fetchDangerousBreedCompliance` reports attested / flagged by jurisdiction (graceful 0% until the attestation form ships). |
| **Ley Provincial 14.107 (2010)** | Provincial dangerous-breed registry (PBA). Art. 8 inc. b requires identifying a **PPP** dog "por medio de un chip **o de un tatuaje**" — it does NOT mandate a microchip, and does not reach the general padrón. | Province-level aggregation matters; our `jurisdiction_province` covers this. Feeds the PPP registry-compliance metric (C7) together with Ley CABA 4078. **NOT the legal basis of microchip penetration** — see the microchip row below (corrected 2026-08-17; the old wording asserted a chip mandate this statute does not contain). |
| **Microchip — NO Argentine mandate** | Ley 14.107 admits chip **or** tattoo and only for PPP; Ley CABA 4.078 art. 6 requires a collar with chapa and never mentions a chip; **SENASA** states no national electronic-identification regulation exists. A CABA bill (2022) and a Santa Fe half-sanction (2025) are not law. | Microchip penetration (C1) + ISO-validity (C2) measure **adoption**, not legal compliance: their target is a programmatic benchmark with no `Obligación:` clause (`lib/metrics/kpi-catalog.ts`), and `microchip_penetration` deliberately has **no entry** in `lib/metrics/metric-legal-basis.ts`. The business-rules default for `microchip_required` is `not_regulated`. Do not re-add a citation without a sourceable norm. |
| **Ley CABA 5470 (2015)**         | Cremation process for canines and felines in CABA.                                     | `death_recorded` event payload carries a `disposition_method` field (`cremation_collective \| cremation_individual_ashes \| authorized_cemetery \| owner_burial \| household_waste \| rendering \| unknown`) for traceability. Normalized by `lib/domain/disposition.ts`; projected by `lib/analytics/mortality-metrics.ts`. |
| **Ley Nacional 14.346 (1954)**   | Malos tratos / actos de crueldad contra animales.                                      | `maltreatment_reported` events need to eventually feed real complaint pipelines (denuncia integration is downstream of UI).          |
| **Ley Nacional 25.326 (2000)**   | Protección de Datos Personales. Arts. 4° (purpose), 14 (acceso), 16 (supresión).       | `purpose data_purpose` + `deleted_at` baseline on every PII table; export/erase RPCs (compliance PR 1) live at `/cuenta/privacidad`. |
| **Ley Nacional 26.653 (2010)**   | Accesibilidad de la Información en las Páginas Web (WCAG 2.1 AA via Disp. ONTI 6/2019). | Focus ring tokens + biome a11y rules at error level + `docs/a11y/contrast-audit.md` (compliance PR 2).                              |
| **Res. SENASA 580/2014**         | Formulario antirrábico para traslado interno (canino).                                | `pet_events.tipo_evento_code` con vocabulario en `ref.tipo_evento_sanitario` (compliance PR 3). Cuando SENASA homologue LSUCyF el export es directo. |
| **Res. SENASA 80/2025**          | Receta Electrónica Veterinaria.                                                       | `tipo_evento_code='prescripcion_electronica'`. Detalles (`principio_activo`, `posologia`) en sprint REV dedicado.                  |
| **Res. SENASA 284/2024**         | Estándar de identificación electrónica animal (ISO 11784/11785).                       | `pet_identifications` polimórfica con ISO subfields decompuestos (`iso_country_code/manufacturer_code/national_id`) — compliance PR 0. |
| **LSUCyF (SENASA, 2022)**        | Libreta Sanitaria Única Canina y Felina (papel).                                       | El digital alinea por `tipo_evento_code` para que el export sea 1:1 con el formulario papel.                                       |
| **Ord. CABA 41.831 (1987)**      | Tenencia, vacunación, identificación de canes en CABA.                                | Art. 4° (tatuaje) cubierto por `pet_identifications kind='tattoo'`. Art. 9° (observación antirrábica 10 días) por `tipo_evento_code='observacion_antirrabica'`. |

None of these are blockers for v1. The data model accepts them without rework; the table is the checklist when wiring owner-facing forms.

## Data model

### `User` (`profiles`)
- `id` (uuid, pk), `email` (unique), `display_name`, `phone?`, `avatar_url?`
- `account_type` (personal | institutional, CHECK-enforced), `role`
- `dni_hash?`, `dni_last4?`, `dni_verified` (bool, default false) — Mi Argentina-ready.
  There is **no `dni_number` column**: migration 0106 dropped it (invariant #5 — no DNI
  in plaintext). Hash with `lib/utils/dni-hash.ts`.
- `created_at`, `updated_at`

> The authoritative shape of every entity below is `db/schema.ts`. These sketches carry
> the INVARIANTS and the reasoning; when a field list disagrees with the schema, the
> schema wins — and the sketch is the bug.

### `Organization` — peer to user; clinic / shelter / rescue network / sanitary authority
- `id` (uuid, pk)
- `public_token` (unique) — short URL-safe code (e.g. `ORG-XK3P-9D2L`), used in public-profile QR
- `legal_name` — full legal/registered name
- `display_name` — short name shown in UI
- `org_type` (enum: `clinic | shelter | rescue_network | sanitary_authority | other`) — kept open like `event_type`; new types are one-line edits
- `cuit?` (unique when present) — Argentine tax ID, credibility booster
- `personeria_juridica_number?` — required for refugio verification; optional for clinics
- `email`, `phone?`, `website?`, `avatar_url?` (logo)
- `verified` (bool, default false) — admin-stamped after document review (same trust ladder as user role verification)
- `verified_at?`, `verified_by_user_id?`
- `tier_0_show_branding` (bool, default false) — opt-in to appear on public credentials of pets in this org's custody / recent followup window
- `jurisdiction_country` (default `'AR'`), `jurisdiction_province?`, `jurisdiction_locality?` — HQ location
- `status` (enum: `active | suspended | dissolved`)
- `capacity_dogs?`, `capacity_cats?`, `capacity_other?`, `capacity_total?` (integer NULL) — declared shelter capacity (Wave 3 Item 16, migration 0102). All nullable — capacity is optional. Occupancy is always derived from active `shelter_custody` ownerships via `lib/analytics/org-census.ts` (pure projection — see §Projections). Only editable by org admins in the `/configuracion` page "Capacidad" section, which is gated to `shelter | rescue_network` org types.
- `created_at`, `updated_at`, `created_by_user_id`

### `OrganizationCoverage` — where the org operates
- `id`, `organization_id`
- `jurisdiction_country` (default `'AR'`), `jurisdiction_province?`, `jurisdiction_locality?` — can be barrio-level for refugios
- `is_primary` (bool) — flags the org's main zone
- `created_at`
- Multiple rows per org allowed. Used to target lost-pet broadcasts to refugios with relevant coverage and to filter adoption listings by region.

### `OrganizationMembership` — people ↔ orgs
- `id`, `organization_id`, `user_id`
- `role` (enum: `admin | coordinator | member | volunteer | foster | vet_individual`)
- `title?` — free text (e.g. `"Coordinadora de tránsito"`, `"Veterinaria de cabecera"`)
- `can_write_pet_events` (bool, default false) — gates author privileges; transportistas false, coordinators / vets true
- `joined_at`, `left_at?` (null = current), `invited_by_user_id?`
- One user can hold memberships across many orgs simultaneously.

### `Pet` — the credential itself
- `id` (uuid, pk) — internal key
- `public_token` (unique) — short URL-safe code, used in QR (e.g. `DIM-3K4F-9P2X`)
- `species`, `breed?`, `name`, `sex` (male|female|unknown)
- `date_of_birth?`, `birth_date_is_estimated` (bool) — DOB is computed from the years+months input on signup; flagged as estimated by default
- `color?`, `distinguishing_features?`
- **Identifiers (microchip / tattoo):** live in `pet_identifications` — see `PetIdentification` below. The legacy parallel columns on `pets` (`microchip_id`, `microchip_country_code`, `tattoo_code`, etc.) were **dropped by migration `0084_drop_legacy_chip_tattoo_columns.sql`**; the dual-write window opened by compliance PR 0 is closed. Readers go through `lib/infra/chip-lookup.ts`.
- `primary_photo_id?` (fk → Attachment)
- `status` (active|lost|deceased), `deceased_at?`
- **Health & lifestyle (owner self-reported):**
  - `estimated_weight_kg?` — denormalized cache of latest reported weight; events are source of truth
  - `favourite_foods?` (text[]) — predefined options + free "otros"
  - `known_allergies?` (text[]) — same pattern; distinct from the `allergy_detected` event which records discovery
  - `training_level?` (none|basic|intermediate|advanced|professional)
- **Legal & insurance:**
  - `potentially_dangerous_breed` (bool, default false) — auto-set at registration via `lib/reference/breeds.ts` from breed + species; drives the `dangerous_breed_attested` flow (Ley CABA 4078, Ley Prov 14.107)
  - `insurance_company?`, `insurance_policy_number?`
- **Jurisdiction (coarse aggregation tag, never coordinates):**
  - `jurisdiction_country` (default `'AR'`)
  - `jurisdiction_province?`, `jurisdiction_locality?` — `jurisdiction_province` is stored as the canonical display name from `lib/reference/ar-provincias.ts` (e.g. `"Buenos Aires"`, `"CABA"`) and enforced by a 24-value CHECK constraint on every table that holds the column (migration 0055). Wire format from `LocationFields` is the ISO code; server actions pipe it through `canonicalProvinceNameForStorage()` in `lib/domain/jurisdiction-canonical.ts` before writing.
- `created_at`, `updated_at`
- **No precise home coordinates stored on pet.** Location precision lives on events when relevant, not on the pet's home.

### `Ownership` — history of who holds custody of each pet
- `id`, `pet_id`
- `owner_user_id?` (fk → users) — set when a person holds the row
- `owner_organization_id?` (fk → organizations) — set when an org holds the row
- `role` (enum: `owner | co_owner | shelter_custody | foster | caretaker`)
- `started_at`, `ended_at?` (null = current)
- `transferred_from_id?` — chains custody history across users and orgs
- `created_at`
- **Polymorphic holder.** Exactly one of (`owner_user_id`, `owner_organization_id`) is set per row, enforced via CHECK constraint. `Ownership` is the projection; the source of truth for transfers is always a `custody_transferred` or `adoption_finalized` event.
- **Active-owner constraint.** At most one active row per pet where `role='owner'` — índice único parcial `ownerships_one_active_owner_per_pet` (`db/schema.ts:1116`). Multiple `shelter_custody`, `foster`, `caretaker`, or `co_owner` rows can coexist with an active `owner`, or with each other when there is no permanent owner yet.
- **Role semantics:**
  - `owner` — permanent legal owner. The single accountable party. Person *or* organization.
  - `shelter_custody` — temporary custody pending permanent placement. Used by refugios *and* by individual citizens who pick up strays. Person *or* organization. It is the DEFAULT and by far the common case for a refugio: they hold `shelter_custody` until adoption finalizes. The vecino-helps-stray case uses the same role with `owner_user_id` set and no org link.
    - **CORRECTED 2026-08-22** (closing report L1). This line used to read "Refugios are never `owner` in DIM". That is false, and the code — not the doc — is the validated side (project rule: validated code beats a design-handoff table). An organization CAN hold `role='owner'`: `owner_by_org` is a value of the immutable event schema, documented there as *the org keeps the animal permanently (sanctuary, institutional adoption, seizure without rehoming)*, two product flows expose it with their own buttons, and two tests pin it as intentional. It is also reachable WITHOUT any transfer — a single org can register an animal in its own name at intake. Treat org-as-owner as a first-class, rarer product state, not an anomaly.
  - `foster` — temporary physical caregiver under an organization's umbrella. Requires `owner_user_id` plus an active `organization_membership` linking the foster to the org that holds the parallel `shelter_custody` row for the same pet.
  - `co_owner` — shared permanent ownership. Schema-ready; UI deferred.
  - `caretaker` — **cuidador temporal**: alguien de confianza que cuida la mascota por un período acotado (petsitter, vecina, familia). **Implementado end to end** (custodia-temporal, migraciones 0189–0193) — ya no es "schema-ready; UI deferred".
    - Su ciclo de vida vive en `pet_caretaker_grants`; la fila de `ownerships` es la proyección, escrita en la MISMA transacción que `caretaker_designated`.
    - **Una sola fila activa por mascota**, índice único parcial `ownerships_one_active_caretaker_per_pet`. El tope está duplicado a propósito: la tabla de grants protege el WORKFLOW, pero `ownerships` es lo que joinean todas las políticas RLS y todos los caminos de lectura.
    - **No es titularidad y no la toca.** El titular conserva todo, incluida la potestad de finalizar el cuidado en cualquier momento y sin consentimiento del cuidador. Un cuidador NO puede transferir, publicar en adopción, cambiar jurisdicción, editar identidad, emitir un link de libreta ni designar otro cuidador — la deny-list vive en `lib/domain/titular-only.ts` y la hacen cumplir `requireTitularAccess` (app) y `public.has_titular_write_access()` (RLS, migración 0190).
    - **No es participante de casos** (v1, decisión F2). `can_read_case` da la rama subject-pet solo a `role='owner'`. La limitación se muestra explícita — "Caso no disponible para cuidadores" — nunca como un 404 que la persona descubre haciendo clic.
    - Vocabulario cerrado (PO 2026-08-19): **"cuidador temporal"**, nunca "custodia temporal" — esa etiqueta ya es del rol `shelter_custody` de una organización.

### `cases.opened_reason*` — why a case was opened (structured, migration 0149)

**Opening a case? Pass an `OpenedReason` code, never a string.** `tsc` enforces it — this is the short version of a fence you cannot go around.

- `opened_reason` (text) — **audit prose. Never render this to a user.**
- `opened_reason_code` (text, nullable) — the structured cause. `GROUP BY` this for "casos abiertos por causa".
- `opened_reason_params` (jsonb, nullable) — the code's params. `{}` when it has none; a CHECK makes "code without params" unrepresentable.

**Where things are:**

| Need | File |
|---|---|
| Add/see the closed set of reasons | `src/modules/cases/domain/opened-reason.ts` (Zod discriminated union) |
| The es-AR label a funcionario reads | `src/modules/cases/domain/opened-reason-render.ts` |
| The audit prose that gets stored | `src/modules/cases/domain/opened-reason-prose.ts` |
| Render any case row | `caseOpenedReasonDisplay()` in `opened-reason-display.ts` |
| The bypass guard | `scripts/check-opened-reason-coverage.ts` (`pnpm lint:opened-reason`) |

**Adding writer #19**: add a union member. `tsc` then *requires* a renderer and a prose template — the mapped `Record`s make a missing one a compile error. Do not hand-write the string.

**Why the prose column still exists** (three reasons, all load-bearing):
1. **It is a live SQL query key.** `surveillance-repository.ts` dedupes open outbreak investigations with `opened_reason LIKE 'manual [{code}]:%'`. The dual-write keeps prose **byte-identical** to the pre-cutover templates, so that query matches both cohorts with no `OR`. Changing a prose template breaks this **silently** — no compile error, no failing test. `opened-reason-prose.test.ts` is the gate.
2. **Pre-cutover rows render from it, forever.** They are `(null, null)` permanently — there is **no backfill**, because retro-translating audit prose into a guessed code is a retro-edit of append-only data. `opened-reason-legacy.ts` is FROZEN (16 rules, pinned) and is **not dead code**.
3. **Rollback is free.** Revert the structured path and every row, new ones included, still renders.

**Privacy**: internal UUIDs (foster volunteer/org, the pet fallback in `pet_marked_lost`, microchip's secondary pet) travel as `OpenedReasonAudit` — they reach the prose and are structurally unreachable from any renderer. Never put an id in params.


### `PetTransfer` — owner→owner handshake (P3-2)
- `id`, `public_token` (`PTR-XXXX-XXXX`), `pet_id` (fk → pets)
- `from_owner_id` (fk → profiles), `to_owner_id?` (fk → profiles, null until the receiver signs up + accepts)
- `to_owner_email` — written before the receiver exists in `auth.users`; magic-link signup via `supabase.auth.admin.inviteUserByEmail` lands on `/transferencias/<token>` post-confirmation
- `status` (`pending | accepted | rejected | expired | cancelled`), `reason` (`sale | gift | inheritance | other`), `note?`
- `initiated_at`, `responded_at?`, `expires_at` (initiated + 7d), `rejection_reason?`
- **One pending transfer per pet.** Partial unique index on `(pet_id) WHERE status='pending'` blocks concurrent transfer races.
- **Daily expiration cron** at `/api/cron/expire-pet-transfers` (`expirePetTransfersOnce`) flips overdue rows to `expired` and notifies the sender.
- **Side effects on accept:** ends the prior `ownerships` row, opens a new one, emits `custody_transferred` event. The libreta sanitaria travels with the pet — no payload migration.

### `PetIdentification` — polymorphic identifier table (compliance PR 0)
- `id`, `pet_id` (fk → pets)
- `kind` (`identification_kind` enum: `microchip_iso | tattoo | collar_tag | photo_biometric`)
- `status` (`identification_status` enum: `active | replaced | removed | unreadable`)
- `code` — 15 dígitos para `microchip_iso`; texto libre normalizado para `tattoo`
- **ISO 11784/11785 subfields (chip rows):** `iso_country_code` (3 char, `'858'` AR), `iso_manufacturer_code` (4 char), `iso_national_id` (8 char), `iso_compliant` (bool)
- **Tattoo subfields:** `tattoo_location`, `tattoo_description`
- `recorded_at`, `recorded_by_user_id?`, `recorded_by_label?`, `photo_id?`, `implantation_site?`
- **Replacement chain:** `replaced_by_id` (self-FK), `replacement_reason` (`damaged | migrated | illegible | medical | other`)
- **Partial unique index:** `(code) WHERE kind='microchip_iso' AND status='active'` — los chips no pueden colisionar; los tatuajes legítimamente sí (CABA Ord. 41.831 no normaliza códigos entre registros).
- **Sustituye las columnas paralelas en `pets`** (microchip_id, tattoo_code, etc.). La ventana de doble-write cerró: la migración `0084_drop_legacy_chip_tattoo_columns.sql` dropeó las columnas legacy.
- **Norma bridge:** `ref.identification_kind_norma` mapea cada `kind` a su Res. SENASA / Ord. CABA correspondiente.

### `PetEvent` — append-only timeline (the spine)
- `id`, `pet_id`, `event_type`
- `occurred_at` (real-world time), `recorded_at` (system time)
- `recorded_by_user_id?` (nullable for anonymous scans and system events)
- `author_role` (enum: `owner | scanner | vet | shelter | govt | system`)
- `author_organization_id?` (fk → organizations) — set when the author acted on behalf of an organization (a clinic vet, a refugio coordinator, a sanitary-authority employee). Lets the audit trail attribute the institutional actor distinct from the individual person.
- `author_verified` (bool, default false) — true only when both: the relevant org is `verified=true` AND the author has `can_write_pet_events=true` in their membership
- `payload` (jsonb), `notes?`, `created_at`
- **Location (interim, v1):** `location_lat?`, `location_lng?` — numeric(10,7) lat/lng pair for events that carry precise location (vet visit, scan GPS, found-pet). Migrating to PostGIS `geography(Point, 4326)` as `location_point?` is deferred until we need radius search or polygon-based projections; Drizzle `customType` makes the lift-and-shift straightforward.
- **SENASA alignment columns (compliance PR 3, all nullable):** `tipo_evento_code` (FK → `ref.tipo_evento_sanitario`), `lote_biologico`, `laboratorio`, `vencimiento_biologico`, `via_aplicacion_code` (FK → `ref.via_aplicacion`), `vet_matricula`, `vet_jurisdiccion_code` (FK → `ref.jurisdiccion_sanitaria`), `establecimiento_renspa`, `proxima_dosis_at`, `firmado_at`, `firma_hash` (Ley 25.506 placeholder). Helpers en `lib/reference/sanitary-vocab.ts`. Legacy events sin `tipo_evento_code` siguen funcionando como antes; el form `/vet/eventos/nuevo` los populará cuando se reescriba al orden del PDF Res. 580/2014.
- **Append-only. Never edit, never delete. Correct by adding a new event.**

### `Reminder`
- `id`, `pet_id`, `user_id`, `reminder_type` (vaccine|medication|appointment|custom)
- `due_at`, `title`, `description?`
- `source_event_id?` (auto-generated reminders point back)
- `completed_at?`, `created_at`

### `Attachment`
- `id`, `pet_id?`, `event_id?`, `uploaded_by_user_id`
- `storage_path`, `mime_type`, `file_size`, `caption?`
- `created_at`

### `Notification` — per-user message history with read/archived state
Distinct from `PetEvent`:
- `PetEvent` = **immutable fact** about the world (the pet's life). Append-only.
- `Notification` = **message to a user** with **mutable state** (unread → read → archived).

Notifications often *project from* events (a `pet_registered` event with `potentially_dangerous_breed=true` produces a `ppp_registration_reminder` notification for the owner). Some are pure system messages (welcome, app updates) with no source event.

Fields:
- `id`, `user_id`
- `notification_type` (text — kept free-text not enum so adding new types doesn't need a migration; current values: `welcome`, `ppp_registration_reminder`, planned: `vaccine_due`, `scan_alert`, `system_update`)
- `title`, `body` (markdown allowed)
- `severity` (enum: `info` / `success` / `warning` / `urgent`) — drives badge color in UI
- `cta_label?`, `cta_url?` — optional call-to-action button
- `related_pet_id?`, `related_event_id?` — backlinks to source domain entities
- `read_at?` — null = unread
- `archived_at?` — null = visible
- `expires_at?` — optional auto-hide
- `created_at`

Indexes: partial index on `(user_id) where read_at IS NULL AND archived_at IS NULL` for unread-count queries; `(user_id, created_at)` for the inbox list.

**How notifications get created.** Three sources:
1. **Database triggers** — `welcome` on signup (handle_new_user trigger inserts both the profile row and the welcome notification atomically).
2. **Server actions** — `createPetAction` and `updatePetAction` insert a `ppp_registration_reminder` when a pet's breed is in the dangerous list.
3. **Future: scheduled jobs** — `vaccine_due` reminders fire from upcoming `Reminder` rows, generating notifications a few days before the due date.

UI for browsing notifications is built on **both clients**, and they read through one door:

- **Web** — `/notificaciones` (`app/(app)/notificaciones/page.tsx`): the inbox with category tabs, keyset pagination, per-row CTA / "Ver {nombre}" / marcar leída / archivar, a mark-all-read action, and the quick-reply island for the actionable types.
- **Native** — `/notificaciones` (`apps/mobile/app/notificaciones.tsx`) over `GET|POST /api/v1/me/notifications`. Same actions minus pagination (no cursor on that surface yet — the payload declares `truncated`) and minus quick reply (that is the capture-console surface, not the inbox). **Eight of the web's eleven pressables come across, not nine.** `d3237b654`'s message enumerated the eleven correctly and then subtracted wrong: pagination is TWO affordances ("← Más recientes" and "Ver más antiguos →"), so dropping it and quick reply drops three. Nine holds only if pull-to-refresh is counted as standing in for "← Más recientes", which it does not — one returns to page 1, the other re-reads the page you are on. The list above is the thing that cannot lie; the number is here only because a wrong one was written down.
- **The query is one function** — `listNotificationsForUser` (`src/modules/notifications/application/read/`), called by the page and the route, so "what is in the inbox" (own rows, not archived, minus the two read-time reconciliations, optionally one category) has one definition.
- **The display order is one function** — `@dim/contract/notifications` (`sortForDisplay` + `groupForDisplay`), called by both clients. `__tests__/notification-ordering-parity.test.ts` runs both projections over the same rows and asserts the orders are identical.
- **The write is not a spine fact.** `read_at` / `archived_at` are operational state on `notifications`; nothing is appended and nothing derives them. The POST family is `inbox-state` in `lib/infra/api-v1-limits.ts` — its own family, because the authenticated-write ceiling is sized against handing over an animal.

### `PushSubscription` — Web Push (VAPID) endpoints, migration `0152`

A second, best-effort delivery leg for `Notification` rows, not a parallel
source of truth — `notifications` stays authoritative; a push send is a side
effect of `severity='urgent'` inserts only (avistajes/hallazgos/custodia),
fired from `lib/infra/notification-service.ts` (`createNotification`) via
`lib/infra/web-push.ts` (`sendPushForNotifications`) — and only when the
insert used the shared `db` pool, not a caller-supplied transaction handle
(push network I/O must never hold a business tx open). Design: ADR
[`docs/adr/2026-07-18-native-readiness.md`](./docs/adr/2026-07-18-native-readiness.md) §4.

- `id`, `user_id` (fk → users)
- `endpoint` — the push service URL; **globally unique**, identifies the
  browser registration. Re-subscribing from the same browser upserts on
  `endpoint`.
- `p256dh`, `auth` — client encryption keys from the `PushSubscription` object
- `revoked_at?` — **soft revoke**. A 410/404 from the push service, or the user
  toggling push off in `/cuenta`, sets this instead of deleting the row —
  keeps an auditable trail. **El borrado duro NO ocurre nunca** (verificado
  2026-08-04): la cascada desde `profiles` existe pero es inalcanzable — nada
  borra filas de `profiles` (`erase_subject_data` hace soft-delete; la acción
  de cuenta borra sólo `auth.users`, que no tiene FK a `profiles`). El endpoint
  de push y sus claves sobreviven a un borrado de sujeto. Hallazgo de
  cumplimiento abierto (Ley 25.326 art. 16) en `dim-interno:docs/plans/PENDIENTES.md`.
- `created_at`

RLS: owner-only (`user_id = auth.uid()`) for SELECT/INSERT/UPDATE; no DELETE
policy (rows are soft-revoked, never client-deleted) — mirrors
`alert_subscriptions` (migration 0108). Drizzle service-role is the primary
authz gate (`requireUserOrRedirect` + `user_id` scoping in
`app/actions/push-subscriptions.ts`); RLS is defense-in-depth for any future
direct PostgREST surface.

Feature flag `NEXT_PUBLIC_PUSH_ENABLED` gates the client-side subscribe UI;
default **OFF**. Service worker: `public/sw.js`.

## Libreta sanitaria

The **Libreta sanitaria** is the digital embodiment of the canonical Argentine pet booklet — the yellow paper book every vet stamps and every dueño carries. In DIM it is a **projection over `pet_events`** filtered to the medical subset: vaccinations, dewormings, sterilization, vet visits, weight, medications, microchip, clinical work (labs, imaging, surgeries), allergies, symptoms, incidents, death.

It is not a new table, not a separate write path, not a parallel data store. Every fact that lands in the Libreta is already in the event log; the Libreta is what you get when you filter that log to medical events and present them grouped by clinical purpose.

**Why this naming matters.** DIM's North Star is real public-health data at population scale, but data only flows in if the dueño understands what they're using. *"Libreta sanitaria"* is the term every Argentine pet owner already knows — collapsing the explanatory distance to zero. *"Eventos"* is a developer concept; *"libreta"* is a household concept.

### Conceptual hierarchy

DIM has three user-facing concepts, each backed by the same underlying data:

| Concept | What it is | Backing |
|---|---|---|
| **Credencial MiMAR** | The pet's digital identity — name, photo, public token, QR. The animal's *documento* | `pets` row + Tier-0 public page at `/p/{publicToken}` |
| **Libreta sanitaria** | The pet's medical history — vacunas, vet visits, peso, medicación. What the vet writes | Projection over `pet_events` filtered to `LIBRETA_SANITARIA_EVENT_TYPES` |
| **Eventos** | The append-only event log itself, including non-medical entries (registrations, scans, custody transfers, welfare reports). Internal/admin concept | `pet_events` table |

The Credencial is **identity**. The Libreta is **history**. The Eventos are the **immutable substrate**. Same data, different framings depending on who's looking.

### Event types in the Libreta

A canonical, code-locked list of `event_type`s belongs to the Libreta. Lives in `lib/infra/libreta-sanitaria.ts`:

```ts
export const LIBRETA_SANITARIA_EVENT_TYPES = [
  "vaccination_administered",
  "deworming_administered",
  "sterilization_performed",
  "medication_started",
  "medication_stopped",
  "medication_dose_taken",
  "vet_visit_logged",
  "weight_recorded",
  "clinical_info_logged",
  "lab_work_performed",
  "imaging_performed",
  "surgery_performed",
  "allergy_detected",
  "microchip_implanted",
  "incident_reported",
  "symptom_observed",
  "death_recorded",
] as const satisfies readonly EventType[];
```

Explicitly **outside the Libreta** (identity, custody, welfare, or system signals — not medical records):

- `pet_registered`, `pet_profile_updated` — identity / admin
- `status_changed` — lost/found is identity-adjacent and welfare-adjacent, not strictly medical
- `credential_scanned` — system telemetry
- `dangerous_breed_attested` — legal attestation, not a clinical event
- `custody_transferred`, `foster_assigned`, `foster_ended`, `adoption_*` — ownership, not health
- `abandonment_reported`, `maltreatment_reported` — welfare denuncia, not health
- `note_added` — owner annotations live in a separate "Notas del dueño" view, not in the Libreta proper

**Rule for new event types.** Every addition to `EVENT_TYPES` declares explicitly whether it belongs to the Libreta. The decision is made at the moment of registration (one-line edit to `lib/infra/libreta-sanitaria.ts`, OR an inline comment confirming it deliberately does not belong). The PR that adds an event type must close the question, not defer it.

### UI surfaces

Three surfaces over the same projection:

1. **Section on the pet profile** at `/mis-mascotas/{publicToken}`. The card formerly titled *"Eventos"* renders as **"Libreta sanitaria"** and shows the latest N medical events with a *"Ver libreta completa →"* link.
2. **Dedicated owner route** at `/mis-mascotas/{publicToken}/libreta`. The full Libreta for the authenticated owner, grouped by clinical purpose (Vacunas, Antiparasitarios, Esterilización, Visitas, Medicación, Cirugías, Estudios, Peso, Alergias y condiciones) with an optional chronological toggle. Print-friendly stylesheet. Header carries pet identity (name, photo, species, sex, microchip if any, dueño first name) **as context** — identity is not part of the Libreta as a concept, but the rendered surface needs the same cover-page context the paper libreta has, otherwise the medical entries float without anchor.
3. **Public shareable Tier-2 route** at `/libreta/compartir/{shareToken}`. The owner-issued share link of the Privacy-tiers table, materialized. Same Libreta, accessible via a **share token distinct from `pets.publicToken`**, expiring (default 30 days, configurable per share), revocable by the owner at any moment. Footers with `Generada por MiMAR · {timestamp} · vence {expiry}` for vet-presentability. This is the surface a dueño hands to a vet who doesn't know MiMAR yet.

### Tokens

Tier-2 share tokens are intentionally separate from `pets.publicToken`:

- `pets.publicToken` — stable, lifetime, public Tier-0 surface
- `libreta_share_token` (new table, name TBD when implemented) — short-lived bearer credential, owner-revocable, per-share

The two never conflate. A leaked `publicToken` exposes Tier-0 (minimal). A leaked share token exposes Tier-2 but is revocable in one click and expires on its own.

### Code conventions

#### Killing a flow: grep for its name first (2026-08-08)

A conditional whose justification NAMES a specific flow becomes wrong the day that flow is removed — silently, with nobody touching the file. Two live bugs on 2026-08-08, both found by the PO rather than by CI:

- `app/gob/layout.tsx` swapped the ADMIN rail in for an admin viewer, because an admin used to arrive via `/admin/moderacion`'s **redirect**. The F1 fusion (2026-07-22) removed that redirect. What was left: the switcher offered "Ir a Gobierno" and the layout then served 19 links back to `/admin`, so the sections never changed and every click bounced. A door the product opened and then refused.
- `lib/ui/shell-nav.ts` pointed the operator's "Volver a mi app" at `/mis-mascotas`, calling it a "personal escape hatch" — while `app/(app)/layout.tsx` redirects govt→`/gob` and admin→`/admin` before that page renders. The link advertised a destination the product refuses to serve.

**The rule**: when you delete or reroute a flow, `rg` its name (route, redirect, entry point) across **comments**, not just code. The justification for someone else's `if` is written in prose, so it will not show up in a type error, a test, or any of the <!-- fact:verify_fences -->81<!-- /fact --> fences.

**The tell**: two pieces of the product disagreeing about whether a state is reachable. One offers it, the other denies it. When you find that, one of the two is stale — establish which before picking a side. Both bugs above also had the correct helper sitting in the same file (`roleHome()`), already used by a sibling branch.

- `lib/infra/libreta-sanitaria.ts` owns `LIBRETA_SANITARIA_EVENT_TYPES`, `isLibretaSanitariaEvent(eventType)`, and a Drizzle clause helper for filtering queries.
- The component formerly used as `<EventTimeline>` remains the rendering primitive but the canonical mount on the pet profile is `<LibretaSanitaria>` — a thin wrapper applying the filter and Libreta-specific empty-state copy.
- User-facing strings consistently use *"libreta sanitaria"*, *"tu libreta"*, *"registrar en la libreta"*, *"quedó en la libreta de Negrita"* — never *"evento"* outside admin/debug surfaces.
- Code-level identifiers (table names, function names, internal types) stay English (`pet_events`, `EventTimeline`, etc.). Spanish UI, English code — the existing rule applies.

### Why this is locked

The naming is not cosmetic. It is the conceptual surface that makes DIM legible to non-technical dueños, which is precisely what the North Star ("the data-collection layer must be valuable on its own to drive adoption") requires. Renaming this later would mean retraining users we already onboarded. Lock it now, before scale.

## Event catalog — 55 types

`UI` column: `v1` = recordable by owner in the v1 PWA · `system` = system-emitted · `later` = schema-ready, UI deferred (either non-owner reporter flow needed, or the owner-facing form just hasn't been built yet).

Grouped by purpose for navigation. Adding a new event type is a one-line edit to the `EVENT_TYPES` const in `db/schema.ts` — no database migration. The Zod schema lands in `lib/events/event-schemas.ts` in the same PR (a CI test in `__tests__/event-schemas.test.ts` enforces 100% coverage — the `UNIMPLEMENTED` allowlist is now empty).

**Lifecycle**

| Type                  | UI    | Payload                                                                                              |
| --------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `pet_registered`      | v1    | initial profile snapshot                                                                             |
| `pet_profile_updated` | v1    | `{ changes: [{field, old, new}], photo_replaced }`                                                   |
| `status_changed`      | v1    | `{ from_status, to_status: active\|lost, location_description?, reason?, disclosure_prefs_snapshot?, lost_description? }` — death uses `death_recorded`, not this |
| `death_recorded`      | v1    | `{ cause, cause_detail?, confirmed_by_vet?, vet_name?, disposition_method?, facility?, death_at_clinic?, vet_contacted_owner?, vet_decided_alone?, owner_to_private_crematorium?, disease_code?, confirmed_by_lab?, is_reportable }` |

**Preventive medicine**

| Type                       | UI | Payload                                                                                |
| -------------------------- | -- | -------------------------------------------------------------------------------------- |
| `vaccination_administered` | v1 | `{ vaccine_name, brand?, batch?, administered_by?, next_due_at? }`                     |
| `deworming_administered`   | v1 | `{ product, type: internal\|external\|both, next_due_at? }`                            |
| `sterilization_performed`  | v1 | `{ procedure: castration\|spay, performed_by?, clinic? }`                              |

**Medication**

| Type                    | UI | Payload                                                                                  |
| ----------------------- | -- | ---------------------------------------------------------------------------------------- |
| `medication_started`    | v1 | `{ drug_name, dose, frequency, prescribed_by?, drug_code?, first_dose_at, duration_days?, custom_hours?, schedule_count }` |
| `medication_stopped`    | v1 | `{ medication_started_event_id, reason? }`                                               |
| `medication_dose_taken` | v1 | `{ medication_started_event_id?, scheduled_for, reminder_id }` — dual-write with `reminder.completedAt` for the adherence cron |

**Clinical encounters and findings**

| Type                  | UI    | Payload                                                                                  |
| --------------------- | ----- | ---------------------------------------------------------------------------------------- |
| `vet_visit_logged`    | v1    | `{ reason, diagnosis?, vet_name?, clinic? }`                                             |
| `clinical_info_logged`| v1    | `{ sub_kind: lab_work\|imaging\|surgery\|allergy_detection\|disease_diagnosis\|pregnancy\|other, title, details?, performed_by? }` — umbrella event with sub-kind discriminator (covers what lab/imaging/surgery/allergy used to model as dedicated event_types pre-2026-05-18; `disease_diagnosis` powers ENO fanout; `pregnancy` tracks phase lifecycle) |

**Body metrics**

| Type              | UI | Payload    |
| ----------------- | -- | ---------- |
| `weight_recorded` | v1 | `{ kg }`   |

**Identification & legal**

| Type                       | UI    | Payload                                                                                              |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `microchip_implanted`      | v1    | `{ chip_number, country_code?, implanted_by?, location_on_body?, implant_date_known? }` — fired automatically at pet creation if a chip is provided |
| `microchip_replaced`       | later | `{ previous_chip_number, new_chip_number: string\|null, reason: damaged\|unreadable\|duplicate_detected\|fraud_detected\|owner_request\|device_failure\|other, replaced_by?, replaced_at, actor_role: owner\|vet\|admin\|govt, actor_user_id?, notes? }` — `new_chip_number=null` means revocation without replacement (replaces the retired `microchip_revoked` event_type, catalog cleanup 2026-05-19) |
| `tattoo_recorded`          | later | `{ tattoo_code, body_location?, recorded_by? }` — initial tattoo identification (Art. 4° Ord. CABA 41.831) |
| `tattoo_updated`           | later | `{ previous_code, new_code, reason? }` — correction or re-tattoo |
| `dangerous_breed_attested` | later | `{ registry: caba_4078\|prov_14107\|other, registry_id?, attested_at }` — owner registers their PPP in the official provincial registry |
| `tag_activated`            | v1    | `{ serial, lote_id?, source: self }` — owner links a physical tag (chapa) to the pet via the wrapper code. The payload NEVER carries the activation code (plaintext or hashed); strict schema rejects any code-shaped key |
| `tag_revoked`              | v1    | `{ serial, revoke_reason: lost\|damaged\|transfer\|fraud\|owner_request\|other, replacement_serial? }` — terminal baja of an ACTIVE tag. Key is `revoke_reason`, NOT `reason` (the erase RPC sentinel-redacts `reason` on every type and would destroy the enum) |

**Cuidado temporal (custodia-temporal, migración 0189)**

Dos tipos, no tres: la invitación pendiente NO es evento, es estado de workflow en `pet_caretaker_grants.status`. `caretaker_designated` se emite EN EL ACCEPT — el nombre significa "el cuidado se volvió activo" — en la misma transacción que la fila `ownerships(role='caretaker')`.

| Type                    | UI    | Payload                                                                                              |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `caretaker_designated`  | later | `{ grant_id, grant_public_token, caretaker_user_id, ends_at, note? }` — `ends_at` va desnormalizado a propósito: el grant puede terminar antes, y la espina tiene que seguir diciendo qué se acordó cuando empezó |
| `caretaker_ended`       | later | `{ grant_id, outcome: returned\|expired\|revoked_by_owner\|withdrawn_by_caretaker\|ownership_transferred, ends_at }` — la clave es `outcome`, NUNCA `reason` (el RPC de borrado redacta `reason` en todos los tipos y destruiría el enum). `expired` NO significa que el animal volvió: terminó el acceso, la posesión es otra pregunta. `ownership_transferred` (2026-08-21) es el hand-off — adopción finalizada, decomiso, resolución de disputa, conversión de tránsito a dueño — donde el arreglo lo termina un cambio de manos y no una decisión de las partes |

**Apadrinamiento de adopción (rehome-by-titular, migración 0194)**

El titular que ya no puede tener a su mascota le pide a una organización verificada que la publique en adopción y evalúe postulantes **mientras el animal se queda en su casa**. La org recibe una fila `shelter_custody` AL LADO de la fila `owner` del titular, nunca en lugar de ella: acá "custodia" es un rol de registro, no posesión física, y por eso toda pantalla de la org tiene que decir explícitamente que el animal no está en su poder. Dos tipos, no tres: la solicitud pendiente es estado de workflow en el caso `rehome_request`, no un hecho sobre el animal.

| Type                          | UI    | Payload                                                                                              |
| ----------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| `rehome_sponsorship_started`  | later | `{ ownership_id, sponsoring_organization_id, consented_by_user_id, request_case_public_code, listing_case_id?, note? }` — se emite EN EL ACCEPT, en la misma transacción que la fila `ownerships(role='shelter_custody')`. `ownership_id` dice QUÉ fila de custodia pertenece al apadrinamiento: sin él, el rollback tendría que adivinar por timestamps y barrería custodias de decomiso o intake |
| `rehome_sponsorship_ended`    | later | `{ ownership_id, outcome: adopted\|withdrawn_by_titular\|ended_by_org\|pet_deceased\|withdrawn_by_platform, ended_at }` — la clave es `outcome`, NUNCA `reason` (el RPC de borrado redacta `reason` en todos los tipos y destruiría el enum). `withdrawn_by_platform` existe sólo para el script de rollback |

**Free-form**

| Type         | UI | Payload                              |
| ------------ | -- | ------------------------------------ |
| `note_added` | v1 | `{ category?, text }` — catch-all   |

**Moderación de contenido**

Un tenedor objeta algo que escribió **otra persona** sobre su animal. Hoy eso es el feed de modo perdida: un avistaje o un "la tengo" tipeado por un desconocido anónimo que escaneó el QR en la calle. Existe porque el cuestionario IARC de Google Play declara esta app como una donde **se puede reportar contenido**, y una declaración describe la app tal como se publica. Ver [§ Privacidad 6c](#privacidad-y-manejo-de-datos) para el modelo entero, incluido por qué no hay "bloquear" y por qué la palabra es "reportar" y nunca "denunciar".

| Type               | UI | Payload                              |
| ------------------ | -- | ------------------------------------ |
| `content_reported` | v1 | `{ surface: lost_feed, target_event_id, target_kind: sighting\|finder_in_possession, category: spam\|harassment\|false_information\|personal_data\|other, reason? }` — `target_event_id` **es** el mecanismo: la fila reportada nunca se toca (invariante #2), y toda lectura del feed resta los ids nombrados acá (`notReportedClause`). El texto libre va bajo `reason` a propósito, al revés que `rehome_sponsorship_ended`: la redacción centinela del RPC de borrado es el resultado correcto para prosa. Ojo: eso **no** significa que siempre se borre — el RPC sólo barre las mascotas donde el sujeto es `role='owner'` activo, así que el `reason` de un cuidador queda. Ver §Privacidad 6c. El enum vive en `category`, clave aparte |

**System / observed**

| Type                 | UI     | Payload                                                                                                 |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `credential_scanned`          | system | `{ is_self_scan, viewer_authenticated }` — location goes in the event's `location_point` column        |
| `incident_reported`           | later  | `{ incident_type: bite_inflicted\|bite_suffered\|dog_attack\|fight\|traffic_accident\|fall\|poisoning\|escape\|other, severity?, injuries_summary?, vet_involved?, location_description?, victim_kind?, victim_contact_name?, victim_contact_phone?, victim_pet_id?, victim_age_estimate?, context?, rabies_vaccine_valid_at_incident?, reporter_role? }` — umbrella covers bite events (rabies observation flow filters by `payload->>'incident_type'='bite_inflicted'`). `dog_attack` is deprecated in favor of `bite_suffered`. Distinct from `maltreatment_reported` (incident is non-human-cruelty) |
| `rabies_observation_started`  | system | `{ incident_event_id, observation_deadline_at, opened_by_role: admin\|govt }` — opens the 10-day legal period after a `bite_inflicted` incident (Decreto PBA 4669/1973, Ord. CABA 41.831 art. 9). Sets `pets.rabies_observation_status='in_progress'` |
| `rabies_observation_ended`    | system | `{ incident_event_id, outcome: cleared\|escalated\|auto_closed, auto_closed?: boolean, notes? }` — closes the 10-day window. Emitted manually by admin/govt or automatically by the `close-rabies-observations` cron |
| `outbreak_signal`             | system | `{ source_symptom_event_id, disease_code, disease_label, match_strength: {high_count, medium_count, low_count, matched_symptom_codes}, pet_jurisdiction_country, pet_jurisdiction_province?, pet_jurisdiction_locality?, pet_species }` — emitted when `symptom_observed` triggers a reportable-disease match. Owner does not see this in the libreta |
| `disease_reported`            | govt   | `{ disease: lepto\|hidatidosis\|other, confirmed_by_lab, date_of_onset, clinical_notes? }` — govt-side surveillance entry that feeds zoonosis KPIs and the ENO fanout. Not part of the libreta (handoff P4-3) |

**Jurisdictional mobility (movilidad-jurisdiccional Fase 1)**

| Type | UI | Payload |
| --- | -- | --- |
| `movement_recorded` | v1 | `z.discriminatedUnion` on `sub_kind` (deliberate divergence from `clinical_info_logged`'s flat+superRefine — the three faces share NO fields). `jurisdiction_changed`: `{ from_country, from_province?, from_locality?, to_country, to_province?, to_locality?, effective_date, reason? }` — no-op moves rejected at schema level; ONLY this sub_kind denormalizes `pets.jurisdiction*` (single tx, event-first — `recordMovementWriter`). `cvi_issued`: `{ origin_country, cvi_number, issuing_authority, issued_date, chip_iso_country_code? }` — records the FACT of a foreign CVI; DIM never issues. `transport_recorded`: `{ corridor_id: chile\|uruguay\|brasil\|ue_espana\|usa, direction: outbound_from_ar, travel_date, mode?, purpose? }` — 6th corridor rejected at schema level (5-corridor hard bound in `lib/reference/cross-border-corridors.ts`). Amendable. Powers `/mis-mascotas/[publicToken]/viaje` (semáforo + checklist + PDF export). |

**Correction**

| Type            | UI | Payload                                                                                                                                                                                                                                   |
| --------------- | -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event_amended` | v1 | `{ target_event_id, reason: string\|null, changes: [{field, old, new}], actor_role: owner\|vet\|admin\|govt, actor_user_id? }` — **Principle #2 (built 2026-06-19, Wave 2 Item 15).** Immutable correction: references the original event, never mutates it. `changes` shape calcs `pet_profile_updated`; `actor_role/reason` calcs `microchip_replaced`. Amendable allowlist (D4): `vaccination_administered`, `deworming_administered`, `weight_recorded`, `vet_visit_logged`, `clinical_info_logged`, `medication_started`, `note_added`, `sterilization_performed`, `movement_recorded`. NOT amendable: death, incidents, legal/forensic events (D4 in spec). Admin/govt amendments: `reason` mandatory ≥5 chars, `audit_log` row, owner notified (`notification_type='admin_event_amended'`). Amendment-of-amendment allowed — always references the ORIGINAL `target_event_id`. Projection: libreta applies latest amendment at render; original remains in `/historial`. NOT part of the libreta (pointer/audit artifact, not clinical entry). |

**Schema-ready, requires non-owner reporting flow**

| Type                    | UI    | Payload                                                                                          |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `symptom_observed`      | v1    | `{ source: libreta\|welfare_report, welfare_report_id?, reporter_role: owner\|witness\|vet, free_text, matched_symptom_codes, alerted_disease_codes, severity_self_assessed?, onset_at? }` |
| `abandonment_reported`  | later | `{ welfare_report_id, reporter_role: owner\|witness, description }`                              |
| `maltreatment_reported` | later | `{ welfare_report_id, reporter_role, description, severity, kind }` — eventually integrates with Ley Nacional 14.346 denuncia pipelines |

**Custody & adoption**

| Type                              | UI    | Payload                                                                                          |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `shelter_intake_recorded`         | later | `{ intake_reason: rescue\|surrender\|seizure\|stray_found\|other, intake_condition?, rescue_jurisdiction? }` — fired when a shelter or citizen takes custody of an unowned animal |
| `foster_assigned`                 | later | `{ foster_user_id, expected_weeks?, notes? }` — refugio assigns a voluntario |
| `foster_ended`                    | later | `{ foster_user_id, foster_assigned_event_id?, ended_by: shelter\|foster_returned\|other, reason? }` |
| `adoption_application_submitted`  | later | `{ applicant_user_id, related_organization_id, housing_type?, other_pets?, daily_routine?, notes? }` |
| `adoption_application_resolved`   | later | `{ application_event_id, reviewer_user_id, outcome: approved\|rejected, reason?, auto_generated?, notes? }` — umbrella for approve/reject decisions; `auto_generated=true` marks the F5.5 cascade rejections triggered by `adoption_finalized` |
| `adoption_finalized`              | later | `{ previous_owner_organization_id, adopter_user_id, foster_user_id?, contract_attachment_id?, post_adoption_followup_months?, notes? }` — **composite event.** Atomically ends `shelter_custody` and `foster` rows and inserts a new `owner` row |
| `post_adoption_checkin`           | later | `{ related_organization_id, photo_attachment_ids, notes? }`                                      |
| `adoption_reversed`               | later | `{ actor: shelter\|adopter\|court, reason, reverted_finalization_event_id? }` — replaces both `adoption_revoked` and `adoption_withdrawn` (catalog cleanup 2026-05-19) |
| `ownership_claimed`               | later | `{ chip_number?, tattoo_code?, claim_reason? }` — direct claim of a chip/tattoo-registered pet with no active custody of any role (free pet). Unlike `custody_transferred` there is no "from" actor; the claimant opens a fresh `owner` ownership row. Emitted by `submitFreeClaimAction` (claim wizard variant "free") |
| `custody_transferred`             | later | `{ from_user_id?, from_organization_id?, to_user_id?, to_organization_id?, from_role, to_role, reason?, matched_against_pet_id?, foster_ended_event_id?, notes? }` — handoffs that are not adoption |
| `custody_transfer_proposed`       | later | `{ from_user_id?, from_organization_id?, to_user_id?, to_organization_id?, reason, matched_against_pet_id?, proposed_at, notes? }` — Phase 1 of the return-to-owner / cross-org two-phase handshake |
| `custody_transfer_cancelled`      | later | `{ proposal_event_id, cancelled_by: sender\|receiver\|system, reason? }` — structured cancellation of a `custody_transfer_proposed`. Replaces the fragile `note_added` marker approach (ARCH-B). The `cancelled_by` discriminator records who terminated the proposal |
| `custody_dispute_raised`          | later | `{ raised_by_role: admin\|govt\|owner, raised_by_user_id, external_proceeding_reference?, reason }` — flags the pet as subject to an ownership dispute and sets `pets.in_custody_dispute = true`. Admin/govt use it for external legal proceedings; `owner` is the self-raised path via the chip/tatuaje claim wizard (`/mis-mascotas/reclamar`, P3-1) — adjudication still flows through govt/admin via `custody_dispute_resolved`. **⚠ Known drift (flagged 2026-07-16, deliberately NOT reconciled): this EVENT PAYLOAD lists 3 roles, but the `custody_disputes` TABLE's CHECK allows 4 — `owner\|org\|govt\|admin`.** Two different surfaces; each is authoritative for itself. `OpenedReason.custody_dispute_raised.raisedByRole` follows the table's 4. Reconciling them is a decision, not a typo fix — whoever makes it should decide whether an `org` can raise a dispute, then change one side to match |
| `custody_dispute_resolved`        | later | `{ raised_event_id, resolved_by_role: admin\|govt, resolved_by_user_id, outcome: ownership_confirmed\|ownership_transferred\|case_dismissed\|other, notes? }` — closes a prior `custody_dispute_raised`. Sets `pets.in_custody_dispute = false` |
| `foster_proposed`                 | later | `{ volunteer_user_id, expected_weeks?, notes? }` — org proposes a foster assignment to a volunteer (Phase 1 of foster lifecycle per spec 2026-05-18-foster-volunteers-pool-design v1.4) |
| `foster_proposal_resolved`        | later | `{ proposal_event_id, outcome: accepted\|rejected\|cancelled\|expired, resolved_by_user_id? }` — umbrella terminal event for the foster proposal lifecycle (replaces 4 dedicated event_types per catalog cleanup 2026-05-19) |
| `foster_co_foster_allowed`        | later | `{ foster_user_id, co_foster_user_id, allowed_by_role }` — org grants a co-foster opt-in flag (D17 spec) |
| `adoption_eligibility_set`        | later | `{ eligible: boolean, reason?, set_by_role }` — flag set/changed on a shelter-held pet indicating readiness for adoption listing (spec foster-volunteers-pool §17) |

**System telemetry**

Share-view tracking (Tier-2 libreta share tokens) moved out of `pet_events` and into a dedicated `share_telemetry` table during the 2026-05-19 catalog cleanup; migration `0167` then **dropped that table** (TEL-1, PO decision 2026-08-04) — it recorded a `viewer_ip_hash` + `user_agent` per view and nothing ever read it. All that remains of share views is the counter pair `libreta_share_tokens.view_count_cached` / `last_viewed_at_cached`. `pet_events` carries no non-clinical telemetry of share use; the `libreta_shared_viewed` event_type was retired (see Deprecated table). Only `outbreak_signal` and `credential_scanned` remain as system-emitted entries inside the events log.

### Deprecated event types

Fifteen event types were retired in the 2026-05-18/19 catalog cleanup (`lab_work_performed`
→ `clinical_info_logged`, the `foster_proposal_*` / `adoption_application_*` pairs →
their `_resolved` forms, and so on). They are absent from both `EVENT_TYPES` and the
Zod registry, so no flow can write them. The full old→new mapping lives in
`dim-interno:docs/archive/2026-05-19-deprecated-event-types.md` — consult it only when an old plan
or seed script names one.

The `incident_type='dog_attack'` value inside `incident_reported.payload` is also deprecated in favor of the unambiguous `incident_type='bite_suffered'`. Historical rows with `dog_attack` are preserved by keeping the value in the Zod enum.

Self-scans (owner viewing own pet's public page) are recorded with `is_self_scan: true` and hidden from default timeline UI.

Events with a real-world location should populate the `PetEvent.location_point` column (top-level), not duplicate it inside `payload`. The payload is for event-type-specific data; `location_point` is universal across event types and used by every geographic projection.

### Cross-cutting event design patterns

Four recurring patterns emerge from DIM's event catalog. New event design should recognize which pattern fits and use the established shape rather than inventing new structure.

**1. `*_started` / `*_ended` pairs with auto-close cron.**

Used for time-bounded processes — for example the planned `rabies_observation_started`/`_ended` (10-day legal period) and `foster_assigned`/`foster_ended`. Each pair has:
- An originating event that opens the period and writes a denormalized status column on the relevant row (`pets.rabies_observation_status='in_progress'`, `pets.in_custody_dispute=true`).
- A closing event that flips the status to a terminal state.
- A daily cron that auto-closes the happy path; manual closure for non-happy cases. Cron must be idempotent.

The pattern preserves the immutable event log while giving fast queries via the denormalized status column. When designing a new bounded-process event, follow this shape.

**2. `*_signal` system-emitted events for surveillance and audit.**

Used when the system itself produces a record not directly authored by a user. Examples: `outbreak_signal` (system detected a disease pattern from `symptom_observed`), `libreta_shared_viewed` (telemetry of share-token use), `credential_scanned` (QR scan log). Each has:
- `author_role = 'system'` (or the relevant party for authenticated scans); anonymous-scan rows have `recorded_by_user_id = null`.
- Severity tagged when actionable (`urgent | warning | info`).
- Classified as NON-libreta — these are system telemetry, not pet medical history.

When designing a new system-emitted event, ensure it's NON-libreta and the trigger that emits it is explicitly documented.

**3. `*_proposed` / `*_executed` two-phase with lazy auto-cancel.**

Used for high-trust transfers requiring acceptance: `custody_transfer_proposed` + `custody_transferred` (org-to-org and refugio-to-owner), the adoption pipeline (`adoption_application_submitted` → `_approved` / `_rejected` / `adoption_withdrawn` → `adoption_finalized`). Each pair has:
- Phase 1: proposing party emits the `*_proposed` event. State is "pending".
- Phase 2: receiving party accepts → emits the `*_executed` event in an atomic transaction; ends related ownership rows, starts new ones.
- Lazy auto-cancel: at Phase 2 accept time, the receiver's server action validates preconditions (proposer still has standing, target state still matches the proposal context). If any precondition fails, the proposal auto-cancels with a `note_added` event + notification to the original proposer. No sweep job needed.

When designing a new transfer or approval workflow, use this pattern. Avoid ad-hoc state machines; reuse the proposed/executed shape.

**4. `*_reported` umbrella with sub_kind discriminator.**

Used when several variants share a common event shape: `incident_reported` with `incident_type` (`bite_inflicted | bite_suffered | dog_attack | fight | traffic_accident | fall | poisoning | escape | other`), `clinical_info_logged` with `sub_kind` (`lab_work | imaging | surgery | allergy_detection | other`), `symptom_observed` with implicit sub_kind via `matched_symptom_codes`. Each has:
- A single event_type covering N variants.
- A discriminator field in payload (`incident_type`, `sub_kind`, …).
- Optional fields per variant that are only meaningful for some discriminator values (validated as `optional`/`nullable` at the schema level; the form layer enforces conditional requirements when needed).

When designing a new event with 3+ semantically-similar variants, prefer this umbrella over N separate event_types. Easier to extend (add a new discriminator value, optionally add new payload fields) than to add N event types each with their own schema.

**When NOT to use these patterns.**

- For purely additive write-once facts (`vaccination_administered`, `weight_recorded`, `death_recorded`), no pattern needed. Just an event_type with payload.
- For UI preferences (`emergencyInfoVisible`, `disclose_*_when_lost` on `pets`), these aren't events at all — they're mutable state on the entity row. Don't emit events for preference flips.

**Payload enrichments to add when their forms get built** (already justified by the legal framework above and the CABA acquisition-trend data):

- `pet_registered.payload.acquisition_method` — `adopted | rescued | purchased | bred | gift | unknown`. Adoption/rescue is the growing modality per EAH 2018; surfacing it lets us measure that trend over time.
- `pet_registered.payload.potentially_dangerous_breed` (boolean) — flips on the Ley CABA 4078 / Ley Prov 14.107 attestation requirement. Possibly a dedicated `dangerous_breed_attested` event for the legal record itself.

**Already built — `death_recorded.payload.disposition_method`** (`cremation_collective | cremation_individual_ashes | authorized_cemetery | owner_burial | household_waste | rendering | unknown`), plus optional `facility` (the cremation center / vet clinic that handled the disposition). Captured today by `DeathRecordForm`, normalized via `lib/domain/disposition.ts`, and projected by `lib/analytics/mortality-metrics.ts` into the `/gob/mortalidad` dashboard (Ley CABA 5470 traceability). Read from the JSONB payload (`payload->>'disposition_method'`) — not denormalized to a column.

**Payload evolution policy (PO-approved, 2026-07-08).** Surfaces once read `payload->>'key'` keys no writer schema emitted — Postgres returns NULL for a missing JSONB key instead of erroring, so 14+ dashboards were silently wrong (commits c01bec56 / 9e57a7b7). Three rules, enforced by `pnpm lint:events` (`scripts/check-event-payload-parity.ts`) in the `verify` pipeline:

1. **Payload keys are never reused with a different meaning.** Once a key name has shipped for an event type, its meaning is fixed forever — a later PR that wants a different shape for "the same concept" adds a NEW key (or a new `sub_kind`/discriminator variant), never redefines what an existing key means. Old rows in the immutable log would silently misparse otherwise.
2. **Readers may only query keys a writer schema emits.** Every `payload->>'key'` (SQL) or `.payload.key` (JS) read anywhere in `app/`, `src/`, `lib/` must be a key some schema in `lib/events/event-schemas.ts` is capable of writing — enforced mechanically by `lint:events`, not by review discipline alone. A justified exception (a genuinely legacy key still read for historical rows, no longer written) goes in `scripts/event-parity-baseline.json` with a mandatory reason string; empty is the goal.
3. **Schema evolution is read-side upcasters, never event rewrites.** Events are append-only (core invariant #2) — a payload shape change never touches existing rows. When a schema's meaning must evolve, bump `payload_version` and add a v(n-1)→v(n) mapping in `lib/events/event-upcasters.ts` (see `docs/superpowers/event-versioning.md`) so historical rows still read correctly under the new shape.

## Privacy tiers (the public surface)

| Tier | Audience                              | What's visible                                                                                                                       |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Anyone scanning the QR                | photo, first name, species, breed, approx age (year), sex, "credential valid ✓", vaccination boolean (✓ / ⚠), microchip present (y/n), "Did you find this pet?" contact form |
| 0+   | Tier 0 + owner-toggled emergency flag | "This pet takes daily medication — contact owner immediately" without drug names or owner phone                                       |
| 1    | Pet status = `lost`                   | Tier 0 + owner first name + direct contact + last-known location if shared                                                            |
| 2-público | Anyone with the `publicToken` URL (QR or direct link) — **opt-in, default OFF** | Curated medical summary on `/p/[publicToken]`: active vaccine count, sterilization status, active medication names. UI chip reads "TIER 2 · MÉDICO". Gated by `pets.tier2PublicPermanent = true` OR `pets.tier2PublicEnabledUntil` is a future timestamp. Activated by the owner via `enableTier2PublicAction` (durations: 24h / 7d / 30d / permanent). Revoked instantly via `revokeTier2PublicAction`. **Distinct from Tier 2 share-link** — no auth needed, no token distribution, just the pet's existing `publicToken`. |
| 2    | Owner-issued share link               | The full **Libreta sanitaria** via a revocable, time-limited share token at `/libreta/compartir/{shareToken}`. Distinct from `pets.publicToken`. See §Libreta sanitaria for surfaces and token model.         |
| 3    | Owner, authenticated in app           | Everything, including scan history with locations. Editable.                                                                          |
| 4    | (future) Verified vet via portal      | Tier 2 by default + can write events                                                                                                  |

**Organization branding on public credentials.** When a pet's current `Ownership` row is held by a verified organization (or held one recently, within the post-adoption followup window declared on `adoption_finalized`), Tier 0 may display a "Bajo seguimiento de [Org Name] ✓" badge. The badge is gated by `organizations.verified AND organizations.tier0ShowOriginOrg` (`lib/infra/origin-org.ts:100`). **NO existe opt-in por mascota** — corregido 2026-08-04: este párrafo prometía un control `pets.tier0ShowOriginOrg` que no existe, y nombraba `tier0ShowBranding`, que es OTRO flag (autoría en el timeline). La organización decide sola. (texto viejo, label "Refugio de origen", default `false`). Unverified orgs do not appear on public credentials. The "Did you find this pet?" contact form (`/p/[publicToken]/encontre`) does **not** dual-route to the originating refugio — it routes to the legal owner only.

## Dashboards & projections (the consumers)

Build for **flexibility and big scope** — three audiences are intended consumers, each gets distinct views from the same underlying event log. The architectural rule: **any dashboard view must be expressible as a query/projection over the event log**, optionally with jurisdiction or time filters. If a useful view can't be expressed this way, the event catalog is incomplete and the answer is a new event type, not a new table.

> **Design law — name your denominator (and what you exclude).** Every aggregate a surface shows MUST name **what it excludes** and **against which denominator it is computed**. A bare "41,3%" is a pretty number; "41,3% de los 12.480 perros del padrón · el padrón cubre 2,6% de la población canina estimada" is a serious tool. This formalizes the hand-made residuals already in the codebase (sin ubicación, no-locality, k-anon suppressed, sin-vacunas-registradas) into a rule, and mandates the **double denominator** for coverage %: registry coverage (numerator / registered population) AND registry-of-census coverage (registered population / estimated canine population, `jurisdictions_census` × `ESTIMATED_DOGS_PER_INHABITANT`). When a denominator is unavailable (e.g. no census row), say so explicitly ("sin estimación censal") — never omit it silently or fabricate one. Coverage fetchers return `{ value, registryDenominator, censusDenominator, censusCoveragePct }` progressively (`lib/analytics/govt-home-kpis.ts → fetchRabiesCoverage`, pure helper `lib/metrics/census.ts → computeCensusCoverage`). See also [§ Privacidad #6](#privacidad-y-manejo-de-datos).

### Sanitary authority (city / comuna, operational)
- Vaccination coverage by barrio — % of registered pets with up-to-date core vaccines, overdue counts and approximate density
- Active campaign performance — enrollments, completions, no-shows, geographic reach
- Mortality clusters — `death_recorded` events by cause and week, map overlay
- Antibiotic / antimicrobial use density (AMR surveillance) — **A12**, antimicrobial `medication_started` per 1,000 active pets, `lib/analytics/surveillance-metrics.ts` `fetchAmrDensity` (classifier `isAntimicrobial` in `lib/reference/drugs.ts`; uncatalogued codes shown as a provisional raw count, not folded into the rate)
- 10-day rabies-observation compliance + breaches — **A8/A9**, `fetchRabiesObservationCompliance` (Ord. CABA 41.831 art. 9); open-past-10d observations surface as a live `OpBreach`
- ENO-notification SLA — **A7**, `fetchEnoSla` over `event_notification_outbox` (`target_kind='eno_authority'`): on-time %, breached-row count, median latency. Measures OUR outbox pipeline, not external delivery
- Mortality clusters — `death_recorded` events by cause and week, by-locality breakdown (`/gob/mortalidad`, live; per-death geo heat layer deferred — payload carries no `location_point`)
- Disposition mix & traceable-disposal rate (Ley CABA 5470) — `death_recorded.disposition_method` + `facility`, normalized into cremation/burial/rendering/other buckets; traceable-disposal rate = share of deaths with a known method AND a recorded facility; unknown-disposition rate as the compliance gap (`/gob/mortalidad`, live)
- Reportable-death share — `death_recorded.is_reportable` + `disease_code` breakdown (`/gob/mortalidad`, live)
- Antibiotic / antimicrobial use density (AMR surveillance)
- Sterilization rate trend by jurisdiction
- **Microchip penetration (C1)** — chipped active pets / active pets, by jurisdiction. **Adoption, not legal compliance**: no Argentine norm mandates the chip (see the Legal framework table), so the 80% target is a programmatic benchmark and the tile cites no law. `lib/analytics/compliance-metrics.ts → fetchMicrochipPenetration`; locality breakdown is k-anon suppressed. Surfaced on `/gob` Panel.
- **ISO-validity rate (C2)** — chipped pets with well-formed decomposed ISO fields (`iso_country_code`/`iso_manufacturer_code`/`iso_national_id`) / all chipped (Res. SENASA 284/2024). `fetchIsoValidity`; surfaced on `/gob/usuarios` (Registro).
- **Chip-fraud signal (C5)** — `microchip_replaced` grouped by `reason`, highlighting `fraud_detected` + `duplicate_detected`. A signal for human review, NOT an auto-classification. `fetchChipReplacementSignal`; surfaced as an `OpBreach` on `/gob/usuarios`.
- **Dangerous-breed registry compliance (C7)** — PPP-flagged pets attested / all PPP-flagged (Ley CABA 4078 / Prov 14.107). `fetchDangerousBreedCompliance`. **Degrades gracefully**: until a `dangerous_breed_attested` writer-form exists the attested count is 0, so C7 reads an honest "registry adoption 0%" (a true signal, not a bug). Surfaced on `/gob` Panel.

### Public-health analyst (province / national, strategic)
- Vaccination coverage trends over time, sliceable by jurisdiction
- Zoonosis indicators — aggregated `symptom_observed` + `death_recorded` patterns flagged when anomalous
- Reportable-disease incidence + lab-confirmation rate — **A6/A10**, `fetchReportableIncidence` over `disease_reported` + `death_recorded.is_reportable` (per-disease counts k-anonymity suppressed; lab-confirmation = `confirmed_by_lab` share)
- Population dynamics — registrations vs deaths vs lost over time, by region
- Cross-region comparison and ranking
- AMR signal trends, multi-region (**A12**, see Sanitary authority)

### Animal-welfare officer (case-driven)
- Maltreatment / abandonment report queue with map and assignment workflow
- Lost-pet hotspots (density maps from `status_changed → lost` events)
- **Reunification rate (D4)** — lost episodes returned to `active` / all lost, plus median days-to-recovery (UK ~39% benchmark). `lib/analytics/compliance-metrics.ts → fetchReunificationRate`; period-aware, jurisdiction-scoped. Surfaced on `/gob/perdidas`.
- **Seizures / decomisos (D5)** — `shelter_intake_recorded(intake_reason='seizure')` grouped by `seizure_motive`, by period (Ley 14.346 enforcement throughput). `fetchSeizures`; surfaced on `/gob/decomisos`.
- Stray / found-pet sighting feed (anonymous `credential_scanned` events on unowned pets, when that flow exists)
- Owner-of-record gaps — unmicrochipped pets in welfare cases
- Case-management workflow: status, assignment, resolution, audit trail (itself an event stream)

### Cross-cutting projection examples
- "Pets in a given jurisdiction with overdue rabies" → contact pipeline for outreach campaigns
- "Vets with the highest sterilization throughput last quarter" → recognition / capacity allocation
- "Barrios with rising stray-scan density" → welfare resource pre-positioning

### Bitemporal projections — valid time vs transaction time (task #77)

Every `pet_events` row carries **two** timestamps: `occurred_at` (VALID time — when the fact happened) and `recorded_at` (TRANSACTION time — when the system/State learned it). This bitemporality is dormant in the data (zero migration needed) but load-bearing for projections. **Every temporal surface must name which basis it uses**, because the two answer different questions:

- **Valid time (`occurred_at`)** — "what happened when." The default for reconstructing a situation as it unfolded on the ground.
- **Transaction time (`recorded_at`)** — "what the State KNEW when." An event that occurred 2026-03-01 but was recorded 2026-03-13 shows up 12 days *later* in a transaction-time replay. **The gap between the two IS a metric**: reporting lag, territorial-presence blind spots, institutional diligence.

Surfaces and their basis:

| Surface | Default basis | Toggle? | Notes |
|---|---|---|---|
| Panorama time scrubber ("Reproducción temporal") | valid (`occurred_at`) | Yes — "según lo conocido al momento" switches to `recorded_at` (scrubber Detalle mode only) | Honored by the `pet_events`-backed layers: perdidas, mordeduras, zoonosis. Client-only view state (panorama-vista-redesign) — NOT part of the shareable board URL; threaded as `?basis=transaction` only into the `/api/panorama/[layer]` fetch while actively scrubbing. `denuncias` (welfare_reports) and `decomisos` (cases) have no distinct `recorded_at`, so they replay by their single timestamp in both modes. |
| MPF welfare export ("Cronología según conocimiento") | both, shown side by side | n/a | The PDF names the occurrence date (valid) and the intake date (transaction = when the authority took knowledge via the denuncia), plus the gap — institutional legal defense for the fiscalía. |

**Why it matters**: no Argentine state system exposes this distinction. Surfacing "según lo conocido al momento" turns a dormant data property into a governance instrument — the reporting-lag gap is territorial-presence evidence no other registry can produce.

**Perf note**: `recorded_at` is NOT indexed (only `occurred_at` is: `pet_events_pet_id_occurred_at_idx`, `pet_events_event_type_occurred_at_idx`), so a transaction-basis replay is an unindexed range scan. Acceptable at pilot scale; a future migration should add a `recorded_at` index if this path gets hot.

## Aggregation & privacy policy

- **Coarse public aggregates require no consent.** Counts of vaccinated pets per barrio per month, with no per-pet attribution, can power public dashboards without owner opt-in — there's no individual signal to expose.
- **Granular research/welfare contribution is opt-in.** Owners can opt their pet's events (with location, with timing) into datasets beyond coarse counts. Default off; clearly communicated; revocable.
- **PII never leaves the database in AGGREGATE projections** (dashboards, datos abiertos): ahí rigen k-anonimato y supresión, y `jurisdiction_locality` es la unidad más chica publicada. **Las superficies públicas CONSENTIDAS son la excepción declarada**: credencial de mascota perdida (nombre del dueño + contacto + coordenadas, con su opt-in), libreta compartida (nombre) y comprobante de denuncia (coordenadas gruesas). Corregido 2026-08-04 — como absoluto la frase era falsa, y es la clase de frase que alguien cita ante un regulador.
- **k-anonymity for small cells — enforced.** Any aggregate that would expose fewer than `k` pets in a region (default `k=5`) is suppressed or rolled up to the next coarser jurisdiction level. Prevents accidental re-identification in sparse data. **Enforcement boundary: `lib/metrics/anonymity.ts` → `suppressSmallCells`.** The `SuppressedCells` branded type makes it a compile-time error to return a raw cell array without suppression.
- **The operator PADRÓN export is the declared exception on the authority side, and it is a real one.** `/gob/analytics/export` returns data **fila por fila** — one row per pet / case / organization / event — and `suppressSmallCells` is **not** applied to it. `anonymizeRows` (`lib/analytics/govt-exports.ts`) only STRIPS fields via Zod; it suppresses no cell, so grouping the CSV in Excel reconstructs the cells the dashboards hide (measured: 98 % of the mortality-by-locality cells). This is a **PO decision, 2026-08-23 (D2)**: an official needs the padrón of their own territory, and suppressing cells breaks the purpose. It is bounded to the operator's own jurisdiction (every fetcher fails closed on a govt with zero assignments) and every generation writes an `analytics_export_generated` audit row. **The full declaration, the two properties it rests on, and its reopen triggers are `docs/architecture/privacy-known-limitations.md` → PD1** — read it before touching that path. Do NOT read the k-anonymity bullet above as covering this surface: it did not, and saying nothing about it was the dishonest part. Datos abiertos and every public aggregate remain governed with no exception.
- **Authorized actors (vet portal, gov portal, when they exist) see PII within their legitimate scope only**, gated by Postgres Row Level Security. The data layer enforces tier visibility, not just the app code.
### Authorization architecture (Wave 5 Item 26)

DIM uses a **two-layer authorization model**. Understanding both layers is critical when adding new data paths or new tables.

**Layer 1 — Server Actions (primary authz gate, mandatory):**
Every mutation and every sensitive read goes through a Next.js Server Action
backed by Drizzle ORM. Drizzle connects via `DATABASE_URL`, which resolves to
a role with `BYPASSRLS` privilege (the `postgres` / `service_role` superuser).
The action checks the session, the caller's role, and ownership before any SQL.
This is the AUTHORITATIVE gate; it cannot be bypassed from the browser.
Reference: `app/actions/`, `lib/`, any file ending in `Action` or `query*`.

**Layer 2 — Postgres RLS (defense-in-depth backstop):**
PostgREST (the supabase-js / publishable-key surface) is subject to PostgreSQL
Row Level Security. If a Next.js vulnerability, a future direct-PostgREST
integration, or a misconfigured supabase-js client is ever exposed, RLS is the
last line of defense that keeps tenant data isolated at the DB level.

Key invariant: **service-role and `postgres` connections bypass RLS by design**
(`BYPASSRLS` privilege confirmed on both roles). Every Drizzle server-action
query, the public `/p/[publicToken]` credential page, and all Tier-2 routes go
through this BYPASSRLS connection — RLS never fires for these paths. Enabling
or tightening an RLS policy CANNOT break the app. Enabling deny-all for
PostgREST writes is always safe.

RLS history and coverage:
- All PII / tenant-scoped tables have RLS enabled (migration 0086, the
  authoritative list is in `__tests__/rls/coverage.test.ts → RLS_REQUIRED`).
- `__tests__/rls/matrix.test.ts` exercises SELECT via supabase-js (PostgREST)
  for the role × table matrix (the table list is `ALL_TABLES` in that file — read it there).
- `pnpm rls:smoke` runs a cross-account smoke against a live local stack.
- `e2e/cross-tenant-isolation.spec.ts` (Wave 5 Item 26) validates both the
  action-edge authz and the PostgREST RLS layer end-to-end via Playwright.

When adding a new PII or tenant-scoped table:
1. Enable RLS in the migration (`ALTER TABLE … ENABLE ROW LEVEL SECURITY`).
2. Add it to `RLS_REQUIRED` in `__tests__/rls/coverage.test.ts`.
3. Add appropriate policies (or document it as intentional deny-all with a reason).
4. If the table belongs to an owner, add it to the cross-tenant e2e probes.

- **Owner-facing RLS lives in the migrations** (0086 onward; `db/rls.sql` is a reference-only mirror that nothing applies). It enables RLS on the seven core tables (`profiles`, `pets`, `ownerships`, `pet_events`, `reminders`, `attachments`, `notifications`) and locks every PostgREST read/write to the authenticated owner. `pet_events` has no INSERT, UPDATE or DELETE policy (0212) — the append-only rule (`AGENTS.md → Core principles #2`) is enforced both by code discipline and by RLS. Change a policy only through a forward-only `db/migrations/NNNN_*.sql` applied by `db:migrate` — never by pasting a `db/*_rls.sql` file into Supabase Studio (they lag the migrations and would re-open policies 0175/0211/0212/0236 closed); do not use `pnpm db:push`, which would propose dropping unmodeled policies. Server-side reads via Drizzle bypass RLS by design — the public credential page at `/p/{public_token}` continues to work because its server component goes through Drizzle, not supabase-js. Verify the policies via `pnpm rls:smoke`, which runs two test accounts against PostgREST and asserts isolation end-to-end.

## Scan privacy model (Wave 5 Item 28)

When the public credential page `/p/[publicToken]` is viewed, `app/actions/scans.ts`
inserts a `credential_scanned` event into `pet_events`.

> **The payload contract lives in one place — Privacidad §5 (`#privacidad-y-manejo-de-datos`).**
> This section used to state "no IP address and no geolocation are ever stored", which
> Task #45 (scan-location capture, PO decision obs #733) superseded: scanner rows now
> carry a COARSE `scan_ip_area` (city precision max, never the raw IP). They used to add
> `scan_coords` / `scan_accuracy_m` when the pet was lost and the scanner granted browser
> geolocation; W8 (PO 2026-09-24, no device location anywhere) retired that — only pre-W8
> events still carry them, until the 90-day purge. Privacidad §5 has the full rule table with enforcement sites; do not
> re-derive it here — one of the two copies will drift, and this is the copy that did.

Author role assignment:
- `author_role = 'owner'` — viewer is the pet's current owner (self-scan).
- `author_role = 'scanner'` — viewer is anyone else (anonymous or authenticated non-owner).

**Retention (TTL = 90 days, owner-approved):**  
`credential_scanned` events with `author_role='scanner'` are purged after 90 days by
the daily cron `/api/cron/purge-scan-events` (`lib/infra/scan-retention.ts`).  Self-scan
events (`author_role='owner'`) are NOT purged — they are part of the owner's own
history.

Append-only exception (migration 0104 + `db/triggers.sql`):  
The `enforce_pet_events_append_only` trigger now includes a **narrow second path**
(`app.allow_scan_purge = 'true'` session GUC) that permits DELETE exclusively for
scanner events older than the TTL.  Every purged row produces an `audit_log` entry
(action `scan_event_purged`).  The general mutation escape hatch
(`app.allow_event_mutation`) is unaffected and still requires an accountable actor UUID.

(The owner-nudges consumer that used to be documented here was deleted as dead code on
2026-07-21 — see the feature inventory. `/inicio` is a redirect-only router, not a
dashboard.)

## Identity model & DNI handling (Wave 5 Item 25a)

**No DNI in plaintext rule** (Ley 25.326 / Mi Argentina premise, migration 0106):
`profiles.dni_number` was dropped. The DNI is never stored in cleartext after
migration 0106. The columns that replace it:

| Column | Type | Purpose |
|---|---|---|
| `miarg_sub` | `text unique` | Opaque, stable subject ID from Mi Argentina OIDC |
| `identity_source` | `'miarg' \| 'legacy'` | How identity was verified |
| `dni_hash` | `text` (HMAC-SHA256 hex) | Equality matching only — see `lib/utils/dni-hash.ts` |
| `dni_last4` | `text(4)` | Human disambiguation in operator UI — NOT an identifier |
| `dni_verified` | `bool` | Whether DNI has been verified |
| `dni_verified_at` | `timestamptz` | When verification happened |

**Pepper:** `DNI_HASH_PEPPER` env var (server-side only). Local/test default:
`dim-test-pepper-v1`. Production value must be a secret in Vercel env — if
leaked, the entire hash table can be reversed via rainbow table (Argentine DNI
space is finite). Never commit the production pepper.

**Where-clauses:** `WHERE dni_hash = hashDni(input)` — never `WHERE dni_number = input`.
See `lib/utils/dni-hash.ts` for `hashDni()` and `dniLast4()` helpers.

**OIDC scaffold (Item 25a — stub only):**
`lib/infra/miarg-oidc.ts` defines the integration shape for Mi Argentina OIDC.
`app/auth/miarg/callback/route.ts` is the callback route stub. Both are gated
behind `isMiArgOidcEnabled()` — absent env vars → email/password flow unchanged.
The real connection (token exchange, JWK verification) is Item 25b, gated on
owner credentials. Every 25b TODO is marked `TODO(25b)`.

**Institutional accounts** remain unchanged — no `miarg_sub`, no `dni_hash`.
The `profiles_institutional_no_pii` CHECK now also excludes `miarg_sub`.

**Checklist for any agent touching auth or profiles:**
- Never write `dni_number` — that column is gone.
- Never select or return raw DNI — use `dni_last4` for display, `dni_hash` for equality.
- The `hashDni()` function in `lib/utils/dni-hash.ts` is the canonical path.
- `erase_subject_data()` (migration 0106) nulls `dni_hash`, `dni_last4`, `miarg_sub`.

**Ties Item 31:** this section is the "identity + DNI" entry for the consolidated
"Privacidad y manejo de datos" checklist that Item 31 will build.

## PII baseline & subject rights (Ley 25.326)

Compliance PR 1 (2026-05-28) ancla las bases de la Ley 25.326 al schema:

- **Schema `pii`** con helper `pii.apply_baseline(tbl regclass)` que añade 5 columnas estándar a cualquier tabla con datos personales: `created_by`, `updated_by`, `purpose` (`data_purpose` enum), `deleted_at`, `retention_until`. Aplicado a **`profiles`, `pets`, `pet_identifications`, `custody_disputes`**. `pet_events` queda afuera porque es append-only por trigger (soft-delete no aplica semánticamente).
- **`data_purpose` enum** (8 valores) — ata cada fila PII a su base legal (Ley 25.326 art. 4°): `identidad_mascota`, `salud_animal`, `notificacion_zoonosis`, `reunificacion_perdida`, `control_poblacional`, `razas_peligrosas`, `auditoria_legal`, `consentimiento_marketing`.
- **RPCs en `migrations/0059`** (SECURITY DEFINER, GRANT a `authenticated`):
  - `export_subject_data(p_user_id uuid) → jsonb` — Ley 25.326 art. 14 (derecho de acceso). Devuelve perfil + mascotas + identificaciones + eventos del sujeto. Auth: self o admin institucional.
  - `erase_subject_data(p_user_id, p_reason) → void` — Ley 25.326 art. 16 (derecho de supresión). Soft-delete + hash de PII; los eventos sanitarios se conservan **por decisión de producto** (el historial de salud sobrevive a un cambio de responsable), NO por una obligación legal de conservación. La justificación normativa que escribieron `0059:102-104` y `0159:6-7` (SENASA / Ord. CABA 41.831 / Ley 14.072) es **falsa** y no puede invocarse para negar una supresión (art. 16 inc. 5) — errata completa en `docs/architecture/retention-policy-pending-decision.md`.
- **UI** en `/cuenta/privacidad` — botones "Descargar mis datos" (JSON download) y "Eliminar mi cuenta" (con motivo). El disclaimer explica qué se conserva y por qué, **sin** afirmar obligación legal alguna (fence: `__tests__/privacy-retention-claim.guard.test.ts`).
- **Audit log** registra cada llamada con la cita normativa: `subject_data_exported` (art. 14), `subject_erasure` (art. 16).
- **`<html lang="es-AR">`** + `prefers-reduced-motion` + biome a11y rules a level error documentan el baseline WCAG 2.1 AA (Ley 26.653, Disp. ONTI 6/2019). Audit de contraste en `docs/a11y/contrast-audit.md`.

**Pendiente (sprint propio):**
- `lib/audit/log.ts` wrapper que registra `purpose` en cada mutación PII.
- Consent checkboxes granulares por `data_purpose` en `/registro`.
- RLS soft-delete policies sobre cada tabla PII (defense in depth).

## SENASA reference vocabularies

Schema `ref.*` (compliance PR 3, migration 0060) ancla los vocabularios SENASA en tablas referenciables por foreign key — cuando se homologue la LSUCyF digital con SENASA, el export es directo sin ETL.

| Tabla | Filas seeded | Norma |
| --- | --- | --- |
| `ref.tipo_evento_sanitario` | 17 codes — 5 vacunas + 2 desparasitaciones + cirugía + esterilización + observación antirrábica + mordedura + defunción + transferencia + extravío/recuperación + consulta clínica + REV | Res. SENASA 580/2014, 80/2025, LSUCyF 2022 |
| `ref.via_aplicacion` | 6 (`sc`/`im`/`iv`/`vo`/`top`/`in`) | ICAR |
| `ref.jurisdiccion_sanitaria` | 4 sembradas (CABA, BA, Santa Fe, Córdoba); las 20 restantes ISO 3166-2:AR son research follow-up | Decreto-Ley 9.686/1981 (CVPBA), Ley 14.072 (CVPCABA) |
| `ref.identification_kind_norma` | 4 — bridge cada `pet_identifications.kind` a su Res. SENASA / Ord. CABA correspondiente | PR 0 + Res. SENASA 284/2024 |

Helpers en `lib/reference/sanitary-vocab.ts`: `tipoEventoLabel`, `tipoEventoNorma`, `requiresLote`, `requiresVia`, `notificableEno`. El test `__tests__/sanitary-vocab.test.ts` pinea el TS mirror contra el DB seed en cada CI.

`pet_events.notificable_eno=true` codes (vacunacion_antirrabica / observacion_antirrabica / mordedura_notificada) deberían disparar un row en `event_notification_outbox` con `target_kind='eno_authority'` — la integración auto-fire queda como follow-up. La **latencia de ese outbox ya se mide** (metric **A7**, `lib/analytics/surveillance-metrics.ts` `fetchEnoSla`, superficie `/gob/vigilancia`): on-time %, filas en breach y mediana de latencia. El auto-fire sigue siendo follow-up; lo que se monitorea hoy es el SLA de nuestra cola, no la entrega externa.

## Feature inventory

Lectura rápida de qué hace DIM hoy, qué está spec'd y pendiente de ejecución, y qué queda como pregunta abierta. Es la respuesta canónica a "¿existe X?" antes de asumir o construir desde cero. Cuando una feature lande o cambie de status, actualizar esta tabla en el mismo PR.

Leyenda: ✅ en producción · 🔵 en progreso (migración parcial en curso) · 🟢 spec + plan listos, pendiente de ejecutar · 🟡 spec only (falta plan) · ⚪ idea / open question.

### Owner-facing (PWA principal)

| Estado | Feature | Ruta / surface |
|---|---|---|
| ✅ | Signup dos pasos (cuenta → identidad) + Mi Argentina placeholder | `/signup` |
| ✅ | Login (email/password + Mi Argentina placeholder) | `/login` |
| ✅ | Lista de mascotas | `/mis-mascotas` |
| ✅ | Pet profile + event timeline | `/mis-mascotas/[publicToken]` |
| ✅ | Event detail con mapa de OSM cuando hay coords | `/mis-mascotas/[publicToken]/eventos/[eventId]` |
| ✅ | Libreta sanitaria (vista agrupada + cronológica + print) | `/mis-mascotas/[publicToken]/libreta` |
| ✅ | Tier-2 shareable libreta vía share token revocable | `/libreta/compartir/[shareToken]` |
| ✅ | Public credential Tier 0/0+/1 con disclosure prefs owner-controlled | `/p/[publicToken]` |
| ✅ | Marcar perdida + enriched description para pets sin chip | `/mis-mascotas/[publicToken]/perdida` |
| ✅ | Marcar encontrada / coordinar devolución refugio→owner | `/mis-mascotas/[publicToken]/devolucion` |
| ✅ | Vecino-en-tránsito (custody flow para vecino con stray) | `/mis-mascotas/nueva?custodyKind=transito` |
| ✅ | Reservar turnos en campaigns/clinics, ver agenda propia | `/turnos/buscar` + `/mis-turnos` |
| ✅ | Captura rápida (URL-prefill + matcher local sin LLM) | `/mis-mascotas/[publicToken]/anotar` + `lib/events/event-capture-registry.ts` |
| ✅ | Owner home `/inicio` — NO es un dashboard: es un server-redirect a la credencial de la mascota más urgente (mismo rank compartido `rankOwnerCarousel`). Cero mascotas vivas → redirige a `/mis-mascotas` (índice + bandeja). Reenvía su query (`?sheet=anotar`) al destino. Aplica la misma vet-gate que `/mis-mascotas` (`resolveVetLanding` salvo `?as=owner`). | `/inicio` + `lib/analytics/owner-dashboard.ts` (`fetchLivePetsForCarouselRanking`) |
| ✅ | Carrusel de credenciales del owner — se hojea entre las mascotas vivas (urgent-first) DENTRO de `/mis-mascotas/[publicToken]`; el índice `/mis-mascotas` es lista de filas + bandeja + In memoriam. La nav owner tiene 2 tabs (Mis mascotas, Denuncias) — no hay tab "Inicio". | `/mis-mascotas/[publicToken]` (`PetCredentialCarousel`) + `lib/domain/owner-carousel.ts` |
| ⚪ | Estado sanitario — nudges per-pet derivados de eventos propios (vacuna vencida, sin microchip, próximo recordatorio, scans de credencial, esterilización) fueron diseñados, testeados y privacy-reviewed, pero el componente host (`PetHealthStatusStrip`) fue eliminado en la consolidación "tarjeta-todo". El motor (`lib/infra/owner-nudges.ts`) quedó huérfano (cero callers fuera de su propio test) y se removió como dead code el 2026-07-21 — sin surface owner-facing hoy. Remontarlo es una decisión de producto separada, no un bug. | ninguno hoy |
| 🟡 | Movilidad jurisdiccional — honest facade desde la UX-honesty pass del 2026-07-19: la ruta renderiza un `LnEmptyState` "Próximamente" (ningún writer emite `transport_recorded`; solo `jurisdiction_changed` vía `/mudanza`), y el ítem de menú "Viaje y movilidad" queda deshabilitado con badge "Próximamente". El semáforo/checklist/export PDF de Fase 1 (5 corredores, valores regulatorios citation-pending) NO está wired a ninguna pantalla — el código subyacente (`lib/projections/travel-compliance.ts`, `lib/reference/cross-border-corridors.ts`) queda intacto y listo para re-wire cuando se priorice. | `/mis-mascotas/[publicToken]/viaje` + `lib/projections/travel-compliance.ts` + `lib/reference/cross-border-corridors.ts` |
| ✅ | Adoption listing público con filtros + postulación | `/adoptar` (spec v1.2) |
| ✅ | Foster volunteers pool (pool global owner→refugio) | `/cuenta/ofrecerme-como-tránsito` + `/cuenta/transitos/*` (spec v1.4) |
| ✅ | **Acompañamiento de adopción (rehome-by-titular)** — el titular le pide a una org verificada que publique a su mascota y evalúe postulantes **mientras el animal sigue en su casa**: abre un caso `rehome_request` (kind 13), la org acepta (fila `shelter_custody` AL LADO de la fila `owner`, nunca en lugar de ella) o rechaza; el titular cancela el pedido pendiente o da de baja el acompañamiento cuando quiera y eso siempre gana. Eventos `rehome_sponsorship_started/ended` (titular-only, migración 0194); un solo org con custodia viva por mascota (0195). Una muerte cierra el acompañamiento (`lib/infra/rehome-death-cascade.ts`); rollback por `scripts/rollback-rehome-sponsorships.ts` (ADR-7). SDD en Engram `sdd/rehome-by-titular/*`. | `/mis-mascotas/[publicToken]/buscar-hogar` + `src/modules/rehome/` (README) |
| ✅ | Physical-tag lifecycle (chapa física): emisión admin por lote (CSV serial+código), activación self-service con código de envoltorio (hash HMAC peppered, compuerta de evidencia en SQL — el código nunca se lee de vuelta), baja terminal con motivo, resolver público por estado (active→307 a `/p/`, unactivated→CTA activar, revoked→página honesta sin motivo, unknown→404, 100/min/IP). El lado de ESCRITURA también tiene presupuesto, y no es el mismo número: activación 5/min · 20/h por IP y 3/min · 10/h por serial (acota el brute-force del código de envoltorio), revocación 10/min · 40/h por IP y 3/min · 10/h por serial (el caller ya probó ownership, así que solo acota un cliente desbocado sobre una escritura terminal) — `app/actions/tags.ts`. Eventos `tag_activated`/`tag_revoked` (payload key `revoke_reason`, nunca el código). La regla `physical_credential_channels.engraved_plate` gatea SOLO discovery (entrada de nav /cuenta), nunca activación ni resolución. Migrations 0169/0170. | `/t/[serial]` + `/cuenta/chapas` + `/cuenta/chapas/activar` + `/admin/chapas` + `src/modules/pets/application/tags/` |

### Welfare denuncias (Ley 14.346)

| Estado | Feature | Ruta / surface |
|---|---|---|
| ✅ | Form público de denuncia (anonymous-capable, 5 attachments × 25MB, 9 kinds, 4 severidades) | `/denuncias/nueva` |
| ✅ | Tracking anónimo via reference code `DEN-XXXX-XXXX` | `/denuncias/codigo/[code]` |
| ✅ | Lista de mis denuncias (autenticado) | `/denuncias/mias` y `/denuncias/[id]` |
| ✅ | Bridge a pet_events (`maltreatment_reported`, `abandonment_reported`, `symptom_observed`) cuando subject es registered pet | server-side en `src/modules/welfare/actions.ts` |
| ✅ | Bug fix: location bridge a pet_event + mapa en detail page denuncia + rate-limit anon | plan `2026-05-18-welfare-reports-polish.md` (shipped) |
| ✅ | Welfare-officer queue para triagear casos | `/gob/maltrato` — queue completo con filtros (urgent/mine), asignación, detail page, loading skeleton |
| ✅ | Moderation queue para denuncias anónimas auto-flagged | `/admin/moderacion` (scope universal) y `/gob/moderacion` (cola scope-bound por jurisdicción + triage) — ambas comparten el predicado `buildModerationQueueConditions` (`lib/analytics/govt-dashboards.ts`); queue + detail page en cada portal |
| ✅ | Export template a fiscalía MPF CABA (Ley 14.346 pipeline) | `src/modules/welfare/application/generate-mpf-export.ts` + `generateMpfExportAction` |

### Organizations (refugios, clinics, rescue networks, sanitary authorities)

| Estado | Feature | Ruta / surface |
|---|---|---|
| ✅ | Org portal — intake, foster, custody, adoption, scheduling, member management | `/org/[orgToken]/*` |
| ✅ | Intake (new pet) + transfer-in con microchip cross-check | `/org/[orgToken]/intake` |
| ✅ | Foster assign / end (member-based) | dentro de `/org/[orgToken]/mascotas/[petToken]` |
| ✅ | Custody transfer org→org (propose → accept / reject / **cancel**). El sender SÍ puede cancelar una transferencia pendiente: `CancelTransferAction.tsx`, cableado en `transferencias/page.tsx:156`. (Esta fila decía lo contrario hasta 2026-08-12 — quedó stale tras el facades-harvest del 2026-07-21.) | `/org/[orgToken]/transferencias` |
| ✅ | Adoption pipeline completo (submitted/approved/rejected/finalized; cron `post-adoption-checkin`). `adoption_reversed` tiene acción y formulario: `ReverseAdoptionAction.tsx`, cableado en `mascotas/[publicToken]/page.tsx:118`. (Esta fila decía "sin acción/formulario que lo dispare" hasta 2026-08-12 — misma staleness.) | `/org/[orgToken]/adopciones` |
| ✅ | Post-adoption check-ins | `/org/[orgToken]/checkins` |
| ✅ | Service offerings + scheduling con materialización vía cron | `/org/[orgToken]/servicios` |
| ✅ | Coverage zones para targeting de lost-pet broadcast | `/org/[orgToken]/cobertura` |
| ✅ | Members + capability grants | `/org/[orgToken]/miembros` |
| ✅ | Surface unificado de mascotas en tránsito (member + voluntary pool + vecino) | `/org/[orgToken]/transitos` (parte del plan foster pool) |
| ✅ | Listado de pets no aptas para adopción (con razón estructurada) | `/org/[orgToken]/pets/no-aptas` (parte del plan foster pool) |
| ✅ | Bulk operations para refugios high-capacity (200+ animales) | `/org/[orgToken]/mascotas` — multi-select: vacunación, elegibilidad-adopción, publicar/despublicar listado (Sprint 8, #399-401) |
| ✅ | **Solicitudes de nuevo hogar** (rehome-by-titular) en la bandeja de casos, acotadas a `rehome_request` por `receiver_organization_id`; aceptar/rechazar desde el expediente. "Custodia" acá es registral, no posesión: toda pantalla de la org sobre una mascota apadrinada dice "{Mascota} vive con su familia; {Org} acompaña la adopción" (`SponsorshipPossessionNotice`), y la ficha pública `/adoptar/[petToken]` condiciona su copy a dónde vive el animal. | `/org/[orgToken]/casos?kind=rehome_request` + `/casos/[publicCode]` + `/org/[orgToken]/adopciones` |

### Surveillance & health

| Estado | Feature | Surface / mecanismo |
|---|---|---|
| ✅ | Symptom-disease surveillance (matcher fuzzy → reportable diseases → outbreak signal silent a govt) | server-side, sin UI directa al owner |
| ✅ | Bite-rabies observation 10-day (Ley CABA + Decreto PBA) con auto-close + escalation hooks | `/admin/observaciones/[publicToken]` |
| ✅ | Cron de cierre automático de observaciones | `/api/cron/close-rabies-observations` |
| ⚪ | Vaccination-due warning al owner (UX feature, NO compliance requirement) | — |

### Panorama / situational console

The operator situational map — jurisdiction-fenced choropleth + graduated symbols over the event log. `/gob/panorama` (scope-bound) y `/admin/panorama` (universal).

| Estado | Feature | Surface / mecanismo |
|---|---|---|
| ✅ | Light operator theme (`ln-op-*` tokens) en /gob y /admin — la piel oscura v1 quedó retirada | `fd757227` (v2C `#21`, incremento 1); `packages/contract/src/viz/viz-scales.ts` (`@dim/contract/viz`) es la fuente de verdad de la paleta |
| ✅ | Consola fija v2C — viewport-locked (`100dvh`, sin scroll de página), chrome flotante sobre el mapa (Vista/Capas + KPI chips + legend pill) + dock inferior con tabs `Registros \| Estadísticas \| Línea de tiempo` | `components/panorama/PanoramaConsole.tsx` + `PanoramaDock.tsx`; el canvas MapLibre nunca re-layoutea |
| ✅ | Event-points mode — puntos por evento scope-gated (no jitter; ver plan de puntos) | `pointsMode` en `PanoramaConsole` + disclosure honesto por capa |
| ✅ | Cube precompute (road-to-10 infra, migración 0139) — **ON por defecto** desde la decisión cube-ON (K4/S3 2026-07-24): `CUBE_READS='0'` es el kill switch; lectura solo si el cubo está FRESCO (ventana 26h = cadencia diaria del cron `refresh-cube`, `0 3 * * *` en vercel.json — 2.º y último slot Hobby); stale/ausente → live con disclosure de truncamiento; caption "Datos precalculados al …" / "Datos en vivo" en el footer del console; refresh sub-diario + ventana 6h requieren Vercel Pro (fase 3) | `src/modules/panorama/application/load-layer-features-cube.ts` (flag `!== "0"`, `CUBE_STALE_MAX_MS` 26h), `db/index.ts` (`analyticsReadOverride`), `src/modules/panorama/domain/cube-freshness.ts` |
| 🟡 | KPI-strip cube (migración 0151, extiende road-to-10 infra #1) — mismo `CUBE_READS` dual-path que 0139 pero para `/api/panorama/kpis`; el builder REUSA `getPanoramaKpis` (mismo fan-out que la request path) así que cube-vs-live drift es estructuralmente imposible. Fase independiente dentro del cron `refresh-cube`: un fallo de la fase KPI no bloquea el swap de la cube de capas ni viceversa | `src/modules/panorama/application/load-panorama-kpis-cube.ts`, `panorama_kpi_cube` + `panorama_kpi_cube_meta` (deny-all RLS, solo `analyticsDb` service-role), `app/api/cron/refresh-cube/route.ts` (campo `kpi` en la respuesta), fence de paridad cube-vs-live |
| ✅ | k-anonimato display suppression (k=5) en las 5 rutas de render; limitación de differencing KA1/KA2 **aceptada y documentada** (no implementar el fix salvo que se dispare un reopen trigger) | `lib/metrics/anonymity.ts` (`k ?? 5`); `docs/architecture/privacy-known-limitations.md` |

### Professional & vet

| Estado | Feature | Ruta / surface |
|---|---|---|
| ✅ | Vet con membership en org puede emitir eventos clínicos | dentro de `/org/[orgToken]` |
| ✅ | Vet independiente crea clinic org via `/cuenta/crear-consultorio` + opera desde `/org/[orgToken]` | Sprint 1A (Fases A–C) |

### Admin & govt

| Estado | Feature | Ruta / surface |
|---|---|---|
| ✅ | Admin surface básico (orgs + vet upgrades review) | `/admin/*` parcial |
| ✅ | Admin page completo (4 roles, account_type institutional, split `/gob` vs `/admin`) | spec v2.2 (`2026-05-17-admin-page-design.md`) + fases 10-14 (`2026-05-18-admin-page-next-phases-design.md`), ambos planes archivados |
| ✅ | `/gob` portal scope-bound por localidad / jurisdicción | `requireAdminOrGovtOrRedirect()` en `lib/infra/auth-guards.ts`; admin ve scope universal, govt filtra por sus `govt_assignments`; todos los helpers de `lib/analytics/govt-dashboards.ts` aceptan el par `actor + jurisdictions` |
| ✅ | Government dashboards (sanitary / analyst / welfare officer) | `/gob/mortalidad`, `/gob/vigilancia`, `/gob/programa` (hub: `?vista=resumen\|analitica`), `/gob/padron` (hub: `?vista=censo\|poblacion`) — UI completa con proyecciones sobre el event log. `/gob/analytics`, `/gob/poblacion` y `/gob/censo` sobreviven solo como redirects hacia su hub (fusiones F8/F9); no tienen entrada de nav. |
| ✅ | Admin rules console — `govt_business_rules` + registry declarativo de tipos de regla (contá los del registry, no este número), cascade locality > province > country > default | `/admin/reglas` + `lib/domain/rule-types-registry.ts` + `lib/infra/business-rules-resolver.ts` (migración 0116) |
| 🟢 | Rules-engine v2: jurisdiction-aware compliance (obligation types + legal baseline versionado + honest compliance surface + métricas jurisdiction-aware) | SDD change `jurisdiction-compliance` — spec/design/tasks en engram (`sdd/jurisdiction-compliance/*`); número de migración a determinar (0118 ya está tomado por `event_amended_target_idx`) |

### Identity & legal

| Estado | Feature | Pendiente |
|---|---|---|
| ✅ | Microchip implant event + tracking (`microchip_implanted`) | — |
| 🟡 | Dangerous breed (PPP) registry support — Ley CABA 4078 / Prov 14.107 | flag + attestation event ✅ shipped (column `pets.potentially_dangerous_breed` + event `dangerous_breed_attested`). **Export CABA ✅**: `generatePppExportAction` emite el PDF para el RUPPPA (Ley 5470 / Ord. 41.831) — render, subida al bucket privado `ppp-exports`, URL firmada 24 h, auditoría — y el titular legal de un perro PPP en CABA lo emite desde la tarjeta PPP de la ficha (`PppExportAffordance`, gate en `lib/domain/ppp-export-eligibility.ts`); fuera de CABA la tarjeta dice por qué no. Hasta 2026-09-18 esta fila decía "placeholder por ahora" y ningún componente invocaba la acción. **Pendiente**: Prov. BA (Ley 14.107) y el envío automático al registro — el PDF lo presenta el titular |
| ✅ | Disposition method en `death_recorded` — Ley CABA 5470 | shipped: `DISPOSITION_METHODS` enum en `src/modules/events/domain/death-rules.ts` (`cremation_collective | cremation_individual_ashes | authorized_cemetery | owner_burial | household_waste | rendering | unknown`) + opcional `facility` + form en `app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/fallecimiento/`. `createDeathRecordAction` valida y persiste |
| ✅ | Acquisition method en `pet_registered` — EAH 2018 trend tracking | shipped: `petAcquisitionMethodEnum` (`adopted | purchased | found_stray | gift | born_in_litter | other`) + columna `pets.acquisitionMethod` + validación Zod en `pet_registered.payload.acquisition_method` (`lib/events/event-schemas.ts:76`). UI en `PetForm` recolecta |
| ⚪ | DNI verification provider (RENAPER directo vs intermediary) | — |
| ⚪ | Mi Argentina integration — OAuth y/o emisión federada de credenciales | — |

### Infra & cross-cutting

| Estado | Feature | Ubicación |
|---|---|---|
| ✅ | Event sourcing hardening (Zod schemas estrictos + append-only triggers + validateEventPayload) | `lib/events/event-schemas.ts` + DB triggers |
| ✅ | Bidirectional geocoding (text ↔ map pin via Nominatim/OSM) | `components/LocationFields` |
| ✅ | Cron infra (CRON_SECRET + helper-lib + thin route) | `app/api/cron/*` |
| ✅ | RLS aplicada en todas las tablas PII/tenant (la lista viva es `RLS_REQUIRED` en el coverage test) — authz model documentado (Wave 5 Item 26) | migrations 0086 + 0105; `__tests__/rls/coverage.test.ts`; `e2e/cross-tenant-isolation.spec.ts` |
| ✅ | RLS smoke test cross-account vía PostgREST (extendido Item 26: pet_identifications, pet_transfers) | `pnpm rls:smoke` |
| ✅ | Unified `AppShell` (one role-variant chrome: citizen/operator/landing) — Item 7, strangler A→D complete | `components/layout/AppShell.tsx` + `lib/ui/shell-nav.ts` (auth-aware `resolveShellNav`). All surfaces migrated; legacy `LnOwnerNav`/`AppHeader`/`OpShell` deleted (Phase D). Plan: `docs/superpowers/plans/archive/2026-06-18-unified-app-shell.md` |
| ✅ | Localities catalog INDEC (catalog reference) | `ar_localities` table + `scripts/import-indec-localities.ts`; seeded via `db:bootstrap` step 4; graceful fallback + vendored-CSV override (`INDEC_LOCALITIES_CSV`). Runbook: `dim-interno:docs/ops/remote-supabase-bootstrap-runbook.md` §3 + `docs/ops/db-bootstrap-runbook.md` |
| ✅ | Public-credential resilience — `/p/[publicToken]` reads are budgeted and fail-soft; a partial/slow read renders an honest degraded state instead of a 500 or an infinite spinner | `app/(public)/p/[publicToken]/DegradedCredentialCard.tsx` + `CredentialStreamedSections.tsx`; structured single-line JSON error logging for Vercel via `lib/infra/report-error.ts` |
| ✅ | Durable rate limiting on public search endpoints (`rate_limit_buckets`, DB-backed, IP-and-endpoint keyed, cross-worker-safe) | `localities_search` (`src/modules/localities/application/search/search-localities.ts`), `performed_by_search` (`src/modules/search/application/performed-by/search-performed-by.ts`) |
| ✅ | `/refugios` public directory — Next Data Cache (`unstable_cache`, 300s) instead of an uncacheable per-request fan-out; invalidated on tag `"org-directory"` when an org is verified or revoked | `app/(public)/refugios/page.tsx` |
| ✅ | Web push v1 (VAPID) — best-effort second delivery leg for `severity='urgent'` notifications only (avistajes/hallazgos/custodia); in-app `notifications` table stays source of truth. Flag `NEXT_PUBLIC_PUSH_ENABLED` default **OFF**. iOS PWA push has its own platform limitations (Safari's install-to-homescreen requirement) — not solved by this, just not blocked by it | migration `0152_push_subscriptions.sql`; `public/sw.js`; `/cuenta` toggle; `lib/infra/web-push.ts` (urgent-only seam inside `lib/infra/notification-service.ts`, skipped for tx clients — ADR `docs/adr/2026-07-18-native-readiness.md` §4) |
| ⚪ | Native mobile via React Native sharing data layer | ADR `docs/adr/2026-07-18-native-readiness.md` — the API-exposability standing rule for when this lands |
| ⚪ | Agente conversacional con LLM (audio/text → intent → form prefilled) | Captura rápida ya cubre el path determinístico; LLM aterriza encima del mismo registry |
| ⚪ | Materialized views para proyecciones caras | — |

## Naming

DIM has a dual identity by design.

**User-facing brand: MiMAR (Mi Mascota Argentina).** This is what appears in app metadata, signup/login copy, the public credential header, notification titles, future marketing, and the domain (when assigned). The "Mi-" prefix is a deliberate alignment with the Argentine government services pattern (Mi Argentina, Mi AFIP, Mi ANSES) — communicating "your personal portal." The Spanish word "mascota" is what every Argentine pet owner uses; "Mi Mascota Argentina" is warm, familiar, and emotionally legible.

**Code identifier: DIM.** The original backronym ("Documento de Identificación para Mascotas") remains in code, schema, server actions, audit logs, internal docs, and the `public_token` format (`DIM-XXXX-XXXX`). DIM is a stable identifier we never rename — every issued token, every audit entry, every database row references it. The institutional descriptor "Documento de Identificación para Mascotas" also appears in the footer of the public credential page when an animal-health professional or government clerk views the document — it reinforces legitimacy in those contexts without changing the user-facing brand for everyday owners.

**Why the duality.** "DIM" alone sounds institutional/legal — good for credibility with vets and govt, cold for an owner adding their dog's first photo. "MiMAR" alone loses the document-credential framing that makes the credencial pública meaningful as official identification. Both names serve different audiences and contexts; keeping both serves the product.

**Mi Argentina alignment is the core premise, not a nice-to-have.** This project's reason to exist is to be the missing data layer that government animal-health programs (Mascotas CABA, SENASA zoonosis surveillance, eventually Mi Argentina itself) lack today. The product makes no sense as a standalone PWA forever — its trajectory points at official adoption. Every design decision is filtered through this premise:
- The credential is real enough that Mi Argentina could eventually issue it
- The data model is privacy-preserving enough that govt actors can use it under existing legal frameworks
- The brand alignment signals the direction
- The architecture supports federation when the integration becomes feasible

If you find yourself making a decision that breaks Mi Argentina alignment for short-term convenience, reconsider.

## Design rules (UI conventions)

The trilogy-unification design critiques (2026-05-27) codified the first four cross-cutting UI conventions; convention 5 (pet profile order) was added by the v2.1 reorder (2026-06-18). They apply to every new form, surface, or copy edit. The trilogy migration completed with the handoff-fixes series (#455–#479); the originating plan lives at `docs/superpowers/plans/archive/2026-05-27-trilogy-unification-handoff.md`.

### 0. Navigation & perceived performance (2026-07-04, nav-QOL audit N1)

Next 15.5's soft router silently drops navigations under load (fetch 200,
screen frozen). The repo carries three CURED navigation families — do not
choose by taste; classify the interaction and use its row:

| Interaction | Mechanism | Canonical file |
|---|---|---|
| Same route, query-only (`?sheet=`, `?tab=` with same SSR) | History API shallow: `pushSheetUrl` / `pushTabUrl` | `lib/ui/sheet-nav.ts` |
| Tab/filter whose SSR output differs | `UrlTabs` → `window.location.assign` | `components/ui/UrlTabs.tsx` |
| Post-mutation redirect from a server action | action returns `{ redirectTo }`; client calls `navigateAfterActionSuccess` | `lib/ui/full-page-action-nav.ts` |
| Ordinary cross-route link | `<Link>` (with `loading.tsx` on the target segment) | — |

Prohibitions: no `router.push`/`router.replace` for query-only state (drops);
no `router.refresh()` as post-mutation feedback on hot paths (same dropped
machinery — 53 files still do this; burn-down tracked, don't add more); no
raw `redirect()` in new server actions (use the `redirectTo` contract).
Print destinations (cartel, chapita) are full PAGES by design —
`window.print` needs a whole document, not a sheet.

Checklist for any navigable UI change: pending state within 100ms on async
controls; target segment has `loading.tsx` (or Suspense fallback) with the
final layout's footprint (`Ln*` vs `Op*` skeletons); scroll containers carry
`data-scroll-reset`; trámites end in `SuccessScreen`, never a mute redirect.

### 1. Two levels of location capture (L1 / L2)

- **L1 — jurisdiction only** (province + locality, derived from a single locality autocomplete against `ar_localities`). Used when downstream queries are jurisdiction-bounded but the exact point doesn't matter — e.g. owner upgrades to org, vet/clinical events, foster-volunteer availability. Component: `<LocationFields mode="l1">`.
- **L2 — Nominatim address autocomplete + map confirmation + derived jurisdiction**. Used when "where" matters as a coordinate — denuncia location, MarkLost last-seen, org-side incident reports. The autocomplete pick fills address + lat/lng + province + locality in one gesture; the map below is for visual confirmation and drag-to-adjust. Component: `<LocationFields mode="l2">`.

L3 (delivery-grade postal address) is **collapsed into L2** — no separate mode. L2 already carries address text plus coordinates; if a true delivery use case appears, revisit then. Critique-direcciones-2026-05-27 §Opción B closed the L3 fantasma.

Never invent a new mode; if a flow seems to need one, raise it in design rather than adding a third variant.

### 2. Four verbs for primary buttons

CTAs in any flow MUST use one of these verb shapes, in priority order:

1. **`Continuar`** — intermediate step inside a wizard (no commit yet).
2. **`Confirmar X`** — definitive, hard-to-reverse action that the user owns ("Confirmar cierre de medicación", "Confirmar elegibilidad", "Confirmar reemplazo de chip").
3. **`Crear X`** — creation that produces a new persistent object the user controls ("Crear consultorio", "Crear servicio").
4. **Verb-specific to the domain** when 1–3 don't fit, with the object included ("Registrar vacuna", "Publicar adopción", "Reportar mordedura", "Marcar como perdida"). Never bare ("Aceptar", "Guardar", "Publicar" on its own).

`Registrar X` is reserved for logging an observable event (medical, sighting). `Confirmar X` is reserved for definitive actions. Closing a treatment is `Confirmar cierre`, not `Registrar fin`.

### 3. `WizardShell` is the only multi-step chrome

Multi-step flows (≥3 sections, or ≥1 destructive step) MUST use `components/ui/WizardShell.tsx`. The shell owns the back arrow, the step counter, the progress bar's a11y label, and the optional cancel link. Step labels and submit-button copy are caller-supplied; consumers do not re-implement the chrome.

If a flow has only two screens (a form and a confirm), do not use the wizard — use a single page with a `<ConfirmDialog>` or a SuccessScreen.

### 4. `SuccessScreen` closes "trámite"-style flows

Denuncia, adoption application, intake, devolución, mordedura, and similar bureaucratic flows MUST end on `components/ui/SuccessScreen.tsx` (PR-011 onward). The screen surfaces the confirmation code, a short description of what happens next, and 2–3 contextual actions. Silent redirects after the final submit are forbidden for these flows — the user must see the receipt.

Lightweight inline edits (toggle, save profile field) keep their existing inline `<Toast>` confirmation; SuccessScreen is for full trámites only.

### 5. Operator action layer — omnibox + bulk-select (Wave 2 Item 10)

Operator surfaces (`/gob/*`, `/admin/*`) get from an aggregate to a single record via the **omnibox**, and act on many records via the **bulk bar**. Both are jurisdiction-aware and PII-disciplined.

- **Global search (`OpOmnibox`)** lives in the `OpTopbar` `actions` slot (mounted in `app/gob/layout.tsx` + `app/admin/layout.tsx`). Focus with `/` or ⌘K. It searches pets (name / DIM token / active microchip code), persons (name / DNI, via `searchUsers`) and cases (public code). Query is debounced 250ms; results are grouped by type and keyboard-navigable (`role="combobox"` + `aria-activedescendant`; dropdown `role="listbox"` + `role="option"`).
  - **Scoping is non-negotiable:** scope comes from `requireAdminOrGovtOrRedirect()`. Admin = universal; govt = their assigned jurisdiction(s); **govt with zero assignments returns empty without a DB hit**. Pet scope is `pets.jurisdiction_province ∈ assignments`; cases by `(province, locality)`; persons delegate to the audited `searchUsers` semi-join. Logic in `lib/infra/omnibox-search.ts`; auth + logging in `app/actions/omnibox-search.ts`.
  - **Every non-empty query logs one `pii_queried` audit row** via `logPiiQueryForAuthority(..., "omnibox")` — same trail as `/gob/usuarios`. `surface` is a JSONB payload value, not a column; new surfaces never need a migration.
  - Do NOT add a parallel search path that skips the scope or the log.
- **Bulk-select (`OpBulkBar { count, actions[] }`)** is the generic sticky action bar. It owns no selection state and calls no server action — the queue holds the selected `Set` and each action supplies `onRun(reason)`. Hidden at `count === 0`; otherwise shows "N seleccionados" + actions + "Limpiar". `role="region" aria-label="Acciones en lote"`; count `aria-live="polite"`.
  - **Selection state machine** is pure in `lib/domain/bulk-select.ts` (`toggleSelection`, `toggleSelectPage`, `isPageFullySelected`, `isReasonValid`, `selectionSummary`) — keep selection logic there, not inlined in components.
  - **Destructive actions require a reason whose minimum matches the actual server action** (`bulkRejectRequestsAction` ≥ 5; `bulkRevokeAction` ≥ 30 chars + ≥1 evidence attachment). The revoke flow keeps its evidence-upload modal — a reason-only `ConfirmDialog` cannot collect attachments. Never weaken these minimums in the UI.
  - The header checkbox selects the **page**, not the whole query, for irreversible/notifying actions.
### 6. Pet profile order: identity/credential → alerts (lost leads) → capture → faces

Updated by the pet-profile "two-face" redesign (2026-07-01; spec dim-interno:docs/design/handoffs/2026-07-01-pet-profile-two-face-lean-handoff.md) and the pet-document-redesign change (2026-07-02, S2/S3 — lost-as-case-block + anotar-as-sheet; DocFrame/Credencial/Libreta visual rewrite lands in a follow-up batch, this stub only covers the structural/navigation change). The owner profile at /mis-mascotas/[publicToken] is TWO FACES OF ONE DOCUMENT and MUST present blocks in this order:

1. **Credencial first (Face 1)** — one credential object (LnHero identity + compliance stamp row + printed QR, plus an owner-only Emergencia card with tap-to-call vet/emergency contacts when set) is the first content block in **every** non-terminal state, including lost (no separate cockpit page — see item 2). No conditional banner precedes it. Provenance gates the stamps (H1): a stamp reads "al día" only for professional/institutional-verified events. There is no separate mono-ID card and no "Inscripción válida" seal block — both were cut as redundant with the hero + stamp row.
2. **Avisos in one prioritized strip, LostCaseBlock leads it** — conditional alerts (rabies, transit/custody, open cases, pregnancy) collapse into a single <PetAlertStrip> BELOW the credential, ordered urgent → warning → info. When `pet.status === 'lost'`, `<LostCaseBlock>` (`components/pet-profile/LostCaseBlock.tsx`) is the FIRST urgent item — publicCode + public-credential link, owner-only "Marcar encontrada", last-seen + scans/sightings feed, and (owner-only) share/poster + disclosure toggles. There is no separate full-screen cockpit page anymore (`LostCockpit` deleted): the rest of the profile (faces, action row, Anotar sheet) stays reachable while lost. Org/vet viewers get the SAME block, read-only (no toggles, no Marcar encontrada, no /perdida update, no share/poster beyond public). Empty strip → renders nothing.
3. **Capture, then the two faces** — a single action row led by Anotar (owner-only, icon + label, same pill sizing as its siblings) followed by Compartir · Marcar perdida/encontrada · ⋯ Más (each with a leading icon), then the two faces: **Credencial · Libreta**. Since wave-3 P2 (2026-07-02, PO decision #645) there is NO visible tab title bar — the faces render inside one credential-style flip card (`FlipCard.tsx`) and its "Girar" button is the ONLY switcher, with a CONTEXTUAL icon (booklet while on Credencial, id-card while on Libreta) and full aria (descriptive label naming the target face + `aria-pressed`). Anotar's sticky mobile CTA is unaffected. Libreta is ONE timeline (future pinned on top → "— hoy —" → past) with three lens values (Todo · Vacunas · Oficial), but the visible chip set is role-scoped: **owners see Todo · Vacunas** (Oficial is org-only), **org-path viewers see Vacunas · Oficial** (Todo is owner-only); lenses filter, faces flip — no third navigation model. /libreta, /historial, /vacunas are permanent redirects to ?tab=…; ?tab=resumen→credencial, ?tab=vacunas→libreta+vacunas, ?tab=historial→libreta+todo (clamped to vacunas for org viewers), ?tab=libreta→libreta+oficial (clamped to todo for owners; unchanged for org viewers).
4. **Everything else lives behind "⋯ Más"** — permanent credentials (PPP, perro de servicio) render as compact rows on the credential; editar/transferir/buscar-hogar/devolución/viaje/ficha/contactos live in the ⋯ Más sheet. No section chrome on the document.

**Anotar is a sheet, not a page.** The canonical capture hub is `?sheet=anotar` (SheetMounter, reusing `app/(app)/mis-mascotas/[publicToken]/anotar/CaptureBox.tsx`) — triggered from the action row and the sticky mobile CTA, same mounting pattern as Compartir/Más/Marcar-perdida. `/anotar` survives ONLY as a fallback host page (deep links, e2e, the `/eventos/nuevo` redirect doctrine) rendering identical content via the shared `CaptureOptionsList` component — it is not the primary interaction anymore. `/eventos/nuevo` is a permanent redirect to `/anotar`; the `/eventos/nuevo/*` form sub-routes remain the URL-addressable form targets. Org viewers never get an Anotar entry point anywhere (action row, sticky CTA, or a hand-typed `?sheet=anotar` — SheetMounter denies it server-side for non-owner accessPath).
### 7. `AppShell` is the single role-variant application chrome (Item 7 — complete)

`components/layout/AppShell.tsx` is the **only** application chrome. The historical three chrome systems (`LnOwnerNav`, `AppHeader`, `OpShell`) have been deleted (Item 7, Phase D — PRs #630–#634). Do not reintroduce per-surface chrome wrappers.

- **Nav source is `components/layout/nav-presets.ts`** — `OWNER_NAV`, `PUBLIC_NAV`, `GOB_NAV(_SECTIONS)`, `ADMIN_NAV(_SECTIONS)`, `buildOrgNav`. Do not introduce per-component nav literals. `OWNER_NAV` is **2 items** — Mis mascotas→`/mis-mascotas`, Denuncias→`/denuncias/mias` (PO ronda 4, 2026-07-15). The former "Inicio" tab was REMOVED: `/inicio` is only a server-redirect into the most-urgent pet's credential, so the tab never highlighted (the carousel marks "Mis mascotas" active) and it bypassed the vet gate. The `/inicio` route stays (post-login landing + bookmarks + Asentar fallback); only the nav entry died. Supersedes the 2026-07-02 three-item split (decision #645). Each item owns a single, disjoint `matchPrefix`.
- **The variant + nav decision is auth-aware, not route-group-based** — `lib/ui/shell-nav.ts` `resolveShellNav(input)` is the single decision (pure, tested). Anonymous on a public surface → `citizen` + `PUBLIC_NAV`; a logged-in user on any surface (including public) keeps their **role** nav. A public surface must NEVER replace the role nav (fixes the stranded-logged-in-user dead-end). The separate "Volver a mi app" return chip only renders where the active nav has no equivalent destination of its own — token-landing surfaces (no nav at all) and the operator variant stranded on a public page (ADMIN_NAV/GOB_NAV/org nav have no pets-home link). **For an institutional role that chip goes to `roleHome(role)` — `/gob` or `/admin` — never `/mis-mascotas`**: `app/(app)/layout.tsx` redirects govt and admin away from the citizen tree, so pointing there advertised a destination the product refuses to serve (fixed 2026-08-08; see "Killing a flow" under Code conventions). The vet/owner-in-org branch keeps `/mis-mascotas`, which is correct — those roles are not redirected. For the citizen+owner/vet case, OWNER_NAV's own "Mis mascotas" item already IS the guaranteed ≤1-click return, so `showReturn` is never set there (the return chip used to duplicate it on every citizen page).
- **Three variants:**
  - `citizen` — top masthead with Argentina stripe + footer. Owner portal, public surfaces, marketing landing.
  - `operator` — left navy rail + topbar, no stripe/footer. gob / admin / org portals. **Exception — the situational console** (`/gob|admin/panorama`): a viewport-locked "fixed console" (`100dvh`, no page scroll; the map is fixed like the rail and fills everything except slim bars, with floating overlay chrome + a bottom dock). It is the one operator surface that never page-scrolls (v2C, `#21`).
  - `landing` — minimal trust chrome for token-landing surfaces (`/p/[publicToken]`, `/libreta/compartir/[shareToken]`, `/r/invite/[token]`): brand + stripe + "Credencial registrada en MiMAR". Auth-independent; a logged-in owner gets a discreet "volver a mi app".
- **"Inicio" is disambiguated**: the brand/logo → public landing `/`; the role home → the owner's "Mis mascotas" tab (`/mis-mascotas`; the `/inicio` route still redirects there or into the most-urgent pet), or the operator panel for gob/admin/org.
- **`#main-content`** (skip-link target) is preserved in every variant — do not drop it.

Spec: `docs/superpowers/specs/archive/2026-06-18-unified-app-shell-design.md`. Plan: `docs/superpowers/plans/archive/2026-06-18-unified-app-shell.md`.

### 8. "Limpiar todo" ≠ "Limpiar filtros" — they are different mechanisms (2026-08-08)

Both strings live on the same screen and a QA pass read that as an inconsistency. It is not, and unifying them would erase a real distinction:

- **"Limpiar todo"** sits on the active-filter chip row and clears **every axis at once** — period + action + actor in one click (`app/gob/historial/page.tsx`, `components/ui/dashboard/CasoEstadoFilter.tsx`).
- **"Limpiar filtros"** is the **empty-state's** action: the list came back empty *because of* a filter, so the way out is offered where the dead end is (`components/ui/EmptyState.tsx`, `CaseQueue.tsx`).

One is a control in a toolbar; the other is a recovery in an empty state. A screen can legitimately show both. Do not "fix" this.

### 9. The 44px touch floor is a FIELD rule, not a control rule (2026-08-08)

`components/ui/Field.tsx` and `components/ui/dashboard/OpField.tsx` put `min-h-[44px]` on their **`md`** density — the form default. `sm`/`xs` are deliberately exempt: they exist to sit inside table rows and queue toolbars, where 44px breaks the row rhythm, and both clear WCAG 2.5.8 AA (24px) on their own.

**Neither `LnButton` nor `OpButton` carries the floor**, on purpose. `md` is OpButton's default size, so a floor there silently grows every unsized button across `/gob`, `/admin` and `/org`. A button that must match a field's height says so at its own call site (see `DecomisoForm`'s "Buscar"). The file-input triggers (`OpFileInput`, `LnFileInput`) DO carry it — they are the file field's control surface, not buttons.

`e2e/mobile-390.spec.ts` asserts both floors separately; do not collapse them into one threshold.

### Drift policy

If a new feature seems to need an exception, write the exception into the PR description and link it from the relevant design critique doc (08/09/10) so the rule's footprint stays explicit. Mute exceptions are the path to drift.

## Open questions / future work

> Genuinely OPEN items only. Anything shipped moves to the Feature inventory;
> anything decided moves to the section that owns it. Struck-through change-log
> entries were pruned 2026-08-04 — this is not a diary.

- Mi Argentina integration: third-party OAuth via Argentina.gob.ar SSO when available, vs. eventual official credential adoption (see `dim-interno:docs/archive/mimar-go-to-market.md`)
- DNI verification provider when we get there (RENAPER direct vs. intermediary like Didit / Truora)
- **`/gob` portal** and **`/admin` portal** — built. `/gob` is govt scope-bound (locality approvals + regional dashboards via `requireAdminOrGovtOrRedirect()`); `/admin` holds universal-scope surfaces. Admin page spec v2.2 and the fases 10-14 follow-up plan are both archived (implemented). See Feature inventory → Admin & govt.
- **Lost-pet broadcast distribution** — Argentine channel mix (WhatsApp share-intent + Instagram Story template + barrio Facebook groups + verified-refugio voluntario alerts via `organization_coverage`). Animales BA interoperability is an open integration question; the goal is to complement it.
- **Cross-org transfer UX** — refugio-to-refugio handoffs need a sender-confirms / receiver-accepts flow. Event always emitted on completion (`custody_transferred`).
- Government dashboards: three audiences in scope (sanitary authority, analyst, welfare officer); build order TBD by where adoption lands first
- **Mascotas CABA program integration** — the GCBA's existing (non-digitalized) free-vet-attention program. DIM is the data layer it lacks; explore as a partnership path.
- **Dangerous breed registry export** — Ley CABA 4078 / Ley Prov 14.107. Pet flag + attestation event ✅ shipped; **export CABA ✅** (PDF para el RUPPPA que el titular emite desde la tarjeta PPP de la ficha — ver la fila de la tabla de features). **Pendiente**: el export de Prov. BA y el push automático al registro municipal/provincial. Spec abierta: nombrar cuando se priorice integración real.
- **Vaccination-due warning to owner** — when a vaccination approaches or passes its `next_due_at`. Confirmed via `docs/legal-framework-full.md` (2026-05-18 pass) that NO Argentine norm requires the system to warn — the obligation rests on the owner to keep vaccinations current (Ley 22.953, DL 8056, Ord. 41.831). A system-side warning is a UX feature, not a compliance requirement. Future spec if product decides to implement.
- Materialized views for expensive projections — keep event log as source of truth, cache when query latency justifies
- Lost/found feature expansion beyond simple status flip
- Push notifications (iOS PWA limitations — may need native shell eventually). EAH 2018 finding: social media is the dominant channel for pet-health info reaching households; shareability is first-order.
- Native mobile via React Native sharing the data layer
- Per-pet "emergency info" public flag toggle

- **Agente conversacional con LLM (deferred, future)** — Layer on top of the captura-rápida registry: same `EVENT_CAPTURE_REGISTRY` becomes tool definitions for Claude/GPT; the local matcher stays as offline fallback. **Forward-compat that holds today:** (a) every event-creation route is URL-addressable with query-param prefill — new event forms MUST accept their payload fields as `searchParams` and register their slots in `event-capture-registry.ts`. (b) Per-event-type Zod schemas (`lib/events/event-schemas.ts`, `validateEventPayload`) double as function-calling tool definitions — the same schema validates the human form submit and any future LLM structured output. (c) The slugs at `/mis-mascotas/[token]/eventos/nuevo/*` are public contract — rename before launch, freeze after. **Design principles when the LLM lands:** agent proposes, user confirms — never silent writes to `pet_events`; audio is not persisted (events are the source of truth, not the recording); the agent reads as well as writes — natural-language queries open filtered timeline projections, not a parallel chat surface. Legally-fraught events (`abandonment_reported`, `maltreatment_reported`, `dangerous_breed_attested`) are out of agent scope — those force the full manual flow with all disclaimers visible. LLM provider, hosting jurisdiction, voice (Web Speech API) and iOS PWA audio fallback TBD when implementation lands.
## Test-runner conventions (Item 29 — Wave 5)

These conventions were locked after fixing chronic worker-exit errors and suite
instability (Item 29, 2026-06-19). Respect them to keep the suite green and fast.

### Two-project split (unit vs db)

`vitest.config.ts` defines two Vitest **projects** instead of one suite running
`fileParallelism:false` globally (the old suite paid the serial + DB tax on
every file, even the ~44% that never touch Postgres):

- **`unit`** — files whose transitive import graph provably never reaches
  `db/index.ts`. Runs in **parallel** (default workers), `setupFiles:
  __tests__/setup-env.ts` (env-only, no `DATABASE_URL`/`SUPABASE_URL` forcing,
  no pool-drain `globalSetup`). See the run's own summary for file counts and timing.
- **`db`** — files that do reach the DB client. Runs **serially**
  (`fileParallelism: false`), `setupFiles: __tests__/setup.ts` (URL-forcing) +
  `globalSetup: __tests__/global-setup.ts` (postgres.js pool-drain teardown) —
  byte-for-byte the old behavior. See the run's own summary for file counts and timing.

Membership is **mechanical, not a maintained manifest**:
`__tests__/db-reachability.ts` (`computeTestPartition()`) walks the import
graph from every test file via reverse-BFS and classifies by reachability of
`db/index.ts` plus its own DB-signal heuristics (including Supabase client
imports). It is recomputed on every `vitest` invocation — nothing to drift —
and guarded by `__tests__/project-partition.guard.test.ts`.

Scripts: `pnpm test:unit` (`vitest run --project unit`), `pnpm test:db`
(`vitest run --project db`). Bare `pnpm test` (`vitest run`) still runs both
projects in one pass, as does `pnpm test:coverage` (coverage is a root-level,
cross-project concern in Vitest 4).

### DB connection pool

`db/index.ts` applies a **test-mode pool cap** when `VITEST=true` or
`NODE_ENV=test`:

- `max: 3` — prevents exhausting the local Supabase limit (100 connections)
  across the `db` project's serial files.
- `idle_timeout: 20 s` — returns connections quickly between files.
- `max_lifetime: 60 s` — recycles long-lived connections.
- `connect_timeout: 10 s` — fails fast when the local stack is not running.

In production none of these apply; Supavisor/pgBouncer sits in front anyway.
This pool cap only matters to the `db` project — `unit` files never open a
pool.

### `globalSetup` — what it actually does

`__tests__/global-setup.ts` is registered as `globalSetup` in `vitest.config.ts`.
It runs in the MAIN process, once, around the whole suite:

- **Sets `VITEST=true` before any test file imports `db/index.ts`**, which is what
  activates the bounded pool config above. This is the load-bearing one — the cap
  has to be in place before the first pool is constructed.
- **Forces `DATABASE_URL` to the local stack** when it is unset or not pointing at
  `127.0.0.1`. Per-file `setup.ts` does this for workers; `globalSetup` runs first,
  so the value is right from the very beginning.
- **Sweeps eventless pet rows** left behind by an aborted earlier run, before the
  suite starts, and logs what it removed. Debris with no spine event is what
  invariant #3 forbids and what `pnpm lint:spine` fails on for everybody sharing
  the local database.

**Its `teardown()` does NOT drain the pool.** It is an explicit no-op, and says so
in the file: globalSetup runs in a different process from the worker that owns the
postgres.js pool, so it has no handle to reach. This page claimed the opposite for
some time and sent people investigating the "Worker exited unexpectedly" defect at
the wrong process. Pools are drained **per test file** by `closeDbPools()` in
`__tests__/setup.ts` — that is the code to read, and the change that recovered 5
tests previously lost with the sockets. See `docs/ops/local-dev-runbook.md`.

**Do not remove the `globalSetup` entry** — not for teardown, which does nothing,
but for the three things in the list above.

### Pet-cache fitness sweep scoping

`__tests__/pet-cache-rederivation.test.ts` Layer 1 sweeps only pets whose
`publicToken LIKE 'DIM-%'` (seed pets created by `generatePublicToken()`). It
does NOT sweep all pets in the DB — that makes the sweep state-dependent on
other test files' cleanup and causes intermittent flakes. The fitness signal is
preserved because seed pets go through the REAL writers.

**Do not change the sweep back to `SELECT * FROM pets`** — the flake returns.

### Pet-cache sweep: skip bootstrap pets from outside the sweep

If bootstrap creates pets whose `publicToken` does not start with `DIM-`
(e.g. direct INSERT with a synthetic token), the sweep ignores them by design.
Use `generatePublicToken()` from `lib/infra/publicToken.ts` for any seed pet whose
cache fitness you want CI to enforce.

### Migration idempotency

Migration `0084_drop_legacy_chip_tattoo_columns.sql` now drops
`pets_microchip_lookup_idx` (created by 0012) before dropping the
`microchip_id` column. This makes the migration succeed cleanly on a fresh
migration-order run (not just on a drizzle-kit-push-first bootstrap).

All migrations use `IF EXISTS` / `IF NOT EXISTS` guards — do not remove them.

### Fences (the `pnpm verify` chain)

`pnpm verify` is `typecheck && lint` + **every `lint:*` fence in package.json** (<!-- fact:verify_fences -->81<!-- /fact --> — counted out of the `verify` script itself by `pnpm facts:write`; package.json remains the source of truth and this marker is regenerated from it) + `build`, in
that order (`package.json` → `verify` script is the literal source of truth —
read it before assuming this list, it grows). Each fence is a standalone
`pnpm lint:<name>` script so it can be run in isolation while iterating.

Long-standing fences (pre-dating this section): `lint:tokens`, `lint:locality`,
`lint:timezone`, `lint:ui`, `lint:professionalism`, `lint:authz`,
`lint:events`, `lint:authz-scoping`, `lint:authz-subsumption`,
`lint:authz-orgtoken`, `lint:deps`, `lint:rls`, `lint:actions`, `lint:lib-root`,
`lint:mocks`, `lint:buttons`, `lint:nav`, `lint:notifications`,
`lint:db-budget`, `lint:metric-labels`, `lint:opened-reason`.

**The non-obvious ones, spelled out** (the rest are self-describing from their
script name — read `package.json`, do not trust an inventory here):

| Fence | Rule you must follow |
|---|---|
| `lint:lib-root` | **Nothing new goes in `lib/` root.** Every module lives in a bucket by role: `lib/domain` (pure rules), `lib/infra` (I/O, DB, external services), `lib/reference` (static catalogs), `lib/analytics`, `lib/events`, `lib/ui`, `lib/utils`. This is why a doc citing `lib/foo.ts` is always stale. |
| `lint:spine` | Invariant #3, checked against the live DB: every `pets` row must have its `pet_registered` event. A cache row with no spine event is a cache outranking the log. |
| `lint:action-redirect` | Server actions RETURN `redirectTo` (the N3 contract); they do not call `redirect()` themselves. |
| `lint:csp-prerender` | No prerendered page may exist — every route needs a per-request CSP nonce. |
| `lint:amendment-overlay` | Every reader of an AMENDABLE payload folds corrections: a `replayPetWeight/Pregnancy/Jurisdiction` caller calls `overlayAmendments` and fetches `event_amended`; any other raw `petEvents.payload` reader of an amendable type is classified in the script (via / other-type / raw-by-design / debt). A new raw reader fails. |
| `lint:ci-parity` | The fences CI runs must equal the fences `verify` runs; drift here is how a gate goes quiet. |
| `lint:seed-ids` | Static twin of `check-seed-hygiene`: no seed script may write a seed-marker literal into a RENDERABLE column (displayName/description/name), so demo scaffolding can never surface as real content. |

**New fences, waves S + M:**

| Fence | Script | Guards |
|---|---|---|
| `lint:file-size` | `scripts/check-file-size.ts` | File-length ratchet |
| `lint:maplibre` | `scripts/check-maplibre-locale.ts` | MapLibre strings stay es-AR, no hardcoded English map chrome |
| `lint:hard-nav` | `scripts/check-hard-nav-anchors.ts` | No raw `<a href>` hard-navigation where client routing is expected |
| `lint:tablist` | `scripts/check-tablist-ratchet.ts` | `role="tablist"` a11y pattern ratchet |
| `lint:eyebrow` | `scripts/check-eyebrow-title.ts` | Eyebrow/title heading convention |
| `lint:uuid` | `scripts/check-uuid-literals.ts` | No hardcoded UUID literals outside seeds/tests |
| `lint:plural` | `scripts/check-pluralize-es.ts` | Spanish pluralization helper used instead of ad-hoc `s`-suffixing |
| `lint:dupes` | `scripts/check-duplication.ts` | `jscpd` duplication ceiling — 7% |

**Biome, `biome.json`** additions worth knowing about (verified against the
file, not the plan that proposed them):

- `noExcessiveCognitiveComplexity` — `maxAllowedComplexity: 25` by default;
  a per-file `overrides` entry raises the ceiling to `160` for **138 files**
  (pre-existing complexity the ratchet grandfathers rather than blocks;
  extending this list back down is a tracked cleanup, not a blocker).
- `noUnusedVariables` / `noUnusedImports` — `error` by default, with narrow
  per-file `off` overrides for known exceptions.
- `nursery.noRestrictedImports` on `src/modules/*/domain/**` (no `@/db`,
  `drizzle-orm`, `next*`, `server-only`) **and now also on
  `src/modules/*/application/**`** (no `next*`/`server-only` — see ADR
  [`docs/adr/2026-07-18-native-readiness.md`](./docs/adr/2026-07-18-native-readiness.md)
  Decision 1). The application-layer fence has a 46-path `off` override for
  use-cases grandfathered in before the rule landed — new use-cases don't get
  added to that list; the goal is 0.

### Test suite state

The suite spans both vitest projects (see the two-project split above); `pnpm test` prints the live file count. A
theater audit (mutation-probe + matrix sweep) found the suite under 0.5%
theater. **Review rule that came out of it: no self-referential assertions** —
a test must assert `f(x)` against an independently-stated expected value, never
against a value derived from the code under test (e.g. re-deriving the
expected string from the same template the production code uses defeats the
test). See `docs/agents/README.md` for where this is enforced as a review
convention.

---

## Privacidad y manejo de datos

**Per-task privacy gate:** before touching any public route, token, or PII field, verify each rule below applies correctly to the change. The enforcement file column is the canonical place to check or extend the rule.

### 1. No DNI in plaintext

Migration `0106_dni_less_identity.sql` dropped `profiles.dni_number`. The DNI is never stored in cleartext.

| Rule | Enforcement |
|---|---|
| Equality matching → `WHERE dni_hash = hashDni(input)` | `lib/utils/dni-hash.ts` → `hashDni()` |
| Human disambiguation (operator UI only) → `dni_last4` | `lib/utils/dni-hash.ts` → `dniLast4()` |
| Subject erasure → nulls `dni_hash`, `dni_last4`, `miarg_sub` | `erase_subject_data()` (migration 0106) |
| Institutional accounts → `dni_hash IS NULL` (CHECK enforced) | `profiles_institutional_no_pii` constraint |

> **Production warning:** set `DNI_HASH_PEPPER` in Vercel env before real DNI data lands. The local/test default is `dim-test-pepper-v1`. If the pepper differs, every hash in the table mismatches — the DNI space is finite and reversible via rainbow table.

### 2. RLS backstop for every new PII / tenant table

| Step | Where |
|---|---|
| Enable RLS in the SAME migration that creates the table | `ALTER TABLE … ENABLE ROW LEVEL SECURITY` (fenced by `pnpm lint:migration-rls`) |
| Add to coverage test | `__tests__/rls/coverage.test.ts` → `RLS_REQUIRED` |
| Add appropriate policies (or document deny-all with reason) | a forward-only `db/migrations/NNNN_*.sql` — never `db/*_rls.sql`, which are reference-only and never applied |
| If the table belongs to an owner, add to cross-tenant e2e probes | `e2e/cross-tenant-isolation.spec.ts` |

Service-role / `postgres` connections bypass RLS by design (`BYPASSRLS`). Enabling or tightening an RLS policy cannot break the app — Drizzle server-action queries go through the BYPASSRLS connection. RLS fires only for supabase-js / PostgREST (defense-in-depth backstop). See [§ Authorization architecture](#authorization-architecture-wave-5-item-26).

### 3. Never return raw event payloads

Project only the fields callers need; never return a raw `payload` JSONB blob.

| Rule | Enforcement |
|---|---|
| Adoption review → return `{ id, applicantUserId }` only (Item 27) | `src/modules/adoption/infrastructure/adoption-repository.ts` |
| Audit any new DB read for `payload->>` over-exposure | `grep -rn "payload->>"` before shipping |

### 4. Privacy predicates in the query, not the render layer

Push visibility decisions to SQL — do not fetch then redact in JS.

| Rule | Enforcement |
|---|---|
| Lost-listing: location fetched only for pets with `discloseLastLocationWhenLost=true` (Item 27) | `src/modules/lost/infrastructure/lost-listing-read.ts` |
| Welfare public comprobante: coarse coordinates for anonymous audience; exact + logged for authority — established contract per plan `2026-06-19-welfare-coordinates-precision.md` | `app/(public)/denuncias/codigo/[code]/page.tsx` (open PR) |

### 5. Scan events — strict payload contract + 90-day TTL purge

Updated by Task #45 (scan-location capture, PO decision obs #733): scans now carry anonymized location, under these rules.

| Rule | Enforcement |
|---|---|
| Scanner-role payload = `{ is_self_scan, viewer_authenticated, scan_ip_area, scan_coords?, scan_accuracy_m? }`. Never the raw IP. | `src/modules/pets/application/scans/log-scan.ts` |
| `scan_ip_area` is coarse (city precision max), derived from platform geo headers only — the raw IP is never read into the payload | `lib/infra/scan-geo.ts` |
| `scan_coords`/`scan_accuracy_m` are NEVER written (W8, PO 2026-09-24: no device location anywhere) — the scan action takes no coordinate; the schema keeps them only for pre-W8 events | `src/modules/pets/application/scans/log-scan.ts` + `scripts/check-no-device-gps.ts` |
| Scanner-role rows are hard-anonymized: `recorded_by_user_id = NULL` always (no scanner identity link, even when authenticated) | `src/modules/pets/application/scans/log-scan.ts` |
| Self-scans (`author_role='owner'`) carry NO location fields — they are identity-linked and exempt from the purge | `src/modules/pets/application/scans/log-scan.ts` |
| `author_role='scanner'` events purged after 90 days — this bounds retention of ALL scan-location fields | `lib/infra/scan-retention.ts` + cron `/api/cron/purge-scan-events` |
| Self-scans (`author_role='owner'`) are NOT purged — part of owner's own history | `lib/infra/scan-retention.ts` |
| Every purged row produces an `audit_log` entry (`action='scan_event_purged'`) | migration 0104 trigger |

### 6. k-anonymity on all public aggregates

Any jurisdiction-grouped aggregate returned to a public or analyst surface must pass through `suppressSmallCells` with `k=5`. The `SuppressedCells` branded type makes it a compile-time error to return a raw cell array without suppression.

| Rule | Enforcement |
|---|---|
| `suppressSmallCells(rows, { k: 5 })` on every public aggregate | `lib/metrics/anonymity.ts` → `suppressSmallCells` |
| Govt outreach pipelines log `pii_queried` per query | `lib/infra/outreach-pipelines.ts` → `logOutreachPiiQuery` |
| The adopter-DNI desk check logs `pii_queried` (surface `adopter_dni_check`) with the **hashed** DNI + `organization_id`, and is capped per organization | `src/modules/adoption/actions.ts` → `checkAdopterAccountAction`; the ceiling is `ADOPTER_DNI_CHECK_LIMITS` in `src/modules/adoption/domain/dni-check-policy.ts` (it may NOT live in the `"use server"` module — see `lint:server-exports`). It is a READ, so `lint:audit-log` (which derives mutating actions) cannot see it — the trail is the only thing that makes the confirmation oracle over `profiles.dniHash` accountable (D4, 2026-08-23) |
| **Name your denominator** — every aggregate names what it excludes AND against which denominator it is computed; coverage % carries the double denominator (registry + estimated census). See [§ Dashboards design law](#dashboards--projections-the-consumers). | `lib/metrics/census.ts` → `computeCensusCoverage`; `lib/analytics/govt-home-kpis.ts` → `fetchRabiesCoverage` |

### 6b. Cuidador temporal — PII de un TERCERO en la ficha de una mascota ajena

`pet_caretaker_grants` (migración 0189) es la primera tabla del producto donde el titular escribe datos personales **de otra persona**. Tres campos y una regla cada uno.

| Campo | Qué es | Regla |
|---|---|---|
| `caretaker_email` | El correo del invitado, **tipeado por el titular**. Puede pertenecer a alguien que ni siquiera tiene cuenta en miMAR. | Bajo `pii.apply_baseline` (0189). Se muestra al titular en su propio panel de cuidado; nunca en una superficie pública ni a un tercero. La página de invitación se lo niega incluso a quien tiene el link: si no sos parte, no ves ni la mascota ni el titular. |
| `note` | Texto libre que el titular le escribe al cuidador ("Pampa toma media pastilla a la mañana"). | Puede traer datos de salud y rutinas del hogar. **Se desnormaliza dentro del payload de `caretaker_designated`** — a propósito: la espina tiene que seguir diciendo qué se acordó al empezar. Consecuencia que hay que tener presente: es texto libre dentro de un evento append-only, así que cae bajo §3 (nunca devolver un `payload` crudo) y no es editable ni borrable después. |
| `public_contact_consent_at` | **Llave 2** del modelo de dos llaves. Marca de tiempo, capturada en el ACCEPT. | Publicar el contacto de un cuidador en una credencial pública es el titular consintiendo por otra persona. Hacen falta DOS llaves: la del cuidador (esta) y la del titular (`pets.disclose_caretaker_contact_when_lost`, migración 0193). Sin la llave 2 **el toggle del titular ni siquiera se renderiza** — un switch que no puede cambiar nada es una mentira con forma de control. Predicado único: `lib/infra/caretaker-public-contact.ts`. |

**HUECO CERRADO — migración 0205 (2026-08-27).** `pet_caretaker_grants` ya figura en los dos RPC. La pregunta que estaba abierta ("qué significa borrar un grant cuando el sujeto es el CUIDADOR y no quien lo otorgó") se respondió así, y las tres mitades importan:

| Sujeto | Qué hace `erase_subject_data` |
|---|---|
| **Invitado** (por cuenta o por email) | Invitación `pending` → `rejected` con `responded_at`. Centinela `erased@invalid.local` en `caretaker_email`, en **todos** los estados. |
| **Otorgante** | Invitación `pending` → `cancelled`. `note` → NULL. El `caretaker_email` **no se toca**: ahí es el correo de un TERCERO (mismo criterio que §6c). |
| **Los dos, con el grant `accepted`** | **No lo toca el RPC.** Terminar un cuidado aceptado son TRES escrituras que van juntas —cerrar la fila de `ownerships`, emitir `caretaker_ended`, girar el grant— y existe **una sola** definición de eso: `endCaretakerGrantAtomically()` en `lib/infra/end-pet-ownerships.ts`. Un flip de estado en SQL sin evento deja un grant que la espina no puede explicar (`detect-pet-cache-drift` lo reporta como `pet_caretaker_ownership_drift`). Así que el cierre lo hace `erase-subject-data.ts` **antes** de llamar al RPC, por ese único escritor. La línea es la del propio dominio: *accepted* debe un hecho a la espina, *pending* es estado de flujo y no debe nada. |

`caretaker_user_id` tampoco se anula: el perfil al que apunta queda soft-deleted y anonimizado, nada borra perfiles en duro, y `pet_caretaker_grants_accept_check` (0192) convierte ese NULL en violación de constraint sobre una fila `accepted`/`ended`. Mismo trato que `pet_transfers`.

**Y la clase de omisión ya no es invisible para CI.** `pnpm lint:subject-rights` (`scripts/check-subject-rights-coverage.ts`) enumera **todas** las tablas de `public` del catálogo vivo y obliga a que cada una esté declarada en exactamente una de cuatro listas — `IN_EXPORT`, `IN_ERASE`, `EXEMPT` (con razón escrita) o `KNOWN_GAP` (con nota) — y verifica las dos primeras **en las dos direcciones** contra `pg_get_functiondef`. Una tabla nueva que no esté en ninguna lista es rojo. Deriva de `pii.apply_baseline` **a propósito no**: solo seis tablas están bajo la baseline y los RPC alcanzan bastante más — el número exacto está en la cabecera de la fence, cercado contra sus propias listas. **La fence prueba MENCIÓN, no que el predicado sea el correcto** — lo dice ella misma en su cabecera y en su línea verde; eso lo prueban los tests de integración. El `KNOWN_GAP` de hoy es deuda nombrada y no cobertura; **cuántas tablas tiene lo dice §7, que es el único lugar de este documento que lleva ese número**.

> **Este párrafo afirmaba que los RPC alcanzaban dieciocho, y ponía el registro de deuda en veintiuna. Las dos cifras eran falsas, y la segunda se contradecía con §7 cuarenta y seis líneas más abajo, que ya decía la buena.** El lint sobre la base viva mide 22 alcanzadas y 17 en deuda (medido 2026-08-29: `54 public tables classified; 22 reached by a subject-rights RPC (20 in export, 19 in erase); 15 exempt; 17 declared KNOWN_GAP`). Es la tercera vez que esta cifra se pudre en este mismo tema, así que la corrección no fue reescribir los literales: §6b ya no lleva ninguno, §7 lleva uno solo, y ese uno lo cerca `__tests__/documented-subject-rights-counts.test.ts` contra `Object.keys(KNOWN_GAP).length`. Un número que hay que mantener a mano se pudre; la única pregunta útil es cuál de las dos puntas se deriva de la otra.
>
> Esa cerca es también la razón por la que este párrafo no cita textualmente las dos frases viejas: barre **todo** el documento buscando una cantidad pegada a `KNOWN_GAP` y no distingue una cita de una afirmación — se puso en rojo con la primera redacción de esta misma nota. Es el comportamiento correcto. Un número equivocado que se lee como vigente no deja de leerse así porque el párrafo que lo rodea diga que era un error.

### 6c. Reportar contenido — moderación sin cuentas, y sin hueco nuevo de borrado

El feed de modo perdida trae dos clases de fila escritas por **desconocidos anónimos**: el avistaje (`/p/{token}/sighting`) y el "la tengo" (`/p/{token}/encontre`). No hay cuenta detrás de ninguna: `LostFeedItemV1` no lleva user id porque no existe. De ahí salen las dos decisiones que definen esta función.

**Se reporta un ÍTEM, no una persona.** "Bloquear al usuario" no tiene sujeto. La única analogía honesta sería una válvula que corte los reportes de esa mascota, y una válvula es una defensa que nadie usa justo cuando la necesita: quien está buscando a su animal no va a cerrar el canal por donde puede llegar el mensaje que lo encuentra. Reportar un ítem y que desaparezca del propio panel es la protección que sí se usa.

**"Reportar", nunca "denunciar", en toda la copy.** En este producto `denuncia` ya nombra una denuncia por maltrato (Ley 14.346) con nueve tipos, cuatro severidades y ruteo a una autoridad real (`src/modules/welfare/**`). Usar esa palabra en un botón que oculta un mensaje prometería un expediente que no existe. Fence: `apps/mobile/src/lost/lost-view-model.test.ts` recorre toda la copy de la función y falla ante cualquier `denunci`.

**Ocultar es una DERIVACIÓN, no una mutación.** El evento reportado no se toca — el invariante #2 lo prohíbe y el trigger `enforce_pet_events_append_only` lo hace imposible. Se agrega un `content_reported` que nombra la fila en `payload.target_event_id`, y **toda** lectura que pueda devolver esa fila la resta (`lib/infra/content-reports.ts::notReportedClause`). La regla es una frase y **sólo sigue siendo cierta si se aplica en las doce**: *un ítem reportado no se MUESTRA en ninguna superficie que renderice lo que alguien escribió, no se cuenta en los contadores de esas superficies, y no es el titular de "última vez vista"*. Lo que **sí** sigue haciendo: existir, y ser contado por los agregados del Estado — ver las exenciones más abajo. Decir "no se cuenta" a secas era una sobreafirmación: cinco lecturas de gob/admin cuentan la fila (tipo, mes, rol del autor, token) y dos la grafican como punto en el mapa. Ninguna selecciona `payload`, así que no se filtra ninguna frase.

> **Cómo se contó mal la primera vez.** La primera entrega aplicó la cláusula en **cuatro** lecturas y el comentario decía "toda lectura". Una revisión a contexto fresco encontró **ocho**; al re-enumerar contra el árbol aparecieron **diez**; y escribir la fence —que obliga a clasificar cada candidato en exactamente una de tres listas— encontró las **dos** últimas: la tira de "últimos movimientos" del panel del dueño (sin filtro de tipo, renderiza `payload.text`) y la página de detalle de un evento, que hace su propia lectura sin pasar por el loader. Total: **doce consultas en diez archivos**, más **cuatro** exenciones declaradas. Las que no había visto ninguno de los dos son las que más duelen: la exportación de la libreta, el **compartir Tier-2 que abre un veterinario**, y las dos que encontró la fence. Por eso la cláusula ya no vive en `lost-mode.ts` ni recibe un `petId`: correlaciona contra la fila misma, así que sirve en una consulta scopeada por `pet_id`, por `case_id` o por `id`. Un helper con parámetro es una forma de equivocarse; uno que no se puede aplicar a una consulta por `case_id` es un helper que esa consulta simplemente no va a usar.

Las doce lecturas están enumeradas en el docblock de `content-reports.ts` y verificadas por `__tests__/content-report-read-coverage.test.ts`, que deriva la lista del código y falla en las dos direcciones. Las dos peores que faltaban:

| Fuga | Por qué era grave |
|---|---|
| `lib/infra/case-queries.ts` → `/casos/{code}` | `lost_pet_episode` está en `PUBLIC_ANONYMOUS_KINDS`: la línea de tiempo del caso la lee **cualquiera** que tenga el código CAS, y los códigos CAS se comparten justamente para difundir una búsqueda. El mensaje agresivo salía del feed y de los dos overlays y se quedaba, textual, en una URL anónima. |
| `src/modules/lost/infrastructure/lost-listing-read.ts` → `/perdidas` | Rompía **el escenario canónico de este mismo mecanismo**: quien tipeó mal su domicilio en "actualizar dónde la vieron" lo bajaba de la credencial y seguía en la tarjeta pública — y las dos superficies públicas quedaban en **desacuerdo**, porque la credencial cae al update anterior y `/perdidas` mostraba el reportado. |

**Siete exenciones, declaradas.** **Seis son agregados para el Estado**: el mapa de panorama y su historial (`repository-by-unit.ts` —que además grafica los PUNTOS individuales—, `repository-histogram.ts`, `repository-history.ts`) y tres lecturas de gob/admin que cuentan o listan la existencia de la fila (`lib/analytics/dashboards/perdidas.ts`, `lib/analytics/dashboards/exports.ts`, `lib/metrics/event-ledger.ts`) — un punto y un número, nunca la frase de nadie: **ninguna de las seis selecciona `payload`**. La séptima es el **writer** (`report-lost-feed-item-use-case.ts`): tiene que ver la fila que está reportando para validarla. Dejar que un dueño borre puntos de un mapa oficial reportándolos sería un control de moderación con alcance jurisdiccional que nadie pidió. **La consecuencia se dice en voz alta**: el panel del dueño puede leer "2 avistajes" y un tablero de gob contar 3. Son dos denominadores para dos audiencias — lo que la ley de diseño "nombrá tu denominador" ya permite; lo que no permite es que la divergencia sea una sorpresa.

> **Esta lista decía "cuatro" y nombraba `repository-scope.ts` — un archivo SIN NINGUNA CONSULTA.** Era la sexta repetición del mismo error en esta misma entrega, y estaba adentro de la prosa escrita para condenarlo: el párrafo de arriba ya decía doce lecturas y esta tabla seguía en cuatro. `repository-scope.ts` es un constructor de predicados; los que leen son los tres repositorios que lo importan. La lista viva —la única que no puede mentir— es `DECLARED_EXEMPTIONS` en `__tests__/content-report-read-coverage.test.ts`, que la fence verifica contra el árbol en las dos direcciones. **Si esta prosa y esa lista no coinciden, la prosa está mal.**

**El ocultamiento es GLOBAL a la mascota, irreversible y sin vista de "ocultos".** No es un mute por espectador: el ítem se va del registro para todos los que lo leen — a propósito, porque un feed por espectador serían dos verdades sobre una sola espina. No hay des-reportar: la corrección es una regla de lectura futura, porque la espina no se edita. **Por eso el camino ORG está prohibido en LAS DOS PUERTAS** — `checkCommandGuard` para la API que usa el celular, y `reportLostFeedItemAction` para la web (espejando `reactivate_search`, que ya se refuta ahí igual): con el ocultamiento global, una organización con `shelter_custody` podía hacer desaparecer un "tengo a tu perro, llamame" del panel del **dueño**, en silencio y sin aviso — una palanca apuntada al momento exacto en que una búsqueda está por terminar, en un producto que tiene disputas de custodia como concepto de primera clase. El cuidador la conserva: lo invitó el titular, con el modelo de dos llaves.

> **Cómo se rompió esto una vez, para que no se repita.** La refutación ORG salió sólo en la puerta de la API. La web quedó abierta: `requirePetAccess` responde ok para el camino org y ni siquiera chequea `event.write` (esa compuerta vive en `requireAlivePetAccess`, que esta acción no llama), y el caso de uso no tiene refutación por rol de autor a propósito. Que el componente **escondiera el botón** en la variante org no cerraba nada: la acción se importa y se bindea a nivel de módulo en un componente que renderiza en las dos variantes, así que su action id viaja igual al cliente org y se puede POSTear. **Un botón escondido no es un control de autorización.** Y durante dos revisiones, tres documentos —esta sección, el cuerpo del commit y el docblock de `content-reports.ts`— afirmaron que el control existía. Un control afirmado en prosa no es un control; la assertion que ahora lo sostiene es `__tests__/actions/report-lost-feed-item-action-authz.test.ts`.

**Qué significa para Data Safety: NO abre un hueco nuevo.** Fue el criterio que eligió el mecanismo por encima de una tabla de moderación aparte.

| Pregunta | Respuesta |
|---|---|
| ¿Es borrable bajo `erase_subject_data`? | **Sí, sin tocar la 0170.** `content_reported` es una fila de `pet_events`, tabla que el RPC ya enumera: desde la 0240 transforma cada clave del payload según su clase de privacidad (ver §7). |
| ¿Y el texto que escribió quien reporta? | **Desde la 0240 (T3-A2b) se borra por clase, no por nombre de clave.** `content_reported.reason` está clasificado `personal_data` → centinela en `lib/events/payload-privacy.ts`, y el RPC alcanza toda fila que el sujeto **escribió**, en cualquier mascota. *Nota histórica:* hasta la 0240 el RPC centinela-reemplazaba `reason` por nombre en todos los tipos de evento, y por eso `tag_revoked` tuvo que evitar esa clave; ese barrido por nombre destruía el `reason` enum de `microchip_replaced`, `foster_ended`, `custody_transferred` y `custody_transfer_proposed`. |
| ¿Y el mensaje del desconocido que fue reportado? | Sigue donde estaba. No es dato del sujeto que reporta y el spine no borra. Reportar oculta; no es una vía de supresión de datos ajenos. |
| ¿Se borra el `reason` de **cualquiera** que reporte? | **Sí, desde la 0240.** El alcance S1 (`recorded_by_user_id` = sujeto, cualquier mascota, siempre) cubre al cuidador y al ex-titular que reportan y después borran su cuenta. *Nota histórica:* `0170:326-331` barría `reason` sólo en las mascotas con `role='owner'` sin `ended_at`, y ese era el hueco que esta fila dejaba escrito. |
| ¿Hizo falta una migración? | **No.** `pet_events.event_type` es TEXT sin CHECK ni enum (dicho en `0189:23`), así que sumar un tipo de evento al catálogo es TypeScript y nada más. |

Una tabla `lost_feed_item_reports` habría sido la otra opción defendible y se descartó justamente por la primera fila de esa tabla: el RPC de borrado enumera tablas **a mano**, así que una tabla nueva es un hueco nuevo — y ya hay uno abierto en §6b. Ver §7: nada vincula hoy `pii.apply_baseline` con los dos RPC, y esa es la razón por la que la elección de mecanismo, acá, es una decisión de privacidad y no de gusto.

### 7. Subject rights (Ley 25.326)

| Right | Enforcement |
|---|---|
| Access (art. 14) — `export_subject_data(p_user_id)` RPC | migration 0059; `pet_tags` in 0170 (`activation_code_hash` excluded); `pet_caretaker_grants`, `foster_volunteers`, `org_contact_messages` y `push_subscriptions` en **0205** (`p256dh`/`auth` excluidos: sin esas claves RFC 8291 el endpoint no entrega nada); `operator_feed_watermarks`, `physical_tag_interest` y `organization_invitations` en **0208** (`invitation_token` excluido: es una credencial al portador y este RPC lo puede llamar un admin sobre otro sujeto — misma exclusión que `activation_code_hash` y `p256dh`/`auth`). `schema_version` **5** — el número que devuelve la función viva, no el que quedó escrito acá |
| Erasure (art. 16) — `erase_subject_data(p_user_id, p_reason)` RPC | migration 0059 (+ 0106 `dni_hash`/`miarg_sub`; + 0170 FKs de `pet_tags`; + **0205**: grants de cuidado, `foster_volunteers` borrada, `profiles.jurisdiction_*`, los espejos por mascota `emergency_contact_*`/`preferred_vet_*`/`insurance_*`, y `submitter_ip` + `message` en `org_contact_messages`). Siete contadores nuevos en el payload `subject_erasure` |
| **Cada tabla nueva de `public` se declara contra los dos RPC** | `pnpm lint:subject-rights` → `scripts/check-subject-rights-coverage.ts`. Cuatro listas, verificación en las dos direcciones contra `pg_get_functiondef`. **Prueba mención, no corrección del predicado.** 16 tablas siguen en `KNOWN_GAP` — la 0207 cerró `libreta_share_tokens`, la 0208 cerró las tres suyas y la 0226 cerró `notification_dead_letter`. **No transcribas este número a ningún otro lado: sale de `pnpm lint:subject-rights`, que lo computa desde la lista viva, y esta celda es el único lugar del documento que lo escribe.** Que siga diciendo la verdad lo cerca `__tests__/documented-subject-rights-counts.test.ts`, que lee esta línea y la compara contra `Object.keys(KNOWN_GAP).length` |
| **Cada clave de payload de `pet_events` lleva una clase de privacidad** (decisión PO 5A, 2026-09-22: la supresión borra lo que es de la PERSONA, nunca la historia sanitaria de la mascota) | `lib/events/payload-privacy.ts`: `compliance_fact` (se conserva), `professional_act` (se conserva, opcionalmente condicionado a que `author_role` sea vet/govt/system o un shelter **verificado**), `personal_data` (centinela, drop, null, `[]`, franja etaria o punto a 2 decimales), `mirrored` (el changelog toma la clase del campo). Una clave nueva en un esquema zod sin clase pone rojo `pnpm lint:string-sweep` (`scripts/check-event-payload-privacy.ts`), igual que un centinela sobre un enum; `pnpm lint:subject-rights` compara la tabla viva `pii.pet_event_redaction_rules` con el TypeScript en las dos direcciones. Migración 0240. |
| New PII tables → `pii.apply_baseline(tbl)` adds `purpose`, `deleted_at`, `retention_until` | schema `pii` helper (solo seis tablas; **no** es la fuente de verdad de la cobertura) |
| Terminar un cuidado `accepted` durante una supresión pasa por el escritor único | `endCaretakerGrantAtomically()`, llamado desde `erase-subject-data.ts` **antes** del RPC. Ver §6b |
| `submitter_ip` caduca a los 30 días para todo el mundo, no solo para quien pide la baja | `ORG_CONTACT_IP_TTL_DAYS` en `lib/infra/data-lifecycle.ts` (quinto target del purge diario) |
| La cuenta **no** guarda provincia ni localidad | Retirado del formulario y del writer en 0205 (un writer, cero lectores). La jurisdicción es un hecho **de la mascota** |
| `pet_events` is append-only by design → exempt from soft-delete | Core principle #2 |
| **CERRADO 2026-08-28 — el soft-delete de la mascota se filtra en el guard de acceso** | `resolvePetHolderAccess` (`lib/infra/pet-access.ts`) lleva `isNull(pets.deletedAt)` en **los dos** caminos (persona y org), así que una mascota borrada contesta `kind: "none"` → 404 en todos sus consumidores de una sola vez. La fence es runtime, en el choke point: `__tests__/public-soft-delete-resolution.test.ts` corre el RPC real y afirma ambos caminos. **No copies conteos de call sites: corré `bash scripts/derive-pet-access-callers.sh`**, que es el comando que los deriva |

> **Por qué esa fila es de esta sección y no de autorización.** `erase_subject_data` hace SOFT-DELETE de la mascota y **deja viva la fila de `ownerships`** — `purgeOwnedPetAttachments` depende de eso y lo dice: "ownerships rows survive the RPC (only pets are soft-deleted)". Entonces, después de una supresión, el animal seguía teniendo una fila de tenencia viva y el guard contestaba `kind: "owner"` igual. `requireAlivePetAccess` **no** lo tapaba: rechaza `status === 'deceased'`, que es otra columna y otro hecho. El filtro en el resolver es lo que cierra la clase para las dos puertas (web y API) por construcción.
>
> **Sin parámetro de opt-in, a propósito.** La clasificación de todos los call sites (2026-08-28) no encontró ninguno que deba seguir resolviendo una mascota borrada: los agregados de gob leen `pets` directo y sin filtro por diseño (0205 PART C1), `getFormerOwnerReadAccess` es un resolver hermano con su propio SELECT, y el decomiso es mutuamente excluyente por SQL (la supresión sólo soft-borra mascotas cuyo sujeto tiene fila `role='owner'` viva; `executeDecomiso` cierra todas las filas individuales al abrir el episodio). Una superficie futura de recuperación admin tendría su propio resolver con nombre, nunca un flag.
>
> **La primera versión de la fila (cuando el hueco estaba abierto) decía 60 call sites en 34 archivos y se anunciaba como "medida".** Contaba menciones del guard dentro de docblocks como si fueran llamadas, y contaba la composición interna de `pet-access.ts` como consumidores independientes. Un número que dice "medido" y no reproduce es peor que ningún número, porque la próxima unidad dimensiona a partir de él. Por eso hay un script y no una cifra transcripta.

---

## How Claude should work in this repo

- **Always read this file first** in a new session.
- **Append to this file** when locking in a new design decision worth preserving across sessions.
- **Never break the core principles** above without explicit user agreement and an update to this file.
- **Events are forever**: if the user asks to "fix" historical event data, push back — the answer is a correction event, not a mutation.
- **Spanish UI, English code**. Variable names, function names, code comments in English. User-facing strings in Spanish (es-AR).
- The user is non-technical. When asking the user to run a command, explain in one sentence what it does. When showing an error, explain it in plain language before suggesting a fix.
