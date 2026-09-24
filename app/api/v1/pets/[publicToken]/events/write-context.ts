// El contexto de una escritura, y el unico helper que los dos lados del corte
// necesitan.
//
// EXISTE PORQUE `writers.ts` PASO LAS 1500 LINEAS con el kind de mordedura y la
// fence de tamano lo refuto — correctamente: ese archivo se habia convertido en
// un router de 16 kinds con seis funciones especiales adentro. El corte no se
// eligio por el numero: los comentarios del propio router ya nombraban a esas
// seis como una categoria ("los que no entran en el switch"), asi que se fueron
// juntas a `append-special-kinds.ts`.
//
// Este archivo existe para que ese corte no sea un ciclo. `writers.ts` importa
// las seis funciones; las seis necesitan el tipo y el parser; si cualquiera de
// los dos viviera en `writers.ts`, los dos modulos se importarian mutuamente.

import { parseDateInput } from "@/lib/utils/format";
import type { RecordEventInput } from "@dim/contract/input";

export type WriteContext = {
  publicToken: string;
  userId: string;
  idempotencyKey: string;
  input: RecordEventInput;
};

/**
 * `"YYYY-MM-DD"` → the instant the web anchors it at, or `null` if that string
 * does not name a real day.
 *
 * `parseDateInput` ALONE IS NOT THAT CHECK, and this is the one place on this
 * surface where the difference writes a wrong fact into an append-only ledger.
 * `new Date("2026-02-31T12:00:00Z")` neither throws nor is `NaN` — JavaScript
 * rolls it over to 3 March — so `parseDateInput` returns a perfectly good Date
 * for a day that never existed, and the vaccination lands three days late with
 * nothing reporting a substitution.
 *
 * The contract's schema refuses it first, so this is a backstop. It exists
 * anyway because a schema and a writer agreeing today is not a reason for the
 * writer to have no opinion about a date it is about to make permanent.
 */
export function parseWireDay(value: string): Date | null {
  const parsed = parseDateInput(value);
  if (!parsed) return null;
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}
