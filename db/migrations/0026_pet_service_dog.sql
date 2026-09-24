-- Service dogs under Ley 26.858 — sibling table to `pets`, one row per pet
-- that has a service dog credential (or one being built up). The banner on
-- /p/[publicToken] renders ONLY when status='vigente' AND in_service=true
-- AND public_visibility='full_banner' AND service_type IS NOT 'otro'.
--
-- Privacy: marking a pet as a service dog reveals disability info about the
-- owner (Ley 25.326 Art. 7 — datos sensibles). `public_visibility` defaults
-- to `private_only`; the owner has to opt in explicitly to the public banner.
--
-- Workflow: owner creates the row in status 'pendiente_verificacion'. They
-- submit an approval_request (type='service_dog_credential_verification');
-- admin/govt reviews and approves → status becomes 'vigente'. Revocation is
-- admin/govt only, with motivo + evidence (same pattern as vet revocations).

create table if not exists "public"."pet_service_dog" (
  "id"                      uuid primary key default gen_random_uuid(),
  "pet_id"                  uuid not null unique references "public"."pets"("id") on delete cascade,

  "service_type"            text not null,
  "credential_status"       text not null default 'pendiente_verificacion',
  "rupga_credential"        text,
  "training_center"         text not null,
  "training_cert_date"      date,
  "credential_issue_date"   date,
  "credential_expiry_date"  date,
  "in_service"              boolean not null default true,
  "public_visibility"       text not null default 'private_only',
  "notes"                   text,

  "verified_at"             timestamptz,
  "verified_by_user_id"     uuid references "public"."profiles"("id"),
  "revoked_at"              timestamptz,
  "revoked_by_user_id"      uuid references "public"."profiles"("id"),
  "revocation_reason"       text,

  "created_at"              timestamptz not null default now(),
  "updated_at"              timestamptz not null default now(),

  constraint "pet_service_dog_service_type_valid" check (
    service_type in ('guia','asistencia_motriz','alerta_medica','senal_auditiva','asistencia_tea','otro')
  ),
  constraint "pet_service_dog_status_valid" check (
    credential_status in ('en_entrenamiento','pendiente_verificacion','vigente','vencida','revocada')
  ),
  constraint "pet_service_dog_visibility_valid" check (
    public_visibility in ('full_banner','private_only')
  ),
  -- A 'vigente' row must be backed by an admin/govt verification act.
  constraint "pet_service_dog_vigente_requires_verification" check (
    credential_status != 'vigente'
    or (verified_at is not null and verified_by_user_id is not null)
  ),
  -- A revoked row must record who, when, and why.
  constraint "pet_service_dog_revoked_requires_motivo" check (
    credential_status != 'revocada'
    or (revoked_at is not null and revoked_by_user_id is not null and revocation_reason is not null)
  )
);

create index if not exists "pet_service_dog_status_idx"
  on "public"."pet_service_dog" ("credential_status")
  where credential_status in ('vigente','pendiente_verificacion');

-- ============================================================================
-- RLS
-- ============================================================================
-- Owner of the pet can read their own. Admin / govt-in-scope can read all.
-- All writes go through server actions (service role bypasses RLS).
alter table "public"."pet_service_dog" enable row level security;

drop policy if exists "service_dog select by owner or authority" on "public"."pet_service_dog";
create policy "service_dog select by owner or authority"
  on "public"."pet_service_dog" for select
  using (
    exists (
      select 1
      from public.ownerships o
      where o.pet_id = pet_service_dog.pet_id
        and o.owner_user_id = auth.uid()
        and o.ended_at is null
    )
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.account_type = 'institutional'
        and p.role in ('admin','govt')
        and p.deactivated_at is null
    )
  );
