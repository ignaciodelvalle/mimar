/**
 * loading.tsx — skeleton for /gob/censo (census KPI dashboard + breakdown cards).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobCensoLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 5]} />;
}
