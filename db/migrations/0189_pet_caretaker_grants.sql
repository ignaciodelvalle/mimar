-- Migration 0189 — `pet_caretaker_grants`: the temporary-caretaker invitation
-- lifecycle, plus the missing concurrency cap on caretaker ownership rows.
--
-- WHAT THIS IS FOR (custodia-temporal)
-- ---------------------------------------------------------------------------
-- A titular hands one person bounded, scoped access to an owned pet: record
-- medical events, notes, photos, mark lost/found — but never transfer the
-- animal, publish it for adoption, move its jurisdiction or edit its identity.
-- This migration lands the storage. The role deny-list lives at the app layer
-- (scripts/check-titular-gate.ts + requireTitularAccess) and, from migration
-- 0190, at the RLS layer.
--
-- WHY ITS OWN TABLE AND NOT A REUSE OF `pet_transfers`
-- ---------------------------------------------------------------------------
-- The shape matches almost exactly — to_owner_email, a status machine, a public
-- token — and that is precisely the trap. A `pet_transfers` row that transfers
-- nothing poisons every query already written against that table: the transfer
-- dashboards, the cross-org expiry sweep, the handshake case. The relationship
-- is TEMPLATE, not table.
--
-- WHY THERE IS NO NEW EVENT-TYPE DDL HERE
-- ---------------------------------------------------------------------------
-- `pet_events.event_type` is TEXT with no CHECK and no enum (see the comment
-- above EVENT_TYPES in db/schema.ts): adding an event type is deliberately a
-- code change, not a migration. `caretaker_designated` and `caretaker_ended`
-- land in the same commit as this file, in db/schema.ts, with their payload
-- schemas in lib/events/caretaker-event-schemas.ts. Stating it here so nobody
-- reads the absence of DDL as an omission.
--
-- WHY `ends_at` IS NOT NULL AND THE 180-DAY CAP IS NOT A CHECK
-- ---------------------------------------------------------------------------
-- An open-ended arrangement is the exact thing this feature refuses to create,
-- so the end date is mandatory at the storage layer. The 180-day MAXIMUM is
-- not: a forward-only, immutable migration is the wrong place to freeze a
-- product number the PO can still change. The cap lives in
-- src/modules/caretakers/domain and only there.
--
-- THE INTERACTION WORTH KNOWING ABOUT BEFORE IT SURPRISES SOMEBODY
-- ---------------------------------------------------------------------------
-- `caretaker_user_id` is ON DELETE SET NULL, and the accept invariant below is
-- a biconditional. Together they mean a HARD DELETE of a profile that holds an
-- ACCEPTED grant is REFUSED (23514) rather than silently orphaning the grant.
-- That is intentional: DIM erases subjects softly (erase_subject_data sets
-- deleted_at), the only hard profile delete in the codebase is the stub-profile
-- claim path, and a stub can never be an accepted caretaker. If a hard delete
-- is ever genuinely needed, end the grant through the normal flow first — which
-- is what the spec requires anyway ("caretaker account deactivation ends the
-- grant").
--
-- THE OWNERSHIPS INDEX — the part that is NOT about the new table
-- ---------------------------------------------------------------------------
-- `ownerships_one_active_owner_per_pet` is `WHERE role='owner'`, so it
-- constrained caretaker rows not at all. The grants table protects the
-- WORKFLOW; `ownerships` is what every RLS policy and every read path actually
-- joins. If a seed, a script or a future feature ever writes an ownership row
-- without going through a grant, the invariant consumers depend on has to hold
-- at the table consumers read. Cost: one index. Effect: a seed that writes two
-- active caretaker rows now fails loudly instead of quietly.
--
-- Verified before writing: `SELECT count(*) FROM ownerships WHERE
-- role='caretaker'` returns 0 on local, so the index cannot fail on existing
-- data.

CREATE TABLE IF NOT EXISTS public.pet_caretaker_grants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The /cuidado/{token} key handed to the invitee.
  public_token        text NOT NULL UNIQUE,
  pet_id              uuid NOT NULL REFERENCES public.pets (id) ON DELETE CASCADE,
  granted_by_user_id  uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  -- NULL until accept: the invitation may be addressed to somebody who does not
  -- have an account yet, in which case the email is the only handle we have.
  caretaker_user_id   uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  caretaker_email     text NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  starts_at           timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz NOT NULL,
  note                text,
  responded_at        timestamptz,
  ended_at            timestamptz,
  ended_reason        text,
  -- The projected ownership row, set at accept. The event is authoritative;
  -- this pointer is what lets the drift harness compare the two.
  ownership_id        uuid REFERENCES public.ownerships (id) ON DELETE SET NULL,
  -- Stored witness for the T-3 reminder. "Fires exactly once" needs a witness,
  -- not a date computation: a 04:05 re-run of the daily dispatcher would
  -- otherwise send it twice.
  reminder_sent_at    timestamptz,
  -- KEY 2 of the two-key consent model for showing an ALTERNATE PUBLIC CONTACT
  -- on the credential (PO decision 2026-08-19). NULL = never consented.
  --
  --   Key 1 — the TITULAR turns the disclosure on. That rides the existing
  --           lost-mode disclosure toggles on `pets` (disclose_*_when_lost),
  --           off by default like its siblings. It is NOT stored here.
  --   Key 2 — THIS COLUMN. The CARETAKER consented, at invitation-accept time,
  --           where they are already being shown exactly what they are
  --           accepting.
  --
  -- BOTH must be true. Do NOT "simplify" this into a single owner-side flag:
  -- publishing a third party's phone number on an unauthenticated page is the
  -- titular consenting on somebody else's behalf, and the titular does not own
  -- that consent. A caretaker who never agreed must not be reachable from a QR
  -- scan by anyone who finds the animal.
  --
  -- A timestamptz rather than a boolean because WHEN is the auditable form —
  -- same shape as responded_at / ended_at on this table — and because a Ley
  -- 25.326 art. 5 consent claim that cannot say when it was given is not much
  -- of a claim.
  public_contact_consent_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pet_caretaker_grants_status_check
    CHECK (status IN ('pending','accepted','rejected','cancelled','expired','ended')),

  CONSTRAINT pet_caretaker_grants_period_check
    CHECK (ends_at > starts_at),

  -- The accept invariant, in the database. Biconditional on purpose: an
  -- accepted grant MUST point at both the caretaker and the projected ownership
  -- row, and a grant that is NOT accepted must point at neither — otherwise a
  -- cancelled invitation keeps a phantom ownership pointer and the drift
  -- harness ends up comparing against a lie.
  CONSTRAINT pet_caretaker_grants_accept_check
    CHECK ((status = 'accepted') = (caretaker_user_id IS NOT NULL AND ownership_id IS NOT NULL)),

  -- Backstop for the domain rule. The interesting case is not the UI (the form
  -- never offers it) but a script or a future feature.
  CONSTRAINT pet_caretaker_grants_no_self_designation_check
    CHECK (granted_by_user_id <> caretaker_user_id),

  -- Key 2 is captured AT ACCEPT and nowhere else. A `pending` row carrying
  -- consent means somebody recorded it before the invitee ever saw the
  -- invitation — most plausibly the titular, on their behalf, which is the one
  -- thing the second key exists to prevent.
  --
  -- Deliberately the WEAK form (`status <> 'pending'`) rather than
  -- `status = 'accepted'`: the consent record must SURVIVE the grant ending, so
  -- pinning it to the accepted status would force the cron to erase a
  -- historical fact on its way past ends_at. It is also the form the accept
  -- flow can actually satisfy — the same single-UPDATE discipline the accept
  -- invariant above already imposes, no new one.
  CONSTRAINT pet_caretaker_grants_public_contact_consent_check
    CHECK (public_contact_consent_at IS NULL OR status <> 'pending')
);

-- One OPEN invitation per pet, and one ACTIVE caretaker per pet. Partial so the
-- terminal statuses (rejected / cancelled / expired / ended) accumulate freely —
-- history is not a constraint violation.
CREATE UNIQUE INDEX IF NOT EXISTS pet_caretaker_grants_one_pending_per_pet
  ON public.pet_caretaker_grants (pet_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS pet_caretaker_grants_one_accepted_per_pet
  ON public.pet_caretaker_grants (pet_id)
  WHERE status = 'accepted';

-- Cron scan: pending older than 7 days, accepted past ends_at, the T-3 window.
CREATE INDEX IF NOT EXISTS pet_caretaker_grants_status_ends_at_idx
  ON public.pet_caretaker_grants (status, ends_at);

-- The caretaker's own /mis-mascotas.
CREATE INDEX IF NOT EXISTS pet_caretaker_grants_caretaker_active_idx
  ON public.pet_caretaker_grants (caretaker_user_id)
  WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS pet_caretaker_grants_pet_id_idx
  ON public.pet_caretaker_grants (pet_id);

COMMENT ON TABLE public.pet_caretaker_grants IS
  'Temporary-caretaker invitation lifecycle (custodia-temporal, 0189). Workflow state, not spine: a pending invitation is not a fact about the animal. Only an accept emits caretaker_designated and opens the ownerships(role=caretaker) row, in one transaction.';

-- PII baseline (migration 0058): created_by/updated_by/purpose/deleted_at/
-- retention_until on tables that carry personal data. This one does —
-- caretaker_email is an identifiable third party who may not even have an
-- account — so it gets the baseline like pet_tags did in 0169.
SELECT pii.apply_baseline('public.pet_caretaker_grants');

-- RLS. The design put this in the NEXT migration with the policy amendments;
-- it belongs here instead, and scripts/check-rls-coverage.ts is what proves it:
-- a table cannot ship one migration without row-level security, no matter how
-- short the gap. The SPLIT the design actually wanted is still intact — this
-- file only touches a table that did not exist a minute ago (zero blast radius
-- on live users); 0190 amends policies that serve them, and gets its own review.
ALTER TABLE public.pet_caretaker_grants ENABLE ROW LEVEL SECURITY;

-- SELECT for the two parties only: the titular who granted it and the person
-- invited. Explicit TO authenticated (0168 posture) — anon must never read a
-- grant row; the /cuidado/{token} page resolves server-side (BYPASSRLS) from
-- the unguessable public_token, because the invitee may not have an account yet
-- and therefore cannot match caretaker_user_id at all.
CREATE POLICY "pet_caretaker_grants select own" ON public.pet_caretaker_grants
  FOR SELECT TO authenticated
  USING (
    granted_by_user_id = (SELECT auth.uid())
    OR caretaker_user_id = (SELECT auth.uid())
  );

-- NO INSERT/UPDATE/DELETE policy, deliberately — the 0163 posture. Writes go
-- through server actions on the BYPASSRLS connection; RLS is the PostgREST
-- backstop. A caretaker who could write here could extend their own grant,
-- which is the one thing this table must never allow.

-- The cap that was missing on the table every consumer actually joins.
CREATE UNIQUE INDEX IF NOT EXISTS ownerships_one_active_caretaker_per_pet
  ON public.ownerships (pet_id)
  WHERE role = 'caretaker' AND ended_at IS NULL;
