// Lote A4 — server-side mirror of the attestation form's registry options.
// The action used to validate against the hardcoded DANGEROUS_BREED_REGISTRIES
// while the form offered the resolved per-jurisdiction rule — the sets split
// the moment a jurisdiction configured real registries via /gob/reglas.

import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";

import { allowedAttestationRegistries } from "../../domain/enums";

/**
 * Resolve `ppp_attestation_required_registries` for the pet's jurisdiction and
 * check the submitted registry against the derived accepted set
 * (allowedAttestationRegistries — override replaces the national fallback,
 * "other" always allowed). Returns the es-AR error to show, or null when valid.
 */
export async function validateAttestationRegistry(
  registry: string,
  jurisdiction: { province: string | null; locality: string | null },
): Promise<string | null> {
  const resolved = await resolveBusinessRule("ppp_attestation_required_registries", {
    country: "AR",
    province: jurisdiction.province,
    locality: jurisdiction.locality,
  });
  return allowedAttestationRegistries(resolved.payload).has(registry)
    ? null
    : "Registro inválido. Elegí uno de los disponibles.";
}
