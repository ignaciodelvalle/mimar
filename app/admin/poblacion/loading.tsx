/**
 * loading.tsx — skeleton for /admin/poblacion (population KPI dashboard + charts).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminPoblacionLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 5]} />;
}
