-- SENASA reference vocabularies (compliance handoff PR 3).
--
-- Cuatro tablas lookup en schema dedicado `ref.*` para anclar
-- pet_events.tipo_evento_code, via_aplicacion_code, jurisdiccion_code y
-- el bridge identification_kind ↔ norma a vocabularios SENASA exactos.
-- Cuando se homologue la LSUCyF digital con SENASA el export es directo
-- (sin ETL adicional).
--
-- Aditivo: no toca tablas existentes en esta migración. La alineación de
-- pet_events ocurre en 0061.

BEGIN;

CREATE SCHEMA IF NOT EXISTS ref;

-- ---------------------------------------------------------------------------
-- tipo_evento_sanitario — vocabulario canónico SENASA Res. 580/2014 + LSUCyF
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ref.tipo_evento_sanitario (
  code              text PRIMARY KEY,
  label_es          text NOT NULL,
  norma_origen      text NOT NULL,
  requiere_lote     boolean NOT NULL DEFAULT false,
  requiere_via      boolean NOT NULL DEFAULT false,
  notificable_eno   boolean NOT NULL DEFAULT false
);

INSERT INTO ref.tipo_evento_sanitario(code, label_es, norma_origen, requiere_lote, requiere_via, notificable_eno) VALUES
  ('vacunacion_antirrabica',     'Vacunación antirrábica',                   'Ley 22.953/1983 + Res. MS 1144/2018',   true,  true,  true ),
  ('vacunacion_quintuple',       'Vacunación quíntuple',                     'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('vacunacion_sextuple',        'Vacunación séxtuple',                      'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('vacunacion_octuple',         'Vacunación óctuple',                       'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('vacunacion_triple_felina',   'Vacunación triple felina',                 'LSUCyF (SENASA, 2022)',                 true,  true,  false),
  ('desparasitacion_interna',    'Desparasitación interna',                  'Res. MS 546/1985 (hidatidosis)',        true,  false, false),
  ('desparasitacion_externa',    'Desparasitación externa',                  'LSUCyF (SENASA, 2022)',                 true,  false, false),
  ('prescripcion_electronica',   'Receta Electrónica Veterinaria',           'Res. SENASA 80/2025',                   false, false, false),
  ('consulta_clinica',           'Consulta clínica',                         'Ley 14.072/1951',                       false, false, false),
  ('cirugia_general',            'Cirugía general',                          'Ley 14.072/1951',                       false, false, false),
  ('esterilizacion_quirurgica',  'Esterilización quirúrgica',                'Ley CABA 1.338/2004 / PBA 13.879/2008', false, false, false),
  ('observacion_antirrabica',    'Observación antirrábica (10 días)',        'Ord. CABA 41.831 art. 9°',              false, false, true ),
  ('mordedura_notificada',       'Mordedura — notificación',                 'Ley 15.465/1960 (ENO)',                 false, false, true ),
  ('defuncion',                  'Defunción',                                'Ord. CABA 41.831 art. 11',              false, false, false),
  ('transferencia_tenencia',     'Transferencia de tenencia',                'Art. 1947 CCyCN',                       false, false, false),
  ('extravio_reportado',         'Extravío reportado',                       'Decreto 1.088/2011',                    false, false, false),
  ('recuperacion_reportada',     'Recuperación reportada',                   'Decreto 1.088/2011',                    false, false, false)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- via_aplicacion — vías de administración para vacunas / medicación
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ref.via_aplicacion (
  code     text PRIMARY KEY,
  label_es text NOT NULL
);

INSERT INTO ref.via_aplicacion(code, label_es) VALUES
  ('sc',  'Subcutánea'),
  ('im',  'Intramuscular'),
  ('iv',  'Endovenosa'),
  ('vo',  'Oral'),
  ('top', 'Tópica'),
  ('in',  'Intranasal')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- jurisdiccion_sanitaria — ISO 3166-2:AR + colegio veterinario referencial
-- ---------------------------------------------------------------------------
-- Sembrado inicial de 4 jurisdicciones de alto tráfico. Las 20 restantes
-- pueden cargarse en una migración separada de research (handoff explicit).

CREATE TABLE IF NOT EXISTS ref.jurisdiccion_sanitaria (
  code                text PRIMARY KEY,
  label_es            text NOT NULL,
  colegio_veterinario text
);

INSERT INTO ref.jurisdiccion_sanitaria(code, label_es, colegio_veterinario) VALUES
  ('AR-C', 'CABA',         'CVPCABA (Ley 14.072)'),
  ('AR-B', 'Buenos Aires', 'CVPBA (Decreto-Ley 9.686/1981)'),
  ('AR-S', 'Santa Fe',     'Colegio de Médicos Veterinarios de Santa Fe'),
  ('AR-X', 'Córdoba',      'Colegio Médico Veterinario de la Provincia de Córdoba')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- identification_kind_norma — bridge pet_identifications.kind ↔ norma
-- ---------------------------------------------------------------------------
-- Tabla de referencia: cada `identification_kind` (enum de PR 0) se asocia
-- a su norma de origen y estándar técnico. Permite que reports SENASA
-- citen la norma exacta cuando se exportan identifiers.

CREATE TABLE IF NOT EXISTS ref.identification_kind_norma (
  kind             identification_kind PRIMARY KEY,
  norma_origen     text NOT NULL,
  estandar_tecnico text
);

INSERT INTO ref.identification_kind_norma(kind, norma_origen, estandar_tecnico) VALUES
  ('microchip_iso',    'Res. SENASA 284/2024',          'ISO 11784:1996 + ISO 11785:1996'),
  ('tattoo',           'Ord. CABA 41.831 art. 4°',      NULL),
  ('collar_tag',       'Uso voluntario',                NULL),
  ('photo_biometric',  'Reservado — no implementado',   NULL)
ON CONFLICT (kind) DO NOTHING;

COMMENT ON SCHEMA ref IS
  'Vocabularios SENASA + ICAR + ISO. Tablas semi-estáticas referenciadas por pet_events y pet_identifications. Compliance handoff PR 3.';

COMMIT;
