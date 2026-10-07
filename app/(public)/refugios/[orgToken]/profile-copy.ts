// How the public profile speaks, per org type.
//
// /refugios/[orgToken] was written for shelters and rescue networks. Since
// migration 0283 a verified clinic that opted in also lands here from the
// directory, and it must not be called a refugio, offer adoption, or ask for
// donations and volunteers. A rehoming org keeps exactly the copy it always
// had — the strings below for it are the ones the components carried inline.
//
// Pure strings, no imports beyond the rule.

import { BRANDING } from "@/lib/ui/branding";
import { isRehomingOrgType } from "@/src/modules/organizations/domain/org-type";

export type PublicProfileCopy = {
  /** Whether the profile carries the rehoming panels (adoption, how to help). */
  rehoming: boolean;
  /** The type chip on the hero. */
  typeChip: string;
  /** "{name} — {metaKind} en miMAR" in the page title. */
  metaKind: string;
  /** The hero's trust line under the name. */
  trustCopy: string;
  /** The hero's primary button; the no-channels note in "Consulta sin turno" names it too. */
  contactCta: string;
  /** The strip only the org's own admins and coordinators see. */
  adminBanner: { label: string; text: string; portalLink: string };
  /** The link back from the profile. */
  back: { href: string; label: string };
};

export function publicProfileCopy(orgType: string): PublicProfileCopy {
  if (isRehomingOrgType(orgType)) {
    return {
      rehoming: true,
      typeChip: orgType === "shelter" ? "Refugio" : "Red de rescate",
      metaKind: "Refugio",
      trustCopy: `Refugio verificado por ${BRANDING.appName}. Las postulaciones llegan directo al equipo del refugio, que coordina los próximos pasos por email con cada candidato.`,
      contactCta: "Contactar al refugio",
      adminBanner: {
        label: "Banner para administradores del refugio",
        text: "Estás viendo el perfil público de tu refugio. Los visitantes externos ven esta misma página.",
        portalLink: "Ir al portal del refugio →",
      },
      back: { href: "/adoptar", label: "← Volver a adopciones" },
    };
  }
  return {
    rehoming: false,
    typeChip: "Veterinaria",
    metaKind: "Veterinaria",
    trustCopy: `Veterinaria verificada por ${BRANDING.appName}. Los mensajes que mandes desde acá llegan directo al equipo de la veterinaria.`,
    contactCta: "Contactar a la veterinaria",
    adminBanner: {
      label: "Banner para administradores de la veterinaria",
      text: "Estás viendo el perfil público de tu veterinaria. Los visitantes externos ven esta misma página.",
      portalLink: "Ir al portal de la veterinaria →",
    },
    back: { href: "/refugios?tipo=veterinarias", label: "← Volver al directorio" },
  };
}
