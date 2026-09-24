/**
 * loading.tsx — skeleton for /admin/casos (case/expediente queue, admin portal).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminCasosLoading() {
  return <OpDashboardSkeleton cards={[8]} />;
}
