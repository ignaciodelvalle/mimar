// getOwnedPetsCountCached — LIVE pets, not live ownerships.
//
// PRE-PUSH REVIEW 2026-07-30 of D.8. The tab-bar centre slot picks "Asentar"
// (→ /inicio?sheet=anotar) vs "Registrar mascota" (→ /mis-mascotas/nueva) off this
// count. The first version counted ACTIVE OWNERSHIPS, and DEATH DOES NOT END AN
// OWNERSHIP — no code path sets `ownerships.ended_at` when a pet dies, because
// In memoriam is deliberately still your pet. So an owner whose only pet had
// died counted >= 1, got "Asentar", and landed on /mis-mascotas with an inert
// sheet: the silent no-op D.8 exists to remove, on a grieving owner.
//
// Integration (local Postgres + Supabase auth) because the defect lives in the
// SQL predicate, not in the wiring — the source-scan guard beside this file
// (owned-pets-count-slot-signal.test.ts) can only pin the shape. Each case
// provisions its own owner and tears it down.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The tab bar reads the route to decide the capture target; pinned to the
// pets index so the slot is decided by the COUNT alone (the branch under test).
vi.mock("next/navigation", () => ({ usePathname: () => "/mis-mascotas" }));

import { CitizenTabBar } from "@/components/layout/CitizenTabBar";
import { OWNER_NAV } from "@/components/layout/nav-presets";
import { db, ownerships, pets } from "@/db";
import { getOwnedPetsCountCached } from "@/lib/infra/request-cache";

import { withMutationOverride } from "./_helpers/db-overrides";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

/** The centre-slot label the tab bar renders for a given count. */
function slotLabel(ownedPetsCount: number): "Asentar" | "Registrar mascota" {
  const html = renderToStaticMarkup(
    <CitizenTabBar nav={OWNER_NAV} ownedPetsCount={ownedPetsCount} />,
  );
  return html.includes(">Registrar mascota<") ? "Registrar mascota" : "Asentar";
}

async function createOwner(email: string): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers();
  const existing = list?.users.find((u) => u.email === email);
  if (existing) await admin.auth.admin.deleteUser(existing.id);
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "Test-Passw0rd!",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return data.user.id;
}

async function givePet(userId: string, token: string, status: "active" | "deceased") {
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: token, name: `Pet_${token}`, species: "dog", sex: "unknown", status })
    .returning();
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId: userId, role: "owner" });
  return pet.id;
}

async function purge(userId: string) {
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
}

const STAMP = Date.now();
let mourningId = "";
let mixedId = "";

beforeAll(async () => {
  mourningId = await createOwner(`owned-count-mourning-${STAMP}@dim.test`);
  mixedId = await createOwner(`owned-count-mixed-${STAMP}@dim.test`);
  await givePet(mourningId, `DIM-OCD1-${STAMP % 100000}`, "deceased");
  await givePet(mixedId, `DIM-OCD2-${STAMP % 100000}`, "active");
  await givePet(mixedId, `DIM-OCD3-${STAMP % 100000}`, "deceased");
}, 60_000);

afterAll(async () => {
  if (mourningId) await purge(mourningId);
  if (mixedId) await purge(mixedId);
}, 60_000);

describe("getOwnedPetsCountCached excludes deceased pets", () => {
  it("an owner whose ONLY pet died counts 0 and gets the 'Registrar mascota' slot", async () => {
    // The ownership is still ACTIVE (death never ends it) — that is exactly the
    // trap: counting ownerships returns 1 here and re-arms the no-op.
    const stillOwned = await db
      .select()
      .from(ownerships)
      .where(eq(ownerships.ownerUserId, mourningId));
    expect(stillOwned.filter((o) => o.endedAt === null)).toHaveLength(1);

    const n = await getOwnedPetsCountCached(mourningId);
    expect(n).toBe(0);
    expect(slotLabel(n)).toBe("Registrar mascota");
  }, 30_000);

  it("an owner with 1 live + 1 deceased counts 1 and keeps 'Asentar'", async () => {
    const n = await getOwnedPetsCountCached(mixedId);
    expect(n).toBe(1);
    expect(slotLabel(n)).toBe("Asentar");
  }, 30_000);
});
