// streamSenasaBatch — paginación por keyset (2a pasada, nota del Paso 4).
//
// POR QUÉ EXISTE. La query de export SENASA no tenía LIMIT: materializaba todos
// los eventos sanitarios del scope en memoria. Está dormida (cero callers), y
// por eso se reescribió como generador paginado ANTES de que alguien la cablee
// — el que la cablee no la va a auditar, va a asumir que está lista.
//
// Una reescritura de una query con cursor que "pasa" porque nadie la llama no
// prueba nada. Lo que este archivo verifica es lo único que un keyset puede
// romper de verdad: el LÍMITE DE PÁGINA. Y en particular el caso donde el
// keyset ingenuo falla — varias filas compartiendo el mismo `occurred_at`. Si
// el cursor fuera sólo la fecha, esas filas se saltearían o se repetirían.
//
// Corre contra el Postgres local, provisiona su fixture y lo limpia.

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petEvents, pets } from "@/db";
import { streamSenasaBatch } from "@/lib/analytics/senasa-export-query";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { withMutationOverride } from "./_helpers/db-overrides";

const PROVINCE = "Santa Fe";
const LOCALITY = "SenasaStreamVille"; // única de este archivo
const TOKEN = "DIM-SENASA-STREAM";

// Todos los eventos comparten EXACTAMENTE el mismo occurred_at a propósito:
// es el caso que rompe un cursor que sólo mira la fecha.
const SAME_INSTANT = new Date("2026-06-15T12:00:00Z");
const EVENT_COUNT = 7;

let petId: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, TOKEN));
    for (const s of stale) {
      await tx.delete(petEvents).where(eq(petEvents.petId, s.id));
      await tx.delete(pets).where(eq(pets.id, s.id));
    }
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TOKEN,
      name: "SenasaStreamDog",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: PROVINCE,
      jurisdictionLocality: LOCALITY,
    })
    .returning();
  petId = pet.id;

  for (let i = 0; i < EVENT_COUNT; i++) {
    await db.insert(petEvents).values({
      petId,
      eventType: "vaccination_administered",
      occurredAt: SAME_INSTANT,
      recordedAt: SAME_INSTANT,
      authorRole: "vet",
      recordedByUserId: null,
      payload: {
        payload_version: 1,
        vaccine_name: "Antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
        pet_jurisdiction_province: PROVINCE,
        pet_jurisdiction_locality: LOCALITY,
      },
      // Lo que hace que la fila entre al export SENASA.
      tipoEventoCode: "VAC_ANTIRRABICA",
      loteBiologico: `LOTE-${i}`,
    });
  }
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    if (petId) {
      await tx.delete(petEvents).where(eq(petEvents.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    }
  }).catch(() => {});
});

function ctx() {
  return buildProjectionContext(
    { role: "govt" },
    [{ province: PROVINCE, locality: LOCALITY }],
    windows.trailing12m(),
  );
}

async function collect(pageSize?: number) {
  const out = [];
  for await (const row of streamSenasaBatch(ctx(), pageSize ? { pageSize } : {})) {
    out.push(row);
  }
  return out;
}

describe("streamSenasaBatch — keyset compuesto", () => {
  it("emite TODAS las filas cuando el corte de página cae entre filas del mismo instante", async () => {
    // pageSize 2 sobre 7 filas idénticas en fecha: tres cortes de página, todos
    // dentro del mismo occurred_at. Un cursor por fecha sola se colgaría o
    // saltearía acá.
    const rows = await collect(2);

    expect(rows).toHaveLength(EVENT_COUNT);
  });

  it("no repite ninguna fila entre páginas", async () => {
    const rows = await collect(2);
    const lotes = rows.map((r) => r.loteBiologico);

    expect(new Set(lotes).size).toBe(EVENT_COUNT);
  });

  it("da el mismo resultado con una sola página que con varias", async () => {
    const paged = await collect(2);
    const single = await collect(1000);

    expect(paged.map((r) => r.loteBiologico).sort()).toEqual(
      single.map((r) => r.loteBiologico).sort(),
    );
  });

  it("no emite el id del keyset — no forma parte del contrato de salida", async () => {
    // El transform puro recibe SenasaEventRow; el id existe sólo para paginar.
    const [row] = await collect(2);

    expect(row).not.toHaveProperty("id");
    expect(row.animalToken).toBe(TOKEN);
  });

  it("no emite nada para un govt sin jurisdicciones asignadas", async () => {
    const empty = buildProjectionContext({ role: "govt" }, [], windows.trailing12m());
    const out = [];
    for await (const row of streamSenasaBatch(empty)) out.push(row);

    expect(out).toEqual([]);
  });
});
