-- DIM export buckets — private, service-role only
-- -----------------------------------------------
-- Apply once per environment (Supabase Studio → SQL Editor, or the MCP).
-- Idempotent. Version-controlled so prod parity is reproducible (closes the
-- EXPORT-buckets half of the W2 deploy-readiness gap; org-logos and avatars
-- buckets still have NO SQL coverage and remain manual dashboard steps — see
-- the 2026-07-07 deploy checklist).
--
-- These hold generated PDF exports (welfare case bundles, PPP registries,
-- cross-border travel document bundles). They are PRIVATE buckets: reads are
-- served through short-lived signed URLs generated server-side.
--
-- Path convention per module: {scope_id}/{export_id}.pdf
-- Retention: exports are regenerable; a TTL purge can be added per bucket later.
--
-- NO storage.objects POLICY IS CREATED HERE — AND NONE MAY BE ADDED.
-- ------------------------------------------------------------------
-- This file used to ship an INSERT and a SELECT policy, both `TO authenticated`
-- with `bucket_id in (...)` as the entire predicate. That predicate never
-- mentions the caller, so it was TRUE for every object in every export bucket:
-- any self-serve signup could POST /storage/v1/object/list/welfare-exports,
-- enumerate the national corpus of MPF prosecution bundles, and GET each one —
-- reporter names, exact incident addresses, and signed evidence links. The
-- header's old defense ("discovery is gated by the SSR layer; the private
-- bucket refuses a raw GET") was wrong on both halves: the list endpoint is
-- filtered by this very policy, not by SSR, and a private bucket refuses anon,
-- not an authenticated bearer token. Migration 0164 had already closed exactly
-- this class for the sibling `welfare-evidence` bucket; migration 0172 drops
-- these and finishes the sweep.
--
-- The paired commit points every export writer at the service-role client
-- (lib/analytics/welfare-exports.ts, lib/analytics/travel-exports.ts), which
-- bypasses RLS. Authorization moves from a policy that cannot see who is asking
-- to the server code that already knows: requireAdminOrGovtOrRedirect +
-- loadAndVerifyScopeFor for the MPF export, strict ownership for PPP and
-- travel. Signed-URL downloads are redeemed by their token, not by RLS, so the
-- user-facing download path is unchanged.
--
-- With RLS enabled on storage.objects and no policy for anon/authenticated on
-- these buckets, the answer is deny — fail-closed, which is what a private
-- legal-export bucket should have said from the start.

insert into storage.buckets (id, name, public)
values
  ('welfare-exports', 'welfare-exports', false),
  ('ppp-exports',     'ppp-exports',     false),
  ('travel-exports',  'travel-exports',  false)
on conflict (id) do nothing;

-- Drop the pre-0172 policies if this file is applied to an environment that
-- still carries them (idempotent; a no-op on a fresh project).
drop policy if exists "export_buckets_authenticated_upload" on storage.objects;
drop policy if exists "export_buckets_authenticated_read" on storage.objects;
