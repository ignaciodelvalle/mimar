// Admin sub-route under /org/[orgToken]. Gates on the `capability.grant`
// capability (admins hold it implicitly; others only after explicit grant).
// Any page under /org/[orgToken]/admin can assume the visitor can decide
// capability requests.

import { OpBreach } from "@/components/ui/dashboard/OpBreach";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import Link from "next/link";

export default async function OrgAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  if (!granted.has("capability.grant")) {
    return (
      <div className="p-6">
        <OpBreach
          title="Acceso restringido"
          detail={
            <>
              Esta sección es para administradores. Necesitás el permiso{" "}
              <code className="text-sm font-bold text-ln-op-ink-2 bg-ln-op-stripe px-1 rounded">
                capability.grant
              </code>{" "}
              para revisar solicitudes.{" "}
              <Link href={`/org/${orgToken}`} className="underline font-medium">
                Volver al panel
              </Link>
            </>
          }
        />
      </div>
    );
  }

  return <>{children}</>;
}
