# `rehome` — acompañamiento de adopción (rehome-by-titular)

A titular who can no longer keep their pet asks a **verified org** to publish it
for adoption and vet applicants **while the animal keeps living at home**. The
titular keeps their `ownerships(role='owner')` row for the whole arrangement;
the org gets a `shelter_custody` row **beside** it, never instead of it. The
titular can end the arrangement unilaterally at any moment, and that always
wins over anything the org does. When an adoption finalizes, both rows close in
the transaction that opens the adopter's.

Vocabulary (es-AR UI): **"acompañamiento de adopción"** for the arrangement,
**"solicitud de nuevo hogar"** for the request case. Never "tránsito" (that is
the foster role, a different feature with its own "buscar hogar" flow for
fosters — `src/modules/foster/application/find-rehome-orgs.ts`, untouched).

Design artifacts live in Engram: `sdd/rehome-by-titular/{proposal,spec,design,tasks,apply-progress}`.
The ADR numbers below are the design's.

---

## Layout

```
domain/rehome-rules.ts           pure gates: who may ask / answer / withdraw, REQ-16
application/ports.ts             the PORT the use-cases talk to (request / answer / withdraw / state)
application/request-rehome-sponsorship.ts   the titular asks  → a real `rehome_request` case
application/respond-to-rehome-request.ts    the org accepts or declines → ADR-1 transaction
application/withdraw-rehome-request.ts      the titular cancels a still-pending request (REQ-3)
application/withdraw-rehome-sponsorship.ts  the titular ends a running sponsorship (REQ-8, REQ-10)
application/get-rehome-state-for-pet.ts     none / pending / active, for the titular's page
infrastructure/rehome-repository.ts         the only file here that knows Drizzle
actions.ts                       "use server" controllers: guard → parse → use-case → map
```

`application/**` runs in the fast `unit` vitest project against fakes of the
port; the transaction-level proofs are in `__tests__/rehome-*.test.ts` (serial
`db` project), because the claims are about what one transaction leaves behind
across `ownerships`, `pets`, `pet_events` and `cases`.

---

## Two cases, not one (ADR-1)

`rehome_request` is the titular's **consent record** and the org's **inbox
item**: opened atomically by the request action (no `pet_events` opener, the
`welfare_denuncia` shape), closed the moment it is answered. `adoption_listing`
is the **sponsorship itself**: the accept transaction opens it through the
existing `adoption_eligibility_set(eligible=true)` attachment rule, so every
downstream machine (applications, finalize, the org's existing `canReadCase`
branch) keeps running unmodified. The two never coexist while open.

The accept transaction's order is load-bearing (ADR-1, steps 1–9): pet
advisory lock → case `FOR UPDATE` → org `FOR SHARE` → titular's owner row
`FOR UPDATE` → zero live custody → eligibility → custody insert → listing →
`rehome_sponsorship_started` (attached to the still-open request) → close the
request. Decline and the titular's cancel write **nothing on the spine**: the
spine records arrangements that happened.

How accept / decline / cancel are told apart with a closed four-value
`closed_reason`: see the header of `src/modules/cases/domain/lifecycles/rehome-request.ts`.

---

## The rules that are not style

### 1. The module depends on `adoption`; `adoption` never depends on it

`ALLOWED_EDGES` (scripts/check-dependency-direction.ts) has `rehome:adoption`
and `rehome:organizations`, and **nothing points back**. The accept transaction
reuses `AdoptionRepository`'s eligibility and listing writers inside its own
transaction (ADR-1 steps 6–7); the REQ-16 gate and the withdraw key on
`findOpenSponsorship`, adoption's predicate.

This is WHY the writer of `rehome_sponsorship_ended` lives in
`src/modules/adoption/infrastructure/rehome-sponsorship-writer.ts` and not
here: its callers reach it from adoption's side of the graph — the finalize
cascade, every hand-off through `lib/infra/end-pet-ownerships.ts` (decomiso, a
resolved dispute), the death cascade in `lib/infra/rehome-death-cascade.ts`,
and the rollback script — and housing it in `rehome` would add the return edge
`adoption -> rehome` and close a **cycle**. The titular's withdraw calls it
through the repository (`rehome -> adoption`, the allowed direction). It also
has to sit under `src/modules/**/infrastructure/**` so
`scripts/check-titular-gate.ts` sees a writer of a titular-only event type.

### 2. "Custodia" now means two things, and every surface says which

An org's `shelter_custody` row used to mean *the org has the animal*. For a
sponsored pet it means *registry custody* only — the animal lives with its
family. The PO accepted this overload (it is what keeps the catalog predicate
untouched) on one condition: **every org-facing screen says the animal is not
in the org's possession** (spec REQ-11), and the public ficha conditions its
copy on where the animal actually lives (REQ-12). The sentence lives in one
place, `components/adoption/SponsorshipPossessionNotice.tsx`, and
`__tests__/rehome-possession-disclosure.test.tsx` pins every screen that must
render it.

The two meanings are documented at the three places a reader meets the role:
the `ownerships` header in `db/schema.ts`, Path 2 of `requirePetAccess` in
`lib/infra/pet-access.ts` (an org member gets full pet access to an animal in
a private home — the privacy face of the overload, design R4), and
`queryAdoptionListing` in `src/modules/adoption/infrastructure/adoption-listing-read.ts`.

"Sponsored" is always decided **on the spine** — an unmatched
`rehome_sponsorship_started` naming the live custody row (`payload.ownership_id`)
— never on the owner+shelter_custody shape, which also describes a decomiso or
an intake.

### 3. The custody writers of this feature take the pet advisory lock first

Finalize locks the custody row then closes the owner row; the withdraw locked
the owner row then closed the custody row — the same two row locks in opposite
orders, a deadlock Postgres breaks with `40P01`. Every writer of THIS feature
takes `pg_advisory_xact_lock(hashtext(petId))` **before any row lock**
(`acquirePetAdvisoryLock` on both repositories), the repo's precedent for
serialising custody writers (chip-match, return-to-owner, cross-org transfer):

| Writer | Where the lock is the first statement |
|---|---|
| Accept | `respondToRehomeRequest` — ADR-1 step 0 |
| Withdraw | `withdrawRehomeSponsorship` — step 0 |
| Finalize | `finalizeAdoption` — before `lockLiveCustodyRow` |
| Death (CASCADE D) | `createDeathRecord` — `lockPetForDeathRecord`, before the death event, the pets row and the foster closes; the cascade re-reads the sponsorship under it and ends nothing a withdraw already ended (WU6/7 review, M-1) |
| Rollback | `scripts/rollback-rehome-sponsorships.ts` — per pet, then re-read |

Pinned by `src/modules/rehome/__tests__/owner-row-lock.test.ts` — including
an arm that **discovers** every writer that ends custody instead of naming
them, deriving the call vocabulary from the exports of the two files that
define an ending rather than searching one literal (widened 2026-08-23: the old
`endRehomeSponsorship(` search was blind to the foster convert writer, which
ends a sponsorship transitively — *a fence enumerates forms, not the thing*) —
and `src/modules/adoption/__tests__/finalize-custody-lock.test.ts`;
proven real by `__tests__/rehome-withdraw-flow.test.ts` and
`__tests__/rehome-death-cascade.test.ts` (a withdraw racing the death).

**Writers outside the feature — closed 2026-08-23 (loop fase 1, M-9 + L-9).**
`lib/infra/end-pet-ownerships.ts` ends an open sponsorship whenever it closes
the custody row, and it runs inside its CALLER's transaction. The lock cannot
move into the primitive — taken after a caller's own row locks it would not be
first — so that file stays the one allowlisted caller in the fence, with this
reason. What changed is that its callers now all take the lock:

| Writer | Where the lock goes |
|---|---|
| `finalizeAdoption` | before `lockLiveCustodyRow` (WU5) |
| `executeDecomiso` | first statement of its transaction (after the in-flight pet insert on the unowned path) |
| `acceptDecomisoHandoffInTx` | first statement of its transaction |
| `returnCustodyToOwnerInTx` | first statement of its transaction |
| `resolveDisputeUseCase` | right after the dispute row lock — `custody_disputes` rows are locked by that use-case alone, so that edge cannot close a cycle |
| `insertConvertFosterToOwner` / `insertEndFoster` | first statement (M-8 — an advisory lock excludes only other takers, so BOTH foster closers take it) |

This description used to say those five writers did not take it and that a
concurrent decomiso "can still hit `40P01`". That was true and is no longer;
the arm in `owner-row-lock.test.ts` now pins each one against the first custody
write it must precede.

**The duplicate-event half was a different defect.** The 40P01 cycle needed
crossed lock orders; the DUPLICATE needed nothing — `endAllLiveOwnerships`
guarded its sponsorship close with a plain `SELECT`, which reads the last
committed version and says "still live" even when another transaction has
already closed the row. That guard now reads `FOR UPDATE` (M-9), so the losing
transaction blocks, re-checks, and writes no second `rehome_sponsorship_ended`.

---

## The spine (ADR-2)

Two titular-only event types (migration 0194), payloads in
`lib/events/rehome-event-schemas.ts`:

- `rehome_sponsorship_started { ownership_id, sponsoring_organization_id, consented_by_user_id, request_case_public_code, listing_case_id, note }` — written in the accept, attached to the request case (`requires-open`).
- `rehome_sponsorship_ended { ownership_id, outcome, ended_at }` — `outcome ∈ adopted | withdrawn_by_titular | ended_by_org | pet_deceased | withdrawn_by_platform`; attaches to the listing case while open. The key is `outcome`, **never** `reason` (the erasure RPC redacts `reason` on every type).
  - **`ended_by_org` is RESERVED vocabulary with no writer.** Design R7's "the org resigns the accompaniment" path was not built (REQ-15: the org cannot end the arrangement against the titular; it can only pause/unpublish the listing, REQ-6). The value stays in the schema so a future org-side resign writes a recognised outcome instead of widening a CHECK under load, and so `lint:spine`'s orphan arm and the rollback script keep one closed list to reason over. Nothing in the tree emits it; a reader that switches on `outcome` must still handle it. (Verify report S-3, 2026-08-22.)

`ownership_id` is what lets rollback, drift detection (`lint:spine`'s
orphaned-sponsorship arm) and audit say WHICH custody row belongs to a
sponsorship instead of guessing from timestamps.

Migration 0195: at most one live **organisation** `shelter_custody` per pet
(scoped to org custody after the WU3 review — neighbour-held rows stay
unconstrained). 0196 drops a never-shipped draft index name.

---

## How a sponsorship ends

| Who | Path | Outcome written |
|---|---|---|
| The titular | `withdrawRehomeSponsorship` (REQ-8/10) — closes the custody row by id, clears the listing, closes the listing case and every open application case, tells the org and the applicants | `withdrawn_by_titular` |
| An adoption | `finalizeAdoption` → `endAllLiveOwnerships` | `adopted` |
| The animal's death | `createDeathRecord` CASCADE D → `lib/infra/rehome-death-cascade.ts` — same closes as the withdraw, under the pet lock; signed by whoever recorded the death, `author_organization_id` = the **sponsoring** org (WU6/7 review, M-2); a still-pending request is closed too; the org's notice points at the closed case | `pet_deceased` |
| An authority's hand-off (decomiso, a resolved dispute) | `endAllLiveOwnerships` | `withdrawn_by_platform` |
| The platform, rolling the feature back | `scripts/rollback-rehome-sponsorships.ts` | `withdrawn_by_platform` |
| **The titular changing the title** (owner→owner transfer) | `initiatePetTransfer` / `acceptPetTransfer` — **REFUSED** (REQ-15), nothing written | *(none — the titular withdraws first)* |

Nothing auto-expires (design R3, accepted): the titular was never blocked from
leaving, so nothing needs a deadline.

**A hand-off never ends a sponsorship — it is refused (REQ-15).** That holds
for both shapes, and for the same reason: ending the arrangement inside someone
else's hand-off would leave custody standing with no `rehome_sponsorship_started`
naming a live row, so REQ-10's unconditional route back would be gone.

- **Cross-org** (`proposeCrossOrgTransfer` / `acceptCrossOrgTransfer`): the org
  cannot hand off a row a titular's consent opened.
- **Owner→owner** (`initiatePetTransfer` / `acceptPetTransfer`): the titular
  cannot hand the title to another person while the accompaniment runs.
  `closeOwnerOwnerships` filters on `role='owner'` **by design**, so the org's
  custody row would survive a title change and stand over a stranger — the
  catalogue still reading "vive con su familia", and the shelter still able to
  finalise an adoption that closes the new owner's row. The refusal points the
  titular at withdraw, the one door that is theirs.

Both layers check twice: a readable refusal on the pre-read (before anyone else
is bothered) and the one that HOLDS under the lock, because a sponsorship can
start after the proposal was made.

---

## Rollback (ADR-7) — the order IS the rollback

The data step runs BEFORE the app commit is reverted.

1. **Run `scripts/rollback-rehome-sponsorships.ts` FIRST, through the
   still-deployed app** (`pnpm rollback:rehome`, then `pnpm rollback:rehome -- --apply`).
   Dry-run by default; `--apply` writes; a remote `DATABASE_URL` needs
   `--allow-remote`. Per live sponsorship, one
   transaction: pet lock → re-read on the spine → close the custody row by id
   → clear the listing → `rehome_sponsorship_ended{withdrawn_by_platform}`
   through the single writer → close the listing case and its application
   cases as cancelled with a note. The applications are **not resolved on the
   spine**: a resolution needs a reviewer to sign it and the platform has none
   (script header, "WHAT IT DOES" step 5). Every still-open `rehome_request`
   is closed as cancelled. **Orphans** (a started event whose row already closed without
   its event) are listed through `lint:spine`'s query and **skipped** — they
   are drift to heal by hand, and ending them here would stamp a platform
   withdrawal onto an arrangement that ended months ago.
2. Then revert the app commit. Case kind and event types are TEXT; historical
   rows survive.
3. Then a forward-only migration removing both types from
   `titular_only_event_types()`. 0195's index can stay.

Skipping step 1 leaves pets satisfying `queryAdoptionListing` with the UI to
unpublish them gone, and a payload validator that can no longer write the
closing fact.

Tests: `__tests__/rollback-rehome-sponsorships.test.ts` (rows),
`__tests__/rehome-rollback-contract.test.ts` (the CLI contract).

---

## Known follow-ups (not bugs of this module)

- ~~`resolveApplication` never closes the `adoption_application` case on
  approve/reject/finalize~~ — retired 2026-08-22
  (`src/modules/adoption/infrastructure/application-case-close.ts`): reject and
  the applicant's withdraw close it `cancelled`, finalize closes the adopter's
  own case `resolved` and the auto-rejected ones `cancelled`; every resolution
  now hangs off the case. An APPROVAL leaves the case open on purpose — the
  withdraw and death cascades here are what close it, with a note the
  approved adopter reads (`closeCase: false` is their opt-out from the
  resolver's default close).
- No `audit_log` action for a rehome answer (closed catalog + DB CHECK).
- An org's queue lists every case on a pet it holds a live custody row on — a
  `welfare_denuncia` about a sponsored household appears as a row whose detail
  is denied (`__tests__/rehome-inbox-visibility.test.ts`, "OBSERVATION"). Open
  product question.
- `adoptionEligible` is not flipped by the withdraw (decision #2265).
