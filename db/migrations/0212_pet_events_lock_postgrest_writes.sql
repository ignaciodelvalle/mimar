-- Migration 0212 — pet_events: remove the PostgREST write surface entirely.
-- (Fresh-review lens A02, finding A02-1, 2026-09-02. Forged provenance in the
-- append-only spine, reachable today, permanent once written.)
--
-- THE HOLE
-- --------
-- Migration 0190 (0190_titular_only_rls.sql:140-155) narrowed the INSERT policy
-- this table has carried since 0086, but only along ONE axis:
--
--   create policy "Pet events insertable by active owner (owner-self only)"
--     on public.pet_events for insert to authenticated
--     with check (
--       author_organization_id is null
--       and exists (select 1 from public.ownerships o
--                   where o.pet_id = pet_events.pet_id
--                     and o.owner_user_id = (select auth.uid())
--                     and o.ended_at is null)
--       and (not (event_type = any (public.titular_only_event_types()))
--            or public.has_titular_write_access(pet_events.pet_id, (select auth.uid())))
--     );
--
-- Those three conjuncts pin WHICH PET the row may name and WHICH FAMILY of
-- event_type a caretaker may not forge. Nothing in them pins WHO THE ROW SAYS
-- WROTE IT. `author_role`, `author_verified` and `recorded_by_user_id` are
-- entirely caller-supplied, and `event_type` is never checked against the
-- catalog at all — the column is TEXT with no CHECK and no enum
-- (db/schema.ts:1289).
--
-- So an authenticated account holding a plain non-caretaker ownership on ONE
-- pet — its own — could
--
--   POST /rest/v1/pet_events
--   {"pet_id":"<own pet>","event_type":"vaccination_administered",
--    "author_role":"govt","author_verified":true,
--    "author_organization_id":null,"occurred_at":"…","payload":{…}}
--
-- and all three conjuncts pass: the org id is null, the ownership exists, and
-- `vaccination_administered` is not a titular-only type. The row lands claiming
-- a sanitary authority wrote it.
--
-- WHY THAT IS NOT COSMETIC
--   · lib/events/event-confidence.ts:67-74 reads exactly those two columns:
--     `author_role = 'govt' AND author_verified` → `institutional_verified`;
--     `author_role = 'vet' AND author_verified`  → `professional_verified`.
--   · lib/domain/credential-badges.ts renders that tier on the PUBLIC
--     credential page, which is consumed by third parties scanning a QR.
--   · lib/projections/pet-compliance.ts distinguishes an owner-declared dose
--     from a verified one (`:532` `ownerDeclared = authorRole === "owner"`) and
--     clears obligations on the strength of it.
--   The forgery therefore buys a self-issued sanitary credential, not a
--   cosmetic label.
--
-- AND IT IS PERMANENT. `pet_events` has no UPDATE and no DELETE policy, and
-- `enforce_pet_events_append_only` (db/triggers.sql:120-195) refuses both at the
-- trigger layer for everyone. Invariant #2 forbids deletion outright. A forged
-- row is a lie that cannot be retracted, only contradicted — which is precisely
-- what invariant #2 exists to prevent.
--
-- Nothing else stood in the way:
--   · No BEFORE INSERT trigger pairs `author_role` with the caller's real
--     account. db/triggers.sql wires only the append-only guards on this table.
--   · No CHECK constraint pairs them either, and `event_type` has no catalog
--     constraint — `validateEventPayload` and the EVENT_TYPES union live in TS
--     and never run on the PostgREST path.
--   · Column-level privileges do not help: `applySchemaGrants`
--     (scripts/deploy-provision.ts) runs `grant all on all tables in schema
--     public to anon, authenticated, service_role` on EVERY provision, so a
--     REVOKE on pet_events.author_role would be silently re-granted by the next
--     deploy. RLS is the only durable gate on this surface. (Same reasoning as
--     0211 for profiles.)
--   · The write-path fence (__tests__/rls/write-path-matrix.test.ts) could not
--     see it, and that is not a bug in the fence: its heuristic is
--     "UNCONDITIONAL clause" (`true` or absent), and this WITH CHECK is three
--     conjuncts deep. The defect is which COLUMNS the clause omits, not whether
--     the clause exists — a class that fence does not claim to cover. It is the
--     same blind spot that hid the profiles hole 0211 closed.
--
-- WHY DENY-ALL IS THE CORRECT POLICY, NOT A NARROWER ONE
-- ------------------------------------------------------
-- The narrower fix is available and was considered: AND the WITH CHECK with
-- `author_role = 'owner' AND author_verified = false AND recorded_by_user_id =
-- (select auth.uid())`. It closes the provenance forgery and leaves the
-- PostgREST INSERT open. It was not taken, because the writer count decides it.
--
-- Enumerated every writer of `public.pet_events` in the tree (2026-09-02):
--   · Sweeping `app lib src apps/mobile packages e2e` for a supabase-js call
--     naming this table — `.from("pet_events")` in either quote style — returns
--     ZERO hits in app, lib, src, apps/mobile and packages. Every `.from(...)`
--     in application code is `storage.from(<bucket>)`, never a PostgREST table.
--   · Every legitimate append is `db.insert(petEvents)` / `tx.insert(petEvents)`
--     through `EventsRepository` (src/modules/events/infrastructure/) over the
--     Drizzle connection — a direct Postgres session as a BYPASSRLS role, for
--     which no policy on this table is ever consulted (db/rls.sql:18-23 states
--     that contract; write-path-matrix.test.ts:16 restates it).
--   · `/api/v1/pets/[publicToken]/events` (writers.ts) imports `db` from `@/db`
--     and dispatches to those same use cases. It is a server route, not a
--     client.
--   · `apps/mobile` reaches the server exclusively through `/api/v1` with a
--     bearer token and never touches PostgREST for data — PO decision #2, stated
--     in apps/mobile/src/config/api.ts:20-26 and apps/mobile/src/auth/
--     supabase-auth.ts:13-18, whose stated REASON is this very hole.
--   · The only PostgREST callers on this table anywhere in the tree are probes:
--     e2e/cross-tenant-isolation.spec.ts:440,498, scripts/rls-smoke.ts:87,117,
--     171,188 and __tests__/rls/matrix.test.ts:865,885 — all SELECT, except the
--     append-only UPDATE/DELETE denials rls-smoke already asserts.
--
-- The count of legitimate writers that reach `pet_events` THROUGH PostgREST is
-- therefore ZERO. A policy that "admits exactly the legitimate path and no
-- other" is, for this table, no write policy at all. This mirrors 0163
-- (ownerships) and 0211 (profiles), decided on the same evidence.
--
-- WHAT THIS DOES NOT TAKE AWAY FROM THE CARETAKER
-- ------------------------------------------------
-- 0190's header says "a caretaker MUST be able to insert medical events; that is
-- the arrangement", and that stays true. The arrangement is served by the app:
-- a caretaker records a vaccination through the form or `/api/v1`, which writes
-- over Drizzle after `requirePetAccess` has authorized them. The policy dropped
-- here was never that path — it was the parallel, unauthenticated-by-the-app
-- path that ran alongside it. What narrows is the bearer token, not the role.
--
-- The two helpers 0190 introduced STAY. `has_titular_write_access` still backs
-- the `pets` UPDATE and `libreta_share_tokens` INSERT policies. After this
-- migration `titular_only_event_types()` has no remaining RLS consumer; it is
-- deliberately not dropped, because its equality fence against
-- lib/domain/titular-only.ts (__tests__/caretaker-rls-hardening.test.ts) is
-- still the thing that keeps the TS list honest, and dropping a function that a
-- future policy may want back is not forward progress.
--
-- READS ARE UNTOUCHED. "Pet events readable by active owner" (0086, widened by
-- 0115's case branch) is correctly scoped and stays: the owner keeps reading
-- their own spine through PostgREST, e2e/cross-tenant-isolation.spec.ts asserts
-- against it, and the table keeps >= 1 policy so check-rls-coverage.ts stays
-- green without an allowlist entry.
--
-- Forward-only and idempotent: DROP POLICY IF EXISTS is a no-op on re-run, and
-- the post-condition block below is satisfied by the state it leaves behind.
-- Mirrored into db/rls.sql (reference copy) in the same commit. Fenced by
-- __tests__/rls/pet-events-write-lockdown.test.ts.

BEGIN;

DROP POLICY IF EXISTS "Pet events insertable by active owner (owner-self only)" ON public.pet_events;

-- ---------------------------------------------------------------------------
-- Post-condition fence. "Applied" is not the same as "closed" — 0190's own
-- header (:178-192) learned this on this exact table: a DROP POLICY by NAME
-- reports success and does nothing at all when the target environment was
-- hand-patched and the policy carries a different name. This block is
-- name-independent: it asks the catalog whether ANY caller-reachable write
-- policy survives, whatever it is called.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(format('%s (%s, %s)', p.policyname, p.cmd, array_to_string(p.roles, '/')), '; ')
    INTO offenders
  FROM pg_policies p
  WHERE p.schemaname = 'public'
    AND p.tablename = 'pet_events'
    AND p.cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    AND p.roles && ARRAY['anon', 'authenticated', 'public']::name[];

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0212 did not close: pet_events still carries a caller-reachable write policy (%). Inventory pg_policies for this table and drop the surviving policy by its real name before retrying — a rename is exactly the case this check exists for.',
      offenders;
  END IF;

  -- The inverse mistake, asserted so it cannot pass as success: this migration
  -- must not take the read surface with it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pet_events' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'Migration 0212 over-corrected: pet_events has no SELECT policy left. Owners must keep reading their own spine, and check-rls-coverage.ts requires at least one policy on this table.';
  END IF;
END
$$;

COMMIT;
