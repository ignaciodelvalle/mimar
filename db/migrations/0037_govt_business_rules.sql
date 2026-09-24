-- Migration 0037 — govt_business_rules table.
-- Spec: 2026-05-19-govt-business-rules-poc-design (BR2).
--
-- Stores per-jurisdiction override of business rules (POC: PPP rule types).
-- Cascade is applied at read time by lib/business-rules-resolver.ts —
-- locality > province > country > hardcoded defaults.
--
-- Idempotent — safe to re-run.

create table if not exists public.govt_business_rules (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_country text not null default 'AR',
  jurisdiction_province text,
  jurisdiction_locality text,
  rule_type text not null,
  rule_payload jsonb not null,
  notes text,
  legal_anchor_ids text[],
  created_at timestamptz not null default now(),
  created_by_user_id uuid not null references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid references public.profiles(id) on delete restrict
);

create unique index if not exists govt_business_rules_jurisdiction_rule_type_unique
  on public.govt_business_rules (
    jurisdiction_country,
    coalesce(jurisdiction_province, ''),
    coalesce(jurisdiction_locality, ''),
    rule_type
  );

create index if not exists govt_business_rules_rule_type_idx
  on public.govt_business_rules (rule_type);

do $$ begin
  alter table public.govt_business_rules
    drop constraint if exists govt_business_rules_rule_type_valid;
exception when others then null; end $$;

alter table public.govt_business_rules
  add constraint govt_business_rules_rule_type_valid
  check (rule_type in (
    'ppp_breed_list',
    'ppp_weight_threshold',
    'ppp_attestation_required_registries'
  ));
