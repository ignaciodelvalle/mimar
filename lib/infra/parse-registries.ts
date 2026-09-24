// lib/parse-registries.ts — Pure helper for ppp_attestation_required_registries form data.
//
// Serialisation: the form sends a single JSON string ("registriesJson") instead
// of three parallel arrays (registryId / registryLabel / registryRequired).
// This avoids index-alignment fragility when the user reorders entries.
//
// PURE — no DB, no side effects. Tested in parse-registries.test.ts.

/**
 * Parse a JSON-serialised list of attestation registry objects.
 *
 * Tolerates empty input, malformed JSON, and non-array values by returning [].
 * Each item is validated to have a non-empty string id and label; malformed
 * items are silently dropped so a partially-corrupt submission still saves
 * what it can.
 */
export function parseRegistriesJson(raw: string | null | undefined): Array<{
  id: string;
  label: string;
  required: boolean;
}> {
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: Array<{ id: string; label: string; required: boolean }> = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const label = typeof obj.label === "string" ? obj.label.trim() : "";
    if (!id || !label) continue;
    result.push({ id, label, required: Boolean(obj.required) });
  }
  return result;
}
