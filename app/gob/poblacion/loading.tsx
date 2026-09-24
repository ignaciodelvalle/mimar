/**
 * loading.tsx — skeleton for /gob/poblacion (population KPI dashboard + charts).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobPoblacionLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 5]} />;
}
