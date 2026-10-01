"use server";

// pet-photo.ts — the web's photo door (owner-pet-actions, PO rule "web = app").
//
// THE APP'S DOOR, ON THE WEB. The app's "Foto" row opens a photo screen for any
// holder (`POST /api/v1/pets/{token}/photo`); the web's only photo field lived
// inside "Editar datos", whose writer (`updatePetAction`) is titular-gated for
// the OTHER fields in that form. So a caretaker had the door on the phone and a
// grey row on the web. This is the same act under the same rule:
//
//   · WHO: any holder on the person path — `lib/domain/titular-only.ts` lists
//     photos among what a caretaker MAY do, and `primaryPhotoId` is not a
//     titular-only column — and, on the organization path, a membership holding
//     `event.write`, the capability the app's door demands for org media.
//   · A DEAD PET IS NOT REFUSED, as on the app's door: a photo is not an event.
//   · THE BYTES go through the web's own upload primitive (magic bytes, no SVG,
//     re-encode, fail closed); THE ROW AND THE POINTER through the app door's
//     own writer (`recordPetPhoto`), so the two doors cannot disagree about an
//     animal erased mid-save.

import { requirePetAccess } from "@/lib/infra/pet-access";
import { PET_PHOTO_BUCKET, recordPetPhoto } from "@/lib/infra/pet-photo-upload";
import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

export type PetPhotoFormState = { error: string | null; redirectTo?: string };

/** The guard's own words for a pet the caller may not touch — and for one erased mid-save. */
const PET_NOT_FOUND = "Mascota no encontrada o sin permisos.";

export async function updatePetPhotoAction(
  publicToken: string,
  _previous: PetPhotoFormState,
  formData: FormData,
): Promise<PetPhotoFormState> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  if (access.accessPath === "org" && access.membership) {
    const granted = await getGrantedCapabilities(access.membership);
    if (!granted.has("event.write")) {
      return {
        error:
          "Necesitás el permiso 'Registrar eventos clínicos' (event.write) para cambiar la foto. Pediselo a un administrador.",
      };
    }
  }

  const photo = formData.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return { error: "Elegí una foto para la credencial." };
  }

  const upload = await uploadAttachmentIfPresent(access.supabase, photo, PET_PHOTO_BUCKET);
  if (upload.error !== null) return { error: upload.error };
  if (upload.uploadedPath === null) return { error: "Elegí una foto para la credencial." };

  const recorded = await recordPetPhoto({
    petId: access.pet.id,
    userId: access.user.id,
    storagePath: upload.uploadedPath,
    mimeType: upload.mimeType ?? "image/jpeg",
    fileSize: upload.size ?? photo.size,
  });
  if (!recorded.ok) {
    // No row points at the object just written: take it back rather than leave
    // an orphan in a public bucket (the same cleanup `updatePetAction` does).
    try {
      await access.supabase.storage.from(PET_PHOTO_BUCKET).remove([upload.uploadedPath]);
    } catch {
      // Best-effort.
    }
    return {
      error:
        recorded.code === "pet_gone"
          ? PET_NOT_FOUND
          : "No pudimos guardar la foto. Probá de nuevo.",
    };
  }

  // A full navigation back to the profile (useActionRedirect): the credential
  // is rendered on the server, so that is how it shows the new photo.
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}` };
}
