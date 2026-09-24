/**
 * Repara el estado imposible del DNI: un perfil PERSONAL marcado
 * `dni_verified = true` con `dni_hash` / `dni_last4` en NULL.
 *
 * POR QUÉ EXISTE
 * --------------
 * El writer real (verifyDniForUser) escribe las cuatro columnas en una sola
 * transacción, así que el producto nunca produce ese estado. Los atajos de seed
 * sí lo producían: ponían la bandera y dejaban el DNI vacío. Resultado, en el
 * master test CIU (2026-08-10): el botón "Declarar ahora" no abría nada (N2b) y
 * el pool de tránsito aceptaba una inscripción con el DNI sin declarar (N3-b) —
 * el gate no estaba roto, preguntaba `dniVerified` como manda el patrón de
 * prerequisitos y el seed le había mentido.
 *
 * Los seeds ya están arreglados y son auto-reparadores, PERO re-sembrar un
 * entorno remoto exige credenciales de Supabase Auth además de la base. Este
 * script hace sólo la reparación de datos y por eso necesita únicamente
 * DATABASE_URL — sin SDK de Auth, sin recrear ningún dataset.
 *
 * QUÉ NO TOCA
 * -----------
 * Las cuentas INSTITUCIONALES. El CHECK `profiles_institutional_no_pii` prohíbe
 * dni_hash en un perfil no personal: una institución no tiene DNI, así que para
 * ellas "verificada sin DNI" es la forma CORRECTA, no una inconsistencia.
 *
 * Uso:
 *   pnpm repair:dni                 (base local)
 *   pnpm repair:dni --allow-remote  (staging u otro remoto)
 *   pnpm repair:dni --dry-run       (sólo informa, no escribe)
 */

import { createHash } from "node:crypto";

import { config as loadEnv } from "dotenv";

import { describeTarget } from "./_env-target";

// El env ya presente en el proceso GANA: dotenv no pisa lo que ya está seteado,
// así que exportar DATABASE_URL de staging antes de correr esto es suficiente.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const ALLOW_REMOTE = process.argv.includes("--allow-remote");
const DRY_RUN = process.argv.includes("--dry-run");

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL — abortando.");
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("Me niego a correr con NODE_ENV=production.");
  process.exit(2);
}

const isLocal = DATABASE_URL.includes("127.0.0.1") || DATABASE_URL.includes("localhost");
// Host + REF DEL PROYECTO, sin credenciales, para que quien lo corre VEA contra
// qué está apuntando antes de que escriba nada.
//
// El ref es imprescindible, no adorno: esta cuenta tiene DOS proyectos Supabase
// (DIM producción y DIM-staging) detrás del MISMO host de pooler, así que el host
// solo produce una línea idéntica en los dos casos — justo la pregunta que este
// mensaje existe para responder. Se reusa el helper compartido para que la forma
// de nombrar un destino sea una sola en todos los scripts.
const host = describeTarget(DATABASE_URL);

if (!isLocal && !ALLOW_REMOTE) {
  console.error(
    `Me niego a reparar: DATABASE_URL apunta a ${host}, que no es local. Re-corré con --allow-remote si es a propósito.`,
  );
  process.exit(2);
}

console.log(`[destino] ${isLocal ? "LOCAL" : "REMOTO"} → ${host}`);
if (DRY_RUN) console.log("[dry-run] no se va a escribir nada.");

const { and, eq, isNull, sql } = await import("drizzle-orm");
const { db, profiles } = await import("../db");
const { hashDni, dniLast4 } = await import("@/lib/utils/dni-hash");

const brokenPredicate = and(
  eq(profiles.accountType, "personal"),
  eq(profiles.dniVerified, true),
  isNull(profiles.dniLast4),
);

const broken = await db
  .select({ id: profiles.id, displayName: profiles.displayName })
  .from(profiles)
  .where(brokenPredicate);

console.log(`[antes] ${broken.length} perfil(es) personal(es) verificados SIN DNI en archivo.`);
for (const p of broken) console.log(`         · ${p.displayName ?? p.id}`);

if (broken.length === 0) {
  console.log("[listo] Nada que reparar.");
  process.exit(0);
}
if (DRY_RUN) {
  console.log("[dry-run] fin — no se escribió nada.");
  process.exit(0);
}

for (const p of broken) {
  // Determinístico por id (estable entre corridas) y distinto por cuenta:
  // profiles_dni_hash_unique es un índice único parcial sobre dni_hash.
  const digits = createHash("sha256").update(p.id).digest("hex");
  const syntheticDni = String(10_000_000 + (Number.parseInt(digits.slice(0, 12), 16) % 90_000_000));

  await db
    .update(profiles)
    .set({
      dniHash: hashDni(syntheticDni),
      dniLast4: dniLast4(syntheticDni),
      dniVerifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(profiles.id, p.id), brokenPredicate));

  console.log(`[ok] ${p.displayName ?? p.id} → DNI ••••${dniLast4(syntheticDni)}`);
}

const [{ n }] = await db
  .select({ n: sql<number>`count(*)`.mapWith(Number) })
  .from(profiles)
  .where(brokenPredicate);

console.log(`[después] ${n} perfil(es) en el estado imposible.`);
process.exit(n === 0 ? 0 : 1);
