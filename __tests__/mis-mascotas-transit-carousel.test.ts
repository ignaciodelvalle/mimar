// Regression test — exercises the REAL app/(app)/mis-mascotas/page.tsx (not a
// re-implementation of its logic) to pin the canon-C2 parity at the page level
// on the surface that owns the per-pet credential rows (owner-ia-redesign P5:
// /inicio folded away; the index rows live on /mis-mascotas — reverted from
// cards back to LnRegRow list rows in PO ronda 4): a transit/foster-role pet's
// row must show its REAL compliance status ("ok"), not the "registered"
// placeholder fallback.
//
// The old /inicio page computed compliance only over an owner-role-only pet
// set, dropping a foster pet. The index has no such filter — it computes
// compliance over EVERY active owned pet — so the bug cannot recur here; this
// test locks that in against a future refactor.
//
// requireUserOrRedirect is mocked to skip real Supabase session cookies (its
// supabase stub also answers auth.getUser for the transfers-by-email branch);
// every other read the page performs hits the real local Postgres/Supabase.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(),
}));

import { LnRegRow } from "@/components/ui/RegRow";
import { db, ownerships, petEvents, pets } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const EMAIL = "mis-mascotas-transit-carousel@dim-test.local";
const PASS = "MisMascotasTransitCarousel_2026!";
const TOKEN = "TRNS-TEST-0003";

const VET = { authorRole: "vet" as const, authorVerified: true, authorOrganizationId: null };

let userId: string;
let petId: string;

beforeAll(async () => {
  const { data: list } = await admin.auth.admin.listUsers();
  const existing = list?.users.find((u) => u.email === EMAIL);
  if (existing) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.publicToken, TOKEN));
    });
    await admin.auth.admin.deleteUser(existing.id);
  }

  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  userId = data.user.id;

  // The mocked auth guard hands the page a user + a minimal supabase stub whose
  // auth.getUser answers the email used by the transfers-by-email count branch.
  vi.mocked(requireUserOrRedirect).mockResolvedValue({
    supabase: {
      auth: { getUser: async () => ({ data: { user: { email: EMAIL } } }) },
    } as never,
    user: { id: userId } as never,
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: TOKEN,
      name: "Transit Index Test Cat",
      species: "cat", // never PPP — keeps the fixture to 3 obligations.
      status: "active",
    })
    .returning({ id: pets.id });
  petId = pet.id;

  // Transit/foster ownership — included in the index's own active-pet
  // compliance pass (no role filter, unlike the historical owner-only fetch).
  await db.insert(ownerships).values({ petId, ownerUserId: userId, role: "foster" });

  const occurredAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const nextDueAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // "upcoming" → ok
  await db.insert(petEvents).values([
    {
      petId,
      eventType: "vaccination_administered",
      occurredAt,
      payload: { vaccine_name: "Antirrábica", next_due_at: nextDueAt.toISOString() },
      ...VET,
    },
    { petId, eventType: "microchip_implanted", occurredAt, payload: {}, ...VET },
    { petId, eventType: "sterilization_performed", occurredAt, payload: {}, ...VET },
  ]);
});

afterAll(async () => {
  if (petId) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  if (userId) {
    await admin.auth.admin.deleteUser(userId);
  }
});

// Minimal React-element shape used by the DFS below. LnRegRow carries the pet's
// resolved status + its credential href directly as props.
type ElementLike = {
  type?: unknown;
  props?: { children?: unknown; status?: string; href?: string };
};

function isElementLike(node: unknown): node is ElementLike {
  return typeof node === "object" && node !== null && "type" in node;
}

// Depth-first collection of every element of the given `type` in a React
// element tree returned directly from an async Server Component invocation.
function collectByType(node: unknown, type: unknown, out: ElementLike[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectByType(child, type, out);
    return;
  }
  if (!isElementLike(node)) return;
  if (node.type === type) out.push(node);
  collectByType(node.props?.children, type, out);
}

describe("/mis-mascotas index — credential row shows the transit pet's real status", () => {
  it("LnRegRow receives the pet with status 'ok', not the 'registered' fallback", async () => {
    const { default: MisMascotasPage } = await import("@/app/(app)/mis-mascotas/page");
    const result = await MisMascotasPage({ searchParams: Promise.resolve({}) });

    const rows: ElementLike[] = [];
    collectByType(result, LnRegRow, rows);
    const row = rows.find((r) => r.props?.href === `/mis-mascotas/${TOKEN}`)?.props;
    expect(row).toBeDefined();
    // Before the equivalent /inicio fix this pet had NO compliance entry and
    // fell back to "registered"; the index computes compliance over every
    // active pet, so it reads the real "ok".
    expect(row?.status).toBe("ok");
  });
});
