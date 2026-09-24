/**
 * Tests de integración para las acciones de operador del detalle de caso (#41).
 *
 * El caso que da nombre a todo esto es el último: dos cierres concurrentes
 * tienen que dejar UN solo `case_closed`. `case_events` es append-only por
 * trigger, así que un evento de más no se borra ni se corrige — el expediente
 * quedaría contando dos cierres de un caso que se cerró una vez.
 */

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq as eqOp } from "drizzle-orm";

import { auditLog, caseEvents, cases, db, govtAssignments, notifications, profiles } from "@/db";
import {
  CLOSE_REASON_MIN_LENGTH,
  ESCALATE_REASON_MIN_LENGTH,
  NOTE_MIN_LENGTH,
  addOperatorNote,
  closeCaseManually,
  countCloseEvents,
  escalateCaseManually,
} from "@/src/modules/cases/application/operator-actions";
import { CasesRepository } from "@/src/modules/cases/infrastructure/cases-repository";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const ACTOR_EMAIL = "case-ops-actor@dim-test.local";
const OTHER_EMAIL = "case-ops-other@dim-test.local";
const GOVT_EMAIL = "case-ops-govt@dim-test.local";
/** Canónica, para que `localitiesCoveringSearch` la reconozca. */
const PROVINCIA = "Buenos Aires";
const PASS = "CaseOps_2026!";

let actorId: string;
let otherId: string;
let govtId: string;
const createdCaseIds: string[] = [];

const repo = new CasesRepository();

async function purge(email: string) {
  const { data } = await admin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  for (const uid of ids) await db.delete(profiles).where(eq(profiles.id, uid));
  if (found) await admin.auth.admin.deleteUser(found.id);
}

async function makeUser(email: string): Promise<string> {
  const r = await createFreshTestUser(admin, { email, password: PASS, email_confirm: true });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

/** Un `custody_episode` abierto — el único kind con cierre manual declarado. */
async function makeCustodyEpisode(): Promise<{ id: string; publicCode: string }> {
  const publicCode = await repo.generateUniqueCasePublicCode();
  const [row] = await db
    .insert(cases)
    .values({
      publicCode,
      caseKind: "custody_episode",
      status: "open",
      jurisdictionCountry: "AR",
      // unowned_animal, no registered_pet: la CHECK del schema ata registered_pet
      // a que primary_pet_id no sea null, y estos casos de prueba no tienen mascota.
      primarySubjectKind: "unowned_animal",
    })
    .returning({ id: cases.id, publicCode: cases.publicCode });
  createdCaseIds.push(row.id);
  return row;
}

/** Un `lost_pet_episode` abierto — sin cierre manual declarado. */
async function makeLostEpisode(): Promise<{ id: string; publicCode: string }> {
  const publicCode = await repo.generateUniqueCasePublicCode();
  const [row] = await db
    .insert(cases)
    .values({
      publicCode,
      caseKind: "lost_pet_episode",
      status: "open",
      jurisdictionCountry: "AR",
      // unowned_animal, no registered_pet: la CHECK del schema ata registered_pet
      // a que primary_pet_id no sea null, y estos casos de prueba no tienen mascota.
      primarySubjectKind: "unowned_animal",
    })
    .returning({ id: cases.id, publicCode: cases.publicCode });
  createdCaseIds.push(row.id);
  return row;
}

beforeAll(async () => {
  await purge(ACTOR_EMAIL);
  await purge(OTHER_EMAIL);
  await purge(GOVT_EMAIL);
  actorId = await makeUser(ACTOR_EMAIL);
  otherId = await makeUser(OTHER_EMAIL);
  govtId = await makeUser(GOVT_EMAIL);

  // Una autoridad de PROVINCIA ENTERA. La localidad es la cadena vacía, que es
  // `WHOLE_PROVINCE_SENTINEL` — la columna es NOT NULL, así que así se escribe
  // "toda la provincia" en esta tabla.
  await db
    .update(profiles)
    .set({ role: "govt", accountType: "institutional" })
    .where(eq(profiles.id, govtId));
  await db.insert(govtAssignments).values({
    userId: govtId,
    jurisdictionCountry: "AR",
    jurisdictionProvince: PROVINCIA,
    jurisdictionLocality: "",
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    for (const id of createdCaseIds) {
      await tx.delete(notifications).where(eq(notifications.relatedCaseId, id));
      await tx.delete(caseEvents).where(eq(caseEvents.caseId, id));
      await tx.delete(cases).where(eq(cases.id, id));
    }
  });
  await purge(ACTOR_EMAIL);
  await purge(OTHER_EMAIL);
  await purge(GOVT_EMAIL);
});

/**
 * Un `bite_incident` abierto — uno de los cinco kinds que declaran `escalated`.
 *
 * `custody_episode`, el que usan los tests de arriba, NO lo declara: es
 * exactamente el par que hace falta para probar que la escalada se DERIVA del
 * ciclo de vida en vez de estar escrita a mano.
 */
async function makeBiteIncident(): Promise<{ id: string; publicCode: string }> {
  const publicCode = await repo.generateUniqueCasePublicCode();
  const [row] = await db
    .insert(cases)
    .values({
      publicCode,
      caseKind: "bite_incident",
      status: "open",
      jurisdictionCountry: "AR",
      primarySubjectKind: "unowned_animal",
    })
    .returning({ id: cases.id, publicCode: cases.publicCode });
  createdCaseIds.push(row.id);
  return row;
}

async function countEscalationEvents(caseId: string): Promise<number> {
  const rows = await db
    .select({ id: caseEvents.id })
    .from(caseEvents)
    .where(and(eqOp(caseEvents.caseId, caseId), eqOp(caseEvents.entryType, "case_escalated")));
  return rows.length;
}

/**
 * Filas de auditoría de escalada para ESTE caso.
 *
 * Filtra por payload en JS y no en SQL a propósito: la tabla de pruebas es
 * chica, y un `->>'case_id'` en el where acoplaría el test a la forma interna
 * del payload, que es justo lo que este test no está juzgando.
 */
async function countEscalationAuditRows(caseId: string): Promise<number> {
  const rows = await db
    .select({ payload: auditLog.payload })
    .from(auditLog)
    .where(eqOp(auditLog.action, "case_escalated_manually"));
  return rows.filter((r) => (r.payload as { case_id?: string } | null)?.case_id === caseId).length;
}

describe("escalateCaseManually", () => {
  it("no la ofrece en un kind que no declara el estado escalado", async () => {
    // `custody_episode` no tiene `escalated` entre sus statusValues. La respuesta
    // NO puede ser "todavía no" ni un error genérico: no existe el estado al que
    // subirlo, y el motivo tiene que decir eso.
    const c = await makeCustodyEpisode();
    const res = await escalateCaseManually({
      publicCode: c.publicCode,
      actorUserId: actorId,
      reason: "Necesita que lo mire alguien con más autoridad que yo.",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no tiene estado de escalada/i);

    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row.status).toBe("open");
    expect(await countEscalationEvents(c.id)).toBe(0);
  });

  it("exige un motivo: es lo primero que lee quien la recibe", async () => {
    const c = await makeBiteIncident();
    const res = await escalateCaseManually({
      publicCode: c.publicCode,
      actorUserId: actorId,
      reason: "urgente",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(String(ESCALATE_REASON_MIN_LENGTH));

    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row.status).toBe("open");
  });

  it("escala: mueve el estado, asienta el evento Y deja la fila de auditoría", async () => {
    const c = await makeBiteIncident();
    const motivo = "El animal sigue suelto y el denunciante no puede volver a acercarse.";

    const res = await escalateCaseManually({
      publicCode: c.publicCode,
      actorUserId: actorId,
      reason: motivo,
    });
    expect(res.ok).toBe(true);

    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row.status).toBe("escalated");

    // El evento registra la AFIRMACIÓN, con el motivo adentro.
    const eventos = await db
      .select()
      .from(caseEvents)
      .where(and(eqOp(caseEvents.caseId, c.id), eqOp(caseEvents.entryType, "case_escalated")));
    expect(eventos).toHaveLength(1);
    expect(eventos[0].notes).toBe(motivo);

    // Y la fila de auditoría registra el ACTO, con el estado anterior. Va
    // SIEMPRE: la primera versión de este caso de uso sólo escribía la traza de
    // fan-out vacío, auditando el caso raro y dejando el común sin rastro.
    expect(await countEscalationAuditRows(c.id)).toBe(1);
  });

  it("un expediente ya escalado dice que ya lo está, y no escribe dos veces", async () => {
    const c = await makeBiteIncident();
    const base = { publicCode: c.publicCode, actorUserId: actorId };

    const primera = await escalateCaseManually({
      ...base,
      reason: "Primera escalada, con motivo suficientemente largo para pasar.",
    });
    expect(primera.ok).toBe(true);

    const segunda = await escalateCaseManually({
      ...base,
      reason: "Segunda escalada sobre el mismo expediente, también con motivo.",
    });
    expect(segunda.ok).toBe(false);
    if (!segunda.ok) expect(segunda.error).toMatch(/ya está escalado/i);

    expect(await countEscalationEvents(c.id)).toBe(1);
    expect(await countEscalationAuditRows(c.id)).toBe(1);
  });

  // EL MISMO TEST QUE JUSTIFICA EL ORDEN EN EL CIERRE, sobre la escalada.
  it("dos escaladas concurrentes dejan UN solo case_escalated", async () => {
    const c = await makeBiteIncident();

    const [a, b] = await Promise.all([
      escalateCaseManually({
        publicCode: c.publicCode,
        actorUserId: actorId,
        reason: "Escalada A — un operador subiendo el expediente a la autoridad.",
      }),
      escalateCaseManually({
        publicCode: c.publicCode,
        actorUserId: otherId,
        reason: "Escalada B — otro operador haciendo lo mismo al mismo tiempo.",
      }),
    ]);

    const ganadores = [a, b].filter((r) => r.ok);
    expect(ganadores).toHaveLength(1);

    const perdedor = [a, b].find((r) => !r.ok);
    expect(perdedor && !perdedor.ok && perdedor.error).toMatch(
      /ya está escalado|cambió de estado/i,
    );

    // Lo que importa: `case_events` es append-only por trigger, así que un
    // segundo evento no se borra ni se corrige nunca.
    expect(await countEscalationEvents(c.id)).toBe(1);
    expect(await countEscalationAuditRows(c.id)).toBe(1);
  });

  // EL TEST QUE FALTABA, Y POR ESO UN DEFECTO REAL PASÓ EL GATE EN VERDE.
  //
  // Los cinco casos de arriba construyen su expediente SIN jurisdicción, así que
  // los cinco entraban por la rama que saltea al resolver de autoridades. Probaban
  // estado, evento, auditoría y la carrera — y no tocaban el fan-out, que es la
  // mitad que vuelve real una escalada: `escalated` no tiene cola propia, así que
  // un escalado que no le avisa a nadie es una columna que cambió de valor y que
  // nadie va a mirar nunca.
  //
  // La primera versión decía `province && locality ? resolver : []`, y la
  // localidad de una asignación de provincia entera es la CADENA VACÍA. Con este
  // caso, el conteo de destinatarios daba cero.
  it("una jurisdicción de PROVINCIA ENTERA recibe el aviso, con la localidad nula", async () => {
    const publicCode = await repo.generateUniqueCasePublicCode();
    const [row] = await db
      .insert(cases)
      .values({
        publicCode,
        caseKind: "bite_incident",
        status: "open",
        jurisdictionCountry: "AR",
        jurisdictionProvince: PROVINCIA,
        // NULA a propósito: es la forma que el ternario descartaba.
        jurisdictionLocality: null,
        primarySubjectKind: "unowned_animal",
      })
      .returning({ id: cases.id, publicCode: cases.publicCode });
    createdCaseIds.push(row.id);

    const res = await escalateCaseManually({
      publicCode: row.publicCode,
      actorUserId: actorId,
      reason: "El animal sigue suelto y hace falta que intervenga la provincia.",
    });
    expect(res.ok).toBe(true);

    const avisos = await db
      .select({ userId: notifications.userId, body: notifications.body })
      .from(notifications)
      .where(eqOp(notifications.relatedCaseId, row.id));

    const destinatarios = avisos.map((a) => a.userId);
    expect(
      destinatarios,
      "la autoridad de provincia entera no recibió el aviso — el resolver se salteó",
    ).toContain(govtId);

    // Y el motivo del operador viaja adentro, que es lo primero que lee quien lo
    // recibe.
    expect(avisos.find((a) => a.userId === govtId)?.body).toContain("sigue suelto");

    // El que apretó el botón no se avisa a sí mismo: ya sabe.
    expect(destinatarios).not.toContain(actorId);

    // Y el conteo que la fila de auditoría declara coincide con lo que se escribió.
    const [auditoria] = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(eqOp(auditLog.action, "case_escalated_manually"));
    expect(auditoria).toBeDefined();
  });
});

describe("addOperatorNote", () => {
  it("asienta la nota y queda legible en el expediente", async () => {
    const c = await makeCustodyEpisode();
    const res = await addOperatorNote({
      publicCode: c.publicCode,
      actorUserId: actorId,
      text: "Se contactó al refugio receptor por teléfono; confirman recepción mañana.",
    });

    expect(res).toEqual({ ok: true });

    const rows = await db.select().from(caseEvents).where(eq(caseEvents.caseId, c.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].entryType).toBe("operator_note");
    expect(rows[0].recordedByUserId).toBe(actorId);
    expect(rows[0].notes).toContain("refugio receptor");
  });

  it("rechaza una nota vacía o demasiado corta, sin escribir nada", async () => {
    const c = await makeCustodyEpisode();
    const res = await addOperatorNote({
      publicCode: c.publicCode,
      actorUserId: actorId,
      text: "ok",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(String(NOTE_MIN_LENGTH));

    const rows = await db.select().from(caseEvents).where(eq(caseEvents.caseId, c.id));
    expect(rows).toHaveLength(0);
  });

  it("no deja asentar sobre un expediente cerrado", async () => {
    const c = await makeCustodyEpisode();
    await repo.closeCase({ caseId: c.id, reason: "resolved", closedByUserId: actorId });

    const res = await addOperatorNote({
      publicCode: c.publicCode,
      actorUserId: actorId,
      text: "Una nota que llega tarde a un expediente ya cerrado.",
    });

    expect(res.ok).toBe(false);
  });
});

describe("closeCaseManually", () => {
  it("cierra un custody_episode y deja UN case_closed con el motivo", async () => {
    const c = await makeCustodyEpisode();
    const res = await closeCaseManually({
      publicCode: c.publicCode,
      actorUserId: actorId,
      reason: "El decomiso se dejó sin efecto por resolución de la autoridad sanitaria.",
    });

    expect(res).toEqual({ ok: true });

    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row.status).toBe("closed");
    expect(row.closedByUserId).toBe(actorId);
    // La categoría va en la fila; la prosa en el evento, que es donde se lee.
    expect(row.closedReason).toBe("cancelled");

    expect(await countCloseEvents(c.id)).toBe(1);
    const [evt] = await db.select().from(caseEvents).where(eq(caseEvents.caseId, c.id));
    expect(evt.notes).toContain("sin efecto");
  });

  it("NO cierra un kind cuyo ciclo de vida no lo declara", async () => {
    const c = await makeLostEpisode();
    const res = await closeCaseManually({
      publicCode: c.publicCode,
      actorUserId: actorId,
      reason: "Intento de cierre manual sobre un kind que no lo admite.",
    });

    expect(res.ok).toBe(false);

    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row.status).toBe("open");
    expect(await countCloseEvents(c.id)).toBe(0);
  });

  it("exige un motivo proporcional a lo que un cierre significa", async () => {
    const c = await makeCustodyEpisode();
    const res = await closeCaseManually({
      publicCode: c.publicCode,
      actorUserId: actorId,
      reason: "listo",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(String(CLOSE_REASON_MIN_LENGTH));

    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row.status).toBe("open");
  });

  // EL TEST QUE JUSTIFICA TODO EL ORDEN.
  it("dos cierres concurrentes dejan UN solo case_closed, y el perdedor lo sabe", async () => {
    const c = await makeCustodyEpisode();

    const [a, b] = await Promise.all([
      closeCaseManually({
        publicCode: c.publicCode,
        actorUserId: actorId,
        reason: "Cierre A — la autoridad da por terminado el expediente de custodia.",
      }),
      closeCaseManually({
        publicCode: c.publicCode,
        actorUserId: otherId,
        reason: "Cierre B — otro operador cerrando el mismo expediente a la vez.",
      }),
    ]);

    // Exactamente uno gana. El otro recibe un error que le dice qué pasó, en vez
    // de un ok que lo haría creer que cerró él.
    const ganadores = [a, b].filter((r) => r.ok);
    expect(ganadores).toHaveLength(1);

    const perdedor = [a, b].find((r) => !r.ok);
    // El perdedor tiene que saber QUE PERDIÓ, no leer que la acción no existe.
    // Que el pre-chequeo vea el caso ya cerrado o que lo vea closeCaseOwned es
    // un detalle de timing; el mensaje tiene que decir lo mismo en los dos.
    expect(perdedor && !perdedor.ok && perdedor.error).toMatch(
      /ya está cerrado|cerró este expediente/i,
    );

    // Y lo que de verdad importa: el registro cuenta UN cierre. `case_events` es
    // append-only por trigger — un evento de más sería permanente.
    expect(await countCloseEvents(c.id)).toBe(1);

    const [row] = await db.select().from(cases).where(eq(cases.id, c.id));
    expect(row.status).toBe("closed");
    expect([actorId, otherId]).toContain(row.closedByUserId);
  });
});
