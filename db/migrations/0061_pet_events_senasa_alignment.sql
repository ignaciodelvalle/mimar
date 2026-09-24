-- pet_events alineación a SENASA Res. 580/2014 + LSUCyF 2022
-- (compliance handoff PR 3).
--
-- Suma columnas para que el formulario antirrábico SENASA y la libreta
-- digital exporten al mismo shape. Todas las columnas son NULLABLE — los
-- pet_events legacy quedan intactos sin necesidad de backfill ahora.
--
-- Nota sobre constraint: el handoff sugería una CHECK que valida
-- `lote_biologico is not null cuando ref.tipo_evento_sanitario.requiere_lote`.
-- Postgres NO permite subqueries en CHECK constraints, así que la regla
-- queda enforce-en-app via lib/sanitary-vocab.ts. Si SENASA exige DB-level
-- enforcement más adelante, agregar un BEFORE INSERT/UPDATE trigger.

BEGIN;

ALTER TABLE public.pet_events
  ADD COLUMN IF NOT EXISTS tipo_evento_code        text REFERENCES ref.tipo_evento_sanitario(code),
  ADD COLUMN IF NOT EXISTS lote_biologico          text,
  ADD COLUMN IF NOT EXISTS laboratorio             text,
  ADD COLUMN IF NOT EXISTS vencimiento_biologico   date,
  ADD COLUMN IF NOT EXISTS via_aplicacion_code     text REFERENCES ref.via_aplicacion(code),
  ADD COLUMN IF NOT EXISTS vet_matricula           text,
  ADD COLUMN IF NOT EXISTS vet_jurisdiccion_code   text REFERENCES ref.jurisdiccion_sanitaria(code),
  ADD COLUMN IF NOT EXISTS establecimiento_renspa  text,
  ADD COLUMN IF NOT EXISTS proxima_dosis_at        date,
  ADD COLUMN IF NOT EXISTS firmado_at              timestamptz,
  ADD COLUMN IF NOT EXISTS firma_hash              text;

-- Index para queries comunes de la libreta sanitaria por tipo SENASA.
CREATE INDEX IF NOT EXISTS pet_events_tipo_evento_code_idx
  ON public.pet_events(tipo_evento_code)
  WHERE tipo_evento_code IS NOT NULL;

-- Backfill heurístico — INTENCIONALMENTE NO RUN aquí.
-- El handoff documenta los mappings tentativos:
--   event_type='vaccination_administered' → tipo_evento_code='vacunacion_antirrabica'
--   event_type='sterilization_performed'  → tipo_evento_code='esterilizacion_quirurgica'
-- Pero ambos son inválidos sin contexto: una vacuna no necesariamente es antirrábica.
-- El backfill se hace en una migración operacional separada después de revisar
-- caso por caso con un veterinario humano.

COMMIT;
