#!/usr/bin/env tsx
/**
 * with-env — corre un comando con las variables de un archivo .env puntual.
 *
 *   pnpm exec tsx scripts/ops/with-env.ts .env.staging.local pnpm db:doctor -- --allow-remote
 *
 * POR QUÉ EXISTE (2026-08-10). Apuntar una herramienta a staging por una sola
 * corrida era, hasta hoy, un acertijo de shell. `migrate.ts` y
 * `check-ledger-honesty.ts` cargan `.env.local` con dotenv y no aceptan flag de
 * entorno, así que la única salida era exportar `DATABASE_URL` a mano — y las
 * dos formas obvias fallan:
 *
 *   DATABASE_URL="<pegá la url>" pnpm …   → la url termina en el historial del
 *                                            shell, y en el chat si hay uno
 *   set -a && . ./.env.staging.local      → bash NO parsea el formato que
 *                                            dotenv sí parsea, y muere con
 *                                            "DATABASE_URL: command not found"
 *
 * Este wrapper usa el MISMO parser que los scripts (dotenv), así que lo que
 * funciona para ellos funciona acá. El valor nunca se imprime.
 *
 * NO relaja ningún gateo: `--allow-remote` sigue siendo obligatorio y explícito
 * en el comando que se pasa, y los scripts siguen decidiendo por sí mismos si
 * aceptan una base remota. Esto sólo resuelve CÓMO llega la variable.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { config as loadEnv } from "dotenv";

const [envFile, ...command] = process.argv.slice(2);

if (!envFile || command.length === 0) {
  console.error(
    "Uso: tsx scripts/ops/with-env.ts <archivo .env> <comando…>\n" +
      "Ej:  tsx scripts/ops/with-env.ts .env.staging.local pnpm db:doctor -- --allow-remote",
  );
  process.exit(2);
}

if (!existsSync(envFile)) {
  console.error(`No existe ${envFile}.`);
  process.exit(2);
}

// `override: true` — el archivo pedido gana sobre lo que ya esté en el proceso.
// Sin esto, un .env.local previamente cargado dejaría la herramienta apuntando
// a la base equivocada mientras el operador cree que apunta a la pedida: el modo
// de falla más caro que este script puede tener.
const parsed = loadEnv({ path: envFile, override: true });
if (parsed.error) {
  console.error(`No pude leer ${envFile}: ${parsed.error.message}`);
  process.exit(2);
}

const keys = Object.keys(parsed.parsed ?? {});
if (keys.length === 0) {
  console.error(`${envFile} no definió ninguna variable — ¿formato inesperado?`);
  process.exit(2);
}

// Se listan los NOMBRES, nunca los valores: el operador necesita confirmar que
// cargó lo que creía, no ver el secreto.
console.log(`[with-env] ${envFile} → ${keys.length} variable(s): ${keys.join(", ")}`);

// Un host visible sin credenciales, para que el operador confirme el destino
// ANTES de leer la salida del comando. Un doctor que corre contra la base
// equivocada y sale limpio es peor que uno que falla.
const dbUrl = process.env.DATABASE_URL;
if (dbUrl) {
  try {
    console.log(`[with-env] DATABASE_URL apunta a ${new URL(dbUrl).host}`);
  } catch {
    console.error("[with-env] DATABASE_URL no es una URL válida.");
    process.exit(2);
  }
}

const [bin, ...args] = command;
const res = spawnSync(bin, args, { stdio: "inherit", env: process.env, shell: true });
process.exit(res.status ?? 1);
