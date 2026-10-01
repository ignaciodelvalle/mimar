"use client";

// PetPhotoSheet — the pet's photo, as its own door (`?sheet=foto`).
//
// THE APP'S PHOTO SCREEN, ON THE WEB (owner-pet-actions, PO rule "web = app").
// The panel's "Foto" row and the credential's photo frame open this sheet for
// any holder the catalogue gives the row to — a caretaker included, as on the
// phone — instead of the "Editar datos" form a caretaker may not open. The
// words are the app screen's; the act is `updatePetPhotoAction`, under the app
// door's own rule.
//
// ON SUCCESS THE DOCUMENT NAVIGATES (useActionRedirect): the credential is
// drawn on the server, and a full load is how it shows the new photo.

import { useActionState } from "react";

import { type PetPhotoFormState, updatePetPhotoAction } from "@/app/actions/pet-photo";
import { LnPhotoField } from "@/components/pet-form/fields";
import { usePhotoPreview } from "@/components/pet-form/use-photo-preview";
import { LnButton } from "@/components/ui/Button";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";

type Props = {
  petPublicToken: string;
  /** The credential's current photo, for the preview; `null` when it has none. */
  existingPhotoUrl: string | null;
};

const IDLE: PetPhotoFormState = { error: null };

export function PetPhotoSheet({ petPublicToken, existingPhotoUrl }: Props) {
  const [state, formAction, pending] = useActionState(
    updatePetPhotoAction.bind(null, petPublicToken),
    IDLE,
  );
  const navigating = useActionRedirect(state.redirectTo, state);
  const { preview, onFileChange } = usePhotoPreview(existingPhotoUrl, state.error ? state : null);

  const busy = pending || navigating;
  return (
    <form action={formAction} className="space-y-4">
      <p className="text-sm text-[var(--color-ln-ink-2)]">
        Es la imagen de la credencial: la ve cualquiera que escanee el QR. Elegí una donde se
        reconozca al animal.
      </p>
      <LnPhotoField onFileChange={onFileChange} preview={preview} optional={false} />
      {state.error && (
        <p className="text-xs text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}
      <LnButton type="submit" variant="ok" size="md" disabled={busy}>
        {busy ? "Guardando…" : "Guardar foto"}
      </LnButton>
    </form>
  );
}
