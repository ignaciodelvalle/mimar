/**
 * loading.tsx — skeleton for /admin/sistema/crons (scheduled jobs list).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminCronsLoading() {
  return <OpDashboardSkeleton filterBar={false} cards={[8]} />;
}
