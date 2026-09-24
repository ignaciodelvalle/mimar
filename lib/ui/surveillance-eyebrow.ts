// Pure helper: derive the surveillance page eyebrow label from the viewer's role.
// Admin → "Admin · Vigilancia", govt → "Gobierno · Vigilancia".

// national (read-only, country-wide read scope) browses the /gob portal, so it
// gets the Gobierno eyebrow like govt — the eyebrow names the PORTAL, not the scope.
type SurveillanceRole = "admin" | "govt" | "national";

export function surveillanceEyebrow(role: SurveillanceRole): string {
  return role === "admin" ? "Admin · Vigilancia" : "Gobierno · Vigilancia";
}
