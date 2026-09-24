/**
 * Robustly read an HTML checkbox from `FormData`.
 *
 * A checkbox submits its `value` attribute when checked and is omitted entirely
 * when unchecked. Forms in this app use two conventions:
 *   - a bare `<input type="checkbox">` / `<LnCheckbox>` submits the browser
 *     default `"on"`;
 *   - a checkbox with an explicit `value="true"` submits `"true"`.
 *
 * Server Actions historically tested only `=== "on"`, so any form using
 * `value="true"` silently failed validation (e.g. the owner bite report never
 * registered the mandatory observation confirmation). This helper accepts both
 * truthy conventions and treats anything else — an absent field or an explicit
 * `"false"` — as unchecked.
 */
export function checkboxOn(formData: FormData, name: string): boolean {
  const value = formData.get(name);
  return value === "on" || value === "true";
}
