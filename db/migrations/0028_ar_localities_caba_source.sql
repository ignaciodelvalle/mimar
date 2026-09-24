-- Allow 'caba_open_data' as a valid source for ar_localities rows.
--
-- INDEC's CPPDyL dataset treats CABA as a single locality ("Ciudad Autónoma de
-- Buenos Aires"). The 48 barrios (Ley CABA 1.777 + Ley 8 de Comunas) are
-- carried by the city's own open-data portal at `data.buenosaires.gob.ar`.
-- We model them with a distinct source so the provenance is auditable and
-- future re-imports can target only this slice without touching INDEC rows.
--
-- Idempotent — safe to re-run.

alter table public.ar_localities
  drop constraint if exists ar_localities_source_valid;

alter table public.ar_localities
  add constraint ar_localities_source_valid
  check (source in ('indec_cppdyl','bahra','manual','caba_open_data'));
