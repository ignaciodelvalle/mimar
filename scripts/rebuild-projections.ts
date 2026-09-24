/**
 * Projection-rebuild script.
 *
 * Replays the pet_events log for one or every pet and compares the derived
 * projection state against what the `pets` row currently holds. Reports drift.
 * With --dry-run=false, applies the update to bring the cache in line with
 * the events. This operationalizes AGENTS.md's "cache is always re-derivable
 * in principle" promise — if this script reports zero drift on a healthy DB,
 * the dual-write discipline is intact.
 *
 * Usage:
 *   pnpm rebuild:projections                     # dry-run, all pets
 *   pnpm rebuild:projections --pet DIM-XXXX-YY   # dry-run, one pet
 *   pnpm rebuild:projections --apply             # write fixes, all pets
 *   pnpm rebuild:projections --pet DIM-XXXX-YY --apply
 *
 * Output is grep-friendly: one pet per line, status code in the first column:
 *   OK     {publicToken}
 *   DRIFT  {publicToken}  status=... weight=...
 *   FIXED  {publicToken}
 *
 * Note on preference-managed columns: `pets.emergencyInfoVisible` is a UI
 * preference (NO event emitted on flip — see v1 closure item 3) and is NOT
 * projection-managed. This script does not touch it.
 *
 * ARCH-S: microchip projection columns (microchipId, microchipCountryCode,
 * microchipImplantedAt, microchipImplantedBy, microchipLocation) dropped from
 * the pets table. Microchip data is now canonical in pet_identifications.
 * The replayPetMicrochip projection is still valid for event-sourced reads but
 * drift detection/fixing against the pets row is no longer applicable.
 */

import { asc, eq, gt, sql } from "drizzle-orm";

import { db, petEvents, pets } from "../db";
import { overlayAmendments } from "../lib/infra/amendment";
import { replayPetStatus } from "../lib/projections/pet-status";
import { replayPetWeight } from "../lib/projections/pet-weight";

type Args = {
  publicToken: string | null;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  let publicToken: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pet") {
      publicToken = argv[i + 1] ?? null;
      i++;
    } else if (a === "--apply") {
      apply = true;
    } else if (a === "--dry-run") {
      apply = false;
    }
  }
  return { publicToken, apply };
}

type Drift = {
  column: string;
  current: unknown;
  expected: unknown;
};

function diffPet(
  current: {
    status: string;
    deceasedAt: Date | string | null;
    estimatedWeightKg: string | null;
    // ARCH-S: microchip columns dropped from pets table. No longer diffed here.
  },
  expected: {
    status: string;
    deceasedAt: Date | null;
    estimatedWeightKg: string | null;
  },
): Drift[] {
  const drifts: Drift[] = [];
  if (current.status !== expected.status) {
    drifts.push({ column: "status", current: current.status, expected: expected.status });
  }
  const currentDeceasedAt = normalizeDate(current.deceasedAt);
  const expectedDeceasedAt = normalizeDate(expected.deceasedAt);
  if (currentDeceasedAt !== expectedDeceasedAt) {
    drifts.push({
      column: "deceasedAt",
      current: currentDeceasedAt,
      expected: expectedDeceasedAt,
    });
  }
  // Compare weights as numbers — Postgres `numeric` normalizes the stored
  // string ("8.5" → "8.50") so a raw string compare would false-positive drift.
  if (!sameNumeric(current.estimatedWeightKg, expected.estimatedWeightKg)) {
    drifts.push({
      column: "estimatedWeightKg",
      current: current.estimatedWeightKg,
      expected: expected.estimatedWeightKg,
    });
  }
  return drifts;
}

function normalizeDate(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function sameNumeric(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  const na = Number.parseFloat(a);
  const nb = Number.parseFloat(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return a === b;
  return na === nb;
}

/** Page size for the keyset sweep — same shape as detect-pet-cache-drift. */
const PET_SCAN_BATCH_SIZE = 500;

/**
 * Todos los ids de mascota, paginados por keyset sobre la primary key.
 *
 * Devuelve la lista completa (el script necesita el total para su resumen), pero
 * la trae de a páginas y sólo con el id, en vez de materializar la tabla entera
 * con todas sus columnas de una.
 */
type PetRef = { id: string; publicToken: string };

async function collectAllPetIds(): Promise<PetRef[]> {
  const out: PetRef[] = [];
  let cursor: string | null = null;
  for (;;) {
    const base = db.select({ id: pets.id, publicToken: pets.publicToken }).from(pets).$dynamic();
    const query = cursor ? base.where(gt(pets.id, cursor)) : base;
    const batch: PetRef[] = await query.orderBy(asc(pets.id)).limit(PET_SCAN_BATCH_SIZE);
    if (batch.length === 0) return out;
    out.push(...batch);
    cursor = batch[batch.length - 1].id;
    if (batch.length < PET_SCAN_BATCH_SIZE) return out;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Sin --pet esto hacía `db.select().from(pets)`: TODAS las columnas de TODAS
  // las filas en un solo array en memoria. Sus dos hermanos
  // (detect-pet-cache-drift, repair-pet-cache-drift) fueron reconstruidos con
  // keyset y select angosto justamente para no hacer eso; éste quedó sin migrar.
  //
  // Es un script manual de operador, con dry-run por default y sin ningún path
  // de producción, así que el radio de daño es la RAM de una corrida — deuda de
  // robustez, no riesgo. Pero es exactamente la clase que esta auditoría vino a
  // barrer, y el arreglo son diez líneas.
  //
  // El cuerpo del loop toma un advisory lock POR MASCOTA y relee sus eventos
  // dentro de la tx, así que sólo necesita el id: traer la fila entera nunca
  // sirvió para nada.
  const targetPets = args.publicToken
    ? await db
        .select({ id: pets.id, publicToken: pets.publicToken })
        .from(pets)
        .where(eq(pets.publicToken, args.publicToken))
    : await collectAllPetIds();

  if (targetPets.length === 0) {
    console.error(
      args.publicToken ? `No pet with publicToken=${args.publicToken}` : "No pets in the database.",
    );
    process.exit(args.publicToken ? 1 : 0);
  }

  let driftCount = 0;
  let fixedCount = 0;

  for (const pet of targetPets) {
    // Phase 3.5 (action plan 2026-05-20): the read-events / compute /
    // update-pet sequence MUST be atomic per pet. Without this, a writer
    // appending a new pet_event between our SELECT and UPDATE would have
    // its projection clobbered by our stale UPDATE.
    //
    // Per-pet pg_advisory_xact_lock serializes rebuilds with any other
    // writer that takes the same lock (none today, but the lock key is
    // here so future writers can opt in cheaply). Held until the tx
    // commits — no manual release needed.
    //
    // `hashtext(pet.id::text)` gives us a stable int8 lock key derived
    // from the pet uuid.
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pet.id}))`);

      const rawEvents = await tx
        .select({
          id: petEvents.id,
          eventType: petEvents.eventType,
          occurredAt: petEvents.occurredAt,
          recordedAt: petEvents.recordedAt,
          payload: petEvents.payload,
        })
        .from(petEvents)
        .where(eq(petEvents.petId, pet.id))
        .orderBy(asc(petEvents.occurredAt), asc(petEvents.recordedAt), asc(petEvents.id));

      // AMENDMENT OVERLAY — the same one rederivePetCache applies at its own
      // source (review 2026-08-22, M1). This mirror is not optional: this script
      // is the documented repair path, and `--apply` WRITES. Replaying the raw
      // stream here would take a weight the owner corrected from 10 kg to 12 kg
      // and put 10 back into the cache — reverting a correction with no audit
      // row and no new event, which is exactly what the append-only spine exists
      // to make impossible. Fixing the detector alone would have left that.
      const events = overlayAmendments(rawEvents);

      const statusProj = replayPetStatus(events);
      const weightProj = replayPetWeight(events);
      // ARCH-S: microchipProj removed — pets.microchipId* columns dropped.
      // Canonical microchip data lives in pet_identifications.

      // Las columnas actuales se releen DENTRO de la tx, bajo el advisory lock.
      // Antes se diffeaba contra la fila traida en el barrido inicial, o sea un
      // valor leido antes de tomar el lock: si otro writer la tocaba en el medio,
      // el diff comparaba contra un estado viejo. Ahora la lectura y la escritura
      // ocurren bajo el mismo lock.
      const [current] = await tx
        .select({
          status: pets.status,
          deceasedAt: pets.deceasedAt,
          estimatedWeightKg: pets.estimatedWeightKg,
        })
        .from(pets)
        .where(eq(pets.id, pet.id))
        .limit(1);
      if (!current) return { status: "ok" as const };

      const expected = { ...statusProj, ...weightProj };
      const drifts = diffPet(current, expected);

      if (drifts.length === 0) {
        return { status: "ok" as const };
      }

      const summary = drifts
        .map((d) => `${d.column}: ${JSON.stringify(d.current)} → ${JSON.stringify(d.expected)}`)
        .join("; ");

      if (!args.apply) {
        return { status: "drift" as const, summary };
      }

      await tx
        .update(pets)
        .set({
          status: expected.status,
          deceasedAt: expected.deceasedAt,
          estimatedWeightKg: expected.estimatedWeightKg,
          // ARCH-S: microchip columns dropped — no longer updated here.
          updatedAt: new Date(),
        })
        .where(eq(pets.id, pet.id));

      return { status: "fixed" as const, summary };
    });

    if (outcome.status === "ok") {
      console.log(`OK     ${pet.publicToken}`);
      continue;
    }

    driftCount++;
    if (outcome.status === "drift") {
      console.log(`DRIFT  ${pet.publicToken}  ${outcome.summary}`);
    } else {
      fixedCount++;
      console.log(`FIXED  ${pet.publicToken}  ${outcome.summary}`);
    }
  }

  console.log("");
  console.log(
    `Summary: ${targetPets.length} pet(s) scanned, ${driftCount} with drift${
      args.apply ? `, ${fixedCount} fixed` : " (dry-run, no writes)"
    }.`,
  );
  process.exit(driftCount > 0 && !args.apply ? 1 : 0);
}

main().catch((err) => {
  console.error("rebuild-projections crashed:", err);
  process.exit(2);
});
