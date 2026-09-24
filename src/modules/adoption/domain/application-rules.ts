// Application submission validation — pure function, no DB, no Next.js imports.
// Extracted from app/actions/adoption-applications.ts validation block.

import type { ApplicantProfile, ApplicationInput, ExistingApplication } from "./types";

export type ApplicationValidationResult = { ok: true } | { ok: false; error: string };

const MAX_TEXT_LEN = 2000;
const MIN_MOTIVATION_LEN = 30;
const VALID_PRIOR_PETS = new Set(["yes_currently", "yes_before", "no"]);

/**
 * Validates the inputs for an adoption application submission.
 *
 * @param input - The application form data.
 * @param applicant - Minimal profile shape for the applicant (accountType).
 * @param existingApplication - Non-null when the applicant already has a pending
 *   unresolved application for this pet. The caller (repo) supplies this.
 */
export function validateApplicationInput(
  input: ApplicationInput,
  applicant: ApplicantProfile,
  existingApplication: ExistingApplication | null,
): ApplicationValidationResult {
  // Institutional accounts cannot apply.
  if (applicant.accountType === "institutional") {
    return {
      ok: false,
      error:
        "Las cuentas institucionales no pueden postularse para adoptar. Si querés adoptar como persona, creá una cuenta personal con otro email.",
    };
  }

  // Consent is mandatory.
  if (input.profileSharingConsent !== true) {
    return {
      ok: false,
      error: "Tu consentimiento para compartir el perfil es obligatorio para postularte.",
    };
  }

  // Duplicate pending application.
  if (existingApplication !== null) {
    return {
      ok: false,
      error:
        "Ya postulaste para esta mascota. El refugio recibió tu postulación y la está revisando.",
    };
  }

  // Motivation — required, minimum length.
  const motivationTrimmed = input.motivation?.trim() ?? "";
  if (motivationTrimmed.length < MIN_MOTIVATION_LEN) {
    return {
      ok: false,
      error: `Contanos por qué querés adoptar (mínimo ${MIN_MOTIVATION_LEN} caracteres).`,
    };
  }

  // Prior pets — required, must be a valid enum value.
  if (!input.priorPets || !VALID_PRIOR_PETS.has(input.priorPets)) {
    return {
      ok: false,
      error: "Seleccioná si tuviste mascotas antes.",
    };
  }

  // Text length caps.
  const textFields: Array<[string, string | null | undefined]> = [
    ["Otras mascotas", input.otherPets],
    ["Rutina diaria", input.dailyRoutine],
    ["Notas", input.notes],
    ["Motivación", input.motivation],
  ];

  for (const [label, val] of textFields) {
    if (val && val.trim().length > MAX_TEXT_LEN) {
      return { ok: false, error: `${label}: máximo ${MAX_TEXT_LEN} caracteres.` };
    }
  }

  return { ok: true };
}
