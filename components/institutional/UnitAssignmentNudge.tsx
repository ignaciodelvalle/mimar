// "Falta asignarlo a su unidad" — shown after a govt account is created with a
// grant in CABA or Córdoba (localidades CABA + Córdoba, 2026-10, change C4).
//
// A grant is born matching its locality by NAME; in these two provinces it is
// meant to be confirmed onto its authority unit in a second step. Until then
// it sees by name — and in Córdoba seven pairs of towns share one, so it would
// see both. The platform admin gets the link to that province's units; a
// jurisdiction admin cannot confirm units, so it is told who can.
// scripts/place-legacy-grants.ts catches a forgotten step either way.

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OpCallout } from "@/components/ui/dashboard";
import { unitFirstProvinceCode } from "@/lib/place/unit-first-provinces";
import { provinceByCode } from "@/lib/reference/ar-provincias";

export function UnitAssignmentNudge({
  provinces,
  canConfirmUnits,
}: {
  /** The provinces of the grant(s) just written, as names or ISO codes. */
  provinces: readonly (string | null | undefined)[];
  /** True for the platform admin, who edits /admin/localidades. */
  canConfirmUnits: boolean;
}) {
  const codes = [
    ...new Set(provinces.map(unitFirstProvinceCode).filter((c): c is string => c !== null)),
  ];
  if (codes.length === 0) return null;
  return (
    <div data-testid="unit-assignment-nudge">
      {codes.map((code) => {
        const name = provinceByCode(code)?.name ?? code;
        return (
          <OpCallout
            key={code}
            title="Falta asignarlo a su unidad"
            icon={<Icon name="alerta" decorative />}
            body={
              <>
                En {name} los permisos se leen por unidad. Hasta que confirmes este permiso en su
                unidad, el funcionario ve por nombre de localidad, y un nombre repetido le mostraría
                las dos.{" "}
                {canConfirmUnits ? (
                  <Link
                    href={`/admin/localidades?provincia=${code}`}
                    className="font-medium text-ln-op-navy underline"
                  >
                    Ir a las unidades de {name}
                  </Link>
                ) : (
                  "Pedile a un administrador de la plataforma que lo asigne a su unidad."
                )}
              </>
            }
          />
        );
      })}
    </div>
  );
}
