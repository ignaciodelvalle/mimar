"use client";

// Client component — self-service profile edit form (Slice 3a).
// Handles text fields (displayName, phone) and avatar upload.
// On submit: calls updateProfileAction and uploadAvatarAction server actions.
// On success: shows inline success banner; does NOT redirect (user stays on
// the edit form so they can keep making changes). "Cancelar" goes back to /cuenta.

import { useRef, useState } from "react";

import { updateProfileAction, uploadAvatarAction } from "@/app/actions/profile";
import {
  EmergencyContactFields,
  type EmergencyContactValues,
} from "@/components/pet-profile/EmergencyContactFields";
import { looksLikeArPhone } from "@/lib/reference/ar-phone";
import { notifySaved } from "@/lib/ui/action-feedback";
import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";

function PhoneFormatWarning({ value }: { value: string }) {
  if (!value || looksLikeArPhone(value)) return null;
  return (
    <p className="mt-1 text-xs text-[var(--color-ln-warn)]">
      Formato inusual para Argentina — guardamos igual, revisalo si querés.
    </p>
  );
}

type InitialProfile = {
  displayName: string;
  phone: string;
  /**
   * A SHORT-LIVED SIGNED URL, minted by the server render — `avatars` is a
   * private bucket and `profiles.avatar_url` holds a path, not a URL. Preview
   * only; never persisted, never sent back.
   */
  avatarUrl: string;
  preferredVetName: string;
  preferredVetPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

type FieldErrors = {
  displayName?: string;
  phone?: string;
  avatar?: string;
};

export function EditProfileForm({ initialProfile }: { initialProfile: InitialProfile }) {
  const [displayName, setDisplayName] = useState(initialProfile.displayName);
  const [phone, setPhone] = useState(initialProfile.phone);
  const [preferredVetName, setPreferredVetName] = useState(initialProfile.preferredVetName);
  const [preferredVetPhone, setPreferredVetPhone] = useState(initialProfile.preferredVetPhone);
  const [emergencyContactName, setEmergencyContactName] = useState(
    initialProfile.emergencyContactName,
  );
  const [emergencyContactPhone, setEmergencyContactPhone] = useState(
    initialProfile.emergencyContactPhone,
  );
  const [avatarPreview, setAvatarPreview] = useState<string | null>(
    initialProfile.avatarUrl || null,
  );
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setFieldErrors((prev) => ({
        ...prev,
        avatar: "Solo se aceptan imágenes JPEG, PNG o WebP",
      }));
      return;
    }
    // Courtesy pre-check only — it saves an upload, it decides nothing. The
    // real bound is `MAX_IMAGE_BYTES` in lib/media/validate.ts, enforced on the
    // bytes by uploadAvatarForUser and again by the avatars bucket itself
    // (migration 0218). Restated as a literal rather than imported because that
    // module dynamically imports sharp and this is a client component.
    if (file.size > 5 * 1024 * 1024) {
      setFieldErrors((prev) => ({
        ...prev,
        avatar: "La imagen no puede superar los 5 MB. Probá con una foto más liviana.",
      }));
      return;
    }

    setFieldErrors((prev) => ({ ...prev, avatar: undefined }));
    setPendingAvatarFile(file);

    const reader = new FileReader();
    reader.onload = (evt) => {
      setAvatarPreview(evt.target?.result as string);
    };
    reader.readAsDataURL(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setGlobalError(null);
    setSuccessMessage(null);
    setFieldErrors({});
    setLoading(true);

    try {
      let hasError = false;
      const newErrors: FieldErrors = {};

      // Update text fields
      const textResult = await updateProfileAction({
        displayName,
        phone: phone,
        preferredVetName,
        preferredVetPhone,
        emergencyContactName,
        emergencyContactPhone,
      });

      if ("error" in textResult) {
        hasError = true;
        const msg = textResult.error;
        if (msg.includes("nombre")) {
          newErrors.displayName = msg.replace("VALIDATION_ERROR: ", "");
        } else if (msg.includes("teléfono")) {
          newErrors.phone = msg.replace("VALIDATION_ERROR: ", "");
        } else {
          setGlobalError(msg);
        }
      }

      // Upload avatar if one was selected
      if (pendingAvatarFile && !hasError) {
        const avatarResult = await uploadAvatarAction({
          fileBlob: pendingAvatarFile,
          fileName: pendingAvatarFile.name,
          mimeType: pendingAvatarFile.type,
          fileSize: pendingAvatarFile.size,
        });

        if ("error" in avatarResult) {
          hasError = true;
          if (avatarResult.error.includes("VALIDATION_ERROR")) {
            newErrors.avatar = avatarResult.error.replace("VALIDATION_ERROR: ", "");
          } else {
            // Storage failure — non-blocking for text fields
            newErrors.avatar = `No se pudo subir la foto: ${avatarResult.error.replace("STORAGE_FAILED: ", "")}`;
          }
        } else {
          setPendingAvatarFile(null);
          // `avatarUrl` is a freshly SIGNED url — `avatars` is private and the
          // column holds a path (migration 0219). Null means the upload
          // SUCCEEDED but signing it for display did not, so keep the previous
          // preview rather than blanking the avatar: the photo is stored, and
          // the next /cuenta render signs it again from the path.
          setAvatarPreview((prev) => avatarResult.avatarUrl ?? prev);
        }
      }

      setFieldErrors(newErrors);
      if (!hasError && Object.keys(newErrors).length === 0) {
        setSuccessMessage("Tus datos fueron actualizados correctamente.");
        // This form never navigates/reloads on save — the toast is the
        // confirmation (mutation-feedback convention, lib/ui/action-feedback.ts).
        // The inline banner above stays too — it's the durable signal for
        // anyone who dismisses the toast before reading it.
        notifySaved("Perfil actualizado");
      }
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : UNKNOWN_ERROR_FALLBACK);
    } finally {
      setLoading(false);
    }
  }

  const displayNameInitials = displayName
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Success banner */}
      {successMessage && (
        <div className="rounded-[var(--radius-sm)] bg-[var(--color-ln-ok-050)] border border-[var(--color-ln-ok)] px-4 py-3">
          <p className="text-sm text-[var(--color-ln-ok)]">{successMessage}</p>
        </div>
      )}

      {/* Global error */}
      {globalError && (
        <div className="rounded-[var(--radius-sm)] bg-[var(--color-ln-err-050)] border border-[var(--color-ln-seal)] px-4 py-3">
          <p className="text-sm text-[var(--color-ln-seal)]">{globalError}</p>
        </div>
      )}

      {/* Avatar upload */}
      <div className="space-y-2">
        <label
          htmlFor="avatarUpload"
          className="block text-sm font-medium text-[var(--color-ln-ink-2)]"
        >
          Foto de perfil
        </label>
        <div className="flex items-center gap-4">
          {avatarPreview ? (
            <img
              src={avatarPreview}
              alt="Vista previa"
              className="w-16 h-16 rounded-full object-cover border border-[var(--color-ln-line)] shrink-0"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-[var(--color-ln-stripe)] border border-[var(--color-ln-line)] flex items-center justify-center text-xl font-semibold text-[var(--color-ln-ink-2)] shrink-0">
              {displayNameInitials || "?"}
            </div>
          )}
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-sm text-[var(--color-ln-ink)] underline underline-offset-4 hover:opacity-70 transition-opacity"
            >
              {avatarPreview ? "Cambiar foto" : "Subir foto"}
            </button>
            <p className="text-xs text-[var(--color-ln-mute)]">JPEG, PNG o WebP · máx. 5 MB</p>
            {fieldErrors.avatar && (
              <p className="text-xs text-[var(--color-ln-err)]">{fieldErrors.avatar}</p>
            )}
          </div>
        </div>
        <input
          id="avatarUpload"
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={handleAvatarChange}
        />
      </div>

      {/* displayName */}
      <div>
        <label
          htmlFor="displayName"
          className="block text-sm font-medium text-[var(--color-ln-ink-2)] mb-1"
        >
          Nombre de display <span className="text-[var(--color-ln-seal)]">*</span>
        </label>
        <input
          id="displayName"
          type="text"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          minLength={2}
          maxLength={80}
          placeholder="Tu nombre o apodo"
          className="w-full text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
          aria-describedby={fieldErrors.displayName ? "displayName-error" : undefined}
        />
        {fieldErrors.displayName && (
          <p id="displayName-error" className="mt-1 text-xs text-[var(--color-ln-err)]">
            {fieldErrors.displayName}
          </p>
        )}
      </div>

      {/* phone */}
      <div>
        <label
          htmlFor="phone"
          className="block text-sm font-medium text-[var(--color-ln-ink-2)] mb-1"
        >
          Teléfono{" "}
          <span className="text-xs font-normal text-[var(--color-ln-mute)]">(opcional)</span>
        </label>
        <input
          id="phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+54 9 11 1234-5678"
          className="w-full text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
          aria-describedby={fieldErrors.phone ? "phone-error" : undefined}
        />
        {fieldErrors.phone && (
          <p id="phone-error" className="mt-1 text-xs text-[var(--color-ln-err)]">
            {fieldErrors.phone}
          </p>
        )}
        <PhoneFormatWarning value={phone} />
      </div>

      {/* Emergency / vet contact group — appears on <PetEmergencyCard>
          of every pet detail. Tap-to-call linkable. Extracted to
          EmergencyContactFields (pet-document-redesign ADR-13, Phase 5) —
          shared with the narrow `?sheet=emergencia` in-profile edit. */}
      <EmergencyContactFields
        values={{
          preferredVetName,
          preferredVetPhone,
          emergencyContactName,
          emergencyContactPhone,
        }}
        onChange={(field, value) => {
          const setters: Record<keyof EmergencyContactValues, (v: string) => void> = {
            preferredVetName: setPreferredVetName,
            preferredVetPhone: setPreferredVetPhone,
            emergencyContactName: setEmergencyContactName,
            emergencyContactPhone: setEmergencyContactPhone,
          };
          setters[field](value);
        }}
      />

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-2 text-sm bg-[var(--color-ln-azul)] text-white rounded-[var(--radius-pill)] hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Guardando..." : "Guardar cambios"}
        </button>
        <a
          href="/cuenta"
          className="px-5 py-2 text-sm border border-[var(--color-ln-line-strong)] rounded-[var(--radius-pill)] hover:bg-[var(--color-ln-stripe)] transition-colors"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
