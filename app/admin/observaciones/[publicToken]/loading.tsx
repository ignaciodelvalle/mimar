/**
 * loading.tsx — skeleton for /admin/observaciones/[publicToken] (observation detail).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminObservacionDetailLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[4]} />;
}
