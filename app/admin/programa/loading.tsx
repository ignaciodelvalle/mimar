/**
 * loading.tsx — skeleton for /admin/programa (program dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminProgramaLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 4]} />;
}
