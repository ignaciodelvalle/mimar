/**
 * loading.tsx — skeleton for /gob/operativos (the Operativos hub, F2 fusion).
 */

import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

export default function GobOperativosLoading() {
  return <OpDashboardSkeleton kpis={4} cards={[6, 4]} />;
}
