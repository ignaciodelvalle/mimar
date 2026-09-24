// Pure href builders for the /gob/reglas admin-lens jurisdiction drill-down
// (design ADR-1 — folded in from the old /admin/jurisdicciones surface).
//
// The dynamic route is /gob/reglas/[country]/[province]/[locality] where the
// "_" segment is the sentinel for "null" (country-wide or province-wide).
// These helpers centralize the segment encoding so the admin lens and the
// locality drill-down (AC4) can't diverge — in particular so a real locality
// name lands in the [locality] segment instead of "_".
//
// No React, no async — kept pure so the resolver is unit-testable in isolation.

const NULL_SEGMENT = "_";

function seg(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return NULL_SEGMENT;
  return encodeURIComponent(value);
}

/**
 * Build the rules list href for a jurisdiction tuple. Pass `null` (or omit) for
 * province/locality to target the country-wide or province-wide scope.
 *
 * Examples:
 *   buildJurisdictionRulesHref({ country: "AR" })
 *     -> /gob/reglas/AR/_/_
 *   buildJurisdictionRulesHref({ country: "AR", province: "Buenos Aires" })
 *     -> /gob/reglas/AR/Buenos%20Aires/_
 *   buildJurisdictionRulesHref({ country: "AR", province: "Buenos Aires", locality: "La Plata" })
 *     -> /gob/reglas/AR/Buenos%20Aires/La%20Plata
 */
export function buildJurisdictionRulesHref(input: {
  country: string;
  province?: string | null;
  locality?: string | null;
  /**
   * Portal prefix the link must stay inside (portal-follows-viewer,
   * 2026-07-02): the rules surface renders under both /admin and /gob, and
   * drill-down links must not eject the viewer from their portal. Server
   * pages resolve it via lib/ui/portal-base and thread it down as a prop.
   */
  base?: "/admin" | "/gob";
}): string {
  const country = seg(input.country);
  const province = seg(input.province);
  const locality = seg(input.locality);
  return `${input.base ?? "/gob"}/reglas/${country}/${province}/${locality}`;
}

/**
 * es-AR display label for a jurisdiction tuple — shared by the customized-
 * jurisdictions list (AdminReglasLens), the jurisdiction detail page, and the
 * "Crear regla" wizard's step-4 summary, so the three surfaces can never say
 * three different things about the same (country, province, locality) triple.
 * `null` province/locality render as "(nivel país)" / "(toda la provincia)" —
 * the same placeholders the pre-wizard console already used verbatim.
 */
export function jurisdictionLabel(
  country: string,
  province: string | null,
  locality: string | null,
): string {
  const parts = [country, province ?? "(nivel país)", locality ?? "(toda la provincia)"];
  return parts.join(" · ");
}
