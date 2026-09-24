-- 0140_rls_scope_govt_pii_reads.sql
-- ===========================================================================
-- Tier-2 authz critique (R1 + R2): tighten two OVER-BROAD govt READ policies on
-- the PostgREST surface. Both leak special-category / PII data beyond the
-- operator's assigned jurisdiction. The app connects as `postgres` (BYPASSRLS)
-- so these policies never govern the app itself — they are the active defense
-- on prod for any authenticated JWT hitting /rest/v1 directly.
--
-- NOTE (delivery): forward-only, immutable. APPLYING THIS TO REMOTE
-- (staging / prod) IS IGNACIO-GATED — do not run it against any remote DB from
-- an agent session. Local Supabase only, so the RLS matrix/coverage tests can
-- verify the tightened boundary.
--
-- ---------------------------------------------------------------------------
-- R1 — pet_identifications (microchip / ISO / tattoo PII, Ley 25.326)
-- ---------------------------------------------------------------------------
-- The govt read policy matched `ga.jurisdiction_province = pt.jurisdiction_province`
-- ONLY (no locality clause) and omitted the `role = 'govt'` + `deactivated_at IS
-- NULL` guards its sibling govt policies (approval_requests, custody_disputes)
-- carry. Effect: a locality-assigned govt operator (e.g. BA / La Plata) read
-- chip/tattoo PII for EVERY locality in that province.
--
-- Fix: add `ga.jurisdiction_locality = pt.jurisdiction_locality` and the
-- role/account_type/deactivation guards, mirroring the custody_disputes govt
-- branch EXACTLY (0137:125-130), adapted with the pets join needed to reach the
-- jurisdiction columns (pet_identifications has none of its own).
DROP POLICY IF EXISTS "pet_identifications read by govt in jurisdiction" ON public.pet_identifications;
CREATE POLICY "pet_identifications read by govt in jurisdiction"
  ON public.pet_identifications
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.pets pt
        JOIN public.profiles p ON (p.id = (select auth.uid()))
      WHERE pt.id = pet_identifications.pet_id
        AND p.role = 'govt'::user_role
        AND p.account_type = 'institutional'::text
        AND p.deactivated_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.govt_assignments ga
          WHERE ga.user_id = p.id
            AND ga.revoked_at IS NULL
            AND ga.jurisdiction_province = pt.jurisdiction_province
            AND ga.jurisdiction_locality = pt.jurisdiction_locality
        )
    )
  );

-- ---------------------------------------------------------------------------
-- R2 — pet_service_dog (assistance-dog status = disability-proxy special data)
-- ---------------------------------------------------------------------------
-- The single authority branch lumped admin + govt together
-- (`p.role = ANY (ARRAY['admin','govt'])`) with NO govt_assignments join, so ANY
-- institutional govt read assistance-dog status NATIONWIDE.
--
-- Fix: split the authority branch. Admin stays nationwide (governance role);
-- govt is jurisdiction-scoped (province + locality) via a govt_assignments join,
-- mirroring the R1 predicate style above. The OWNER branch is untouched.
DROP POLICY IF EXISTS "service_dog select by owner or authority" ON public.pet_service_dog;
CREATE POLICY "service_dog select by owner or authority"
  ON public.pet_service_dog
  FOR SELECT
  USING (
    -- Owner branch — UNCHANGED (owner reads own pet's assistance-dog record).
    EXISTS (
      SELECT 1
      FROM public.ownerships o
      WHERE o.pet_id = pet_service_dog.pet_id
        AND o.owner_user_id = (select auth.uid())
        AND o.ended_at IS NULL
    )
    -- Admin branch — nationwide (institutional admin, governance scope).
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = (select auth.uid())
        AND p.account_type = 'institutional'::text
        AND p.role = 'admin'::user_role
        AND p.deactivated_at IS NULL
    )
    -- Govt branch — jurisdiction-scoped (province + locality) via govt_assignments.
    OR EXISTS (
      SELECT 1
      FROM public.pets pt
        JOIN public.profiles p ON (p.id = (select auth.uid()))
      WHERE pt.id = pet_service_dog.pet_id
        AND p.account_type = 'institutional'::text
        AND p.role = 'govt'::user_role
        AND p.deactivated_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM public.govt_assignments ga
          WHERE ga.user_id = p.id
            AND ga.revoked_at IS NULL
            AND ga.jurisdiction_province = pt.jurisdiction_province
            AND ga.jurisdiction_locality = pt.jurisdiction_locality
        )
    )
  );
