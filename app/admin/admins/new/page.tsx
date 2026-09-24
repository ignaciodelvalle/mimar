import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";

import { CreateAdminForm } from "./CreateAdminForm";

export default async function NewAdminPage() {
  await requireAdminOrRedirect();

  return (
    <div className="space-y-6">
      <ScreenHeader
        title="Crear cuenta administrador"
        subtitle={
          <p className="text-sm text-ln-op-ink-2 mt-1">
            El administrador tendrá acceso universal. Recibirá un mail para entrar y elegir su
            contraseña.
          </p>
        }
      />

      <CreateAdminForm />
    </div>
  );
}
