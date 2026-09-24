/**
 * loading.tsx — skeleton for /gob/campanas (outreach campaigns dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobCampanasLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 4]} />;
}
