-- dim:no-transaction
-- (Tiene que estar en las primeras cinco líneas: así lo lee migrate.ts.)
--
-- Migración 0181 — una mascota no puede tener DOS turnos VIVOS en la misma
-- CAMPAÑA, y el índice de 0177 se reconstruye porque quedó INVALID.
--
-- QUÉ PASÓ (QA A3, clickthrough 2026-08-13)
-- -----------------------------------------
-- El agente de QA reservó el turno de las 08:00 Y el de las 08:15 de la MISMA
-- campaña para la misma mascota, y el sistema confirmó los dos. La 0177 cerró
-- la identidad a nivel SLOT (mismo turno dos veces); a nivel campaña no había
-- nada: con N slots materializados, una mascota podía comerse N cupos de una
-- campaña gratuita. La intención de producto es un turno CONFIRMADO por
-- (mascota, oferta); cancelar y volver a reservar sigue siendo legítimo, por
-- eso el índice es parcial sobre 'confirmed' — los otros cuatro estados son
-- terminales (mismo razonamiento que 0177, ver ese archivo).
--
-- appointments ya carga service_offering_id (NOT NULL, denormalizado por
-- book-slot desde el slot), así que no hay columna nueva ni backfill.
--
-- POR QUÉ SE RECONSTRUYE EL ÍNDICE DE 0177
-- ----------------------------------------
-- Trampa medida en local (2026-08-13): la primera corrida de 0177 falló a
-- mitad del CREATE INDEX CONCURRENTLY (par duplicado de seed-panorama). Un
-- CONCURRENTLY que falla NO desaparece: deja el índice registrado como
-- INVALID (pg_index.indisvalid = false) — existe en pg_indexes pero no
-- valida nada. Y como 0177 usaba IF NOT EXISTS, la re-corrida posterior lo
-- vio "existente" y lo salteó para siempre: el candado por slot llevaba
-- desde entonces sin proteger nada en local. Por eso acá el patrón es
-- DROP IF EXISTS + CREATE SIN "if not exists": si el CREATE falla a mitad,
-- la re-corrida dropea el resto inválido y lo reintenta de verdad, en vez de
-- saltearlo. (Los archivos sin transacción se re-aplican completos tras un
-- fallo parcial; cada sentencia es idempotente bajo ese ciclo.)
--
-- Si el CREATE del índice por campaña falla acá, es porque el entorno tiene
-- pares confirmados duplicados por (mascota, oferta) — exactamente lo que el
-- QA creó en staging. Eso se resuelve cancelando uno de los dos turnos por
-- el flujo normal (o un UPDATE puntual a 'cancelled_by_org' con motivo), no
-- borrando historia; después se re-corre la migración.

DROP INDEX CONCURRENTLY IF EXISTS appointments_one_live_per_pet_slot;

CREATE UNIQUE INDEX CONCURRENTLY appointments_one_live_per_pet_slot
  ON appointments (pet_id, slot_id)
  WHERE status = 'confirmed';

DROP INDEX CONCURRENTLY IF EXISTS appointments_one_live_per_pet_offering;

CREATE UNIQUE INDEX CONCURRENTLY appointments_one_live_per_pet_offering
  ON appointments (pet_id, service_offering_id)
  WHERE status = 'confirmed';
