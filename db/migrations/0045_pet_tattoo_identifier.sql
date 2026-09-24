-- 0045_pet_tattoo_identifier.sql
-- Adds tattoo as a secondary identifier. Mirrors microchip column shape on pets.
-- Spec: docs/superpowers/specs/2026-05-21-tattoo-identifier-design.md
-- Decisions D1-D4 closed 2026-05-22: no registry enum (free-form description instead);
-- code + location + photo gated by lost status on public surface.

begin;

alter table public.pets
  add column tattoo_code        text,
  add column tattoo_location    text,
  add column tattoo_description text,
  add column tattoo_recorded_at date,
  add column tattoo_recorded_by text,
  add column tattoo_photo_id    uuid;

alter table public.pets
  add constraint pets_tattoo_location_valid
    check (
      tattoo_location is null
      or tattoo_location in ('inner_ear_left','inner_ear_right','inner_thigh','belly','other')
    );

-- Best-effort lookup index for tattoo cross-check (D2). No uniqueness — codes
-- collide across registries. Normalization (uppercase + strip whitespace) lives
-- in app code (createTattooForUser + lookupByTattoo), not in DB constraint.
create index pets_tattoo_code_idx
  on public.pets (tattoo_code)
  where tattoo_code is not null;

commit;
