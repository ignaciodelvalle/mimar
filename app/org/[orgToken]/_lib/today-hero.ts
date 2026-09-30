// The "Hoy" hero of the org home (portal-vet-p0 D13).
//
// A clinic's day is the agenda and the animal in front of it, not a custody
// queue. So an org that runs no rehoming lifecycle, and whose member can work
// the agenda or sign a clinical act, lands on those two doors first — admins
// included. A refugio keeps its home exactly as it was (null here).
//
// The solo-clinic agenda landing is untouched: it returns before this runs.

import { isRehomingOrgType } from "@/src/modules/organizations/domain/org-type";

export type TodayHeroLink = { href: string; label: string; description: string };

export function todayHeroLinks(input: {
  orgToken: string;
  orgType: string;
  granted: ReadonlySet<string>;
}): TodayHeroLink[] | null {
  if (isRehomingOrgType(input.orgType)) return null;
  const links: TodayHeroLink[] = [];
  if (input.granted.has("appointment.manage")) {
    links.push({
      href: `/org/${input.orgToken}/agenda`,
      label: "Turnos de hoy",
      description: "Las reservas del día para atender.",
    });
  }
  if (input.granted.has("event.write")) {
    links.push({
      href: `/org/${input.orgToken}/atender`,
      label: "Atender mascota",
      description: "Buscá al animal por su código y registrá lo que atendiste.",
    });
  }
  return links.length > 0 ? links : null;
}
