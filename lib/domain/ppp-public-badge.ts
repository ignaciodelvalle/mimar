// Pure-logic helpers for the PppPublicBadge component.
//
// Extracted so the disclaimer interpolation can be tested without a JSX
// runtime. PppPublicBadge.tsx imports from here.
// PppPublicBadge.test.ts guards this contract.

export function buildPppHeadline(): string {
  return "Animal Potencialmente Peligroso (PPP)";
}

/**
 * Builds the public-facing legal disclaimer line for the PPP badge.
 *
 * When breed is present: "Por la raza de {petName} ({breed}), está sujeta al
 * régimen de la Ley CABA 4078 / Ley Prov 14.107."
 *
 * When breed is absent: "Por la raza de {petName}, está sujeta al régimen
 * de la Ley CABA 4078 / Ley Prov 14.107."
 */
export function buildPppDisclaimerLine(petName: string, breed: string | null): string {
  const breedPart = breed ? ` (${breed})` : "";
  return `Por la raza de ${petName}${breedPart}, está sujeta al régimen de la Ley CABA 4078 / Ley Prov 14.107.`;
}
