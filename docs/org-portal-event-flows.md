# DIM — Org portal event flows

> **IMPLEMENTED / shipped.** The flows described here are live in `src/modules/*/actions.ts`.
> This document is archived for historical reference. Notable deviations from the original plan:
>
> - `adoption_application_reviewed` event type **removed** (catalog cleanup 2026-05-18) — the
>   application table's `status` field covers the "in review" stage.
> - `adoption_revoked` **renamed** to `adoption_reversed` (umbrella for revoked + withdrawn;
>   catalog cleanup 2026-05-19). Actor discriminator: `shelter | adopter | court`.
> - Cross-org transfer cancellations emit `custody_transfer_cancelled` (dedicated event type),
>   NOT `note_added(category='custody_transfer_cancelled')` — structured cancellation is ARCH-B fix.
> - Cross-org transfer expiry is **30 days** (not 7 days).
> - Routes are at `/org/[orgToken]/*` (not `/refugio/[orgToken]`).
> - Org portal lives in `app/org/` route group (not `app/(refugio)/`).

The atomic event sequences for each composite workflow in the org portal. The orchestrator should treat these as authoritative; the spec in `AGENTS.md` is more permissive but this file fixes the open questions.

All transactions below run inside a single `db.transaction(async (tx) => { ... })` block. Failure of any step rolls back all of them. Every event row gets `recorded_by_user_id` (the human), `author_role`, `author_organization_id`, `author_verified` set via `lib/event-authorship.ts`.

## EVENT_TYPES additions

Append the following to `EVENT_TYPES` in `db/schema.ts` (alphabetical order within their group is fine; the existing order is purpose-grouped). Per AGENTS.md, adding event types is a **one-line edit, no migration**:

```ts
// Custody — transfers between users and orgs (two-event handshake for proposals)
"custody_transfer_proposed",
"custody_transferred",
"custody_transfer_cancelled",  // structured cancellation (ARCH-B fix; replaces note_added approach)

// Custody — shelter intake
"shelter_intake_recorded",

// Custody — foster
"foster_assigned",
"foster_ended",

// Adoption pipeline
"adoption_application_submitted",
// "adoption_application_reviewed" — REMOVED (catalog cleanup 2026-05-18)
"adoption_application_resolved",  // outcome: approved|rejected (collapses _approved/_rejected)
"adoption_finalized",
"post_adoption_checkin",
// "adoption_revoked" — RENAMED to adoption_reversed (catalog cleanup 2026-05-19)
"adoption_reversed",  // actor: shelter|adopter|court
```

None of these require enum changes — `event_type` is `text`.

## Flow 1 — Shelter intake, new pet in DIM

User: org member with `custody.intake.new_pet`. Pet does not exist in DIM yet (microchip lookup returned nothing, owner search returned nothing).

Transaction:

1. Insert `pets` row. Status `active`. Author org's jurisdiction copied to `pet.jurisdiction_*` as a starting point (editable later). `created_at` = `now()`.
2. Insert `ownerships` row: `pet_id`, `owner_organization_id = org.id`, `role = 'shelter_custody'`, `started_at = now()`, `ended_at = null`.
3. Insert `pet_events` row of type `pet_registered`. Payload = initial profile snapshot. Authorship: `author_role='shelter'`, `author_organization_id=org.id`.
4. Insert `pet_events` row of type `shelter_intake_recorded`. Payload `{ intake_reason, intake_condition?, rescue_jurisdiction?, found_location_note? }`. `location_lat/lng` if the form captured them. Same authorship.
5. Insert `notifications` row to every org admin: "Mascota intake registrada: {pet.name}". `related_pet_id` set.

If a microchip was provided in the form, also insert a `microchip_implanted` event between steps 3 and 4 (same authorship). Set `pets.microchip_*` columns.

## Flow 2 — Shelter intake, pet already exists in DIM

Pre-condition: the form found a pet by microchip / public_token / owner search and the user confirmed it's the same animal. The pre-flow shows the current owner (if any) and asks for the intake reason.

Two sub-cases:

**2a. Pet has no active owner** (was previously in another org's `shelter_custody`, or pet was orphaned). Equivalent to a transfer-in with no sender:
- Insert `pet_events` row of type `custody_transferred`. Payload `{ from_organization_id: prevOrg.id, from_user_id: null, to_organization_id: org.id, to_user_id: null, reason }`. Authorship by receiving org.
- Update prior `ownerships` row: `ended_at = now()`.
- Insert new `ownerships` row: `owner_organization_id = org.id`, `role = 'shelter_custody'`.
- Insert `shelter_intake_recorded` event with intake_reason etc.

**2b. Pet has an active owner (a person)** — common case: animal abandonment, decomiso, owner surrender:
- Insert `pet_events` of type `custody_transferred`. Payload `{ from_user_id: oldOwner.id, to_organization_id: org.id, reason: 'abandonment' | 'surrender' | 'seizure' | 'other', authority_reference? }`.
- Update prior `ownerships`: `ended_at = now()`.
- Insert new `ownerships`: `owner_organization_id = org.id`, `role = 'shelter_custody'`.
- Insert `shelter_intake_recorded` event.
- Insert `notifications` row to the previous owner: title "Custodia transferida a {org.name}", body explains the reason. Severity `warning` unless reason is `seizure` (then `urgent`).

The `notes` field on the events carries any free-text the operator wrote.

## Flow 3 — Custody transfer between orgs (two-event handshake)

**Proposing side** (Refugio A wants to hand pet X to Refugio B).

Step P1 — User: admin/coordinator of Refugio A with `custody.transfer.propose_out`.

Single insert (not a transaction; nothing else changes):
- Insert `pet_events` of type `custody_transfer_proposed`. Payload `{ to_organization_id: orgB.id, proposed_by_user_id, reason?, expires_at }`. Authorship by Refugio A.
- Insert `notifications` row to every admin/coordinator of Refugio B: "Refugio A te propone recibir custodia de {pet.name}". CTA link to the accept screen.

The proposal is "pending" while there is a `custody_transfer_proposed` event for this pet with no matching `custody_transferred` (or cancellation) emitted after it. No state column anywhere — the event log *is* the state.

**Accepting side** (Refugio B accepts or rejects).

Step A1 — User: admin/coordinator of Refugio B with `custody.transfer.accept_in`. UI shows the proposal; user clicks "Aceptar" or "Rechazar".

If accepted:
- Transaction:
  - Insert `pet_events` of type `custody_transferred`. Payload `{ from_organization_id: orgA.id, to_organization_id: orgB.id, proposal_event_id: <P1 event id>, reason }`. Authorship by Refugio B.
  - Update prior `ownerships` of Refugio A: `ended_at = now()`.
  - Insert new `ownerships` for Refugio B: `role = 'shelter_custody'`.
  - Insert `notifications` to Refugio A admins: accepted.

If rejected:
- Insert `pet_events` of type `custody_transfer_cancelled` with payload `{ proposal_event_id: <P1 event id>, cancelled_by: 'receiver', reason? }`. Authorship by Refugio B.
- Insert `notifications` to Refugio A admins: rejected.

**Cancelling side** (Refugio A cancels before B responds).

Step C1 — User: admin/coordinator of Refugio A with `custody.transfer.cancel`:
- Insert `pet_events` of type `custody_transfer_cancelled` with payload `{ proposal_event_id: <P1 event id>, cancelled_by: 'sender', reason? }`. Authorship by Refugio A.
- Insert `notifications` to Refugio B admins: cancelled.

> **Note:** Cross-org transfer proposals expire after **30 days** (not 7 days as originally planned).
> State is tracked via the `custody_transfer_handshake` case kind (`lib/case-attachment.ts`).

A proposal is "still pending" only if **none** of these follow-up events (`custody_transferred` or `custody_transfer_cancelled`) reference it by `proposal_event_id`.

## Flow 4 — Foster assign

User: admin/coordinator of org with `foster.assign`. Pre-condition: target user has an active `organization_memberships` row with this org (any role) — typically `volunteer` or `foster`. If they have `member`/`volunteer` and not `foster`, the assign action **also updates their membership role to `foster`** (or leaves it untouched if they're a coordinator — coordinators can foster without changing role).

Transaction:
1. Insert `pet_events` of type `foster_assigned`. Payload `{ foster_user_id, expected_weeks?, notes? }`. Authorship by org.
2. Insert `ownerships` row alongside the existing `shelter_custody` row: `owner_user_id = foster.id`, `role = 'foster'`, `started_at = now()`. **The shelter_custody row stays active.** Both rows are "current" until foster_ended.
3. Insert `notifications` to the foster user: "{org.name} te asignó como tránsito de {pet.name}". CTA to the pet's detail page.

The `ownerships_one_active_owner_per_pet` partial unique index allows this — it only prevents two active rows of `role='owner'`, not other roles.

## Flow 5 — Foster end

User: admin/coordinator of org with `foster.end`, OR the foster themselves (per the matrix, foster can end self only).

Transaction:
1. Insert `pet_events` of type `foster_ended`. Payload `{ foster_user_id, reason: 'adoption' | 'returned' | 'escalated' | 'other' }`. Authorship by org.
2. Update the foster `ownerships` row: `ended_at = now()`. **The shelter_custody row remains active.**
3. Insert `notifications` to foster (when ended by admin) or to org admins (when ended by foster): "Tránsito de {pet.name} cerrado: {reason}".

If `reason='adoption'`, this flow runs as part of Flow 7 (`adoption_finalized`) inside the same transaction — do not call it twice.

## Flow 6 — Adoption application

**Submission** — User: any authenticated user (potential adopter) on the public `/adoptar/{petToken}`.

Single insert:
- Insert `pet_events` of type `adoption_application_submitted`. Payload `{ applicant_user_id, related_organization_id: pet's current custody org id, housing_type?, other_pets?, daily_routine?, notes? }`. Authorship: `author_role='owner'`, `author_organization_id=null` (the applicant is acting as an individual, not as the org), `recorded_by_user_id=applicant`.
- Insert `notifications` to every admin/coordinator of the org: "Nueva aplicación para {pet.name}". CTA to the application detail.

**Review** — `adoption_application_reviewed` event type was **removed** (catalog cleanup 2026-05-18).
The application table's `status` field covers the "in review" stage without a dedicated event.

**Approve / Reject** — User: admin/coordinator with `adoption.review`.

Insert `pet_events` of type `adoption_application_resolved`. Payload `{ application_event_id, reviewer_user_id, outcome: 'approved'|'rejected', reason?, conditions?, auto_generated? }`. Authorship by org.

Insert `notifications` to the applicant: "Tu aplicación para {pet.name} fue aprobada/rechazada".

An approved application becomes the pre-condition for Flow 7. There can only be one active approved application per pet at any time — if a second `adoption_application_approved` is emitted while the first hasn't been finalized, that's a logical conflict the UI must prevent (server action checks).

## Flow 7 — Adoption finalized (the atomic composite)

User: admin/coordinator with `adoption.finalize`. Pre-conditions checked in the action:
- Pet has an active `shelter_custody` row owned by `org.id`.
- There is a most-recent `adoption_application_approved` event for this pet that has not been finalized (no `adoption_finalized` event references it yet).
- The applicant (from the application event payload) is a current DIM user.
- The org has provided a `post_adoption_followup_months` value (default 6, configurable per finalize).

Transaction (single `db.transaction`):

1. Update existing `ownerships` row where `owner_organization_id = org.id AND role = 'shelter_custody'`: `ended_at = now()`.
2. If a foster `ownerships` row exists for this pet (`role = 'foster'`, `ended_at IS NULL`): update `ended_at = now()` and insert a `foster_ended` event with payload `{ foster_user_id, reason: 'adoption' }` (authorship by org). The transaction makes this atomic with the rest.
3. Insert new `ownerships` row: `owner_user_id = adopter.id`, `role = 'owner'`, `started_at = now()`, `transferred_from_id = <shelter_custody row id>`.
4. Insert `pet_events` of type `adoption_finalized`. Payload `{ application_event_id, previous_owner_organization_id: org.id, foster_user_id?, contract_attachment_id?, post_adoption_followup_months }`. Authorship by org.
5. Insert `notifications` to the adopter: "¡Felicitaciones! La adopción de {pet.name} está finalizada. Vas a recibir recordatorios para los check-ins durante los próximos {N} meses." CTA to pet detail.
6. Insert scheduled `reminders` rows for each check-in window (typically months 1, 3, 6 — derive from `post_adoption_followup_months`). `user_id = adopter.id`, `reminder_type = 'custom'`, `title = "Check-in de adopción"`, `source_event_id = <finalized event id>`.

After commit, the `pets.tier_0_show_origin_org` flag (new column — see Flow 9 prep) defaults to `true` so the public credential shows "Adoptada de {Org}" until the adopter opts out.

## Flow 8 — Post-adoption check-in

User: adopter (authenticated). UI surface: a check-in card on the adopter's `/mis-mascotas/{petToken}` during the followup window.

Single insert:
- Insert `pet_events` of type `post_adoption_checkin`. Payload `{ related_organization_id, photo_attachment_ids?, notes? }`. Authorship: `author_role='owner'`, `author_organization_id=null`, `recorded_by_user_id=adopter`.
- If photos uploaded, also insert their `attachments` rows linked to this event.
- Mark the corresponding `reminder` row as `completed_at = now()`.
- Insert `notifications` to org admins/coordinators: "Check-in recibido de {pet.name}". `related_event_id` set.

A missed check-in (reminder past due_at + 7 days without completion) generates a `notifications` row of type `adoption_post_checkin_missed` to **both** adopter and org admins (see scheduled job in main prompt). The public credential is not degraded — explicit AGENTS.md rule.

## Flow 9 — Adoption reversed (previously "adoption revoked")

> `adoption_revoked` was renamed to `adoption_reversed` in catalog cleanup 2026-05-19.
> It is the umbrella event for both revocation (shelter/court) and withdrawal (adopter).

User: admin (NOT coordinator) of the org that finalized. Used when the adopter is in clear breach.

Transaction:
1. Insert `pet_events` of type `adoption_reversed`. Payload `{ actor: 'shelter'|'adopter'|'court', reason, reverted_finalization_event_id }`. Authorship by org.
2. Update current `ownerships` row (`role='owner', owner_user_id=adopter`): `ended_at = now()`.
3. Insert new `ownerships` row: `owner_organization_id = org.id`, `role = 'shelter_custody'`.
4. Insert `notifications` to former adopter: "Adopción revertida", body explains the reason. Severity `urgent`.

The pet returns to `/adoptar` listing automatically (because the projection reads current Ownership).

## Schema prep that the orchestrator must do first

Two new columns on `pets`:

```ts
// Origin-org display on Tier 0 of public credential.
// Defaults true; adopter can opt out. Origin lineage stays in the event log regardless.
tier0ShowOriginOrg: boolean("tier_0_show_origin_org").notNull().default(true),
```

That's it. The `organizations.tier_0_show_branding` column already exists (org-side opt-in). The new pet-side column is the adopter's opt-out. Both must be true for the badge to render.

No other schema changes are required for these flows. All the event types are text, all the new ownership roles already exist in the enum (migration 0000), all the polymorphic columns exist on `Ownership` and `pet_events`.

## Sequence-diagram-style summary

```
INTAKE NEW PET:
  Tx { pets+ ; ownerships(shelter_custody)+ ; pet_registered+ ; shelter_intake_recorded+ } ; notifications+

INTAKE EXISTING (transfer-in from owner):
  Tx { custody_transferred+ ; ownerships(prev).end ; ownerships(shelter_custody)+ ; shelter_intake_recorded+ } ; notifications+

PROPOSE TRANSFER (org → org):
  custody_transfer_proposed+ ; notifications+ to receiver

ACCEPT TRANSFER:
  Tx { custody_transferred+ ; ownerships(sender).end ; ownerships(shelter_custody-receiver)+ } ; notifications+ to sender

FOSTER ASSIGN:
  Tx { foster_assigned+ ; ownerships(foster)+ alongside shelter_custody } ; notifications+

FOSTER END (standalone):
  Tx { foster_ended+ ; ownerships(foster).end } ; notifications+

ADOPTION FINALIZED (composite):
  Tx {
    ownerships(shelter_custody).end ;
    if foster: ownerships(foster).end + foster_ended+ ;
    ownerships(owner=adopter)+ ;
    adoption_finalized+ ;
    reminders(checkin)+ ×N
  } ; notifications+

POST-ADOPTION CHECKIN:
  post_adoption_checkin+ ; reminder.complete ; notifications+

ADOPTION REVERSED:
  Tx { adoption_reversed+ ; ownerships(owner).end ; ownerships(shelter_custody)+ } ; notifications+
```

`+` = insert; `.end` = set `ended_at = now()`; `Tx { ... }` = single atomic transaction.
