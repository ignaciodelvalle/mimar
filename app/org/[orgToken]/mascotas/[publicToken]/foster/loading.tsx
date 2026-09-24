/**
 * loading.tsx — skeleton for /org/[orgToken]/mascotas/[publicToken]/foster (foster action form).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMascotaFosterLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[3]} />;
}
