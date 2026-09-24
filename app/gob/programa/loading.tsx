/**
 * loading.tsx — skeleton for /gob/programa (program dashboard).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobProgramaLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 4]} />;
}
