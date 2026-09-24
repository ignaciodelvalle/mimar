/**
 * loading.tsx — skeleton for /admin/censo (census KPI dashboard + breakdown cards).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminCensoLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 5]} />;
}
