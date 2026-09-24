/**
 * loading.tsx — skeleton for /admin/adopciones (adoption program dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function AdminAdopcionesLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[8]} />;
}
