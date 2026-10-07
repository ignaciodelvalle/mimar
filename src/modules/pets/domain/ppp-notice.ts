// The copy of the PPP (raza potencialmente peligrosa) reminder, by jurisdiction.
//
// Surface audit 2026-10-07, item B: the reminder cited "Ley CABA 4078 / Ley
// Provincial 14.107" to EVERY owner — a dog in Mendoza was told two laws that
// do not reach it, and a dog in CABA was sent to "el registro provincial",
// which is not where CABA registers it. Each owner now reads only the law of the
// pet's own jurisdiction, and a jurisdiction with no PPP law in the legal
// framework (docs/legal-framework-full.md) gets a neutral sentence with no
// citation — never invent law.
//
// What each law is said to require is limited to what the framework records:
//   - CABA, Ley 4078: Registro de Propietarios de Perros Potencialmente
//     Peligrosos (APrA, via TAD).
//   - PBA, Ley 14.107: Registro Provincial, through its municipal delegations.
//   - Córdoba, Ley 9685: correa, bozal, identificación (art. 7) and seguro de
//     responsabilidad civil (art. 17). The framework records no registry, so
//     the copy does not claim one.

import { provinceByCode, provinceByName } from "@/lib/reference/ar-provincias";

export type PppNotice = { title: string; body: string };

type PppJurisdiction = "AR-C" | "AR-B" | "AR-X" | null;

function pppJurisdiction(province: string | null | undefined): PppJurisdiction {
  const code = (provinceByCode(province) ?? provinceByName(province))?.code ?? null;
  return code === "AR-C" || code === "AR-B" || code === "AR-X" ? code : null;
}

/**
 * Title and body of the `ppp_registration_reminder` notification for a pet
 * whose breed is on its jurisdiction's PPP list.
 *
 * `province` is the pet's stored jurisdiction (a canonical name such as "CABA"
 * or an ISO code such as "AR-C"); anything unresolvable takes the neutral copy.
 * `autoMarked` adds the sentence that miMAR set the official mark itself — true
 * at registration, where the mark is applied without the owner asking.
 */
export function pppRegistrationNotice(input: {
  petName: string;
  breed: string | null;
  province: string | null | undefined;
  autoMarked: boolean;
}): PppNotice {
  const opening = `Tu mascota está marcada como raza potencialmente peligrosa por ${input.breed ?? "su raza"}.`;
  const closing = input.autoMarked ? " miMAR le puso automáticamente la marca oficial." : "";

  switch (pppJurisdiction(input.province)) {
    case "AR-C":
      return {
        title: `${input.petName}: inscribila en el registro de PPP de la Ciudad`,
        body: `${opening} En la Ciudad de Buenos Aires, la Ley 4078 requiere inscribirla en el Registro de Propietarios de Perros Potencialmente Peligrosos.${closing}`,
      };
    case "AR-B":
      return {
        title: `${input.petName}: inscribila en el registro provincial de PPP`,
        body: `${opening} En la Provincia de Buenos Aires, la Ley 14.107 requiere inscribirla en el Registro Provincial, a través de la delegación de tu municipio.${closing}`,
      };
    case "AR-X":
      return {
        title: `${input.petName}: conocé las reglas para perros potencialmente peligrosos`,
        body: `${opening} En Córdoba, la Ley 9685 pide pasearla con correa corta, bozal e identificación, y tener un seguro de responsabilidad civil.${closing}`,
      };
    default:
      return {
        title: `${input.petName}: revisá las reglas para perros potencialmente peligrosos`,
        body: `${opening} Consultá en tu municipio si tu jurisdicción pide inscribirla en un registro.${closing}`,
      };
  }
}
