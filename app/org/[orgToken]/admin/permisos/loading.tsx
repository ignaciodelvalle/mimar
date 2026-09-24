/**
 * loading.tsx — skeleton for /org/[orgToken]/admin/permisos (permissions list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgPermisosLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6]} />;
}
