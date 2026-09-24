// Jurisdiction gating of tag surfaces is DISCOVERY-ONLY (design D6).
//
// Two halves:
//   1. shouldShowTagSurfaces behavior — hidden when the rule is off and the
//      user has no tags; shown when the rule enables engraved_plate for an
//      owned pet's jurisdiction; ALWAYS shown once the user holds a tag
//      (a rule flip must never strand a shipped chapa).
//   2. Structural fence — the activation page and the /t/[serial] resolver
//      must NOT consult the business rule at all: their reachability is
//      unconditional by design, and the cheapest honest proof is that they
//      never import the resolver.

import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveChannels } = vi.hoisted(() => ({
  mockResolveChannels: vi.fn(),
}));

vi.mock("@/lib/infra/physical-credential-channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/physical-credential-channels")>();
  return {
    ...actual,
    resolvePhysicalCredentialChannels: mockResolveChannels,
  };
});

import { db, ownerships, petTags, pets } from "@/db";
import { generateTagSerial } from "@/lib/infra/publicToken";
import { shouldShowTagSurfaces } from "@/lib/infra/tag-surfaces-visibility";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const USER_EMAIL = "tag-visibility@dim-test.local";
const TEST_LOTE = "TEST-LOTE-TAGVIS";

let userId: string;
let petId: string;

const DISABLED = {
  printable_qr: true,
  engraved_plate: { enabled: false },
  nfc_tag: { enabled: false },
};
const ENABLED = {
  printable_qr: true,
  engraved_plate: { enabled: true, providerName: "Grabados Test", providerUrl: "https://x.test" },
  nfc_tag: { enabled: false },
};

async function purge() {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === USER_EMAIL);
  await db.delete(petTags).where(eq(petTags.loteId, TEST_LOTE));
  if (!found) return;
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  await withMutationOverride(async (tx) => {
    for (const { petId: id } of owned) await tx.delete(pets).where(eq(pets.id, id));
  });
  await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purge();
  const { data, error } = await createFreshTestUser(admin, {
    email: USER_EMAIL,
    password: "TagVisibility_2026!",
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-TAGV-${Date.now().toString(36).toUpperCase().slice(-4)}`,
      name: "Visibility Pet",
      species: "dog",
      sex: "female",
      status: "active",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning({ id: pets.id });
  petId = pet.id;
  await db.insert(ownerships).values({ petId, ownerUserId: userId, role: "owner" });
}, 30_000);

afterAll(async () => {
  await purge();
}, 30_000);

beforeEach(() => {
  mockResolveChannels.mockReset();
});

describe("shouldShowTagSurfaces (D6 discovery gating)", () => {
  it("hides the surfaces when the rule is disabled and the user has no tags", async () => {
    mockResolveChannels.mockResolvedValue(DISABLED);
    expect(await shouldShowTagSurfaces(userId)).toBe(false);
    // Consulted the pet's jurisdiction.
    expect(mockResolveChannels).toHaveBeenCalledWith({
      country: "AR",
      province: "Buenos Aires",
      locality: "La Plata",
    });
  });

  it("shows the surfaces when engraved_plate is enabled for an owned pet's jurisdiction", async () => {
    mockResolveChannels.mockResolvedValue(ENABLED);
    expect(await shouldShowTagSurfaces(userId)).toBe(true);
  });

  it("shows the surfaces once the user holds a tag, even with the rule disabled", async () => {
    mockResolveChannels.mockResolvedValue(DISABLED);
    const serial = generateTagSerial();
    const now = new Date();
    await db.insert(petTags).values({
      serial,
      activationCodeHash: hashTagActivationCode("QQQQ-QQQQ"),
      loteId: TEST_LOTE,
      status: "active",
      petId,
      activatedByUserId: userId,
      activatedAt: now,
    });
    expect(await shouldShowTagSurfaces(userId)).toBe(true);
    // The rule was never even needed: participation short-circuits.
    expect(mockResolveChannels).not.toHaveBeenCalled();
  });
});

describe("activation + resolver reachability is unconditional (structural fence)", () => {
  const ROOT = path.resolve(__dirname, "..");
  const UNGATED_SURFACES = [
    "app/(app)/cuenta/chapas/activar/page.tsx",
    "app/(public)/t/[serial]/page.tsx",
  ];

  it.each(UNGATED_SURFACES)("%s never consults the engraved_plate rule", (rel) => {
    const source = readFileSync(path.join(ROOT, rel), "utf8");
    expect(source).not.toContain("resolvePhysicalCredentialChannels");
    expect(source).not.toContain("resolveBusinessRule");
  });
});
