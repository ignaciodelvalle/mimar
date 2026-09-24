/**
 * loading.tsx — skeleton for /admin/govts (govt accounts list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminGovtsLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
