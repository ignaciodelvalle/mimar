// Resolver wrapper for the physical_credential_channels business rule.
// Spec 2026-06-19-physical-credential-hub §4 Fase A.
//
// Consumers call resolvePhysicalCredentialChannels(jurisdiction) to get the
// channel availability for the pet's jurisdiction. Cascades via the standard
// business-rules resolver: locality > province > country > hardcoded default.

import type { PhysicalCredentialChannels } from "@/lib/domain/business-rules-defaults";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";

export type ChannelKey = "printable_qr" | "engraved_plate" | "nfc_tag";
export type ChannelAvailability = PhysicalCredentialChannels;

/**
 * Resolve which physical credential channels are available for a given
 * jurisdiction. Returns the full PhysicalCredentialChannels payload
 * (defaults: printable_qr ON, engraved_plate/nfc_tag OFF).
 */
export async function resolvePhysicalCredentialChannels(jurisdiction: {
  country: string;
  province: string | null;
  locality: string | null;
}): Promise<ChannelAvailability> {
  const r = await resolveBusinessRule("physical_credential_channels", jurisdiction);
  return r.payload;
}
