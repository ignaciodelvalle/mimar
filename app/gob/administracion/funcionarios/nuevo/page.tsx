// /gob/administracion/funcionarios/nuevo — a jurisdiction admin creates a
// municipal official of their own province (jurisdiction-admin Phase 6).
//
// The same form the platform admin uses (components/institutional), scoped:
// municipal official only, at least one locality, pickers inside the province.
// createInstitutionalAccountForAuthority refuses anything else on its own.

import { CreateGovtForm } from "@/components/institutional/CreateGovtForm";
import { OpCrumbs } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";

import {
  ADMINISTRACION_BASE,
  requireProvinceAdministrationOrRedirect,
} from "../../_lib/province-administration";

export const dynamic = "force-dynamic";

export default async function NuevoFuncionarioPage() {
  const { provinceCode, provinceName } = await requireProvinceAdministrationOrRedirect();
  const base = `${ADMINISTRACION_BASE}/funcionarios`;

  return (
    <div className="max-w-2xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Administración", href: ADMINISTRACION_BASE },
          { label: "Funcionarios", href: base },
          { label: "Nueva cuenta" },
        ]}
      />
      <ScreenHeader
        title="Crear cuenta de gobierno"
        subtitle={
          <p className="mt-1 text-sm text-ln-op-ink-2">
            Para un funcionario municipal de {provinceName}. Recibirá un mail para entrar y elegir
            su contraseña.
          </p>
        }
      />
      <CreateGovtForm scope={{ provinceCode, provinceName, detailBase: base, cancelHref: base }} />
    </div>
  );
}
