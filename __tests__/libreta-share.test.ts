// Integration tests for Libreta Sanitaria — Parte C (Tier-2 share tokens).
//
// Tests call pure inner writer functions directly, bypassing FormData and the
// Supabase server client — same pattern as create-pet-custody.test.ts and
// role-upgrade.test.ts.

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { logLibretaShareViewForToken } from "@/app/actions/libreta-share";
import { db, libretaShareTokens, ownerships, pets, profiles } from "@/db";
import { generateLibretaShareToken } from "@/lib/infra/publicToken";
import { createLibretaShareForUser } from "@/src/modules/pets/application/libreta-share/create-libreta-share";
import { getActiveLibretaShares } from "@/src/modules/pets/application/libreta-share/get-active-libreta-shares";
import { revokeLibretaShareForUser } from "@/src/modules/pets/application/libreta-share/revoke-libreta-share";
import { findPetPublicTokenForShare } from "@/src/modules/pets/application/libreta-share/revoke-libreta-share";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAIL = "libreta-share-test@dim-test.local";
const EMAIL2 = "libreta-share-test2@dim-test.local";
const PASS = "LibretaShare_2026!";

let userId: string;
let userId2: string;
let petId: string;
const PET_TOKEN = "LBR-TEST-PET1";

async function cleanupUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  // Clean up ownerships + pets for this user.
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  if (owned.length > 0) {
    await withMutationOverride(async (tx) => {
      for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
    });
  }
  await admin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await cleanupUser(EMAIL);
  await cleanupUser(EMAIL2);

  // Also clean up the shared pet token in case a previous run left it.
  await withMutationOverride(async (tx) => {
    await tx.delete(pets).where(eq(pets.publicToken, PET_TOKEN));
  });

  const { data: d1, error: e1 } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (e1 || !d1.user) throw new Error(`createUser1: ${e1?.message}`);
  userId = d1.user.id;

  const { data: d2, error: e2 } = await createFreshTestUser(admin, {
    email: EMAIL2,
    password: PASS,
    email_confirm: true,
  });
  if (e2 || !d2.user) throw new Error(`createUser2: ${e2?.message}`);
  userId2 = d2.user.id;

  // Create a pet owned by userId.
  const [newPet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "TestShare",
      species: "dog",
      sex: "unknown",
      status: "active",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = newPet.id;

  await db.insert(ownerships).values({
    petId,
    ownerUserId: userId,
    role: "owner",
    startedAt: new Date(),
  });
});

afterAll(async () => {
  // Delete the test pet (cascades ownerships, libreta_share_tokens).
  await withMutationOverride(async (tx) => {
    await tx.delete(pets).where(eq(pets.publicToken, PET_TOKEN));
  });
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  await admin.auth.admin.deleteUser(userId2).catch(() => {});
});

// Helper: revoke all active shares for the test pet.
async function revokeAllShares() {
  await db
    .update(libretaShareTokens)
    .set({ revokedAt: new Date(), revokedByUserId: userId })
    .where(and(eq(libretaShareTokens.petId, petId), isNull(libretaShareTokens.revokedAt)));
}

describe("generateLibretaShareToken", () => {
  it("returns LBR-XXXX-XXXX matching the expected format", () => {
    const token = generateLibretaShareToken();
    expect(token).toMatch(/^LBR-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Verify excluded chars: 0, 1, I, O, L are not in the alphabet.
    const body = token.replace(/^LBR-/, "").replace("-", "");
    expect(body).not.toMatch(/[01IOL]/);
  });
});

describe("createLibretaShareForUser", () => {
  it("happy path: returns shareToken and row exists with correct fields", async () => {
    await revokeAllShares();
    const result = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Para prueba",
    });
    expect(result).toHaveProperty("shareToken");
    if (!("shareToken" in result)) return;

    const [row] = await db
      .select()
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, result.shareToken))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.petId).toBe(petId);
    expect(row.createdByUserId).toBe(userId);
    expect(row.viewCountCached).toBe(0);
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt).toBeDefined();
  });

  it("ownership guard: user without active ownership gets error", async () => {
    const result = await createLibretaShareForUser(userId2, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 7,
      label: null,
    });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/no encontrada|sin permisos/i);
  });

  it("cap=5: 6th active share returns friendly error", async () => {
    await revokeAllShares();

    // Insert 5 active shares.
    for (let i = 0; i < 5; i++) {
      const r = await createLibretaShareForUser(userId, {
        petPublicToken: PET_TOKEN,
        expiresInDays: 30,
        label: `Share ${i + 1}`,
      });
      expect(r).toHaveProperty("shareToken");
    }

    // 6th should fail.
    const sixth = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Sixth",
    });
    expect(sixth).toHaveProperty("error");
    if (!("error" in sixth)) return;
    expect(sixth.error).toMatch(/5/); // mentions the cap number
  });

  it("revoke + new = succeeds (revoked ones don't count toward cap)", async () => {
    await revokeAllShares();
    // Create 5 again.
    for (let i = 0; i < 5; i++) {
      await createLibretaShareForUser(userId, {
        petPublicToken: PET_TOKEN,
        expiresInDays: 30,
        label: `Cap-test ${i + 1}`,
      });
    }
    // Revoke all.
    await revokeAllShares();
    // Now a new one should succeed.
    const fresh = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 7,
      label: "After revoke",
    });
    expect(fresh).toHaveProperty("shareToken");
  });
});

describe("revokeLibretaShareForUser", () => {
  it("happy path: sets revoked_at and revoked_by_user_id", async () => {
    await revokeAllShares();
    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Revoke test",
    });
    expect(created).toHaveProperty("shareToken");
    if (!("shareToken" in created)) return;

    const [row] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, created.shareToken))
      .limit(1);

    const result = await revokeLibretaShareForUser(userId, row.id);
    expect(result).toEqual({ ok: true, shareTokenRowId: row.id });

    const [updated] = await db
      .select()
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.id, row.id))
      .limit(1);
    expect(updated.revokedAt).not.toBeNull();
    expect(updated.revokedByUserId).toBe(userId);
  });

  it("§2.3 scope: a current pet-owner who didn't create the share CANNOT revoke it", async () => {
    // Review 2026-05-19 §2.3 closed the D6 fallback because it let a new
    // owner (post-transfer, or a co-caretaker) silently break a previous
    // owner's share — destroying the medical-history continuity that
    // libreta shares depend on. Only the creator can revoke; admins are
    // covered by the separate admin-bypass test below.

    await revokeAllShares();

    // Temporarily give userId2 an ownership so it counts as current owner.
    const [tempOwnership] = await db
      .insert(ownerships)
      .values({
        petId,
        ownerUserId: userId2,
        role: "caretaker",
        startedAt: new Date(),
      })
      .returning();

    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "§2.3 scope test",
    });
    expect(created).toHaveProperty("shareToken");
    if (!("shareToken" in created)) return;

    const [row] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, created.shareToken))
      .limit(1);

    // userId2 is NOT the creator but IS a current owner-role user.
    // Old behavior: allowed. New behavior (§2.3): rejected.
    const result = await revokeLibretaShareForUser(userId2, row.id);
    expect(result).toEqual({ error: "Sin permisos para revocar este compartido." });

    // The share is still active.
    const [unchanged] = await db
      .select({ revokedAt: libretaShareTokens.revokedAt })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.id, row.id))
      .limit(1);
    expect(unchanged.revokedAt).toBeNull();

    // Cleanup the temp ownership.
    await db.delete(ownerships).where(eq(ownerships.id, tempOwnership.id));
  });

  it("§2.3 admin bypass: a platform admin who didn't create the share CAN revoke it", async () => {
    await revokeAllShares();

    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "§2.3 admin bypass test",
    });
    expect(created).toHaveProperty("shareToken");
    if (!("shareToken" in created)) return;

    const [row] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, created.shareToken))
      .limit(1);

    // Promote userId2 to admin for the duration of this test.
    const [originalRole] = await db
      .select({ role: profiles.role })
      .from(profiles)
      .where(eq(profiles.id, userId2))
      .limit(1);
    await db.update(profiles).set({ role: "admin" }).where(eq(profiles.id, userId2));

    try {
      const result = await revokeLibretaShareForUser(userId2, row.id);
      expect(result).toEqual({ ok: true, shareTokenRowId: row.id });

      const [updated] = await db
        .select({
          revokedAt: libretaShareTokens.revokedAt,
          revokedByUserId: libretaShareTokens.revokedByUserId,
        })
        .from(libretaShareTokens)
        .where(eq(libretaShareTokens.id, row.id))
        .limit(1);
      expect(updated.revokedAt).not.toBeNull();
      expect(updated.revokedByUserId).toBe(userId2);
    } finally {
      // Restore original role to avoid cross-test pollution.
      await db
        .update(profiles)
        .set({ role: originalRole?.role ?? "owner" })
        .where(eq(profiles.id, userId2));
    }
  });
});

describe("logLibretaShareViewForToken", () => {
  // Since migration 0167 (TEL-1, PO 2026-08-04) this use case writes ONE thing:
  // the cached counters on the token row. The per-view share_telemetry table it
  // used to insert into is gone, and with it the viewer's user agent.
  it("happy path: increments view_count_cached, sets last_viewed_at_cached", async () => {
    await revokeAllShares();
    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "View test",
    });
    expect(created).toHaveProperty("shareToken");
    if (!("shareToken" in created)) return;
    const { shareToken } = created;

    await logLibretaShareViewForToken({ shareToken });

    const [row] = await db
      .select()
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, shareToken))
      .limit(1);
    expect(row.viewCountCached).toBe(1);
    expect(row.lastViewedAtCached).not.toBeNull();
  });

  it("revoked share: no counter increment", async () => {
    await revokeAllShares();
    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Revoked view test",
    });
    expect(created).toHaveProperty("shareToken");
    if (!("shareToken" in created)) return;
    const { shareToken } = created;

    // Revoke the share first.
    const [row] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, shareToken))
      .limit(1);
    await revokeLibretaShareForUser(userId, row.id);

    await logLibretaShareViewForToken({ shareToken });

    const [updated] = await db
      .select()
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.id, row.id))
      .limit(1);
    expect(updated.viewCountCached).toBe(0);
  });

  it("expired share: no counter increment", async () => {
    await revokeAllShares();
    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Expired view test",
    });
    expect(created).toHaveProperty("shareToken");
    if (!("shareToken" in created)) return;
    const { shareToken } = created;

    // Force expiry to the past.
    const [row] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, shareToken))
      .limit(1);
    await db
      .update(libretaShareTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(libretaShareTokens.id, row.id));

    await logLibretaShareViewForToken({ shareToken });

    const [updated] = await db
      .select()
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.id, row.id))
      .limit(1);
    expect(updated.viewCountCached).toBe(0);
  });
});

// ============================================================================
// getActiveLibretaShares — extracted from getActiveLibretaSharesAction
// (strangler line-budget cleanup). Auth/ownership guard is enforced by the
// caller (requirePetAccess); this use-case only filters by petId.
// ============================================================================

describe("getActiveLibretaShares", () => {
  it("returns only non-revoked shares for the given pet", async () => {
    await revokeAllShares();

    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Active share",
    });
    expect(created).toHaveProperty("shareToken");

    const revoked = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "To be revoked",
    });
    expect(revoked).toHaveProperty("shareToken");
    if (!("shareToken" in revoked)) return;
    const [revokedRow] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, revoked.shareToken))
      .limit(1);
    await revokeLibretaShareForUser(userId, revokedRow.id);

    const shares = await getActiveLibretaShares(petId);
    expect(shares.length).toBe(1);
    expect(shares[0].label).toBe("Active share");
  });

  it("returns an empty array when the pet has no active shares", async () => {
    await revokeAllShares();
    const shares = await getActiveLibretaShares(petId);
    expect(shares).toEqual([]);
  });
});

// ============================================================================
// findPetPublicTokenForShare — extracted from revokeLibretaShareAction
// (strangler line-budget cleanup). Resolves the pet's publicToken so the
// action can revalidate the pet page after a successful revoke.
// ============================================================================

describe("findPetPublicTokenForShare", () => {
  it("resolves the owning pet's publicToken for a valid share row", async () => {
    await revokeAllShares();
    const created = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Token lookup",
    });
    expect(created).toHaveProperty("shareToken");
    if (!("shareToken" in created)) return;

    const [row] = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.shareToken, created.shareToken))
      .limit(1);

    const publicToken = await findPetPublicTokenForShare(row.id);
    expect(publicToken).toBe(PET_TOKEN);
  });

  it("returns null for a non-existent share row id", async () => {
    const publicToken = await findPetPublicTokenForShare("00000000-0000-0000-0000-000000000000");
    expect(publicToken).toBeNull();
  });
});

describe("createLibretaShareForUser — idempotency guard (projection-writes audit §6)", () => {
  it("double-submit (same label + expiry) reuses the active token instead of minting a second one", async () => {
    await revokeAllShares();

    const input = {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Doble click",
    };

    const first = await createLibretaShareForUser(userId, input);
    expect(first).toHaveProperty("shareToken");
    if (!("shareToken" in first)) return;

    const second = await createLibretaShareForUser(userId, input);
    expect(second).toHaveProperty("shareToken");
    if (!("shareToken" in second)) return;

    // Same token returned — no second row minted.
    expect(second.shareToken).toBe(first.shareToken);

    const rows = await db
      .select({ id: libretaShareTokens.id })
      .from(libretaShareTokens)
      .where(and(eq(libretaShareTokens.petId, petId), isNull(libretaShareTokens.revokedAt)));
    expect(rows.length).toBe(1);
  });

  it("permanent shares (expiresInDays=null) also dedupe on double-submit", async () => {
    await revokeAllShares();

    const input = { petPublicToken: PET_TOKEN, expiresInDays: null, label: null };
    const first = await createLibretaShareForUser(userId, input);
    const second = await createLibretaShareForUser(userId, input);
    if (!("shareToken" in first) || !("shareToken" in second)) {
      throw new Error("Expected shareToken");
    }
    expect(second.shareToken).toBe(first.shareToken);
  });

  it("a deliberate second share with a different label still creates a fresh token", async () => {
    await revokeAllShares();

    const first = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Veterinaria",
    });
    const second = await createLibretaShareForUser(userId, {
      petPublicToken: PET_TOKEN,
      expiresInDays: 30,
      label: "Guardería",
    });
    if (!("shareToken" in first) || !("shareToken" in second)) {
      throw new Error("Expected shareToken");
    }
    expect(second.shareToken).not.toBe(first.shareToken);
  });
});
