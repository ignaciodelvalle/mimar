// First-name extraction for personal greetings ("Buen día, {nombre}.").
//
// Display names may carry a professional honorific ("Dra. Lilian Marrone").
// Taking the raw first token greeted vets as "Buen día, Dra.." — doubled
// period, no name. The greeting wants the person's first name; the honorific
// belongs to formal surfaces (org portal member lists) that render the full
// display name.

const HONORIFIC_TOKEN = /^(dr|dra|lic|med|vet|prof|ing|sr|sra|srta)\.?$/i;

export function greetingFirstName(
  displayName: string | null | undefined,
  fallback = "amigo",
): string {
  const tokens = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  const first = tokens.find((token) => !HONORIFIC_TOKEN.test(token));
  return first ?? fallback;
}
