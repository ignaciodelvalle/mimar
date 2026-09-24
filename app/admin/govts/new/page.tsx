import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";

import { CreateGovtForm } from "./CreateGovtForm";

export default async function NewGovtPage() {
  await requireAdminOrRedirect();

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Crear cuenta gobierno"
        subtitle={
          <p className="text-sm text-ln-op-ink-2 mt-1">
            El operador recibirá un mail para entrar y elegir su contraseña.
          </p>
        }
      />

      <CreateGovtForm />
    </div>
  );
}
