// Integration test for lib/infra/notifications.ts → runPostAdoptionCheckinScan,
// FASE 2 (el aviso de check-in vencido a los admins del refugio).
//
// POR QUÉ EXISTE ESTE ARCHIVO. La fase 2 no tenía ninguna cobertura real: el
// único test que la nombraba (cron-post-adoption-checkin-route.test.ts) mockea
// el scan entero y sólo ejercita la autenticación de la ruta. O sea que la
// query que resuelve la organización, los admins y el token —y el guard de
// deduplicación— nunca se ejecutaron contra una base.
//
// Eso importó cuando la fase 2 se reescribió (2a pasada de auditoría, hallazgo
// #4): cargaba TODOS los candidatos vencidos sin limit, sin cursor y sin
// deadline, con 3 queries secuenciales por candidato. Ahora pagina por keyset
// con presupuesto de 45s y batchea los lookups por página. Una reescritura de
// queries con joins nuevos que "pasa" porque el test de la ruta está mockeado no
// prueba nada.
//
// Corre contra el Postgres local. Provisiona su propio fixture y lo limpia.

import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  reminders,
} from "@/db";
import { runPostAdoptionCheckinScan } from "@/lib/infra/notifications";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const ADMIN_EMAIL = "postadopt-scan-admin@dim-test.local";
const ADOPTER_EMAIL = "postadopt-scan-adopter@dim-test.local";
const PASS = "PostAdoptScan_2026!";
const ADMIN2_EMAIL = "postadopt-scan-admin2@dim-test.local";
const ORG_TOKEN = "ORG-POSTADOPT-SCAN";
const ORG2_TOKEN = "ORG-POSTADOPT-SCAN-2";

let orgAdminUserId: string;
let adopterUserId: string;
let orgId: string;
// Con org en el payload → debe notificar.
let petWithOrgId: string;
let reminderWithOrgId: string;
// Sin org en el payload → NO debe notificar, y además queda fuera del barrido.
let petNoOrgId: string;
let reminderNoOrgId: string;
// Segunda organización, con su propio admin y su propio candidato EN LA MISMA
// PÁGINA. Con una sola org, un bug en el agrupado por página (admins o tokens
// mapeados a la org equivocada, o pisados entre sí) es invisible.
let org2Id: string;
let org2AdminUserId: string;
let pet2Id: string;

async function deleteUserIfExists(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (found) {
    await db.delete(notifications).where(eq(notifications.userId, found.id));
    const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
    await withMutationOverride(async (tx) => {
      for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
    });
    await admin.auth.admin.deleteUser(found.id);
  }
}

async function makeUser(email: string): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${email}): ${error?.message}`);
  return data.user.id;
}

/** Un check-in vencido: adopción finalizada + recordatorio ya pasado de fecha. */
async function provisionOverdueCheckin(
  token: string,
  adoptionPayload: Record<string, unknown>,
): Promise<{ petId: string; reminderId: string }> {
  const now = new Date();
  // El umbral de "vencido" mira dueAt hacia atrás; 90 días alcanza de sobra.
  const longAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: "Tobi",
      species: "dog",
      sex: "male",
      status: "active",
    })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: adopterUserId, role: "owner" });

  const [event] = await db
    .insert(petEvents)
    .values({
      petId: pet.id,
      eventType: "adoption_finalized",
      occurredAt: longAgo,
      recordedAt: longAgo,
      recordedByUserId: orgAdminUserId,
      authorRole: "shelter",
      payload: adoptionPayload,
    })
    .returning();

  const [reminder] = await db
    .insert(reminders)
    .values({
      petId: pet.id,
      userId: adopterUserId,
      reminderType: "post_adoption_checkin",
      dueAt: longAgo,
      createdAt: longAgo,
      title: "Check-in post adopción",
      description: "Contanos cómo viene la adaptación.",
      sourceEventId: event.id,
    })
    .returning();

  return { petId: pet.id, reminderId: reminder.id };
}

beforeAll(async () => {
  await deleteUserIfExists(ADMIN_EMAIL);
  await deleteUserIfExists(ADMIN2_EMAIL);
  await deleteUserIfExists(ADOPTER_EMAIL);
  await db.delete(organizations).where(inArray(organizations.publicToken, [ORG_TOKEN, ORG2_TOKEN]));

  orgAdminUserId = await makeUser(ADMIN_EMAIL);
  adopterUserId = await makeUser(ADOPTER_EMAIL);

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Refugio Test Post-Adopción A.C.",
      displayName: "Refugio Test Post-Adopción",
      orgType: "shelter",
      email: "refugio-postadopt@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: orgAdminUserId,
    role: "admin",
  });

  const withOrg = await provisionOverdueCheckin("DIM-PASCAN-01", {
    payload_version: 1,
    previous_owner_organization_id: orgId,
  });
  petWithOrgId = withOrg.petId;
  reminderWithOrgId = withOrg.reminderId;

  const noOrg = await provisionOverdueCheckin("DIM-PASCAN-02", {
    payload_version: 1,
    // Sin previous_owner_organization_id — una adopción registrada sin refugio
    // de origen. Antes se re-escaneaba todos los días para siempre porque nunca
    // insertaba nada y el guard NOT EXISTS nunca lo excluía.
  });
  petNoOrgId = noOrg.petId;
  reminderNoOrgId = noOrg.reminderId;

  org2AdminUserId = await makeUser(ADMIN2_EMAIL);
  const [org2] = await db
    .insert(organizations)
    .values({
      publicToken: ORG2_TOKEN,
      legalName: "Segundo Refugio Test A.C.",
      displayName: "Segundo Refugio Test",
      orgType: "shelter",
      email: "refugio2-postadopt@dim-test.local",
      verified: true,
    })
    .returning();
  org2Id = org2.id;
  await db.insert(organizationMemberships).values({
    organizationId: org2Id,
    userId: org2AdminUserId,
    role: "admin",
  });

  const second = await provisionOverdueCheckin("DIM-PASCAN-03", {
    payload_version: 1,
    previous_owner_organization_id: org2Id,
  });
  pet2Id = second.petId;
});

afterAll(async () => {
  if (orgAdminUserId) {
    await db.delete(notifications).where(inArray(notifications.userId, [orgAdminUserId]));
  }
  if (org2AdminUserId) {
    await db.delete(notifications).where(eq(notifications.userId, org2AdminUserId));
  }
  await withMutationOverride(async (tx) => {
    for (const id of [petWithOrgId, petNoOrgId, pet2Id]) {
      if (id) await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  if (org2Id) await db.delete(organizations).where(eq(organizations.id, org2Id));
  if (org2AdminUserId) await admin.auth.admin.deleteUser(org2AdminUserId);
  if (orgAdminUserId) await admin.auth.admin.deleteUser(orgAdminUserId);
  if (adopterUserId) await admin.auth.admin.deleteUser(adopterUserId);
});

describe("runPostAdoptionCheckinScan — fase 2 (check-in vencido)", () => {
  it("avisa al admin del refugio cuando el check-in venció", async () => {
    await runPostAdoptionCheckinScan(db);

    const rows = await db
      .select({ id: notifications.id, petId: notifications.relatedPetId })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgAdminUserId),
          eq(notifications.notificationType, "post_adoption_checkin_missed"),
          eq(notifications.relatedReminderId, reminderWithOrgId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].petId).toBe(petWithOrgId);
  });

  it("no avisa nada por la adopción sin refugio de origen", async () => {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.relatedReminderId, reminderNoOrgId));

    expect(rows).toHaveLength(0);
  });

  it("es idempotente: correrlo de nuevo no duplica el aviso", async () => {
    // El guard NOT EXISTS + el dedupeKey por (recordatorio, admin) son lo que
    // hace que el cron diario no spamee. Sin esto, el refugio recibe el mismo
    // aviso todos los días hasta que alguien cierre el recordatorio.
    await runPostAdoptionCheckinScan(db);
    await runPostAdoptionCheckinScan(db);

    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgAdminUserId),
          eq(notifications.notificationType, "post_adoption_checkin_missed"),
          eq(notifications.relatedReminderId, reminderWithOrgId),
        ),
      );

    expect(rows).toHaveLength(1);
  });

  it("con DOS refugios en la misma pagina, cada admin recibe SOLO lo suyo", async () => {
    // Este es el caso que un fixture de una sola org no puede ver. Los lookups
    // de admins y de token pasaron a hacerse una vez por PAGINA (inArray) en vez
    // de una vez por fila: si el agrupado por organizacion estuviera mal, el
    // admin del refugio A recibiria el aviso de la mascota del refugio B.
    await runPostAdoptionCheckinScan(db);

    const forOrg2 = await db
      .select({ petId: notifications.relatedPetId })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, org2AdminUserId),
          eq(notifications.notificationType, "post_adoption_checkin_missed"),
        ),
      );

    expect(forOrg2).toHaveLength(1);
    expect(forOrg2[0].petId).toBe(pet2Id);

    const forOrg1 = await db
      .select({ petId: notifications.relatedPetId })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgAdminUserId),
          eq(notifications.notificationType, "post_adoption_checkin_missed"),
        ),
      );

    expect(forOrg1).toHaveLength(1);
    expect(forOrg1[0].petId).toBe(petWithOrgId);
  });
});
