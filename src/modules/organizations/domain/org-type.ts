// The ONE org-type rule (portal-vet-p0 D13).
//
// Which organizations run the custody-rehoming lifecycle — intake into
// custody, foster, adoption, custody transfer. A refugio and a rescue network
// do; a clinic, a sanitary authority and "other" do not. Every screen that
// speaks shelter language, and every role or capability that only makes sense
// in a shelter, asks THIS predicate.
//
// It used to be three private copies of the same set (capabilities.ts, the
// settings form, the census page), each free to drift from the others.
//
// ZERO IMPORTS, on purpose: a "use client" component imports it, and nothing
// here may pull the DB schema or a server module into the browser bundle.

/** Org types that run the custody-rehoming lifecycle. */
export const REHOMING_ORG_TYPES: ReadonlySet<string> = new Set(["shelter", "rescue_network"]);

/** Whether an org of this type runs the custody-rehoming lifecycle. */
export function isRehomingOrgType(orgType: string): boolean {
  return REHOMING_ORG_TYPES.has(orgType);
}
