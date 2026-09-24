# DIM — Organization Portal Implementation Plan

> **IMPLEMENTED / shipped.** Core org portal flows are live at `app/org/[orgToken]/*`.
> This plan is archived for historical reference. Do NOT follow its task instructions — read
> the live code instead. Significant implementation deviations are noted below.
>
> **Known deviations from plan (2026-06-24 audit):**
> - Portal routes are `/org/[orgToken]/*` (plan said `/refugio/[orgToken]`).
> - Permission system is grant-based via `authz-resolver.requireCapability(cap, orgId?) → {error}`
>   in `src/modules/organizations/infrastructure/authz-resolver.ts` — **not** a `lib/org-permissions.ts`
>   module (which does not exist).
> - Capabilities: 16 coarse capabilities in `ORGANIZATION_CAPABILITIES` (db/schema.ts) — not 37
>   fine-grained capabilities listed in §T-0.2 below.
> - Cross-org transfer expiry: **30 days** (not 7 days); state tracked via case handshake
>   (`custody_transfer_handshake` case kind, `lib/case-attachment.ts`), not via `note_added` events.
> - `adoption_application_reviewed` event type removed (catalog cleanup 2026-05-18).
>   `adoption_revoked` renamed to `adoption_reversed` (umbrella; catalog cleanup 2026-05-19).
> - Cron `post-adoption-checkin` (singular), not `post-adoption-checkins`.
> - `lib/custody-transfers.ts` does not exist; custody transfer logic lives in
>   `src/modules/cases/` and `src/modules/transfers/`.
>
> **Estado (2026-06-04):** 🟡 PARCIAL — flujos core de custodia/adopción/intake/foster/transferencia enviados (`app/org/[orgToken]/*`). PENDIENTE (no construido como se especificó): T-1.2 invitaciones de miembros (sin tabla organization_invitations), T-1.1 UI de auto-registro de org + edición de config, T-1.3 editor de zonas de cobertura, T-4.3 branding origin-org (columna tier_0_show_origin_org ausente), T-0.3 contexto org por cookie (resuelto por ruta, no cookie).

**Version:** 1.0
**Date:** 2026-05-16
**Owner:** Ignacio Del Valle
**Status:** ready to execute

This is the single source of truth for building the DIM organization portal. Every task below carries a status checkbox; flip it as you go. Every architectural decision and out-of-scope item is locked here so the work does not drift mid-stream. The dependency graph, schema delta, event delta, integration milestones, verification queries, rollback plans, and risk register are all here.

If a conflict arises with another doc, the resolution order is:

1. `docs/org-portal-event-flows.md` wins for atomic event sequences.
2. `docs/org-portal-permissions.md` wins for the permissions matrix.
3. This plan wins for scope, dependencies, schema delta, and acceptance criteria.
4. `AGENTS.md` wins for everything else (principles, data model rationale, naming).

If two of the above disagree on the same point, flag it in the PR description; do not silently choose.

---

## 1. Pre-flight reading

Read these in order before starting any task. Do not skip — every architectural assumption traces back to one of them.

- [ ] `AGENTS.md` — full design doc. Mandatory sections: **Organizations**, **Ownership**, **PetEvents**, **Privacy tiers**, **Role vs. event authorship**, **Aggregation & privacy policy**.
- [ ] `docs/org-portal-permissions.md` — capability matrix, role semantics, authorship resolution API.
- [ ] `docs/org-portal-event-flows.md` — atomic sequences for every composite workflow.
- [ ] `README.md` — local dev loop, conventions.
- [ ] `db/schema.ts` — current shape of every table touched by this plan.
- [ ] `db/migrations/0000_orgs_foundation.sql` — what the org-side schema looks like now.
- [ ] `db/organizations_rls.sql` — existing read-side RLS for orgs.
- [ ] `db/rls.sql` — read-side RLS for owner-facing tables (the pattern to follow when we add write RLS).

After reading, verify your understanding by answering these three questions in your first PR description (they are the smoke test for the reading):

1. Why is `Ownership` polymorphic between user and org instead of subclassed?
2. What makes `adoption_finalized` a "composite event" and why must it run inside a single transaction?
3. What does `author_verified=true` actually require?

---

## 2. Working agreements (locked)

These do not change for the duration of this build. If you think one needs to change, open a discussion before writing code.

- **Append-only events.** `pet_events` rows are never edited or deleted. Corrections are new events. `Ownership` rows can be updated (`ended_at`) because they are projections of the event log.
- **Spanish UI, English code.** All user-facing strings in es-AR (vos, not usted). Identifiers, comments, commits, log lines in English.
- **One PR per task.** Title format: `[org-portal T-X.Y] short description`. Against `develop`.
- **Within a group, tasks are parallel-safe** unless marked otherwise. Across groups, strict order.
- **Every PR ends green:** `pnpm lint && pnpm typecheck && pnpm build && pnpm test`.
- **Every PR includes tests.** New server actions get unit tests for happy path + at least one error path + permission check. Atomic transactions get a crash-injection test that throws inside one step and asserts zero partial writes.
- **The owner is non-technical.** Any new command in `README.md` is explained in one sentence. Any user-facing error message is plain language first, technical detail second (or hidden).
- **Adding an event type is a one-line edit** to `EVENT_TYPES` in `db/schema.ts`. No migration. The column is `text`.
- **Server actions are the authorization boundary.** Drizzle queries bypass RLS (direct DB connection). RLS is defense-in-depth for PostgREST. Real authorization lives in `requireCapability(...)` calls at the top of every server action.

---

## 3. Locked architectural decisions

From product discussion. Do not relitigate inside a PR.

| # | Decision | Implication |
|---|----------|-------------|
| 1 | Custody transfers between orgs use a **two-event handshake** (`custody_transfer_proposed` + `custody_transferred`), not a pending_transfers table. | State derived from event log via `payload->>'proposal_event_id'` lookups. |
| 2 | Shelter intake of a brand-new pet emits **two events** (`pet_registered` then `shelter_intake_recorded`) in the same transaction. | Even when the author is a shelter. Do not collapse into one event. |
| 3 | Verification documents reuse **`attachments` table with flags** (`purpose='org_verification'`, `organization_id` set). No new bucket. | We do not know the real verification workflow yet — do not over-build. |
| 4 | Org `public_token` format is **`ORG-XXXX-XXXX`**, same generator family as pets. | New helper `generateOrgPublicToken()` in `lib/publicToken.ts`. |
| 5 | Tier-0 origin-org branding has **dual opt-out**: org sets `tier_0_show_branding`, adopter sets per-pet `tier_0_show_origin_org`. Both must be true for the badge. **Origin lineage always stays in the immutable event log** (`adoption_finalized.payload.previous_owner_organization_id`); the visual toggle does not erase history. | New column `pets.tier_0_show_origin_org boolean not null default true`. |
| 6 | **Vecino-as-tránsito is out of scope for this build.** Handled in a separate work stream. Do not build any vecino-tránsito UI here. | If the existing personal-owner flow happens to touch `ownership.role='shelter_custody'` incidentally, leave it alone. |

---

## 4. Out of scope (explicit)

State these in PR descriptions if anyone asks. They are deferred to future streams, not declined.

- Donations, sponsorship, apadrinamiento. Zero.
- Internal messaging between orgs and adopters. v1 uses email/phone.
- Bulk operations for high-capacity refugios (200+ animals). Schema supports them; UX deferred.
- Real transactional email provider for invitations. v1 returns the invite URL as copyable text.
- Real verification workflow with admin tooling. v1 auto-verifies in dev; prod requires Studio.
- Public API of adoption listings for third-party apps.
- Integration with Animales BA / Mascotas CABA / Mi Argentina.
- Vet portal (`/pro`) and Government portal (`/gob`). They share the same foundation; building them is separate streams.
- Vecino-tránsito UI.
- React Native / mobile-native app. PWA only.

---

## 5. Scope summary

- **16 tasks** across 4 groups.
- **12 new event types** added to `EVENT_TYPES`. No migration (column is `text`).
- **6 new schema items** across 3 migrations: 1 new table, 5 new columns.
- **~12 new routes** under `/org`, `/adoptar`.
- **~20 new server actions** under `app/actions/`.
- **2 new TypeScript modules** (`authz-resolver` in `src/modules/organizations/infrastructure/`, `lib/event-authorship.ts`) plus helpers.
- **1 new cron route** (`/api/cron/post-adoption-checkin`).

---

## 6. Schema delta — consolidated

### 6.1 New table

**`organization_invitations`** (migration `0003_org_invitations.sql`)

```sql
create table if not exists "public"."organization_invitations" (
  "id" uuid primary key default gen_random_uuid(),
  "organization_id" uuid not null references "public"."organizations"("id") on delete cascade,
  "email" text not null,
  "invited_role" "public"."organization_membership_role" not null,
  "can_write_pet_events" boolean not null default false,
  "invited_by_user_id" uuid references "public"."profiles"("id") on delete set null,
  "invitation_token" text not null unique,         -- INV-XXXX-XXXX
  "expires_at" timestamptz not null default (now() + interval '14 days'),
  "accepted_at" timestamptz,
  "accepted_by_user_id" uuid references "public"."profiles"("id") on delete set null,
  "revoked_at" timestamptz,
  "created_at" timestamptz not null default now()
);
create index if not exists "org_invitations_org_idx" on "public"."organization_invitations" ("organization_id");
create index if not exists "org_invitations_token_idx" on "public"."organization_invitations" ("invitation_token");
create index if not exists "org_invitations_email_idx" on "public"."organization_invitations" ("email");
```

### 6.2 New columns

| Column | Migration | Purpose |
|--------|-----------|---------|
| `attachments.purpose text not null default 'pet_event'` | `0003_org_invitations.sql` (shared) | Tag attachments by use: `pet_event \| org_verification \| adoption_contract \| other`. Validated in app code. |
| `attachments.organization_id uuid references organizations(id) on delete cascade` | `0003_org_invitations.sql` | Owner of org-scoped attachments (verification docs, adoption contracts). |
| `pets.publish_to_adopt boolean not null default false` | `0004_publish_to_adopt.sql` | Org admin toggle to expose a pet on `/adoptar`. |
| `pets.tier_0_show_origin_org boolean not null default true` | `0005_origin_org_branding.sql` | Adopter's opt-out for the origin-org badge on the public credential. |
| `organization_memberships.receives_broadcasts boolean not null default true` | `0006_broadcasts_opt_out.sql` | Volunteer opt-out for lost-pet broadcast notifications. |

### 6.3 Migration order

Strict order: `0003` → `0004` → `0005` → `0006`. Each is idempotent (uses `do $$ ... exception when ... end $$` and `if not exists` guards). All four can be re-run safely.

### 6.4 Rollback notes

These migrations are **additive only** — no rollback is normally needed. If a migration must be reverted, dropping the added columns/tables is safe because nothing earlier depends on them. The reverse SQL lives at the bottom of each migration file inside a comment block (not executed by Drizzle, but documented).

---

## 7. EVENT_TYPES additions

Append to `EVENT_TYPES` in `db/schema.ts` (Task T-0.1). One-line edit per type. Grouped by purpose; comments stay aligned with existing groups.

```ts
// Custody — transfers between users and orgs (two-event handshake)
"custody_transfer_proposed",
"custody_transferred",
"custody_transfer_cancelled",  // structured cancellation (replaces note_added approach)
// Custody — shelter intake
"shelter_intake_recorded",
// Foster
"foster_assigned",
"foster_ended",
// Adoption pipeline
"adoption_application_submitted",
// NOTE: adoption_application_reviewed REMOVED (catalog cleanup 2026-05-18)
// NOTE: adoption_application_approved/rejected collapsed into adoption_application_resolved
"adoption_application_resolved",  // outcome: approved|rejected
"adoption_finalized",
"post_adoption_checkin",
// NOTE: adoption_revoked RENAMED to adoption_reversed (umbrella; catalog cleanup 2026-05-19)
"adoption_reversed",  // actor: shelter|adopter|court
```

> **Deviation from original plan:** `custody_transfer_cancelled` is a dedicated event type
> (not a `note_added` with category). Cross-org transfer proposals expire after **30 days**
> (not 7); state is tracked via the `custody_transfer_handshake` case kind in `lib/case-attachment.ts`.

---

## 8. Dependency graph

```
Group 0 (foundations)
  T-0.1 ──┐
  T-0.2 ──┤   all 4 in parallel
  T-0.3 ──┤
  T-0.4 ──┘
     │
     ▼
Group 1 (org admin)
  T-1.1 ──→ T-1.2 ──→ T-1.3
                │
                └─────────┐
                          ▼
Group 2 (custody)         │
  T-1.1 ──→ T-2.1 ──→ T-2.4
            T-2.2 ──→ T-2.4
                      T-2.4 ──→ T-2.5
  T-1.2 ──→ T-2.3 ──→ T-2.4
     │
     └─────────┐
               ▼
Group 3 (adoption)
  T-1.1 ──→ T-3.1 ──→ T-3.2 ──→ T-3.3 ──→ T-3.4
                                  │
                                  ▼
                              (uses T-2.3 if foster active)

Group 4 (surface & integration)
  Group 2 + Group 3 done ──→ T-4.1
  T-1.1 done              ──→ T-4.2
  T-3.3 done              ──→ T-4.3
  T-1.3 + setPetLostAction──→ T-4.4
```

Parallelization hints:
- Group 0: all 4 fully parallel.
- Group 1: strictly sequential.
- Group 2: T-2.1, T-2.2, T-2.3 parallel after T-1.1 (T-2.3 also needs T-1.2). Then T-2.4. Then T-2.5.
- Group 3: T-3.1 can run in parallel with Group 2 once T-1.1 is done. T-3.2 needs T-3.1. T-3.3 needs T-3.2. T-3.4 needs T-3.3.
- Group 4: T-4.1, T-4.2, T-4.3, T-4.4 can run in parallel once their predecessors are done.

---

## 9. Tasks

Each task block is a self-contained spec. The orchestrator can dispatch one per worker. Status checkboxes are the truth: when a checkbox is flipped to `[x]`, the task is merged and verified.

### Group 0 — Foundations

#### T-0.1 — Append event types and add minimal payload summaries

- **Status:** [x] done
- **Group:** 0
- **Depends on:** none
- **Parallel-safe with:** T-0.2, T-0.3, T-0.4
- **Files:** `db/schema.ts`, `lib/events.ts`, `__tests__/event-types.test.ts`

**Goal.** The 12 new event types from §7 are part of `EVENT_TYPES`, and the timeline renderer (`eventPayloadSummary`) has minimal cases for each so nothing blows up when a row of a new type is read.

**Steps.**
1. Append the 12 strings to `EVENT_TYPES`, preserving grouping comments.
2. In `lib/events.ts`, add a switch case per new type returning `{ primary: <Spanish label>, secondary: <short payload-derived blurb or null> }`. Examples: `custody_transferred` → `"Custodia transferida"`; `adoption_finalized` → `"Adopción finalizada"`, secondary = previous org display name when resolvable; `post_adoption_checkin` → `"Check-in de adopción"`.
3. Add `__tests__/event-types.test.ts` asserting every value in `EVENT_TYPES` is unique and every value has a defined renderer (no `null` from the default case).

**Acceptance.**
- `EVENT_TYPES.length` increases by exactly 12.
- Inserting a row of any new type via Drizzle is accepted by the DB.
- Test suite green.

**Tests.**
- Unit: every event type has a renderer.
- Smoke: insert one row per new type into `pet_events` and read it back.

**Risks.** Renderer fragility — payload shapes are not yet pinned for some types. Keep renderers defensive (`p['key'] ?? "—"`).

---

#### T-0.2 — `lib/org-permissions.ts` and `lib/event-authorship.ts`

- **Status:** [x] done
- **Group:** 0
- **Depends on:** none
- **Parallel-safe with:** T-0.1, T-0.3, T-0.4
- **Files:** `lib/org-permissions.ts`, `lib/event-authorship.ts`, `__tests__/org-permissions.test.ts`, `__tests__/event-authorship.test.ts`

**Goal.** The permissions matrix from `docs/org-portal-permissions.md` is implemented exactly, with one test per cell.

**Steps.**
1. Implement `Capability` union, `OrgContext`, `PerPetContext`, `can()`, `requireCapability()` matching the doc's API.
2. Implement `OrgPermissionError` with a Spanish message: `"No tenés permisos para esta acción en {orgName}."` Throw from `requireCapability`.
3. Implement `resolveAuthorship({ org, profile, orgVerified })` in `lib/event-authorship.ts` returning `{ authorRole, authorOrganizationId, authorVerified }`. Handles `vet_individual` → `vet`, `shelter`/`rescue_network`/`other` → `shelter`, `sanitary_authority` → `govt`, `clinic` → `vet`. When org is null (personal owner mode), returns `{ owner, null, false }`.
4. Write tests literally mirroring the matrix markdown table — one assertion per (role, capability) cell. Use a parameterized test table.

**Acceptance.**
- Every cell of the matrix has a passing test.
- `requireCapability` throws `OrgPermissionError` with the documented message for denied capabilities.
- `pnpm typecheck` shows no `any` in the public API of either file.

**Tests.**
- Matrix coverage (148 assertions: 37 capabilities × 4 effective roles, ignoring `n/a` and per-pet cells).
- `requireCapability` happy path and denied path.
- `resolveAuthorship` for each of the 6 membership roles + null org.

**Risks.** Drift between the matrix doc and the code. Add a comment at the top of `lib/org-permissions.ts` saying "the matrix in `docs/org-portal-permissions.md` is the spec; this file must match it".

---

#### T-0.3 — Org context switcher

- **Status:** [ ] pending (pendiente)
- **Group:** 0
- **Depends on:** none (uses tables already in place)
- **Parallel-safe with:** T-0.1, T-0.2, T-0.4
- **Files:** `lib/current-org.ts`, `components/OrgContextSwitcher.tsx`, `app/actions/org-context.ts`, `app/(app)/mis-mascotas/page.tsx` (insert switcher into header)

**Goal.** A user can choose "acting as" which org; the choice persists in a cookie; every server action can read it via `getCurrentOrgContext()`.

**Steps.**
1. Implement `lib/current-org.ts`:
   - `getCurrentOrgContext(): Promise<OrgContext | null>` reads cookie `dim_current_org` (HTTP-only, `secure` in prod, path `/`, `max-age` 30d), validates the user has an active membership with that org, returns the context or null.
   - Helper `clearCurrentOrgContext()` for logout.
2. Implement `setCurrentOrgContextAction(organizationId: string | null)` in `app/actions/org-context.ts`. Validates the membership before writing the cookie. If `organizationId` is null, clears the cookie (returns to personal mode).
3. Build `<OrgContextSwitcher>`:
   - Server component that fetches the user's active memberships + their orgs.
   - Client subcomponent renders a dropdown: "Modo personal" plus one entry per membership (avatar/initials + display_name + role badge).
   - Currently selected option highlighted; selecting another calls the action and refreshes via `router.refresh()`.
   - Only renders when the user has at least one active membership.
4. Mount in the header of `app/(app)/mis-mascotas/page.tsx` next to the notification bell.
5. Wire `clearCurrentOrgContext()` into `logoutAction`.

**Acceptance.**
- User with two memberships switches between them; cookie value updates; next page load reflects the new context.
- User with no memberships sees no switcher.
- Logout clears the cookie.

**Tests.**
- Unit: cookie read/write/clear.
- Unit: invalid org id in cookie returns null (does not throw).
- Integration: switching context then making a server action call that reads `getCurrentOrgContext()` returns the new context.

**Risks.** Cookie tampering. The validation step (membership lookup) is the trust boundary — it must always run before returning a non-null context.

---

#### T-0.4 — Attachment infrastructure and ORG token generator

- **Status:** [x] done
- **Group:** 0
- **Depends on:** none
- **Parallel-safe with:** T-0.1, T-0.2, T-0.3
- **Files:** `db/schema.ts`, `db/migrations/0003_org_invitations.sql` (this migration also adds the invitations table — Task T-1.2 will land that part; T-0.4 lands only the `attachments` columns and Task T-1.2 adds the table to the same migration file), `lib/publicToken.ts`, `__tests__/public-token.test.ts`

**Goal.** Attachments carry a `purpose` flag and can be scoped to an org; `generateOrgPublicToken()` produces `ORG-XXXX-XXXX`.

**Steps.**
1. Migration `db/migrations/0003_org_invitations.sql` — adds **only** the two `attachments` columns for this task. The invitations table block is appended by T-1.2 (file name shared to keep the migration count low; the file's header lists both contributions). All blocks idempotent.
   ```sql
   alter table public.attachments
     add column if not exists purpose text not null default 'pet_event';
   alter table public.attachments
     add column if not exists organization_id uuid references public.organizations(id) on delete cascade;
   create index if not exists attachments_organization_idx on public.attachments (organization_id);
   ```
2. Update `db/schema.ts` `attachments` table definition to include both columns (with the same defaults and a comment listing the allowed `purpose` values).
3. Extend `lib/publicToken.ts`:
   - Existing exported `generatePublicToken()` generates `DIM-XXXX-XXXX`.
   - Add `generateOrgPublicToken()` producing `ORG-XXXX-XXXX` using the same character set and collision-retry pattern.
   - Refactor internals to share a single `generateToken(prefix)` helper.
4. Tests: format regex for each generator, and an idempotency test for the migration (run twice, assert no error).

**Acceptance.**
- Migration applies cleanly to a DB with existing data and is idempotent.
- `generateOrgPublicToken()` always matches `/^ORG-[A-Z0-9]{4}-[A-Z0-9]{4}$/`.
- `attachments.purpose` defaults to `'pet_event'` for new rows when not specified; existing rows inherit the default.

**Tests.**
- Unit: token format for both generators.
- Migration: re-run idempotency.

**Risks.** Adding NOT NULL columns to a populated table normally requires a backfill. The default value handles this — verify on a non-empty `attachments` table before considering done.

---

### Group 1 — Org administration

#### T-1.1 — Register and edit organization

- **Status:** [ ] pending (pendiente)
- **Group:** 1
- **Depends on:** T-0.2, T-0.3, T-0.4
- **Parallel-safe with:** none in Group 1
- **Files:** `app/(refugio)/refugio/nueva/page.tsx`, `app/(refugio)/refugio/nueva/RegisterOrgForm.tsx`, `app/(refugio)/refugio/[orgToken]/configuracion/page.tsx`, `app/(refugio)/refugio/[orgToken]/configuracion/EditOrgForm.tsx`, `app/(refugio)/refugio/[orgToken]/page.tsx` (dashboard stub), `app/(refugio)/refugio/[orgToken]/layout.tsx` (org-scoped layout), `app/actions/organizations.ts`, `lib/cuit.ts` (new — AR CUIT checksum)

**Goal.** A user can register a new organization, see its dashboard stub, and edit its profile (admin-only).

**Steps.**
1. New route group `app/(refugio)/`. Add a layout that:
   - Guards authentication (redirects to `/login`).
   - For routes under `/refugio/[orgToken]/*`: loads the org by `public_token`, verifies the current user has an active membership, sets `current_org` cookie to this org if not already, renders a sidebar with sections (Dashboard / Mascotas / Tránsitos / Aplicaciones / Miembros / Cobertura / Configuración).
2. Registration page `/refugio/nueva`:
   - Form fields per §5.1.1 of `dim-interno:docs/archive/org-portal-prompt.md` (legal_name, display_name, org_type, CUIT, personería, email, phone, website, avatar upload, jurisdiction via `<LocationFields mode="jurisdiction">`).
   - Validate CUIT checksum when present using `lib/cuit.ts`.
   - Submit calls `createOrganizationAction`.
3. `createOrganizationAction`:
   - Generates `public_token` via `generateOrgPublicToken()` with retry on conflict.
   - Inserts the `organizations` row. **In dev** (`process.env.NODE_ENV !== 'production'`): sets `verified=true` and `verified_at=now()` — log `console.warn` so it's visible. **In prod**: leaves `verified=false`.
   - Inserts an `organization_memberships` row for the creator with `role='admin'`, `can_write_pet_events=true`.
   - Calls `setCurrentOrgContextAction` to switch the cookie.
   - Inserts a welcome notification.
   - Redirects to the org's dashboard.
4. Dashboard stub at `/refugio/[orgToken]`: show display_name, verification status, role badge for current user, four placeholder cards (Mascotas en custodia / Tránsitos activos / Aplicaciones pendientes / Miembros) that link to their respective sections once those tasks land.
5. Configuration page `/refugio/[orgToken]/configuracion`: form same as registration minus public_token. Admin sees full edit; coordinator sees read-only with a notice. Submit calls `updateOrganizationAction` which calls `requireCapability("org.profile.update", ...)`.
6. Tests for both server actions (success, validation failure, permission denied, CUIT checksum failure).

**Acceptance.**
- A logged-in user registers a refugio in dev → org is verified → cookie switches → dashboard renders.
- Same flow in prod → org is unverified → dashboard renders with an "En revisión" notice.
- Admin can edit the org profile; coordinator cannot.
- CUIT with bad checksum is rejected before insert.

**Tests.**
- Unit: CUIT checksum.
- Action: create org happy path, edit org happy path, permission denied for non-admin edit.

**Risks.** Auto-verify in dev leaking to prod. The env guard is critical; add an explicit log line.

---

#### T-1.2 — Members and invitations

- **Status:** [ ] pending (pendiente)
- **Group:** 1
- **Depends on:** T-1.1
- **Parallel-safe with:** none in Group 1
- **Files:** `db/schema.ts` (new `organization_invitations` table), `db/migrations/0003_org_invitations.sql` (append the table block; T-0.4 already created the file with the `attachments` columns), `app/(refugio)/refugio/[orgToken]/miembros/page.tsx`, `app/(refugio)/refugio/[orgToken]/miembros/invitar/page.tsx`, `app/(refugio)/refugio/[orgToken]/miembros/invitar/InviteForm.tsx`, `app/(refugio)/r/invite/[token]/page.tsx` (public accept page), `app/actions/org-memberships.ts`, `app/actions/org-invitations.ts`

**Goal.** Admins can invite people by email, the invitee accepts via a token URL, the membership is created.

**Steps.**
1. Append the `organization_invitations` table block to migration `0003_org_invitations.sql` (see §6.1). Update `db/schema.ts` accordingly.
2. Members list `/refugio/[orgToken]/miembros`:
   - Lists active memberships with role badge, `can_write_pet_events` toggle (admin/coordinator only), "Terminar membresía" button (gated per matrix), `receives_broadcasts` toggle if column already exists (set up properly in T-4.4 — until then, hide the toggle).
   - Section below: pending invitations (not yet accepted, not expired, not revoked). Each row has a "Copiar link" button and "Revocar" button.
3. Invite form `/refugio/[orgToken]/miembros/invitar`:
   - Inputs: email, invited_role (dropdown — admin-only can offer `admin` slot), can_write_pet_events checkbox.
   - Submit calls `inviteMemberAction`: generates `invitation_token` (format `INV-XXXX-XXXX` via the shared `generateToken("INV")` helper from T-0.4), inserts the invitation row, returns the absolute URL to copy. The form's success state shows the URL with a "Copiar" button. **No email is sent in v1** — the inviter is responsible for sending it via WhatsApp/email/in-person.
   - Leave a TODO comment in the action pointing to "future: wire transactional email".
4. Public accept page `/r/invite/[token]`:
   - Loads the invitation by token. 404 if not found, expired, revoked, or already accepted.
   - If user not logged in: shows org name + role + a "Iniciar sesión o crear cuenta" link that round-trips back here.
   - If user logged in but email mismatch: shows "Esta invitación es para {email}. Iniciá sesión con esa cuenta."
   - If user logged in and email matches: "Aceptar" and "Rechazar" buttons.
   - `acceptInvitationAction` inserts the `organization_memberships` row in a transaction with updating `accepted_at` and `accepted_by_user_id` on the invitation.
   - `revokeInvitationAction` (called from the members list) sets `revoked_at = now()`.
5. Other server actions: `endMembershipAction`, `updateMembershipRoleAction`, `updateCanWritePetEventsAction`. Each calls `requireCapability` with the appropriate capability and the protections from the matrix (e.g. coordinators cannot manage admins).

**Acceptance.**
- Admin invites a new email → URL is shown → opening URL in another browser (different user with matching email) shows the accept page → accept creates the membership.
- A coordinator tries to change an admin's role → denied with the Spanish error.
- Revoked invitations cannot be accepted.

**Tests.**
- Action: invite happy path, accept happy path, accept-after-expiry denied, accept-after-revoke denied, accept with mismatched email denied.
- Action: end membership self-only for non-admins.

**Risks.** Token reuse. Tokens are unique-indexed in DB. Action returns 409 on conflict and regenerates.

---

#### T-1.3 — Coverage zones

- **Status:** [ ] pending (pendiente)
- **Group:** 1
- **Depends on:** T-1.1 (org exists). Independent from T-1.2.
- **Parallel-safe with:** T-1.2
- **Files:** `app/(refugio)/refugio/[orgToken]/cobertura/page.tsx`, `app/(refugio)/refugio/[orgToken]/cobertura/CoverageEditor.tsx`, `app/actions/org-coverage.ts`

**Goal.** An org admin/coordinator declares which jurisdictions the org operates in. CABA barrios are picked from a checklist; other provinces are free-form.

**Steps.**
1. Page reads existing coverage rows for the org and groups them by `jurisdiction_province`.
2. CABA section: query `ar_localities where province_code = 'AR-C' and is_caba_barrio = true`. Render as a 48-item checklist. Each toggle inserts or removes a coverage row.
3. Other-province section: a list of `<LocationFields mode="jurisdiction">` blocks (one per existing non-CABA row, plus a "+ Agregar zona" button). Each block has a "Marcar como principal" radio and a "Eliminar" button.
4. Server actions: `addCoverageZoneAction`, `removeCoverageZoneAction`, `setPrimaryCoverageZoneAction`. The last sets `is_primary=true` on the target row and `is_primary=false` on every other row of the same org in a single transaction. All three call `requireCapability("org.coverage.manage", ...)`.

**Acceptance.**
- Admin adds two coverage rows; setting one as primary makes the other non-primary.
- Coordinator can manage coverage; member cannot.

**Tests.**
- Action: primary swap is atomic (no time window with two primaries).

**Risks.** Race condition on primary swap — wrapped in transaction.

---

### Group 2 — Custody

#### T-2.1 — Intake for a brand-new pet (Flow 1)

- **Status:** [x] done
- **Group:** 2
- **Depends on:** T-1.1
- **Parallel-safe with:** T-2.2, T-2.3
- **Files:** `app/(refugio)/refugio/[orgToken]/mascotas/nueva/page.tsx`, `app/(refugio)/refugio/[orgToken]/mascotas/nueva/IntakeForm.tsx`, `app/actions/intake.ts`

**Goal.** A member with `custody.intake.new_pet` registers an animal not yet in DIM, atomically creating pet + shelter_custody ownership + two events.

**Steps.**
1. Page renders a form that reuses `<PetForm>` (existing personal-flow form) with two adjustments:
   - Header copy: "Estás registrando un animal que entró en custodia de {org.name}".
   - Extra "Intake" section above the pet fields: `intake_reason` (dropdown `rescue | surrender | seizure | stray_found | other`), optional `intake_condition` textarea, optional `<LocationFields mode="jurisdiction+point">` for rescue location.
2. Server action `createIntakePetAction` implements Flow 1 from `docs/org-portal-event-flows.md`:
   - `requireCapability("custody.intake.new_pet", ...)`.
   - Single `db.transaction`: insert pet → insert ownership(shelter_custody) → insert `pet_registered` event → insert `shelter_intake_recorded` event → (if microchip provided) insert `microchip_implanted` event.
   - All events get authorship via `resolveAuthorship(currentOrg, profile, org.verified)`.
   - After commit, insert notifications to org admins via a separate call (not in the transaction).
3. Redirect to `/refugio/[orgToken]/mascotas/[petToken]` (Task T-2.4 — until that lands, redirect to the dashboard with a success flash).

**Acceptance.**
- Successful intake: one pet, one ownership row (shelter_custody), two events with matching `author_organization_id`, notification to org admins.
- Crash-injection test: throw inside step 3 → zero partial rows.
- Member without capability is denied with `OrgPermissionError`.

**Tests.**
- Action: happy path, missing required fields, permission denied, transactional crash.

**Risks.** Public token collision on pet. Use existing retry pattern from `createPetAction`.

---

#### T-2.2 — Intake for an existing pet (Flow 2)

- **Status:** [x] done
- **Group:** 2
- **Depends on:** T-1.1
- **Parallel-safe with:** T-2.1, T-2.3
- **Files:** `app/(refugio)/refugio/[orgToken]/mascotas/buscar/page.tsx`, `app/(refugio)/refugio/[orgToken]/mascotas/buscar/SearchForm.tsx`, `app/(refugio)/refugio/[orgToken]/mascotas/transferir/[petToken]/page.tsx`, `app/(refugio)/refugio/[orgToken]/mascotas/transferir/[petToken]/ConfirmTakeIntoCustodyForm.tsx`, `app/actions/intake.ts` (extend), `lib/pet-search.ts` (new)

**Goal.** A member with `custody.intake.transfer_in` finds an existing pet by microchip / token / owner email and takes custody atomically.

**Steps.**
1. Search page: inputs for microchip, public_token, owner_email. Submit calls `searchPetForIntakeAction` which:
   - Queries pets matching the criteria.
   - Returns each result with current ownership (joined) and a "Tomar custodia" link to the confirm page.
2. Confirm page `/mascotas/transferir/[petToken]`:
   - Loads the pet + its current Ownership + (if user-owned) the previous owner's display name (no contact details — PII not revealed to receiving org pre-handoff).
   - Shows reason dropdown (`rescue | surrender | seizure | other`), required `authority_reference` text when reason is `seizure`.
   - Confirmation explains consequences in plain language.
3. Server action `transferInPetAction` implements Flow 2a (pet was held by another org) or Flow 2b (pet was personally owned):
   - `requireCapability("custody.intake.transfer_in", ...)`.
   - `db.transaction`: insert `custody_transferred` event → update prior ownership `ended_at` → insert new ownership(shelter_custody) → insert `shelter_intake_recorded` event.
   - Severity of previous-owner notification: `warning` default, `urgent` when reason is `seizure`.
4. Notification to previous owner happens after commit (separate call).

**Acceptance.**
- Searching by microchip returns the right pet.
- Transferring an owner-held pet ends the old ownership, creates new, emits the two events, notifies previous owner.
- Transferring an org-held pet does the same with org-to-org wording.

**Tests.**
- Action: 2a happy path, 2b happy path, seizure path produces urgent notification, transactional crash.

**Risks.** Searching by `owner_email` leaks "is this email in DIM" via timing. Accept this in v1 — same trade-off as other search-by-email surfaces.

---

#### T-2.3 — Foster assign and end (Flows 4 and 5)

- **Status:** [x] done
- **Group:** 2
- **Depends on:** T-1.1, T-1.2 (foster must be an org member)
- **Parallel-safe with:** T-2.1, T-2.2
- **Files:** `app/(refugio)/refugio/[orgToken]/transitos/page.tsx`, `app/(refugio)/refugio/[orgToken]/transitos/AssignFosterModal.tsx`, `app/(refugio)/refugio/[orgToken]/transitos/EndFosterModal.tsx`, `app/actions/foster.ts`

**Goal.** Admin/coordinator assigns and closes foster periods on org-held pets.

**Steps.**
1. List page shows active foster rows (joined with pet + foster user) for org-held pets.
2. From a pet detail in org context (T-2.4), an "Asignar tránsito" button opens a modal:
   - Dropdown of active org members who do not currently have an active foster row for this pet.
   - Inputs: `expected_weeks`, `notes`.
3. `assignFosterAction` implements Flow 4: `db.transaction` { insert `foster_assigned` event → insert ownership(foster) row }. Note: shelter_custody row stays active — `ownerships_one_active_owner_per_pet` partial unique index allows this because it only constrains `role='owner'`.
4. From each foster row, an "Cerrar tránsito" button opens a modal asking `reason` (radio: `returned | escalated | other`). `endFosterAction` implements Flow 5: transaction { insert `foster_ended` event → update foster ownership `ended_at` }. Foster themselves can call this only on their own rows (`foster.end` matrix entry: yes for foster, self only).

**Acceptance.**
- After assign, both shelter_custody and foster rows are active for the pet.
- After end, only shelter_custody remains active.
- Foster who is no longer a member cannot be assigned (membership check inside action).
- Member without capability denied.

**Tests.**
- Action: assign happy path, assign with non-member foster denied, end happy path, end by non-foster non-admin denied.

**Risks.** Foster ending while pet is being adopted — guarded because Flow 7 (adoption_finalized) handles foster end inside its own transaction.

---

#### T-2.4 — Pet detail in org context

- **Status:** [x] done
- **Group:** 2
- **Depends on:** T-2.1, T-2.2, T-2.3 (at least one custody flow lands first; T-2.4 closes the loop)
- **Parallel-safe with:** none in Group 2
- **Files:** `app/(refugio)/refugio/[orgToken]/mascotas/[petToken]/page.tsx`, `app/(refugio)/refugio/[orgToken]/mascotas/[petToken]/OrgPetActions.tsx`, `lib/pet-resolution.ts` (new helper to resolve pet + custody status from token)

**Goal.** Org members see a pet's full detail with the right actions for their org context.

**Steps.**
1. Layout: header (pet name, photo, status badge, "En custodia de {org.name} desde {date}" line, foster line if applicable), event timeline (reuse existing), info panel.
2. Actions block — capability-gated buttons:
   - "Asignar tránsito" → T-2.3 modal
   - "Cerrar tránsito" (if active foster) → T-2.3 modal
   - "Proponer transfer a otro refugio" → T-2.5 modal
   - "Publicar en adopción" → toggles `pets.publish_to_adopt` (column lands in T-3.1)
   - "Marcar como perdida" / "Marcar como encontrada" → existing actions, re-targeted to org context
   - "Registrar fallecimiento" → existing action
   - Plus all the clinical event entry points the personal-owner flow has, now in org context
3. Validation: route is 404 unless the current user is in org context AND the org holds an active shelter_custody row for this pet.

**Acceptance.**
- Org member with custody sees the page; member of a different org or no context sees 404.
- All capability-gated buttons hide for users lacking the capability.

**Tests.**
- Page-level: render with each membership role, assert the right buttons appear.

**Risks.** N+1 queries on the timeline. Reuse the existing pet-detail data-fetching pattern.

---

#### T-2.5 — Org-to-org transfer handshake (Flow 3)

- **Status:** [x] done
- **Group:** 2
- **Depends on:** T-2.4
- **Parallel-safe with:** none
- **Files:** `app/(refugio)/refugio/[orgToken]/mascotas/[petToken]/ProposeTransferModal.tsx`, `app/(refugio)/refugio/[orgToken]/transfers/recibidos/page.tsx`, `app/(refugio)/refugio/[orgToken]/transfers/emitidos/page.tsx`, `app/actions/custody-transfers.ts`, `lib/custody-transfers.ts` (new — proposal state resolver)

**Goal.** Two-event handshake for transferring custody between verified orgs.

**Steps.**
1. From T-2.4, "Proponer transfer" opens a modal:
   - Search input querying verified orgs of type `shelter` or `rescue_network`.
   - Inputs: reason (optional text), expiry (default `now() + 7 days`).
2. `proposeCustodyTransferAction` implements step P1 from Flow 3: insert `custody_transfer_proposed` event with payload `{ to_organization_id, proposed_by_user_id, reason, expires_at }` + notifications to receiving org admins/coordinators.
3. Receiving-org inbox page `/refugio/[orgToken]/transfers/recibidos`:
   - Lists pending proposals (proposals where no follow-up `custody_transferred` / cancel / reject `note_added` exists referencing the proposal event id).
   - Each row: pet name, sending org, reason, expires in.
   - Actions: "Aceptar" → `acceptCustodyTransferAction` implements step A1 (transaction: insert `custody_transferred` event → update prior ownership ended_at → insert new shelter_custody ownership for receiver).
   - "Rechazar" → `rejectCustodyTransferAction` inserts `note_added` event with `category='custody_transfer_rejected'`, `proposal_event_id` in payload + notification to sender.
4. Sending-org outbox page `/refugio/[orgToken]/transfers/emitidos`: lists proposals this org sent. Each pending one has a "Cancelar" button → `cancelCustodyTransferAction` inserts `note_added` with `category='custody_transfer_cancelled'` + notification.
5. `lib/custody-transfers.ts` exports `resolveProposalState(proposalEventId): 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired'` — single source of truth used by both inbox and outbox.

**Acceptance.**
- Org A proposes; Org B sees it in inbox; accepting moves custody atomically; both orgs see the resolved status afterwards.
- Expired proposals (past `expires_at`) cannot be accepted; the inbox shows them in a separate section as "Vencidas".

**Tests.**
- Action: propose, accept, reject, cancel, expired-cannot-accept, transactional crash on accept.
- `resolveProposalState` for each of the 5 outcomes.

**Risks.** Race: two members of the receiving org accept simultaneously. The transaction step that updates prior ownership where `ended_at IS NULL` will fail for the second one — handle the conflict with a user-friendly error.

---

### Group 3 — Adoption pipeline

#### T-3.1 — Public `/adoptar` listing

- **Status:** [x] done
- **Group:** 3
- **Depends on:** T-1.1
- **Parallel-safe with:** Group 2 in parallel after T-1.1
- **Files:** `db/schema.ts` (column), `db/migrations/0004_publish_to_adopt.sql`, `app/adoptar/page.tsx`, `app/adoptar/PetCard.tsx`, `app/adoptar/Filters.tsx`, `app/adoptar/[petToken]/page.tsx`, `app/actions/publish-pet.ts`

**Goal.** Public listing of adoptable animals + per-pet detail page, both with no PII.

**Steps.**
1. Migration `0004_publish_to_adopt.sql`: add `pets.publish_to_adopt boolean not null default false`. Idempotent.
2. Server action `togglePublishToAdoptAction` (called from T-2.4 page): `requireCapability("org.coverage.manage", ...)` (re-uses the matrix entry — TODO: should be its own capability, document in matrix doc as a future addition; for v1, coverage management covers it).
3. Listing page `/adoptar`:
   - Query: `select pets.* from pets join ownerships on ownerships.pet_id=pets.id join organizations on organizations.id=ownerships.owner_organization_id where ownerships.role='shelter_custody' and ownerships.ended_at is null and organizations.verified=true and pets.status='active' and pets.publish_to_adopt=true`.
   - Filters via search params: `province`, `locality`, `species`, `sex`, `age_min`, `age_max`.
   - Locality filter cross-references `organization_coverage` (org must cover the requested locality).
   - Card per pet: photo, name, species, breed, age, holding org name + logo, CTA.
4. Detail page `/adoptar/[petToken]`:
   - Reads pet + photos + a rescue-story summary from `shelter_intake_recorded` (intake_condition + free-text notes).
   - CTA "Solicitar adopción" → if logged in, links to T-3.2 form; if not, links to login with `redirectTo` set.
5. **No PII anywhere** — verified in PR description by a checklist.

**Acceptance.**
- A pet with `publish_to_adopt=true` held by a verified shelter appears in the listing.
- Filtering by barrio narrows to orgs whose coverage matches.
- An unauth-only path is accessible without login.

**Tests.**
- Page-level: a non-published or unverified-org-held pet does not appear.
- PII audit: no profile/membership data in the rendered HTML.

**Risks.** Listing grows unbounded. v1 acceptable; add a TODO comment for materialized view when count exceeds ~500.

---

#### T-3.2 — Adoption applications

- **Status:** [x] done
- **Group:** 3
- **Depends on:** T-3.1
- **Parallel-safe with:** none in Group 3
- **Files:** `app/(app)/adoptar/[petToken]/aplicar/page.tsx`, `app/(app)/adoptar/[petToken]/aplicar/ApplicationForm.tsx`, `app/(app)/aplicaciones/page.tsx`, `app/(refugio)/refugio/[orgToken]/aplicaciones/page.tsx`, `app/(refugio)/refugio/[orgToken]/aplicaciones/[applicationEventId]/page.tsx`, `app/(refugio)/refugio/[orgToken]/aplicaciones/[applicationEventId]/ReviewActions.tsx`, `app/actions/adoption-applications.ts`, `lib/adoption-applications.ts`

**Goal.** Adopters can apply; orgs review/approve/reject through an inbox.

**Steps.**
1. Apply page `/adoptar/[petToken]/aplicar`:
   - Authenticated only.
   - Form fields per Flow 6: housing_type (dropdown), other_pets (text), daily_routine (textarea), notes.
   - Submit calls `submitAdoptionApplicationAction` which emits `adoption_application_submitted` per Flow 6 + notification to org admins/coordinators.
2. Adopter's own applications list `/aplicaciones`:
   - Lists every `adoption_application_submitted` event where `payload.applicant_user_id = current user`.
   - Each row computes status from the latest event in the chain (via `lib/adoption-applications.ts`).
3. Org inbox `/refugio/[orgToken]/aplicaciones`:
   - Lists every `adoption_application_submitted` event where `payload.related_organization_id = current org`.
   - Filterable by pet, status, date.
4. Application detail `/refugio/[orgToken]/aplicaciones/[applicationEventId]`:
   - Shows applicant display_name (PII, audit-logged via `pii_access_log` — but that table doesn't exist yet; for v1, just log to `console.info` with a TODO).
   - Buttons: "Marcar como revisada" → `reviewApplicationAction` emits `adoption_application_reviewed`. "Aprobar" → emits `_approved`. "Rechazar" → emits `_rejected`. All with `requireCapability("adoption.applications.review" / .approve / .reject, ...)`.
   - Pre-check on approve: no other pending approval exists for the same pet without a `adoption_finalized` referencing it.
5. `lib/adoption-applications.ts` exports `computeApplicationStatus(applicationEventId): 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'finalized'` — pure function over the events.

**Acceptance.**
- Adopter applies; org sees the application; org approves; adopter sees status change.
- Approving a second application for the same pet (when first not finalized) is blocked with a clear Spanish message.

**Tests.**
- Action: submit, review, approve (success + duplicate-block), reject.
- `computeApplicationStatus` for each path.

**Risks.** Status drift between UI and DB. Always derive from events; never cache status in a column.

---

#### T-3.3 — Finalize adoption (Flow 7 — the atomic composite)

- **Status:** [x] done
- **Group:** 3
- **Depends on:** T-3.2 (uses approved application), T-2.3 (handles active foster if present)
- **Parallel-safe with:** none in Group 3
- **Files:** `app/(refugio)/refugio/[orgToken]/aplicaciones/[applicationEventId]/FinalizeModal.tsx`, `app/actions/adoption.ts`, `lib/reminder-schedule.ts`, `__tests__/adoption-finalize.test.ts` (crash-injection)

**Goal.** The single highest-stakes write in the system. Atomically transfers custody from org to adopter, ends foster if active, schedules check-in reminders.

**Steps.**
1. From the application detail (when status = `approved`), button "Finalizar adopción" opens a modal:
   - Confirmation: adopter + pet.
   - Upload contract attachment (calls existing upload helper, sets `purpose='adoption_contract'`, `organization_id` set).
   - Input `post_adoption_followup_months` (default 6, min 0, max 24).
2. `finalizeAdoptionAction` implements Flow 7. **All six steps inside one `db.transaction`:**
   - Step 1: Validate pre-conditions (call once outside the transaction for early failure: org still holds shelter_custody, the application is still the latest approved, no `adoption_finalized` already references the application_event_id — idempotency check).
   - Step 2: Inside transaction: update existing `shelter_custody` ownership `ended_at`.
   - Step 3: If a foster ownership row is active for the pet, update its `ended_at` and insert a `foster_ended` event with `reason='adoption'`.
   - Step 4: Insert new `owner` ownership for adopter.
   - Step 5: Insert `adoption_finalized` event with the payload from Flow 7.
   - Step 6: Insert reminder rows for check-ins via `lib/reminder-schedule.ts` (months 1, 3, and `followup_months`; dedupe overlaps).
   - Post-commit: insert celebratory notification to adopter.
3. Idempotency: if `adoption_finalized` already exists for the application_event_id, return that finalized id with zero writes.
4. **Crash-injection test:** throw inside step 4 of the transaction; assert zero partial writes (no new ownership for adopter, no event, no reminders; original shelter_custody still `ended_at IS NULL`).

**Acceptance.**
- After finalize: ownership transferred, foster (if any) ended, event emitted, reminders scheduled, adopter notified.
- Calling finalize twice with the same application returns the same `adoption_finalized` event id (idempotent).
- Crash test demonstrates zero partial writes.

**Tests.**
- Action: happy path with no foster, happy path with active foster, idempotent repeat.
- Crash injection at each of steps 2, 3, 4, 5, 6 — every one rolls back.
- Permission denied for non-admin/coordinator.

**Risks.** This is the most likely place for a subtle bug. Mandatory two-reviewer policy on the PR. Manual smoke test in dev before merging.

---

#### T-3.4 — Post-adoption check-ins and revocation (Flows 8 and 9)

- **Status:** [x] done
- **Group:** 3
- **Depends on:** T-3.3
- **Parallel-safe with:** none in Group 3
- **Files:** `app/(app)/mis-mascotas/[publicToken]/PostAdoptionCheckInCard.tsx`, `app/actions/post-adoption.ts`, `app/api/cron/post-adoption-checkins/route.ts`, `app/(refugio)/refugio/[orgToken]/mascotas/[petToken]/RevokeAdoptionModal.tsx`

**Goal.** Adopter check-ins, missed-check-in cron, admin-only revocation.

**Steps.**
1. Adopter-side: on `/mis-mascotas/[petToken]`, when the pet was adopted from an org AND now is within the followup window AND a pending reminder exists, render a check-in card. Submission emits `post_adoption_checkin` per Flow 8 and marks the reminder complete.
2. Cron route `/api/cron/post-adoption-checkins`:
   - Auth header check (shared secret).
   - Query reminders past `due_at + interval '7 days'` with `completed_at IS NULL` and `source_event_id` referencing an `adoption_finalized` event.
   - For each, insert a `notifications` row of type `adoption_post_checkin_missed` for both adopter and org admins/coordinators of the originating org.
   - Dedupe pattern: skip if an unarchived notification with same `(user_id, notification_type, related_event_id)` already exists.
3. Revocation: from T-2.4 pet detail post-finalize (admin-only — `requireCapability("adoption.revoke", ...)`), modal with required reason. `revokeAdoptionAction` implements Flow 9 atomically.

**Acceptance.**
- Adopter check-in: event + reminder complete + org notified.
- Missed check-in: one notification per recipient per missed reminder per cron tick, no duplicates on subsequent ticks.
- Revocation: atomic ownership transfer back to org.

**Tests.**
- Action: check-in happy path.
- Cron: dedupe correctness across two consecutive ticks.
- Action: revoke happy path, transactional crash.

**Risks.** Cron runs without auth → leak. Shared-secret header check is required; do not deploy without it.

---

### Group 4 — Surface and integration

#### T-4.1 — Refactor event-writing forms to honor org context

- **Status:** [x] done
- **Group:** 4
- **Depends on:** Group 2 complete + Group 3 complete
- **Parallel-safe with:** T-4.2, T-4.3, T-4.4
- **Files:** every action in `app/actions/events.ts`, every action in `app/actions/pets.ts`

**Goal.** Every existing event-writing server action reads `getCurrentOrgContext()` and produces authorship correctly. No regressions on personal-owner flows.

**Steps.**
1. Audit every action in `app/actions/events.ts` and `app/actions/pets.ts`. For each:
   - Replace hardcoded `authorRole: 'owner'` with `resolveAuthorship(currentOrg, profile, orgVerified)`.
   - Replace the existing "current user is owner of this pet" check with a more nuanced pre-check:
     - If `currentOrg` is null (personal mode): existing owner check stands.
     - If `currentOrg` is set: require an active `shelter_custody` ownership for the pet owned by `currentOrg` OR an active `foster` ownership owned by current user (and the matrix entry for `foster.write_events_on_assigned_pet` for the event type in question).
   - Replace ad-hoc permission checks with `requireCapability("events.write.<family>", currentOrg, perPetContext?)`.
2. Update the existing event-form pages to surface the active context in their headers ("Estás registrando como {org.name}" when in org context, plain otherwise).

**Acceptance.**
- Existing personal-owner test suite green (no regressions).
- New tests: org-context write succeeds when capability + custody align; denied otherwise.
- Foster can write the limited event set on their assigned pet; cannot write on a pet they don't foster.

**Tests.**
- Action: every event type, in each of three contexts (personal-owner, org-member, foster).

**Risks.** Easy to miss one action. Use a CI grep to assert no action calls `db.insert(petEvents)` without going through a `resolveAuthorship`-using helper. Add a small `lib/insert-pet-event.ts` wrapper if needed and lint against direct inserts.

---

#### T-4.2 — Public org page `/o/[orgToken]`

- **Status:** [x] done
- **Group:** 4
- **Depends on:** T-1.1
- **Parallel-safe with:** T-4.1, T-4.3, T-4.4
- **Files:** `app/o/[orgToken]/page.tsx`, `app/o/[orgToken]/OrgPublicView.tsx`

**Goal.** Public profile page for verified orgs.

**Steps.**
1. Route reads the org via the **Supabase client** (PostgREST), not Drizzle direct connection — so RLS gates it. The existing `organizations_rls.sql` returns rows only for `verified=true`.
2. Display: logo, display_name, org_type label, contact (email, phone, website), primary coverage zone (and full coverage list), count of currently-published-to-adopt pets, lifetime count of finalized adoptions, CTA to `/adoptar?org={token}`.
3. Cache: `revalidate = 300` (5 min) — the page is public-read-heavy.

**Acceptance.**
- Unverified org returns 404 (via RLS, nothing renders).
- Verified org renders cleanly; no member names, no PII.

**Tests.**
- Page-level: rendered HTML contains expected sections and zero PII strings.

**Risks.** RLS bypass via cache. Page is rendered server-side per-request; revalidate cache keyed by token only.

---

#### T-4.3 — Tier-0 origin-org branding

- **Status:** [ ] pending (pendiente)
- **Group:** 4
- **Depends on:** T-3.3 (needs `adoption_finalized` flowing)
- **Parallel-safe with:** T-4.1, T-4.2, T-4.4
- **Files:** `db/schema.ts`, `db/migrations/0005_origin_org_branding.sql`, `app/p/[publicToken]/page.tsx`, `components/PetForm.tsx` (add the toggle), `app/actions/pets.ts` (handle the new field on update)

**Goal.** "Bajo seguimiento de {Org}" badge on the public credential when both opt-ins are true. Dual-routing of the "Did you find this pet?" form.

**Steps.**
1. Migration `0005_origin_org_branding.sql`: add `pets.tier_0_show_origin_org boolean not null default true`. Idempotent.
2. PetForm: add a "Privacidad de la credencial pública" section with the toggle. Adopter explanation: "Si lo apagás, no aparece el refugio que te dio en adopción en la página pública de tu mascota."
3. On `/p/[publicToken]`, compute the badge per the algorithm in `dim-interno:docs/archive/org-portal-prompt.md` § Task 4.3:
   - Resolve candidate org: current `shelter_custody` org, or origin org from latest `adoption_finalized` if within followup window.
   - Badge renders only when `org.verified=true AND org.tier_0_show_branding=true AND (currently shelter-held OR pet.tier_0_show_origin_org=true)`.
4. When the badge renders, the existing "¿Encontraste a esta mascota?" form posts to a server action that fans-out to both the legal owner and the originating org.

**Acceptance.**
- Toggle off (either side) hides the badge.
- Origin id readable from `adoption_finalized.payload.previous_owner_organization_id` regardless of badge state.
- Found-pet form sends to both inboxes when badge renders.

**Tests.**
- Page-level: badge visibility for each combination of `tier_0_show_branding` and `tier_0_show_origin_org`.
- Action: dual-routing of found-pet notifications.

**Risks.** Adopter does not realize the toggle exists. UX copy must be clear: "Por defecto, mostramos al refugio que te dio en adopción durante {N} meses. Si lo apagás, no aparece."

---

#### T-4.4 — Lost-pet broadcast to org volunteers

- **Status:** [x] done
- **Group:** 4
- **Depends on:** T-1.3 (coverage zones), existing `setPetLostAction`
- **Parallel-safe with:** T-4.1, T-4.2, T-4.3
- **Files:** `db/schema.ts`, `db/migrations/0006_broadcasts_opt_out.sql`, `app/actions/events.ts` (extend `setPetLostAction`), `app/actions/lost-pet-broadcast.ts` (new), `app/(refugio)/refugio/[orgToken]/miembros/page.tsx` (surface the toggle)

**Goal.** Marking a pet as lost notifies relevant volunteers of relevant orgs.

**Steps.**
1. Migration `0006_broadcasts_opt_out.sql`: add `organization_memberships.receives_broadcasts boolean not null default true`. Idempotent.
2. New `broadcastLostPetAction(petId, status_changed_event_id)`:
   - Resolve location: event's `location_lat/lng` if set, else pet's `jurisdiction_locality` + `jurisdiction_province`.
   - Query orgs: `verified=true AND org_type IN ('shelter', 'rescue_network')` whose `organization_coverage` includes the resolved location (match on locality slug + province code; fall back to province-only if locality not specified).
   - Query members of those orgs: active memberships with `role IN ('volunteer', 'coordinator', 'admin')` AND `receives_broadcasts=true`.
   - Dedupe per `(user_id, related_pet_id)` within the last 24 hours.
   - Insert `notifications` rows of type `lost_pet_broadcast`, severity `urgent`, CTA to `/p/{token}`.
3. Extend `setPetLostAction` to call `broadcastLostPetAction` after the status_changed event commits.
4. Members page (T-1.2): expose the `receives_broadcasts` toggle per row (member can toggle their own; admins can toggle others'? — defer; v1: self only).

**Acceptance.**
- Marking a pet as lost in CABA Palermo notifies every volunteer/coordinator/admin of every verified shelter that covers Palermo, exactly once per 24h.
- Members who opt out receive nothing.

**Tests.**
- Action: broadcast happy path, dedupe across two calls within 24h, opt-out excluded.

**Risks.** Spam. The 24h dedupe is the safety valve; the opt-out is the user control.

---

## 10. Integration milestones

After each group is complete, run the milestone smoke test. If it fails, the group is not done — fix the gap before starting the next.

### M0 — End of Group 0
- [ ] User can switch between "Modo personal" and any active membership; cookie reflects choice.
- [ ] `EVENT_TYPES.length` has grown by 12.
- [ ] `lib/org-permissions.ts` tests green.
- [ ] `generateOrgPublicToken()` produces valid tokens.

### M1 — End of Group 1
- [ ] User registers a new refugio (dev) → org appears verified → user becomes admin.
- [ ] Admin invites a second user by email → URL is shown → second user opens URL → accepts → appears in members list.
- [ ] Admin declares two coverage zones (one CABA barrio, one Mendoza province); marks Mendoza as primary; reload preserves state.

### M2 — End of Group 2
- [ ] Admin records intake of a brand-new pet → pet appears in org dashboard → timeline has `pet_registered` + `shelter_intake_recorded`.
- [ ] Admin searches a pet by microchip (use a pet from an existing personal-owner test account); transfers custody in → previous owner sees a notification → event log has `custody_transferred` + `shelter_intake_recorded`.
- [ ] Admin assigns a foster (test user with org membership) → both shelter_custody and foster ownership rows are active.
- [ ] Foster ends tránsito with reason `returned` → only shelter_custody remains active → `foster_ended` event present.
- [ ] Org A proposes transfer to Org B → Org B accepts → custody atomically moves; both event ids cross-referenced.

### M3 — End of Group 3
- [ ] Admin toggles `publish_to_adopt` on a pet → it appears at `/adoptar` (anonymous browse OK).
- [ ] Logged-in user opens detail → applies → org sees application → reviews → approves.
- [ ] Admin finalizes adoption with a 6-month followup → adopter sees pet in their `/mis-mascotas` → org no longer has it in custody → 3 reminders scheduled.
- [ ] Adopter does a check-in → event present → reminder complete → org admin notified.
- [ ] Cron run for missed check-ins: dedupe correctness across two ticks.

### M4 — End of Group 4
- [ ] Org member in org context writes a vaccination event → authorship reflects org.
- [ ] Personal owner writes a vaccination event → authorship is `owner`.
- [ ] `/o/{orgToken}` renders for verified org; 404 for unverified.
- [ ] Public credential of adopted pet shows org branding when both opt-ins true; hides otherwise.
- [ ] Pet marked as lost in Palermo notifies test volunteer of test refugio that covers Palermo.

## 11. Verification queries

Useful SQL the orchestrator can run via `psql` against local Supabase to confirm state at any point.

```sql
-- M0: event types count
select count(*) from unnest(enum_range(null::text)) as t where false; -- not enum
-- (Use TS-side: EVENT_TYPES.length)

-- M1: orgs and memberships
select o.display_name, o.verified, m.role, m.can_write_pet_events
  from organizations o join organization_memberships m on m.organization_id=o.id
  where m.user_id = '<your test user id>' and m.left_at is null;

-- M1: coverage
select o.display_name, oc.jurisdiction_province, oc.jurisdiction_locality, oc.is_primary
  from organizations o join organization_coverage oc on oc.organization_id=o.id
  where o.id = '<test org id>';

-- M2: pet currently in custody
select p.name, ow.role, ow.started_at, o.display_name
  from pets p join ownerships ow on ow.pet_id=p.id
  left join organizations o on o.id=ow.owner_organization_id
  where p.id='<test pet id>' and ow.ended_at is null;

-- M2: transfer handshake state
select event_type, payload->>'proposal_event_id' as proposal_id, recorded_at
  from pet_events where pet_id='<pet id>' and event_type in (
    'custody_transfer_proposed', 'custody_transferred', 'note_added'
  ) order by recorded_at;

-- M3: adoption finalized atomicity
select event_type, recorded_at, payload from pet_events
  where pet_id='<pet id>' and event_type in (
    'adoption_application_submitted','adoption_application_approved','foster_ended','adoption_finalized'
  ) order by recorded_at;
select * from ownerships where pet_id='<pet id>' order by started_at;

-- M3: reminders scheduled
select reminder_type, due_at, completed_at, source_event_id from reminders
  where pet_id='<pet id>' order by due_at;

-- M4: authorship distribution
select author_role, author_organization_id is not null as is_org, count(*)
  from pet_events group by 1, 2;
```

## 12. End-to-end smoke test

After M4, run this happy path manually (or via Playwright if it has been wired). The orchestrator captures screenshots of each step into `docs/org-portal-walkthrough.md`.

1. Sign up as `alice@example.com`.
2. Register a refugio (Refugio Las Patitas) in CABA.
3. Invite `bob@example.com` as `coordinator`. Copy URL.
4. Open URL in another browser; sign up as Bob; accept invitation.
5. Bob declares coverage: CABA → Palermo, Recoleta. Mendoza → Mendoza Capital (primary).
6. Bob records intake of a new pet "Luna" (rescue, found in Palermo).
7. Bob assigns Alice as foster.
8. Alice opens her `/mis-mascotas` → sees Luna with "Tránsito de Las Patitas" badge.
9. Bob ends foster (reason: adoption — but we go through proper finalize, so reason here is `escalated`).
10. Bob publishes Luna to adopt.
11. Sign up as `carla@example.com`. Browse `/adoptar`. Apply for Luna.
12. Bob reviews → approves Carla's application.
13. Bob finalizes adoption with 6-month followup.
14. Carla sees Luna in her `/mis-mascotas`.
15. Public credential `/p/{luna_token}` shows "Adoptada de Las Patitas ✓".
16. Carla toggles "Privacidad" off; badge disappears.
17. Carla marks Luna as lost. Bob's other volunteer (test user with `receives_broadcasts=true`) receives an urgent notification.
18. Carla marks Luna as found.
19. Carla does the first check-in. Bob is notified.

## 13. Rollback plans

Each migration is additive and reversible by drop. Reverse SQL is documented at the bottom of each migration file inside a comment block (`/* DOWN: ... */`). To revert:

- `0003`: `alter table attachments drop column purpose; alter table attachments drop column organization_id; drop table organization_invitations;`
- `0004`: `alter table pets drop column publish_to_adopt;`
- `0005`: `alter table pets drop column tier_0_show_origin_org;`
- `0006`: `alter table organization_memberships drop column receives_broadcasts;`

Event-log rows are never deleted. If a faulty event is emitted in dev, correct via a new event; do not surgical-delete.

## 14. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `adoption_finalized` leaves partial state | low | critical | Mandatory crash-injection test; two-reviewer policy on T-3.3 PR. |
| Org context cookie tampering | medium | medium | Membership re-validation on every `getCurrentOrgContext()` call. |
| Verification auto-enable in prod | low | high | Explicit `process.env.NODE_ENV` guard + log line. |
| Lost-pet broadcast spam | medium | medium | 24h dedupe + opt-out. |
| `EVENT_TYPES` drift between code and renderer | medium | low | Test asserts every value has a renderer. |
| Race on dual-acceptance of a transfer proposal | low | medium | DB-level partial unique index on ownership + user-friendly conflict error. |
| Storage attachment orphans (cancelled upload) | medium | low | Existing cleanup pattern from welfare module — reuse `cleanupAttachment` helper. |
| RLS bypass via Drizzle direct connection | high | high (without controls) | Server actions are the authorization boundary; `requireCapability` everywhere. RLS is defense-in-depth, not the only barrier. |

## 15. Definition of done

The org portal build is complete when **all** of the following are true:

- [ ] All 16 task checkboxes flipped to `[x]`.
- [ ] All four milestone smoke tests pass.
- [ ] The end-to-end smoke test in §12 runs cleanly without manual intervention.
- [ ] `pnpm lint && pnpm typecheck && pnpm build && pnpm test` green on `develop`.
- [ ] `AGENTS.md` updated: v1 screens section lists the new routes; open questions section ticks off `/refugio`, `/adoptar`, lost-pet broadcast; adds new deferred items (real email, full admin verification, bulk operations).
- [ ] `docs/org-portal-walkthrough.md` exists with screenshots of the smoke test.

## 16. Open questions parking lot

If any of the below come up mid-build, do not block; park them here and continue.

- Vet portal (`/pro`) and clinic context for `vet_individual` members — separate stream.
- Government dashboards (`/gob`) — separate stream.
- `pii_access_log` table for adopter-PII reads by org admins — currently a `console.info` TODO.
- Per-pet "emergency info" flag toggle for Tier 0+ — covered in v1 closure stream.
- Real transactional email — separate stream; will come back to invitations and notifications when wired.
- Bulk operations for El Campito-scale shelters — separate stream after v1 portal lands.
- Materialized views for `/adoptar` listing performance — when count exceeds ~500.
- Push notifications (iOS PWA limitations) — covered in product backlog.
- Cross-org transfer with confirmation across users (sender confirms / receiver accepts at the *human* level, not just org level) — possible v2 enhancement.

---

## Appendix A — File map

Predicted files added or significantly modified by this build. Use as a sanity check during code review.

```
db/
  schema.ts                              [modified: 1 table, 5 columns]
  migrations/
    0003_org_invitations.sql             [new: invitations table + 2 attachments columns]
    0004_publish_to_adopt.sql            [new]
    0005_origin_org_branding.sql         [new]
    0006_broadcasts_opt_out.sql          [new]
lib/
  org-permissions.ts                     [new]
  event-authorship.ts                    [new]
  current-org.ts                         [new]
  adoption-applications.ts               [new]
  custody-transfers.ts                   [new]
  reminder-schedule.ts                   [new — adoption check-in dates]
  pet-resolution.ts                      [new helper]
  pet-search.ts                          [new helper]
  cuit.ts                                [new — AR CUIT checksum]
  insert-pet-event.ts                    [optional — lint hook for authorship]
  publicToken.ts                         [modified: generateOrgPublicToken]
  events.ts                              [modified: 12 new renderer cases]
components/
  OrgContextSwitcher.tsx                 [new]
  LocationFields.tsx                     [pre-existing from location-unification stream — used by 4 new routes]
app/
  actions/
    organizations.ts                     [new]
    org-memberships.ts                   [new]
    org-invitations.ts                   [new]
    org-coverage.ts                      [new]
    org-context.ts                       [new]
    intake.ts                            [new]
    foster.ts                            [new]
    custody-transfers.ts                 [new]
    publish-pet.ts                       [new]
    adoption-applications.ts             [new]
    adoption.ts                          [new]
    post-adoption.ts                     [new]
    lost-pet-broadcast.ts                [new]
    events.ts                            [modified: authorship via resolveAuthorship]
    pets.ts                              [modified: tier_0_show_origin_org handling]
  (refugio)/
    layout.tsx                           [new]
    refugio/
      nueva/page.tsx                     [new]
      [orgToken]/
        page.tsx                         [new — dashboard]
        configuracion/page.tsx           [new]
        miembros/page.tsx                [new]
        miembros/invitar/page.tsx        [new]
        cobertura/page.tsx               [new]
        mascotas/
          nueva/page.tsx                 [new]
          buscar/page.tsx                [new]
          transferir/[petToken]/page.tsx [new]
          [petToken]/page.tsx            [new]
        transitos/page.tsx               [new]
        transfers/recibidos/page.tsx     [new]
        transfers/emitidos/page.tsx      [new]
        aplicaciones/page.tsx            [new]
        aplicaciones/[id]/page.tsx       [new]
    r/invite/[token]/page.tsx            [new — public]
  o/[orgToken]/page.tsx                  [new — public]
  adoptar/
    page.tsx                             [new — public]
    [petToken]/page.tsx                  [new — public]
  (app)/
    adoptar/[petToken]/aplicar/page.tsx  [new — authed]
    aplicaciones/page.tsx                [new]
    mis-mascotas/page.tsx                [modified: header switcher]
    mis-mascotas/[publicToken]/page.tsx  [modified: post-adoption checkin card]
  api/cron/post-adoption-checkins/route.ts [new]
  p/[publicToken]/page.tsx               [modified: origin-org badge logic]
docs/
  org-portal-walkthrough.md              [new — screenshots after E2E]
```

## Appendix B — Glossary

- **Org context.** The active "acting as" identity of a user — either personal or a specific organization membership. Lives in a cookie; resolved per request.
- **Composite event.** An event whose payload references prior events and whose insertion must be atomic with updates to one or more `ownerships` rows. Currently: `adoption_finalized`, `adoption_revoked`. Implemented inside `db.transaction`.
- **Projection.** A read-time computation over the event log. `ownerships` is a projection of custody events. `/adoptar` is a projection over org-held pets. No projection is the source of truth.
- **Verified org.** An organization with `verified=true`. Required for public visibility, `author_verified=true` on events, broadcast targeting, branding on credentials. In dev: auto-verified. In prod: admin-stamped via Studio (until admin tooling lands).
- **Origin org.** The verified shelter or rescue network that finalized the adoption. Persisted in `adoption_finalized.payload.previous_owner_organization_id`. Never erased from the event log; visual branding is a separate concern.
- **Two-event handshake.** The proposal+acceptance pattern for org-to-org custody transfers. State is derived from the event log by `lib/custody-transfers.ts`.
