// Integration tests for Slice 3a: user self-service profile update actions.
//
// Pattern mirrors admin-institutional.test.ts:
//   - beforeAll seeds ephemeral user via supabase admin SDK
//   - afterAll deletes them with app.allow_audit_mutation GUC
//   - Each test calls the inner *ForUser writer directly (no Next.js runtime)
//
// Strict TDD scope (server actions only):
//   - updateProfileForUser: happy path, validation rejections, unauthorized
//   - uploadAvatarForUser: happy path (storage stub), validation rejections

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// updateEmergencyContactsAction (pet-document-redesign ADR-13, Phase 5) calls
// requireUserOrRedirect() — mocked here so the narrow-write test below can
// drive it directly against the real seeded actor without a Next.js request
// context. Doesn't affect the *ForUser writers above, which are called
// directly with an explicit userId (never go through this guard).
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(),
}));

// revalidatePath needs a Next.js request/static-generation context that
// doesn't exist under vitest — mocked to a no-op, same reasoning as the
// auth-guards mock above.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { updateEmergencyContactsAction } from "@/app/actions/profile";
import { auditLog, db, notifications, ownerships, pets, profiles } from "@/db";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { MAX_IMAGE_BYTES } from "@/lib/media/validate";
import { updateProfileForUser } from "@/src/modules/pets/application/profile/update-profile";
import {
  avatarObjectKey,
  uploadAvatarForUser,
} from "@/src/modules/pets/application/profile/upload-avatar";
import { setAuditMutationGucs } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const ACTOR_EMAIL = "profile-slice3a-actor@dim-test.local";
let actorUserId: string;

async function deleteTestUser(email: string) {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);

  const allIds = new Set<string>();
  if (found) allIds.add(found.id);

  for (const uid of allIds) {
    await db.transaction(async (tx) => {
      await setAuditMutationGucs(tx);
      await tx.delete(auditLog).where(eq(auditLog.actorUserId, uid));
      await tx.delete(auditLog).where(eq(auditLog.targetUserId, uid));
    });
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }

  if (found) await adminSdk.auth.admin.deleteUser(found.id);
}

async function createUserOrThrow(email: string): Promise<string> {
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "ProfileSlice3a_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser(${email}): ${r.error?.message}`);
  return r.data.user.id;
}

beforeAll(async () => {
  await deleteTestUser(ACTOR_EMAIL);
  actorUserId = await createUserOrThrow(ACTOR_EMAIL);
  // trigger auto-creates profile with role='owner', displayName from email prefix
  await db
    .update(profiles)
    .set({ displayName: "Prop Test User", phone: null })
    .where(eq(profiles.id, actorUserId));
});

afterAll(async () => {
  await deleteTestUser(ACTOR_EMAIL);
});

// ============================================================================
// updateProfileForUser — happy path
// ============================================================================

describe("updateProfileForUser — happy path", () => {
  it("updates displayName and phone, writes audit_log with before-values", async () => {
    // Capture before state
    const [before] = await db
      .select({ displayName: profiles.displayName, phone: profiles.phone })
      .from(profiles)
      .where(eq(profiles.id, actorUserId))
      .limit(1);

    const result = await updateProfileForUser(actorUserId, {
      displayName: "Ignacio Test",
      phone: "+54 9 11 1234-5678",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;

    expect(result.ok).toBe(true);

    // Profile updated
    const [after] = await db
      .select({ displayName: profiles.displayName, phone: profiles.phone })
      .from(profiles)
      .where(eq(profiles.id, actorUserId))
      .limit(1);

    expect(after.displayName).toBe("Ignacio Test");
    expect(after.phone).toBe("+54 9 11 1234-5678");

    // Audit log written
    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorUserId, actorUserId), eq(auditLog.action, "profile_self_updated")),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(logRow).toBeDefined();
    expect(logRow.action).toBe("profile_self_updated");
    const payload = logRow.payload as Record<string, unknown>;
    expect(payload.changed_fields).toContain("displayName");
    expect((payload.before_values as Record<string, unknown>).displayName).toBe(before.displayName);
  });

  it("updates displayName only (no phone provided), phone preserved", async () => {
    await db
      .update(profiles)
      .set({ displayName: "Before Name", phone: "+54 9 11 9999-0000" })
      .where(eq(profiles.id, actorUserId));

    const result = await updateProfileForUser(actorUserId, {
      displayName: "After Name",
      phone: undefined,
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;

    const [row] = await db
      .select({ displayName: profiles.displayName, phone: profiles.phone })
      .from(profiles)
      .where(eq(profiles.id, actorUserId))
      .limit(1);

    expect(row.displayName).toBe("After Name");
    // phone not in input → not changed
    expect(row.phone).toBe("+54 9 11 9999-0000");
  });

  it("clears phone when empty string provided", async () => {
    await db
      .update(profiles)
      .set({ phone: "+54 9 11 1111-2222" })
      .where(eq(profiles.id, actorUserId));

    const result = await updateProfileForUser(actorUserId, {
      displayName: "Name Clear Phone",
      phone: "",
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;

    const [row] = await db
      .select({ phone: profiles.phone })
      .from(profiles)
      .where(eq(profiles.id, actorUserId))
      .limit(1);

    expect(row.phone).toBeNull();
  });
});

// ============================================================================
// updateProfileForUser — validation rejections
// ============================================================================

describe("updateProfileForUser — validation rejections", () => {
  it("rejects displayName shorter than 2 chars", async () => {
    const result = await updateProfileForUser(actorUserId, { displayName: "A" });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/VALIDATION_ERROR/);
  });

  it("rejects displayName longer than 80 chars", async () => {
    const result = await updateProfileForUser(actorUserId, {
      displayName: "A".repeat(81),
    });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/VALIDATION_ERROR/);
  });

  it("rejects missing displayName", async () => {
    const result = await updateProfileForUser(actorUserId, {
      displayName: "",
    });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/VALIDATION_ERROR/);
  });

  // A2-alta-asentar-09. The length floor is not a shape rule: two zero-width
  // spaces are two characters, survive `trim()` and clear `min(2)`, so this door
  // saved a display name that renders as NOTHING on the person's own credential,
  // on the public /p page and in /gob/historial — while `isIdentityPending`
  // reports the identity complete. Signup step 2 refused exactly this string and
  // this door, onto the SAME column, did not.
  it("rejects a displayName made only of invisible characters", async () => {
    const result = await updateProfileForUser(actorUserId, { displayName: "​​" });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/VALIDATION_ERROR/);
  });

  it("rejects a displayName with no letter in it", async () => {
    const result = await updateProfileForUser(actorUserId, { displayName: "12345" });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/VALIDATION_ERROR/);
  });

  // NON-VACUITY: the shape rule must not be refusing real Argentine names.
  it.each(["María José", "Ñandú-López", "O'Connor", "Ana 2"])(
    "still accepts %s as a displayName",
    async (displayName) => {
      const result = await updateProfileForUser(actorUserId, { displayName });
      expect(result).toEqual({ ok: true });
    },
  );

  it("accepts any non-empty phone format (AR validation is now a client-side soft warning)", async () => {
    // Phone format is no longer rejected server-side. The client surfaces a
    // soft warning via `lib/ar-phone.ts` for non-AR-looking values, but the
    // value saves regardless.
    const result = await updateProfileForUser(actorUserId, {
      displayName: "Valid Name",
      phone: "123-abc-xyz",
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts empty string phone (clears the value)", async () => {
    const result = await updateProfileForUser(actorUserId, {
      displayName: "Valid Name",
      phone: "",
    });
    expect(result).not.toHaveProperty("error");
  });
});

// ============================================================================
// updateEmergencyContactsAction — PET-LEVEL override write (owner-ia-redesign
// P2, PO decision 2). Writes the 4 pet.preferred_vet_* / emergency_contact_*
// columns (migration 0145), scoped to a pet the caller currently OWNS. Must
// never touch the account-level profiles columns.
// ============================================================================

const EMERGENCY_PET_TOKEN = "DIM-TEST-EMG1";

describe("updateEmergencyContactsAction — pet-level override write", () => {
  beforeAll(async () => {
    // Seed a pet owned by the actor so the ownership-scoped write can target it.
    const [pet] = await db
      .insert(pets)
      .values({ publicToken: EMERGENCY_PET_TOKEN, species: "dog", name: "Test Emg Pet" })
      .returning({ id: pets.id });
    await db.insert(ownerships).values({ petId: pet.id, ownerUserId: actorUserId, role: "owner" });
  });

  afterAll(async () => {
    // Ownerships cascade on pet delete; profile deletion (top-level afterAll)
    // does not remove the pet row, so drop it explicitly here.
    await db.delete(pets).where(eq(pets.publicToken, EMERGENCY_PET_TOKEN));
  });

  it("writes the 4 emergency fields onto the PET, leaving the account profile untouched", async () => {
    vi.mocked(requireUserOrRedirect).mockResolvedValue({
      user: { id: actorUserId },
    } as never);

    // Account-level columns are a distinct default surface — must stay null.
    await db
      .update(profiles)
      .set({
        displayName: "Untouched Display Name",
        preferredVetName: null,
        preferredVetPhone: null,
        emergencyContactName: null,
        emergencyContactPhone: null,
      })
      .where(eq(profiles.id, actorUserId));

    const result = await updateEmergencyContactsAction(EMERGENCY_PET_TOKEN, {
      preferredVetName: "Dra. Pérez",
      preferredVetPhone: "+54 9 11 1111-1111",
      emergencyContactName: "Lucía F.",
      emergencyContactPhone: "+54 9 11 2222-2222",
    });

    expect(result).not.toHaveProperty("error");

    const [petRow] = await db
      .select({
        preferredVetName: pets.preferredVetName,
        preferredVetPhone: pets.preferredVetPhone,
        emergencyContactName: pets.emergencyContactName,
        emergencyContactPhone: pets.emergencyContactPhone,
      })
      .from(pets)
      .where(eq(pets.publicToken, EMERGENCY_PET_TOKEN))
      .limit(1);

    expect(petRow.preferredVetName).toBe("Dra. Pérez");
    expect(petRow.preferredVetPhone).toBe("+54 9 11 1111-1111");
    expect(petRow.emergencyContactName).toBe("Lucía F.");
    expect(petRow.emergencyContactPhone).toBe("+54 9 11 2222-2222");

    // The account-level default is a separate surface and stays untouched.
    const [profileRow] = await db
      .select({
        displayName: profiles.displayName,
        preferredVetName: profiles.preferredVetName,
      })
      .from(profiles)
      .where(eq(profiles.id, actorUserId))
      .limit(1);
    expect(profileRow.displayName).toBe("Untouched Display Name");
    expect(profileRow.preferredVetName).toBeNull();
  });

  it("clears an override to null when a field is submitted empty (account fallback on read)", async () => {
    vi.mocked(requireUserOrRedirect).mockResolvedValue({
      user: { id: actorUserId },
    } as never);

    const result = await updateEmergencyContactsAction(EMERGENCY_PET_TOKEN, {
      preferredVetName: "",
      preferredVetPhone: "",
      emergencyContactName: "",
      emergencyContactPhone: "",
    });

    expect(result).not.toHaveProperty("error");

    const [petRow] = await db
      .select({ preferredVetPhone: pets.preferredVetPhone })
      .from(pets)
      .where(eq(pets.publicToken, EMERGENCY_PET_TOKEN))
      .limit(1);
    expect(petRow.preferredVetPhone).toBeNull();
  });

  it("returns NOT_FOUND when the pet is not owned by the caller", async () => {
    vi.mocked(requireUserOrRedirect).mockResolvedValue({
      user: { id: "00000000-0000-0000-0000-000000000099" },
    } as never);

    const result = await updateEmergencyContactsAction(EMERGENCY_PET_TOKEN, {
      preferredVetName: "Should not save",
    });

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/NOT_FOUND/);
  });
});

// ============================================================================
// updateProfileForUser — unauthorized
// ============================================================================

describe("updateProfileForUser — unauthorized", () => {
  it("rejects when userId does not exist in profiles", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const result = await updateProfileForUser(fakeId, {
      displayName: "Hacker",
    });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/NOT_FOUND/);
  });
});

// ============================================================================
// uploadAvatarForUser — validation rejections (no real storage needed)
// ============================================================================

describe("uploadAvatarForUser — validation: wrong mime type", () => {
  it("rejects non-image mime types", async () => {
    const fakeFile = new Blob(["<svg/>"], { type: "image/svg+xml" });
    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: fakeFile,
      fileName: "test.svg",
      mimeType: "image/svg+xml",
      fileSize: fakeFile.size,
    });
    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/VALIDATION_ERROR/);
  });
});

// ============================================================================
// uploadAvatarForUser — the bytes decide (audit 2026-09-fresh, finding A07-2)
// ============================================================================
//
// The defect these pin: the ceiling was enforced against `input.fileSize`, a
// number the caller sends beside the blob. Nothing compared the two, so a
// spoofed `fileSize: 1` carried an arbitrarily large body straight into a
// SERVICE-ROLE upload. `mimeType` was trusted the same way.
//
// THE FIXTURE SIZES BELOW ARE DOMAIN NUMBERS, NOT `MAX_IMAGE_BYTES + 1`. A test
// whose input is derived from the constant it is checking cannot fail when that
// constant is mutated — it moves with it. 6 MiB is a plain phone photo that is
// bigger than a profile picture has any business being; 12 bytes is a header.
//
// `_storageStub` is deliberately NOT passed to the rejection cases: they must
// fail before any upload function is chosen, and a stub would hide it if the
// order ever inverted.

/** 6 MiB — a full-resolution phone photo. Over any sane avatar ceiling. */
const OVERSIZED_PHOTO_BYTES = 6 * 1024 * 1024;

/** Real JPEG magic bytes (FF D8 FF) plus a JFIF header. */
const REAL_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

/**
 * A JPEG sharp can actually DECODE. Since 2026-09-18 (PO D4) every avatar is
 * re-encoded to drop its EXIF, and a 12-byte header is refused as unreadable —
 * fail closed. The header-only REAL_JPEG above still serves the cases that must
 * be refused before any decode (size, type).
 */
let DECODABLE_JPEG: Uint8Array<ArrayBuffer>;
beforeAll(async () => {
  DECODABLE_JPEG = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3a7d44" } })
      .jpeg()
      .toBuffer(),
  );
});

describe("uploadAvatarForUser — validates the blob, not the caller's claims", () => {
  it("refuses an oversized blob with a Spanish sentence that says what to do", async () => {
    const bigJpeg = new Uint8Array(OVERSIZED_PHOTO_BYTES);
    bigJpeg.set(REAL_JPEG, 0);
    const largeBlob = new Blob([bigJpeg], { type: "image/jpeg" });

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: largeBlob,
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      fileSize: largeBlob.size, // honest caller
    });

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toContain("VALIDATION_ERROR");
    expect(result.error).toContain("La imagen no puede superar los 5 MB");
    expect(result.error).toContain("Probá con una foto más liviana");
  });

  // THE DEFECT ITSELF. Identical body to the test above; the only difference is
  // that the caller lies about the size. Before the fix this one returned ok.
  it("refuses a large blob even when fileSize claims it is one byte", async () => {
    const bigJpeg = new Uint8Array(OVERSIZED_PHOTO_BYTES);
    bigJpeg.set(REAL_JPEG, 0);
    const largeBlob = new Blob([bigJpeg], { type: "image/jpeg" });

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: largeBlob,
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      fileSize: 1, // the lie
    });

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toContain("La imagen no puede superar los 5 MB");
  });

  // The magic-byte half. A PDF is not made an image by saying so.
  it("refuses a non-image blob that declares an allowed image content type", async () => {
    const notAnImage = new Blob([new TextEncoder().encode("%PDF-1.7 not a raster at all")], {
      type: "image/jpeg",
    });

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: notAnImage,
      fileName: "foto.jpg",
      mimeType: "image/jpeg", // the lie
      fileSize: notAnImage.size,
    });

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toContain("VALIDATION_ERROR");
    expect(result.error).toContain("El archivo debe ser una imagen JPG, PNG o WebP");
  });

  // The other side of the same guard: a real image at a normal size still gets
  // through.
  it("accepts a real JPEG at a normal size", async () => {
    const smallFile = new Blob([DECODABLE_JPEG], { type: "image/jpeg" });

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: smallFile,
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      fileSize: smallFile.size,
      _storageStub: async () => ({
        storagePath: `${actorUserId}/1.jpg`,
        publicUrl: `https://example.com/storage/avatars/${actorUserId}/1.jpg`,
      }),
    });

    expect(result).not.toHaveProperty("error");
  });

  // PROPAGATION, and the fixture is built so it can only pass one way. The
  // caller declares PNG over JPEG bytes: a mutant that forwards `input.mimeType`
  // sends "image/png" and a correct implementation sends "image/jpeg", so the
  // assertion tells them apart. The first version of this test declared JPEG
  // over JPEG bytes — the two answers were identical and it could not fail.
  //
  // This disagreement is also the executable form of a decision: a mismatch is
  // NOT an error. `File.type` is filled in by the OS from the extension, so a
  // JPEG saved as `foto.png` produces exactly this input with no malice, and
  // the upload must succeed with the bytes' own type.
  it("forwards the DETECTED mime to storage when the caller declares another", async () => {
    const jpegBytes = new Blob([DECODABLE_JPEG], { type: "image/png" });
    const seen: string[] = [];

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: jpegBytes,
      fileName: "foto.png",
      mimeType: "image/png", // the OS's guess, and it is wrong
      fileSize: jpegBytes.size,
      _storageStub: async ({ mimeType }) => {
        seen.push(mimeType);
        return {
          storagePath: `${actorUserId}/1.jpg`,
          publicUrl: `https://example.com/storage/avatars/${actorUserId}/1.jpg`,
        };
      },
    });

    expect(result).not.toHaveProperty("error");
    expect(seen).toEqual(["image/jpeg"]);
  });
});

// PO D4 (2026-09-18): "no guardar datos de ciudadanos que no nos dieron
// concientemente". The avatar was stored byte-for-byte, so a selfie kept its
// EXIF GPS in the bucket. The fixture's own GPS block is asserted first, or "the
// stored file has no EXIF" would pass on a fixture that never had any.
describe("uploadAvatarForUser — the camera's metadata never reaches storage", () => {
  // Tag 0x8825 is the IFD0 pointer to the GPS IFD. sharp writes little-endian.
  const GPS_IFD_POINTER_LE = Buffer.from([0x25, 0x88]);
  let selfieWithGps: Buffer;

  beforeAll(async () => {
    selfieWithGps = await sharp({
      create: { width: 16, height: 12, channels: 3, background: "#7d3a44" },
    })
      .jpeg()
      .withExif({
        IFD0: { Make: "Apple", Model: "iPhone" },
        IFD3: {
          GPSLatitudeRef: "S",
          GPSLatitude: "34/1 36/1 0/1",
          GPSLongitudeRef: "W",
          GPSLongitude: "58/1 22/1 0/1",
        },
      })
      .toBuffer();
  });

  it("the fixture really carries a GPS block", async () => {
    const meta = await sharp(selfieWithGps).metadata();
    expect(meta.exif?.includes(GPS_IFD_POINTER_LE)).toBe(true);
  });

  it("stores the selfie WITHOUT its EXIF, still the same picture", async () => {
    const stored: ArrayBuffer[] = [];
    const blob = new Blob([new Uint8Array(selfieWithGps)], { type: "image/jpeg" });

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: blob,
      fileName: "selfie.jpg",
      mimeType: "image/jpeg",
      _storageStub: async ({ body }) => {
        stored.push(body);
        return { storagePath: `${actorUserId}/2.jpg` };
      },
    });

    expect(result).not.toHaveProperty("error");
    expect(stored).toHaveLength(1);
    const meta = await sharp(Buffer.from(stored[0])).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta).toMatchObject({ format: "jpeg", width: 16, height: 12 });
  });

  it("REFUSES what sharp cannot read — never the original bytes (fail closed)", async () => {
    // A JPEG signature with nothing decodable behind it: it passes the magic
    // bytes and dies in the re-encode.
    let uploaded = false;
    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: new Blob([REAL_JPEG], { type: "image/jpeg" }),
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      _storageStub: async () => {
        uploaded = true;
        return { storagePath: `${actorUserId}/3.jpg` };
      },
    });

    expect(result).toEqual({
      error:
        "VALIDATION_ERROR: No pudimos quitarle a la foto los datos que guarda la cámara, como el lugar donde se sacó, así que no guardamos nada. Probá de nuevo con una captura de pantalla de la foto.",
    });
    expect(uploaded).toBe(false);
  });
});

// The object key, tested through the function that actually builds it.
//
// WHY IT IS A SEPARATE FUNCTION AND A SEPARATE TEST: while the derivation was
// inline in `defaultStorageUpload`, no test could see it — every test above
// drives the writer through `_storageStub`, which computes no key at all, so
// restoring `fileName.split(".").pop()` left the entire suite green. The
// extension must come off the VALIDATED mime; a client filename in an object
// key is how "x.jpg/../../evil" gets into a storage path.
describe("avatarObjectKey", () => {
  const USER = "11111111-2222-3333-4444-555555555555";

  it("takes the extension from the mime, one per raster type", () => {
    expect(avatarObjectKey(USER, "image/jpeg")).toMatch(/^11111111-.*\/\d+\.jpg$/);
    expect(avatarObjectKey(USER, "image/png")).toMatch(/^11111111-.*\/\d+\.png$/);
    expect(avatarObjectKey(USER, "image/webp")).toMatch(/^11111111-.*\/\d+\.webp$/);
  });

  it("puts the object under the user's own prefix and nothing else", () => {
    const key = avatarObjectKey(USER, "image/jpeg");
    expect(key.startsWith(`${USER}/`)).toBe(true);
    expect(key.split("/")).toHaveLength(2);
  });
});

// ============================================================================
// The avatars bucket enforces the SAME bounds at the object store (0218)
// ============================================================================
//
// The app check above only runs when our code runs. Migration 0171 grants
// authenticated callers `insert`/`update` on `storage.objects` for their own
// `avatars` objects, so the Storage API is reachable with a caller's own token
// and never passes through `uploadAvatarForUser`. The bucket is what bounds
// that path.
//
// This reads the LIVE bucket row, so it fails if the migration was never
// applied to the environment under test — the failure mode a test that only
// grepped the .sql file could not see. And it anchors `MAX_IMAGE_BYTES` to an
// EXTERNAL requirement (what the object store actually enforces) rather than to
// itself: mutate the constant and the two layers disagree, which is exactly the
// condition worth failing on.

// ============================================================================
// The client-side hint may not drift away from the ceiling
// ============================================================================
//
// `EditProfileForm.tsx` restates the number as a literal on purpose — it is a
// client component and `lib/media/validate.ts` dynamically imports sharp — but
// a restatement with no fence is a restatement that will disagree. The repo
// already settled this: `packages/contract/src/input/pet-photo.ts:64-68`
// restates for the same reason and says the rule out loud — "The two lists are
// kept equal by __tests__/pet-photo-upload.test.ts, which asserts them against
// each other — not by anyone noticing."
//
// Without this, dropping MAX_IMAGE_BYTES to 3 MiB leaves the form advertising 5,
// waving a 4 MiB photo through, and the person is refused by the server for a
// file the interface had just approved.

const AVATAR_FORM = "app/(app)/cuenta/editar/EditProfileForm.tsx";

describe("avatar size ceiling — the form agrees with the server", () => {
  const megabytes = MAX_IMAGE_BYTES / (1024 * 1024);
  const src = readFileSync(AVATAR_FORM, "utf8");

  it("guards on the same byte count", () => {
    const guard = src.match(/file\.size > (\d+) \* 1024 \* 1024/);
    expect(guard, `no client-side size guard found in ${AVATAR_FORM}`).not.toBeNull();
    expect(Number(guard?.[1]) * 1024 * 1024).toBe(MAX_IMAGE_BYTES);
  });

  it("tells the person the same number, in both places it says it", () => {
    expect(src).toContain(`máx. ${megabytes} MB`);
    expect(src).toContain(`no puede superar los ${megabytes} MB`);
  });
});

describe("avatars storage bucket", () => {
  it("declares a size ceiling and a raster-only mime allowlist", async () => {
    const rows = (await db.execute(sql`
      select file_size_limit::bigint as file_size_limit, allowed_mime_types
      from storage.buckets
      where id = 'avatars'
    `)) as Array<{ file_size_limit: string | number | null; allowed_mime_types: string[] | null }>;

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].file_size_limit)).toBeGreaterThan(0);
    expect([...(rows[0].allowed_mime_types ?? [])].sort()).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
  });

  it("agrees with the ceiling the use-case refuses on", async () => {
    const rows = (await db.execute(sql`
      select file_size_limit::bigint as file_size_limit
      from storage.buckets
      where id = 'avatars'
    `)) as Array<{ file_size_limit: string | number | null }>;

    expect(Number(rows[0].file_size_limit)).toBe(MAX_IMAGE_BYTES);
  });
});

describe("uploadAvatarForUser — happy path (stub storage)", () => {
  it("updates avatarUrl and writes audit_log when storage succeeds", async () => {
    // Reset profile
    await db.update(profiles).set({ avatarStoragePath: null }).where(eq(profiles.id, actorUserId));

    // Provide a valid small JPEG blob (minimal valid JPEG header bytes)
    const smallFile = new Blob([DECODABLE_JPEG], { type: "image/jpeg" });

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: smallFile,
      fileName: "avatar.jpg",
      mimeType: "image/jpeg",
      fileSize: smallFile.size,
      _storageStub: async () => ({ storagePath: `${actorUserId}/1700000000000.jpg` }),
    });

    // Should succeed
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;

    expect(result.ok).toBe(true);
    // THE PATH, NOT A URL — the whole point of the 0219 fix. A value carrying
    // a scheme is the old fabricated `/object/sign/avatars/…` string, which was
    // neither renderable nor joinable.
    expect(result.storagePath).toBe(`${actorUserId}/1700000000000.jpg`);
    expect(result.storagePath).not.toContain("://");

    // The column stores exactly that path.
    const [row] = await db
      .select({ avatarStoragePath: profiles.avatarStoragePath })
      .from(profiles)
      .where(eq(profiles.id, actorUserId))
      .limit(1);

    expect(row.avatarStoragePath).toBe(`${actorUserId}/1700000000000.jpg`);

    // Audit log written
    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.actorUserId, actorUserId), eq(auditLog.action, "profile_avatar_updated")),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(logRow).toBeDefined();
    expect(logRow.action).toBe("profile_avatar_updated");
  });

  it("returns error and logs profile_avatar_upload_failed when storage stub throws", async () => {
    const smallFile = new Blob([DECODABLE_JPEG], { type: "image/png" });

    const result = await uploadAvatarForUser(actorUserId, {
      fileBlob: smallFile,
      fileName: "avatar.png",
      mimeType: "image/png",
      fileSize: smallFile.size,
      _storageStub: async () => {
        throw new Error("BUCKET_NOT_FOUND");
      },
    });

    expect(result).toHaveProperty("error");
    if (!("error" in result)) return;
    expect(result.error).toMatch(/STORAGE_FAILED/);

    // profile_avatar_upload_failed logged
    const [logRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, actorUserId),
          eq(auditLog.action, "profile_avatar_upload_failed"),
        ),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);

    expect(logRow).toBeDefined();
  });
});
