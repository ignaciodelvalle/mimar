/**
 * DIM Demo Pet Reset — reset-demo-pets.ts
 *
 * Deletes the curated demo pets so the demo seeds can recreate them through the
 * REAL intake circuit, then exits. It seeds nothing itself.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *   Every demo seed is idempotent by existence: `ensureDemoPet` and `seedArgo`
 *   skip a token that is already present. That is correct for a re-run, and
 *   useless for a REPAIR — a pet created before the seeds were routed through
 *   registerPet keeps its defects (no pet_registered event, NULL locality_id)
 *   forever, because the seed politely steps around it.
 *
 *   Those defects are not cosmetic. A pets row with no pet_registered event is
 *   an operational cache row with no fact behind it, which is invariant #3
 *   inverted; and the tempting repair — deriving the missing event out of the
 *   pets row's own name and created_at — makes the inversion worse by
 *   promoting the cache to the ORIGIN of the fact. The honest repair is to
 *   destroy the cache rows and let the real use-case emit them again.
 *
 * ─── WHAT IT DELETES ───────────────────────────────────────────────────────
 *   The pets matching DEMO_TOKEN_PATTERNS, and with them (FK CASCADE) their
 *   events, ownerships, identifications, attachments, appointments, cases,
 *   disputes and transfers. Two dependants need explicit handling because
 *   their FK is ON DELETE SET NULL, which would silently orphan them:
 *     · welfare_reports.subject_pet_id — seed-demo-spine's linked-subject
 *       report guards on its description text, so a surviving row would make
 *       the re-seed SKIP and the /gob/maltrato pet-drill would never come back.
 *     · notifications.related_pet_id — scan alerts whose CTA would point at a
 *       pet that no longer exists.
 *
 * ─── THE APPEND-ONLY ESCAPE HATCH ──────────────────────────────────────────
 *   pet_events carries a BEFORE DELETE trigger that fires on cascades too, so
 *   this runs inside `app.allow_event_mutation` with a named actor. That is
 *   deliberate: the override refuses to work anonymously and writes one
 *   audit_log row per deleted event, so a destructive demo reset leaves a
 *   record of who did it. Wiping the spine quietly is not an option this
 *   database offers, and it should not be.
 *
 * ─── SAFETY ────────────────────────────────────────────────────────────────
 *   Local-only (no --allow-remote escape: this destroys data), refuses under
 *   NODE_ENV=production, and requires an explicit --yes.
 *
 * Usage:
 *   node --conditions=react-server --import tsx scripts/reset-demo-pets.ts --yes
 *
 * Then re-seed, in order:
 *   pnpm seed:demo:scenario
 *   node --conditions=react-server --import tsx scripts/seed-demo-spine.ts
 *   pnpm seed:demo-polish
 *   node --conditions=react-server --import tsx scripts/seed-owner-demo.ts
 */

import "./_load-env";

// ---------------------------------------------------------------------------
// 1. Safety guards
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const CONFIRMED = argv.includes("--yes");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const isLocalUrl = (u: string) => u.includes("127.0.0.1") || u.includes("localhost");

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to reset: NODE_ENV=production.");
  process.exit(2);
}
if (!isLocalUrl(SUPABASE_URL) || !isLocalUrl(DATABASE_URL)) {
  console.error(
    `Refusing to reset: NEXT_PUBLIC_SUPABASE_URL (${SUPABASE_URL}) or DATABASE_URL is not local.`,
    "\n  This script DELETES pets. There is no --allow-remote.",
  );
  process.exit(2);
}
if (!CONFIRMED) {
  console.error(
    "Refusing to reset without --yes. This deletes the demo pets and their whole history.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. Imports (after env bootstrap)
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { db } from "../db";

type LogLevel = "STEP" | "OK" | "SKIP" | "WARN" | "INFO" | "DONE" | "FAIL";
function log(level: LogLevel, msg: string): void {
  const tag = `[reset ${level}]`.padEnd(13);
  console.log(`${tag} ${msg}`);
}

// ---------------------------------------------------------------------------
// 3. Scope
// ---------------------------------------------------------------------------

/**
 * The curated demo cut, and nothing else. Matches seed-demo-scenario's
 * DIM-DEMO-NNNN cohort plus seed-demo-spine's named assets (DIM-ARGO-DEMO,
 * DIM-BRUNO-DEMO, DIM-MORA-DEMO). Deliberately NOT a bare `DIM-%` — that is
 * every real pet in the database.
 */
const DEMO_TOKEN_PATTERNS = [
  "DIM-DEMO-%",
  "DIM-ARGO-DEMO",
  "DIM-BRUNO-DEMO",
  "DIM-MORA-DEMO",
] as const;

const TOKEN_SCOPE = sql`public_token LIKE 'DIM-DEMO-%' OR public_token IN ('DIM-ARGO-DEMO', 'DIM-BRUNO-DEMO', 'DIM-MORA-DEMO')`;

/** Actor recorded on every audit_log row the override writes. */
const RESET_ACTOR_EMAIL = "admin@dim.test";

async function main(): Promise<void> {
  log("INFO", `Scope: ${DEMO_TOKEN_PATTERNS.join(", ")}`);

  const before = (await db.execute(sql`
    SELECT p.public_token,
           (SELECT count(*) FROM pet_events e WHERE e.pet_id = p.id) AS eventos
    FROM pets p
    WHERE ${TOKEN_SCOPE}
    ORDER BY 1
  `)) as unknown as Array<{ public_token: string; eventos: string }>;

  if (before.length === 0) {
    log("SKIP", "No hay mascotas demo para borrar — nada que hacer.");
    return;
  }

  for (const row of before) {
    log("INFO", `  ${row.public_token} — ${row.eventos} evento(s)`);
  }

  const [actor] = (await db.execute(sql`
    SELECT id FROM auth.users WHERE email = ${RESET_ACTOR_EMAIL} LIMIT 1
  `)) as unknown as Array<{ id: string }>;

  if (!actor) {
    log("FAIL", `No se encontró ${RESET_ACTOR_EMAIL}. ¿Corriste seed:test primero?`);
    process.exit(1);
  }

  await db.transaction(async (tx) => {
    // Transaction-local override. The trigger REQUIRES a named actor and
    // audit-logs every deleted event under it.
    await tx.execute(sql`SELECT set_config('app.allow_event_mutation', 'true', true)`);
    await tx.execute(
      sql`SELECT set_config('app.allow_event_mutation_actor', ${actor.id}::text, true)`,
    );

    // SET NULL dependants — delete rather than orphan (see header).
    const welfare = (await tx.execute(sql`
      DELETE FROM welfare_reports
      WHERE subject_pet_id IN (SELECT id FROM pets WHERE ${TOKEN_SCOPE})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    const notifs = (await tx.execute(sql`
      DELETE FROM notifications
      WHERE related_pet_id IN (SELECT id FROM pets WHERE ${TOKEN_SCOPE})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;

    const deleted = (await tx.execute(sql`
      DELETE FROM pets WHERE ${TOKEN_SCOPE} RETURNING public_token
    `)) as unknown as Array<{ public_token: string }>;

    log("OK", `  welfare_reports borradas: ${welfare.length}`);
    log("OK", `  notifications borradas:   ${notifs.length}`);
    log("OK", `  pets borradas:            ${deleted.length}`);
  });

  const auditRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM audit_log
    WHERE action = 'pet_events_mutation_override' AND performed_at > now() - interval '5 minutes'
  `)) as unknown as Array<{ n: number }>;

  log("INFO", `audit_log: ${auditRows[0]?.n ?? 0} override(s) registrados en los últimos 5 min.`);
  log("DONE", "Reset completo. Re-corré los seeds (ver el encabezado de este archivo).");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n[FATAL]", err);
    process.exit(1);
  });
