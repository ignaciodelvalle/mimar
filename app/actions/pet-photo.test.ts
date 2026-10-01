// `updatePetPhotoAction` — the web's photo door, the app's door's twin
// (owner-pet-actions, PO rule "web = app").
//
// WHY IT EXISTS. The app's "Foto" row opens a photo screen of its own for ANY
// holder (`POST /api/v1/pets/{token}/photo`): `lib/domain/titular-only.ts`
// lists photos among what a caretaker MAY do. The web's only photo field lived
// inside "Editar datos", whose writer is titular-gated for the OTHER fields in
// that form — so a caretaker had the door on the phone and a grey row on the
// web. This action is the web's door for the same act, under the same rule.
//
// WHAT IT HAS TO PROVE
//   1. THE APP DOOR'S AUTHORIZATION, not the edit form's: any person-path
//      holder — a caretaker included — and, on the organization path, only a
//      membership holding `event.write`. Refusals upload nothing.
//   2. THE UPLOAD IS THE WEB'S OWN PRIMITIVE (`uploadAttachmentIfPresent`: magic
//      bytes, re-encode, fail closed), and its refusal sentence reaches the form.
//   3. THE ROW AND THE POINTER ARE THE APP DOOR'S OWN WRITER (`recordPetPhoto`),
//      and an object whose row did not land is taken back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePetAccess: vi.fn(),
  uploadAttachmentIfPresent: vi.fn(),
  recordPetPhoto: vi.fn(),
  getGrantedCapabilities: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/infra/pet-access", () => ({ requirePetAccess: mocks.requirePetAccess }));
vi.mock("@/lib/infra/uploads", () => ({
  uploadAttachmentIfPresent: mocks.uploadAttachmentIfPresent,
}));
vi.mock("@/lib/infra/pet-photo-upload", () => ({
  PET_PHOTO_BUCKET: "pet-photos",
  recordPetPhoto: mocks.recordPetPhoto,
}));
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  getGrantedCapabilities: mocks.getGrantedCapabilities,
}));

import { updatePetPhotoAction } from "./pet-photo";

const TOKEN = "DIM-PAMP-0001";
const PET_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const UPLOADED = "55555555-5555-4555-8555-555555555555.jpg";
const IDLE = { error: null } as const;

const supabase = {
  storage: { from: (bucket: string) => ({ remove: (p: string[]) => mocks.remove(bucket, p) }) },
};

/** A granted access, as the guard answers for the given path and holder role. */
function granted(over: { accessPath?: "owner" | "org"; holderRole?: string | null } = {}) {
  const accessPath = over.accessPath ?? "owner";
  return {
    ok: true,
    supabase,
    user: { id: USER_ID },
    pet: { id: PET_ID, publicToken: TOKEN, status: "active" },
    accessPath,
    organization: accessPath === "org" ? { id: "org-1" } : null,
    membership: accessPath === "org" ? { id: "mem-1" } : null,
    holderRole: accessPath === "org" ? null : (over.holderRole ?? "owner"),
    eventAuthorship: { authorRole: "owner", authorOrganizationId: null, authorVerified: false },
    error: null,
  };
}

function withPhoto(): FormData {
  const form = new FormData();
  form.append("photo", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "pampa.jpg"));
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePetAccess.mockResolvedValue(granted());
  mocks.uploadAttachmentIfPresent.mockResolvedValue({
    uploadedPath: UPLOADED,
    mimeType: "image/jpeg",
    size: 2048,
    error: null,
  });
  mocks.recordPetPhoto.mockResolvedValue({ ok: true, replacedPrevious: false });
  mocks.getGrantedCapabilities.mockResolvedValue(new Set());
});

describe("updatePetPhotoAction — who may change the photo", () => {
  it("takes a CARETAKER's photo: the act the role exists for, as on the app", async () => {
    mocks.requirePetAccess.mockResolvedValue(granted({ holderRole: "caretaker" }));
    const state = await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(state).toEqual({ error: null, redirectTo: `/mis-mascotas/${TOKEN}` });
    expect(mocks.requirePetAccess).toHaveBeenCalledWith(TOKEN);
    expect(mocks.uploadAttachmentIfPresent).toHaveBeenCalledWith(
      supabase,
      expect.any(File),
      "pet-photos",
    );
    expect(mocks.recordPetPhoto).toHaveBeenCalledWith({
      petId: PET_ID,
      userId: USER_ID,
      storagePath: UPLOADED,
      mimeType: "image/jpeg",
      fileSize: 2048,
    });
  });

  it("refuses a caller the pet guard refuses, with its sentence, and uploads nothing", async () => {
    mocks.requirePetAccess.mockResolvedValue({
      ok: false,
      reason: "not-found-or-forbidden",
      error: "Mascota no encontrada o sin permisos.",
    });
    const state = await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(state).toEqual({ error: "Mascota no encontrada o sin permisos." });
    expect(mocks.uploadAttachmentIfPresent).not.toHaveBeenCalled();
  });

  it("asks an organization member for event.write, the app door's own capability", async () => {
    mocks.requirePetAccess.mockResolvedValue(granted({ accessPath: "org" }));
    const refused = await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(refused.error).toMatch(/Registrar eventos clínicos/);
    expect(mocks.uploadAttachmentIfPresent).not.toHaveBeenCalled();

    mocks.getGrantedCapabilities.mockResolvedValue(new Set(["event.write"]));
    const allowed = await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(allowed).toEqual({ error: null, redirectTo: `/mis-mascotas/${TOKEN}` });
    expect(mocks.getGrantedCapabilities).toHaveBeenCalledWith({ id: "mem-1" });
  });

  it("reads no capability on the person path — a holder needs nothing more", async () => {
    await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(mocks.getGrantedCapabilities).not.toHaveBeenCalled();
  });
});

describe("updatePetPhotoAction — the file, and what happens when it does not land", () => {
  it("asks for a photo when the form carries none, before any upload", async () => {
    const empty = new FormData();
    empty.append("photo", new File([], ""));
    expect((await updatePetPhotoAction(TOKEN, IDLE, empty)).error).toBe(
      "Elegí una foto para la credencial.",
    );
    expect((await updatePetPhotoAction(TOKEN, IDLE, new FormData())).error).toBe(
      "Elegí una foto para la credencial.",
    );
    expect(mocks.uploadAttachmentIfPresent).not.toHaveBeenCalled();
  });

  it("hands the upload's own refusal to the form, and records nothing", async () => {
    mocks.uploadAttachmentIfPresent.mockResolvedValue({
      uploadedPath: null,
      mimeType: null,
      size: null,
      error: "El archivo debe ser una imagen JPG, PNG o WebP.",
    });
    const state = await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(state).toEqual({ error: "El archivo debe ser una imagen JPG, PNG o WebP." });
    expect(mocks.recordPetPhoto).not.toHaveBeenCalled();
  });

  it("takes back the uploaded object when the row does not land", async () => {
    mocks.recordPetPhoto.mockResolvedValue({ ok: false, code: "photo_failed" });
    const state = await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(state).toEqual({ error: "No pudimos guardar la foto. Probá de nuevo." });
    expect(mocks.remove).toHaveBeenCalledWith("pet-photos", [UPLOADED]);
  });

  it("answers an animal erased mid-save like one the caller cannot see", async () => {
    mocks.recordPetPhoto.mockResolvedValue({ ok: false, code: "pet_gone" });
    const state = await updatePetPhotoAction(TOKEN, IDLE, withPhoto());
    expect(state).toEqual({ error: "Mascota no encontrada o sin permisos." });
    expect(mocks.remove).toHaveBeenCalledWith("pet-photos", [UPLOADED]);
  });
});
