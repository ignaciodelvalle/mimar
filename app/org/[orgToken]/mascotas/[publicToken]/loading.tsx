/**
 * loading.tsx — skeleton for /org/[orgToken]/mascotas/[publicToken] (pet detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function OrgMascotaDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[6, 4]} />;
}
